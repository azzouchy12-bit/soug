import crypto from "node:crypto";
import express from "express";
import { config, getMissingCoreConfig } from "./config.js";
import {
  exchangeCodeForLongLivedUserToken,
  getFacebookLoginUrl,
  getManagedPages,
  getPageProfile,
  getPostComments,
  getPostDetails,
  publishPagePost
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

const app = express();
const DASHBOARD_COOKIE = "dashboard_session";

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", true);

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
  const intervalMinutes = Math.max(
    1,
    Number.parseInt(String(state.scheduler.intervalMinutes || config.postIntervalMinutes), 10)
  );

  return {
    enabled: state.scheduler.enabled !== false,
    intervalMinutes
  };
}

function getBotState(state = readState()) {
  return {
    active: state.bot?.active === true,
    startedAt: state.bot?.startedAt || ""
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

function parseQueuedPosts(rawText) {
  const matches = [];
  const regex = /@([\s\S]*?)@/g;
  let match;

  while ((match = regex.exec(rawText)) !== null) {
    const text = match[1].trim();
    if (text) {
      matches.push(text);
    }
  }

  return matches;
}

function getQueuedPosts(state = readState()) {
  return Array.isArray(state.queuedPosts) ? state.queuedPosts : [];
}

function renderQueuedPostsList(queuedPosts) {
  if (!queuedPosts.length) {
    return `<div class="empty">لا توجد منشورات مبرمجة بعد. ألصق نصك بين @ و @ لإضافة أي عدد تريده.</div>`;
  }

  return `<div class="queue-list">
    ${queuedPosts
      .map(
        (post, index) => `
          <article class="queue-card">
            <div class="queue-head">
              <span class="queue-number">#${index + 1} <small>المعرف ${escapeHtml(post.id)}</small></span>
              <form method="post" action="/dashboard/content/delete/${encodeURIComponent(post.id)}">
                <button class="queue-delete" type="submit">x</button>
              </form>
            </div>
            <pre class="queue-text">${escapeHtml(post.text)}</pre>
          </article>
        `
      )
      .join("")}
  </div>`;
}

function getNextQueuedPost(state = readState()) {
  return getQueuedPosts(state)[0] || null;
}

function computeNextRunText(state = readState()) {
  const schedule = getScheduleSettings(state);
  const bot = getBotState(state);
  const nextPost = getNextQueuedPost(state);

  if (!bot.active) {
    return "البوت متوقف";
  }

  if (!schedule.enabled) {
    return "الجدولة متوقفة من الإعدادات";
  }

  if (!nextPost) {
    return "لا توجد منشورات مبرمجة حاليًا";
  }

  if (!state.scheduler.lastRunAt) {
    return `بعد بدء الخدمة أو خلال ${schedule.intervalMinutes} دقيقة`;
  }

  const next = new Date(new Date(state.scheduler.lastRunAt).getTime() + schedule.intervalMinutes * 60 * 1000);
  return next.toLocaleString("ar-MA", { dateStyle: "short", timeStyle: "short" });
}

function getNextRunTimestamp(state = readState()) {
  const schedule = getScheduleSettings(state);
  const bot = getBotState(state);

  if (!bot.active || !schedule.enabled) {
    return "";
  }

  if (!getNextQueuedPost(state)) {
    return "";
  }

  const reference = state.scheduler.lastRunAt || bot.startedAt;
  if (!reference) {
    return "";
  }

  const next = new Date(new Date(reference).getTime() + schedule.intervalMinutes * 60 * 1000);
  return next.toISOString();
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
    </div>
    <script>
      (() => {
        const runtimeNode = document.getElementById("botRuntimeCounter");
        const nextPostNode = document.getElementById("nextPostCountdown");
        const botActive = ${bot.active ? "true" : "false"};
        const startedAt = ${JSON.stringify(bot.startedAt || "")};
        const nextRunAt = ${JSON.stringify(nextRunAt || "")};

        if (!runtimeNode || !nextPostNode) {
          return;
        }

        const formatDuration = (totalSeconds) => {
          const safe = Math.max(0, totalSeconds);
          const hours = String(Math.floor(safe / 3600)).padStart(2, "0");
          const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
          const seconds = String(safe % 60).padStart(2, "0");
          return hours + ":" + minutes + ":" + seconds;
        };

        const tick = () => {
          const now = Date.now();
          const startedMs = startedAt ? Date.parse(startedAt) : NaN;
          const nextRunMs = nextRunAt ? Date.parse(nextRunAt) : NaN;

          if (botActive && Number.isFinite(startedMs)) {
            runtimeNode.textContent = formatDuration(Math.floor((now - startedMs) / 1000));
          } else {
            runtimeNode.textContent = "00:00:00";
          }

          if (botActive && Number.isFinite(nextRunMs)) {
            const remaining = Math.ceil((nextRunMs - now) / 1000);
            nextPostNode.textContent = remaining > 0 ? formatDuration(remaining) : "00:00:00";
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

async function runPostingJob() {
  const state = readState();
  const connection = getResolvedPageConnection(state);
  const nextPost = getNextQueuedPost(state);

  if (!connection.pageId || !connection.pageAccessToken) {
    throw new Error("الصفحة غير جاهزة بعد. أضف FB_PAGE_ACCESS_TOKEN الصحيح.");
  }

  if (!nextPost) {
    throw new Error("لا توجد منشورات مبرمجة للنشر حاليًا.");
  }

  const publishResult = await publishPagePost({
    pageId: connection.pageId,
    pageAccessToken: connection.pageAccessToken,
    message: nextPost.text
  });

  updateState((current) => {
    current.queuedPosts = current.queuedPosts.filter((post) => post.id !== nextPost.id);
    current.posts.push({
      id: publishResult.id,
      message: nextPost.text,
      createdAt: new Date().toISOString(),
      queueId: nextPost.id
    });
    current.posts = current.posts.slice(-40);
    current.scheduler.lastRunAt = new Date().toISOString();
    current.scheduler.lastResult = `تم نشر المنشور رقم ${nextPost.id} بنجاح`;
    current.scheduler.lastError = "";
    return current;
  });

  return {
    postId: publishResult.id,
    message: nextPost.text
  };
}

function syncScheduler() {
  const state = readState();
  const schedule = getScheduleSettings(state);
  const bot = getBotState(state);

  if (!schedule.enabled || !bot.active) {
    stopScheduler();
    return getSchedulerSnapshot();
  }

  startScheduler(async () => {
    try {
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
    timezone: config.timezone
  });

  return getSchedulerSnapshot();
}

function renderQueuedPostsEditor(state) {
  const queuedPosts = getQueuedPosts(state);

  return `
    <section class="section">
      <h2>${icons.edit}<span>إضافة منشورات جديدة</span></h2>
      <form id="bulkPostsForm" method="post" action="/dashboard/content">
        ${renderField({
          label: "ألصق هنا نصًا كبيرًا، وكل جزء بين @ و @ سيتم اعتباره منشورًا مستقلاً.",
          name: "bulkText",
          type: "textarea",
          value: "",
          rows: 10
        })}
        <div class="actions">
          <button class="btn btn-primary" type="submit">إضافة المنشورات</button>
        </div>
      </form>
    </section>
    <div class="modal-backdrop" id="contentResultModal" aria-hidden="true">
      <div class="modal">
        <h3 id="contentResultTitle">تمت العملية</h3>
        <p id="contentResultMessage">تم تحديث القائمة.</p>
        <div class="modal-actions">
          <button class="btn btn-primary" type="button" id="contentResultOk">موافق</button>
        </div>
      </div>
    </div>
    <section class="section">
      <h2>${icons.posts}<span>المنشورات المبرمجة للنشر</span></h2>
      <div id="queuedPostsContainer">${renderQueuedPostsList(queuedPosts)}</div>
    </section>
    <script>
      (() => {
        const form = document.getElementById("bulkPostsForm");
        const modal = document.getElementById("contentResultModal");
        const title = document.getElementById("contentResultTitle");
        const message = document.getElementById("contentResultMessage");
        const okButton = document.getElementById("contentResultOk");
        const queuedPostsContainer = document.getElementById("queuedPostsContainer");

        if (!form || !modal || !title || !message || !okButton || !queuedPostsContainer) {
          return;
        }

        const textarea = form.querySelector('textarea[name="bulkText"]');

        const openModal = (nextTitle, nextMessage) => {
          title.textContent = nextTitle;
          message.textContent = nextMessage;
          modal.classList.add("open");
          modal.setAttribute("aria-hidden", "false");
        };

        const closeModal = () => {
          modal.classList.remove("open");
          modal.setAttribute("aria-hidden", "true");
        };

        okButton.addEventListener("click", closeModal);
        modal.addEventListener("click", (event) => {
          if (event.target === modal) {
            closeModal();
          }
        });

        form.addEventListener("submit", async (event) => {
          event.preventDefault();

          const formData = new FormData(form);

          try {
            const response = await fetch(form.action, {
              method: "POST",
              headers: {
                Accept: "application/json"
              },
              body: new URLSearchParams(formData)
            });

            const payload = await response.json();

            if (!response.ok || !payload.ok) {
              openModal("تعذر إضافة المنشورات", payload.error || "حدث خطأ أثناء إضافة المنشورات.");
              return;
            }

            queuedPostsContainer.innerHTML = payload.queueHtml || "";
            if (textarea) {
              textarea.value = "";
            }
            openModal("تمت إضافة المنشورات", payload.message || "تمت العملية بنجاح.");
          } catch (error) {
            openModal("تعذر إضافة المنشورات", "تعذر الاتصال بالخادم. حاول مرة أخرى.");
          }
        });
      })();
    </script>
  `;
}

async function buildOverviewBody(state) {
  const schedule = getScheduleSettings(state);
  const connection = getResolvedPageConnection(state);
  const queuedPosts = getQueuedPosts(state);
  const nextPost = getNextQueuedPost(state);
  const bot = getBotState(state);

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
          label: "عدد المنشورات المبرمجة",
          value: String(queuedPosts.length),
          note: nextPost ? `المنشور التالي هو رقم ${queuedPosts.findIndex((post) => post.id === nextPost.id) + 1}` : "لا يوجد منشور جاهز الآن",
          icon: icons.posts
        },
        {
          label: "عدد المنشورات المنشورة",
          value: String(state.posts.length),
          note: state.scheduler.lastResult || "لا توجد نتيجة حديثة",
          icon: icons.status
        },
        {
          label: "الصفحة",
          value: connection.pageName,
          note: `FB_PAGE_ID: ${config.facebookPageId}`,
          icon: icons.page
        },
        {
          label: "وقت النشر",
          value: `كل ${schedule.intervalMinutes} دقيقة`,
          note: computeNextRunText(state),
          icon: icons.clock
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
      <h2>${icons.clock}<span>التحكم في وقت النشر</span></h2>
      <form id="timingForm" method="post" action="/dashboard/timing">
        <div class="stack">
          ${renderField({ label: "الفاصل بين المنشورات بالدقائق", name: "intervalMinutes", type: "number", min: "1", max: "1440", value: schedule.intervalMinutes })}
          ${renderField({ label: "تشغيل النشر التلقائي", name: "scheduleEnabled", type: "checkbox", checked: schedule.enabled })}
        </div>
        <div class="helper">بعد الحفظ سيتم تحديث المؤقت فورًا دون الحاجة إلى إعادة تشغيل التطبيق.</div>
        <div class="actions">
          <button class="btn btn-primary" type="button" id="openTimingConfirm">حفظ الوقت</button>
        </div>
      </form>
    </section>
    <div class="modal-backdrop" id="timingConfirmModal" aria-hidden="true">
      <div class="modal">
        <h3>تأكيد تغيير الوقت</h3>
        <p>هل أنت متأكد من تغيير وقت النشر؟ بعد الضغط على تأكيد سيتم حفظ الوقت الجديد مباشرة.</p>
        <div class="modal-actions">
          <button class="btn btn-primary" type="button" id="confirmTimingSave">تأكيد</button>
          <button class="btn btn-secondary" type="button" id="cancelTimingSave">إلغاء</button>
        </div>
      </div>
    </div>
    <section class="section">
      <h2>${icons.clock}<span>ملخص الوقت</span></h2>
      ${renderMetrics([
        { label: "الحالة الحالية", value: schedule.enabled ? "مفعلة" : "متوقفة", level: schedule.enabled ? "good" : "warn", icon: icons.status },
        { label: "الفاصل", value: `${schedule.intervalMinutes} دقيقة`, icon: icons.clock },
        { label: "آخر تشغيل", value: state.scheduler.lastRunAt || "لم يتم بعد", icon: icons.status },
        { label: "الموعد القادم", value: computeNextRunText(state), icon: icons.spark }
      ])}
    </section>
    <script>
      (() => {
        const form = document.getElementById("timingForm");
        const modal = document.getElementById("timingConfirmModal");
        const openButton = document.getElementById("openTimingConfirm");
        const confirmButton = document.getElementById("confirmTimingSave");
        const cancelButton = document.getElementById("cancelTimingSave");

        if (!form || !modal || !openButton || !confirmButton || !cancelButton) {
          return;
        }

        const openModal = () => {
          modal.classList.add("open");
          modal.setAttribute("aria-hidden", "false");
        };

        const closeModal = () => {
          modal.classList.remove("open");
          modal.setAttribute("aria-hidden", "true");
        };

        openButton.addEventListener("click", openModal);
        cancelButton.addEventListener("click", closeModal);
        confirmButton.addEventListener("click", () => form.submit());
        modal.addEventListener("click", (event) => {
          if (event.target === modal) {
            closeModal();
          }
        });
      })();
    </script>
  `;
}

function buildNextPostBody(state) {
  const queuedPosts = getQueuedPosts(state);
  const nextPost = getNextQueuedPost(state);
  const nextIndex = nextPost ? queuedPosts.findIndex((post) => post.id === nextPost.id) + 1 : 0;

  return `
    <section class="section">
      <h2>${icons.spark}<span>المنشور التالي</span></h2>
      ${nextPost
        ? `<div class="queue-list">
            <article class="queue-card">
              <div class="queue-head">
                <span class="queue-number">#${nextIndex} <small>المعرف ${escapeHtml(nextPost.id)}</small></span>
              </div>
              <pre class="queue-text">${escapeHtml(nextPost.text)}</pre>
            </article>
          </div>`
        : `<div class="empty">لا يوجد أي منشور مبرمج حاليًا. أضف منشورات من صفحة إدارة المنشورات.</div>`
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
  if (!connection.pageAccessToken || !state.posts.length) {
    return `
      <section class="section">
        <h2>${icons.people}<span>الأشخاص المتفاعلون</span></h2>
        <div class="empty">لا توجد بيانات تفاعل بعد. بعد نشر منشورات ووجود تعليقات سيظهر الأشخاص هنا.</div>
      </section>
    `;
  }

  const recentPosts = state.posts.slice(-8);
  const commentGroups = await Promise.all(
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
  );

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
        pageDescription: "ملخص لحالة البوت، وقت النشر، وعدد المنشورات المبرمجة والمنشورة.",
        body: await buildOverviewBody(state)
      };
    case "timing":
      return {
        pageTitle: "التحكم في الوقت",
        pageDescription: "تغيير الفاصل الزمني بين المنشورات وتشغيل أو إيقاف الجدولة.",
        body: buildTimingBody(state)
      };
    case "next-post":
      return {
        pageTitle: "المنشور التالي",
        pageDescription: "يعرض أول منشور في طابور النشر كما هو.",
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
        pageDescription: "ألصق نصًا كبيرًا، وكل جزء بين @ و @ سيتم إضافته كمنشور مستقل قابل للحذف.",
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

  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    redirectWithMessage(res, "/dashboard/timing", {
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
  redirectWithMessage(res, "/dashboard/timing", {
    notice: enabled ? `تم حفظ الوقت على كل ${intervalMinutes} دقيقة.` : "تم إيقاف الجدولة."
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

app.post("/dashboard/content", ensureDashboardAuth, (req, res) => {
  const bulkText = String(req.body.bulkText || "");
  const posts = parseQueuedPosts(bulkText);
  const wantsJson = (req.headers.accept || "").includes("application/json");

  if (!posts.length) {
    if (wantsJson) {
      res.status(400).json({
        ok: false,
        error: "لم يتم العثور على منشورات بين الرمز @ والرمز @."
      });
      return;
    }

    redirectWithMessage(res, "/dashboard/content", {
      error: "لم يتم العثور على منشورات بين الرمز @ والرمز @."
    });
    return;
  }

  const nextState = updateState((current) => {
    for (const text of posts) {
      current.queueCounter += 1;
      current.queuedPosts.push({
        id: current.queueCounter,
        text,
        createdAt: new Date().toISOString()
      });
    }
    return current;
  });

  if (wantsJson) {
    res.json({
      ok: true,
      message: `تمت إضافة ${posts.length} منشور(ات) إلى الطابور.`,
      queueHtml: renderQueuedPostsList(getQueuedPosts(nextState))
    });
    return;
  }

  redirectWithMessage(res, "/dashboard/content", {
    notice: `تمت إضافة ${posts.length} منشور(ات) إلى الطابور.`
  });
});

app.post("/dashboard/content/delete/:id", ensureDashboardAuth, (req, res) => {
  const id = Number.parseInt(String(req.params.id || ""), 10);

  updateState((current) => {
    current.queuedPosts = current.queuedPosts.filter((post) => post.id !== id);
    return current;
  });

  redirectWithMessage(res, "/dashboard/content", {
    notice: `تم حذف المنشور رقم ${id}.`
  });
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
  res.json({
    ok: true,
    baseUrl: config.baseUrl,
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
    queuedPosts: getQueuedPosts(state),
    nextPost: getNextQueuedPost(state),
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
  const state = readState();
  const schedule = getScheduleSettings(state);
  const bot = getBotState(state);

  if (!hasDirectPageAccessToken() || !bot.active || !schedule.enabled || getMissingCoreConfig().length) {
    return;
  }

  const lastRunAt = state.scheduler.lastRunAt ? new Date(state.scheduler.lastRunAt).getTime() : 0;
  const minDelayMs = schedule.intervalMinutes * 60 * 1000;

  if (lastRunAt && Number.isFinite(lastRunAt) && Date.now() - lastRunAt < minDelayMs) {
    return;
  }

  if (!getNextQueuedPost(state)) {
    return;
  }

  try {
    await runPostingJob();
    console.log("[startup] initial queued post published");
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
  if (hasDirectPageAccessToken()) {
    await refreshDirectPageProfile();
    console.log(`Direct page token mode enabled for page ${config.facebookPageId}`);
    void maybeRunStartupPost();
  }
});
