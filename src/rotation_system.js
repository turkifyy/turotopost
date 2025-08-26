// ============================================
// نظام فحص وإدارة التناوب v4.3
// ============================================
const admin = require('firebase-admin');
const { format, differenceInDays, addDays } = require('date-fns');
const { arSA } = require('date-fns/locale'); // استيراد اللغة العربية
const axios = require('axios');
class RotationChecker {
  constructor() {
    this.db = null;
    this.zapierAccounts = [];
  }
  async initialize() {
    console.log('╔════════════════════════════════════╗');
    console.log('║    🔄 نظام فحص التناوب v4.3      ║');
    console.log('╚════════════════════════════════════╝\n');
    // تهيئة Firebase
    if (!admin.apps.length) {
      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL
      };
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
      });
    }
    this.db = admin.firestore();
    // تحميل حسابات Zapier
    try {
      this.zapierAccounts = JSON.parse(process.env.ZAPIER_WEBHOOKS || '[]');
      console.log(`✅ تم تحميل ${this.zapierAccounts.length} حساب Zapier\n`);
    } catch (error) {
      console.error('❌ فشل تحميل حسابات Zapier');
      throw error;
    }
  }
  async checkRotationStatus() {
    console.log('📊 فحص حالة التناوب الحالية...\n');
    const rotationRef = this.db.collection('system_settings').doc('rotation');
    const doc = await rotationRef.get();
    if (!doc.exists) {
      console.log('⚠️ لا توجد بيانات تناوب سابقة');
      return null;
    }
    const data = doc.data();
    const now = new Date();
    const nextRotation = data.nextRotationDate?.toDate();
    const startDate = data.startDate?.toDate();
    const status = {
      currentAccount: data.currentAccountIndex + 1,
      totalAccounts: this.zapierAccounts.length,
      startDate: startDate ? format(startDate, 'yyyy-MM-dd HH:mm', { locale: arSA }) : 'غير محدد',
      nextRotation: nextRotation ? format(nextRotation, 'yyyy-MM-dd HH:mm', { locale: arSA }) : 'غير محدد',
      daysRemaining: nextRotation ? differenceInDays(nextRotation, now) : 0,
      totalCycles: data.totalCycles || 0,
      needsRotation: nextRotation ? now > nextRotation : false,
      timeSlot: data.timeSlot || 'غير محدد' // إضافة الفترة الزمنية
    };
    // عرض المعلومات
    console.log('┌─────────────────────────────────────┐');
    console.log('│         معلومات التناوب الحالية      │');
    console.log('├─────────────────────────────────────┤');
    console.log(`│ 💼 الحساب الحالي: ${status.currentAccount}/${status.totalAccounts}`);
    console.log(`│ 📅 بداية الدورة: ${status.startDate}`);
    console.log(`│ 🔄 التناوب القادم: ${status.nextRotation}`);
    console.log(`│ ⏳ الأيام المتبقية: ${status.daysRemaining} يوم`);
    console.log(`│ 📈 إجمالي الدورات: ${status.totalCycles}`);
    console.log(`│ 🎯 الفترة الزمنية: ${status.timeSlot}`); // عرض الفترة الزمنية
    console.log(`│ 🚦 يحتاج تناوب: ${status.needsRotation ? 'نعم ⚠️' : 'لا ✅'}`);
    console.log('└─────────────────────────────────────┘\n');
    return status;
  }
  async getAccountsUsageStats() {
    console.log('📈 إحصائيات استخدام الحسابات...\n');
    const stats = [];
    for (let i = 0; i < this.zapierAccounts.length; i++) {
      const account = this.zapierAccounts[i];
      // جلب إحصائيات من Firebase
      const query = await this.db.collection('links')
        .where('lastAccountIndex', '==', i) // استخدام lastAccountIndex
        .get();
      const accountStats = {
        accountNumber: i + 1,
        totalPosts: query.size,
        webhookUrl: account.webhook ? '✅ موجود' : '❌ مفقود',
        accountName: account.name || `حساب ${i + 1}`
      };
      stats.push(accountStats);
    }
    // عرض الإحصائيات
    console.log('┌─────────────────────────────────────┐');
    console.log('│      إحصائيات الحسابات              │');
    console.log('├─────────────────────────────────────┤');
    stats.forEach(stat => {
      console.log(`│ حساب ${stat.accountNumber}: ${stat.totalPosts} منشور - ${stat.webhookUrl}`);
    });
    console.log('└─────────────────────────────────────┘\n');
    return stats;
  }
  async checkWebhooksHealth() {
    console.log('🏥 فحص صحة Webhooks...\n');
    const results = [];
    for (let i = 0; i < this.zapierAccounts.length; i++) {
      const account = this.zapierAccounts[i];
      if (!account.webhook) {
        results.push({
          account: i + 1,
          status: '❌ Webhook مفقود',
          healthy: false
        });
        continue;
      }
      try {
        // إرسال طلب تجريبي
        const response = await axios.post(
          account.webhook,
          { test: true, timestamp: new Date().toISOString() },
          { 
            timeout: 10000,
            validateStatus: (status) => status < 500
          }
        );
        results.push({
          account: i + 1,
          status: response.status === 200 ? '✅ يعمل بشكل طبيعي' : `⚠️ رمز الحالة: ${response.status}`,
          healthy: response.status === 200
        });
      } catch (error) {
        results.push({
          account: i + 1,
          status: `❌ خطأ: ${error.message}`,
          healthy: false
        });
      }
    }
    // عرض النتائج
    console.log('┌─────────────────────────────────────┐');
    console.log('│         صحة Webhooks                │');
    console.log('├─────────────────────────────────────┤');
    results.forEach(result => {
      console.log(`│ حساب ${result.account}: ${result.status}`);
    });
    const healthyCount = results.filter(r => r.healthy).length;
    console.log('├─────────────────────────────────────┤');
    console.log(`│ الإجمالي: ${healthyCount}/${results.length} يعمل بشكل صحيح`);
    console.log('└─────────────────────────────────────┘\n');
    return results;
  }
  async forceRotation() {
    console.log('🔄 تنفيذ تناوب يدوي...\n');
    const rotationRef = this.db.collection('system_settings').doc('rotation');
    const doc = await rotationRef.get();
    if (!doc.exists) {
      console.log('❌ لا توجد بيانات تناوب');
      return false;
    }
    const data = doc.data();
    const newIndex = (data.currentAccountIndex + 1) % this.zapierAccounts.length;
    const now = new Date();
    const nextRotation = addDays(now, 13);
    await rotationRef.update({
      currentAccountIndex: newIndex,
      startDate: admin.firestore.Timestamp.now(),
      nextRotationDate: admin.firestore.Timestamp.fromDate(nextRotation),
      lastRotation: admin.firestore.Timestamp.now(),
      totalCycles: admin.firestore.FieldValue.increment(1),
      manualRotation: true,
      manualRotationDate: admin.firestore.Timestamp.now()
    });
    console.log(`✅ تم التناوب بنجاح إلى الحساب ${newIndex + 1}`);
    console.log(`📅 التناوب القادم: ${format(nextRotation, 'yyyy-MM-dd', { locale: arSA })}\n`);
    // إرسال إشعار
    await this.sendNotification(
      `🔄 تناوب يدوي!
` +
      `تم التبديل إلى الحساب ${newIndex + 1}
` +
      `التناوب القادم: ${format(nextRotation, 'yyyy-MM-dd', { locale: arSA })}`
    );
    return true;
  }
  async generateReport() {
    console.log('📄 توليد تقرير شامل...\n');
    const status = await this.checkRotationStatus();
    const usage = await this.getAccountsUsageStats();
    const health = await this.checkWebhooksHealth();
    const report = {
      timestamp: new Date().toISOString(),
      rotation: status,
      usage: usage,
      health: health,
      summary: {
        totalAccounts: this.zapierAccounts.length,
        healthyAccounts: health.filter(h => h.healthy).length,
        totalPosts: usage.reduce((sum, u) => sum + u.totalPosts, 0),
        averagePostsPerAccount: Math.round(
          usage.reduce((sum, u) => sum + u.totalPosts, 0) / usage.length
        )
      }
    };
    // حفظ التقرير في Firebase
    await this.db.collection('system_reports').add({
      ...report,
      createdAt: admin.firestore.Timestamp.now()
    });
    console.log('✅ تم حفظ التقرير في قاعدة البيانات\n');
    // إرسال ملخص إلى Telegram
    const summary = `
📊 *تقرير النظام الشامل*
━━━━━━━━━━━━━━━━
🕐 ${format(new Date(), 'yyyy-MM-dd HH:mm', { locale: arSA })}
*حالة التناوب:*
• الحساب الحالي: ${status?.currentAccount || 'غير محدد'}/${this.zapierAccounts.length}
• الأيام المتبقية: ${status?.daysRemaining || 0} يوم
*الإحصائيات:*
• إجمالي المنشورات: ${report.summary.totalPosts}
• متوسط لكل حساب: ${report.summary.averagePostsPerAccount}
• الحسابات الصحية: ${report.summary.healthyAccounts}/${report.summary.totalAccounts}
${status?.needsRotation ? '⚠️ *تنبيه: يحتاج النظام إلى تناوب!*' : '✅ النظام يعمل بشكل طبيعي'}
    `.trim();
    await this.sendNotification(summary);
    return report;
  }
  async sendNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.log('📵 Telegram غير مفعل');
      return;
    }
    try {
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        }
      );
      console.log('📨 تم إرسال الإشعار\n');
    } catch (error) {
      console.error('❌ فشل إرسال الإشعار:', error.message);
    }
  }
  async run() {
    try {
      await this.initialize();
      // تنفيذ جميع الفحوصات
      await this.checkRotationStatus();
      await this.getAccountsUsageStats();
      await this.checkWebhooksHealth();
      // توليد التقرير الشامل
      await this.generateReport();
      console.log('╔════════════════════════════════════╗');
      console.log('║     ✅ اكتمل فحص النظام بنجاح      ║');
      console.log('╚════════════════════════════════════╝');
    } catch (error) {
      console.error('💥 خطأ في فحص النظام:', error);
      process.exit(1);
    }
  }
}
// تشغيل الفحص
if (require.main === module) {
  const checker = new RotationChecker();
  checker.run();
}
module.exports = RotationChecker;                              
