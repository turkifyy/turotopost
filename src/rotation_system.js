// ============================================
// نظام فحص وإدارة التناوب v4.3 - مع دعم يومي عشوائي
// ============================================

const admin = require('firebase-admin');
const { format, differenceInDays, addDays, getDay } = require('date-fns');
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
        databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com/`
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
  
  async checkDailyRotationStatus() {
    console.log('📊 فحص حالة التناوب اليومي الحالية...\n');
    
    const today = format(new Date(), 'yyyy-MM-dd');
    const rotationRef = this.db.collection('system_settings').doc(`rotation-${today}`);
    const doc = await rotationRef.get();
    
    if (!doc.exists) {
      console.log('⚠️ لا توجد بيانات تناوب يومية اليوم، سيتم إنشاؤها تلقائياً');
      return null;
    }
    
    const data = doc.data();
    const configDate = format(data.configDate.toDate(), 'yyyy-MM-dd');
    
    const status = {
      today: today,
      configDate: configDate,
      shuffledAccounts: data.shuffledAccounts || [],
      timeSlotMap: data.timeSlotMap || {},
      totalCycles: data.totalCycles || 0,
      needsNewRotation: configDate !== today
    };
    
    // عرض المعلومات
    console.log('┌─────────────────────────────────────┐');
    console.log('│     معلومات التناوب اليومي          │');
    console.log('├─────────────────────────────────────┤');
    console.log(`│ 📅 التاريخ: ${status.today}`);
    console.log(`│ 🔄 تاريخ التكوين: ${status.configDate}`);
    console.log(`│ 📈 إجمالي الدورات: ${status.totalCycles}`);
    console.log(`│ 🚦 يحتاج تناوب جديد: ${status.needsNewRotation ? 'نعم ⚠️' : 'لا ✅'}`);
    console.log('├─────────────────────────────────────┤');
    console.log('│         خريطة الفترات:              │');
    Object.entries(status.timeSlotMap || {}).forEach(([slot, account]) => {
      console.log(`│ ${slot}: ${account.name || account}`);
    });
    console.log('└─────────────────────────────────────┘\n');
    
    if (status.needsNewRotation) {
      await this.generateNewDailyRotation(today);
    }
    
    return status;
  }
  
  async generateNewDailyRotation(today) {
    console.log('🔄 إنشاء تناوب يومي جديد عشوائي...\n');
    
    // Shuffle الحسابات
    const shuffledAccounts = [...this.zapierAccounts].sort(() => Math.random() - 0.5);
    
    const timeSlots = ['morning', 'afternoon', 'evening', 'night'];
    const timeSlotMap = {};
    timeSlots.forEach((slot, index) => {
      timeSlotMap[slot] = shuffledAccounts[index % shuffledAccounts.length];
    });

    const config = {
      configDate: admin.firestore.Timestamp.now(),
      shuffledAccounts: shuffledAccounts.map(a => a.name),
      timeSlotMap: timeSlotMap,
      created: admin.firestore.Timestamp.now(),
      totalCycles: admin.firestore.FieldValue.increment(1)
    };

    await this.db.collection('system_settings').doc(`rotation-${today}`).set(config);
    
    console.log(`✅ تم إنشاء تناوب يومي جديد لـ ${today}`);
    console.log('┌─────────────────────────────────────┐');
    console.log('│       الفترات الجديدة:              │');
    Object.entries(timeSlotMap).forEach(([slot, account]) => {
      console.log(`│ ${slot}: ${account.name}`);
    });
    console.log('└─────────────────────────────────────┘\n');
    
    await this.sendNotification(
      `🔄 *تناوب يومي جديد!*\n` +
      `📅 لليوم: ${today}\n` +
      `الحسابات المعشوشبة: ${shuffledAccounts.map(a => a.name).join(', ')}`
    );
  }
  
  async getAccountsUsageStats() {
    console.log('📈 إحصائيات استخدام الحسابات...\n');
    
    const stats = [];
    
    for (let i = 0; i < this.zapierAccounts.length; i++) {
      const account = this.zapierAccounts[i];
      
      // جلب إحصائيات من Firebase
      const query = await this.db.collection('links')
        .where('lastAccount', '==', account.name)
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
  
  async forceDailyRotation() {
    console.log('🔄 تنفيذ تناوب يومي يدوي...\n');
    
    const today = format(new Date(), 'yyyy-MM-dd');
    await this.generateNewDailyRotation(today);
    
    return true;
  }
  
  async generateReport() {
    console.log('📄 توليد تقرير شامل...\n');
    
    const status = await this.checkDailyRotationStatus();
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
🕐 ${format(new Date(), 'yyyy-MM-dd HH:mm')}

*حالة التناوب اليومي:*
• التاريخ: ${status?.today || 'غير محدد'}
• الحسابات المعشوشبة: ${status?.shuffledAccounts?.join(', ') || 'غير محدد'}

*الإحصائيات:*
• إجمالي المنشورات: ${report.summary.totalPosts}
• متوسط لكل حساب: ${report.summary.averagePostsPerAccount}
• الحسابات الصحية: ${report.summary.healthyAccounts}/${report.summary.totalAccounts}

${status?.needsNewRotation ? '⚠️ *تنبيه: تم إنشاء تناوب جديد!*' : '✅ النظام يعمل بشكل طبيعي'}
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
        },
        { timeout: 10000 }
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
      await this.checkDailyRotationStatus();
      await this.getAccountsUsageStats();
      await this.checkWebhooksHealth();
      
      // توليد التقرير الشامل
      await this.generateReport();
      
      console.log('╔════════════════════════════════════╗');
      console.log('║     ✅ اكتمل فحص النظام بنجاح      ║');
      console.log('╚════════════════════════════════════╝');
      
    } catch (error) {
      console.error('💥 خطأ في فحص النظام:', error);
      await this.sendNotification(`💥 *خطأ في فحص التناوب*\n${error.message}\nتم التعامل تلقائياً`);
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
