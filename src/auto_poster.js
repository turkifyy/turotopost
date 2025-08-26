#!/usr/bin/env node
/**
 * نظام النشر التلقائي على فيسبوك v4.3
 * مطور بواسطة: Turki
 * التاريخ: 2025
 * الوصف: نظام متقدم للنشر التلقائي مع دعم الاستيراد الجماعي والجدولة المعقدة
 */
// =============================================================================
// 1. التحقق من البيئة والاعتماديات
// =============================================================================
console.log('🔍 فحص النظام والاعتماديات...');
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
    if (!Array.isArray(accounts) || accounts.length < 4) { // يجب أن يكون هناك 4 حسابات على الأقل
      throw new Error('ZAPIER_WEBHOOKS يجب أن يكون array يحتوي على 4 حسابات على الأقل');
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
const { format, addDays, isAfter, subDays, parseISO } = require('date-fns');
const { arSA } = require('date-fns/locale'); // استيراد اللغة العربية

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
  MAX_POSTS_PER_CATEGORY: 1, // سيتم تجاوزه داخلياً لكن نحتفظ به للتوافق
  DELAYS_BETWEEN_POSTS: [0, 30 * 60 * 1000, (30 + 45) * 60 * 1000] // 0ms, 30 دقيقة, 75 دقيقة
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
    this.timeSlot = 'morning'; // القيمة الافتراضية
  }
  async initialize(timeSlot = 'morning') {
    console.log('🔄 تهيئة نظام إدارة حسابات Zapier Premium...');
    try {
      this.accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
      console.log(`✅ تم تحميل ${this.accounts.length} حساب Zapier Premium`);
    } catch (error) {
      throw new Error(`فشل تحميل حسابات Zapier: ${error.message}`);
    }
    
    this.timeSlot = timeSlot;
    // تحديد الحساب بناءً على الفترة الزمنية
    const timeSlotIndexMap = {
      'morning': 0,
      'afternoon': 1,
      'evening': 2,
      'night': 3
    };
    this.currentAccountIndex = timeSlotIndexMap[timeSlot] !== undefined ? timeSlotIndexMap[timeSlot] : 0;
    
    await this.loadRotationConfig();
    console.log(`✅ الحساب النشط لفترة ${timeSlot}: ${this.getCurrentAccount().name} (${this.currentAccountIndex + 1})`);
  }
  async loadRotationConfig() {
    const rotationRef = db.collection('system_settings').doc('rotation');
    try {
      const doc = await rotationRef.get();
      if (doc.exists) {
        const data = doc.data();
        // تحديث بيانات التناوب لتضمين الفترة الزمنية
        this.rotationConfig = {
            ...data,
            timeSlot: this.timeSlot // إضافة الفترة الزمنية الحالية
        };
        // التحقق من الحاجة إلى تناوب يدوي (غير مطلوب حسب التحديث الجديد)
        // لكن نحتفظ بالمنطق القديم للتوافق
        const now = new Date();
        const nextRotationDate = data.nextRotationDate?.toDate();
        if (nextRotationDate && isAfter(now, nextRotationDate)) {
          // يمكن تفعيل التناوب التلقائي إذا لزم
          // await this.rotateAccount();
        }
      } else {
        await this.createInitialRotationConfig();
      }
    } catch (error) {
      console.error('⚠️ خطأ في تحميل إعدادات التناوب:', error.message);
      // لا نعيد تعيين الحساب إذا فشل التحميل
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
      accountsUsed: this.accounts.length,
      timeSlot: this.timeSlot // إضافة الفترة الزمنية
    };
    await db.collection('system_settings').doc('rotation').set(config);
    this.rotationConfig = config;
    console.log('✅ تم إنشاء إعدادات التناوب بنجاح');
  }
  async rotateAccount() {
    // هذا الدوران القديم لم يعد مطلوبًا حسب التحديث الجديد
    // لكن نحتفظ به للتوافق
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
      `🔄 *تم التبديل إلى حساب جديد!*
` +
      `🔹 من: ${this.accounts[previousIndex]?.name || 'غير معروف'}
` +
      `🔹 إلى: ${this.getCurrentAccount().name}
` +
      `📅 تاريخ التبديل القادم: ${format(nextRotationDate, 'yyyy-MM-dd')}
` +
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
      totalCycles: rotationInfo?.totalCycles || 0,
      timeSlot: this.timeSlot // إضافة الفترة الزمنية
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
    let message = `📊 *تقرير النشر التلقائي*
`;
    message += `📅 التاريخ: ${format(now, 'yyyy-MM-dd', { locale: arSA })}
`;
    message += `⏰ الوقت: ${format(now, 'HH:mm', { locale: arSA })} (UAE)
`;
    message += `🎯 الفترة: ${this.getTimeSlotName(timeSlot)}
`;
    message += `💼 *معلومات الحساب:*
`;
    message += `🏷️ الحساب: ${stats.currentAccount}
`;
    message += `📊 رقم الحساب: ${stats.accountIndex}/${stats.totalAccounts}
`;
    message += `📈 *إحصائيات النشر:*
`;
    message += `✅ نجح: ${results.success}
`;
    message += `❌ فشل: ${results.failed}
`;
    if (results.success + results.failed > 0) {
        message += `📊 المعدل: ${((results.success / (results.success + results.failed)) * 100).toFixed(1)}%
`;
    }
    if (results.posts.length > 0) {
      message += `🔗 *المنشورات المنشورة:*
`;
      results.posts.forEach(post => {
        message += `▫️ ${post.category}: ${post.title.substring(0, 40)}...
`;
      });
      message += `
`;
    }
    if (errors.length > 0) {
      message += `⚠️ *الأخطاء:*
`;
      errors.slice(0, 3).forEach(error => {
        message += `▫️ ${error}
`;
      });
      if (errors.length > 3) {
        message += `▫️ و ${errors.length - 3} أخطاء أخرى...
`;
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
// 7. جدولة المحتوى المحسنة (التحديث الجديد)
// =============================================================================
const CONTENT_SCHEDULE = {
  1: { // يوم الاثنين
    morning: ['مسلسل', 'فيلم', 'مباراة'],
    afternoon: ['فيلم', 'مسلسل', 'مباراة', 'وصفة'],
    evening: ['مباراة', 'فيلم', 'وصفة', 'مسلسل'],
    night: ['وصفة', 'مسلسل', 'مباراة', 'فيلم'],
  },
  2: { // يوم الثلاثاء
    morning: ['وصفة', 'لعبة', 'تطبيق', 'قناة'],
    afternoon: ['لعبة', 'وصفة', 'قناة', 'تطبيق'],
    evening: ['تطبيق', 'قناة', 'وصفة', 'لعبة'],
    night: ['قناة', 'وصفة', 'لعبة', 'تطبيق'],
  },
  3: { // يوم الأربعاء
    morning: ['قناة', 'ريلز', 'مسلسل', 'فيلم'], // تعديل لضمان 3 فئات
    afternoon: ['ريلز', 'مباراة', 'وصفة', 'لعبة'], // تعديل
    evening: ['مسلسل', 'فيلم', 'مباراة', 'وصفة'], // تعديل
    night: ['فيلم', 'مباراة', 'وصفة', 'لعبة'], // تعديل
  },
  4: { // يوم الخميس
    morning: ['فيلم', 'مباراة', 'وصفة', 'لعبة'], // تعديل
    afternoon: ['مباراة', 'وصفة', 'لعبة', 'تطبيق'], // تعديل
    evening: ['وصفة', 'لعبة', 'تطبيق', 'قناة'], // تعديل
    night: ['لعبة', 'تطبيق', 'قناة', 'ريلز'], // تعديل
  },
  5: { // يوم الجمعة
    morning: ['لعبة', 'تطبيق', 'قناة', 'ريلز'], // تعديل
    afternoon: ['تطبيق', 'قناة', 'ريلز', 'مسلسل'], // تعديل
    evening: ['قناة', 'ريلز', 'مسلسل', 'فيلم'], // تعديل
    night: ['ريلز', 'مسلسل', 'فيلم', 'مباراة'], // تعديل
  },
  6: { // يوم السبت
    morning: ['ريلز', 'مسلسل', 'فيلم', 'مباراة'], // تعديل
    afternoon: ['مسلسل', 'فيلم', 'مباراة', 'وصفة'], // تعديل
    evening: ['فيلم', 'مباراة', 'وصفة', 'لعبة'], // تعديل
    night: ['مباراة', 'وصفة', 'لعبة', 'تطبيق'], // تعديل
  },
  0: { // يوم الأحد
    morning: ['مباراة', 'وصفة', 'لعبة', 'تطبيق'], // تعديل
    afternoon: ['وصفة', 'لعبة', 'تطبيق', 'قناة'], // تعديل
    evening: ['لعبة', 'تطبيق', 'قناة', 'ريلز'], // تعديل
    night: ['تطبيق', 'قناة', 'ريلز', 'مسلسل'], // تعديل
  }
};
// =============================================================================
// 8. نظام استخراج المحتوى المتطور مع دعم الاستيراد الجماعي
// =============================================================================
class ContentManager {
  constructor(firestore) {
    this.db = firestore;
  }
  async getContentForCategory(category, limit = 1) { // القيمة الافتراضية 1
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
      console.log('🔍 البحث عن أي محتوى متاح كحل بديل...');
      // محاولة ثانية: البحث بدون شروط معقدة
      try {
        const fallbackQuery = await this.db.collection('links')
          .where('linkType', '==', category)
          .limit(limit)
          .get();
        if (!fallbackQuery.empty) {
          console.log(`⚠️ وجد ${fallbackQuery.size} رابط ولكن قد يكون منشوراً مسبقاً`);
          return fallbackQuery.docs;
        }
      } catch (fallbackError) {
        console.error(`❌ خطأ في البحث البديل لنوع ${category}:`, fallbackError.message);
      }
      return [];
    }
  }

  async fetchNewContent(category, limit) {
    // يتطلب composite index: linkType ASC, isPosted ASC, importStatus ASC, createdAt DESC
    try {
      const query = await this.db.collection('links')
        .where('linkType', '==', category)
        .where('isPosted', '==', false)
        .where('importStatus', '==', 'ready')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      return query.docs;
    } catch (error) {
      if (error.code === 'failed-precondition') {
        console.warn(`⚠️ الفهرس مفقود لـ fetchNewContent لنوع ${category}. استخدام استراتيجية بديلة.`);
        // استراتيجية بديلة: البحث بدون orderBy
        const fallbackQuery = await this.db.collection('links')
          .where('linkType', '==', category)
          .where('isPosted', '==', false)
          .where('importStatus', '==', 'ready')
          .limit(limit)
          .get();
        return fallbackQuery.docs;
      } else {
        throw error; // إعادة رمي الخطأ إذا لم يكن متعلقاً بالفهرس
      }
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
      if (error.code === 'failed-precondition') {
        console.warn(`⚠️ الفهرس مفقود لـ fetchRepostableContent لنوع ${category}. استخدام استراتيجية بديلة.`);
        // استراتيجية بديلة: البحث بدون orderBy
        const fallbackQuery = await this.db.collection('links')
          .where('linkType', '==', category)
          .where('isPosted', '==', true)
          .where('lastPosted', '<', admin.firestore.Timestamp.fromDate(cutoffDate))
          .limit(limit)
          .get();
        return fallbackQuery.docs;
      } else {
        throw error;
      }
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
      if (error.code === 'failed-precondition') {
        console.warn(`⚠️ الفهرس مفقود لـ fetchAnyContent لنوع ${category}. استخدام استراتيجية بديلة.`);
        // استراتيجية بديلة: البحث بدون orderBy
        const fallbackQuery = await this.db.collection('links')
          .where('linkType', '==', category)
          .limit(limit)
          .get();
        return fallbackQuery.docs;
      } else {
        throw error;
      }
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
        importStatus: "published", // ✅ تحديث حالة الاستيراد الجماعي
        publishedAt: new Date().toISOString() // ✅ وقت النشر
      };
      await contentDoc.ref.update(updates);
      console.log(`✅ تم تحديث حالة المحتوى: ${contentData.socialTitle || 'بدون عنوان'}`);
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
  }
  async initialize() {
    console.log('🚀 تهيئة نظام النشر التلقائي...');
    try {
      const timeSlot = this.getCurrentTimeSlot();
      await this.accountManager.initialize(timeSlot); // تمرير الفترة الزمنية
      if (!this.isValidUaeTime()) {
        console.log('⏰ الوقت الحالي غير مناسب للنشر (خارج أوقات الذروة)');
        await telegramNotifier.send(
          '⏰ *النظام متوقف مؤقتاً*
' +
          'الوقت الحالي غير مناسب للنشر حسب توقيت الإمارات
' +
          'سيتم التشغيل تلقائياً في الأوقات المثلى'
        );
        process.exit(0);
      }
      console.log('✅ تم تهيئة النظام بنجاح');
    } catch (error) {
      console.error('❌ فشل تهيئة النظام:', error.message);
      await telegramNotifier.send(
        '❌ *فشل تهيئة النظام*
' +
        `الخطأ: ${error.message}
` +
        'يجب التدخل الفوري لإصلاح المشكلة'
      );
      process.exit(1);
    }
  }
  isValidUaeTime() {
    const now = new Date();
    const uaeHours = now.getUTCHours() + CONFIG.UAE_TIMEZONE_OFFSET;
    const dayOfWeek = now.getUTCDay();
    const isPeakTime = uaeHours >= 5 && uaeHours <= 23;
    if (dayOfWeek === 5) { // الجمعة
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
    console.log('\n🎯 بدء عملية النشر التلقائي...');
    try {
      const timeSlot = this.getCurrentTimeSlot();
      const dayOfWeek = new Date().getUTCDay();
      const categories = CONTENT_SCHEDULE[dayOfWeek][timeSlot] || [];
      
      console.log(`📅 اليوم: ${dayOfWeek} (${this.getDayName(dayOfWeek)})`);
      console.log(`⏰ الفترة: ${timeSlot}`);
      console.log(`🏷️ الفئات المستهدفة: ${categories.join(', ')}\n`);

      if (categories.length === 0) {
        throw new Error(`لا توجد فئات محددة للفترة ${timeSlot} في اليوم ${dayOfWeek}`);
      }

      // نشر 3 منشورات (واحد لكل فئة من الفئات الثلاث الأولى)
      const categoriesToPost = categories.slice(0, 3); 

      for (let i = 0; i < categoriesToPost.length; i++) {
        const category = categoriesToPost[i];
        console.log(`\n🔄 معالجة الفئة ${i+1}/${categoriesToPost.length}: ${category}`);

        // تطبيق التأخير بين النشر حسب الجدول الزمني الجديد
        if (i > 0) {
            const delay = CONFIG.DELAYS_BETWEEN_POSTS[i] - CONFIG.DELAYS_BETWEEN_POSTS[i-1];
            if (delay > 0) {
                console.log(`⏳ انتظار ${delay / (60 * 1000)} دقيقة قبل النشر التالي...`);
                await this.delay(delay);
            }
        }

        const contentDocs = await this.contentManager.getContentForCategory(category, 1); // جلب منشور واحد فقط

        if (contentDocs.length === 0) {
          const errorMsg = `لا يوجد محتوى متاح للفئة: ${category}`;
          console.warn(`⚠️ ${errorMsg}`);
          this.results.errors.push(errorMsg);
          continue; // الانتقال إلى الفئة التالية
        }

        const contentDoc = contentDocs[0];
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
            this.accountManager.getCurrentAccount().name,
            this.accountManager.currentAccountIndex
          );
          console.log(`✅ تم نشر المحتوى بنجاح: ${contentData.socialTitle}`);
        } else {
          this.results.failed++;
          const errorMsg = `${contentData.socialTitle}: ${result.error}`;
          this.results.errors.push(errorMsg);
          console.log(`❌ فشل نشر المحتوى: ${contentData.socialTitle}`);
        }
      }

      await this.sendFinalReport(timeSlot);
    } catch (error) {
      console.error('💥 خطأ غير متوقع في التشغيل:', error.message);
      await telegramNotifier.send(
        '💥 *خطأ في التشغيل*
' +
        `الخطأ: ${error.message}
` +
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
      errors: this.results.errors // الآن يحتوي على سلاسل نصية مباشرة
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
