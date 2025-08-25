// ============================================
// نظام فحص وإدارة التناوب v5.0
// ============================================

const admin = require('firebase-admin');
const { format, differenceInDays, addDays } = require('date-fns');
const axios = require('axios');
const crypto = require('crypto');

class RotationChecker {
  constructor() {
    this.db = null;
    this.zapierAccounts = [];
  }
  
  async initialize() {
    console.log('╔════════════════════════════════════╗');
    console.log('║    🔄 نظام فحص التناوب v5.0       ║');
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
    const dailyRotationRef = this.db.collection('system_settings').doc('daily_rotation');
    
    const [rotationDoc, dailyRotationDoc] = await Promise.all([
      rotationRef.get(),
      dailyRotationRef.get()
    ]);
    
    const now = new Date();
    let status = {
      currentAccount: 0,
      totalAccounts: this.zapierAccounts.length,
      startDate: 'غير محدد',
      nextRotation: 'غير محدد',
      daysRemaining: 0,
      totalCycles: 0,
      needsRotation: false,
      dailyRotation: {}
    };
    
    if (rotationDoc.exists) {
      const data = rotationDoc.data();
      const nextRotation = data.nextRotationDate?.toDate();
      const startDate = data.startDate?.toDate();
      
      status = {
        ...status,
        currentAccount: data.currentAccountIndex + 1,
        startDate: startDate ? format(startDate, 'yyyy-MM-dd HH:mm') : 'غير محدد',
        nextRotation: nextRotation ? format(nextRotation, 'yyyy-MM-dd HH:mm') : 'غير محدد',
        daysRemaining: nextRotation ? differenceInDays(nextRotation, now) : 0,
        totalCycles: data.totalCycles || 0,
        needsRotation: nextRotation ? now > nextRotation : false
      };
    }
    
    if (dailyRotationDoc.exists) {
      const data = dailyRotationDoc.data();
      status.dailyRotation = data.rotationMap || {};
      status.dailyRotationDate = data.date || 'غير محدد';
    }
    
    // عرض المعلومات
    console.log('┌─────────────────────────────────────┐');
    console.log('│         معلومات التناوب الحالية      │');
    console.log('├─────────────────────────────────────┤');
    console.log(`│ 💼 الحساب الحالي: ${status.currentAccount}/${status.totalAccounts}`);
    console.log(`│ 📅 بداية الدورة: ${status.startDate}`);
    console.log(`│ 🔄 التناوب القادم: ${status.nextRotation}`);
    console.log(`│ ⏳ الأيام المتبقية: ${status.daysRemaining} يوم`);
    console.log(`│ 📈 إجمالي الدورات: ${status.totalCycles}`);
    console.log(`│ 🗓️ توزيع اليوم: ${status.dailyRotationDate}`);
    console.log(`│ 🚦 يحتاج تناوب: ${status.needsRotation ? 'نعم ⚠️' : 'لا ✅'}`);
    
    // عرض توزيع الحسابات اليومي
    if (Object.keys(status.dailyRotation).length > 0) {
      console.log('├─────────────────────────────────────┤');
      console.log('│        توزيع الحسابات اليومي        │');
      console.log('├─────────────────────────────────────┤');
      Object.entries(status.dailyRotation).forEach(([period, accountIndex]) => {
        console.log(`│ ${period}: حساب ${accountIndex + 1}`);
      });
    }
    
    console.log('└─────────────────────────────────────┘\n');
    
    return status;
  }
  
