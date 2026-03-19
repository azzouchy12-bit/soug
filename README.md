# Facebook AI Auto Poster

هذا المشروع ينشئ بوت Node.js للنشر التلقائي إلى **Facebook Page** كل 10 دقائق باستخدام:

- Gemini لتوليد نص المنشور
- Meta Graph API للنشر الرسمي
- Facebook Login لربط الحساب بالصفحة المحددة في `FB_PAGE_ID`

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

## 3. ربط فيسبوك

من الصفحة الرئيسية:

1. اضغط `ربط حساب فيسبوك وربط الصفحة المحددة فقط`
2. سجل الدخول عبر Facebook Login
3. امنح الصلاحيات المطلوبة
4. إذا كان الحساب يدير الصفحة المطابقة لـ `FB_PAGE_ID` فسيتم ربطها تلقائيًا

## 4. تجربة النشر

يمكنك تشغيل منشور فوري من:

```text
http://localhost:3000/run-once
```

## 5. الصلاحيات المستخدمة

المشروع يطلب صلاحيات مرتبطة بإدارة الصفحة والنشر عليها، وأهمها:

- `pages_manage_posts`
- `pages_read_engagement`
- `pages_show_list`

## 6. ملاحظات عملية

- التوكنات تُحفظ محليًا داخل `data/state.json`
- لا تضع هذا الملف في Git
- إذا انتهت صلاحية الربط، أعد تسجيل الدخول من `/auth/facebook/start`
- هذا الإصدار مقفول على الصفحة الموجودة في `FB_PAGE_ID` فقط، ولن يسمح باختيار صفحة أخرى
- عدل `CONTENT_BRIEF` ليصبح المحتوى مناسبًا لمجالك بدل المنشورات العامة
- بحسب وثائق Google الحالية في 19 مارس 2026، Gemini 3 متاح ضمن Gemini API، وبعض نماذجه ما تزال بصيغة Preview
- هذا الإصدار يعتمد على Gemini فقط، لذلك اجعل `AI_PROVIDER=gemini`

## 7. النشر على GitHub

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

## 8. النشر على Railway

1. ارفع المشروع إلى GitHub
2. في Railway اختر `New Project` ثم `Deploy from GitHub Repo`
3. أضف متغيرات البيئة:
   - `AI_PROVIDER=gemini`
   - `FB_APP_ID`
   - `FB_APP_SECRET`
   - `FB_PAGE_ID` إجباري
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
