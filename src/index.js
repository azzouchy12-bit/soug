import crypto from "node:crypto";
import express from "express";
import { config, getMissingCoreConfig } from "./config.js";
import {
  exchangeCodeForLongLivedUserToken,
  getFacebookLoginUrl,
  getManagedPages,
  publishPagePost
} from "./facebook.js";
import { generatePost, getActiveAiModel } from "./ai.js";
import {
  getSchedulerSnapshot,
  schedulerIsActive,
  startScheduler,
  stopScheduler
} from "./scheduler.js";
import { readState, updateState } from "./storage.js";

const app = express();
const DASHBOARD_COOKIE = "dashboard_session";

const icons = {
  shield: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.9-3 8.9-7 10-4-1.1-7-5.1-7-10V6l7-3z"></path>
      <path d="M9.5 12.5l1.7 1.7 3.8-4.2"></path>
    </svg>
  `,
  clock: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M12 7v5l3 2"></path>
    </svg>
  `,
  spark: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l1.9 4.8L19 9.7l-4 3.2 1.3 5.1L12 15.3 7.7 18l1.3-5.1-4-3.2 5.1-1.9L12 3z"></path>
    </svg>
  `,
  page: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2"></rect>
      <path d="M8 8h8M8 12h8M8 16h5"></path>
    </svg>
  `,
  play: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6l10 6-10 6z"></path>
    </svg>
  `,
  link: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 13a4 4 0 0 1 0-6l2-2a4 4 0 1 1 6 6l-1 1"></path>
      <path d="M14 11a4 4 0 0 1 0 6l-2 2a4 4 0 1 1-6-6l1-1"></path>
    </svg>
  `,
  logout: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 17l5-5-5-5"></path>
      <path d="M15 12H4"></path>
      <path d="M12 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"></path>
    </svg>
  `,
  lock: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2"></rect>
      <path d="M8 11V8a4 4 0 0 1 8 0v3"></path>
    </svg>
  `,
  status: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 18l4-5 3 3 6-8"></path>
      <path d="M4 20h16"></path>
    </svg>
  `
};

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", true);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};

  for (const item of header.split(";")) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    const key = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed;
    const value = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : "";
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getDashboardSessionToken() {
  const seed = config.facebookAppSecret || config.baseUrl || config.stateFile;
  return crypto
    .createHash("sha256")
    .update(`${config.dashboardAccessCode}:${seed}`)
    .digest("hex");
}

function isDashboardAuthenticated(req) {
  const cookies = parseCookies(req);
  return cookies[DASHBOARD_COOKIE] === getDashboardSessionToken();
}

function setDashboardSession(res) {
  res.setHeader(
    "Set-Cookie",
    buildCookie(DASHBOARD_COOKIE, getDashboardSessionToken(), {
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: config.baseUrl.startsWith("https://")
    })
  );
}

function clearDashboardSession(res) {
  res.setHeader(
    "Set-Cookie",
    buildCookie(DASHBOARD_COOKIE, "", {
      maxAge: 0,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: config.baseUrl.startsWith("https://")
    })
  );
}

function redirectWithMessage(res, pathname, params = {}) {
  const target = new URL(pathname, config.baseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      target.searchParams.set(key, value);
    }
  }

  res.redirect(`${target.pathname}${target.search}`);
}

function ensureDashboardAuth(req, res, next) {
  if (isDashboardAuthenticated(req)) {
    next();
    return;
  }

  const acceptsJson = (req.headers.accept || "").includes("application/json");

  if (acceptsJson || req.path === "/status") {
    res.status(401).json({
      ok: false,
      error: "Dashboard authentication required."
    });
    return;
  }

  redirectWithMessage(res, "/login", {
    error: "ادخل كود الداشبورد أولاً."
  });
}

function getScheduleSettings(state = readState()) {
  const intervalMinutes = Math.max(
    1,
    Number.parseInt(String(state.scheduler.intervalMinutes || config.postIntervalMinutes), 10)
  );

  return {
    enabled: state.scheduler.enabled !== false,
    intervalMinutes
  };
}

function hasDirectPageAccessToken() {
  return Boolean(config.facebookPageAccessToken);
}

function getResolvedPageConnection(state = readState()) {
  if (hasDirectPageAccessToken()) {
    return {
      pageId: config.facebookPageId,
      pageAccessToken: config.facebookPageAccessToken,
      pageName:
        state.facebook.pageId === config.facebookPageId && state.facebook.pageName
          ? state.facebook.pageName
          : "Configured Facebook Page",
      mode: "direct"
    };
  }

  const hasMatchingPageToken = state.facebook.pageId === config.facebookPageId;

  return {
    pageId: config.facebookPageId,
    pageAccessToken: hasMatchingPageToken ? state.facebook.pageAccessToken : "",
    pageName: hasMatchingPageToken ? state.facebook.pageName || "My Facebook Page" : "My Facebook Page",
    mode: "oauth"
  };
}

async function runPostingJob() {
  const state = readState();
  const connection = getResolvedPageConnection(state);
  const pageId = connection.pageId;
  const pageAccessToken = connection.pageAccessToken;
  const pageName = connection.pageName;

  if (!pageId || !pageAccessToken) {
    throw new Error("The configured FB_PAGE_ID is not connected yet. Add FB_PAGE_ACCESS_TOKEN or reconnect Facebook for this page.");
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

function syncScheduler() {
  const state = readState();
  const schedule = getScheduleSettings(state);

  if (!schedule.enabled) {
    stopScheduler();
    return getSchedulerSnapshot();
  }

  startScheduler(runPostingJob, {
    intervalMinutes: schedule.intervalMinutes,
    timezone: config.timezone
  });

  return getSchedulerSnapshot();
}

function getStatusTone(active, hasError) {
  if (hasError) {
    return "status-bad";
  }

  return active ? "status-good" : "status-warn";
}

function renderShell({ title, body, description = "" }) {
  return `<!doctype html>
  <html lang="ar" dir="rtl">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          color-scheme: light;
          --bg: #f3f5ef;
          --panel: rgba(255, 255, 255, 0.92);
          --panel-strong: #ffffff;
          --text: #1a2421;
          --muted: #61706c;
          --line: rgba(22, 42, 35, 0.12);
          --brand: #0f6b5a;
          --brand-strong: #0a5346;
          --brand-soft: #d8efe8;
          --gold: #c48a2c;
          --danger: #bb4d4d;
          --danger-soft: #fde7e7;
          --warn-soft: #fff2d6;
          --shadow: 0 18px 50px rgba(16, 39, 32, 0.14);
          --radius: 24px;
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          font-family: Tahoma, Arial, sans-serif;
          background:
            radial-gradient(circle at top left, rgba(15, 107, 90, 0.18), transparent 32%),
            radial-gradient(circle at bottom right, rgba(196, 138, 44, 0.16), transparent 28%),
            linear-gradient(180deg, #eff3ec 0%, #f6f7f2 100%);
          color: var(--text);
          min-height: 100vh;
        }

        a { color: inherit; text-decoration: none; }

        .shell {
          width: min(1180px, calc(100vw - 28px));
          margin: 24px auto;
        }

        .hero {
          background: linear-gradient(135deg, rgba(8, 57, 49, 0.95), rgba(15, 107, 90, 0.92));
          color: #f7fbfa;
          border-radius: 30px;
          padding: 28px;
          box-shadow: var(--shadow);
          position: relative;
          overflow: hidden;
        }

        .hero::after {
          content: "";
          position: absolute;
          inset: auto -80px -80px auto;
          width: 220px;
          height: 220px;
          background: radial-gradient(circle, rgba(255, 255, 255, 0.2), transparent 68%);
        }

        .hero-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          flex-wrap: wrap;
        }

        .eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.12);
          color: rgba(255, 255, 255, 0.92);
          font-size: 14px;
        }

        .hero h1, .auth-card h1 {
          margin: 14px 0 8px;
          font-size: clamp(30px, 4vw, 44px);
          line-height: 1.15;
        }

        .hero p, .auth-card p {
          margin: 0;
          color: rgba(255, 255, 255, 0.86);
          max-width: 680px;
          line-height: 1.8;
        }

        .toolbar {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(12, minmax(0, 1fr));
          gap: 18px;
          margin-top: 20px;
        }

        .card {
          grid-column: span 12;
          background: var(--panel);
          backdrop-filter: blur(10px);
          border: 1px solid var(--line);
          border-radius: var(--radius);
          padding: 22px;
          box-shadow: 0 10px 30px rgba(22, 42, 35, 0.08);
        }

        .card-title {
          display: flex;
          align-items: center;
          gap: 12px;
          margin: 0 0 16px;
          font-size: 20px;
        }

        .card-title svg,
        .eyebrow svg,
        .btn svg,
        .metric-label svg {
          width: 20px;
          height: 20px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
          flex: 0 0 auto;
        }

        .metric-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 14px;
        }

        .metric {
          background: var(--panel-strong);
          border: 1px solid var(--line);
          border-radius: 20px;
          padding: 16px;
        }

        .metric-label {
          display: flex;
          align-items: center;
          gap: 10px;
          color: var(--muted);
          font-size: 14px;
          margin-bottom: 10px;
        }

        .metric-value {
          font-size: 22px;
          font-weight: 700;
          line-height: 1.35;
          word-break: break-word;
        }

        .metric-note {
          font-size: 13px;
          color: var(--muted);
          margin-top: 8px;
        }

        .status-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border-radius: 999px;
          padding: 8px 14px;
          font-size: 14px;
          font-weight: 700;
        }

        .status-good { background: #dff5ea; color: #0c6c48; }
        .status-warn { background: var(--warn-soft); color: #8f6415; }
        .status-bad { background: var(--danger-soft); color: var(--danger); }

        .form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }

        label {
          display: block;
          font-size: 14px;
          color: var(--muted);
          margin-bottom: 8px;
        }

        input[type="password"],
        input[type="number"],
        input[type="text"] {
          width: 100%;
          border: 1px solid rgba(20, 54, 45, 0.14);
          border-radius: 16px;
          padding: 14px 16px;
          background: #fff;
          color: var(--text);
          font-size: 16px;
          outline: none;
        }

        input:focus {
          border-color: rgba(15, 107, 90, 0.5);
          box-shadow: 0 0 0 4px rgba(15, 107, 90, 0.12);
        }

        .inline-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 18px;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          border: 0;
          border-radius: 16px;
          padding: 13px 18px;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.16s ease, box-shadow 0.16s ease;
        }

        .btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 12px 24px rgba(20, 54, 45, 0.12);
        }

        .btn-primary { background: var(--brand); color: #fff; }
        .btn-secondary { background: var(--brand-soft); color: var(--brand-strong); }
        .btn-ghost {
          background: transparent;
          color: #f4fbf8;
          border: 1px solid rgba(255, 255, 255, 0.18);
        }

        .btn-danger { background: #fff1f1; color: var(--danger); }

        .notice, .error-box {
          border-radius: 18px;
          padding: 14px 16px;
          margin-bottom: 16px;
          line-height: 1.7;
        }

        .notice {
          background: #e7f4ef;
          color: #0f6b5a;
          border: 1px solid rgba(15, 107, 90, 0.16);
        }

        .error-box {
          background: var(--danger-soft);
          color: #8c2f2f;
          border: 1px solid rgba(187, 77, 77, 0.18);
        }

        .toggle {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 16px;
          background: var(--panel-strong);
          border: 1px solid var(--line);
          border-radius: 16px;
        }

        .toggle input {
          width: 20px;
          height: 20px;
          accent-color: var(--brand);
        }

        .list {
          display: grid;
          gap: 14px;
        }

        .post-item {
          background: var(--panel-strong);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 16px;
        }

        .post-meta {
          color: var(--muted);
          font-size: 13px;
          margin-bottom: 10px;
        }

        .post-body {
          white-space: pre-wrap;
          margin: 0;
          line-height: 1.8;
        }

        .muted {
          color: var(--muted);
          line-height: 1.8;
        }

        .auth-wrap {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
        }

        .auth-card {
          width: min(520px, 100%);
          background: rgba(10, 55, 48, 0.95);
          color: #f5fbf9;
          border-radius: 30px;
          padding: 30px;
          box-shadow: var(--shadow);
        }

        .auth-card .muted {
          color: rgba(245, 251, 249, 0.76);
          margin-top: 12px;
        }

        .auth-field {
          margin: 22px 0 12px;
        }

        .auth-card input {
          background: rgba(255, 255, 255, 0.98);
        }

        .auth-card .notice,
        .auth-card .error-box {
          margin-top: 0;
        }

        @media (min-width: 860px) {
          .span-4 { grid-column: span 4; }
          .span-5 { grid-column: span 5; }
          .span-7 { grid-column: span 7; }
          .span-8 { grid-column: span 8; }
        }

        @media (max-width: 640px) {
          .shell { width: min(100vw - 18px, 100%); margin: 12px auto; }
          .hero, .card, .auth-card { border-radius: 24px; padding: 20px; }
          .hero-head { align-items: stretch; }
          .toolbar { width: 100%; }
          .btn { width: 100%; }
        }
      </style>
      ${description ? `<meta name="description" content="${escapeHtml(description)}" />` : ""}
    </head>
    <body>${body}</body>
  </html>`;
}

function renderLoginPage({ notice = "", error = "" } = {}) {
  return renderShell({
    title: "تسجيل دخول الداشبورد",
    description: "لوحة تحكم بوت النشر التلقائي على Facebook Page.",
    body: `
      <main class="auth-wrap">
        <section class="auth-card">
          <div class="eyebrow">${icons.lock}<span>Dashboard Access</span></div>
          <h1>دخول الداشبورد</h1>
          <p>أدخل كود الحماية لفتح لوحة التحكم الخاصة بالنشر، وربط الصفحة، وضبط وقت الجدولة.</p>
          ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
          ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ""}
          <form method="post" action="/login">
            <div class="auth-field">
              <label for="accessCode">كود الدخول</label>
              <input id="accessCode" name="accessCode" type="password" inputmode="numeric" autocomplete="off" placeholder="ادخل الكود" required />
            </div>
            <button class="btn btn-primary" type="submit">${icons.shield}<span>فتح الداشبورد</span></button>
          </form>
          <p class="muted">بعد تسجيل الدخول ستتمكن من التحكم بوقت النشر، ربط الصفحة، وتشغيل نشر يدوي عند الحاجة.</p>
        </section>
      </main>
    `
  });
}

function renderDashboard({ req, state, notice = "", error = "" }) {
  const missing = getMissingCoreConfig();
  const schedule = getScheduleSettings(state);
  const schedulerSnapshot = getSchedulerSnapshot();
  const pageConnection = getResolvedPageConnection(state);
  const isDirectMode = pageConnection.mode === "direct";
  const connectedConfiguredPage = pageConnection.pageAccessToken ? pageConnection.pageName : "";
  const recentPosts = state.posts.slice(-6).reverse();
  const statusTone = getStatusTone(
    schedulerIsActive() && schedule.enabled,
    Boolean(state.scheduler.lastError)
  );
  const currentHost = `${req.protocol}://${req.get("host")}`;

  return renderShell({
    title: "Dashboard | Facebook Page Auto Poster",
    description: "لوحة تحكم احترافية للنشر التلقائي بالذكاء الاصطناعي على صفحتك.",
    body: `
      <main class="shell">
        <section class="hero">
          <div class="hero-head">
            <div>
              <div class="eyebrow">${icons.spark}<span>Gemini + Facebook Page Automation</span></div>
              <h1>لوحة تحكم النشر التلقائي</h1>
              <p>هذه اللوحة مقفولة على صفحتك فقط عبر <strong>FB_PAGE_ID</strong>، وتمنحك تحكمًا مباشرًا في وقت النشر وتشغيل منشور فوري عند الحاجة${isDirectMode ? " من دون خطوة ربط الصفحة." : " مع إمكانية ربط الصفحة عند الحاجة."}</p>
            </div>
            <div class="toolbar">
              ${
                isDirectMode
                  ? `<span class="btn btn-ghost">${icons.page}<span>وضع مباشر مفعل</span></span>`
                  : `<a class="btn btn-ghost" href="/auth/facebook/start">${icons.link}<span>ربط الصفحة</span></a>`
              }
              <a class="btn btn-ghost" href="/status">${icons.status}<span>JSON</span></a>
              <form method="post" action="/logout">
                <button class="btn btn-ghost" type="submit">${icons.logout}<span>خروج</span></button>
              </form>
            </div>
          </div>
        </section>

        <section class="grid">
          <article class="card span-7">
            <h2 class="card-title">${icons.status}<span>نظرة عامة</span></h2>
            ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
            ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ""}
            ${
              missing.length
                ? `<div class="error-box">المتغيرات الناقصة: ${escapeHtml(missing.join(", "))}</div>`
                : `<div class="notice">جميع المتغيرات الأساسية جاهزة.</div>`
            }
            <div class="metric-grid">
              <div class="metric">
                <div class="metric-label">${icons.clock}<span>حالة الجدولة</span></div>
                <div class="metric-value">
                  <span class="status-chip ${statusTone}">
                    ${schedule.enabled ? (schedulerIsActive() ? "نشطة" : "تحتاج إعادة ربط") : "متوقفة"}
                  </span>
                </div>
                <div class="metric-note">${
                  schedule.enabled
                    ? escapeHtml(schedulerSnapshot.expression || `*/${schedule.intervalMinutes} * * * *`)
                    : "تم إيقاف النشر التلقائي من الداشبورد"
                }</div>
              </div>
              <div class="metric">
                <div class="metric-label">${icons.clock}<span>وقت النشر</span></div>
                <div class="metric-value">كل ${escapeHtml(schedule.intervalMinutes)} دقيقة</div>
                <div class="metric-note">المنطقة الزمنية: ${escapeHtml(config.timezone)}</div>
              </div>
              <div class="metric">
                <div class="metric-label">${icons.page}<span>الصفحة المستهدفة</span></div>
                <div class="metric-value">${escapeHtml(connectedConfiguredPage || (isDirectMode ? "جاهزة عبر التوكن المباشر" : "غير مربوطة بعد"))}</div>
                <div class="metric-note">FB_PAGE_ID: ${escapeHtml(config.facebookPageId || "غير مضبوط")} | ${isDirectMode ? "Direct Token" : "OAuth"}</div>
              </div>
              <div class="metric">
                <div class="metric-label">${icons.spark}<span>الذكاء الاصطناعي</span></div>
                <div class="metric-value">${escapeHtml(getActiveAiModel())}</div>
                <div class="metric-note">المزوّد: ${escapeHtml(config.aiProvider)}</div>
              </div>
            </div>
          </article>

          <article class="card span-5">
            <h2 class="card-title">${icons.shield}<span>الدخول والحماية</span></h2>
            <p class="muted">الدخول إلى هذه اللوحة محمي بكود ثابت، والعمليات الحساسة مثل النشر اليدوي وتعديل الوقت لا تعمل إلا بعد فتح الداشبورد.</p>
            <div class="metric-grid">
              <div class="metric">
                <div class="metric-label">${icons.link}<span>الرابط الحالي</span></div>
                <div class="metric-value">${escapeHtml(currentHost)}</div>
                <div class="metric-note">${isDirectMode ? "البوت سيعمل مباشرة عند التشغيل" : `Callback: ${escapeHtml(`${config.baseUrl}/auth/facebook/callback`)}`}</div>
              </div>
              <div class="metric">
                <div class="metric-label">${icons.page}<span>هوية الصفحة</span></div>
                <div class="metric-value">${escapeHtml(config.facebookPageId || "غير مضبوط")}</div>
                <div class="metric-note">لن يقبل التطبيق أي صفحة مختلفة عن هذا المعرّف</div>
              </div>
            </div>
          </article>

          <article class="card span-4">
            <h2 class="card-title">${icons.clock}<span>التحكم في الوقت</span></h2>
            <form method="post" action="/settings/schedule">
              <div class="form-grid">
                <div>
                  <label for="intervalMinutes">الفاصل بين المنشورات بالدقائق</label>
                  <input id="intervalMinutes" name="intervalMinutes" type="number" min="1" max="1440" value="${escapeHtml(schedule.intervalMinutes)}" required />
                </div>
              </div>
              <div class="toggle" style="margin-top:16px;">
                <input id="scheduleEnabled" name="scheduleEnabled" type="checkbox" ${schedule.enabled ? "checked" : ""} />
                <label for="scheduleEnabled" style="margin:0;">تشغيل النشر التلقائي على حسب هذا الوقت</label>
              </div>
              <div class="inline-actions">
                <button class="btn btn-primary" type="submit">${icons.clock}<span>حفظ الوقت</span></button>
              </div>
            </form>
          </article>

          <article class="card span-4">
            <h2 class="card-title">${icons.link}<span>${isDirectMode ? "الوضع المباشر" : "ربط الصفحة"}</span></h2>
            <p class="muted">${
              isDirectMode
                ? "بوجود FB_PAGE_ACCESS_TOKEN لن تحتاج إلى ربط Facebook من الداشبورد. يكفي تشغيل البوت وسيستخدم التوكن المباشر للنشر على صفحتك."
                : "بعد الضغط على الربط، سيقبل التطبيق فقط الصفحة التي يطابق معرفها قيمة FB_PAGE_ID داخل إعدادات Railway."
            }</p>
            ${
              isDirectMode
                ? `<p class="muted">التوكن المباشر مفعل الآن، وآخر ربط محفوظ: ${escapeHtml(state.facebook.lastAuthAt || "غير مطلوب في هذا الوضع")}</p>`
                : `<div class="inline-actions"><a class="btn btn-secondary" href="/auth/facebook/start">${icons.link}<span>إعادة ربط Facebook</span></a></div><p class="muted">آخر ربط: ${escapeHtml(state.facebook.lastAuthAt || "لم يتم بعد")}</p>`
            }
          </article>

          <article class="card span-4">
            <h2 class="card-title">${icons.play}<span>تشغيل سريع</span></h2>
            <p class="muted">يمكنك اختبار النشر فورًا للتأكد من أن الربط وGemini يعملان بشكل صحيح قبل انتظار الدورة التالية.</p>
            <div class="inline-actions">
              <a class="btn btn-secondary" href="/run-once">${icons.play}<span>نشر الآن</span></a>
            </div>
            <p class="muted">آخر نتيجة: ${escapeHtml(state.scheduler.lastResult || "لا توجد بعد")}</p>
            <p class="muted">آخر خطأ: ${escapeHtml(state.scheduler.lastError || "لا يوجد")}</p>
          </article>

          <article class="card span-8">
            <h2 class="card-title">${icons.spark}<span>آخر المنشورات المولدة</span></h2>
            ${
              recentPosts.length
                ? `<div class="list">${recentPosts
                    .map(
                      (post) => `
                        <article class="post-item">
                          <div class="post-meta">تم الإنشاء: ${escapeHtml(post.createdAt || "-")} | معرف المنشور: ${escapeHtml(post.id || "-")}</div>
                          <pre class="post-body">${escapeHtml(post.message || "")}</pre>
                        </article>
                      `
                    )
                    .join("")}</div>`
                : `<p class="muted">لا توجد منشورات محفوظة بعد. بعد أول عملية نشر ستظهر هنا المسودات التي تم إنشاؤها وإرسالها.</p>`
            }
          </article>

          <article class="card span-4">
            <h2 class="card-title">${icons.status}<span>آخر نشاط</span></h2>
            <div class="metric-grid">
              <div class="metric">
                <div class="metric-label">${icons.clock}<span>آخر تشغيل</span></div>
                <div class="metric-value">${escapeHtml(state.scheduler.lastRunAt || "لم يتم بعد")}</div>
              </div>
              <div class="metric">
                <div class="metric-label">${icons.status}<span>الرابط العام</span></div>
                <div class="metric-value">${escapeHtml(config.baseUrl)}</div>
                <div class="metric-note">مناسب لـ Railway وMeta Callback</div>
              </div>
            </div>
          </article>
        </section>
      </main>
    `
  });
}

