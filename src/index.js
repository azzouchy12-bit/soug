import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { config, getMissingCoreConfig } from "./config.js";
import {
  enqueueCommentLike,
  enqueueCommentReply,
  ensureDatabaseSeededFromState,
  initDatabase,
  isDatabaseConfigured,
  loadDatabaseSnapshot,
  markCommentLikeHandled,
  markCommentReplyHandled,
  moveScheduledPostToPublished,
  upsertScheduledMarketPost
} from "./database.js";
import {
  exchangeCodeForLongLivedUserToken,
  getFacebookLoginUrl,
  getManagedPages,
  getPageProfile,
  getPostComments,
  getPostDetails,
  likeComment,
  publishPagePhoto,
  replyToComment
} from "./facebook.js";
import { getSchedulerSnapshot, schedulerIsActive, startScheduler, stopScheduler } from "./scheduler.js";
import { readState, updateState } from "./storage.js";
import {
  escapeHtml,
  icons,
  renderDashboardPage,
  renderField,
  renderLoginPage,
  renderMetrics,
  renderItems,
  sectionExists
} from "./dashboard.js";
import multer from "multer";

const app = express();
const DASHBOARD_COOKIE = "dashboard_session";
let commentMonitorTimer = null;
let commentMonitorRunning = false;
const upload = multer({ dest: config.uploadsDir });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", true);
app.use("/uploads", express.static(config.uploadsDir));

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
  const seed = config.facebookAppSecret || config.facebookPageAccessToken || config.baseUrl;
  return crypto.createHash("sha256").update(`${config.dashboardAccessCode}:${seed}`).digest("hex");
}

function isDashboardAuthenticated(req) {
  return parseCookies(req)[DASHBOARD_COOKIE] === getDashboardSessionToken();
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
  const rawPath = String(pathname || "").trim();
  let safePath = rawPath || "/dashboard/overview";

  if (safePath.startsWith("http://") || safePath.startsWith("https://")) {
    try {
      const parsed = new URL(safePath);
      safePath = `${parsed.pathname}${parsed.search}`;
    } catch {
      safePath = "/dashboard/overview";
    }
  } else if (!safePath.startsWith("/")) {
    safePath = `/${safePath.replace(/^\/+/, "")}`;
  }

  let target;
  try {
    target = new URL(safePath, config.baseUrl || "http://localhost:3000");
  } catch {
    target = new URL(safePath, "http://localhost:3000");
  }

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

  if ((req.headers.accept || "").includes("application/json") || req.path === "/status") {
    res.status(401).json({ ok: false, error: "Dashboard authentication required." });
    return;
  }

  res.type("html").send(renderLoginPage({ error: "أدخل الكود أولاً للوصول إلى الداشبورد." }));
}

function getScheduleSettings(state = readState()) {
  return {
    enabled: state.scheduler.enabled !== false,
    intervalMinutes: Math.max(1, Number(state.scheduler.intervalMinutes || config.publishIntervalMinutes || 480))
  };
}

function getBotState(state = readState()) {
  return {
    active: state.bot?.active === true,
    startedAt: state.bot?.startedAt || ""
  };
}

function getMarketState(state = readState()) {
  return state.market || {
    imageFilename: "",
    imageOriginalName: "",
    imageMimeType: "",
    nextNumber: 1,
    activePostId: "",
    activeNumber: 0,
    activeCommentCount: 0,
    repliedComments: {},
    repliedAuthors: {},
    lastPublishedAt: "",
    lastPublishedPostId: "",
    lastPublishedNumber: 0
  };
}

function getMarketImagePath(state = readState()) {
  const market = getMarketState(state);
  if (!market.imageFilename) {
    return "";
  }

  return path.join(config.uploadsDir, market.imageFilename);
}

function getMarketImageUrl(state = readState()) {
  const market = getMarketState(state);
  return market.imageFilename ? `/uploads/${encodeURIComponent(market.imageFilename)}` : "";
}

function getLatestKnownMarketPost(state = readState()) {
  const market = getMarketState(state);
  const latestPost = Array.isArray(state.posts) && state.posts.length ? state.posts[state.posts.length - 1] : null;
  const inferredNumber = latestPost?.marketNumber || extractMarketNumberFromMessage(latestPost?.message || "");

  return {
    postId: market.activePostId || market.lastPublishedPostId || latestPost?.id || "",
    marketNumber: Number(market.activeNumber || market.lastPublishedNumber || inferredNumber || 0)
  };
}

function getNextMarketCaption(state = readState()) {
  return `السوق رقم ${getMarketState(state).nextNumber || 1}`;
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
          : "صفحتي على فيسبوك",
      mode: "direct"
    };
  }

  const hasMatchingPageToken = state.facebook.pageId === config.facebookPageId;

  return {
    pageId: config.facebookPageId,
    pageAccessToken: hasMatchingPageToken ? state.facebook.pageAccessToken : "",
    pageName: hasMatchingPageToken ? state.facebook.pageName || "صفحتي على فيسبوك" : "صفحتي على فيسبوك",
    mode: "oauth"
  };
}

function normalizeErrorMessage(error) {
  const raw = String(error?.message || error || "").trim();
  return raw || "حدث خطأ غير معروف.";
}

function formatIntervalLabel(intervalMinutes) {
  const minutes = Math.max(1, Number(intervalMinutes || 1));
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "كل ساعة" : `كل ${hours} ساعات`;
  }

  return `كل ${minutes} دقيقة`;
}

async function syncScheduledMarketPostRecord(state = readState()) {
  if (!isDatabaseConfigured()) {
    return;
  }

  const market = getMarketState(state);
  if (!market.imageFilename) {
    return;
  }

  const schedule = getScheduleSettings(state);
  const nextNumber = Number(market.nextNumber || 1);
  const nextRunAt = getNextRunTimestamp(state) || new Date(Date.now() + schedule.intervalMinutes * 60 * 1000).toISOString();

  await upsertScheduledMarketPost({
    id: nextNumber,
    message: `السوق رقم ${nextNumber}`,
    createdAt: new Date().toISOString(),
    scheduledFor: nextRunAt,
    imageFilename: market.imageFilename,
    marketNumber: nextNumber
  });
}

