#!/usr/bin/env node
/**
 * نظام النشر التلقائي على فيسبوك v4.3
 */

'use strict';

// =============================================================================
// 0. معالجات أخطاء عامة
// =============================================================================
process.on('unhandledRejection', async (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  // هنا يمكن إرسال تقرير عبر Telegram
  process.exit(1);
});
process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// =============================================================================
// 1. التحقق من البيئة والاعتماديات
// =============================================================================
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
    if (!Array.isArray(accounts) || accounts.length < 4) {
      throw new Error('ZAPIER_WEBHOOKS يجب أن يحتوي على 4 حسابات على الأقل');
    }
  } catch (err) {
    console.error('❌ خطأ في ZAPIER_WEBHOOKS:', err.message);
    process.exit(1);
  }
}

function checkDependencies() {
  ['firebase-admin', 'axios', 'date-fns'].forEach(dep => {
    try {
      require(dep);
    } catch {
      console.error(`❌ الحزمة ${dep} غير مثبتة`);
      process.exit(1);
    }
  });
}

validateEnvironmentVariables();
checkDependencies();

// =============================================================================
// 2. تحميل المكتبات
// =============================================================================
const admin = require('firebase-admin');
const axios = require('axios');
const { format, isAfter } = require('date-fns');

// =============================================================================
// 3. ضبط الإعدادات
// =============================================================================
const CONFIG = {
  REQUEST_TIMEOUT: 45000,
  MAX_RETRIES: 3,
  UAE_OFFSET: 4,        // للتوافق مع المنصة (UTC+4)
};

// =============================================================================
// 4. تهيئة Firebase
// =============================================================================
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL
};
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// =============================================================================
// 5. تخصيص حساب Zapier لكل فترة (عشوائي يومياً)
// =============================================================================
class ZapierAccountManager {
  constructor() {
    this.accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
    this.periodMapping = null;
  }

  async initialize() {
    const ref = db.collection('system_settings').doc('period_mapping');
    const today = new Date().toISOString().split('T')[0];
    const doc = await ref.get();
    if (doc.exists && doc.data().date === today) {
      this.periodMapping = doc.data().mapping;
    } else {
      // راندوم ذكي بين الحسابات الأربع
      const indices = this.accounts.map((_, i) => i);
      // خلط المصفوفة
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      this.periodMapping = {
        morning:   indices[0],
        afternoon: indices[1],
        evening:   indices[2],
        night:     indices[3]
      };
      await ref.set({ date: today, mapping: this.periodMapping });
    }
  }

  getAccountForPeriod(slot) {
    const idx = this.periodMapping[slot];
    return this.accounts[idx];
  }
}

// =============================================================================
// 6. جدولة المحتوى وتعريف الفترات بيوم الأسبوع
// =============================================================================
const CONTENT_SCHEDULE = {
  1: { morning: ['مسلسل','فيلم','مباراة','وصفة'], afternoon: ['فيلم','مسلسل','مباراة','وصفة'], evening: ['مباراة','فيلم','وصفة','مسلسل'], night: ['وصفة','مسلسل','مباراة','فيلم'] },
  2: { morning: ['وصفة','لعبة','تطبيق','قناة'],     afternoon: ['لعبة','وصفة','قناة','تطبيق'], evening: ['تطبيق','قناة','وصفة','لعبة'],     night: ['قناة','وصفة','لعبة','تطبيق'] },
  3: { morning: ['قناة'],                           afternoon: ['ريلز'],                     evening: ['مسلسل'],                         night: ['فيلم'] },
  4: { morning: ['فيلم'],                           afternoon: ['مباراة'],                   evening: ['وصفة'],                           night: ['لعبة'] },
  5: { morning: ['لعبة'],                           afternoon: ['تطبيق'],                   evening: ['قناة'],                           night: ['ريلز'] },
  6: { morning: ['ريلز'],                           afternoon: ['مسلسل'],                   evening: ['فيلم'],                           night: ['مباراة'] },
  0: { morning: ['مباراة'],                         afternoon: ['وصفة'],                     evening: ['لعبة'],                           night: ['تطبيق'] }
};

