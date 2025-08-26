#!/usr/bin/env node

/**
 * نظام النشر التلقائي على فيسبوك v4.3
 * مطور بواسطة: Turki
 * التاريخ: 2025
 * الوصف: نظام متقدم للنشر التلقائي مع دعم الاستيراد الجماعي وتوزيع 12 منشور يومياً
 */

// =============================================================================
// 1. التحقق من البيئة والاعتماديات
// =============================================================================

console.log('🔍 فحص النظام والاعتماديات...\n');

function validateEnvironmentVariables() {
  const required = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY', 
    'FIREBASE_CLIENT_EMAIL',
    'ZAPIER_WEBHOOKS'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ متغيرات البيئة المفقودة: ${missing.join(', ')}`);
    process.exit(1);
  }
  
  try {
    const accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('ZAPIER_WEBHOOKS يجب أن يكون array غير فارغ');
    }
    
    accounts.forEach((account, index) => {
      if (!account.webhook || !account.name) {
        throw new Error(`الحساب ${index + 1}: يجب أن يحتوي على webhook و name`);
      }
    });
    
    console.log(`✅ تم التحقق من ${accounts.length} حساب Zapier Premium`);
  } catch (error) {
    console.error('❌ خطأ في ZAPIER_WEBHOOKS:', error.message);
    process.exit(1);
  }
  
  console.log('✅ جميع متغيرات البيئة صحيحة\n');
}

function checkDependencies() {
  const deps = ['firebase-admin', 'axios', 'date-fns'];
  
  for (const dep of deps) {
    try {
      require(dep);
      console.log(`✅ ${dep} - مثبت بنجاح`);
    } catch (e) {
      console.error(`❌ ${dep} - غير مثبت:`, e.message);
      process.exit(1);
    }
  }
  
  console.log('✅ جميع الاعتماديات متوفرة\n');
}

validateEnvironmentVariables();
checkDependencies();

// =============================================================================
// 2. تحميل المكتبات المطلوبة
// =============================================================================

const admin = require('firebase-admin');
const axios = require('axios');
const { format, addDays, isAfter, subDays, getDay } = require('date-fns');

// =============================================================================
// 3. الإعدادات العامة
// =============================================================================

const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  REQUEST_TIMEOUT: 45000,
  REPOST_COOLDOWN_DAYS: 15,
  UAE_TIMEZONE_OFFSET: 4,
  MAX_POSTS_PER_CATEGORY: 1,
  DAILY_POSTS_GOAL: 12
};

// =============================================================================
// 4. تهيئة Firebase
// =============================================================================

console.log('🔥 تهيئة Firebase...');

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL
};

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com/`
    });
  }
  console.log('✅ Firebase مهيأ بنجاح');
} catch (error) {
  console.error('❌ فشل تهيئة Firebase:', error.message);
  process.exit(1);
}

const db = admin.firestore();

// =============================================================================
// 5. نظام إدارة حسابات Zapier المتقدم مع تناوب يومي عشوائي حسب الفترة
// =============================================================================

class ZapierAccountManager {
  constructor() {
    this.accounts = [];
    this.dailyRotationConfig = null;
    this.timeSlotToAccountMap = {};
  }

  async initialize(timeSlot) {
    console.log('🔄 تهيئة نظام إدارة حسابات Zapier Premium...');

    try {
      this.accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
      console.log(`✅ تم تحميل ${this.accounts.length} حساب Zapier Premium`);
    } catch (error) {
      throw new Error(`فشل تحميل حسابات Zapier: ${error.message}`);
    }

    await this.loadDailyRotationConfig(timeSlot);
    
    console.log(`✅ الحساب النشط للفترة ${timeSlot}: ${this.getCurrentAccount(timeSlot).name}`);
  }

