#!/usr/bin/env node

/**
 * نظام النشر التلقائي على فيسبوك v5.1
 * مطور بواسطة: Turki
 * تاريخ التحديث: 2025
 * الوصف: نظام متقدم للنشر التلقائي بجدولة دقيقة، تناوب حسابات ذكي، ومعالجة أخطاء متطورة.
 */

// =============================================================================
// 1. التحقق من البيئة والاعتماديات
// =============================================================================
console.log('🔍 [1/11] فحص النظام والاعتماديات...');

function validateEnvironmentVariables() {
  const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'ZAPIER_WEBHOOKS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`❌ متغيرات البيئة المفقودة: ${missing.join(', ')}`);
    process.exit(1);
  }
  try {
    const accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
    if (!Array.isArray(accounts) || accounts.length < 4) {
      throw new Error('ZAPIER_WEBHOOKS يجب أن يكون array يحتوي على 4 حسابات على الأقل لضمان عمل التناوب اليومي.');
    }
    accounts.forEach((account, index) => {
      if (!account.webhook || !account.name) throw new Error(`الحساب ${index + 1}: يجب أن يحتوي على webhook و name`);
    });
    console.log(`✅ تم التحقق من ${accounts.length} حساب Zapier`);
  } catch (error) {
    console.error('❌ خطأ في ZAPIER_WEBHOOKS:', error.message);
    process.exit(1);
  }
}

function checkDependencies() {
  const deps = ['firebase-admin', 'axios', 'date-fns'];
  for (const dep of deps) {
    try {
      require(dep);
    } catch (e) {
      console.error(`❌ ${dep} - غير مثبت. يرجى تشغيل 'npm install'`);
      process.exit(1);
    }
  }
  console.log('✅ جميع الاعتماديات متوفرة');
}

validateEnvironmentVariables();
checkDependencies();

// =============================================================================
// 2. تحميل المكتبات المطلوبة
// =============================================================================
const admin = require('firebase-admin');
const axios = require('axios');
const { format, subDays } = require('date-fns');

// =============================================================================
// 3. الإعدادات العامة
// =============================================================================
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 2500, // ms
  REQUEST_TIMEOUT: 45000, // ms
  REPOST_COOLDOWN_DAYS: 15,
  MAX_POSTS_PER_CATEGORY: 1
};

// =============================================================================
// 4. تهيئة Firebase
// =============================================================================
console.log('🔥 [2/11] تهيئة Firebase...');
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL
      })
    });
  }
  console.log('✅ Firebase مهيأ بنجاح');
} catch (error) {
  console.error('❌ فشل تهيئة Firebase:', error.message);
  process.exit(1);
}
const db = admin.firestore();

// =============================================================================
// 5. نظام إدارة حسابات Zapier الذكي
// =============================================================================
class ZapierAccountManager {
  constructor() {
    this.dailyAssignment = null;
  }

  async initialize() {
    console.log('🔄 [3/11] تهيئة نظام إدارة حسابات Zapier...');
    const today = new Date().toISOString().split('T')[0];
    const assignmentRef = db.collection('system_settings').doc(`zapier_assignment_${today}`);
    try {
      const doc = await assignmentRef.get();
      if (!doc.exists) {
        throw new Error(`لم يتم العثور على جدول تناوب الحسابات لليوم (${today}). تأكد من تشغيل مهمة 'setup_daily_rotation' بنجاح.`);
      }
      this.dailyAssignment = doc.data();
      console.log(`✅ تم تحميل جدول تناوب الحسابات لليوم: ${today}`);
    } catch (error) {
      console.error('❌ خطأ في تحميل جدول التناوب اليومي:', error.message);
      throw error;
    }
  }

  getAccountForPeriod(period) {
    if (!this.dailyAssignment || !this.dailyAssignment.assignments[period]) {
      throw new Error(`لا يوجد حساب مخصص للفترة '${period}' في جدول التناوب المحمل.`);
    }
    const account = this.dailyAssignment.assignments[period];
    console.log(`💼 الحساب المستخدم لهذه الفترة (${period}): ${account.name}`);
    return account;
  }
}

