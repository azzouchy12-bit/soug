const icons = {
  shield: icon('<path d="M12 3l7 3v6c0 4.9-3 8.9-7 10-4-1.1-7-5.1-7-10V6l7-3z"></path><path d="M9.5 12.5l1.7 1.7 3.8-4.2"></path>'),
  overview: icon('<path d="M4 13h6V5H4z"></path><path d="M14 19h6V5h-6z"></path><path d="M4 19h6v-2H4z"></path>'),
  clock: icon('<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>'),
  spark: icon('<path d="M12 3l1.9 4.8L19 9.7l-4 3.2 1.3 5.1L12 15.3 7.7 18l1.3-5.1-4-3.2 5.1-1.9L12 3z"></path>'),
  posts: icon('<rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h6"></path>'),
  people: icon('<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9.5" cy="7" r="4"></circle><path d="M20 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>'),
  edit: icon('<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>'),
  logout: icon('<path d="M10 17l5-5-5-5"></path><path d="M15 12H4"></path><path d="M12 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"></path>'),
  status: icon('<path d="M5 18l4-5 3 3 6-8"></path><path d="M4 20h16"></path>'),
  page: icon('<rect x="5" y="3" width="14" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h5"></path>'),
  login: icon('<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>'),
  run: icon('<path d="M8 6l10 6-10 6z"></path>')
};