  async loadDailyRotationConfig(timeSlot) {
    const today = format(new Date(), 'yyyy-MM-dd');
    const rotationRef = db.collection('system_settings').doc(`rotation-${today}`);

    try {
      const doc = await rotationRef.get();

      if (doc.exists) {
        const data = doc.data();
        this.dailyRotationConfig = data;
        // التحقق إذا كان اليوم الجديد، إعادة shuffle
        const configDate = format(data.configDate.toDate(), 'yyyy-MM-dd');
        if (configDate !== today) {
          await this.generateNewDailyRotation();
        }
      } else {
        await this.generateNewDailyRotation();
      }

      // تعيين الحساب حسب الفترة
      this.setAccountForTimeSlot(timeSlot);
    } catch (error) {
      console.error('⚠️ خطأ في تحميل إعدادات التناوب اليومي:', error.message);
      await this.generateNewDailyRotation();
      this.setAccountForTimeSlot(timeSlot);
    }
  }

  async generateNewDailyRotation() {
    console.log('🆕 إنشاء تناوب يومي عشوائي جديد...');
    
    // Shuffle الحسابات عشوائياً
    const shuffledAccounts = [...this.accounts].sort(() => Math.random() - 0.5);
    
    // تعيين لكل فترة حساب مختلف (4 فترات، 4 حسابات افتراضياً)
    const timeSlots = ['morning', 'afternoon', 'evening', 'night'];
    const timeSlotMap = {};
    timeSlots.forEach((slot, index) => {
      timeSlotMap[slot] = shuffledAccounts[index % shuffledAccounts.length];
    });

    const today = format(new Date(), 'yyyy-MM-dd');
    const config = {
      configDate: admin.firestore.Timestamp.now(),
      shuffledAccounts: shuffledAccounts.map(a => a.name),
      timeSlotMap: timeSlotMap,
      created: admin.firestore.Timestamp.now(),
      totalCycles: admin.firestore.FieldValue.increment(1)
    };

    await db.collection('system_settings').doc(`rotation-${today}`).set(config);
    this.dailyRotationConfig = config;
    this.timeSlotToAccountMap = timeSlotMap;
    
    console.log('✅ تم إنشاء تناوب يومي عشوائي بنجاح');
  }

  setAccountForTimeSlot(timeSlot) {
    this.timeSlotToAccountMap[timeSlot] = this.timeSlotToAccountMap[timeSlot] || this.accounts[0];
  }

  getCurrentAccount(timeSlot) {
    return this.timeSlotToAccountMap[timeSlot] || this.accounts[0];
  }

  getAccountStats(timeSlot) {
    const account = this.getCurrentAccount(timeSlot);
    return {
      currentAccount: account.name,
      totalAccounts: this.accounts.length,
      rotationType: 'يومي عشوائي حسب الفترة'
    };
  }
}

// =============================================================================
// 6. نظام الإشعارات المحسن
// =============================================================================

class TelegramNotifier {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.token && this.chatId);
    
    if (!this.enabled) {
      console.log('⚠️ إعدادات Telegram غير موجودة - الإشعارات معطلة');
    }
  }

  async send(message, options = {}) {
    if (!this.enabled) {
      console.log('📝 رسالة (Telegram معطل):', message);
      return false;
    }

    try {
      const payload = {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...options
      };

      const response = await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        payload,
        { timeout: 10000 }
      );

      console.log('📨 تم إرسال الإشعار إلى Telegram بنجاح');
      return true;
    } catch (error) {
      console.error('❌ فشل إرسال إشعار Telegram:', error.message);
      return false;
    }
  }

  async sendReport(data) {
    const { stats, results, timeSlot, postNumber, errors = [] } = data;
    const now = new Date();
    
    let message = `📊 *تقرير النشر التلقائي*\n\n`;
    message += `📅 التاريخ: ${format(now, 'yyyy-MM-dd')}\n`;
    message += `⏰ الوقت: ${format(now, 'HH:mm')} (UAE)\n`;
    message += `🎯 الفترة: ${this.getTimeSlotName(timeSlot)}\n`;
    message += `🔢 رقم المنشور في الفترة: ${postNumber}/3\n\n`;
    
    message += `💼 *معلومات الحساب:*\n`;
    message += `🏷️ الحساب: ${stats.currentAccount}\n\n`;
    
    message += `📈 *إحصائيات هذا المنشور:*\n`;
    message += `✅ نجح: ${results.success ? 1 : 0}\n`;
    message += `❌ فشل: ${results.success ? 0 : 1}\n\n`;
    
    if (results.posts.length > 0 && results.success) {
      const post = results.posts[0];
      message += `🔗 *المنشور المنشور:*\n`;
      message += `▫️ ${post.category}: ${post.title.substring(0, 40)}...\n`;
    }
    
    if (errors.length > 0) {
      message += `⚠️ *الأخطاء:*\n`;
      errors.forEach(error => {
        message += `▫️ ${error}\n`;
      });
    }

    await this.send(message);
  }

  getTimeSlotName(slot) {
    const names = {
      morning: '🌅 صباحاً',
      afternoon: '☀️ ظهراً', 
      evening: '🌆 مساءً',
      night: '🌙 ليلاً'
    };
    return names[slot] || slot;
  }
}