function computeNextRunText(state = readState()) {
  const schedule = getScheduleSettings(state);
  const bot = getBotState(state);
  const market = getMarketState(state);

  if (!bot.active) {
    return "البوت متوقف";
  }

  if (!schedule.enabled) {
    return "الجدولة متوقفة من الإعدادات";
  }

  if (!market.imageFilename) {
    return "ارفع صورة البوت أولًا";
  }

  if (!state.scheduler.lastRunAt) {
    return "فور تشغيل البوت";
  }

  const next = new Date(new Date(state.scheduler.lastRunAt).getTime() + schedule.intervalMinutes * 60 * 1000);
  return next.toLocaleString("ar-MA", { dateStyle: "short", timeStyle: "short" });
}

function getNextRunTimestamp(state = readState()) {
  const schedule = getScheduleSettings(state);
  const bot = getBotState(state);
  const market = getMarketState(state);

  if (!bot.active || !schedule.enabled) {
    return "";
  }

  if (!market.imageFilename) {
    return "";
  }

  if (!state.scheduler.lastRunAt) {
    return new Date().toISOString();
  }

  const reference = state.scheduler.lastRunAt;
  if (!reference) {
    return "";
  }

  const referenceMs = Date.parse(reference);
  if (!Number.isFinite(referenceMs)) {
    return "";
  }

  const intervalMs = schedule.intervalMinutes * 60 * 1000;
  let nextMs = referenceMs + intervalMs;

  while (nextMs <= Date.now()) {
    nextMs += intervalMs;
  }

  return new Date(nextMs).toISOString();
}

function getMsUntilNextRun(state = readState()) {
  const nextRunAt = getNextRunTimestamp(state);
  if (!nextRunAt) {
    return 0;
  }

  const nextRunMs = Date.parse(nextRunAt);
  if (!Number.isFinite(nextRunMs)) {
    return 0;
  }

  return Math.max(0, nextRunMs - Date.now());
}

function buildHeaderHtml(state) {
  const bot = getBotState(state);
  const nextRunAt = getNextRunTimestamp(state);

  return `
    <div class="header-counters">
      <div class="counter-pill">
        <strong id="botRuntimeCounter">00:00:00</strong>
        <span>مدة تشغيل البوت</span>
      </div>
      <div class="counter-pill">
        <strong id="nextPostCountdown">--:--:--</strong>
        <span>الوقت المتبقي لنشر المنشور التالي</span>
      </div>
      <div class="counter-pill">
        <strong id="deviceClockCounter">--/--/---- 00:00:00</strong>
        <span>الساعة والتاريخ على جهازك</span>
      </div>
    </div>
    <script>
      (() => {
        const runtimeNode = document.getElementById("botRuntimeCounter");
        const nextPostNode = document.getElementById("nextPostCountdown");
        const deviceClockNode = document.getElementById("deviceClockCounter");
        const botActive = ${bot.active ? "true" : "false"};
        const startedAt = ${JSON.stringify(bot.startedAt || "")};
        const nextRunAt = ${JSON.stringify(nextRunAt || "")};
        const reloadKey = "dashboard-auto-refresh-next-run";

        if (!runtimeNode || !nextPostNode || !deviceClockNode) {
          return;
        }

        const formatDuration = (totalSeconds) => {
          const safe = Math.max(0, totalSeconds);
          const hours = String(Math.floor(safe / 3600)).padStart(2, "0");
          const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
          const seconds = String(safe % 60).padStart(2, "0");
          return hours + ":" + minutes + ":" + seconds;
        };

        const formatDeviceTime = (date) =>
          new Intl.DateTimeFormat("ar-MA", {
            dateStyle: "short",
            timeStyle: "medium"
          }).format(date);

        const tick = () => {
          const nowDate = new Date();
          const now = nowDate.getTime();
          const startedMs = startedAt ? Date.parse(startedAt) : NaN;
          const nextRunMs = nextRunAt ? Date.parse(nextRunAt) : NaN;

          deviceClockNode.textContent = formatDeviceTime(nowDate);

          if (botActive && Number.isFinite(startedMs)) {
            runtimeNode.textContent = formatDuration(Math.floor((now - startedMs) / 1000));
          } else {
            runtimeNode.textContent = "00:00:00";
          }

          if (botActive && Number.isFinite(nextRunMs)) {
            const remaining = Math.ceil((nextRunMs - now) / 1000);
            nextPostNode.textContent = remaining > 0 ? formatDuration(remaining) : "00:00:00";

            if (remaining <= 0) {
              const lastReloadedSlot = window.sessionStorage.getItem(reloadKey);
              if (lastReloadedSlot !== nextRunAt) {
                window.sessionStorage.setItem(reloadKey, nextRunAt);
                window.setTimeout(() => {
                  window.location.reload();
                }, 1200);
              }
            }
          } else {
            nextPostNode.textContent = "--:--:--";
          }
        };

        tick();
        window.setInterval(tick, 1000);
      })();
    </script>
  `;
}

