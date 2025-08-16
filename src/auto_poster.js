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

// 2. نظام التناوب
const ROTATION_DAYS = 13;
let zapierAccounts = [];
let currentAccountIndex = 0;

async function initRotationSystem() {
  // تحميل إعدادات التناوب من Firestore
  const rotationRef = db.collection('system_settings').doc('rotation');
  const doc = await rotationRef.get();
  
  if (doc.exists) {
    const data = doc.data();
    currentAccountIndex = data.currentAccountIndex || 0;
    
    // التحقق إذا انتهت فترة الـ 13 يوم
    const now = new Date();
    const nextRotationDate = data.nextRotationDate.toDate();
    
    if (now > nextRotationDate) {
      currentAccountIndex = (currentAccountIndex + 1) % 5;
      const newRotationDate = new Date();
      newRotationDate.setDate(newRotationDate.getDate() + ROTATION_DAYS);
      
      await rotationRef.update({
        currentAccountIndex: currentAccountIndex,
        startDate: admin.firestore.Timestamp.now(),
        nextRotationDate: admin.firestore.Timestamp.fromDate(newRotationDate)
      });
      
      // إرسال إشعار عند تبديل الحساب
      await sendTelegramNotification(
        `🔄 تم التبديل إلى الحساب ${currentAccountIndex + 1}\n` +
        `📅 تاريخ الانتهاء: ${format(newRotationDate, 'yyyy-MM-dd')}`
      );
    }
  } else {
    // الإعداد الأولي
    const startDate = new Date();
    const nextRotationDate = new Date();
    nextRotationDate.setDate(startDate.getDate() + ROTATION_DAYS);
    
    await rotationRef.set({
      currentAccountIndex: 0,
      startDate: admin.firestore.Timestamp.now(),
      nextRotationDate: admin.firestore.Timestamp.fromDate(nextRotationDate),
      totalCycles: 0
    });
  }
  
  // تحميل حسابات Zapier من البيئة
  zapierAccounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
}

// 3. جدول المحتوى الأسبوعي
const contentSchedule = {
  1: { // الإثنين
    morning: 'مسلسل',
    afternoon: 'فيلم',
    evening: 'مباراة',
    night: 'وصفة'
  },
  2: { // الثلاثاء
    morning: 'وصفة',
    afternoon: 'لعبة',
    evening: 'تطبيق',
    night: 'قناة'
  },
  3: { // الأربعاء
    morning: 'قناة',
    afternoon: 'ريلز',
    evening: 'مسلسل',
    night: 'فيلم'
  },
  4: { // الخميس
    morning: 'فيلم',
    afternoon: 'مباراة',
    evening: 'وصفة',
    night: 'لعبة'
  },
  5: { // الجمعة
    morning: 'لعبة',
    afternoon: 'تطبيق',
    evening: 'قناة',
    night: 'ريلز'
  },
  6: { // السبت
    morning: 'ريلز',
    afternoon: 'مسلسل',
    evening: 'فيلم',
    night: 'مباراة'
  },
  0: { // الأحد
    morning: 'مباراة',
    afternoon: 'وصفة',
    evening: 'لعبة',
    night: 'تطبيق'
  }
};

// 4. جلب الروابط من Firebase
async function getLinksForCategory(category, limit = 1) {
  try {
    // أولا: جلب روابط غير منشورة
    const newLinks = await db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    if (!newLinks.empty) return newLinks.docs;

    // ثانيا: جلب روابط قديمة (لم تنشر منذ 15 يوم)
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    
    const oldLinks = await db.collection('links')
      .where('linkType', '==', category)
      .where('isPosted', '==', true)
      .where('lastPosted', '<', fifteenDaysAgo)
      .orderBy('lastPosted', 'asc')
      .limit(limit)
      .get();

    if (!oldLinks.empty) return oldLinks.docs;

    // ثالثا: أي روابط متاحة
    const anyLinks = await db.collection('links')
      .where('linkType', '==', category)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    return anyLinks.docs;
  } catch (error) {
    console.error('❌ خطأ في جلب الروابط:', error);
    return [];
  }
}