// =============================================================================
// 6. نظام الإشعارات
// =============================================================================
class TelegramNotifier {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.enabled = !!(this.token && this.chatId);
        if (!this.enabled) console.log('⚠️ إعدادات Telegram غير موجودة - الإشعارات معطلة');
    }

    async send(message, options = {}) {
        if (!this.enabled) return false;
        try {
            await axios.post(
                `https://api.telegram.org/bot${this.token}/sendMessage`, {
                    chat_id: this.chatId,
                    text: message,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true,
                    ...options
                }, { timeout: 10000 }
            );
            console.log('📨 تم إرسال الإشعار إلى Telegram بنجاح');
            return true;
        } catch (error) {
            console.error('❌ فشل إرسال إشعار Telegram:', error.response ? error.response.data : error.message);
            return false;
        }
    }
}
const telegramNotifier = new TelegramNotifier();

// =============================================================================
// 7. جدولة المحتوى الدقيقة
// =============================================================================
const POSTING_SCHEDULE = {
  // الأحد: 0, الإثنين: 1, ...
  1: { // الإثنين
    '09:30': 'مسلسل', '10:00': 'فيلم', '10:45': 'مباراة',
    '13:30': 'فيلم', '14:00': 'مسلسل', '14:45': 'مباراة',
    '18:30': 'مباراة', '19:00': 'فيلم', '19:45': 'وصفة',
    '22:30': 'وصفة', '23:00': 'مسلسل', '23:45': 'فيلم'
  },
  2: { // الثلاثاء
    '09:30': 'وصفة', '10:00': 'لعبة', '10:45': 'تطبيق',
    '13:30': 'لعبة', '14:00': 'وصفة', '14:45': 'قناة',
    '18:30': 'تطبيق', '19:00': 'قناة', '19:45': 'وصفة',
    '22:30': 'قناة', '23:00': 'لعبة', '23:45': 'تطبيق'
  },
  3: { // الأربعاء
    '09:30': 'قناة', '10:00': 'تطبيق', '10:45': 'لعبة',
    '13:30': 'ريلز', '14:00': 'وصفة', '14:45': 'فيلم',
    '17:15': 'مسلسل', '19:00': 'مباراة', '19:45': 'قناة',
    '22:30': 'فيلم', '23:00': 'ريلز', '23:45': 'مسلسل'
  },
  4: { // الخميس
    '09:30': 'فيلم', '10:00': 'مسلسل', '10:45': 'ريلز',
    '13:30': 'مباراة', '14:00': 'لعبة', '14:45': 'تطبيق',
    '18:30': 'وصفة', '19:00': 'قناة', '19:45': 'فيلم',
    '22:30': 'لعبة', '23:00': 'وصفة', '23:45': 'مباراة'
  },
  5: { // الجمعة
    '09:30': 'لعبة', '10:00': 'تطبيق', '10:45': 'قناة',
    '13:30': 'تطبيق', '14:00': 'لعبة', '14:45': 'ريلز',
    '18:30': 'قناة', '19:00': 'فيلم', '19:45': 'مسلسل',
    '22:30': 'ريلز', '23:00': 'وصفة', '23:45': 'مباراة'
  },
  6: { // السبت
    '09:30': 'ريلز', '10:00': 'لعبة', '10:45': 'تطبيق',
    '13:30': 'مسلسل', '14:00': 'فيلم', '14:45': 'وصفة',
    '18:30': 'فيلم', '19:00': 'مسلسل', '19:45': 'مباراة',
    '22:30': 'مباراة', '23:00': 'ريلز', '23:45': 'لعبة'
  },
  0: { // الأحد
    '09:30': 'مباراة', '10:00': 'فيلم', '10:45': 'مسلسل',
    '13:30': 'وصفة', '14:00': 'ريلز', '14:45': 'قناة',
    '18:30': 'لعبة', '19:00': 'تطبيق', '19:45': 'مباراة',
    '22:30': 'تطبيق', '23:00': 'لعبة', '23:45': 'وصفة'
  }
};

// =============================================================================
// 8. نظام استخراج المحتوى المتطور
// =============================================================================
class ContentManager {
  constructor(firestore) {
    this.db = firestore;
  }

  async fetchNewContent(category) {
    // يتطلب هذا الاستعلام فهرسًا مركبًا في Firestore
    return this.db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', false)
      .where('importStatus', '==', 'ready')
      .orderBy('createdAt', 'desc')
      .limit(CONFIG.MAX_POSTS_PER_CATEGORY)
      .get();
  }

