import express from "express";
import { config, getMissingCoreConfig } from "./config.js";
import {
  exchangeCodeForLongLivedUserToken,
  getFacebookLoginUrl,
  getManagedPages,
  publishPagePost
} from "./facebook.js";
import { generatePost, getActiveAiModel } from "./ai.js";
import { startScheduler, schedulerIsActive } from "./scheduler.js";
import { readState, updateState } from "./storage.js";

const app = express();

app.use(express.json());
app.set("trust proxy", true);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function runPostingJob() {
  const state = readState();
  const pageId = config.facebookPageId;
  const hasMatchingPageToken = state.facebook.pageId === config.facebookPageId;
  const pageAccessToken = hasMatchingPageToken ? state.facebook.pageAccessToken : "";
  const pageName = hasMatchingPageToken ? state.facebook.pageName || "My Facebook Page" : "My Facebook Page";

  if (!pageId || !pageAccessToken) {
    throw new Error("The configured FB_PAGE_ID is not connected yet. Reconnect Facebook for this page.");
  }

  const message = await generatePost({
    pageName,
    recentPosts: state.posts
  });

  const publishResult = await publishPagePost({
    pageId,
    pageAccessToken,
    message
  });

  updateState((current) => {
    current.posts.push({
      id: publishResult.id,
      message,
      createdAt: new Date().toISOString()
    });
    current.posts = current.posts.slice(-20);
    current.scheduler.lastRunAt = new Date().toISOString();
    current.scheduler.lastResult = `Posted successfully to ${pageName}`;
    current.scheduler.lastError = "";
    return current;
  });

  return {
    postId: publishResult.id,
    message
  };
}

const cronExpression = startScheduler(async () => {
  try {
    await runPostingJob();
    console.log(`[scheduler] post published at ${new Date().toISOString()}`);
  } catch (error) {
    updateState((current) => {
      current.scheduler.lastRunAt = new Date().toISOString();
      current.scheduler.lastError = error.message;
      return current;
    });
    console.error("[scheduler] failed:", error.message);
  }
});

app.get("/", (req, res) => {
  const state = readState();
  const missing = getMissingCoreConfig();
  const connectedConfiguredPage =
    state.facebook.pageId === config.facebookPageId ? state.facebook.pageName : "";
  const recentPosts = state.posts
    .slice(-5)
    .reverse()
    .map((post) => `<li><pre style="white-space:pre-wrap">${escapeHtml(post.message)}</pre></li>`)
    .join("");

  res.type("html").send(`<!doctype html>
  <html lang="ar">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Facebook AI Auto Poster</title>
    </head>
    <body style="font-family:Tahoma,Arial,sans-serif;max-width:860px;margin:40px auto;line-height:1.7">
      <h1>بوت النشر التلقائي بالذكاء الاصطناعي لصفحتك</h1>
      <p>هذا المشروع ينشر تلقائيًا إلى <strong>Facebook Page</strong> كل ${config.postIntervalMinutes} دقائق باستخدام Gemini و Meta Graph API.</p>

      <h2>الحالة</h2>
      <ul>
        <li>الجدولة: ${schedulerIsActive() ? "مفعلة" : "متوقفة"}</li>
        <li>التكرار: ${escapeHtml(cronExpression)}</li>
        <li>الرابط العام: ${escapeHtml(config.baseUrl)}</li>
        <li>مزود الذكاء الاصطناعي: ${escapeHtml(config.aiProvider)}</li>
        <li>الموديل: ${escapeHtml(getActiveAiModel())}</li>
        <li>FB_PAGE_ID المحدد: ${escapeHtml(config.facebookPageId || "غير مضبوط")}</li>
        <li>الصفحة المربوطة: ${escapeHtml(connectedConfiguredPage || "غير مربوطة بعد")}</li>
        <li>آخر تشغيل: ${escapeHtml(state.scheduler.lastRunAt || "لم يتم بعد")}</li>
        <li>آخر نتيجة: ${escapeHtml(state.scheduler.lastResult || "لا توجد")}</li>
        <li>آخر خطأ: ${escapeHtml(state.scheduler.lastError || "لا يوجد")}</li>
      </ul>

      <h2>الإعداد</h2>
      ${
        missing.length
          ? `<p>المتغيرات الناقصة في <code>.env</code>: ${escapeHtml(missing.join(", "))}</p>`
          : `<p>تم تحميل المتغيرات الأساسية.</p>`
      }
      <p>لن يتم استخدام أي صفحة أخرى غير الصفحة المحددة في <code>FB_PAGE_ID</code>.</p>
      <p><a href="/auth/facebook/start">ربط حساب فيسبوك وربط الصفحة المحددة فقط</a></p>
      <p><a href="/run-once">نشر منشور تجريبي الآن</a></p>
      <p><a href="/status">عرض الحالة كـ JSON</a></p>

      <h2>آخر المنشورات المولدة</h2>
      <ol>${recentPosts || "<li>لا توجد منشورات بعد.</li>"}</ol>
    </body>
  </html>`);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime()
  });
});

app.get("/status", (req, res) => {
  const state = readState();
  const missing = getMissingCoreConfig();

  res.json({
    ok: true,
    baseUrl: config.baseUrl,
    stateDir: config.stateDir,
    aiProvider: config.aiProvider,
    aiModel: getActiveAiModel(),
    configuredPageId: config.facebookPageId,
    schedulerActive: schedulerIsActive(),
    connectedPage: state.facebook.pageId === config.facebookPageId
      ? {
          id: state.facebook.pageId,
          name: state.facebook.pageName
        }
      : null,
    missingEnv: missing,
    lastRunAt: state.scheduler.lastRunAt,
    lastResult: state.scheduler.lastResult,
    lastError: state.scheduler.lastError,
    recentPosts: state.posts.slice(-5)
  });
});

app.get("/auth/facebook/start", (req, res) => {
  const missing = getMissingCoreConfig();
  if (missing.length) {
    res.status(400).send(`Missing env values: ${missing.join(", ")}`);
    return;
  }

  res.redirect(getFacebookLoginUrl(config.baseUrl));
});

app.get("/auth/facebook/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      throw new Error("Facebook did not return an authorization code.");
    }

    const userAccessToken = await exchangeCodeForLongLivedUserToken(
      String(code),
      config.baseUrl
    );
    const pages = await getManagedPages(userAccessToken);

    if (!pages.length) {
      throw new Error("No managed Facebook Pages were found for this account.");
    }

    const matchingPage = pages.find((page) => page.id === config.facebookPageId);

    if (!matchingPage) {
      throw new Error(
        `The configured FB_PAGE_ID (${config.facebookPageId}) is not managed by this Facebook account.`
      );
    }

    updateState((current) => {
      current.facebook.userAccessToken = userAccessToken;
      current.facebook.pages = [matchingPage];
      current.facebook.lastAuthAt = new Date().toISOString();
      current.facebook.pageId = matchingPage.id;
      current.facebook.pageName = matchingPage.name;
      current.facebook.pageAccessToken = matchingPage.access_token;

      return current;
    });

    res.redirect("/");
  } catch (error) {
    res.status(500).send(`Facebook auth failed: ${error.message}`);
  }
});

app.get("/run-once", async (req, res) => {
  try {
    const result = await runPostingJob();
    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    updateState((current) => {
      current.scheduler.lastRunAt = new Date().toISOString();
      current.scheduler.lastError = error.message;
      return current;
    });
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
  console.log(`Public base URL ${config.baseUrl}`);
  console.log(`Scheduler active every ${config.postIntervalMinutes} minutes`);
});
