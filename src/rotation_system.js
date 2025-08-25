// =================================================================
// || نظام فحص وإدارة التناوب v4.2 ||
// =================================================================
// ملاحظة: هذا الملف يعمل الآن كنظام مراقبة وصحة للحسابات.
// منطق التناوب الفعلي لعمليات النشر اليومية تم نقله إلى
// `auto_poster.js` ليكون أكثر ديناميكية.
// =================================================================

const admin = require('firebase-admin');
const { format, differenceInDays, addDays } = require('date-fns');
const axios = require('axios');

class RotationChecker {
  constructor() {
    this.db = null;
    this.zapierAccounts = [];
  }
  
  async initialize() {
    console.log('╔════════════════════════════════════╗');
    console.log('║    🔄 نظام فحص صحة الحسابات v4.2   ║');
    console.log('╚════════════════════════════════════╝\n');
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL
        }),
      });
    }
    
    this.db = admin.firestore();
    try {
      this.zapierAccounts = JSON.parse(process.env.ZAPIER_WEBHOOKS || '[]');
      console.log(`✅ تم تحميل ${this.zapierAccounts.length} حساب Zapier\n`);
    } catch (error) {
      console.error('❌ فشل تحميل حسابات Zapier');
      throw error;
    }
  }
  
  // ... باقي محتوى الملف يبقى كما هو بدون تغيير ...
  // The rest of the file content remains unchanged as its health check
  // and reporting functionalities are still valuable.
  
  async checkRotationStatus() {
    console.log('📊 فحص حالة التناوب المسجلة في Firestore...\n');
    const rotationRef = this.db.collection('system_settings').doc('rotation');
    const doc = await rotationRef.get();
    
    if (!doc.exists) {
      console.log('⚠️ لا توجد بيانات تناوب سابقة. هذا طبيعي إذا كان النظام جديدًا.');
      return null;
    }
    
    const data = doc.data();
    const now = new Date();
    const nextRotation = data.nextRotationDate?.toDate();
    
    const status = {
      currentAccountIndex: data.currentAccountIndex,
      needsRotation: nextRotation ? now > nextRotation : false
    };

    console.log('ⓘ ملاحظة: هذه البيانات قد لا تعكس الحساب الفعلي المستخدم حاليًا، حيث أن التناوب يتم يوميًا.');
    console.log(`الحساب المسجل في Firestore: ${status.currentAccountIndex + 1}`);
    console.log(`هل يحتاج التناوب الدوري (كل 13 يوم) للتحديث؟: ${status.needsRotation ? 'نعم ⚠️' : 'لا ✅'}`);
    
    return status;
  }

  async checkWebhooksHealth() {
    console.log('🏥 فحص صحة Webhooks...\n');
    const results = [];
    
    for (let i = 0; i < this.zapierAccounts.length; i++) {
      const account = this.zapierAccounts[i];
      if (!account.webhook) {
        results.push({ account: account.name || `حساب ${i+1}`, status: '❌ Webhook مفقود', healthy: false });
        continue;
      }
      
      try {
        const response = await axios.post(
          account.webhook,
          { test: true, system: 'rotation_checker' },
          { timeout: 10000, validateStatus: (status) => status < 500 }
        );
        results.push({
          account: account.name || `حساب ${i+1}`,
          status: response.status === 200 ? '✅ يعمل' : `⚠️ حالة: ${response.status}`,
          healthy: response.status === 200
        });
      } catch (error) {
        results.push({ account: account.name || `حساب ${i+1}`, status: `❌ خطأ: ${error.message}`, healthy: false });
      }
    }
    
    console.log('┌──────────────────────────────────┐');
    console.log('│         تقرير صحة Webhooks        │');
    console.log('├──────────────────────────────────┤');
    results.forEach(r => console.log(`│ ${r.account.padEnd(15)}: ${r.status}`));
    console.log('└──────────────────────────────────┘\n');
    
    return results;
  }

  async generateReport() {
    console.log('📄 توليد تقرير شامل...\n');
    const health = await this.checkWebhooksHealth();
    const healthyCount = health.filter(h => h.healthy).length;
    
    const summary = `
📊 *تقرير صحة النظام اليومي*
━━━━━━━━━━━━━━━━
*صحة Webhooks:*
${health.map(h => `• ${h.account}: ${h.status}`).join('\n')}

*الملخص:*
• الحسابات الصحية: ${healthyCount} / ${this.zapierAccounts.length}
${healthyCount < this.zapierAccounts.length ? '⚠️ *تنبيه: يوجد حسابات لا تعمل!*' : '✅ جميع الحسابات تعمل بشكل طبيعي.'}
    `.trim();
    
    await this.sendNotification(summary);
    return summary;
  }
  
  async sendNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id: chatId, text: message, parse_mode: 'Markdown' }
      );
      console.log('📨 تم إرسال تقرير الصحة إلى Telegram\n');
    } catch (error) {
      console.error('❌ فشل إرسال الإشعار:', error.message);
    }
  }
  
  async run() {
    try {
      await this.initialize();
      await this.generateReport();
      console.log('╔════════════════════════════════════╗');
      console.log('║   ✅ اكتمل فحص صحة النظام بنجاح    ║');
      console.log('╚════════════════════════════════════╝');
    } catch (error) {
      console.error('💥 خطأ في فحص النظام:', error);
      await this.sendNotification(`*فشل نظام فحص الصحة*\n\nحدث خطأ: ${error.message}`);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  new RotationChecker().run();
}

module.exports = RotationChecker;