// =============================================================================
// 7. استخراج ونشر المحتوى
// =============================================================================
class ContentManager {
  async getOne(category) {
    try {
      // محاولة المحتوى الجديد أولاً
      const q = await db.collection('links')
        .where('linkType','==',category)
        .where('isPosted','==',false)
        .where('importStatus','==','ready')
        .orderBy('createdAt','desc')
        .limit(1)
        .get();
      if (!q.empty) return q.docs[0];
    } catch (err) {
      if (err.message.includes('requires an index')) {
        console.log('⚠️ خطأ الـ index اكتُشف، سيتم استخدام استعلام أبسط كحل مؤقت');
      } else {
        console.error('❌ fetchNewContent:', err.message);
      }
    }
    // تراكم أو أي محتوى متاح
    const fallback = await db.collection('links')
      .where('linkType','==',category)
      .limit(1)
      .get();
    return fallback.empty ? null : fallback.docs[0];
  }

  async markPosted(doc, accountName) {
    await doc.ref.update({
      isPosted: true,
      lastPosted: admin.firestore.FieldValue.serverTimestamp(),
      postCount: admin.firestore.FieldValue.increment(1),
      lastAccount: accountName,
      importStatus: 'published',
      publishedAt: new Date().toISOString()
    });
  }
}

class ZapierPublisher {
  constructor(account) {
    this.webhook = account.webhook;
    this.name    = account.name;
  }

  async publish(data) {
    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        await axios.post(this.webhook, data, {
          timeout: CONFIG.REQUEST_TIMEOUT,
          headers: { 'Content-Type': 'application/json' }
        });
        return true;
      } catch (err) {
        if (attempt === CONFIG.MAX_RETRIES) {
          console.error('💥 فشل نهائي للنشر عبر', this.name, err.message);
          return false;
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
}

// =============================================================================
// 8. النظام الرئيسي
// =============================================================================
(async () => {
  console.log('🚀 تشغيل Auto Poster v4.3');

  //تهيئة المديرين
  const accountMgr = new ZapierAccountManager();
  await accountMgr.initialize();
  const contentMgr = new ContentManager();

  // تحديد الفترة الحالية
  const now = new Date();
  const utcMin = now.getUTCMinutes();
  const utcHour = now.getUTCHours();
  let slot;
  if (utcHour === 5 && utcMin === 30 || utcHour === 6 && [0,45].includes(utcMin)) slot = 'morning';
  else if (utcHour === 9 && utcMin === 30 || utcHour === 10 && [0,45].includes(utcMin)) slot = 'afternoon';
  else if (utcHour === 13 && utcMin === 30 || utcHour === 14 && [0,45].includes(utcMin)) slot = 'evening';
  else if (utcHour === 17 && utcMin === 30 || utcHour === 18 && [0,45].includes(utcMin)) slot = 'night';
  else {
    console.log('🕒 ليس وقت نشر مضبوط، سيتم الإيقاف');
    process.exit(0);
  }

  // تحديد يوم الأسبوع
  const dow = now.getUTCDay();
  const categories = CONTENT_SCHEDULE[dow][slot];
  // ترتيب ثابت خلال اليوم: 1️⃣ أول مشاركة، 2️⃣ الثانية، 3️⃣ الثالثة
  let seq;
  if (utcHour % 6 === 5 && utcMin === 30) seq = 1;      // 5:30,9:30,13:30,17:30 UTC
  else if (utcMin === 0) seq = 2;
  else seq = 3;

  const category = categories[(seq - 1) % categories.length];
  console.log(`📅 يوم ${dow} | ⏰ ${slot} #${seq} | 🏷️ الفئة: ${category}`);

  const doc = await contentMgr.getOne(category);
  if (!doc) {
    console.warn('⚠️ لا يوجد محتوى لفئة', category);
    process.exit(0);
  }
  const data = doc.data();
  const payload = {
    socialTitle: data.socialTitle || '',
    socialDescription: data.socialDescription || '',
    shortUrl: data.shortUrl || '',
    socialImage: data.socialImage || '',
    linkType: data.linkType,
    publishTime: new Date().toISOString(),
    systemVersion: '4.3'
  };

  // اختيار الحساب المناسب
  const account = accountMgr.getAccountForPeriod(slot);
  const publisher = new ZapierPublisher(account);
  const ok = await publisher.publish(payload);

  if (ok) {
    console.log('✅ تم النشر عبر', account.name);
    await contentMgr.markPosted(doc, account.name);
  }

  console.log('🚀 انتهى التشغيل');
  process.exit(0);
})();