  async fetchRepostableContent(category) {
    const cutoffDate = subDays(new Date(), CONFIG.REPOST_COOLDOWN_DAYS);
    return this.db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', true)
      .where('lastPosted', '<', admin.firestore.Timestamp.fromDate(cutoffDate))
      .orderBy('lastPosted', 'asc')
      .limit(CONFIG.MAX_POSTS_PER_CATEGORY)
      .get();
  }
  
  async getContentForCategory(category) {
    console.log(`🔍 [6/11] البحث عن محتوى جديد لنوع: ${category}`);
    try {
      let query = await this.fetchNewContent(category);
      if (!query.empty) {
        console.log(`✅ وجد ${query.size} عنصر جديد.`);
        return query.docs[0];
      }

      console.log(`♻️ لم يوجد محتوى جديد، البحث عن محتوى قابل لإعادة النشر لنوع: ${category}`);
      query = await this.fetchRepostableContent(category);
      if (!query.empty) {
        console.log(`✅ وجد ${query.size} عنصر قابل لإعادة النشر.`);
        return query.docs[0];
      }

      console.log(`❌ لم يوجد أي محتوى متاح وجاهز للنشر لنوع: ${category}`);
      return null;

    } catch (error) {
      if (error.code === 5) { // FAILED_PRECONDITION for missing index
        console.error(`❌❌❌ خطأ فادح: الفهرس المطلوب غير موجود في Firestore!`);
        console.error(`الفئة: ${category}. الرسالة: ${error.message}`);
        await telegramNotifier.send(
            `🚨 *خطأ في فهرس Firestore* 🚨\n\n` +
            `النظام فشل في جلب المحتوى للفئة *'${category}'* بسبب عدم وجود فهرس مركب.\n\n` +
            `*الرسالة:*\n`+
            `\`${error.message}\`\n\n`+
            `*الحل:*\n`+
            `1. اذهب إلى قسم Indexes في Firestore.\n`+
            `2. قم بإنشاء فهرس جديد للمجموعة 'links' بالحقول التالية:\n`+
            `   - linkType (Ascending)\n`+
            `   - isPosted (Ascending)\n`+
            `   - importStatus (Ascending)\n`+
            `   - createdAt (Descending)\n\n` +
            `سيحاول النظام المتابعة باستخدام استعلام أبسط ولكن قد يؤدي إلى نشر محتوى مكرر.`
        );
        // Fallback to a simpler query that doesn't need a composite index
        console.log(`⚠️ محاولة استخدام استعلام احتياطي بدون فهرس...`);
        const fallbackQuery = await this.db.collection('links').where('linkType', '==', category).where('isPosted', '==', false).limit(1).get();
        if (!fallbackQuery.empty) return fallbackQuery.docs[0];
      }
      // Re-throw other errors to be caught by the main handler
      throw new Error(`فشل استخراج المحتوى للفئة ${category}: ${error.message}`);
    }
  }

  async updateContentStatus(contentDoc, accountName) {
    console.log(`🔄 [9/11] تحديث حالة المحتوى في Firestore...`);
    const updates = {
      isPosted: true,
      lastPosted: admin.firestore.FieldValue.serverTimestamp(),
      postCount: admin.firestore.FieldValue.increment(1),
      lastAccount: accountName,
      importStatus: "published",
      publishedAt: new Date().toISOString()
    };
    await contentDoc.ref.update(updates);
    console.log(`✅ تم تحديث حالة المحتوى: ${contentDoc.data().socialTitle || 'بدون عنوان'}`);
  }
}

// =============================================================================
// 9. نظام النشر على Zapier
// =============================================================================
class ZapierPublisher {
  constructor(account) {
    this.account = account;
  }

  async publishContent(contentData) {
    console.log(`📤 [8/11] بدء نشر المحتوى عبر: ${this.account.name}`);
    const payload = {
      socialTitle: contentData.socialTitle || 'محتوى بدون عنوان',
      socialDescription: contentData.socialDescription || 'وصف غير متوفر',
      shortUrl: contentData.shortUrl || '',
      socialImage: contentData.socialImage || '',
      linkType: contentData.linkType || 'عام',
      publishTime: new Date().toISOString(),
      accountUsed: this.account.name,
      systemVersion: '5.1'
    };

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        console.log(`🔄 المحاولة ${attempt}/${CONFIG.MAX_RETRIES}...`);
        const response = await axios.post(this.account.webhook, payload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: CONFIG.REQUEST_TIMEOUT,
          validateStatus: (status) => status >= 200 && status < 300,
        });
        console.log(`✅ نجح النشر! الحالة: ${response.status}`);
        return { success: true };
      } catch (error) {
        const errorMessage = error.response ? `فشل بالخادم (حالة ${error.response.status})` : `مشكلة بالشبكة أو انتهاء مهلة الطلب (${error.message})`;
        console.log(`❌ المحاولة ${attempt} فشلت: ${errorMessage}`);
        if (attempt < CONFIG.MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
        } else {
          return { success: false, error: `فشل نهائي: ${errorMessage}` };
        }
      }
    }
    return { success: false, error: 'حدث خطأ غير متوقع في حلقة المحاولات' };
  }
}

