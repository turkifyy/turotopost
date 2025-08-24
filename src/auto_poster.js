#!/usr/bin/env node

/**
 * نظام النشر التلقائي على فيسبوك v4.2
 * مطور بواسطة: Turki
 * التاريخ: 2025
 * الوصف: نظام متقدم للنشر التلقائي مع دعم الاستيراد الجماعي
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
const { format, addDays, isAfter, subDays } = require('date-fns');

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
  MAX_POSTS_PER_CATEGORY: 1
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
// 5. نظام إدارة حسابات Zapier المتقدم
// =============================================================================

class ZapierAccountManager {
  constructor() {
    this.accounts = [];
    this.currentAccountIndex = 0;
    this.rotationConfig = null;
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
    
    console.log(`✅ الحساب النشط: ${this.getCurrentAccount().name} (${this.currentAccountIndex + 1})`);
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
      totalCycles: rotationInfo?.totalCycles || 0
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
// 7. جدولة المحتوى المحسنة
// =============================================================================

const CONTENT_SCHEDULE = {
  1: {
    morning: 'مسلسل',
    afternoon: 'فيلم', 
    evening: 'مباراة',
    night: 'وصفة'
  },
  2: {
    morning: 'وصفة',
    afternoon: 'لعبة',
    evening: 'تطبيق', 
    night: 'قناة'
  },
  3: {
    morning: 'قناة',
    afternoon: 'ريلز',
    evening: 'مسلسل',
    night: 'فيلم'
  },
  4: {
    morning: 'فيلم',
    afternoon: 'مباراة',
    evening: 'وصفة',
    night: 'لعبة'
  },
  5: {
    morning: 'لعبة',
    afternoon: 'تطبيق',
    evening: 'قناة',
    night: 'ريلز'
  },
  6: {
    morning: 'ريلز',
    afternoon: 'مسلسل',
    evening: 'فيلم',
    night: 'مباراة'
  },
  0: {
    morning: 'مباراة',
    afternoon: 'وصفة', 
    evening: 'لعبة',
    night: 'تطبيق'
  }
};

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
      return [];
    }
  }

  async fetchNewContent(category, limit) {
    const query = await this.db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', false)
      .orderBy('importDate', 'asc') // ✅ الأولوية للاستيراد الأقدم أولاً
      .limit(limit)
      .get();

    return query.docs;
  }

  async fetchRepostableContent(category, limit) {
    const cutoffDate = subDays(new Date(), CONFIG.REPOST_COOLDOWN_DAYS);
    
    const query = await this.db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', true)
      .where('lastPosted', '<', admin.firestore.Timestamp.fromDate(cutoffDate))
      .orderBy('lastPosted', 'asc')
      .limit(limit)
      .get();

    return query.docs;
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

  async publishContent(contentData) {
    const account = this.accountManager.getCurrentAccount();
    
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
            'User-Agent': `Auto-Poster-Premium/4.2 (${account.name})`,
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
      systemVersion: '4.2'
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
    
    if (dayOfWeek === 5) {
      return uaeHours >= 14 && uaeHours <= 23;
    }
    
    return isPeakTime;
  }

  getCurrentTimeSlot() {
    const now = new Date();
    const uaeHours = now.getUTCHours() + CONFIG.UAE_TIMEZONE_OFFSET;
    
    if (uaeHours >= 5 && uaeHours < 12) return 'morning';
    if (uaeHours >= 12 && uaeHours < 17) return 'afternoon';
    if (uaeHours >= 17 && uaeHours < 21) return 'evening';
    return 'night';
  }

  async run() {
    console.log('\n🎯 بدء عملية النشر التلقائي...\n');
    
    try {
      const timeSlot = this.getCurrentTimeSlot();
      const dayOfWeek = new Date().getUTCDay();
      const category = CONTENT_SCHEDULE[dayOfWeek][timeSlot];
      
      console.log(`📅 اليوم: ${dayOfWeek} (${this.getDayName(dayOfWeek)})`);
      console.log(`⏰ الفترة: ${timeSlot}`);
      console.log(`🏷️ الفئة المستهدفة: ${category}\n`);

      const contentDocs = await this.contentManager.getContentForCategory(category);
      
      if (contentDocs.length === 0) {
        throw new Error(`لا يوجد محتوى متاح للفئة: ${category}`);
      }

      for (const contentDoc of contentDocs) {
        const contentData = contentDoc.data();
        const result = await this.publisher.publishContent(contentData);
        
        if (result.success) {
          this.results.success++;
          this.results.posts.push({
            title: contentData.socialTitle,
            category: contentData.linkType,
            url: contentData.shortUrl
          });
          
          await this.contentManager.updateContentStatus(
            contentDoc, 
            this.accountManager.getCurrentAccount().name
          );
          
          console.log(`✅ تم نشر المحتوى بنجاح: ${contentData.socialTitle}`);
          
          await this.delay(3000);
          
        } else {
          this.results.failed++;
          this.results.errors.push({
            content: contentData.socialTitle,
            error: result.error
          });
          
          console.log(`❌ فشل نشر المحتوى: ${contentData.socialTitle}`);
        }
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
  console.log('🎉 بدء تشغيل نظام النشر التلقائي على فيسبوك v4.2');
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