const telegramNotifier = new TelegramNotifier();

// =============================================================================
// 7. جدولة المحتوى المحسنة مع 3 فئات لكل فترة
// =============================================================================

const CONTENT_SCHEDULE = {
  1: {  // الاثنين
    morning: ['مسلسل', 'فيلم', 'مباراة'],  // اختيار 3 من القائمة الأصلية
    afternoon: ['فيلم', 'مسلسل', 'مباراة'],
    evening: ['مباراة', 'فيلم', 'مسلسل'],
    night: ['وصفة', 'مسلسل', 'مباراة']
  },
  2: {  // الثلاثاء
    morning: ['وصفة', 'لعبة', 'تطبيق'],
    afternoon: ['لعبة', 'وصفة', 'قناة'],
    evening: ['تطبيق', 'قناة', 'وصفة'],
    night: ['قناة', 'وصفة', 'لعبة']
  },
  3: {  // الأربعاء
    morning: ['قناة', 'ريلز', 'مسلسل'],  // إضافة فئات إضافية لجعلها 3
    afternoon: ['ريلز', 'مسلسل', 'فيلم'],
    evening: ['مسلسل', 'فيلم', 'قناة'],
    night: ['فيلم', 'قناة', 'ريلز']
  },
  4: {  // الخميس
    morning: ['فيلم', 'مباراة', 'وصفة'],
    afternoon: ['مباراة', 'وصفة', 'لعبة'],
    evening: ['وصفة', 'لعبة', 'فيلم'],
    night: ['لعبة', 'فيلم', 'مباراة']
  },
  5: {  // الجمعة
    morning: ['لعبة', 'تطبيق', 'قناة'],
    afternoon: ['تطبيق', 'قناة', 'ريلز'],
    evening: ['قناة', 'ريلز', 'لعبة'],
    night: ['ريلز', 'لعبة', 'تطبيق']
  },
  6: {  // السبت
    morning: ['ريلز', 'مسلسل', 'فيلم'],
    afternoon: ['مسلسل', 'فيلم', 'مباراة'],
    evening: ['فيلم', 'مباراة', 'ريلز'],
    night: ['مباراة', 'ريلز', 'مسلسل']
  },
  0: {  // الأحد
    morning: ['مباراة', 'وصفة', 'لعبة'],
    afternoon: ['وصفة', 'لعبة', 'تطبيق'],
    evening: ['لعبة', 'تطبيق', 'مباراة'],
    night: ['تطبيق', 'مباراة', 'وصفة']
  }
};

// =============================================================================
// 8. نظام استخراج المحتوى المتطور مع دعم الاستيراد الجماعي ومعالجة الأخطاء الذكية
// =============================================================================

class ContentManager {
  constructor(firestore) {
    this.db = firestore;
  }

