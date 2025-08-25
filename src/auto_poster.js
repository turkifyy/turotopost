#!/usr/bin/env node

/**
 * نظام النشر التلقائي على فيسبوك v5.0
 * مطور بواسطة: Turki
 * التاريخ: 2025
 * الوصف: نظام متقدم للنشر التلقائي مع دعم الاستيراد الجماعي والجدولة الذكية
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
  const deps = ['firebase-admin', 'axios', 'date-fns', 'crypto'];
  
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
const { format, addDays, isAfter, subDays, addMinutes } = require('date-fns');
const crypto = require('crypto');

// =============================================================================
// 3. الإعدادات العامة
// =============================================================================

const CONFIG = {
  ROTATION_DAYS: 13,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  REQUEST_TIMEOUT: 45000,
  REPOST_COOLDOWN_DAYS: 15,
  UAE_TIMEZONE_OFFSET: 4,
  MAX_POSTS_PER_CATEGORY: 1,
  POST_DELAY_MINUTES: 30, // التأخير بين المنشورات
  MAX_ERROR_RETRIES: 5,   // الحد الأقصى لمحاولات إصلاح الأخطاء
  ERROR_RETRY_DELAY: 5000 // تأخير بين محاولات إصلاح الأخطاء
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
// 5. جدولة المحتوى المحسنة مع 3 منشورات لكل فترة
// =============================================================================

const CONTENT_SCHEDULE = {
  1: { // الاثنين
    morning: ['مسلسل', 'فيلم', 'مباراة', 'وصفة'],
    afternoon: ['فيلم', 'مسلسل', 'مباراة', 'وصفة'],
    evening: ['مباراة', 'فيلم', 'وصفة', 'مسلسل'],
    night: ['وصفة', 'مسلسل', 'مباراة', 'فيلم']
  },
  2: { // الثلاثاء
    morning: ['وصفة', 'لعبة', 'تطبيق', 'قناة'],
    afternoon: ['لعبة', 'وصفة', 'قناة', 'تطبيق'],
    evening: ['تطبيق', 'قناة', 'وصفة', 'لعبة'],
    night: ['قناة', 'وصفة', 'لعبة', 'تطبيق']
  },
  3: { // الأربعاء
    morning: ['قناة'],
    afternoon: ['ريلز'],
    evening: ['مسلسل'],
    night: ['فيلم']
  },
  4: { // الخميس
    morning: ['فيلم'],
    afternoon: ['مباراة'],
    evening: ['وصفة'],
    night: ['لعبة']
  },
  5: { // الجمعة
    morning: ['لعبة'],
    afternoon: ['تطبيق'],
    evening: ['قناة'],
    night: ['ريلز']
  },
  6: { // السبت
    morning: ['ريلز'],
    afternoon: ['مسلسل'],
    evening: ['فيلم'],
    night: ['مباراة']
  },
  0: { // الأحد
    morning: ['مباراة'],
    afternoon: ['وصفة'], 
    evening: ['لعبة'],
    night: ['تطبيق']
  }
};

// =============================================================================
// 6. نظام إدارة حسابات Zapier المتقدم مع توزيع حسب الفترة
// =============================================================================

class ZapierAccountManager {
  constructor() {
    this.accounts = [];
    this.currentAccountIndex = 0;
    this.rotationConfig = null;
    this.dailyRotationMap = {}; // خريطة التناوب اليومي
  }

  async initialize() {
    console.log('🔄 تهيئة نظام إدارة حسابات Zapier Premium...');

    try {
      this.accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
      console.log(`✅ تم تحميل ${this.accounts.length} حساب Zapier Premium`);
    } catch (error) {
      throw new Error(`فشل تحميل حسابات Zapier: ${error.message}`);
    }

    await this.loadRotationConfig();
    await this.setupDailyRotation();
    
    console.log(`✅ الحساب النشط: ${this.getCurrentAccount().name} (${this.currentAccountIndex + 1})`);
  }

  async setupDailyRotation() {
    const today = format(new Date(), 'yyyy-MM-dd');
    const rotationRef = db.collection('system_settings').doc('daily_rotation');
    
    try {
      const doc = await rotationRef.get();
      
      if (doc.exists && doc.data().date === today) {
        // استخدام التوزيع الحالي لهذا اليوم
        this.dailyRotationMap = doc.data().rotationMap;
        console.log('✅ تم تحميل توزيع الحسابات اليومي');
      } else {
        // إنشاء توزيع جديد عشوائي لهذا اليوم
        await this.createDailyRotation(rotationRef, today);
      }
    } catch (error) {
      console.error('⚠️ خطأ في تحميل التوزيع اليومي:', error.message);
      // إنشاء توزيع افتراضي في حالة الخطأ
      this.createFallbackRotation();
    }
  }

  async createDailyRotation(rotationRef, today) {
    // إنشاء توزيع عشوائي للحسابات حسب الفترات
    const periods = ['morning', 'afternoon', 'evening', 'night'];
    const rotationMap = {};
    
    periods.forEach(period => {
      // اختيار حساب عشوائي لكل فترة
      const randomIndex = crypto.randomInt(0, this.accounts.length);
      rotationMap[period] = randomIndex;
    });
    
    this.dailyRotationMap = rotationMap;
    
    // حفظ التوزيع في Firebase
    await rotationRef.set({
      date: today,
      rotationMap: rotationMap,
      createdAt: admin.firestore.Timestamp.now()
    });
    
    console.log('✅ تم إنشاء توزيع جديد للحسابات اليومي');
  }

  createFallbackRotation() {
    // توزيع افتراضي في حالة حدوث خطأ
    this.dailyRotationMap = {
      morning: 0,
      afternoon: 1,
      evening: 2,
      night: 3
    };
    
    console.log('⚠️ استخدام التوزيع الافتراضي للحسابات');
  }

  async loadRotationConfig() {
    const rotationRef = db.collection('system_settings').doc('rotation');

    try {
      const doc = await rotationRef.get();

      if (doc.exists) {
        const data = doc.data();
        this.currentAccountIndex = data.currentAccountIndex || 0;
        this.rotationConfig = data;

        const now = new Date();
        const nextRotationDate = data.nextRotationDate.toDate();

        if (isAfter(now, nextRotationDate)) {
          await this.rotateAccount();
        }
      } else {
        await this.createInitialRotationConfig();
      }
    } catch (error) {
      console.error('⚠️ خطأ في تحميل إعدادات التناوب:', error.message);
      this.currentAccountIndex = 0;
    }
  }

  async createInitialRotationConfig() {
    console.log('🆕 إنشاء إعدادات التناوب الأولية...');
    
    const now = new Date();
    const nextRotationDate = addDays(now, CONFIG.ROTATION_DAYS);

    const config = {
      currentAccountIndex: 0,
      startDate: admin.firestore.Timestamp.now(),
      nextRotationDate: admin.firestore.Timestamp.fromDate(nextRotationDate),
      totalCycles: 0,
      created: admin.firestore.Timestamp.now(),
      lastRotation: null,
      accountsUsed: this.accounts.length
    };

    await db.collection('system_settings').doc('rotation').set(config);
    this.rotationConfig = config;
    
    console.log('✅ تم إنشاء إعدادات التناوب بنجاح');
  }

  async rotateAccount() {
    const previousIndex = this.currentAccountIndex;
    this.currentAccountIndex = (this.currentAccountIndex + 1) % this.accounts.length;
    
    const now = new Date();
    const nextRotationDate = addDays(now, CONFIG.ROTATION_DAYS);

    const updates = {
      currentAccountIndex: this.currentAccountIndex,
      lastRotation: admin.firestore.Timestamp.now(),
      nextRotationDate: admin.firestore.Timestamp.fromDate(nextRotationDate),
      totalCycles: admin.firestore.FieldValue.increment(1),
      previousAccount: this.accounts[previousIndex]?.name || 'unknown'
    };

    await db.collection('system_settings').doc('rotation').update(updates);

    await telegramNotifier.send(
      `🔄 *تم التبديل إلى حساب جديد!*\n\n` +
      `🔹 من: ${this.accounts[previousIndex]?.name || 'غير معروف'}\n` +
      `🔹 إلى: ${this.getCurrentAccount().name}\n` +
      `📅 تاريخ التبديل القادم: ${format(nextRotationDate, 'yyyy-MM-dd')}\n` +
      `📊 إجمالي دورات التناوب: ${(this.rotationConfig?.totalCycles || 0) + 1}`
    );

    console.log(`🔄 تم التبديل من الحساب ${previousIndex + 1} إلى الحساب ${this.currentAccountIndex + 1}`);
  }

  getAccountForPeriod(period) {
    const accountIndex = this.dailyRotationMap[period] || 0;
    return this.accounts[accountIndex] || this.accounts[0];
  }

  getCurrentAccount() {
    return this.accounts[this.currentAccountIndex] || this.accounts[0];
  }

  getAccountStats() {
    const account = this.getCurrentAccount();
    const rotationInfo = this.rotationConfig;
    
    return {
      currentAccount: account.name,
      accountIndex: this.currentAccountIndex + 1,
      totalAccounts: this.accounts.length,
      rotationStartDate: rotationInfo?.startDate?.toDate(),
      nextRotationDate: rotationInfo?.nextRotationDate?.toDate(),
      totalCycles: rotationInfo?.totalCycles || 0,
      dailyRotation: this.dailyRotationMap
    };
  }
}

// =============================================================================
// 7. نظام الإشعارات المحسن
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
    const { stats, results, timeSlot, errors = [] } = data;
    const now = new Date();
    
    let message = `📊 *تقرير النشر التلقائي*\n\n`;
    message += `📅 التاريخ: ${format(now, 'yyyy-MM-dd')}\n`;
    message += `⏰ الوقت: ${format(now, 'HH:mm')} (UAE)\n`;
    message += `🎯 الفترة: ${this.getTimeSlotName(timeSlot)}\n\n`;
    
    message += `💼 *معلومات الحساب:*\n`;
    message += `🏷️ الحساب: ${stats.currentAccount}\n`;
    message += `📊 رقم الحساب: ${stats.accountIndex}/${stats.totalAccounts}\n\n`;
    
    message += `📈 *إحصائيات النشر:*\n`;
    message += `✅ نجح: ${results.success}\n`;
    message += `❌ فشل: ${results.failed}\n`;
    message += `📊 المعدل: ${((results.success / (results.success + results.failed)) * 100).toFixed(1)}%\n\n`;
    
    if (results.posts.length > 0) {
      message += `🔗 *المنشورات المنشورة:*\n`;
      results.posts.forEach(post => {
        message += `▫️ ${post.category}: ${post.title.substring(0, 40)}...\n`;
      });
      message += `\n`;
    }
    
    if (errors.length > 0) {
      message += `⚠️ *الأخطاء:*\n`;
      errors.slice(0, 3).forEach(error => {
        message += `▫️ ${error}\n`;
      });
      if (errors.length > 3) {
        message += `▫️ و ${errors.length - 3} أخطاء أخرى...\n`;
      }
    }

    await this.send(message);
  }

  getTimeSlotName(slot) {
    const names = {
      morning: '🌅 صباحاً',
      afternoon: '☀️ ظهراً', 
      evening: '🌅 مساءً',
      night: '🌙 ليلاً'
    };
    return names[slot] || slot;
  }
}

const telegramNotifier = new TelegramNotifier();

// =============================================================================
// 8. نظام استخراج المحتوى المتطور مع دعم الاستيراد الجماعي
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
      
      // معالجة خطأ الفهرس تلقائياً
      if (error.message.includes('index') || error.message.includes('FAILED_PRECONDITION')) {
        console.log('🛠️ محاولة إصلاح خطأ الفهرس تلقائياً...');
        return await this.handleIndexError(category, limit, error);
      }
      
      console.log('🔍 البحث عن أي محتوى متاح كحل بديل...');
      const fallbackQuery = await this.db.collection('links')
        .where('linkType', '==', category)
        .limit(limit)
        .get();

      if (!fallbackQuery.empty) {
        console.log(`⚠️ وجد ${fallbackQuery.size} رابط ولكن قد يكون منشوراً مسبقاً`);
        return fallbackQuery.docs;
      }
      
      return [];
    }
  }
  
  async handleIndexError(category, limit, error) {
    console.log(`🛠️ معالجة خطأ الفهرس للفئة: ${category}`);
    
    try {
      // المحاولة الأولى: البحث بدون ترتيب
      const query1 = await this.db.collection('links')
        .where('linkType', '==', category)
        .where('isPosted', '==', false)
        .where('importStatus', '==', 'ready')
        .limit(limit)
        .get();
        
      if (!query1.empty) return query1.docs;
      
      // المحاولة الثانية: البحث بأقل شروط
      const query2 = await this.db.collection('links')
        .where('linkType', '==', category)
        .limit(limit)
        .get();
        
      if (!query2.empty) return query2.docs;
      
      // المحاولة الثالثة: البحث بأي طريقة
      const query3 = await this.db.collection('links')
        .limit(limit)
        .get();
        
      const filteredDocs = query3.docs.filter(doc => doc.data().linkType === category);
      if (filteredDocs.length > 0) return filteredDocs;
      
      console.log('❌ لم يتم العثور على أي محتوى بعد معالجة الخطأ');
      return [];
      
    } catch (retryError) {
      console.error('❌ فشل معالجة خطأ الفهرس:', retryError.message);
      return [];
    }
  }
  
  async fetchNewContent(category, limit) {
    try {
      // يتطلب composite index: linkType ASC, isPosted ASC, importStatus ASC, createdAt DESC
      const query = await this.db.collection('links')
        .where('linkType', '==', category)
        .where('isPosted', '==', false)
        .where('importStatus', '==', 'ready')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      return query.docs;
    } catch (error) {
      if (error.message.includes('index')) {
        // تجربة بديلة بدون ترتيب إذا كان هناك خطأ في الفهرس
        const fallbackQuery = await this.db.collection('links')
          .where('linkType', '==', category)
          .where('isPosted', '==', false)
          .where('importStatus', '==', 'ready')
          .limit(limit)
          .get();
          
        return fallbackQuery.docs;
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
      if (error.message.includes('index')) {
        // تجربة بديلة بدون ترتيب
        const fallbackQuery = await this.db.collection('links')
          .where('linkType', '==', category)
          .where('isPosted', '==', true)
          .limit(limit)
          .get();
          
        // تصفية يدوية للتاريخ
        const filteredDocs = fallbackQuery.docs.filter(doc => {
          const lastPosted = doc.data().lastPosted?.toDate();
          return lastPosted && lastPosted < cutoffDate;
        });
        
        return filteredDocs.slice(0, limit);
      }
      throw error;
    }
  }

  async fetchAnyContent(category, limit) {
    const query = await this.db.collection('links')
      .where('linkType', '==', category)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    return query.docs;
  }

  async updateContentStatus(contentDoc, accountName) {
    try {
      const updates = {
        isPosted: true,
        lastPosted: admin.firestore.FieldValue.serverTimestamp(),
        postCount: admin.firestore.FieldValue.increment(1),
        lastAccount: accountName,
        lastAccountIndex: accountManager.currentAccountIndex,
        importStatus: "published", // ✅ تحديث حالة الاستيراد الجماعي
        publishedAt: new Date().toISOString() // ✅ وقت النشر
      };

      await contentDoc.ref.update(updates);
      console.log(`✅ تم تحديث حالة المحتوى: ${contentDoc.data().socialTitle || 'بدون عنوان'}`);
    } catch (error) {
      console.error('❌ فشل تحديث حالة المحتوى:', error.message);
    }
  }
}

// =============================================================================
// 9. نظام النشر المتطور على Zapier
// =============================================================================

class ZapierPublisher {
  constructor(accountManager) {
    this.accountManager = accountManager;
  }

  async publishContent(contentData, period) {
    const account = this.accountManager.getAccountForPeriod(period);
    
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
            'User-Agent': `Auto-Poster-Premium/5.0 (${account.name})`,
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
      systemVersion: '5.0',
      // بيانات الاستيراد الجماعي
      importMethod: contentData.importMethod || "bulk",
      batchId: contentData.batchId || "batch-" + Date.now(),
      importDate: contentData.importDate || new Date().toISOString().split('T')[0],
      source: contentData.source || "turkii.netlify.app"
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
  }

  async initialize() {
    console.log('🚀 تهيئة نظام النشر التلقائي...');

    try {
      await this.accountManager.initialize();
      
      if (!this.isValidUaeTime()) {
        console.log('⏰ الوقت الحالي غير مناسب للنشر (خارج أوقات الذروة)');
        await telegramNotifier.send(
          '⏰ *النظام متوقف مؤقتاً*\n' +
          'الوقت الحالي غير مناسب للنشر حسب توقيت الإمارات\n' +
          'سيتم التشغيل تلقائياً في الأوقات المثلى'
        );
        process.exit(0);
      }

      console.log('✅ تم تهيئة النظام بنجاح');
      
    } catch (error) {
      console.error('❌ فشل تهيئة النظام:', error.message);
      await telegramNotifier.send(
        '❌ *فشل تهيئة النظام*\n' +
        `الخطأ: ${error.message}\n` +
        'يجب التدخل الفوري لإصلاح المشكلة'
      );
      process.exit(1);
    }
  }

  isValidUaeTime() {
    const now = new Date();
    const uaeHours = now.getUTCHours() + CONFIG.UAE_TIMEZONE_OFFSET;
    const dayOfWeek = now.getUTCDay();
    
    const isPeakTime = uaeHours >= 8 && uaeHours <= 23;
    
    if (dayOfWeek === 5) { // الجمعة
      return uaeHours >= 14 && uaeHours <= 23;
    }
    
    return isPeakTime;
  }

  getCurrentTimeSlot() {
    const now = new Date();
    const uaeHours = now.getUTCHours() + CONFIG.UAE_TIMEZONE_OFFSET;
    const uaeMinutes = now.getUTCMinutes();
    
    // تحديد الفترة بناءً على الوقت الحالي
    if (uaeHours >= 5 && uaeHours < 12) return 'morning';
    if (uaeHours >= 12 && uaeHours < 17) return 'afternoon';
    if (uaeHours >= 17 && uaeHours < 21) return 'evening';
    return 'night';
  }

  getPostSequence() {
    const now = new Date();
    const uaeHours = now.getUTCHours() + CONFIG.UAE_TIMEZONE_OFFSET;
    const uaeMinutes = now.getUTCMinutes();
    
    // تحديد تسلسل النشر داخل الفترة
    if (uaeHours === 9 && uaeMinutes >= 30) return 1; // 9:30
    if (uaeHours === 10 && uaeMinutes < 30) return 2; // 10:00
    if (uaeHours === 10 && uaeMinutes >= 45) return 3; // 10:45
    
    if (uaeHours === 16 && uaeMinutes >= 30) return 1; // 4:30
    if (uaeHours === 17 && uaeMinutes < 0) return 2;   // 5:00
    if (uaeHours === 17 && uaeMinutes >= 45) return 3; // 5:45
    
    if (uaeHours === 19 && uaeMinutes >= 30) return 1; // 7:30
    if (uaeHours === 20 && uaeMinutes < 0) return 2;   // 8:00
    if (uaeHours === 20 && uaeMinutes >= 45) return 3; // 8:45
    
    if (uaeHours === 22 && uaeMinutes >= 30) return 1; // 10:30
    if (uaeHours === 23 && uaeMinutes < 0) return 2;   // 11:00
    if (uaeHours === 23 && uaeMinutes >= 45) return 3; // 11:45
    
    return 1; // افتراضي
  }

  async run() {
    console.log('\n🎯 بدء عملية النشر التلقائي...\n');
    
    try {
      const timeSlot = this.getCurrentTimeSlot();
      const postSequence = this.getPostSequence();
      const dayOfWeek = new Date().getUTCDay();
      const categories = CONTENT_SCHEDULE[dayOfWeek][timeSlot] || ['عام'];
      
      console.log(`📅 اليوم: ${dayOfWeek} (${this.getDayName(dayOfWeek)})`);
      console.log(`⏰ الفترة: ${timeSlot}`);
      console.log(`🔢 تسلسل النشر: ${postSequence}/3`);
      console.log(`🏷️ الفئات المستهدفة: ${categories.join(', ')}\n`);

      // اختيار الفئة المناسبة للتسلسل الحالي
      const categoryIndex = (postSequence - 1) % categories.length;
      const targetCategory = categories[categoryIndex];
      
      console.log(`🎯 الفئة المحددة: ${targetCategory} (${categoryIndex + 1}/${categories.length})`);

      const contentDocs = await this.contentManager.getContentForCategory(targetCategory);
      
      if (contentDocs.length === 0) {
        console.log(`⚠️ لا يوجد محتوى متاح للفئة: ${targetCategory}`);
        
        // محاولة استخدام فئة بديلة
        const fallbackCategory = categories[(categoryIndex + 1) % categories.length];
        console.log(`🔄 المحاولة مع الفئة البديلة: ${fallbackCategory}`);
        
        const fallbackContent = await this.contentManager.getContentForCategory(fallbackCategory);
        if (fallbackContent.length === 0) {
          throw new Error(`لا يوجد محتوى متاح لأي فئة في ${categories.join(', ')}`);
        }
        
        await this.publishContent(fallbackContent[0], targetCategory, timeSlot);
      } else {
        await this.publishContent(contentDocs[0], targetCategory, timeSlot);
      }

      await this.sendFinalReport(timeSlot);

    } catch (error) {
      console.error('💥 خطأ غير متوقع في التشغيل:', error.message);
      await telegramNotifier.send(
        '💥 *خطأ في التشغيل*\n' +
        `الخطأ: ${error.message}\n` +
        'يجب التدقيق في النظام'
      );
    }
  }

  async publishContent(contentDoc, category, timeSlot) {
    const contentData = contentDoc.data();
    const result = await this.publisher.publishContent(contentData, timeSlot);
    
    if (result.success) {
      this.results.success++;
      this.results.posts.push({
        title: contentData.socialTitle,
        category: contentData.linkType,
        url: contentData.shortUrl
      });
      
      await this.contentManager.updateContentStatus(
        contentDoc, 
        this.accountManager.getAccountForPeriod(timeSlot).name
      );
      
      console.log(`✅ تم نشر المحتوى بنجاح: ${contentData.socialTitle}`);
      
    } else {
      this.results.failed++;
      this.results.errors.push({
        content: contentData.socialTitle,
        error: result.error
      });
      
      console.log(`❌ فشل نشر المحتوى: ${contentData.socialTitle}`);
      
      // محاولة إصلاح الخطأ تلقائياً
      await this.autoFixError(result.error, contentDoc, category, timeSlot);
    }
  }

  async autoFixError(error, contentDoc, category, timeSlot) {
    console.log('🛠️ محاولة إصلاح الخطأ تلقائياً...');
    
    for (let attempt = 1; attempt <= CONFIG.MAX_ERROR_RETRIES; attempt++) {
      console.log(`🔄 محاولة الإصلاح ${attempt}/${CONFIG.MAX_ERROR_RETRIES}`);
      
      try {
        if (error.includes('index') || error.includes('FAILED_PRECONDITION')) {
          // خطأ في الفهرس - تجربة محتوى بديل
          console.log('🔧 معالجة خطأ الفهرس...');
          const alternativeContent = await this.contentManager.getContentForCategory(category);
          
          if (alternativeContent.length > 0 && alternativeContent[0].id !== contentDoc.id) {
            console.log('🔁 تجربة محتوى بديل...');
            await this.publishContent(alternativeContent[0], category, timeSlot);
            return;
          }
        } else if (error.includes('timeout') || error.includes('network')) {
          // خطأ في الشبكة - إعادة المحاولة بعد تأخير
          console.log('🌐 إعادة المحاولة بعد خطأ الشبكة...');
          await this.delay(CONFIG.ERROR_RETRY_DELAY * attempt);
          await this.publishContent(contentDoc, category, timeSlot);
          return;
        }
        
        // إذا لم يكن الخطأ معروفاً، ننتقل إلى المحتوى التالي
        console.log('⏭️ تخطي المحتوى بسبب خطأ غير قابل للإصلاح');
        break;
        
      } catch (fixError) {
        console.error(`❌ فشل محاولة الإصلاح ${attempt}:`, fixError.message);
        await this.delay(CONFIG.ERROR_RETRY_DELAY);
      }
    }
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async sendFinalReport(timeSlot) {
    const stats = this.accountManager.getAccountStats();
    
    await telegramNotifier.sendReport({
      stats,
      results: this.results,
      timeSlot,
      errors: this.results.errors.map(e => `${e.content}: ${e.error}`)
    });

    console.log('\n📊 التقرير النهائي:');
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
  console.log('🎉 بدء تشغيل نظام النشر التلقائي على فيسبوك v5.0');
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
