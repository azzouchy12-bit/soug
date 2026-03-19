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
import { generatePost, getActiveAiModel } from "./ai.js";
import { getSchedulerSnapshot, schedulerIsActive, startScheduler, stopScheduler } from "./scheduler.js";
import { readState, updateState } from "./storage.js";
import {
  escapeHtml,
  icons,
  renderDashboardPage,
  renderField,
  renderFormSection,
  renderItems,
  renderLoginPage,
  renderMetrics,
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
    res.status(401).json({ ok: false, error: "Dashboard authentication required." });
    return;
  }

  res.type("html").send(
    renderLoginPage({
      error: "أدخل الكود أولاً للوصول إلى الداشبورد."
    })
  );
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

function getEffectiveContentSettings(state = readState()) {
  return {
    contentBrief: state.settings.contentBrief || config.contentBrief,
    contentLanguage: state.settings.contentLanguage || config.contentLanguage
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

function computeNextRunText(state = readState()) {
  const schedule = getScheduleSettings(state);

  if (!schedule.enabled) {
    return "الجدولة متوقفة";
  }

  if (!state.scheduler.lastRunAt) {
    return `بعد بدء الخدمة أو خلال ${schedule.intervalMinutes} دقيقة`;
  }

  const next = new Date(new Date(state.scheduler.lastRunAt).getTime() + schedule.intervalMinutes * 60 * 1000);
  return next.toLocaleString("ar-MA", { dateStyle: "short", timeStyle: "short" });
}

function normalizeErrorMessage(error) {
  const raw = String(error?.message || error || "").trim();

  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.error?.message || parsed?.message || "";
    if (nested) {
      return nested;
    }
  } catch {}

  if (raw.includes("429") || raw.includes("RESOURCE_EXHAUSTED")) {
    return "تم تجاوز حصة Gemini الحالية. خفف عدد الطلبات أو راجع الخطة والفوترة.";
  }

  if (raw.includes("NOT_FOUND") && raw.includes("models/")) {
    return "اسم نموذج Gemini غير صحيح أو غير مدعوم. راجع قيمة GEMINI_MODEL.";
  }

  return raw || "حدث خطأ غير معروف.";
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
  const contentSettings = getEffectiveContentSettings(state);

  if (!connection.pageId || !connection.pageAccessToken) {
    throw new Error("الصفحة غير جاهزة بعد. أضف FB_PAGE_ACCESS_TOKEN الصحيح.");
  }

  const message = await generatePost({
    pageName: connection.pageName,
    recentPosts: state.posts,
    contentBrief: contentSettings.contentBrief,
    contentLanguage: contentSettings.contentLanguage
  });

  const publishResult = await publishPagePost({
    pageId: connection.pageId,
    pageAccessToken: connection.pageAccessToken,
    message
  });

  updateState((current) => {
    current.posts.push({
      id: publishResult.id,
      message,
      createdAt: new Date().toISOString()
    });
    current.posts = current.posts.slice(-30);
    current.preview.nextPost = "";
    current.preview.generatedAt = "";
    current.preview.lastError = "";
    current.scheduler.lastRunAt = new Date().toISOString();
    current.scheduler.lastResult = `تم النشر بنجاح على ${connection.pageName}`;
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

function statusLevel(state = readState()) {
  if (state.scheduler.lastError) {
    return "bad";
  }

  if (!getScheduleSettings(state).enabled || !schedulerIsActive()) {
    return "warn";
  }

  return "good";
}

async function generatePreviewPost() {
  const state = readState();
  const connection = getResolvedPageConnection(state);
  const contentSettings = getEffectiveContentSettings(state);
  const nextPost = await generatePost({
    pageName: connection.pageName,
    recentPosts: state.posts,
    contentBrief: contentSettings.contentBrief,
    contentLanguage: contentSettings.contentLanguage
  });

  updateState((current) => {
    current.preview.nextPost = nextPost;
    current.preview.generatedAt = new Date().toISOString();
    current.preview.lastError = "";
    return current;
  });

  return nextPost;
}

async function ensureNextPostPreview() {
  const state = readState();

  if (state.preview.nextPost) {
    return state;
  }

  try {
    await generatePreviewPost();
  } catch (error) {
    updateState((current) => {
      current.preview.lastError = normalizeErrorMessage(error);
      return current;
    });
  }

  return readState();
}

async function buildOverviewBody(state) {
  const schedule = getScheduleSettings(state);
  const contentSettings = getEffectiveContentSettings(state);
  const connection = getResolvedPageConnection(state);
  const metrics = [
    {
      label: "حالة الجدولة",
      value: schedule.enabled && schedulerIsActive() ? "نشطة" : "متوقفة",
      level: statusLevel(state)
    },
    {
      label: "وقت النشر",
      value: `كل ${schedule.intervalMinutes} دقيقة`,
      note: `المنطقة الزمنية: ${config.timezone}`,
      icon: icons.clock
    },
    {
      label: "المنشور التالي",
      value: computeNextRunText(state),
      note: state.preview.generatedAt ? `آخر معاينة: ${state.preview.generatedAt}` : "لا توجد معاينة محفوظة",
      icon: icons.spark
    },
    {
      label: "الصفحة",
      value: connection.pageName,
      note: `FB_PAGE_ID: ${config.facebookPageId}`,
      icon: icons.page
    },
    {
      label: "عدد المنشورات",
      value: String(state.posts.length),
      note: state.scheduler.lastResult || "لا توجد نتيجة حديثة",
      icon: icons.posts
    },
    {
      label: "محتوى المنشورات",
      value: contentSettings.contentLanguage,
      note: contentSettings.contentBrief.slice(0, 90),
      icon: icons.edit
    }
  ];

  return `
    <section class="section">
      <h2>${icons.overview}<span>النظرة العامة</span></h2>
      ${renderMetrics(metrics)}
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
  const contentSettings = getEffectiveContentSettings(state);
  return `
    ${renderFormSection({
      title: "تحديث المعاينة",
      icon: icons.spark,
      action: "/dashboard/next-post/generate",
      fields: [],
      actions: ['<button class="btn btn-primary" type="submit">تحديث المعاينة</button>'],
      helper: "عند فتح هذه الصفحة يتم توليد المعاينة تلقائيًا. هذا الزر فقط لإعادة توليدها يدويًا."
    })}
    <section class="section">
      <h2>${icons.spark}<span>المعاينة الحالية</span></h2>
      ${renderItems(
        state.preview.nextPost
          ? [{
              meta: `تم التوليد في: ${escapeHtml(state.preview.generatedAt || "-")} | اللغة: ${escapeHtml(contentSettings.contentLanguage)}`,
              text: state.preview.nextPost
            }]
          : [],
        state.preview.lastError || "تعذر إنشاء معاينة تلقائية الآن."
      )}
    </section>
  `;
}

async function buildPostsBody(state) {
  const connection = getResolvedPageConnection(state);
  const posts = state.posts.slice(-12).reverse();
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
      <h2>${icons.posts}<span>المنشورات التي تم نشرها</span></h2>
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
  const contentSettings = getEffectiveContentSettings(state);
  const usingDashboardOverride = Boolean(state.settings.contentBrief || state.settings.contentLanguage);

  return `
    ${renderFormSection({
      title: "تغيير محتوى المنشورات",
      icon: icons.edit,
      action: "/dashboard/content",
      fields: [
        renderField({ label: "لغة المنشورات", name: "contentLanguage", value: contentSettings.contentLanguage }),
        renderField({ label: "تعليمات المحتوى", name: "contentBrief", type: "textarea", value: contentSettings.contentBrief, rows: 10 })
      ],
      actions: [
        '<button class="btn btn-primary" type="submit">حفظ المحتوى</button>',
        '<button class="btn btn-secondary" type="submit" name="resetContent" value="1">العودة إلى القيم الأصلية</button>'
      ],
      helper: "هذا النص هو الذي يوجّه Gemini لصياغة المنشورات القادمة."
    })}
    <section class="section">
      <h2>${icons.edit}<span>المصدر الحالي للمحتوى</span></h2>
      ${renderMetrics([
        { label: "المصدر", value: usingDashboardOverride ? "إعدادات الداشبورد" : "متغيرات Railway", level: usingDashboardOverride ? "good" : "warn", icon: icons.status },
        { label: "اللغة", value: contentSettings.contentLanguage, icon: icons.edit },
        { label: "عدد الحروف", value: String(contentSettings.contentBrief.length), icon: icons.edit }
      ])}
    </section>
  `;
}

async function buildSectionView(sectionKey, state) {
  switch (sectionKey) {
    case "overview":
      return {
        pageTitle: "نظرة عامة",
        pageDescription: "ملخص سريع لحالة البوت، وقت النشر، الصفحة المستهدفة، وآخر النتائج.",
        body: await buildOverviewBody(state)
      };
    case "timing":
      return {
        pageTitle: "التحكم في الوقت",
        pageDescription: "تغيير الفاصل الزمني بين المنشورات وتشغيل أو إيقاف الجدولة من داخل الداشبورد.",
        body: buildTimingBody(state)
      };
    case "next-post":
      state = await ensureNextPostPreview();
      return {
        pageTitle: "المنشور التالي",
        pageDescription: "تظهر هنا معاينة المنشور التالي مباشرة عند فتح الصفحة.",
        body: buildNextPostBody(state)
      };
    case "posts":
      return {
        pageTitle: "المنشورات التي تم نشرها",
        pageDescription: "مراجعة آخر المنشورات التي نشرها البوت مع بياناتها الأساسية.",
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
        pageTitle: "تغيير محتوى المنشورات",
        pageDescription: "تعديل لغة وتعليمات المحتوى التي تُرسل إلى Gemini مباشرة من الواجهة.",
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
  redirectWithMessage(res, "/", {
    notice: "تم تسجيل الخروج بنجاح."
  });
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

app.post("/dashboard/content", ensureDashboardAuth, (req, res) => {
  updateState((current) => {
    if (req.body.resetContent === "1") {
      current.settings.contentBrief = "";
      current.settings.contentLanguage = "";
    } else {
      current.settings.contentBrief = String(req.body.contentBrief || "").trim();
      current.settings.contentLanguage = String(req.body.contentLanguage || "").trim();
    }
    return current;
  });

  redirectWithMessage(res, "/dashboard/content", {
    notice: req.body.resetContent === "1" ? "تمت العودة إلى القيم الأصلية." : "تم حفظ محتوى المنشورات الجديد."
  });
});

app.post("/dashboard/next-post/generate", ensureDashboardAuth, async (req, res) => {
  try {
    await generatePreviewPost();
    redirectWithMessage(res, "/dashboard/next-post", {
      notice: "تم توليد المنشور التالي بنجاح."
    });
  } catch (error) {
    updateState((current) => {
      current.preview.lastError = normalizeErrorMessage(error);
      return current;
    });
    redirectWithMessage(res, "/dashboard/next-post", {
      error: normalizeErrorMessage(error)
    });
  }
});

app.get("/dashboard/next-post/generate", ensureDashboardAuth, async (req, res) => {
  try {
    await generatePreviewPost();
    redirectWithMessage(res, "/dashboard/next-post", {
      notice: "تم تحديث المعاينة بنجاح."
    });
  } catch (error) {
    updateState((current) => {
      current.preview.lastError = normalizeErrorMessage(error);
      return current;
    });
    redirectWithMessage(res, "/dashboard/next-post", {
      error: normalizeErrorMessage(error)
    });
  }
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
    aiProvider: config.aiProvider,
    aiModel: getActiveAiModel(),
    configuredPageId: config.facebookPageId,
    directPageTokenConfigured: hasDirectPageAccessToken(),
    schedule: getScheduleSettings(state),
    scheduler: getSchedulerSnapshot(),
    connectedPage: connection.pageAccessToken
      ? {
          id: connection.pageId,
          name: connection.pageName,
          mode: connection.mode
        }
      : null,
    settings: getEffectiveContentSettings(state),
    preview: state.preview,
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