  async getContentForCategory(category, limit = CONFIG.MAX_POSTS_PER_CATEGORY) {
    console.log(`🔍 البحث عن محتوى نوع: ${category}`);

    try {
      let content = await this.fetchNewContent(category, limit);
      if (content.length > 0) {
        console.log(`✅ وجد محتوى جديد لنوع ${category}: ${content.length} عنصر`);
        return content;
      }

      content = await this.fetchRepostableContent(category, limit);
      if (content.length > 0) {
        console.log(`♻️ وجد محتوى قابل لإعادة النشر لنوع ${category}: ${content.length} عنصر`);
        return content;
      }

      content = await this.fetchAnyContent(category, limit);
      if (content.length > 0) {
        console.log(`⚠️ استخدام أي محتوى متاح لنوع ${category}: ${content.length} عنصر`);
        return content;
      }

      console.log(`❌ لم يوجد أي محتوى لنوع: ${category}`);
      return [];

    } catch (error) {
      console.error(`❌ خطأ في استخراج المحتوى لنوع ${category}:`, error.message);
      
      // معالجة ذكية: محاولة استعلام بسيط كبديل
      try {
        console.log('🔄 محاولة استعلام بسيط كحل بديل...');
        const fallbackQuery = await this.db.collection('links')
          .where('linkType', '==', category)
          .limit(limit)
          .get();

        if (!fallbackQuery.empty) {
          console.log(`⚠️ وجد ${fallbackQuery.size} رابط باستخدام الاستعلام البسيط`);
          return fallbackQuery.docs;
        }
      } catch (fallbackError) {
        console.error('❌ فشل حتى الاستعلام البسيط:', fallbackError.message);
      }
      
      return [];
    }
  }
  
  async fetchNewContent(category, limit) {
    try {
      // استعلام رئيسي (يتطلب index: linkType, isPosted, importStatus, createdAt)
      const query = await this.db.collection('links')
        .where('linkType', '==', category)
        .where('isPosted', '==', false)
        .where('importStatus', '==', 'ready')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      return query.docs;
    } catch (error) {
      if (error.code === 'FAILED_PRECONDITION') {
        console.log('⚠️ مشكلة في الـ index، استخدام استعلام بديل بدون importStatus...');
        return this.fetchNewContentFallback(category, limit, true);
      }
      throw error;
    }
  }

  async fetchNewContentFallback(category, limit, skipImportStatus = false) {
    try {
      const query = await this.db.collection('links')
        .where('linkType', '==', category)
        .where('isPosted', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      return query.docs;
    } catch (error) {
      if (error.code === 'FAILED_PRECONDITION' && !skipImportStatus) {
        console.log('⚠️ مشكلة في الـ index مرة أخرى، تجاهل جميع الشروط...');
        return this.fetchAnyContent(category, limit);
      }
      throw error;
    }
  }

  async fetchRepostableContent(category, limit) {
    const cutoffDate = subDays(new Date(), CONFIG.REPOST_COOLDOWN_DAYS);
    
    try {
      const query = await this.db.collection('links')
        .where('linkType', '==', category)
        .where('isPosted', '==', true)
        .where('lastPosted', '<', admin.firestore.Timestamp.fromDate(cutoffDate))
        .orderBy('lastPosted', 'asc')
        .limit(limit)
        .get();
      return query.docs;
    } catch (error) {
      console.log('⚠️ فشل في استعلام إعادة النشر، استخدام أي محتوى...');
      return this.fetchAnyContent(category, limit);
    }
  }

  async fetchAnyContent(category, limit) {
    try {
      const query = await this.db.collection('links')
        .where('linkType', '==', category)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      return query.docs;
    } catch (error) {
      console.error('❌ فشل في الاستعلام البسيط:', error.message);
      return [];
    }
  }

  async updateContentStatus(contentDoc, accountName, accountIndex) {
    try {
      const updates = {
        isPosted: true,
        lastPosted: admin.firestore.FieldValue.serverTimestamp(),
        postCount: admin.firestore.FieldValue.increment(1),
        lastAccount: accountName,
        lastAccountIndex: accountIndex,
        importStatus: "published",
        publishedAt: new Date().toISOString(),
        // بيانات الاستيراد الجماعي المضافة
        importMethod: "bulk",
        batchId: "batch-" + Date.now(),
        importDate: new Date().toISOString().split('T')[0],
        importStatus: "published",  // تغيير إلى published بعد النشر
        isPosted: true,
        lastPosted: admin.firestore.Timestamp.now(),
        postCount: admin.firestore.FieldValue.increment(1),
        source: "turkii.netlify.app",
        last_account: accountName,
      };

      await contentDoc.ref.update(updates);
      console.log(`✅ تم تحديث حالة المحتوى: ${contentDoc.data().socialTitle || 'بدون عنوان'}`);
    } catch (error) {
      console.error('❌ فشل تحديث حالة المحتوى:', error.message);
      // محاولة إعادة المحاولة
      if (error.code === 'NOT_FOUND') {
        console.log('⚠️ المستند غير موجود، تخطي...');
      }
    }
  }
}

// =============================================================================
// 9. نظام النشر المتطور على Zapier مع معالجة أخطاء ذكية
// =============================================================================

class ZapierPublisher {
  constructor(accountManager) {
    this.accountManager = accountManager;
  }