syncScheduler();

app.get("/login", (req, res) => {
  if (isDashboardAuthenticated(req)) {
    redirectWithMessage(res, "/", {
      notice: "الداشبورد مفتوح بالفعل."
    });
    return;
  }

  res.type("html").send(
    renderLoginPage({
      notice: String(req.query.notice || ""),
      error: String(req.query.error || "")
    })
  );
});

app.post("/login", (req, res) => {
  const accessCode = String(req.body.accessCode || "").trim();

  if (accessCode !== config.dashboardAccessCode) {
    redirectWithMessage(res, "/login", {
      error: "الكود غير صحيح."
    });
    return;
  }

  setDashboardSession(res);
  redirectWithMessage(res, "/", {
    notice: "تم فتح الداشبورد بنجاح."
  });
});

app.post("/logout", ensureDashboardAuth, (req, res) => {
  clearDashboardSession(res);
  redirectWithMessage(res, "/login", {
    notice: "تم تسجيل الخروج من الداشبورد."
  });
});

app.get("/", ensureDashboardAuth, (req, res) => {
  res.type("html").send(
    renderDashboard({
      req,
      state: readState(),
      notice: String(req.query.notice || ""),
      error: String(req.query.error || "")
    })
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime()
  });
});

app.get("/status", ensureDashboardAuth, (req, res) => {
  const state = readState();
  const schedule = getScheduleSettings(state);
  const missing = getMissingCoreConfig();
  const pageConnection = getResolvedPageConnection(state);

  res.json({
    ok: true,
    baseUrl: config.baseUrl,
    stateDir: config.stateDir,
    aiProvider: config.aiProvider,
    aiModel: getActiveAiModel(),
    configuredPageId: config.facebookPageId,
    directPageTokenConfigured: hasDirectPageAccessToken(),
    schedule,
    scheduler: getSchedulerSnapshot(),
    connectedPage: pageConnection.pageAccessToken
      ? {
          id: config.facebookPageId,
          name: pageConnection.pageName,
          mode: pageConnection.mode
        }
      : null,
    missingEnv: missing,
    lastRunAt: state.scheduler.lastRunAt,
    lastResult: state.scheduler.lastResult,
    lastError: state.scheduler.lastError,
    recentPosts: state.posts.slice(-5)
  });
});