function icon(paths) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shell({ title, body }) {
  return `<!doctype html>
  <html lang="ar" dir="rtl">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          --bg: #f5f3ee;
          --ink: #1c2422;
          --muted: #67726d;
          --line: rgba(22, 45, 38, 0.12);
          --card: rgba(255,255,255,.92);
          --card-strong: #fff;
          --brand: #0d6a59;
          --brand-2: #c28a2f;
          --brand-soft: #daf0e8;
          --danger: #b84646;
          --danger-soft: #fde7e7;
          --ok-soft: #e5f4ec;
          --warn-soft: #fff4da;
          --shadow: 0 22px 60px rgba(13, 40, 32, .12);
          --radius: 24px;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Tahoma, Arial, sans-serif;
          background:
            radial-gradient(circle at top right, rgba(13, 106, 89, .14), transparent 28%),
            radial-gradient(circle at bottom left, rgba(194, 138, 47, .12), transparent 24%),
            linear-gradient(180deg, #f2f4ef, #f8f7f3);
          color: var(--ink);
          min-height: 100vh;
        }
        a { color: inherit; text-decoration: none; }
        svg {
          width: 20px;
          height: 20px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
          flex: 0 0 auto;
        }
        .auth-wrap {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
        }
        .auth-card {
          width: min(520px, 100%);
          background: linear-gradient(155deg, rgba(7, 54, 46, .96), rgba(15, 106, 88, .92));
          color: #f5fbfa;
          border-radius: 32px;
          padding: 32px;
          box-shadow: var(--shadow);
        }
        .eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-radius: 999px;
          background: rgba(255,255,255,.12);
          font-size: 14px;
        }
        h1 { margin: 16px 0 10px; font-size: clamp(30px, 5vw, 44px); line-height: 1.15; }
        p { line-height: 1.8; }
        .notice, .error {
          border-radius: 18px;
          padding: 14px 16px;
          margin: 16px 0;
        }
        .notice { background: rgba(229, 244, 236, .16); border: 1px solid rgba(229, 244, 236, .2); }
        .error { background: rgba(184, 70, 70, .15); border: 1px solid rgba(184, 70, 70, .2); }
        label { display: block; margin: 0 0 8px; font-size: 14px; }
        input, textarea, select {
          width: 100%;
          border: 1px solid rgba(20, 54, 45, .14);
          border-radius: 16px;
          padding: 14px 16px;
          font: inherit;
          background: rgba(255,255,255,.98);
          color: var(--ink);
          outline: none;
        }
        textarea { min-height: 180px; resize: vertical; }
        input:focus, textarea:focus, select:focus {
          border-color: rgba(13, 106, 89, .42);
          box-shadow: 0 0 0 4px rgba(13, 106, 89, .10);
        }
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          border: 0;
          border-radius: 16px;
          padding: 13px 18px;
          font: inherit;
          font-weight: 700;
          cursor: pointer;
        }
        .btn-primary { background: var(--brand); color: #fff; }
        .btn-secondary { background: var(--brand-soft); color: var(--brand); }
        .btn-ghost { background: transparent; color: #f8fbfa; border: 1px solid rgba(255,255,255,.2); }
        .layout {
          width: min(1320px, calc(100vw - 28px));
          margin: 18px auto;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 290px;
          gap: 18px;
        }
        .sidebar, .panel, .topbar {
          background: var(--card);
          border: 1px solid var(--line);
          box-shadow: 0 12px 32px rgba(13, 40, 32, .08);
          backdrop-filter: blur(10px);
        }
        .sidebar {
          border-radius: 28px;
          padding: 22px;
          position: sticky;
          top: 18px;
          height: fit-content;
        }
        .brand {
          padding: 16px;
          border-radius: 22px;
          background: linear-gradient(145deg, rgba(8,58,49,.97), rgba(13,106,89,.93));
          color: #f5fbfa;
          margin-bottom: 18px;
        }
        .brand small { display: block; opacity: .8; margin-top: 6px; line-height: 1.7; }
        .nav {
          display: grid;
          gap: 10px;
          margin-top: 16px;
        }
        .nav a {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 14px 16px;
          border-radius: 18px;
          color: var(--ink);
          background: rgba(255,255,255,.72);
          border: 1px solid transparent;
        }
        .nav a.active {
          background: #0d6a59;
          color: #fff;
          border-color: rgba(13, 106, 89, .4);
        }
        .nav .nav-label {
          display: inline-flex;
          align-items: center;
          gap: 10px;
        }
        .logout-form { margin-top: 18px; }
        .logout-form .btn { width: 100%; }
        .main {
          display: grid;
          gap: 18px;
        }
        .topbar {
          border-radius: 28px;
          padding: 24px;
          background: linear-gradient(140deg, rgba(8,58,49,.96), rgba(13,106,89,.92));
          color: #f6fbfa;
          position: relative;
          overflow: hidden;
        }
        .topbar::after {
          content: "";
          position: absolute;
          inset: auto auto -70px -50px;
          width: 180px;
          height: 180px;
          background: radial-gradient(circle, rgba(255,255,255,.18), transparent 70%);
        }
        .topbar-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          flex-wrap: wrap;
        }
        .topbar p { max-width: 720px; margin: 8px 0 0; color: rgba(246,251,250,.86); }
        .top-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .header-counters {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 18px;
        }
        .counter-pill {
          display: inline-flex;
          flex-direction: column;
          gap: 4px;
          min-width: 180px;
          padding: 12px 14px;
          border-radius: 18px;
          background: rgba(255,255,255,.12);
          border: 1px solid rgba(255,255,255,.14);
        }
        .counter-pill strong {
          font-size: 22px;
          line-height: 1.2;
        }
        .counter-pill span {
          color: rgba(246,251,250,.82);
          font-size: 13px;
        }
        .section {
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 28px;
          box-shadow: 0 12px 32px rgba(13, 40, 32, .08);
          padding: 24px;
        }
        .section h2 {
          margin: 0 0 18px;
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 22px;
        }
        .metrics {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 14px;
        }
        .metric {
          background: var(--card-strong);
          border: 1px solid var(--line);
          border-radius: 20px;
          padding: 16px;
        }
        .metric .label {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--muted);
          font-size: 14px;
          margin-bottom: 10px;
        }
        .metric .value {
          font-size: 22px;
          font-weight: 700;
          line-height: 1.35;
          word-break: break-word;
        }
        .metric .note {
          margin-top: 8px;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.7;
        }
        .status {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border-radius: 999px;
          padding: 8px 14px;
          font-size: 14px;
          font-weight: 700;
        }
        .good { background: var(--ok-soft); color: #0e6a48; }
        .warn { background: var(--warn-soft); color: #8a6518; }
        .bad { background: var(--danger-soft); color: var(--danger); }
        .content-grid {
          display: grid;
          grid-template-columns: repeat(12, minmax(0, 1fr));
          gap: 18px;
        }
        .span-12 { grid-column: span 12; }
        .span-8 { grid-column: span 8; }
        .span-6 { grid-column: span 6; }
        .span-4 { grid-column: span 4; }
        .stack { display: grid; gap: 14px; }
        .item {
          background: var(--card-strong);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 16px;
        }
        .item-meta {
          color: var(--muted);
          font-size: 13px;
          line-height: 1.7;
          margin-bottom: 10px;
        }
        .item-text {
          white-space: pre-wrap;
          line-height: 1.8;
          margin: 0;
        }
        .empty {
          padding: 18px;
          border-radius: 18px;
          background: rgba(255,255,255,.7);
          border: 1px dashed rgba(13, 106, 89, .18);
          color: var(--muted);
        }
        .actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 18px;
        }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(18, 35, 30, .48);
          display: none;
          align-items: center;
          justify-content: center;
          padding: 20px;
          z-index: 50;
        }
        .modal-backdrop.open {
          display: flex;
        }
        .modal {
          width: min(460px, 100%);
          background: #fff;
          border-radius: 24px;
          border: 1px solid var(--line);
          box-shadow: 0 22px 60px rgba(13, 40, 32, .22);
          padding: 24px;
        }
        .modal h3 {
          margin: 0 0 12px;
          font-size: 24px;
        }
        .modal p {
          margin: 0;
          color: var(--muted);
        }
        .modal-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 20px;
        }
        .split {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }
        .helper {
          color: var(--muted);
          font-size: 14px;
          line-height: 1.8;
          margin-top: 10px;
        }
        .queue-list {
          display: grid;
          gap: 14px;
          margin-top: 18px;
        }
        .queue-card {
          background: linear-gradient(140deg, rgba(218, 240, 232, .92), rgba(255,255,255,.96));
          border: 1px solid rgba(13, 106, 89, .16);
          border-radius: 20px;
          padding: 16px;
        }
        .queue-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .queue-number {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: var(--brand);
          font-weight: 700;
        }
        .queue-delete {
          width: 38px;
          height: 38px;
          border-radius: 12px;
          border: 0;
          background: rgba(184, 70, 70, .12);
          color: var(--danger);
          font-weight: 700;
          cursor: pointer;
        }
        .queue-text {
          margin: 0;
          white-space: pre-wrap;
          line-height: 1.9;
          color: var(--ink);
        }
        @media (max-width: 1020px) {
          .layout {
            grid-template-columns: 1fr;
          }
          .sidebar {
            position: static;
          }
          .content-grid, .split {
            grid-template-columns: 1fr;
          }
          .span-8, .span-6, .span-4 {
            grid-column: span 12;
          }
        }
      </style>
    </head>
    <body>${body}</body>
  </html>`;
}