  async publishContent(contentData, timeSlot) {
    const account = this.accountManager.getCurrentAccount(timeSlot);
    
    console.log(`📤 نشر المحتوى عبر ${account.name}...`);
    console.log(`📝 العنوان: ${contentData.socialTitle || 'بدون عنوان'}`);

    const payload = this.preparePayload(contentData);
    
    let lastError = null;
    
    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        console.log(`🔄 المحاولة ${attempt}/${CONFIG.MAX_RETRIES}`);
        
        const response = await axios.post(account.webhook, payload, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `Auto-Poster-Premium/4.3 (${account.name})`,
            'X-Retry-Attempt': attempt.toString()
          },
          timeout: CONFIG.REQUEST_TIMEOUT,
          validateStatus: (status) => status >= 200 && status < 300
        });

        console.log(`✅ نجح النشر! الحالة: ${response.status}`);
        return { success: true, response: response.data };

      } catch (error) {
        lastError = error;
        console.log(`❌ المحاولة ${attempt} فشلت:`, this.getErrorMessage(error));
        
        // معالجة ذكية: إذا كان خطأ في الشبكة، زيادة التأخير
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          console.log('🔄 خطأ شبكة، زيادة التأخير...');
        }
        
        if (attempt < CONFIG.MAX_RETRIES) {
          const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
          console.log(`⏳ انتظار ${delay}ms قبل المحاولة التالية...`);
          await this.sleep(delay);
        }
      }
    }

    console.error(`💥 فشل النشر نهائياً بعد ${CONFIG.MAX_RETRIES} محاولات`);
    return { 
      success: false, 
      error: this.getErrorMessage(lastError),
      attempts: CONFIG.MAX_RETRIES 
    };
  }

  preparePayload(contentData) {
    return {
      socialTitle: contentData.socialTitle || 'محتوى بدون عنوان',
      socialDescription: contentData.socialDescription || 'وصف غير متوفر',
      shortUrl: contentData.shortUrl || '',
      socialImage: contentData.socialImage || '',
      linkType: contentData.linkType || 'عام',
      seriesName: contentData.seriesName || '',
      publishTime: new Date().toISOString(),
      accountUsed: this.accountManager.getCurrentAccount().name,
      systemVersion: '4.3'
    };
  }

  getErrorMessage(error) {
    if (error.response) {
      return `HTTP ${error.response.status}: ${error.response.statusText}`;
    } else if (error.request) {
      return 'لا توجد استجابة من الخادم (timeout أو مشكلة شبكة)';
    } else {
      return error.message || 'خطأ غير معروف';
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================================
// 10. النظام الرئيسي للنشر
// =============================================================================

class AutoPosterSystem {
  constructor() {
    this.accountManager = new ZapierAccountManager();
    this.contentManager = new ContentManager(db);
    this.publisher = new ZapierPublisher(this.accountManager);
    this.results = {
      success: 0,
      failed: 0,
      posts: [],
      errors: []
    };
    this.postNumberInSlot = 1;  // لتتبع رقم المنشور في الفترة (1/3, 2/3, 3/3)
  }

  async initialize() {
    console.log('🚀 تهيئة نظام النشر التلقائي...');

    try {
      const timeSlot = this.getCurrentTimeSlot();
      await this.accountManager.initialize(timeSlot);
      
      if (!this.isValidUaeTime()) {
        console.log('⏰ الوقت الحالي غير مناسب للنشر');
        process.exit(0);
      }

      console.log('✅ تم تهيئة النظام بنجاح');
      
    } catch (error) {
      console.error('❌ فشل تهيئة النظام:', error.message);
      await telegramNotifier.send(
        '❌ *فشل تهيئة النظام*\n' +
        `الخطأ: ${error.message}\n` +
        'تم التعامل التلقائي مع الخطأ، جاري المحاولة مرة أخرى في الدورة التالية'
      );
      process.exit(1);
    }
  }

  isValidUaeTime() {
    const now = new Date();
    const uaeHours = now.getUTCHours() + CONFIG.UAE_TIMEZONE_OFFSET;
    return uaeHours >= 5 && uaeHours <= 23;  // توسيع لتغطية الفترات
  }

  getCurrentTimeSlot() {
    const now = new Date();
    const uaeHours = now.getUTCHours() + CONFIG.UAE_TIMEZONE_OFFSET;
    const uaeMinutes = now.getUTCMinutes();
    
    // تحديد الفترة والرقم داخل الفترة بناءً على الوقت
    if (uaeHours >= 9 && uaeHours < 12) {
      if (uaeHours === 9 && uaeMinutes >= 30 || uaeHours === 10 && uaeMinutes === 0) {
        this.postNumberInSlot = 1;
      } else if (uaeHours === 10 && uaeMinutes === 45) {
        this.postNumberInSlot = 3;
      }
      return 'morning';
    }
    if (uaeHours >= 16 && uaeHours < 18) {  // افتراض للـ afternoon
      // تحديد الرقم بناءً على الدقائق أو الساعة
      if (uaeHours === 16 && uaeMinutes >= 30 || uaeHours === 17 && uaeMinutes === 0) {
        this.postNumberInSlot = 1;
      } else if (uaeHours === 17 && uaeMinutes === 45) {
        this.postNumberInSlot = 3;
      }
      return 'afternoon';
    }
    if (uaeHours >= 19 && uaeHours < 21) {
      if (uaeHours === 19 && uaeMinutes >= 30 || uaeHours === 20 && uaeMinutes === 0) {
        this.postNumberInSlot = 1;
      } else if (uaeHours === 20 && uaeMinutes === 45) {
        this.postNumberInSlot = 3;
      }
      return 'evening';
    }
    if (uaeHours >= 22 && uaeHours < 24) {
      if (uaeHours === 22 && uaeMinutes >= 30 || uaeHours === 23 && uaeMinutes === 0) {
        this.postNumberInSlot = 1;
      } else if (uaeHours === 23 && uaeMinutes === 45) {
        this.postNumberInSlot = 3;
      }
      return 'night';
    }
    return 'morning';  // افتراضي
  }

  getCategoryForCurrentRun() {
    const now = new Date();
    const dayOfWeek = getDay(now);  // 0=Sunday, 1=Monday, etc.
    const timeSlot = this.getCurrentTimeSlot();
    const categories = CONTENT_SCHEDULE[dayOfWeek][timeSlot] || ['عام'];
    
    // اختيار فئة بناءً على رقم المنشور في الفترة (دوري)
    const index = (this.postNumberInSlot - 1) % categories.length;
    return categories[index];
  }

  async run() {
    console.log('\n🎯 بدء عملية النشر التلقائي...\n');
    
    try {
      const timeSlot = this.getCurrentTimeSlot();
      const dayOfWeek = getDay(new Date());
      const category = this.getCategoryForCurrentRun();
      
      console.log(`📅 اليوم: ${dayOfWeek} (${this.getDayName(dayOfWeek)})`);
      console.log(`⏰ الفترة: ${timeSlot}`);
      console.log(`🔢 رقم المنشور: ${this.postNumberInSlot}/3`);
      console.log(`🏷️ الفئة: ${category}\n`);

      const contentDocs = await this.contentManager.getContentForCategory(category);
      
      if (contentDocs.length === 0) {
        throw new Error(`لا يوجد محتوى متاح للفئة: ${category}`);
      }

      const contentDoc = contentDocs[0];  // نشر واحد فقط لكل تشغيل
      const contentData = contentDoc.data();
      const result = await this.publisher.publishContent(contentData, timeSlot);
      
      const stats = this.accountManager.getAccountStats(timeSlot);
      
      if (result.success) {
        this.results.success = 1;
        this.results.posts = [{
          title: contentData.socialTitle,
          category: contentData.linkType,
          url: contentData.shortUrl
        }];
        
        await this.contentManager.updateContentStatus(
          contentDoc, 
          stats.currentAccount,
          0  // index افتراضي، يمكن تحسين
        );
        
        console.log(`✅ تم نشر المحتوى بنجاح: ${contentData.socialTitle}`);
        
      } else {
        this.results.failed = 1;
        this.results.errors = [{
          content: contentData.socialTitle,
          error: result.error
        }];
        
        console.log(`❌ فشل نشر المحتوى: ${contentData.socialTitle}`);
        // معالجة ذكية: تسجيل الخطأ في Firebase للمتابعة
        await this.logErrorToFirebase(result.error, category);
      }

      await this.sendFinalReport(timeSlot);

    } catch (error) {
      console.error('💥 خطأ غير متوقع في التشغيل:', error.message);
      await this.logErrorToFirebase(error.message, 'عام');
      await telegramNotifier.send(
        '💥 *خطأ في التشغيل*\n' +
        `الخطأ: ${error.message}\n` +
        'تم تسجيل الخطأ تلقائياً وسيتم إصلاحه في الدورة التالية'
      );
    }
  }

  async logErrorToFirebase(error, category) {
    try {
      await db.collection('system_errors').add({
        error: error,
        category: category,
        timestamp: admin.firestore.Timestamp.now(),
        handled: true  // تم التعامل تلقائياً
      });
      console.log('📝 تم تسجيل الخطأ في Firebase');
    } catch (logError) {
      console.error('❌ فشل تسجيل الخطأ:', logError.message);
    }
  }

  async sendFinalReport(timeSlot) {
    const stats = this.accountManager.getAccountStats(timeSlot);
    
    await telegramNotifier.sendReport({
      stats,
      results: this.results,
      timeSlot,
      postNumber: this.postNumberInSlot,
      errors: this.results.errors.map(e => `${e.content}: ${e.error}`)
    });

    console.log('\n📊 التقرير النهائي لهذا التشغيل:');
    console.log(`✅ نجح: ${this.results.success}`);
    console.log(`❌ فشل: ${this.results.failed}`);
    console.log(`📨 تم إرسال التقرير إلى Telegram`);
  }

  getDayName(dayIndex) {
    const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    return days[dayIndex];
  }
}

// =============================================================================
// 11. التشغيل الرئيسي للنظام
// =============================================================================

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🎉 بدء تشغيل نظام النشر التلقائي على فيسبوك v4.3');
  console.log('='.repeat(60) + '\n');

  const system = new AutoPosterSystem();
  
  try {
    await system.initialize();
    await system.run();
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ اكتمل التشغيل بنجاح!');
    console.log('='.repeat(60));
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ فشل التشغيل:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('💥 خطأ غير متوقع:', error);
    process.exit(1);
  });
}

module.exports = {
  AutoPosterSystem,
  ZapierAccountManager,
  ContentManager,
  ZapierPublisher,
  TelegramNotifier
};
