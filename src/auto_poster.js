#!/usr/bin/env node

/**
 * نظام النشر التلقائي على فيسبوك v5.0
 * مطور بواسطة: Turki (تم التحديث بواسطة Gemini)
 * التاريخ: 2025
 * الوصف: نظام متقدم للنشر المجدول مع تناوب ذكي للحسابات ومعالجة متطورة للأخطاء.
 */

// =============================================================================
// 1. تحميل المكتبات والتحقق من البيئة
// =============================================================================
console.log('🔍 [v5.0] فحص النظام والاعتماديات...');

const admin = require('firebase-admin');
const axios = require('axios');
const { subDays } = require('date-fns');

// التحقق من متغيرات البيئة الأساسية
const requiredEnv = ['FIREBASE_PROJECT_ID', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'ZAPIER_WEBHOOKS'];
if (requiredEnv.some(key => !process.env[key])) {
  console.error(`❌ متغيرات البيئة المفقودة: ${requiredEnv.filter(key => !process.env[key]).join(', ')}`);
  process.exit(1);
}
console.log('✅ متغيرات البيئة موجودة.');

// =============================================================================
// 2. الإعدادات العامة للنظام
// =============================================================================
const CONFIG = {
  MAX_RETRIES: 3, // محاولات النشر
  REQUEST_TIMEOUT: 45000, // مهلة طلب النشر
  REPOST_COOLDOWN_DAYS: 15, // فترة السماح قبل إعادة النشر
  TIMEZONE_OFFSET: 4, // توقيت الإمارات (UTC+4)
  POST_DELAYS: [
    30 * 60 * 1000, // 30 دقيقة بعد المنشور الأول
    45 * 60 * 1000, // 45 دقيقة بعد المنشور الثاني
  ],
};

// =============================================================================
// 3. جدول المحتوى اليومي (التحديث رقم 1)
// =============================================================================
const CONTENT_SCHEDULE = {
  1: { // الاثنين
    morning: ['مسلسل', 'فيلم', 'مباراة'],
    afternoon: ['فيلم', 'مسلسل', 'مباراة'],
    evening: ['مباراة', 'فيلم', 'وصفة'],
    night: ['وصفة', 'مسلسل', 'فيلم'],
  },
  2: { // الثلاثاء
    morning: ['وصفة', 'لعبة', 'تطبيق'],
    afternoon: ['لعبة', 'وصفة', 'قناة'],
    evening: ['تطبيق', 'قناة', 'وصفة'],
    night: ['قناة', 'وصفة', 'لعبة'],
  },
  3: { // الأربعاء
    morning: ['قناة', 'ريلز', 'مسلسل'], // تم إضافة فئات لتصبح 3
    afternoon: ['ريلز', 'فيلم', 'وصفة'],
    evening: ['مسلسل', 'لعبة', 'تطبيق'],
    night: ['فيلم', 'قناة', 'ريلز'],
  },
  4: { // الخميس
    morning: ['فيلم', 'مباراة', 'وصفة'],
    afternoon: ['مباراة', 'لعبة', 'فيلم'],
    evening: ['وصفة', 'تطبيق', 'مسلسل'],
    night: ['لعبة', 'ريلز', 'قناة'],
  },
  5: { // الجمعة
    morning: ['لعبة', 'تطبيق', 'قناة'],
    afternoon: ['تطبيق', 'ريلز', 'لعبة'],
    evening: ['قناة', 'مسلسل', 'فيلم'],
    night: ['ريلز', 'مباراة', 'وصفة'],
  },
  6: { // السبت
    morning: ['ريلز', 'مسلسل', 'فيلم'],
    afternoon: ['مسلسل', 'فيلم', 'مباراة'],
    evening: ['فيلم', 'مباراة', 'وصفة'],
    night: ['مباراة', 'لعبة', 'تطبيق'],
  },
  0: { // الأحد
    morning: ['مباراة', 'وصفة', 'لعبة'],
    afternoon: ['وصفة', 'تطبيق', 'ريلز'],
    evening: ['لعبة', 'قناة', 'مسلسل'],
    night: ['تطبيق', 'فيلم', 'مباراة'],
  }
};