app.post("/settings/schedule", ensureDashboardAuth, (req, res) => {
  const intervalMinutes = Number.parseInt(String(req.body.intervalMinutes || ""), 10);
  const enabled = req.body.scheduleEnabled === "on";

  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    redirectWithMessage(res, "/", {
      error: "وقت النشر يجب أن يكون رقمًا بين 1 و 1440 دقيقة."
    });
    return;
  }

  updateState((current) => {
    current.scheduler.intervalMinutes = intervalMinutes;
    current.scheduler.enabled = enabled;
    return current;
  });

  syncScheduler();

  redirectWithMessage(res, "/", {
    notice: enabled
      ? `تم حفظ وقت النشر على كل ${intervalMinutes} دقيقة.`
      : "تم إيقاف النشر التلقائي من الداشبورد."
  });
});

app.get("/auth/facebook/start", ensureDashboardAuth, (req, res) => {
  if (hasDirectPageAccessToken()) {
    redirectWithMessage(res, "/", {
      notice: "الوضع المباشر مفعل بالفعل عبر FB_PAGE_ACCESS_TOKEN."
    });
    return;
  }

  const missing = getMissingCoreConfig();
  if (missing.length) {
    res.status(400).send(`Missing env values: ${missing.join(", ")}`);
    return;
  }

  res.redirect(getFacebookLoginUrl(config.baseUrl));
});