function buildTopActions(sectionKey, state) {
  const bot = getBotState(state);
  const returnTo = `/dashboard/${sectionKey}`;

  return `
    <form id="botToggleForm" method="post" action="/dashboard/bot-toggle?returnTo=${encodeURIComponent(returnTo)}">
      <button class="btn btn-ghost" type="submit">
        ${icons.run}
        <span>${bot.active ? "إغلاق البوت" : "تشغيل البوت"}</span>
      </button>
    </form>
    <a class="btn btn-ghost" href="/status">${icons.status}<span>JSON</span></a>
    <script>
      (() => {
        const form = document.getElementById("botToggleForm");
        if (!form) {
          return;
        }

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const button = form.querySelector("button");
          if (button) {
            button.disabled = true;
          }

          try {
            const response = await fetch(form.action, {
              method: "POST",
              headers: {
                Accept: "application/json"
              }
            });

            const payload = await response.json();

            if (!response.ok || !payload.ok) {
              window.alert(payload.error || "تعذر تحديث حالة البوت.");
              if (button) {
                button.disabled = false;
              }
              return;
            }

            window.location.reload();
          } catch (error) {
            window.alert("تعذر الاتصال بالخادم. حاول مرة أخرى.");
            if (button) {
              button.disabled = false;
            }
          }
        });
      })();
    </script>
  `;
}

async function refreshDirectPageProfile() {
  if (!hasDirectPageAccessToken() || !config.facebookPageId) {
    return;
  }

  try {
    const profile = await getPageProfile({
      pageId: config.facebookPageId,
      pageAccessToken: config.facebookPageAccessToken
    });

    updateState((current) => {
      current.facebook.pageId = profile.id || config.facebookPageId;
      current.facebook.pageName = profile.name || current.facebook.pageName;
      return current;
    });
  } catch {}
}