// =============================================================================
// 4. تهيئة Firebase
// =============================================================================
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
  }
  console.log('🔥 Firebase مهيأ بنجاح.');
} catch (error) {
  console.error('❌ فشل تهيئة Firebase:', error.message);
  process.exit(1);
}
const db = admin.firestore();

// =============================================================================
// 5. نظام الإشعارات (Telegram)
// =============================================================================
class TelegramNotifier {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.token && this.chatId);
  }

  async send(message, isCritical = false) {
    if (!this.enabled) return;
    const prefix = isCritical ? '🚨 *تنبيه خطير* 🚨\n\n' : '';
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`, {
          chat_id: this.chatId,
          text: prefix + message,
          parse_mode: 'Markdown',
        }, { timeout: 10000 }
      );
    } catch (error) {
      console.error('❌ فشل إرسال إشعار Telegram:', error.message);
    }
  }
}
const telegramNotifier = new TelegramNotifier();

// =============================================================================
// 6. نظام إدارة حسابات Zapier (التحديث رقم 2)
// =============================================================================
class ZapierAccountManager {
  constructor() {
    try {
      this.accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
      if (!Array.isArray(this.accounts) || this.accounts.length < 4) {
        throw new Error('يجب توفير 4 حسابات Zapier على الأقل في ZAPIER_WEBHOOKS.');
      }
      console.log(`✅ تم تحميل ${this.accounts.length} حساب Zapier.`);
    } catch (error) {
      throw new Error(`خطأ في ZAPIER_WEBHOOKS: ${error.message}`);
    }
    this.dailyShuffledAccounts = this.getShuffledAccountsForDay();
  }

  // يقوم بخلط الحسابات بشكل عشوائي ولكن ثابت لنفس اليوم
  getShuffledAccountsForDay() {
    const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
    let shuffled = [...this.accounts];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(dayOfYear * (i + 1)) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    console.log('🔀 تم خلط الحسابات لهذا اليوم.');
    return shuffled;
  }

  getAccountForTimeSlot(timeSlot) {
    const slotMap = { morning: 0, afternoon: 1, evening: 2, night: 3 };
    const index = slotMap[timeSlot];
    // إذا كان هناك أكثر من 4 حسابات، يتم استخدام الباقي بشكل دوري
    return this.dailyShuffledAccounts[index % this.dailyShuffledAccounts.length];
  }
}

// =============================================================================
// 7. نظام استخراج المحتوى (معالجة الخطأ رقم 4)
// =============================================================================
class ContentManager {
  constructor() {
    this.db = db;
  }

  async #executeQuery(query, category) {
    try {
      return await query.get();
    } catch (error) {
      // معالجة خطأ الفهرس بشكل خاص
      if (error.code === 'FAILED_PRECONDITION') { [cite: 9]
        console.error(`❌❌❌ خطأ فادح: الفهرس المطلوب غير موجود! ❌❌❌`);
        console.error(`لحل المشكلة، يرجى إنشاء الفهرس المركب التالي في Firebase Firestore:`);
        console.error(`المجموعة (Collection): 'links'`);
        console.error(`الحقول (Fields):`);
        console.error(`  - linkType (ASC)`);
        console.error(`  - isPosted (ASC)`);
        console.error(`  - importStatus (ASC)`);
        console.error(`  - createdAt (DESC)`);
        console.error(`يمكنك إنشاء الفهرس غالبًا عبر الرابط الذي يظهر في سجل الخطأ الكامل.`);
        // إرسال تنبيه حاسم
        await telegramNotifier.send(
          `*خطأ في فهرس Firestore*\n\nالنظام لا يستطيع جلب المحتوى لنوع \`${category}\` بسبب عدم وجود فهرس. يرجى مراجعة سجلات التشغيل فورًا لإنشاء الفهرس المطلوب.`,
          true
        );
      }
      // رمي الخطأ مجددًا ليتم التقاطه في المستوى الأعلى
      throw error;
    }
  }

  async getContentForCategory(category) {
    console.log(`🔍 البحث عن محتوى لنوع: ${category}`);
    // 1. البحث عن محتوى جديد جاهز للنشر
    let query = this.db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', false)
      .where('importStatus', '==', 'ready')
      .orderBy('createdAt', 'desc')
      .limit(1);
    let snapshot = await this.#executeQuery(query, category);
    if (!snapshot.empty) {
      console.log(`✅ وجد محتوى جديد.`);
      return snapshot.docs[0];
    }

    // 2. البحث عن محتوى قديم يمكن إعادة نشره
    const cutoffDate = subDays(new Date(), CONFIG.REPOST_COOLDOWN_DAYS);
    query = this.db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', true)
      .where('lastPosted', '<', admin.firestore.Timestamp.fromDate(cutoffDate))
      .orderBy('lastPosted', 'asc')
      .limit(1);
    snapshot = await this.#executeQuery(query, category); // لا يتطلب فهرسًا معقدًا عادةً
    if (!snapshot.empty) {
      console.log(`♻️ وجد محتوى قابل لإعادة النشر.`);
      return snapshot.docs[0];
    }

    console.log(`⚠️ لم يتم العثور على محتوى جاهز أو قابل لإعادة النشر لنوع: ${category}`);
    return null;
  }

  async updateContentStatus(doc, accountName) {
    try {
      await doc.ref.update({
        isPosted: true,
        lastPosted: admin.firestore.FieldValue.serverTimestamp(),
        postCount: admin.firestore.FieldValue.increment(1),
        lastAccount: accountName,
        importStatus: "published",
        publishedAt: new Date().toISOString()
      });
      console.log(`🔄 تم تحديث حالة المحتوى: ${doc.id}`);
    } catch (error) {
      console.error(`❌ فشل تحديث حالة المحتوى ${doc.id}:`, error.message);
      // إرسال إشعار بعدم التمكن من تحديث الحالة
      await telegramNotifier.send(`*فشل تحديث Firestore*\n\nلم يتمكن النظام من تحديث حالة المنشور \`${doc.data().socialTitle}\` بعد نشره. قد يؤدي هذا إلى نشره مرة أخرى قريبًا.`, true);
    }
  }
}