const sections = [
  { key: "overview", label: "نظرة عامة", icon: icons.overview },
  { key: "timing", label: "التحكم في الوقت", icon: icons.clock },
  { key: "next-post", label: "المنشور التالي", icon: icons.spark },
  { key: "posts", label: "المنشورات التي تمت نشرها", icon: icons.posts },
  { key: "audience", label: "الأشخاص المتفاعلون", icon: icons.people },
  { key: "content", label: "إدارة المنشورات", icon: icons.edit }
];

export function renderLoginPage({ notice = "", error = "" }) {
  return shell({
    title: "دخول الداشبورد",
    body: `
      <main class="auth-wrap">
        <section class="auth-card">
          <div class="eyebrow">${icons.login}<span>Private Dashboard</span></div>
          <h1>ادخل إلى الداشبورد</h1>
          <p>من الرابط الأساسي ستظهر لك هذه الصفحة مباشرة. أدخل الكود <strong>5598</strong> ثم اضغط زر الدخول للانتقال مباشرة إلى الداشبورد.</p>
          ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
          ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
          <form method="post" action="/login">
            <label for="accessCode">كود الدخول</label>
            <input id="accessCode" name="accessCode" type="password" inputmode="numeric" autocomplete="off" required />
            <div class="actions">
              <button class="btn btn-primary" type="submit">${icons.login}<span>Enter</span></button>
            </div>
          </form>
        </section>
      </main>
    `
  });
}

function statusClass(level) {
  return level === "bad" ? "bad" : level === "warn" ? "warn" : "good";
}