app.get("/auth/facebook/callback", ensureDashboardAuth, async (req, res) => {
  if (hasDirectPageAccessToken()) {
    redirectWithMessage(res, "/", {
      notice: "تم تجاوز Facebook Login لأن FB_PAGE_ACCESS_TOKEN مفعل."
    });
    return;
  }

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

    redirectWithMessage(res, "/", {
      notice: `تم ربط صفحة ${matchingPage.name} بنجاح.`
    });
  } catch (error) {
    redirectWithMessage(res, "/", {
      error: `فشل ربط Facebook: ${error.message}`
    });
  }
});

async function maybeRunStartupPost() {
  const state = readState();
  const schedule = getScheduleSettings(state);

  if (!hasDirectPageAccessToken() || !schedule.enabled || getMissingCoreConfig().length) {
    return;
  }

  const lastRunAt = state.scheduler.lastRunAt ? new Date(state.scheduler.lastRunAt).getTime() : 0;
  const minDelayMs = schedule.intervalMinutes * 60 * 1000;

  if (lastRunAt && Number.isFinite(lastRunAt) && Date.now() - lastRunAt < minDelayMs) {
    return;
  }

  try {
    await runPostingJob();
    console.log("[startup] initial post published using direct page token");
  } catch (error) {
    updateState((current) => {
      current.scheduler.lastRunAt = new Date().toISOString();
      current.scheduler.lastError = error.message;
      return current;
    });
    console.error("[startup] failed:", error.message);
  }
}

app.get("/run-once", ensureDashboardAuth, async (req, res) => {
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
  const schedule = getScheduleSettings();
  console.log(`Server listening on port ${config.port}`);
  console.log(`Public base URL ${config.baseUrl}`);
  console.log(`Dashboard code protected on /login`);
  console.log(`Scheduler active: ${schedule.enabled ? "yes" : "no"}`);
  if (hasDirectPageAccessToken()) {
    console.log(`Direct page token mode enabled for page ${config.facebookPageId}`);
    void maybeRunStartupPost();
  }
});
