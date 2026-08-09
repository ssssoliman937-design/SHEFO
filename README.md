# Deal or No Deal Football

لعبة درافت كرة قدم بأسلوب "Deal or No Deal": بتختار لاعبين من بطاقات غامضة وتبني تشكيلة، وبعدها تتحاكي مباراة بين تشكيلتك وتشكيلة الخصم.

تطبيق ويب (PWA) عربي RTL بالكامل — المتصفح بيكتب على Firebase Realtime Database مباشرة، مفيش سيرفر بيحتفظ بأي حالة لعبة.

## التشغيل محلياً

```bash
npm install
npm run build          # يولّد public/js/player-database.js من data/players.json
npm start              # http://localhost:3001
```

على ويندوز فيه كمان `Run-Game.bat` (بينادي `node server.js` مباشرة).

اللعبة بتشتغل من غير أي متغيرات بيئة إجبارية:

| المتغير | إجباري | الوصف |
|---|---|---|
| `PORT` | لا | افتراضي `3001` |
| `CORS_ORIGIN` | لا | افتراضي `*` |

مفيش ملف `.env` في الريبو — حطّهم في بيئة التشغيل لو احتجت (Vercel → Environment Variables، أو `$env:VAR="..."` في PowerShell).

## بنية المشروع

```
server.js                    Express: يقدّم public/ بس. مفيه أي حالة لعبة.
data/players.json            المصدر الوحيد لبطاقات اللاعبين.
scripts/sync-players.js      يولّد public/js/player-database.js من الـ JSON.
public/index.html            واجهة الويب.
public/js/player-database.js مُولّد آلياً — متعدّلوش بالإيد.
public/js/firebase-engine.js محرك اللعبة (قراءة/كتابة Firebase من المتصفح).
public/js/app.js             رندر الواجهة والأحداث.
public/js/auth.js            تسجيل دخول جوجل (اختياري — شوف "تسجيل الدخول" تحت).
public/js/leaderboard.js     قائمة المتصدرين.
public/js/sound-effects.js   مؤثرات صوتية.
public/sw.js                 Service Worker (PWA). لازم تزوّد CACHE_NAME مع أي تغيير في قائمة الملفات.
```

## تسجيل الدخول

اللعب **مايحتاجش** تسجيل دخول — تكتب اسمك وتلعب. زرار "تسجيل الدخول بجوجل" وقائمة المتصدرين مخفيين افتراضياً لأن `public/js/firebase-engine.js` لسه فيه مفاتيح Firebase Auth placeholder (`apiKey`/`appId`/`messagingSenderId`).

لو عايز تفعّلهم: هات مفاتيح مشروعك من Firebase Console → Project Settings → Web App، واستبدل القيم في `firebaseConfig` بأول `public/js/firebase-engine.js`. الكود بيكتشف المفاتيح الحقيقية تلقائياً ويظهر زرار الدخول والمتصدرين من غير أي تعديل تاني.

## تعديل بيانات اللاعبين

عدّل `data/players.json` بس، وبعدها:

```bash
npm run build
```

سكيمة اللاعب:

```json
{ "id": "att1_prime", "name": "Lionel Messi (Prime GOAT) 👑", "rating": 99,
  "club": "Legend Icon", "nation": "Argentina", "flag": "🇦🇷",
  "edition": "Prime Ultra 🌈" }
```

- `nation` اسم البلد بدون علم، والعلم في `flag` لوحده (بيتقارن كنص لحساب التناغم).
- بطاقات `MGR` لازم يكون معاها `tactic`.
- `id` لازم يكون فريد على مستوى كل المراكز — `sync-players.js` بيرفض التوليد لو فيه تكرار أو بيانات ناقصة.

## النشر (Vercel)

`vercel.json` بيبني `server.js` كـ `@vercel/node` و `public/**` كـ static.

- `npm run build` لازم يشتغل في الـ build عشان `public/js/player-database.js` يتولّد.

## حدود معروفة

- **مفيش Firebase Security Rules مطبّقة.** أي حد يفتح console المتصفح يقدر يكتب في أي مسار. قواعد جاهزة للّصق موجودة في `docs/firebase-rules.json` — تتطبّق يدوياً من Firebase Console → Realtime Database → Rules.
- **مفيش اختبارات.** أي تعديل يتفحص يدوياً: `npm start` + جرّب في المتصفح.
- الـ rate limiter في `server.js` بيحمي طلبات Express بس — مش بيحمي مسار اللعبة الحقيقي (كتابة المتصفح المباشرة على Firebase).