// =============================================================================
// 10. النظام الرئيسي للنشر
// =============================================================================
class AutoPosterSystem {
  constructor() {
    this.accountManager = new ZapierAccountManager();
    this.contentManager = new ContentManager(db);
  }

  async initialize() {
    console.log('🚀 [4/11] تهيئة نظام النشر التلقائي...');
    await this.accountManager.initialize();
  }

  getCurrentTarget() {
    const now = new Date();
    const day = now.getUTCDay(); // استخدام دالة JavaScript الأصلية
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const timeKey = `${hours}:${minutes}`;

    const category = POSTING_SCHEDULE[day]?.[timeKey];
    if (!category) {
        throw new Error(`لا يوجد فئة مجدولة لهذا الوقت بالتحديد: ${timeKey} UTC. يرجى التحقق من جدول cron.`);
    }

    let period;
    const hourNum = parseInt(hours, 10);
    if (hourNum >= 9 && hourNum < 13) period = 'morning';
    else if (hourNum >= 13 && hourNum < 18) period = 'afternoon';
    else if (hourNum >= 18 && hourNum < 22) period = 'evening';
    else period = 'night';
    
    console.log(`🎯 [5/11] الهدف الحالي: اليوم=${day}, الوقت=${timeKey} UTC, الفترة=${period}, الفئة=${category}`);
    return { category, period };
  }

  async run() {
    const { category, period } = this.getCurrentTarget();
    
    const contentDoc = await this.contentManager.getContentForCategory(category);
    if (!contentDoc) {
      throw new Error(`توقف النشر: لم يتم العثور على أي محتوى جاهز للنشر للفئة '${category}'. يرجى إضافة محتوى جديد.`);
    }

    const contentData = contentDoc.data();
    console.log(`📄 [7/11] تم اختيار المحتوى: "${contentData.socialTitle}"`);
    
    const zapierAccount = this.accountManager.getAccountForPeriod(period);
    const publisher = new ZapierPublisher(zapierAccount);
    const result = await publisher.publishContent(contentData);

    if (result.success) {
      await this.contentManager.updateContentStatus(contentDoc, zapierAccount.name);
      await this.sendSuccessReport(contentData, category, period, zapierAccount.name);
    } else {
      throw new Error(`فشل النشر النهائي للمحتوى "${contentData.socialTitle}" بعد ${CONFIG.MAX_RETRIES} محاولات. الخطأ الأخير: ${result.error}`);
    }
  }

  async sendSuccessReport(content, category, period, accountName) {
    console.log('📊 [10/11] إرسال تقرير النجاح...');
    const message = `✅ *تم النشر بنجاح*\n\n` +
                    `*الفئة:* ${category}\n` +
                    `*العنوان:* ${content.socialTitle}\n` +
                    `*الفترة:* ${period}\n` +
                    `*الحساب:* ${accountName}`;
    await telegramNotifier.send(message);
  }
}

// =============================================================================
// 11. التشغيل الرئيسي للنظام
// =============================================================================
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🎉 بدء تشغيل نظام النشر التلقائي v5.1');
  console.log('='.repeat(60) + '\n');

  try {
    const system = new AutoPosterSystem();
    await system.initialize();
    await system.run();
    console.log('\n' + '='.repeat(60));
    console.log('✅ [11/11] اكتمل التشغيل بنجاح!');
    console.log('='.repeat(60));
    process.exit(0);
  } catch (error) {
    console.error('💥 خطأ فادح في عملية التشغيل:', error.message);
    await telegramNotifier.send(`💥 *فشل تشغيل نظام النشر*\n\n*السبب:*\n\`${error.message}\``);
    process.exit(1);
  }
}

main();
