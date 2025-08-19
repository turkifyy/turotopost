// التحقق من تثبيت جميع الحزم المطلوبة
console.log('🔍 التحقق من الاعتماديات...');
try {
  require('firebase-admin');
  console.log('✅ firebase-admin مثبت بشكل صحيح');
} catch (e) {
  console.error('❌ firebase-admin غير مثبت:', e.message);
  process.exit(1);
}

try {
  require('axios');
  console.log('✅ axios مثبت بشكل صحيح');
} catch (e) {
  console.error('❌ axios غير مثبت:', e.message);
  process.exit(1);
}

try {
  require('date-fns');
  console.log('✅ date-fns مثبت بشكل صحيح');
} catch (e) {
  console.error('❌ date-fns غير مثبت:', e.message);
  process.exit(1);
}

console.log('✅ جميع الاعتماديات مثبتة بشكل صحيح\n');

const admin = require('firebase-admin');
const axios = require('axios');
const { format } = require('date-fns');

// 1. تهيئة Firebase
console.log('🔥 تهيئة Firebase...');
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL
};

// التحقق من وجود جميع متغيرات Firebase
if (!serviceAccount.projectId || !serviceAccount.privateKey || !serviceAccount.clientEmail) {
  console.error('❌ متغيرات Firebase غير موجودة في البيئة');
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
  });
  console.log('✅ Firebase مهيأ بنجاح');
} catch (error) {
  console.error('❌ فشل تهيئة Firebase:', error.message);
  process.exit(1);
}

const db = admin.firestore();

// 2. إرسال إشعارات التلغرام
async function sendTelegramNotification(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    console.log('⚠️ إعدادات التلغرام غير موجودة، تخطي الإشعار');
    return;
  }
  
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('📨 تم إرسال الإشعار إلى التلغرام');
  } catch (error) {
    console.error('❌ فشل إرسال إشعار التلغرام:', error.message);
  }
}

// 3. التحقق من نظام التناوب
async function checkRotationSystem() {
  console.log('🔄 التحقق من نظام التناوب...');
  
  const rotationRef = db.collection('system_settings').doc('rotation');
  
  try {
    const doc = await rotationRef.get();
    
    if (doc.exists) {
      const data = doc.data();
      const now = new Date();
      const nextRotationDate = data.nextRotationDate.toDate();
      const daysRemaining = Math.ceil((nextRotationDate - now) / (1000 * 60 * 60 * 24));
      
      console.log(`📅 الحساب الحالي: ${data.currentAccountIndex + 1}`);
      console.log(`⏳ الأيام المتبقية: ${daysRemaining}`);
      console.log(`📆 تاريخ الانتهاء: ${format(nextRotationDate, 'yyyy-MM-dd')}`);
      
      // إرسال تنبيه قبل 3 أيام من انتهاء الفترة
      if (daysRemaining <= 3 && daysRemaining > 0) {
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
      
      if (daysRemaining <= 0) {
        console.log('🔄 حان وقت التبديل إلى الحساب التالي');
        
        const nextAccountIndex = (data.currentAccountIndex + 1) % 5;
        const newRotationDate = new Date();
        newRotationDate.setDate(newRotationDate.getDate() + 13);
        
        await rotationRef.update({
          currentAccountIndex: nextAccountIndex,
          nextRotationDate: admin.firestore.Timestamp.fromDate(newRotationDate),
          lastRotation: admin.firestore.Timestamp.now()
        });
        
        const switchMessage = `
🔄 *تم تبديل الحساب*
- الحساب السابق: ${data.currentAccountIndex + 1}
- الحساب الجديد: ${nextAccountIndex + 1}
- تاريخ الانتهاء: ${format(newRotationDate, 'yyyy-MM-dd')}
        `;
        
        await sendTelegramNotification(switchMessage);
        console.log('✅ تم التبديل إلى الحساب الجديد');
      }
    } else {
      console.log('⚠️ إعدادات التناوب غير موجودة، سيتم إنشاؤها في التشغيل القادم');
    }
  } catch (error) {
    console.error('❌ فشل التحقق من نظام التناوب:', error.message);
    await sendTelegramNotification(
      `🚨 *خطأ في نظام التناوب!*\n` +
      `- الخطأ: ${error.message}\n` +
      `- الوقت: ${format(new Date(), 'yyyy-MM-dd HH:mm')}`
    );
  }
}

// 4. التنفيذ الرئيسي
async function main() {
  try {
    await checkRotationSystem();
    console.log('✅ اكتمل التحقق من نظام التناوب');
  } catch (error) {
    console.error('🔥 خطأ غير متوقع:', error);
    process.exit(1);
  }
}

main();
