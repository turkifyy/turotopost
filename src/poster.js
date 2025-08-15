const admin = require('firebase-admin');
const axios = require('axios');
const { UserAgent } = require('user-agents');

// تهيئة Firebase
const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// جدول المحتوى الأسبوعي
const weeklySchedule = {
  0: ['مباراة', 'وصفة', 'لعبة'],      // الأحد
  1: ['مسلسل', 'فيلم', 'مباراة'],     // الإثنين
  2: ['وصفة', 'لعبة', 'تطبيق'],       // الثلاثاء
  3: ['قناة', 'ريلز', 'مسلسل'],       // الأربعاء
  4: ['فيلم', 'مباراة', 'وصفة'],      // الخميس
  5: ['لعبة', 'تطبيق', 'قناة'],       // الجمعة
  6: ['ريلز', 'مسلسل', 'فيلم']        // السبت
};

// دالة المساعدة للتأخير العشوائي
const randomDelay = (minMinutes = 1, maxMinutes = 5) => {
  const delayMs = Math.floor(Math.random() * (maxMinutes - minMinutes) * 60000) + (minMinutes * 60000);
  return new Promise(resolve => setTimeout(resolve, delayMs));
};

// دالة جلب المحتوى المحدثة
async function getContentsForTimeSlot(timeSlot) {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const categories = weeklySchedule[dayOfWeek];
  
  if (!categories) {
    throw new Error(`جدول المحتوى غير محدد لليوم: ${dayOfWeek}`);
  }

  const contents = [];
  
  for (const category of categories) {
    try {
      // البحث عن محتوى غير منشور
      const snapshot = await db.collection('links')
        .where('category', '==', category)
        .where('isPosted', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        contents.push({
          id: doc.id,
          ...doc.data()
        });
        continue;
      }
      
      // البحث عن محتوى قديم (لم ينشر منذ 30 يوم)
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 30);
      
      const oldSnapshot = await db.collection('links')
        .where('category', '==', category)
        .where('lastPosted', '<', monthAgo)
        .orderBy('lastPosted', 'asc')
        .limit(1)
        .get();
      
      if (!oldSnapshot.empty) {
        const doc = oldSnapshot.docs[0];
        contents.push({
          id: doc.id,
          ...doc.data()
        });
      }
    } catch (error) {
      console.error(`خطأ في جلب محتوى الفئة ${category}:`, error);
    }
  }
  
  return contents;
}

// دالة النشر المحدثة
async function postContent(content, accessToken) {
  try {
    // إنشاء وصف البطاقة
    const postData = {
      message: `${content.title}\n\n${content.description}\n\n🔗 ${content.shortUrl}`,
      link: content.shortUrl,
    };
    
    // إضافة الصورة المصغرة إذا وجدت
    if (content.thumbnail) {
      postData.picture = content.thumbnail;
    }
    
    // إعداد رأس عشوائي
    const userAgent = new UserAgent();
    const headers = {
      'User-Agent': userAgent.toString(),
      'Accept-Language': 'ar-SA,ar;q=0.9'
    };
    
    // النشر على فيسبوك
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.FB_PAGE_ID}/feed`,
      postData,
      {
        params: { access_token: accessToken },
        headers,
        timeout: 30000
      }
    );
    
    return {
      success: true,
      postId: response.data.id
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

// الدالة الرئيسية
async function main() {
  try {
    const timeSlot = process.argv[2] || 'morning';
    const accountId = process.argv[3] || '1';
    
    console.log(`بدء النشر للوقت: ${timeSlot}, الحساب: ${accountId}`);
    
    // جلب المحتويات
    const contents = await getContentsForTimeSlot(timeSlot);
    
    if (contents.length === 0) {
      console.log('لا يوجد محتوى متاح للنشر');
      return;
    }
    
    console.log(`تم العثور على ${contents.length} محتوى للنشر`);
    
    // جلب مفتاح الوصول
    const tokens = JSON.parse(process.env.FB_TOKENS);
    const accessToken = tokens[accountId];
    
    if (!accessToken) {
      throw new Error(`مفتاح الوصول غير موجود للحساب ${accountId}`);
    }
    
    const results = [];
    
    // نشر المحتويات مع تأخير عشوائي
    for (const content of contents) {
      await randomDelay(1, 3); // تأخير 1-3 دقائق
      
      const result = await postContent(content, accessToken);
      results.push(result);
      
      if (result.success) {
        // تحديث حالة المحتوى
        await db.collection('links').doc(content.id).update({
          isPosted: true,
          lastPosted: admin.firestore.FieldValue.serverTimestamp(),
          postCount: admin.firestore.FieldValue.increment(1)
        });
        console.log(`✅ تم نشر ${content.title} بنجاح!`);
      } else {
        console.error(`❌ فشل نشر ${content.title}:`, result.error);
      }
    }
    
    // تسجيل الإحصائيات
    const successCount = results.filter(r => r.success).length;
    await db.collection('stats').doc().set({
      date: new Date().toISOString(),
      timeSlot,
      accountId,
      successCount,
      totalCount: contents.length
    });
    
    console.log(`✅ تم نشر ${successCount}/${contents.length} منشور بنجاح`);
    
  } catch (error) {
    console.error('❌ خطأ رئيسي:', error.message);
    await db.collection('errors').doc().set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      error: error.message,
      details: error.stack
    });
  }
}

// تشغيل الدالة الرئيسية
if (require.main === module) {
  main();
          }