export function renderDashboardPage(view) {
  const activeSection = sections.find((item) => item.key === view.sectionKey) || sections[0];
  return shell({
    title: `${activeSection.label} | Dashboard`,
    body: `
      <main class="layout">
        <section class="main">
          <header class="topbar">
            <div class="topbar-row">
              <div>
                <div class="eyebrow">${activeSection.icon}<span>${escapeHtml(activeSection.label)}</span></div>
                <h1>${escapeHtml(view.pageTitle)}</h1>
                <p>${escapeHtml(view.pageDescription)}</p>
                ${view.headerHtml || ""}
              </div>
              <div class="top-actions">
                ${view.actionsHtml || `<a class="btn btn-ghost" href="/status">${icons.status}<span>JSON</span></a>`}
              </div>
            </div>
          </header>
          ${view.notice ? `<div class="section"><div class="notice">${escapeHtml(view.notice)}</div></div>` : ""}
          ${view.error ? `<div class="section"><div class="error">${escapeHtml(view.error)}</div></div>` : ""}
          ${view.body}
        </section>
        <aside class="sidebar">
          <div class="brand">
            <strong>Facebook Auto Dashboard</strong>
            <small>لوحة تحكم مرتبة لصفحتك فقط عبر FB_PAGE_ID و FB_PAGE_ACCESS_TOKEN.</small>
          </div>
          <nav class="nav">
            ${sections
              .map(
                (item) => `
                  <a href="/dashboard/${item.key}" class="${item.key === view.sectionKey ? "active" : ""}">
                    <span class="nav-label">${item.icon}<span>${escapeHtml(item.label)}</span></span>
                  </a>
                `
              )
              .join("")}
          </nav>
          <form class="logout-form" method="post" action="/logout">
            <button class="btn btn-secondary" type="submit">${icons.logout}<span>تسجيل الخروج</span></button>
          </form>
        </aside>
      </main>
    `
  });
}

export function renderMetrics(metrics) {
  return `
    <div class="metrics">
      ${metrics
        .map(
          (metric) => `
            <div class="metric">
              <div class="label">${metric.icon || icons.status}<span>${escapeHtml(metric.label)}</span></div>
              <div class="value">
                ${
                  metric.level
                    ? `<span class="status ${statusClass(metric.level)}">${escapeHtml(metric.value)}</span>`
                    : escapeHtml(metric.value)
                }
              </div>
              ${metric.note ? `<div class="note">${escapeHtml(metric.note)}</div>` : ""}
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderItems(items, emptyText) {
  if (!items.length) {
    return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  }

  return `
    <div class="stack">
      ${items
        .map(
          (item) => `
            <article class="item">
              ${item.meta ? `<div class="item-meta">${item.meta}</div>` : ""}
              <pre class="item-text">${escapeHtml(item.text || "")}</pre>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderFormSection({ title, icon, action, fields, actions, helper = "" }) {
  return `
    <section class="section">
      <h2>${icon || icons.edit}<span>${escapeHtml(title)}</span></h2>
      <form method="post" action="${escapeHtml(action)}">
        <div class="stack">
          ${fields.join("")}
        </div>
        ${helper ? `<div class="helper">${escapeHtml(helper)}</div>` : ""}
        <div class="actions">
          ${actions.join("")}
        </div>
      </form>
    </section>
  `;
}

export function renderField({ label, name, value, type = "text", min = "", max = "", checked = false, rows = 0 }) {
  if (type === "checkbox") {
    return `
      <label>
        <input type="checkbox" name="${escapeHtml(name)}" ${checked ? "checked" : ""} />
        ${escapeHtml(label)}
      </label>
    `;
  }

  if (type === "textarea") {
    return `
      <div>
        <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
        <textarea id="${escapeHtml(name)}" name="${escapeHtml(name)}" ${rows ? `rows="${rows}"` : ""}>${escapeHtml(value)}</textarea>
      </div>
    `;
  }

  if (type === "file") {
    return `
      <div>
        <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
        <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="file" />
      </div>
    `;
  }

  return `
    <div>
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}" ${min !== "" ? `min="${escapeHtml(min)}"` : ""} ${max !== "" ? `max="${escapeHtml(max)}"` : ""} />
    </div>
  `;
}

export function sectionExists(sectionKey) {
  return sections.some((item) => item.key === sectionKey);
}

export { icons, escapeHtml };