// 5. إرسال البيانات إلى Zapier
async function sendToZapier(linkData) {
  try {
    const account = zapierAccounts[currentAccountIndex];
    
    const payload = {
      socialTitle: linkData.socialTitle,
      socialDescription: linkData.socialDescription,
      shortUrl: linkData.shortUrl,
      socialImage: linkData.socialImage,
      linkType: linkData.linkType,
      seriesName: linkData.seriesName
    };

    const response = await axios.post(
      account.webhook,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        },
        timeout: 30000
      }
    );
    
    console.log(`✅ تم إرسال المنشور إلى Zapier: ${linkData.socialTitle}`);
    return true;
  } catch (error) {
    console.error('❌ فشل إرسال إلى Zapier:', error.response?.data || error.message);
    return false;
  }
}

// 6. تحديث حالة الرابط في Firebase
async function updateLinkStatus(linkDoc) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await linkDoc.ref.update({
    isPosted: true,
    lastPosted: now,
    postCount: admin.firestore.FieldValue.increment(1),
    lastAccount: `zapier-${currentAccountIndex + 1}`
  });
}

// 7. إرسال تقارير إلى التلغرام
async function sendTelegramNotification(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('❌ فشل إرسال إشعار التلغرام:', error);
  }
}

// 8. الوظيفة الرئيسية
async function postContent() {
  try {
    // تهيئة نظام التناوب
    await initRotationSystem();
    
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hours = now.getHours();
    
    // تحديد الفترة الزمنية
    let timeSlot;
    if (hours >= 5 && hours < 12) timeSlot = 'morning';
    else if (hours >= 12 && hours < 16) timeSlot = 'afternoon';
    else if (hours >= 16 && hours < 19) timeSlot = 'evening';
    else timeSlot = 'night';
    
    // الحصول على أنواع المحتوى للفترة الحالية
    const categories = [
      contentSchedule[dayOfWeek][timeSlot],
      `${contentSchedule[dayOfWeek][timeSlot]}_alt1`,
      `${contentSchedule[dayOfWeek][timeSlot]}_alt2`
    ];
    
    let successCount = 0;
    let failCount = 0;
    const postedLinks = [];
    const errors = [];

    // جلب ونشر المحتوى لكل فئة
    for (const category of categories) {
      const linkDocs = await getLinksForCategory(category, 1);
      
      if (linkDocs.length > 0) {
        const linkData = linkDocs[0].data();
        
        try {
          const success = await sendToZapier(linkData);
          
          if (success) {
            await updateLinkStatus(linkDocs[0]);
            successCount++;
            postedLinks.push({
              category: category,
              title: linkData.socialTitle
            });
          } else {
            failCount++;
            errors.push(`فشل نشر ${category}`);
          }
        } catch (error) {
          failCount++;
          errors.push(`خطأ في نشر ${category}: ${error.message}`);
        }
      } else {
        failCount++;
        errors.push(`لا يوجد محتوى لنوع: ${category}`);
      }
    }
    
    // إرسال التقرير النهائي
    const report = `
📅 *تقرير النشر - ${timeSlot}*
- التاريخ: ${format(now, 'yyyy-MM-dd')}
- الوقت: ${format(now, 'HH:mm')}
- الحساب المستخدم: ${currentAccountIndex + 1}
✅ المنشورات الناجحة: ${successCount}
❌ المنشورات الفاشلة: ${failCount}
${failCount > 0 ? `- الأخطاء: ${errors.join(', ')}` : ''}

🔗 الروابط المنشورة:
${postedLinks.map(link => `  - ${link.category}: ${link.title}`).join('\n')}
    `;
    
    await sendTelegramNotification(report);
    console.log('🏁 اكتملت عملية النشر بنجاح');
    
  } catch (error) {
    console.error('🔥 خطأ رئيسي:', error);
    await sendTelegramNotification(
      `🚨 *خطأ جسيم في النظام!*\n` +
      `- الخطأ: ${error.message}\n` +
      `- الوقت: ${format(new Date(), 'yyyy-MM-dd HH:mm')}`
    );
  }
}

// 9. التنفيذ الرئيسي
postContent();
