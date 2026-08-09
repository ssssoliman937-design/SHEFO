# n8n workflows — dea

هذه المجلد فيه workflow files جاهزة للاستيراد في n8n. **المشروع نفسه سيرفرلس (Vercel) فمفيش مكان يشغّل n8n بنفسه** — لازم تستضيف n8n بنفسك (n8n.cloud، أو self-hosted Docker) وتستورد الملفات دي فيه.

## الملفات
- `dea-stale-room-cleanup.json` — كل 6 ساعات، يمسح غرف `dond_rooms`/`mazad_rooms` القديمة. **بديل أبسط بدون n8n خالص:** المشروع فيه نفس الوظيفة دي شغالة أصلاً كـ Vercel Cron يوميًا (`api/cleanup-stale-rooms.js` + `vercel.json` → `crons`) — استخدم الملف ده بس لو عايز تردد أعلى من مرة يوميًا (محتاج Vercel Pro plan) أو تشغيل من برّة Vercel.
- `dea-active-idle-report.json` — تقرير عن الغرف النشطة/الخاملة (تقريب من عدد الغرف، مش عدد مستخدمين حقيقي — راجع تعليق الكود جوه الـworkflow).
- `dea-weekly-leaderboard-digest.json` — أسبوعيًا، يجيب أفضل 5 لاعبين في كل تصنيف من الـ4 (صفقة سريع/كامل، مزاد سريع/كامل) من `users/{uid}/profile/stats/{gameKey}`. **مفيش نود إشعار متحطة** (Slack/Discord/Telegram/إيميل) لأن مفيش وجهة محددة — ضيف نود بعد "Build Digest" على حسب احتياجك.

## طريقة الاستيراد
1. افتح n8n (Workflows → Import from File).
2. اختار الملف `.json`.
3. تأكد إن رابط Firebase في نودات الـ HTTP Request مطابق لـ `FIREBASE_DB_URL` الحالي (حاليًا `https://cuafa-9f3b6-default-rtdb.firebaseio.com` — لو اتغيّر، غيّره في كل نود URL).
4. فعّل الـ workflow (Active toggle).

## ملاحظات
- Firebase Security Rules **مطبّقة دلوقتي** (`docs/firebase-rules.json`) — `dond_rooms`/`mazad_rooms`/`users` كلهم قابلين للقراءة العامة (`.read: true`) عشان الـ HTTP GET نودات هنا تفضل شغالة من غير أي مصادقة إضافية. الكتابة (DELETE في workflow التنظيف) لسه مفتوحة لأي حد برضو — لو عايز تقفلها، محتاج Cloud Function بدل REST مباشر.
- workflow التقرير الأسبوعي والتقرير اليومي مفيهمش نود إشعار — ضيف نود بعد "Build Digest"/"Build Report" على حسب احتياجك.