function buildCommentReplyText(marketNumber, commentNumber) {
  return `شكرا ربي يجيب السوق ${marketNumber}.${commentNumber}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms || 0)));
  });
}

function isIgnorableLikeError(error) {
  const message = normalizeErrorMessage(error).toLowerCase();
  return message.includes("already") || message.includes("liked") || message.includes("duplicate");
}

async function replyAndLikeComment({ commentId, pageAccessToken, replyText }) {
  let replyError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await replyToComment({
        commentId,
        pageAccessToken,
        message: replyText
      });
      replyError = null;
      break;
    } catch (error) {
      replyError = error;
      if (attempt < 2) {
        await delay(4000 * attempt);
      }
    }
  }

  if (replyError) {
    throw replyError;
  }

  await delay(config.commentActionGapMs);

  try {
    await likeComment({
      commentId,
      pageAccessToken
    });
  } catch (error) {
    if (!isIgnorableLikeError(error)) {
      throw error;
    }
  }
}

function extractMarketNumberFromMessage(message) {
  const match = String(message || "").match(/السوق رقم\s+(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function stopCommentMonitor() {
  if (commentMonitorTimer) {
    clearInterval(commentMonitorTimer);
    commentMonitorTimer = null;
  }

  commentMonitorRunning = false;
}

async function checkLatestPostComments() {
  let state = readState();
  const bot = getBotState(state);
  const connection = getResolvedPageConnection(state);
  let market = getMarketState(state);

  if (!market.activePostId) {
    const latestKnown = getLatestKnownMarketPost(state);
    if (latestKnown.postId) {
      state = updateState((current) => {
        current.market.activePostId = latestKnown.postId;
        current.market.activeNumber = latestKnown.marketNumber || current.market.activeNumber || 0;
        current.market.lastPublishedPostId = current.market.lastPublishedPostId || latestKnown.postId;
        current.market.lastPublishedNumber =
          current.market.lastPublishedNumber || latestKnown.marketNumber || current.market.lastPublishedNumber;
        return current;
      });
      market = getMarketState(state);
    }
  }

  if (!bot.active || !market.activePostId || !connection.pageAccessToken) {
    return;
  }

  const comments = await getPostComments({
    postId: market.activePostId,
    pageAccessToken: connection.pageAccessToken,
    limit: 50
  });

  const sortedComments = [...comments].sort(
    (left, right) => Date.parse(left.created_time || 0) - Date.parse(right.created_time || 0)
  );

  for (const comment of sortedComments) {
    const commentId = String(comment.id || "");
    if (!commentId) {
      continue;
    }

    const currentState = readState();
    const currentMarket = getMarketState(currentState);
    if (currentMarket.activePostId !== market.activePostId) {
      return;
    }

    if (currentMarket.repliedComments?.[commentId]) {
      continue;
    }

    if (comment.from?.id && comment.from.id === connection.pageId) {
      continue;
    }

    const authorKey = String(comment.from?.id || comment.from?.name || `anon:${commentId}`);
    const hasRepliedToAuthorBefore = Number(currentMarket.repliedAuthors?.[authorKey] || 0) > 0;

    if (hasRepliedToAuthorBefore) {
      await delay(config.repeatCommentReplyDelayMs);
    }

    const nextCommentNumber = Number(currentMarket.activeCommentCount || 0) + 1;
    const replyText = buildCommentReplyText(currentMarket.activeNumber, nextCommentNumber);

    await enqueueCommentReply({
      commentId,
      postId: market.activePostId,
      authorId: comment.from?.id || "",
      authorName: comment.from?.name || "",
      commentMessage: comment.message || "",
      replyMessage: replyText,
      marketNumber: currentMarket.activeNumber,
      commentNumber: nextCommentNumber
    });

    await enqueueCommentLike({
      commentId,
      postId: market.activePostId,
      authorId: comment.from?.id || "",
      authorName: comment.from?.name || "",
      commentMessage: comment.message || ""
    });

    await replyAndLikeComment({
      commentId,
      pageAccessToken: connection.pageAccessToken,
      replyText
    });

    await markCommentReplyHandled(commentId);
    await markCommentLikeHandled(commentId);

    updateState((current) => {
      current.market.activeCommentCount = nextCommentNumber;
      current.market.repliedComments = {
        ...(current.market.repliedComments || {}),
        [commentId]: replyText
      };
      current.market.repliedAuthors = {
        ...(current.market.repliedAuthors || {}),
        [authorKey]: Number(current.market.repliedAuthors?.[authorKey] || 0) + 1
      };
      current.scheduler.lastResult = `تم الرد على تعليق جديد في السوق ${current.market.activeNumber}.${nextCommentNumber}`;
      current.scheduler.lastError = "";
      return current;
    });

    return;
  }
}

function startCommentMonitor() {
  stopCommentMonitor();
  void checkLatestPostComments().catch((error) => {
    updateState((current) => {
      current.scheduler.lastError = normalizeErrorMessage(error);
      return current;
    });
    console.error("[comments] failed:", normalizeErrorMessage(error));
  });
  commentMonitorTimer = setInterval(async () => {
    if (commentMonitorRunning) {
      return;
    }

    commentMonitorRunning = true;
    try {
      await checkLatestPostComments();
    } catch (error) {
      const message = normalizeErrorMessage(error);
      updateState((current) => {
        current.scheduler.lastError = message;
        return current;
      });
      console.error("[comments] failed:", message);
    } finally {
      commentMonitorRunning = false;
    }
  }, config.commentCheckIntervalMs);
}

async function runPostingJob() {
  let state = readState();
  if (isDatabaseConfigured()) {
    const snapshot = await loadDatabaseSnapshot();
    if (snapshot) {
      state = updateState((current) => {
        current.queuedPosts = snapshot.queuedPosts;
        current.posts = snapshot.posts;
        current.queueCounter = Math.max(current.queueCounter, snapshot.queueCounter);
        return current;
      });
    }
  }

  const connection = getResolvedPageConnection(state);
  const market = getMarketState(state);
  const imagePath = getMarketImagePath(state);
  const marketNumber = Number(market.nextNumber || 1);
  const caption = `السوق رقم ${marketNumber}`;

  if (!connection.pageId || !connection.pageAccessToken) {
    throw new Error("الصفحة غير جاهزة بعد. أضف FB_PAGE_ACCESS_TOKEN الصحيح.");
  }

  if (!market.imageFilename || !imagePath || !fs.existsSync(imagePath)) {
    throw new Error("ارفع صورة البوت من الداشبورد أولًا.");
  }

  const publishResult = await publishPagePhoto({
    pageId: connection.pageId,
    pageAccessToken: connection.pageAccessToken,
    imagePath,
    imageMimeType: market.imageMimeType || "image/jpeg",
    imageFilename: market.imageOriginalName || market.imageFilename,
    caption
  });

  const publishedAt = new Date().toISOString();
  const postId = publishResult.post_id || publishResult.id;

  await moveScheduledPostToPublished({
    queueId: marketNumber,
    facebookPostId: postId,
    message: caption,
    createdAt: publishedAt,
    imageFilename: market.imageFilename,
    marketNumber
  });

  updateState((current) => {
    current.posts.push({
      id: postId,
      message: caption,
      createdAt: publishedAt,
      queueId: null,
      marketNumber
    });
    current.posts = current.posts.slice(-40);
    current.market.lastPublishedAt = publishedAt;
    current.market.lastPublishedPostId = postId;
    current.market.lastPublishedNumber = marketNumber;
    current.market.activePostId = postId;
    current.market.activeNumber = marketNumber;
    current.market.activeCommentCount = 0;
    current.market.repliedComments = {};
    current.market.repliedAuthors = {};
    current.market.nextNumber = marketNumber + 1;
    current.scheduler.lastRunAt = new Date().toISOString();
    current.scheduler.lastResult = `تم نشر ${caption} بنجاح`;
    current.scheduler.lastError = "";
    return current;
  });
  void syncScheduledMarketPostRecord(readState());
  startCommentMonitor();

  return {
    postId,
    message: caption
  };
}

function syncScheduler() {
  const state = readState();
  const schedule = getScheduleSettings(state);
  const bot = getBotState(state);

  if (!schedule.enabled || !bot.active) {
    stopScheduler();
    stopCommentMonitor();
    return getSchedulerSnapshot();
  }

  startCommentMonitor();

  startScheduler(async () => {
    try {
      const currentState = readState();
      if (!getMarketState(currentState).imageFilename) {
        throw new Error("ارفع صورة البوت من الداشبورد أولًا.");
      }
      await runPostingJob();
    } catch (error) {
      updateState((current) => {
        current.scheduler.lastRunAt = new Date().toISOString();
        current.scheduler.lastError = normalizeErrorMessage(error);
        return current;
      });
      console.error("[scheduler] failed:", normalizeErrorMessage(error));
    }
  }, {
    intervalMinutes: schedule.intervalMinutes,
    timezone: config.timezone,
    initialDelayMs: getMsUntilNextRun(state) || schedule.intervalMinutes * 60 * 1000
  });

  return getSchedulerSnapshot();
}

function renderQueuedPostsEditor(state) {
  const market = getMarketState(state);
  const imageUrl = getMarketImageUrl(state);
  const hasImage = Boolean(imageUrl);
  const schedule = getScheduleSettings(state);

  return `
    <section class="section">
      <h2>${icons.edit}<span>رفع صورة البوت</span></h2>
      <form method="post" action="/dashboard/content/image" enctype="multipart/form-data">
        ${renderField({
          label: `اختر صورة واحدة فقط. سيعيد البوت نشرها ${formatIntervalLabel(schedule.intervalMinutes)} بعنوان السوق التالي.`,
          name: "marketImage",
          type: "file",
          value: ""
        })}
        <div class="actions">
          <button class="btn btn-primary" type="submit">رفع الصورة</button>
        </div>
      </form>
    </section>
    <section class="section">
      <h2>${icons.overview}<span>إعداد البوت الحالي</span></h2>
      ${renderMetrics([
        { label: "الصورة الحالية", value: hasImage ? "مرفوعة" : "غير مرفوعة", icon: icons.page },
        { label: "المنشور القادم", value: `السوق رقم ${market.nextNumber || 1}`, icon: icons.spark },
        { label: "آخر منشور", value: market.lastPublishedNumber ? `السوق رقم ${market.lastPublishedNumber}` : "لم ينشر بعد", icon: icons.posts },
        { label: "فحص التعليقات", value: "كل 15 ثانية", icon: icons.clock }
      ])}
      ${hasImage
        ? `<div class="stack">
            <article class="item">
              <div class="item-meta">الصورة الحالية: ${escapeHtml(market.imageOriginalName || market.imageFilename)}</div>
              <img src="${escapeHtml(imageUrl)}" alt="صورة البوت" style="width:100%;max-width:360px;border-radius:20px;border:1px solid rgba(20,54,45,.12)" />
            </article>
          </div>`
        : `<div class="empty">ارفع صورة من الأعلى ليبدأ البوت إعادة نشرها ${formatIntervalLabel(schedule.intervalMinutes)}.</div>`
      }
    </section>
    <section class="section">
      <h2>${icons.spark}<span>الردود التلقائية</span></h2>
      <div class="empty">
        يراقب البوت آخر منشور نشره فقط كل 15 ثانية، ويعالج تعليقًا واحدًا في كل دورة.
        <br />
        شكرا ربي يجيب السوق X.Y
      </div>
    </section>
  `;
}

async function buildOverviewBody(state) {
  const schedule = getScheduleSettings(state);
  const connection = getResolvedPageConnection(state);
  const bot = getBotState(state);
  const market = getMarketState(state);

  return `
    <section class="section">
      <h2>${icons.overview}<span>النظرة العامة</span></h2>
      ${renderMetrics([
        {
          label: "حالة البوت",
          value: bot.active && schedule.enabled && schedulerIsActive() ? "يعمل" : "متوقف",
          level: bot.active && schedule.enabled && schedulerIsActive() ? "good" : "warn",
          icon: icons.clock
        },
        {
          label: "الصورة الحالية",
          value: market.imageFilename ? "جاهزة" : "غير مرفوعة",
          note: market.imageOriginalName || "ارفع صورة من إدارة المنشورات",
          icon: icons.posts
        },
        {
          label: "عدد المنشورات المنشورة",
          value: String(state.posts.length),
          note: state.scheduler.lastResult || "لا توجد نتيجة حديثة",
          icon: icons.status
        },
        {
          label: "السوق القادم",
          value: `السوق رقم ${market.nextNumber || 1}`,
          note: market.lastPublishedNumber ? `آخر منشور كان السوق رقم ${market.lastPublishedNumber}` : "لم ينشر شيء بعد",
          icon: icons.spark
        },
        {
          label: "الصفحة",
          value: connection.pageName,
          note: `FB_PAGE_ID: ${config.facebookPageId}`,
          icon: icons.page
        },
        {
          label: "وقت النشر",
          value: formatIntervalLabel(schedule.intervalMinutes),
          note: computeNextRunText(state),
          icon: icons.clock
        },
        {
          label: "فحص التعليقات",
          value: "كل 15 ثانية",
          note: market.activePostId
            ? `يتابع الآن السوق رقم ${market.activeNumber} مع تأخير 30 ثانية للتعليقات المتكررة من نفس الشخص`
            : "سينتظر أول منشور",
          icon: icons.people
        }
      ])}
    </section>
    <section class="section">
      <h2>${icons.status}<span>آخر تحديثات البوت</span></h2>
      ${renderItems(
        [
          { meta: `آخر تشغيل: ${escapeHtml(state.scheduler.lastRunAt || "لم يتم بعد")}`, text: state.scheduler.lastResult || "لا توجد نتيجة محفوظة بعد." },
          { meta: "آخر خطأ", text: state.scheduler.lastError || "لا يوجد أي خطأ حاليًا." }
        ],
        "لا توجد تحديثات."
      )}
    </section>
  `;
}

function buildTimingBody(state) {
  const schedule = getScheduleSettings(state);
  return `
    <section class="section">
      <h2>${icons.clock}<span>توقيت البوت</span></h2>
      <form method="post" action="/dashboard/timing">
        <div class="stack">
          ${renderField({
            label: "الفاصل بين المنشورات بالدقائق",
            name: "intervalMinutes",
            type: "number",
            min: "1",
            max: "10080",
            value: schedule.intervalMinutes
          })}
          ${renderField({
            label: "تشغيل النشر التلقائي",
            name: "scheduleEnabled",
            type: "checkbox",
            checked: schedule.enabled
          })}
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="submit">حفظ الوقت</button>
        </div>
      </form>
    </section>
    <section class="section">
      <h2>${icons.clock}<span>ملخص الوقت</span></h2>
      ${renderMetrics([
        { label: "الحالة الحالية", value: schedule.enabled ? "مفعلة" : "متوقفة", level: schedule.enabled ? "good" : "warn", icon: icons.status },
        { label: "فاصل النشر", value: formatIntervalLabel(schedule.intervalMinutes), icon: icons.clock },
        { label: "فحص التعليقات", value: "كل 15 ثانية", icon: icons.people },
        { label: "آخر تشغيل", value: state.scheduler.lastRunAt || "لم يتم بعد", icon: icons.status },
        { label: "الموعد القادم", value: computeNextRunText(state), icon: icons.spark }
      ])}
    </section>
  `;
}

function buildNextPostBody(state) {
  const market = getMarketState(state);
  const imageUrl = getMarketImageUrl(state);

  return `
    <section class="section">
      <h2>${icons.spark}<span>المنشور التالي</span></h2>
      ${imageUrl
        ? `<div class="stack">
            <article class="item">
              <div class="item-meta">العنوان القادم: السوق رقم ${market.nextNumber || 1}</div>
              <pre class="item-text">السوق رقم ${market.nextNumber || 1}</pre>
              <img src="${escapeHtml(imageUrl)}" alt="صورة السوق القادمة" style="width:100%;max-width:420px;border-radius:20px;border:1px solid rgba(20,54,45,.12);margin-top:16px" />
            </article>
          </div>`
        : `<div class="empty">لا توجد صورة مرفوعة بعد. ارفع صورة من صفحة إدارة المنشورات.</div>`
      }
    </section>
  `;
}

async function buildPostsBody(state) {
  const connection = getResolvedPageConnection(state);
  const posts = state.posts.slice(-15).reverse();
  const enriched = await Promise.all(
    posts.map(async (post) => {
      try {
        if (!connection.pageAccessToken) {
          throw new Error("no token");
        }

        const details = await getPostDetails({
          postId: post.id,
          pageAccessToken: connection.pageAccessToken
        });

        return {
          meta:
            `النشر: ${escapeHtml(post.createdAt || details.created_time || "-")}` +
            ` | التعليقات: ${escapeHtml(details.comments?.summary?.total_count ?? 0)}` +
            ` | التفاعلات: ${escapeHtml(details.reactions?.summary?.total_count ?? 0)}` +
            ` | الرابط: ${escapeHtml(details.permalink_url || "غير متوفر")}`,
          text: post.message
        };
      } catch {
        return {
          meta: `النشر: ${escapeHtml(post.createdAt || "-")} | المعرف: ${escapeHtml(post.id || "-")}`,
          text: post.message
        };
      }
    })
  );

  return `
    <section class="section">
      <h2>${icons.posts}<span>المنشورات التي تمت نشرها</span></h2>
      ${renderItems(enriched, "لا توجد منشورات منشورة بعد.")}
    </section>
  `;
}

async function buildAudienceBody(state) {
  const connection = getResolvedPageConnection(state);
  if (!connection.pageAccessToken) {
    return `
      <section class="section">
        <h2>${icons.people}<span>الأشخاص المتفاعلون</span></h2>
        <div class="empty">لا يوجد توكن صالح للصفحة لقراءة بيانات التفاعل الآن.</div>
      </section>
    `;
  }

  let profile = null;
  try {
    profile = await getPageProfile({
      pageId: connection.pageId,
      pageAccessToken: connection.pageAccessToken
    });
  } catch {}

  const recentPosts = state.posts.slice(-8);
  const commentGroups = recentPosts.length
    ? await Promise.all(
        recentPosts.map(async (post) => {
          try {
            return await getPostComments({
              postId: post.id,
              pageAccessToken: connection.pageAccessToken,
              limit: 15
            });
          } catch {
            return [];
          }
        })
      )
    : [];

  const audience = new Map();
  for (const comments of commentGroups) {
    for (const comment of comments) {
      const person = comment.from;
      if (!person?.id || !person?.name) {
        continue;
      }

      const current = audience.get(person.id) || {
        name: person.name,
        count: 0,
        latestAt: "",
        lastMessage: ""
      };

      current.count += 1;
      current.latestAt = comment.created_time || current.latestAt;
      current.lastMessage = comment.message || current.lastMessage;
      audience.set(person.id, current);
    }
  }

  const topPeople = [...audience.values()]
    .sort((a, b) => b.count - a.count || String(b.latestAt).localeCompare(String(a.latestAt)))
    .slice(0, 15);

  return `
    <section class="section">
      <h2>${icons.people}<span>الأشخاص المتفاعلون</span></h2>
      ${renderMetrics([
        {
          label: "إجمالي المعجبين",
          value: String(profile?.fan_count ?? 0),
          note: "إجمالي الإعجابات على الصفحة",
          icon: icons.people
        },
        {
          label: "إجمالي المتابعين",
          value: String(profile?.followers_count ?? 0),
          note: "إجمالي المتابعين الحاليين",
          icon: icons.people
        },
        { label: "إجمالي الأشخاص", value: String(topPeople.length), icon: icons.people },
        { label: "المنشورات المفحوصة", value: String(recentPosts.length), icon: icons.posts },
        { label: "مصدر البيانات", value: "تعليقات أحدث المنشورات", icon: icons.status }
      ])}
    </section>
    <section class="section">
      <h2>${icons.people}<span>أحدث المتفاعلين</span></h2>
      ${renderItems(
        topPeople.map((person) => ({
          meta: `عدد التعليقات: ${escapeHtml(person.count)} | آخر تفاعل: ${escapeHtml(person.latestAt || "-")}`,
          text: `${person.name}\n\nآخر تعليق:\n${person.lastMessage || "لا توجد رسالة مكتوبة."}`
        })),
        "لم يتم العثور على تعليقات بأسماء أشخاص حتى الآن."
      )}
    </section>
  `;
}

function buildContentBody(state) {
  return renderQueuedPostsEditor(state);
}

async function buildSectionView(sectionKey, state) {
  switch (sectionKey) {
    case "overview":
      return {
        pageTitle: "نظرة عامة",
        pageDescription: "ملخص لحالة البوت، وقت نشر صورة السوق، وآخر النتائج.",
        body: await buildOverviewBody(state)
      };
    case "timing":
      return {
        pageTitle: "التحكم في الوقت",
        pageDescription: "هذا الإصدار ينشر صورة السوق حسب الوقت الذي تحدده، ويفحص تعليقات آخر منشور بطريقة مستقرة.",
        body: buildTimingBody(state)
      };
    case "next-post":
      return {
        pageTitle: "المنشور التالي",
        pageDescription: "يعرض الصورة الحالية والنص الذي سينشره البوت في الدورة القادمة.",
        body: buildNextPostBody(state)
      };
    case "posts":
      return {
        pageTitle: "المنشورات التي تمت نشرها",
        pageDescription: "مراجعة آخر المنشورات التي نشرها البوت.",
        body: await buildPostsBody(state)
      };
    case "audience":
      return {
        pageTitle: "الأشخاص المتفاعلون",
        pageDescription: "عرض الأشخاص الذين علقوا على أحدث المنشورات المنشورة بواسطة البوت.",
        body: await buildAudienceBody(state)
      };
    case "content":
      return {
        pageTitle: "إدارة المنشورات",
        pageDescription: "ارفع صورة واحدة وسيعيد البوت نشرها حسب الوقت الذي تحدده مع ترقيم السوق تلقائيًا.",
        body: buildContentBody(state)
      };
    default:
      return null;
  }
}

async function renderSection(req, res, sectionKey) {
  const state = readState();
  const section = await buildSectionView(sectionKey, state);
  if (!section) {
    res.status(404).send("Dashboard section not found.");
    return;
  }

  res.type("html").send(
    renderDashboardPage({
      sectionKey,
      pageTitle: section.pageTitle,
      pageDescription: section.pageDescription,
      headerHtml: buildHeaderHtml(state),
      actionsHtml: buildTopActions(sectionKey, state),
      body: section.body,
      notice: String(req.query.notice || ""),
      error: String(req.query.error || "")
    })
  );
}

syncScheduler();

app.get("/", (req, res) => {
  if (isDashboardAuthenticated(req)) {
    res.redirect("/dashboard/overview");
    return;
  }

  res.type("html").send(
    renderLoginPage({
      notice: String(req.query.notice || ""),
      error: String(req.query.error || "")
    })
  );
});

app.get("/login", (req, res) => {
  if (isDashboardAuthenticated(req)) {
    res.redirect("/dashboard/overview");
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
  if (String(req.body.accessCode || "").trim() !== config.dashboardAccessCode) {
    res.type("html").send(renderLoginPage({ error: "الكود غير صحيح." }));
    return;
  }

  setDashboardSession(res);
  res.redirect("/dashboard/overview");
});

app.post("/logout", ensureDashboardAuth, (req, res) => {
  clearDashboardSession(res);
  redirectWithMessage(res, "/", { notice: "تم تسجيل الخروج بنجاح." });
});

app.get("/dashboard", ensureDashboardAuth, (req, res) => {
  res.redirect("/dashboard/overview");
});

app.get("/dashboard/:section", ensureDashboardAuth, async (req, res) => {
  const sectionKey = String(req.params.section || "");
  if (!sectionExists(sectionKey)) {
    res.status(404).send("Dashboard section not found.");
    return;
  }

  await renderSection(req, res, sectionKey);
});

app.post("/dashboard/timing", ensureDashboardAuth, (req, res) => {
  const intervalMinutes = Number.parseInt(String(req.body.intervalMinutes || ""), 10);
  const enabled = req.body.scheduleEnabled === "on";

  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) {
    redirectWithMessage(res, "/dashboard/timing", {
      error: "وقت النشر يجب أن يكون رقمًا بين 1 و 10080 دقيقة."
    });
    return;
  }

  const nextState = updateState((current) => {
    current.scheduler.intervalMinutes = intervalMinutes;
    current.scheduler.enabled = enabled;
    current.scheduler.lastError = "";
    return current;
  });

  syncScheduler();
  void syncScheduledMarketPostRecord(nextState);

  redirectWithMessage(res, "/dashboard/timing", {
    notice: enabled ? `تم حفظ وقت النشر على ${formatIntervalLabel(intervalMinutes)}.` : "تم إيقاف النشر التلقائي."
  });
});

app.post("/dashboard/bot-toggle", ensureDashboardAuth, (req, res) => {
  const wantsJson = (req.headers.accept || "").includes("application/json");
  const returnTo = sectionExists(String(req.query.returnTo || "").replace("/dashboard/", ""))
    ? String(req.query.returnTo || "/dashboard/overview")
    : "/dashboard/overview";

  try {
    const nextState = updateState((current) => {
      const isActive = current.bot?.active === true;
      current.bot.active = !isActive;
      current.bot.startedAt = !isActive ? new Date().toISOString() : "";
      current.scheduler.lastError = "";
      return current;
    });

    syncScheduler();

    if (nextState.bot.active) {
      void maybeRunStartupPost();
    }

    if (wantsJson) {
      res.json({
        ok: true,
        active: nextState.bot.active,
        notice: nextState.bot.active ? "تم تشغيل البوت في الخلفية." : "تم إغلاق البوت."
      });
      return;
    }

    redirectWithMessage(res, returnTo, {
      notice: nextState.bot.active ? "تم تشغيل البوت في الخلفية." : "تم إغلاق البوت."
    });
  } catch (error) {
    const message = normalizeErrorMessage(error);

    if (wantsJson) {
      res.status(500).json({ ok: false, error: message });
      return;
    }

    redirectWithMessage(res, returnTo, { error: message });
  }
});

app.post("/dashboard/content/image", ensureDashboardAuth, upload.single("marketImage"), async (req, res) => {
  if (!req.file) {
    redirectWithMessage(res, "/dashboard/content", {
      error: "اختر صورة أولًا قبل الرفع."
    });
    return;
  }

  try {
    const extension = path.extname(req.file.originalname || "") || ".jpg";
    const finalFilename = `market-image${extension.toLowerCase()}`;
    const finalPath = path.join(config.uploadsDir, finalFilename);

    for (const filename of fs.readdirSync(config.uploadsDir)) {
      if (filename.startsWith("market-image")) {
        try {
          fs.unlinkSync(path.join(config.uploadsDir, filename));
        } catch {}
      }
    }

    fs.renameSync(req.file.path, finalPath);

    const nextState = updateState((current) => {
      current.market.imageFilename = finalFilename;
      current.market.imageOriginalName = req.file.originalname || finalFilename;
      current.market.imageMimeType = req.file.mimetype || "image/jpeg";
      current.scheduler.lastError = "";
      return current;
    });

    syncScheduler();
    void syncScheduledMarketPostRecord(nextState);
    if (getBotState().active) {
      void maybeRunStartupPost();
    }
    redirectWithMessage(res, "/dashboard/content", {
      notice: "تم رفع صورة البوت بنجاح."
    });
  } catch (error) {
    redirectWithMessage(res, "/dashboard/content", {
      error: `تعذر رفع الصورة: ${normalizeErrorMessage(error)}`
    });
  }
});

app.get("/dashboard/next-post/generate", ensureDashboardAuth, (req, res) => {
  res.redirect("/dashboard/next-post");
});

app.post("/dashboard/next-post/generate", ensureDashboardAuth, (req, res) => {
  res.redirect("/dashboard/next-post");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/status", ensureDashboardAuth, (req, res) => {
  const state = readState();
  const connection = getResolvedPageConnection(state);
  const market = getMarketState(state);
  res.json({
    ok: true,
    baseUrl: config.baseUrl,
    databaseConfigured: isDatabaseConfigured(),
    configuredPageId: config.facebookPageId,
    directPageTokenConfigured: hasDirectPageAccessToken(),
    bot: getBotState(state),
    schedule: getScheduleSettings(state),
    scheduler: getSchedulerSnapshot(),
    nextRunAt: getNextRunTimestamp(state),
    connectedPage: connection.pageAccessToken
      ? {
          id: connection.pageId,
          name: connection.pageName,
          mode: connection.mode
        }
      : null,
    market,
    nextCaption: getNextMarketCaption(state),
    imageUrl: getMarketImageUrl(state),
    missingEnv: getMissingCoreConfig(),
    lastRunAt: state.scheduler.lastRunAt,
    lastResult: state.scheduler.lastResult,
    lastError: state.scheduler.lastError,
    posts: state.posts.slice(-10)
  });
});

app.get("/auth/facebook/start", ensureDashboardAuth, (req, res) => {
  if (hasDirectPageAccessToken()) {
    redirectWithMessage(res, "/dashboard/overview", {
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
    redirectWithMessage(res, "/dashboard/overview", {
      notice: "تم تجاوز Facebook Login لأن FB_PAGE_ACCESS_TOKEN مفعل."
    });
    return;
  }

  try {
    const code = String(req.query.code || "");
    if (!code) {
      throw new Error("Facebook did not return an authorization code.");
    }

    const userAccessToken = await exchangeCodeForLongLivedUserToken(code, config.baseUrl);
    const pages = await getManagedPages(userAccessToken);
    const matchingPage = pages.find((page) => page.id === config.facebookPageId);

    if (!matchingPage) {
      throw new Error(`The configured FB_PAGE_ID (${config.facebookPageId}) is not managed by this Facebook account.`);
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

    redirectWithMessage(res, "/dashboard/overview", {
      notice: `تم ربط صفحة ${matchingPage.name} بنجاح.`
    });
  } catch (error) {
    redirectWithMessage(res, "/dashboard/overview", {
      error: normalizeErrorMessage(error)
    });
  }
});

async function maybeRunStartupPost() {
  let state = readState();
  let schedule = getScheduleSettings(state);
  let bot = getBotState(state);
  let market = getMarketState(state);

  if (!hasDirectPageAccessToken() || !bot.active || !schedule.enabled || getMissingCoreConfig().length) {
    return;
  }

  if (!market.imageFilename) {
    return;
  }

  const lastRunAt = state.scheduler.lastRunAt ? new Date(state.scheduler.lastRunAt).getTime() : 0;
  const minDelayMs = schedule.intervalMinutes * 60 * 1000;

  if (lastRunAt && Number.isFinite(lastRunAt) && Date.now() - lastRunAt < minDelayMs) {
    startCommentMonitor();
    return;
  }

  try {
    await runPostingJob();
    console.log("[startup] initial market post published");
  } catch (error) {
    updateState((current) => {
      current.scheduler.lastRunAt = new Date().toISOString();
      current.scheduler.lastError = normalizeErrorMessage(error);
      return current;
    });
    console.error("[startup] failed:", normalizeErrorMessage(error));
  }
}

app.get("/run-once", ensureDashboardAuth, async (req, res) => {
  try {
    const result = await runPostingJob();
    res.json({ ok: true, ...result });
  } catch (error) {
    const message = normalizeErrorMessage(error);
    updateState((current) => {
      current.scheduler.lastRunAt = new Date().toISOString();
      current.scheduler.lastError = message;
      return current;
    });
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(config.port, async () => {
  console.log(`Server listening on port ${config.port}`);
  console.log(`Public base URL ${config.baseUrl}`);
  console.log("Dashboard login available on /");
  if (isDatabaseConfigured()) {
    try {
      await initDatabase();
      await ensureDatabaseSeededFromState(readState());
      const snapshot = await loadDatabaseSnapshot();

      if (snapshot) {
        updateState((current) => {
          current.queuedPosts = snapshot.queuedPosts;
          current.posts = snapshot.posts;
          current.queueCounter = Math.max(current.queueCounter, snapshot.queueCounter);
          const latestPost = snapshot.posts[snapshot.posts.length - 1];
          const inferredNumber = latestPost ? extractMarketNumberFromMessage(latestPost.message) : 0;
          if (inferredNumber && !current.market.lastPublishedNumber) {
            current.market.lastPublishedNumber = inferredNumber;
            current.market.nextNumber = Math.max(current.market.nextNumber || 1, inferredNumber + 1);
            current.market.lastPublishedPostId = latestPost.id || current.market.lastPublishedPostId;
          }
          if (latestPost && !current.market.activePostId) {
            current.market.activePostId = latestPost.id || current.market.activePostId;
            current.market.activeNumber = inferredNumber || current.market.activeNumber || 0;
          }
          return current;
        });
      }

      console.log("Postgres storage enabled");
      await syncScheduledMarketPostRecord(readState());
      syncScheduler();
    } catch (error) {
      console.error("[database] failed:", normalizeErrorMessage(error));
    }
  }
  if (hasDirectPageAccessToken()) {
    await refreshDirectPageProfile();
    console.log(`Direct page token mode enabled for page ${config.facebookPageId}`);
    void maybeRunStartupPost();
  }
});
