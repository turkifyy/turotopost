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

// 2. نظام التناوب
const ROTATION_DAYS = 13;
let zapierAccounts = [];
let currentAccountIndex = 0;

async function initRotationSystem() {
  console.log('🔄 تهيئة نظام التناوب...');
  
  // تحميل حسابات Zapier من البيئة
  try {
    zapierAccounts = JSON.parse(process.env.ZAPIER_WEBHOOKS || '[]');
    console.log(`✅ تم تحميل ${zapierAccounts.length} حساب Zapier`);
  } catch (error) {
    console.error('❌ فشل تحميل حسابات Zapier:', error.message);
    process.exit(1);
  }

  if (zapierAccounts.length === 0) {
    console.error('❌ لم يتم العثور على أي حسابات Zapier');
    process.exit(1);
  }

  // تحميل إعدادات التناوب من Firestore
  const rotationRef = db.collection('system_settings').doc('rotation');
  
  try {
    const doc = await rotationRef.get();
    
    if (doc.exists) {
      const data = doc.data();
      currentAccountIndex = data.currentAccountIndex || 0;
      
      // التحقق إذا انتهت فترة الـ 13 يوم
      const now = new Date();
      const nextRotationDate = data.nextRotationDate.toDate();
      
      if (now > nextRotationDate) {
        currentAccountIndex = (currentAccountIndex + 1) % zapierAccounts.length;
        const newRotationDate = new Date();
        newRotationDate.setDate(newRotationDate.getDate() + ROTATION_DAYS);
        
        await rotationRef.update({
          currentAccountIndex: currentAccountIndex,
          startDate: admin.firestore.Timestamp.now(),
          nextRotationDate: admin.firestore.Timestamp.fromDate(newRotationDate),
          lastRotation: admin.firestore.Timestamp.now()
        });
        
        // إرسال إشعار عند تبديل الحساب
        await sendTelegramNotification(
          `🔄 تم التبديل إلى الحساب ${currentAccountIndex + 1}\n` +
          `📅 تاريخ الانتهاء: ${format(newRotationDate, 'yyyy-MM-dd')}`
        );
      }
      
      console.log(`✅ الحساب الحالي: ${currentAccountIndex + 1}`);
    } else {
      // الإعداد الأولي
      const startDate = new Date();
      const nextRotationDate = new Date();
      nextRotationDate.setDate(startDate.getDate() + ROTATION_DAYS);
      
      await rotationRef.set({
        currentAccountIndex: 0,
        startDate: admin.firestore.Timestamp.now(),
        nextRotationDate: admin.firestore.Timestamp.fromDate(nextRotationDate),
        totalCycles: 0,
        created: admin.firestore.Timestamp.now()
      });
      
      console.log('✅ تم الإعداد الأولي لنظام التناوب');
    }
  } catch (error) {
    console.error('❌ فشل تهيئة نظام التناوب:', error.message);
  }
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

    if (!newLinks.empty) {
      console.log(`✅ تم العثور على محتوى جديد لنوع: ${category}`);
      return newLinks.docs;
    }

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

    if (!oldLinks.empty) {
      console.log(`✅ تم العثور على محتوى قديم لنوع: ${category}`);
      return oldLinks.docs;
    }

    // ثالثا: أي روابط متاحة
    const anyLinks = await db.collection('links')
      .where('linkType', '==', category)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    if (!anyLinks.empty) {
      console.log(`✅ تم العثور على أي محتوى لنوع: ${category}`);
      return anyLinks.docs;
    }
    
    console.log(`⚠️ لم يتم العثور على أي محتوى لنوع: ${category}`);
    return [];
  } catch (error) {
    console.error(`❌ خطأ في جلب الروابط لنوع ${category}:`, error.message);
    return [];
  }
}

// 5. إرسال البيانات إلى Zapier
async function sendToZapier(linkData) {
  try {
    const account = zapierAccounts[currentAccountIndex];
    
    if (!account || !account.webhook) {
      throw new Error(`الحساب ${currentAccountIndex + 1} غير صحيح`);
    }
    
    const payload = {
      socialTitle: linkData.socialTitle || 'بدون عنوان',
      socialDescription: linkData.socialDescription || 'بدون وصف',
      shortUrl: linkData.shortUrl || '',
      socialImage: linkData.socialImage || '',
      linkType: linkData.linkType || 'عام',
      seriesName: linkData.seriesName || ''
    };

    console.log(`📤 إرسال إلى Zapier: ${payload.socialTitle}`);
    
    const response = await axios.post(
      account.webhook,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Auto-Poster/1.0'
        },
        timeout: 30000
      }
    );
    
    console.log(`✅ تم إرسال المنشور إلى Zapier: ${linkData.socialTitle}`);
    return true;
  } catch (error) {
    console.error('❌ فشل إرسال إلى Zapier:', error.message);
    return false;
  }
}

// 6. تحديث حالة الرابط في Firebase
async function updateLinkStatus(linkDoc) {
  try {
    const now = admin.firestore.FieldValue.serverTimestamp();
    await linkDoc.ref.update({
      isPosted: true,
      lastPosted: now,
      postCount: admin.firestore.FieldValue.increment(1),
      lastAccount: `zapier-${currentAccountIndex + 1}`
    });
    console.log('✅ تم تحديث حالة الرابط في Firebase');
  } catch (error) {
    console.error('❌ فشل تحديث حالة الرابط:', error.message);
  }
}

// 7. إرسال تقارير إلى التلغرام
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

// 8. الوظيفة الرئيسية
async function postContent() {
  console.log('🚀 بدء عملية النشر التلقائي\n');
  
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
    
    console.log(`📅 اليوم: ${dayOfWeek}, الفترة: ${timeSlot}`);
    
    // الحصول على أنواع المحتوى للفترة الحالية
    const mainCategory = contentSchedule[dayOfWeek]?.[timeSlot];
    
    if (!mainCategory) {
      throw new Error(`لا يوجد جدول محتوى لليوم ${dayOfWeek} والفترة ${timeSlot}`);
    }
    
    const categories = [
      mainCategory,
      `${mainCategory}_alt1`,
      `${mainCategory}_alt2`
    ];
    
    console.log(`🔍 أنواع المحتوى: ${categories.join(', ')}\n`);
    
    let successCount = 0;
    let failCount = 0;
    const postedLinks = [];
    const errors = [];

    // جلب ونشر المحتوى لكل فئة
    for (const category of categories) {
      console.log(`📦 معالجة النوع: ${category}`);
      
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
              title: linkData.socialTitle || 'بدون عنوان'
            });
            console.log(`✅ نجح نشر: ${category}\n`);
          } else {
            failCount++;
            errors.push(`فشل نشر ${category}`);
            console.log(`❌ فشل نشر: ${category}\n`);
          }
        } catch (error) {
          failCount++;
          errors.push(`خطأ في نشر ${category}: ${error.message}`);
          console.log(`❌ خطأ في نشر: ${category} - ${error.message}\n`);
        }
      } else {
        failCount++;
        errors.push(`لا يوجد محتوى لنوع: ${category}`);
        console.log(`⚠️ لا يوجد محتوى لـ: ${category}\n`);
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
    console.error('🔥 خطأ رئيسي:', error.message);
    await sendTelegramNotification(
      `🚨 *خطأ جسيم في النظام!*\n` +
      `- الخطأ: ${error.message}\n` +
      `- الوقت: ${format(new Date(), 'yyyy-MM-dd HH:mm')}`
    );
  }
}

// 9. التنفيذ الرئيسي
postContent().catch(error => {
  console.error('🔥 خطأ غير متوقع:', error);
  process.exit(1);
});