  async getAccountsUsageStats() {
    console.log('📈 إحصائيات استخدام الحسابات...\n');
    
    const stats = [];
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    for (let i = 0; i < this.zapierAccounts.length; i++) {
      const account = this.zapierAccounts[i];
      const accountName = `zapier-${i + 1}`;
      
      // جلب إحصائيات من Firebase (آخر 7 أيام)
      const query = await this.db.collection('links')
        .where('lastAccount', '==', accountName)
        .where('lastPosted', '>=', admin.firestore.Timestamp.fromDate(sevenDaysAgo))
        .get();
      
      // جلب إحصائيات إجمالية
      const totalQuery = await this.db.collection('links')
        .where('lastAccount', '==', accountName)
        .get();
      
      const accountStats = {
        accountNumber: i + 1,
        totalPosts: totalQuery.size,
        weeklyPosts: query.size,
        webhookUrl: account.webhook ? '✅ موجود' : '❌ مفقود',
        accountName: account.name || `حساب ${i + 1}`,
        health: this.checkAccountHealth(account, totalQuery.size)
      };
      
      stats.push(accountStats);
    }
    
    // عرض الإحصائيات
    console.log('┌─────────────────────────────────────┐');
    console.log('│      إحصائيات الحسابات              │');
    console.log('├─────────────────────────────────────┤');
    
    stats.forEach(stat => {
      console.log(`│ حساب ${stat.accountNumber}: ${stat.totalPosts} منشور | ${stat.weeklyPosts} هذا الأسبوع | ${stat.health}`);
    });
    
    console.log('└─────────────────────────────────────┘\n');
    
    return stats;
  }
  
  checkAccountHealth(account, postCount) {
    if (!account.webhook) return '❌ غير مفعل';
    if (postCount === 0) return '⚠️ غير مستخدم';
    return '✅ نشط';
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
          { 
            test: true, 
            timestamp: new Date().toISOString(),
            check: "health"
          },
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
      
      // تأخير بين الاختبارات لتجنب الحظر
      await this.delay(1000);
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
    console.log(`📅 التناوب القادم: ${format(nextRotation, 'yyyy-MM-dd')}\n`);
    
    // إرسال إشعار
    await this.sendNotification(
      `🔄 تناوب يدوي!\n` +
      `تم التبديل إلى الحساب ${newIndex + 1}\n` +
      `التناوب القادم: ${format(nextRotation, 'yyyy-MM-dd')}`
    );
    
    return true;
  }
  
  async generateNewDailyRotation() {
    console.log('🎲 إنشاء توزيع يومي جديد...\n');
    
    const periods = ['morning', 'afternoon', 'evening', 'night'];
    const rotationMap = {};
    const usedIndices = new Set();
    
    periods.forEach(period => {
      let randomIndex;
      do {
        randomIndex = crypto.randomInt(0, this.zapierAccounts.length);
      } while (usedIndices.has(randomIndex) && usedIndices.size < this.zapierAccounts.length);
      
      usedIndices.add(randomIndex);
      rotationMap[period] = randomIndex;
    });
    
    const today = format(new Date(), 'yyyy-MM-dd');
    const rotationRef = this.db.collection('system_settings').doc('daily_rotation');
    
    await rotationRef.set({
      date: today,
      rotationMap: rotationMap,
      createdAt: admin.firestore.Timestamp.now()
    });
    
    console.log('✅ تم إنشاء توزيع يومي جديد');
    
    // عرض التوزيع الجديد
    console.log('┌─────────────────────────────────────┐');
    console.log('│        التوزيع اليومي الجديد        │');
    console.log('├─────────────────────────────────────┤');
    Object.entries(rotationMap).forEach(([period, accountIndex]) => {
      console.log(`│ ${period}: حساب ${accountIndex + 1}`);
    });
    console.log('└─────────────────────────────────────┘\n');
    
    return rotationMap;
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
        weeklyPosts: usage.reduce((sum, u) => sum + u.weeklyPosts, 0),
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

*حالة التناوب:*
• الحساب الحالي: ${status?.currentAccount || 'غير محدد'}/${this.zapierAccounts.length}
• الأيام المتبقية: ${status?.daysRemaining || 0} يوم

*الإحصائيات:*
• إجمالي المنشورات: ${report.summary.totalPosts}
• المنشورات الأسبوعية: ${report.summary.weeklyPosts}
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
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      
      // إنشاء توزيع يومي جديد إذا كان التوزيع الحالي قديماً
      const today = format(new Date(), 'yyyy-MM-dd');
      const dailyRotationRef = this.db.collection('system_settings').doc('daily_rotation');
      const dailyDoc = await dailyRotationRef.get();
      
      if (!dailyDoc.exists || dailyDoc.data().date !== today) {
        await this.generateNewDailyRotation();
      }
      
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
