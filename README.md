# Facebook AI Auto Poster

هذا المشروع ينشئ بوت Node.js للنشر التلقائي إلى **Facebook Page** كل 10 دقائق باستخدام:

- Gemini لتوليد نص المنشور
- Meta Graph API للنشر الرسمي
- Facebook Login لربط الحساب بالصفحة المحددة في `FB_PAGE_ID`
- داشبورد محمي بكود دخول لإدارة الربط ووقت النشر

## مهم

هذا المشروع موجّه للنشر التلقائي إلى **Facebook Page** تديرها أنت. يعتمد على واجهات Meta الرسمية الخاصة بالصفحات، وليس على الملف الشخصي.

المصادر الرسمية:

- https://developers.facebook.com/docs/pages-api/posts/
- https://developers.facebook.com/docs/permissions/
- https://developers.facebook.com/docs/sharing/reference/feed-dialog
- https://ai.google.dev/models/gemini
- https://ai.google.dev/gemini-api/docs/text-generation
- https://ai.google.dev/tutorials/embed_node_quickstart

## 1. التثبيت

```bash
npm install
```

انسخ ملف البيئة:

```bash
copy .env.example .env
```

ثم عدل القيم التالية داخل `.env`:

- `AI_PROVIDER`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `FB_APP_ID`
- `FB_APP_SECRET`
- `FB_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN` إذا أردت التشغيل المباشر دون ربط الصفحة
- `CONTENT_LANGUAGE`
- `CONTENT_BRIEF`
- `POST_INTERVAL_MINUTES`
- `TIMEZONE`

اختياري:

- `BASE_URL` إذا أردت تحديد الدومين يدويًا
- `STATE_DIR` لتحديد مسار ملف الحالة

## 2. تشغيل البوت

```bash
npm start
```

ثم افتح:

```text
http://localhost:3000
```

إذا وضعت `FB_PAGE_ACCESS_TOKEN` مع `FB_PAGE_ID` فسيبدأ البوت بالنشر مباشرة بعد التشغيل، دون الحاجة إلى تنفيذ Facebook Login أولًا.

## 3. الدخول إلى الداشبورد

- افتح `/login`
- كود الدخول الحالي هو `5598`
- بعد الدخول ستجد حالة الربط
- بعد الدخول ستجد حالة الجدولة
- بعد الدخول ستجد تحكمًا في وقت النشر بالدقائق
- بعد الدخول ستجد تشغيلًا يدويًا للنشر

## 4. ربط فيسبوك

من الصفحة الرئيسية:

1. افتح الداشبورد
2. اضغط `ربط الصفحة`
3. سجل الدخول عبر Facebook Login
4. امنح الصلاحيات المطلوبة
5. إذا كان الحساب يدير الصفحة المطابقة لـ `FB_PAGE_ID` فسيتم ربطها تلقائيًا

إذا كنت تستخدم `FB_PAGE_ACCESS_TOKEN`:

1. لا تحتاج هذا القسم أصلًا
2. شغّل البوت فقط
3. سيستخدم الصفحة المحددة في `FB_PAGE_ID` مباشرة

## 5. تجربة النشر

يمكنك تشغيل منشور فوري من:

```text
http://localhost:3000/run-once
```

## 6. الصلاحيات المستخدمة

المشروع يطلب صلاحيات مرتبطة بإدارة الصفحة والنشر عليها، وأهمها:

- `pages_manage_posts`
- `pages_read_engagement`
- `pages_show_list`

## 7. ملاحظات عملية

- التوكنات تُحفظ محليًا داخل `data/state.json`
- لا تضع هذا الملف في Git
- إذا انتهت صلاحية الربط، أعد تسجيل الدخول من `/auth/facebook/start`
- إذا وضعت `FB_PAGE_ACCESS_TOKEN` فلن تحتاج إلى ربط الصفحة من الداشبورد
- هذا الإصدار مقفول على الصفحة الموجودة في `FB_PAGE_ID` فقط، ولن يسمح باختيار صفحة أخرى
- يمكنك تغيير وقت النشر من الداشبورد دون تعديل المتغيرات ودون إعادة تشغيل التطبيق
- عدل `CONTENT_BRIEF` ليصبح المحتوى مناسبًا لمجالك بدل المنشورات العامة
- بحسب وثائق Google الحالية في 19 مارس 2026، Gemini 3 متاح ضمن Gemini API، وبعض نماذجه ما تزال بصيغة Preview
- هذا الإصدار يعتمد على Gemini فقط، لذلك اجعل `AI_PROVIDER=gemini`

## 8. النشر على GitHub

إذا لم يكن المشروع داخل Git بعد:

```bash
git init
git add .
git commit -m "Initial Facebook page auto poster"
```

ثم أنشئ مستودعًا جديدًا على GitHub وأضف الـ remote:

```bash
git remote add origin YOUR_GITHUB_REPO_URL
git branch -M main
git push -u origin main
```

## 9. النشر على Railway

1. ارفع المشروع إلى GitHub
2. في Railway اختر `New Project` ثم `Deploy from GitHub Repo`
3. أضف متغيرات البيئة:
   - `AI_PROVIDER=gemini`
   - `FB_PAGE_ID` إجباري
   - `FB_PAGE_ACCESS_TOKEN` إذا أردت الوضع المباشر
   - `FB_APP_ID` و `FB_APP_SECRET` فقط إذا كنت تريد Facebook Login بدل التوكن المباشر
   - `CONTENT_LANGUAGE`
   - `CONTENT_BRIEF`
   - `POST_INTERVAL_MINUTES`
   - `TIMEZONE`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL=gemini-3-pro-preview`
4. أضف Volume في Railway إذا أردت الاحتفاظ بالتوكنات والحالة بعد إعادة التشغيل
5. اضبط `STATE_DIR=/data` إذا كان الـ Volume مركبًا على `/data`
6. بعد أن يعطيك Railway الدومين العام:
   - إما اترك التطبيق يستخدم `RAILWAY_PUBLIC_DOMAIN` تلقائيًا
   - أو ضع `BASE_URL=https://your-app.up.railway.app`
7. أضف رابط callback نفسه في إعدادات تطبيق Meta:
   - `https://your-domain/auth/facebook/callback`
8. بعد النشر افتح:
   - `/health` للفحص
   - `/status` لمراجعة الحالة
   - الصفحة الرئيسية لربط فيسبوك بالصفحة المحددة فقط
