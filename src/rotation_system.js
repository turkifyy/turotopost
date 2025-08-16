const admin = require('firebase-admin');
const axios = require('axios');
const { format } = require('date-fns');

// 1. تهيئة Firebase
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();

// 2. التحقق من نظام التناوب
async function checkRotationSystem() {
  const rotationRef = db.collection('system_settings').doc('rotation');
  const doc = await rotationRef.get();
  
  if (doc.exists) {
    const data = doc.data();
    const now = new Date();
    const nextRotationDate = data.nextRotationDate.toDate();
    const daysRemaining = Math.ceil((nextRotationDate - now) / (1000 * 60 * 60 * 24));
    
    // إرسال تنبيه قبل 3 أيام من انتهاء الفترة
    if (daysRemaining <= 3) {
      const message = `
⏳ *تنبيه بقرب انتهاء فترة الحساب*
- الحساب الحالي: ${data.currentAccountIndex + 1}
- الأيام المتبقية: ${daysRemaining}
- تاريخ الانتهاء: ${format(nextRotationDate, 'yyyy-MM-dd')}

⚠️ سيتم التبديل إلى الحساب التالي تلقائياً
      `;
      
      await sendTelegramNotification(message);
    }
    
    // التحقق إذا انتهت الدورة الكاملة (جميع الحسابات)
    if (data.currentAccountIndex === 4 && daysRemaining <= 0) {
      const message = `
🔁 *اكتملت دورة الحسابات!*
- تم استخدام جميع الحسابات لمدة 13 يوم
- النظام يعود للحساب الأول
- الدورة الجديدة تبدأ الآن
      `;
      
      await sendTelegramNotification(message);
    }
  }
}

// 3. إرسال إشعارات التلغرام
async function sendTelegramNotification(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('📨 تم إرسال الإشعار إلى التلغرام');
  } catch (error) {
    console.error('❌ فشل إرسال إشعار التلغرام:', error);
  }
}

// 4. التنفيذ الرئيسي
checkRotationSystem().catch(console.error);
