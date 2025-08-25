/**
 * نظام فحص وإدارة التناوب اليومي v4.3
 */
'use strict';

const admin = require('firebase-admin');
const { format, differenceInDays, addDays } = require('date-fns');
const axios = require('axios');

// تهيئة Firebase
if (!admin.apps.length) {
  const svc = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
  };
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}
const db = admin.firestore();

class RotationChecker {
  constructor() {
    this.accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS || '[]');
  }

  async run() {
    console.log('🔄 بدء فحص التناوب اليومي v4.3');

    // بيانات التناوب
    const ref = db.collection('system_settings').doc('period_mapping');
    const doc = await ref.get();
    if (!doc.exists) {
      console.warn('⚠️ لا توجد إعدادات period_mapping');
      return;
    }
    const { date, mapping } = doc.data();
    console.log(`📆 آخر تحديث: ${date}`);
    console.table(mapping.map(v => this.accounts[v].name), [''])
    
    // صحة Webhooks
    const health = await Promise.all(
      this.accounts.map(acc =>
        axios.post(acc.webhook, { test: true }).then(r => true).catch(() => false)
      )
    );
    health.forEach((ok, i) => {
      console.log(`حساب ${i+1} (${this.accounts[i].name}):`, ok ? '✅' : '❌');
    });

    // أيام متبقية (التحديث القادم في منتصف الليل)
    const tomorrow = new Date();
    tomorrow.setHours(24,0,0,0);
    const daysRem = differenceInDays(tomorrow, new Date());
    console.log(`⏳ الأيام المتبقية لتحديث period_mapping: ${daysRem > 0 ? daysRem : 0}`);
  }
}

if (require.main === module) {
  new RotationChecker().run().catch(err => {
    console.error('💥 خطأ في rotation_system:', err);
    process.exit(1);
  });
}

module.exports = RotationChecker;
