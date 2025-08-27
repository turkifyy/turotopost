/**
 * نظام إعداد التناوب اليومي لحسابات Zapier v5.0
 * الوصف: يعمل هذا السكربت مرة واحدة يومياً لإنشاء جدول عشوائي
 * لاستخدام حسابات Zapier لكل فترة نشر (صباح، ظهر، مساء، ليل).
 */

const admin = require('firebase-admin');
const axios = require('axios');

// =============================================================================
// 1. تهيئة النظام
// =============================================================================
console.log('🔄 بدء إعداد التناوب اليومي لحسابات Zapier...');

function initializeFirebase() {
    console.log('🔥 تهيئة Firebase...');
    try {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                    clientEmail: process.env.CLIENT_EMAIL
                })
            });
        }
        console.log('✅ Firebase مهيأ بنجاح');
        return admin.firestore();
    } catch (error) {
        console.error('❌ فشل تهيئة Firebase:', error.message);
        throw error;
    }
}

function getZapierAccounts() {
    console.log('💼 تحميل حسابات Zapier...');
    try {
        const accounts = JSON.parse(process.env.ZAPIER_WEBHOOKS);
        if (!Array.isArray(accounts) || accounts.length < 4) {
            throw new Error('ZAPIER_WEBHOOKS يجب أن يكون array ويحتوي على 4 حسابات على الأقل.');
        }
        console.log(`✅ تم تحميل ${accounts.length} حساب.`);
        return accounts;
    } catch (error) {
        console.error('❌ خطأ في ZAPIER_WEBHOOKS:', error.message);
        throw error;
    }
}

// =============================================================================
// 2. المنطق الأساسي
// =============================================================================

/**
 * دالة لخلط عناصر مصفوفة بشكل عشوائي (خوارزمية Fisher-Yates)
 * @param {Array} array - المصفوفة المراد خلطها
 * @returns {Array} - مصفوفة جديدة بعناصر مخلوطة
 */
function shuffleArray(array) {
    let newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

async function createDailyAssignment(db, accounts) {
    console.log('🔀 خلط الحسابات لليوم...');
    const shuffledAccounts = shuffleArray(accounts);
    
    const periods = ['morning', 'afternoon', 'evening', 'night'];
    const assignment = {
        assignments: {
            morning:   shuffledAccounts[0],
            afternoon: shuffledAccounts[1],
            evening:   shuffledAccounts[2],
            night:     shuffledAccounts[3]
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        date: new Date().toISOString().split('T')[0]
    };

    console.log('💾 حفظ جدول التناوب في Firestore...');
    const today = new Date().toISOString().split('T')[0];
    const docRef = db.collection('system_settings').doc(`zapier_assignment_${today}`);
    
    await docRef.set(assignment);
    console.log(`✅ تم حفظ جدول التناوب لليوم: ${today}`);
    
    return assignment;
}

// =============================================================================
// 3. إرسال الإشعارات
// =============================================================================
async function sendNotification(assignment) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.CHAT_ID;
    if (!token || !chatId) {
        console.log('⚠️ إعدادات Telegram غير موجودة - تم تخطي الإشعار');
        return;
    }

    let message = `🔄 *تم إعداد تناوب حسابات Zapier لليوم*\n\n`;
    message += `*الصباح 🌅:* ${assignment.assignments.morning.name}\n`;
    message += `*الظهر ☀️:* ${assignment.assignments.afternoon.name}\n`;
    message += `*المساء 🌇:* ${assignment.assignments.evening.name}\n`;
    message += `*الليل 🌙:* ${assignment.assignments.night.name}\n\n`;
    message += `النظام جاهز لبدء النشر.`;

    try {
        await axios.post(
            `https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            }
        );
        console.log('📨 تم إرسال تقرير إعداد التناوب إلى Telegram');
    } catch (error) {
        console.error('❌ فشل إرسال إشعار Telegram:', error.message);
    }
}

// =============================================================================
// 4. التشغيل
// =============================================================================
async function main() {
    try {
        const db = initializeFirebase();
        const accounts = getZapierAccounts();
        const assignment = await createDailyAssignment(db, accounts);
        await sendNotification(assignment);
        console.log('\n✅ اكتمل إعداد التناوب اليومي بنجاح!');
        process.exit(0);
    } catch (error) {
        console.error('\n💥 فشل إعداد التناوب اليومي:', error.message);
        // Optional: Send failure notification via Telegram
        process.exit(1);
    }
}

main();