// =============================================================================
// 8. نظام النشر على Zapier (التحديث رقم 3)
// =============================================================================
class ZapierPublisher {
  async publish(contentData, account) {
    const { webhook, name } = account;
    const payload = {
      socialTitle: contentData.socialTitle || 'محتوى بدون عنوان',
      socialDescription: contentData.socialDescription || 'وصف غير متوفر',
      shortUrl: contentData.shortUrl || '',
      socialImage: contentData.socialImage || '',
      linkType: contentData.linkType || 'عام',
      seriesName: contentData.seriesName || '',
      accountUsed: name
    };

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        console.log(`📤 المحاولة ${attempt}/${CONFIG.MAX_RETRIES} للنشر عبر حساب: ${name}`);
        const response = await axios.post(webhook, payload, { timeout: CONFIG.REQUEST_TIMEOUT });
        console.log(`✅ نجح النشر! الحالة: ${response.status}`);
        return { success: true };
      } catch (error) {
        console.warn(`⚠️ فشلت المحاولة ${attempt}:`, error.message);
        if (attempt < CONFIG.MAX_RETRIES) {
          // Exponential backoff with jitter
          const delay = (Math.pow(2, attempt) * 1000) + Math.random() * 1000;
          console.log(`⏳ الانتظار ${Math.round(delay / 1000)} ثانية قبل المحاولة التالية...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.error(`💥 فشل النشر نهائياً بعد ${CONFIG.MAX_RETRIES} محاولات.`);
          return { success: false, error: error.message };
        }
      }
    }
  }
}

// =============================================================================
// 9. النظام الرئيسي للنشر (التحديث رقم 1، 2، 3)
// =============================================================================
class AutoPosterSystem {
  constructor() {
    this.accountManager = new ZapierAccountManager();
    this.contentManager = new ContentManager();
    this.publisher = new ZapierPublisher();
    this.results = { success: 0, failed: 0, errors: [], posts: [] };
  }

  getCurrentTimeSlot() {
    const hour = new Date().getUTCHours() + CONFIG.TIMEZONE_OFFSET;
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  async run() {
    const timeSlot = this.getCurrentTimeSlot();
    const dayOfWeek = new Date().getUTCDay();
    const categoriesToPost = CONTENT_SCHEDULE[dayOfWeek]?.[timeSlot];

    const slotNames = { morning: '🌅 الصباح', afternoon: '☀️ الظهر', evening: '🌇 المساء', night: '🌙 الليل' };
    console.log(`\n🎯 بدء عملية النشر لفترة: ${slotNames[timeSlot]}`);

    if (!categoriesToPost || categoriesToPost.length === 0) {
      throw new Error(`لا توجد فئات محددة للنشر في فترة ${timeSlot} ليوم ${dayOfWeek}.`);
    }

    const zapierAccount = this.accountManager.getAccountForTimeSlot(timeSlot);
    console.log(`💼 استخدام حساب Zapier لهذه الفترة: ${zapierAccount.name}`);

    for (let i = 0; i < categoriesToPost.length; i++) {
      const category = categoriesToPost[i];
      console.log(`\n--- المنشور ${i + 1}/${categoriesToPost.length} | الفئة: ${category} ---`);

      const contentDoc = await this.contentManager.getContentForCategory(category);
      if (!contentDoc) {
        this.results.failed++;
        const errorMsg = `لم يتم العثور على محتوى للفئة: ${category}`;
        this.results.errors.push(errorMsg);
        console.warn(errorMsg);
        continue;
      }

      const contentData = contentDoc.data();
      const result = await this.publisher.publish(contentData, zapierAccount);

      if (result.success) {
        this.results.success++;
        this.results.posts.push(`- ${contentData.linkType}: ${contentData.socialTitle.substring(0, 50)}...`);
        await this.contentManager.updateContentStatus(contentDoc, zapierAccount.name);
      } else {
        this.results.failed++;
        this.results.errors.push(`- ${category}: ${result.error}`);
      }

      // تطبيق الفاصل الزمني قبل المنشور التالي
      if (i < CONFIG.POST_DELAYS.length) {
        const delayMinutes = CONFIG.POST_DELAYS[i] / (60 * 1000);
        console.log(`⏳ انتظار ${delayMinutes} دقيقة قبل المنشور التالي...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.POST_DELAYS[i]));
      }
    }

    await this.sendFinalReport(timeSlot, zapierAccount.name);
  }

  async sendFinalReport(timeSlot, accountName) {
    const slotNames = { morning: '🌅 الصباح', afternoon: '☀️ الظهر', evening: '🌇 المساء', night: '🌙 الليل' };
    let report = `📊 *تقرير النشر للفترة: ${slotNames[timeSlot]}*\n\n`;
    report += `💼 الحساب المستخدم: *${accountName}*\n`;
    report += `✅ نجح: ${this.results.success}\n`;
    report += `❌ فشل: ${this.results.failed}\n\n`;

    if (this.results.posts.length > 0) {
      report += "*المنشورات الناجحة:*\n" + this.results.posts.join('\n') + "\n\n";
    }
    if (this.results.errors.length > 0) {
      report += "*الأخطاء المسجلة:*\n" + this.results.errors.join('\n');
    }

    console.log('\n' + report);
    await telegramNotifier.send(report);
  }
}

// =============================================================================
// 10. التشغيل الرئيسي للنظام
// =============================================================================
async function main() {
  console.log('='.repeat(60));
  console.log('🚀 بدء تشغيل نظام النشر التلقائي المحدث v5.0');
  console.log('='.repeat(60) + '\n');
  const system = new AutoPosterSystem();
  try {
    await system.run();
    console.log('\n' + '='.repeat(60));
    console.log('✅ اكتملت دورة النشر بنجاح!');
    console.log('='.repeat(60));
    process.exit(0);
  } catch (error) {
    console.error('\n💥 خطأ فادح أوقف تشغيل النظام:', error.message);
    await telegramNotifier.send(`النظام توقف عن العمل بسبب خطأ فادح:\n\n*${error.message}*\n\nيرجى مراجعة السجلات فوراً.`, true);
    process.exit(1);
  }
}

main();
