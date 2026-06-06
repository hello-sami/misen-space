// Hoisted: the `let` for the toast-timer state lives up here so showToast
// (function-hoisted, defined far below) can be safely called by any code
// that runs during bootstrap. The original co-located declaration sat in
// the temporal dead zone until line ~1611 executed, so any earlier caller
// would throw and abort whatever bootstrap function it was inside of.
let toastTimer = null;

// [DEBUG] Surface uncaught errors and rejected promises as visible banners
// at the top of the window so we can diagnose without DevTools.
(function installErrorBanner(){
  function makeBanner(text){
    const b = document.createElement('div');
    b.textContent = text;
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 12px;background:#fee;color:#900;font:12px/1.4 -apple-system,sans-serif;border-bottom:2px solid #c00;white-space:pre-wrap;';
    document.body.appendChild(b);
  }
  window.addEventListener('error', (e) => {
    makeBanner(`JS ERROR: ${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    makeBanner(`PROMISE REJECTED: ${String(r?.message || r)}\n${r?.stack || ''}`);
  });
})();

const API = window.miseAPI;

const allList = document.getElementById('allList');

let projects = [];
let state = { recent: [] };
let activeProjectId = null;
let homeProbeTimer = null;
let dragProjectId = null;
let localNotifications = [];
// Split-screen — null when not in split mode, otherwise the projectId on the
// right pane. Mirrored from main via `onSplitChanged` so the renderer state
// always tracks main's authoritative state.
let splitProjectId = null;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const escapeHtml = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

// ---------------------------------------------------------------------------
// Misen brand wordmark — when an app title starts with "Misen <word>", we
// render it as two paired spans so styles.css can color-shift the suffix.
// Returns ready-to-insert HTML (already escaped). Falls back to plain
// escapedHtml for titles that don't match the pattern (IG Stories, etc.).
//   "Misen Day"   → '<span class="misen-pre">Misen</span><span class="misen-suf"> Day</span>'
//   "misen day"   → '<span class="misen-pre">misen</span><span class="misen-suf"> day</span>'
//   "IG Stories"  → 'IG Stories' (no styling)
// ---------------------------------------------------------------------------
const renderMisenLabel = (title) => {
  const s = String(title ?? '');
  const m = /^(misen)(\s.+)$/i.exec(s);
  if (!m) return escapeHtml(s);
  return `<span class="misen-pre">${escapeHtml(m[1])}</span><span class="misen-suf">${escapeHtml(m[2])}</span>`;
};

// Tooltips and aria-labels — strip the "Misen " prefix since the user is
// already inside the Misen launcher. "Misen Day" → "Day".
const stripMisenPrefix = (s) => {
  const str = String(s ?? '');
  const m = /^misen\s+(.+)$/i.exec(str);
  return m ? m[1] : str;
};

// ---------------------------------------------------------------------------
// SVG icon library (Lucide-style, 24×24 viewBox, stroke-based)
// ---------------------------------------------------------------------------

const SVG_ICONS = {
  kitchen:
    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3v7"/>',
  'email-whiteboard-app':
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'whiteboard-tasks':
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  'sheet-music-tracker':
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  'media-tracker':
    '<rect width="20" height="15" x="2" y="3" rx="2"/><polygon points="9 8 15 11.5 9 15 9 8"/><polyline points="8 21 12 17 16 21"/>',
  'daily-journal':
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  'garden-tracker':
    '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  library:
    '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  'igstories-viewer':
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  'digest':
    '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 0-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6z"/>',
  'events-digest':
    '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
  'cal-bridge':
    '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><path d="m9 16 2 2 4-4"/>',
  'residency-tracker':
    '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  'job-search':
    '<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  'atlas':
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  'follows-audit':
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'ereader':
    '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><polyline points="10 2 10 10 13 7 16 10 16 2"/>',
  'project-sketchbook':
    '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
  'font-manager':
    '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  'day-planner':
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/><path d="M8 14h2"/><path d="M14 14h2"/><path d="M8 18h2"/>',
  'bookshelf':
    '<path d="M4 19h16"/><rect x="5" y="6" width="3" height="13"/><rect x="10" y="4" width="3" height="15"/><rect x="15" y="8" width="3" height="11"/>',
  'organize-cms':
    '<path d="M2 8a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>',
  // Misc / chrome
  'search':
    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  'arrow':
    '<path d="M5 12h14"/><path d="m13 5 7 7-7 7"/>',
  'dot':
    '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  'plus':
    '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'sun':
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'moon':
    '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  'sunset':
    '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
  'check':
    '<path d="M20 6 9 17l-5-5"/>',
  'square':
    '<rect x="4" y="4" width="16" height="16" rx="2"/>',
};

function svgWrap(inner, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${inner}</svg>`;
}

// Returns an HTML string — Misen constellation for branded projects,
// Lucide SVG for the rest, escaped emoji/letter as a last resort.
function getProjectIconHTML(project, size = 20) {
  const custom = typeof project?.icon === 'string' ? project.icon.trim() : '';
  if (custom) return `<span class="iconEmoji">${escapeHtml(custom)}</span>`;

  // Prefer the Misen constellation when the brand catalog knows this app.
  // The catalog ships with per-app dots/lines/accent — that's the design's
  // master language, and it makes the launcher rail and home grid read as
  // one system.
  const brand = window.MisenBrand?.appFor?.(project?.id);
  if (brand) {
    return window.MisenBrand.constellationSVG(brand, {
      size,
      // Sidebar rows render at ≤24px — at that size the grid lines and ghost
      // dots become visual noise; switch them off so only the active dots
      // and connecting lines show through.
      showGrid: size >= 32,
      radius: Math.max(2, size * 0.12),
    });
  }

  const id = (project?.id || '').toLowerCase();
  const title = (project?.title || '').toLowerCase();

  // SVG map — exact id matches first
  if (SVG_ICONS[id]) return svgWrap(SVG_ICONS[id], size);

  // Substring fallbacks for ids not explicitly listed
  if (id.includes('kitchen') || id.includes('recipe'))
    return svgWrap(SVG_ICONS['kitchen'], size);
  if (id.includes('email') || id.includes('whiteboard')) return svgWrap(SVG_ICONS['email-whiteboard-app'], size);
  if (id.includes('task')) return svgWrap(SVG_ICONS['whiteboard-tasks'], size);
  if (id.includes('sheet') || id.includes('music') || title.includes('sheet')) return svgWrap(SVG_ICONS['sheet-music-tracker'], size);
  if (id.includes('media')) return svgWrap(SVG_ICONS['media-tracker'], size);
  if (id.includes('journal')) return svgWrap(SVG_ICONS['daily-journal'], size);
  if (id.includes('garden')) return svgWrap(SVG_ICONS['garden-tracker'], size);
  if (id.includes('library') || id.includes('bookmark'))
    return svgWrap(SVG_ICONS['library'], size);
  if (id.includes('ig') || id.includes('instagram') || id.includes('stories')) return svgWrap(SVG_ICONS['igstories-viewer'], size);
  // Use word-boundary matching for 'cal'/'calendar' so substrings like
  // 'decals-tracker' or 'local-foo' don't end up wearing the calendar icon.
  // 'calendar' is a strict suffix/contains; 'cal' must stand alone.
  if (id.includes('calendar') || /(^|[-_])cal($|[-_])/.test(id)) {
    return svgWrap(SVG_ICONS['cal-bridge'], size);
  }

  // Letter fallback
  const s = project?.title || project?.id || '?';
  return `<span class="iconLetter">${escapeHtml(String(s).trim().slice(0, 1).toUpperCase() || '?')}</span>`;
}

function sortProjectsBySavedOrder(projectList, order) {
  if (!Array.isArray(order) || order.length === 0) return projectList.slice();
  const byId = new Map(projectList.map((p) => [p.id, p]));
  const sorted = [];
  order.forEach((id) => {
    const p = byId.get(id);
    if (p) {
      sorted.push(p);
      byId.delete(id);
    }
  });
  byId.forEach((p) => sorted.push(p));
  return sorted;
}

// ---------------------------------------------------------------------------
// Atmospheres — REMOVED. The launcher used to assign each app to a "room"
// and tint Misen's chrome with a per-room palette. We've collapsed back to
// a single neutral palette (defined in styles.css :root); the fixed-camera
// 3D diorama (diorama.js) is the only surviving "rooms" surface.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sidebar list rendering
// ---------------------------------------------------------------------------

function projectRow(project) {
  const isActive = project.id === activeProjectId;
  const iconHtml = getProjectIconHTML(project, 28);
  const label = project.title || project.id;
  // Per-app accent — drives the row's active outline, the constellation's
  // accent dots, and (when we open the app) the appHeader hairline.
  const accent = window.MisenBrand?.appFor?.(project.id)?.accent || '';
  const styleAttr = accent ? ` style="--app-accent-color:${accent}"` : '';

  return `
    <div class="row${isActive ? ' active' : ''}" data-id="${escapeHtml(project.id)}" draggable="true"${styleAttr}>
      <button
        class="rowMain"
        type="button"
        data-action="open"
        title="${escapeHtml(stripMisenPrefix(label))}"
        aria-label="Open ${escapeHtml(stripMisenPrefix(label))}"
      >
        <span class="iconGlyph" aria-hidden="true">${iconHtml}</span>
      </button>
    </div>
  `;
}

function render() {
  allList.innerHTML = projects
    .map((p) => projectRow(p))
    .join('');
}

// ---------------------------------------------------------------------------
// Notification widget helpers
// ---------------------------------------------------------------------------

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function notifItem(notif) {
  const hasUrl = !!notif.url;
  return `
    <div class="notifItem${hasUrl ? ' notifItemClickable' : ''}" data-notif-id="${escapeHtml(notif.id)}" data-notif-url="${escapeHtml(notif.url || '')}">
      <span class="notifIcon" aria-hidden="true">${escapeHtml(notif.sourceIcon)}</span>
      <div class="notifContent">
        <div class="notifTitle">${escapeHtml(notif.title)}</div>
        ${notif.body ? `<div class="notifBody">${escapeHtml(notif.body)}</div>` : ''}
        <div class="notifMeta">${escapeHtml(notif.source)} · ${escapeHtml(timeAgo(notif.timestamp))}</div>
      </div>
      <button class="notifDismiss" data-dismiss-id="${escapeHtml(notif.id)}" type="button" title="Dismiss" aria-label="Dismiss notification">×</button>
    </div>
  `;
}

function updateNotifBadge(count) {
  const badge = document.getElementById('logoBadge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.removeAttribute('hidden');
  } else {
    badge.setAttribute('hidden', 'true');
  }
}

function renderNotifWidget() {
  const section = document.getElementById('notifSection');
  const list = document.getElementById('notifList');
  const countEl = document.getElementById('notifCount');

  updateNotifBadge(localNotifications.length);
  // Status strip + smart greeting are derived from notification counts too.
  updateStatusStrip();
  updateSmartGreeting();

  // Domains home folds notifications into the Pulling-at-you rail.
  // The legacy #notifSection sidebar is no longer mounted but the call is
  // kept for safety in case some future view brings it back.
  if (section && list) {
    if (localNotifications.length === 0) {
      section.setAttribute('hidden', 'true');
    } else {
      section.removeAttribute('hidden');
      if (countEl) countEl.textContent = `(${localNotifications.length})`;
      const sorted = [...localNotifications].sort((a, b) => b.timestamp - a.timestamp);
      list.innerHTML = sorted.slice(0, 15).map(notifItem).join('');
    }
  }

  refreshPullRail?.();
}

async function loadAndRenderNotifications() {
  localNotifications = (await API.getNotifications?.()) || [];
  renderNotifWidget();
}

// ---------------------------------------------------------------------------
// Home dashboard — Domains design
// (six lanes of life: Work · Self · Media · Home · People · Places, with a
// holistic "Pulling at you" rail above and a quiet Tools strip below.)
// ---------------------------------------------------------------------------

const DOMAINS = [
  { id: 'work',   label: 'Work'   },
  { id: 'self',   label: 'Self'   },
  { id: 'media',  label: 'Media'  },
  { id: 'home',   label: 'Home'   },
  { id: 'people', label: 'People' },
  { id: 'places', label: 'Places' },
];

// Live tasks for the rail's Tasks lane. Sourced from day-planner (port 8764),
// which today proxies whiteboard-tasks's /api/tasks. Cached in module scope
// so renderHome() can render synchronously; refreshTasksLane() repopulates
// it after the home view mounts and re-renders the lane in place.
//
// Shape per item: { text, when, urgent }
//   - text:   task title
//   - when:   shorthand for the due date — 'today' | 'overdue' | 'Nd' | 'wk'
//   - urgent: explicit override (used for 'overdue' / today flagged items)
//
// Empty array is the honest default — no fake placeholders. If day-planner
// isn't running, the lane shows the standard "no tasks due" empty state.
let liveTasks = [];

// Fetch tasks from day-planner with a short timeout. Tolerates two response
// shapes (legacy "array of strings", new "array of {id, title, …}") so it
// keeps working across the planned MEP migration without a launcher rev.
async function fetchTasksFromDayPlanner() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('http://127.0.0.1:8764/api/tasks', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.slice(0, 8).map((t) => {
      const title = typeof t === 'string' ? t : (t.title || t.text || '');
      const due   = typeof t === 'object' ? (t.due || t.dueAt || null) : null;
      const when  = dueToWhen(due);
      const urgent = when === 'today' || when === 'overdue';
      return { text: title, when, urgent };
    }).filter((t) => t.text);
  } catch {
    return [];
  }
}

// Convert an ISO-ish due timestamp into the shorthand the Tasks lane
// already understands ('today' / 'overdue' / 'Nd' / 'wk').
function dueToWhen(due) {
  if (!due) return 'wk';
  const dueMs = typeof due === 'number' ? due : Date.parse(due);
  if (!Number.isFinite(dueMs)) return 'wk';
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const diffDays = Math.floor((dueMs - startOfToday.getTime()) / dayMs);
  if (diffDays < 0)   return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays <= 7)  return `${diffDays}d`;
  return 'wk';
}

// Greet by time-of-day, with an icon glyph that shifts sun → sunset → moon.
function timeOfDayGreeting() {
  const h = new Date().getHours();
  if (h < 12)  return { greeting: 'Good morning',   glyph: 'sun'    };
  if (h < 17)  return { greeting: 'Good afternoon', glyph: 'sun'    };
  if (h < 21)  return { greeting: 'Good evening',   glyph: 'sunset' };
  return       { greeting: 'Good night',     glyph: 'moon'   };
}

// Render a typed app pill — used in domain shelves. data-card-id and
// .homeCardStatus / .homeCardDot are preserved so probeAllAndUpdateCards
// can keep updating run/stop status the same way it always did.
//
// Accent color is sourced from the shelf via --d-accent (set by the
// .domainShelf[data-domain=…] block in styles.css), so the pill itself
// doesn't take an accent argument. The right-click hint in the title
// surfaces the kill-server gesture per pill (it used to live only in
// the Tools strip footer).
//
// Notification badge: when localNotifications has items whose `source`
// matches this project's id, we render a small count chip. Hidden when
// zero so quiet apps stay quiet.
function appPill(project, badgeCount = 0) {
  const label = project.title || project.id;
  const brand = window.MisenBrand?.appFor?.(project.id);
  // Use the constellation directly — no PNG override. The constellation IS
  // the brand mark and ships at any size. Drop the app-icons/<id>.png path
  // since the constellation is now the canonical icon.
  const iconHtml = getProjectIconHTML(project, 36);
  const titleAttr = `Open ${escapeHtml(stripMisenPrefix(label))} — right-click to stop server`;
  const badge = badgeCount > 0
    ? `<span class="appPillBadge" aria-label="${badgeCount} unread">${badgeCount > 99 ? '99+' : badgeCount}</span>`
    : '';
  const idEsc = escapeHtml(project.id);
  const styleAttr = brand ? ` style="--app-accent-color:${brand.accent}"` : '';
  return `
    <button class="appPill" type="button" data-card-id="${idEsc}" title="${titleAttr}"${styleAttr}>
      <span class="appPillIcon" aria-hidden="true">
        <span class="appPillFallback">${iconHtml}</span>
        ${badge}
      </span>
      <span class="appPillBody">
        <span class="appPillName">${renderMisenLabel(label)}</span>
        <span class="homeCardStatus probing appPillStatus"><span class="homeCardDot" aria-hidden="true"></span><span class="appPillStatusText">checking…</span></span>
      </span>
    </button>
  `;
}

// Build {projectId → notification count} from localNotifications, used
// to render per-pill badges. Counts every notification whose `source`
// matches a known project id.
function notificationCountsBySource() {
  const counts = {};
  localNotifications.forEach((n) => {
    if (!n.source) return;
    counts[n.source] = (counts[n.source] || 0) + 1;
  });
  return counts;
}

// Domain shelf — calm structural card. Header is just the domain label.
// No counts, no italic blurbs; the Pulling-at-you rail above carries the
// "what's loud right now" signal, and per-pill badges carry the per-app
// signal. The accent colour is plumbed by the data-domain attribute via
// the .domainShelf[data-domain=…] block in styles.css.
function domainShelf(domain, projectsInDomain, notifCounts) {
  return `
    <section class="domainShelf" data-domain="${escapeHtml(domain.id)}">
      <header class="domainHeader">
        <h2 class="domainLabel">${escapeHtml(domain.label)}</h2>
      </header>
      <div class="domainApps">
        ${projectsInDomain.map((p) => appPill(p, notifCounts[p.id] || 0)).join('')}
      </div>
    </section>
  `;
}

// Format ISO-ish notification timestamp into a short "when" tag.
function notifWhen(ts) {
  if (!ts) return 'now';
  const diff = Date.now() - ts;
  if (diff < 60_000)         return 'now';
  if (diff < 3_600_000)      return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000)     return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

// ---------------------------------------------------------------------------
// Lane-specific formatters — each lane (Events / Inbox / Tasks) treats its
// "when" string differently because it answers a different question.
// ---------------------------------------------------------------------------

// Events: parse a relative-time string ("now", "5m", "2h", "3d", "today")
// into a big-number + small-unit pair plus an urgency bucket so the time
// chip can be colored by how soon the event is.
function parseEventTime(whenStr) {
  const w = String(whenStr || '').trim().toLowerCase();
  if (!w || w === 'now' || w === 'just now') {
    return { num: 'now', unit: '', urgency: 'imminent' };
  }
  if (w === 'today') {
    // All-day events: show "today" in serif + "ALL DAY" in monospace.
    return { num: 'today', unit: 'all day', urgency: 'soon' };
  }
  const m = w.match(/^(\d+)([mhd])$/);
  if (!m) return { num: String(whenStr), unit: '', urgency: 'distant' };
  const n = parseInt(m[1], 10);
  const u = m[2];
  if (u === 'm') return { num: String(n), unit: 'min',                 urgency: n < 30 ? 'imminent' : 'soon'    };
  if (u === 'h') return { num: String(n), unit: n === 1 ? 'hr' : 'hrs', urgency: n < 6  ? 'soon'     : 'distant' };
  return                  { num: String(n), unit: n === 1 ? 'day' : 'days', urgency: 'distant' };
}

// Events: a forward-looking countdown helper — given an event's start time
// (ms epoch) returns "now" / "5m" / "2h" / "3d" depending on how far in
// the future the event is. Mirrors notifWhen's vocabulary so parseEventTime
// can consume it the same way.
function countdownFromNow(targetMs) {
  if (!targetMs) return 'now';
  const diff = targetMs - Date.now();
  if (diff <= 60_000)         return 'now';
  if (diff < 3_600_000)       return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000)      return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

// Inbox: derive a friendly sender label from a notification's body or
// source; strip common "From: …" prefixes the source might have baked in.
function deriveInboxSender(rawSub, fallback) {
  let s = String(rawSub || fallback || '').split('·')[0].trim();
  s = s.replace(/^(from|sender):\s*/i, '');
  return s || 'Misen';
}

// Inbox: stable hashed hue → soft avatar background + darker text. Same
// sender always gets the same color, which helps recognition over time.
function inboxAvatarStyle(name) {
  const s = String(name || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `background:hsl(${hue} 55% 90%); color:hsl(${hue} 45% 30%);`;
}

// Tasks: classify a "when" tag (today / 2d / wk) into an urgency bucket
// so we can paint the left stripe and the due-date pill consistently.
function classifyTaskUrgency(whenStr, urgentFlag) {
  const w = String(whenStr || '').trim().toLowerCase();
  if (urgentFlag || w === 'today' || w === 'now' || w === 'overdue') return 'today';
  const dm = w.match(/^(\d+)d$/);
  if (dm) return parseInt(dm[1], 10) <= 2 ? 'soon' : 'later';
  if (w === 'wk' || w === 'week' || /^\d+wk$/.test(w)) return 'later';
  return 'later';
}

// Tasks: render the due-date pill text in a more readable form than the
// raw shorthand. Keeps the pill compact but unambiguous.
function formatTaskDue(whenStr) {
  const w = String(whenStr || '').trim().toLowerCase();
  if (w === 'today')   return 'today';
  if (w === 'now')     return 'now';
  if (w === 'overdue') return 'overdue';
  if (w === 'wk')      return 'this week';
  const dm = w.match(/^(\d+)d$/);
  if (dm) return `${dm[1]}d`;
  return String(whenStr || '');
}

// Pulling-at-you rail — three lanes with distinct visual identities:
//   Events  → timeline feel (Fraunces serif numerals, vertical timeline dots)
//   Inbox   → correspondence feel (italic sender, subject line)
//   Tasks   → checklist feel (square check, monospace tags)
function pullRail() {
  // Partition real notifications by classify().
  const events = [];
  const inbox = [];
  const nowMs = Date.now();
  localNotifications.forEach((n) => {
    const k = classifyNotif(n);
    const isEvent = k === 'event';
    // For events, the lane is forward-looking — so the time chip should
    // count DOWN to the event start, not measure how long ago the
    // notification arrived. Fall back to notifWhen if eventTime is missing
    // (e.g. third-party event sources that didn't supply one).
    let when;
    if (isEvent && n.allDay) {
      when = 'today';
    } else if (isEvent && n.eventTime) {
      when = countdownFromNow(n.eventTime);
    } else {
      when = notifWhen(n.timestamp);
    }
    const item = {
      id: n.id,
      text: n.title,
      // Events lane shows location-style sub; don't fall back to source
      // ("Calendar"), it adds noise to the timeline rows.
      sub:  isEvent ? (n.body || '') : (n.body || n.source || ''),
      when,
      eventTime: n.eventTime || null,
      allDay: !!n.allDay,
      urgent: false,
      url: n.url || '',
      from: n.source || '',
    };
    if (isEvent) {
      // Drop events that have already started more than 5 minutes ago —
      // the lane is for "what's still coming", not "what just happened".
      if (item.eventTime && item.eventTime < nowMs - 5 * 60 * 1000) return;
      events.push(item);
    } else {
      inbox.push(item);
    }
  });
  // Soonest events first. All-day items (no eventTime) bubble to the top
  // since they're "happening today" by definition.
  events.sort((a, b) => (a.eventTime ?? 0) - (b.eventTime ?? 0));

  return `
    <section class="pullRail">
      <header class="pullRailHeader">
        <div class="pullRailTitle">Pulling at you</div>
        <div class="pullRailMeta" id="pullRailMeta"></div>
      </header>
      <div class="pullRailLanes">
        ${eventsLane(events)}
        ${inboxLane(inbox)}
        ${tasksLane(liveTasks)}
      </div>
    </section>
  `;
}

function eventsLane(items) {
  const inner = items.length === 0
    ? `<div class="laneEmpty">no events scheduled</div>`
    : items.slice(0, 8).map((it) => {
        const t = parseEventTime(it.when);
        return `
          <button class="eventItem urg-${t.urgency} ${it.urgent ? 'urgent' : ''}" type="button"
                  data-notif-id="${escapeHtml(it.id || '')}"
                  data-notif-url="${escapeHtml(it.url || '')}"
                  title="${escapeHtml(it.text)}">
            <span class="eventTime">
              <span class="eventTimeNum">${escapeHtml(t.num)}</span>
              ${t.unit ? `<span class="eventTimeUnit">${escapeHtml(t.unit)}</span>` : ''}
            </span>
            <span class="eventBody">
              <span class="eventTitle">${escapeHtml(it.text)}</span>
              ${it.sub ? `<span class="eventSub">${escapeHtml(it.sub)}</span>` : ''}
            </span>
          </button>
        `;
      }).join('');
  return `
    <div class="lane lane-events">
      <header class="laneHeader">
        <span class="laneIcon">${svgWrap(SVG_ICONS['cal-bridge'], 12)}</span>
        <span class="laneLabel">Events</span>
        <span class="laneCount">${items.length}</span>
      </header>
      <div class="laneBody">${inner}</div>
    </div>
  `;
}

function inboxLane(items) {
  const inner = items.length === 0
    ? `<div class="laneEmpty">inbox quiet</div>`
    : items.slice(0, 8).map((it) => {
        const sender = deriveInboxSender(it.sub, it.from);
        const subject = it.text;
        const initial = (sender.trim().charAt(0) || '?').toUpperCase();
        return `
          <button class="inboxItem ${it.urgent ? 'urgent' : ''}" type="button"
                  data-notif-id="${escapeHtml(it.id || '')}"
                  data-notif-url="${escapeHtml(it.url || '')}"
                  title="${escapeHtml(sender)} — ${escapeHtml(subject)}">
            <span class="inboxAvatar" style="${inboxAvatarStyle(sender)}" aria-hidden="true">${escapeHtml(initial)}</span>
            <span class="inboxLines">
              <span class="inboxSender">${escapeHtml(sender)}</span>
              <span class="inboxSubject">${escapeHtml(subject)}</span>
            </span>
            <span class="inboxWhen">${escapeHtml(it.when)}</span>
          </button>
        `;
      }).join('');
  return `
    <div class="lane lane-inbox">
      <header class="laneHeader">
        <span class="laneIcon">${svgWrap(SVG_ICONS['email-whiteboard-app'], 12)}</span>
        <span class="laneLabel">Inbox</span>
        <span class="laneCount">${items.length}</span>
      </header>
      <div class="laneBody">${inner}</div>
    </div>
  `;
}

function tasksLane(items) {
  const inner = items.length === 0
    ? `<div class="laneEmpty">no tasks due</div>`
    : items.slice(0, 8).map((it, i) => {
        const urg = classifyTaskUrgency(it.when, it.urgent);
        const dueLabel = formatTaskDue(it.when);
        return `
          <button class="taskItem urg-${urg} ${it.urgent ? 'urgent' : ''}" type="button"
                  data-task-id="${i}"
                  title="${escapeHtml(it.text)}">
            <span class="taskCheck" aria-hidden="true">${svgWrap(SVG_ICONS['square'], 18)}</span>
            <span class="taskText">${escapeHtml(it.text)}</span>
            <span class="taskDue">${escapeHtml(dueLabel)}</span>
          </button>
        `;
      }).join('');
  return `
    <div class="lane lane-tasks">
      <header class="laneHeader">
        <span class="laneIcon">${svgWrap(SVG_ICONS['whiteboard-tasks'], 12)}</span>
        <span class="laneLabel">Tasks</span>
        <span class="laneCount">${items.length}</span>
      </header>
      <div class="laneBody">${inner}</div>
    </div>
  `;
}

function toolsStrip(toolProjects) {
  if (toolProjects.length === 0) return '';
  return `
    <div class="toolsStrip">
      <span class="toolsLabel">Tools</span>
      ${toolProjects.map((p) => {
        const accent = window.MisenBrand?.appFor?.(p.id)?.accent || '';
        const styleAttr = accent ? ` style="--app-accent-color:${accent}"` : '';
        return `
        <button class="toolsItem" type="button" data-card-id="${escapeHtml(p.id)}" title="Open ${escapeHtml(stripMisenPrefix(p.title || p.id))} — right-click to stop server"${styleAttr}>
          <span class="homeCardStatus probing" aria-hidden="true"><span class="homeCardDot"></span></span>
          ${renderMisenLabel((p.title || p.id).toLowerCase())}
        </button>
      `;
      }).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Recents — last N opened apps, persisted in localStorage so the surface
// survives reloads. pushRecent() is called from onOpenProject; renderHome()
// reads via loadRecents() and renders a small horizontal strip above the
// domain shelves. Hidden when no apps have been opened yet (fresh install).
// ---------------------------------------------------------------------------

const RECENTS_KEY = 'misen.recentsV1';
const RECENTS_MAX = 5;

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(projectId) {
  if (!projectId) return;
  const cur = loadRecents().filter((id) => id !== projectId);
  cur.unshift(projectId);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(cur.slice(0, RECENTS_MAX)));
  } catch {
    /* localStorage disabled — fail silently, recents just won't persist */
  }
}

function recentsStrip(recentProjects) {
  if (recentProjects.length === 0) return '';
  return `
    <section class="recentsStrip" aria-label="Recently opened">
      <header class="recentsHeader">
        <h2 class="recentsLabel">Recently opened</h2>
      </header>
      <div class="recentsRow">
        ${recentProjects.map((p) => {
          const accent = window.MisenBrand?.appFor?.(p.id)?.accent || '';
          const styleAttr = accent ? ` style="--app-accent-color:${accent}"` : '';
          return `
          <button class="recentsItem" type="button" data-card-id="${escapeHtml(p.id)}" title="Open ${escapeHtml(stripMisenPrefix(p.title || p.id))} — right-click to stop server"${styleAttr}>
            <span class="recentsItemIcon" aria-hidden="true">${getProjectIconHTML(p, 22)}</span>
            <span class="recentsItemName">${renderMisenLabel(p.title || p.id)}</span>
            <span class="homeCardStatus probing" aria-hidden="true"><span class="homeCardDot"></span></span>
          </button>
        `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderHome() {
  const hint = document.querySelector('.hint');
  if (!hint) return;
  // roomMode tells the CSS that .hint is now a transparent overlay sitting on
  // top of the 3D room canvas — only the pull rail floats here.
  hint.className = 'hint homeView roomMode';

  // The room is the home view. Lazy-init the 3D scene the first time we land
  // here, then just show it on subsequent visits. Falls back to keeping the
  // hint empty if MiseRoom didn't load (e.g. CDN was unavailable).
  ensureRoomInit();
  if (typeof MiseRoom !== 'undefined' && MiseRoom.isReady()) {
    MiseRoom.show();
  }

  hint.innerHTML = `
    <!-- hidden compatibility shells for the existing notif/status updaters -->
    <div class="hiddenStatus" hidden>
      <span id="pillRunning"></span>
      <span id="pillNotif"></span>
      <span id="pillEmail"></span>
      <span id="pillEvents"></span>
    </div>

    <!-- Notifications rail floats as an overlay on the right side, on top of the room. -->
    ${pullRail()}
  `;

  // Update Pulling-at-you rail meta (count + sources) — purely cosmetic.
  const pullMeta = document.getElementById('pullRailMeta');
  if (pullMeta) {
    const sources = new Set(localNotifications.map((n) => n.source).filter(Boolean));
    const items = localNotifications.length + liveTasks.length;
    pullMeta.textContent = `${items} item${items === 1 ? '' : 's'}${sources.size > 0 ? ` · across ${sources.size} app${sources.size === 1 ? '' : 's'}` : ''}`;
  }

  // Kick off live tasks fetch — populates liveTasks then re-renders the
  // Tasks lane in place via refreshPullRail. Runs after the synchronous
  // render so the page paints immediately even if day-planner is slow.
  fetchTasksFromDayPlanner().then((tasks) => {
    liveTasks = tasks;
    refreshPullRail?.();
  });

  // Home click + contextmenu wiring lives in attachDelegates() so listeners
  // are bound exactly once to the persistent .hint element. Re-binding on
  // every renderHome() used to stack handlers, causing right-click → kill to
  // fire N times after N home visits.

  startHomePolling();

  // Load notifications, then patch the rail in-place so the Events/Inbox
  // lanes get the live data once it arrives. (renderNotifWidget also keeps
  // updating the badge, status pills, and greeting subtitle.)
  loadAndRenderNotifications().then(refreshPullRail);
}

// Replace the rail with fresh content based on current localNotifications.
function refreshPullRail() {
  const home = document.querySelector('.hint.homeView');
  if (!home) return;
  const existing = home.querySelector('.pullRail');
  if (!existing) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = pullRail().trim();
  const replacement = tmp.firstChild;
  existing.replaceWith(replacement);
  const pullMeta = home.querySelector('#pullRailMeta');
  if (pullMeta) {
    const sources = new Set(localNotifications.map((n) => n.source).filter(Boolean));
    const items = localNotifications.length + liveTasks.length;
    pullMeta.textContent = `${items} item${items === 1 ? '' : 's'}${sources.size > 0 ? ` · across ${sources.size} app${sources.size === 1 ? '' : 's'}` : ''}`;
  }
}

// Update only the badge chips on each .appPill — used when a new
// notification arrives while the user is already on the home view, so
// we can avoid a full home re-render. Mirrors the badge-rendering branch
// in appPill().
function refreshAppPillBadges() {
  const home = document.querySelector('.hint.homeView');
  if (!home) return;
  const counts = notificationCountsBySource();
  home.querySelectorAll('.appPill').forEach((pill) => {
    const id = pill.getAttribute('data-card-id');
    const want = counts[id] || 0;
    const existing = pill.querySelector('.appPillBadge');
    if (want > 0) {
      const text = want > 99 ? '99+' : String(want);
      if (existing) {
        existing.textContent = text;
        existing.setAttribute('aria-label', `${want} unread`);
      } else {
        const status = pill.querySelector('.homeCardStatus');
        const node = document.createElement('span');
        node.className = 'appPillBadge';
        node.setAttribute('aria-label', `${want} unread`);
        node.textContent = text;
        if (status) pill.insertBefore(node, status);
        else pill.appendChild(node);
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

async function probeAllAndUpdateCards() {
  const homeView = document.querySelector('.hint.homeView');
  if (!homeView) {
    stopHomePolling();
    return;
  }
  const results = await API.probeAll?.();
  if (!results) return;

  let runningCount = 0;
  Object.entries(results).forEach(([projectId, isRunning]) => {
    if (isRunning) runningCount++;
    // querySelectorAll because a single project can now appear in BOTH
    // the recents strip AND a domain shelf — both status dots must update.
    const items = homeView.querySelectorAll(`[data-card-id="${CSS.escape(projectId)}"]`);
    if (items.length === 0) return;
    const cls = isRunning ? 'running' : 'stopped';
    const label = isRunning ? 'Running' : 'Stopped';
    items.forEach((item) => {
      const statusEl = item.querySelector('.homeCardStatus');
      if (!statusEl) return;
      // Preserve the .appPillStatus class on the new home card style so the
      // subtitle layout (dot + text inline) keeps applying after probing.
      const isAppPillStatus = statusEl.classList.contains('appPillStatus');
      statusEl.className = `homeCardStatus ${cls}${isAppPillStatus ? ' appPillStatus' : ''}`;
      const subtitle = isRunning ? 'Running' : 'Off';
      statusEl.innerHTML = `<span class="homeCardDot" aria-hidden="true"></span><span class="appPillStatusText">${isAppPillStatus ? subtitle : label}</span>`;
    });
  });

  updateStatusStrip({ runningCount });
  updateSmartGreeting({ runningCount });
}

// ---------------------------------------------------------------------------
// Status strip + smart greeting
// ---------------------------------------------------------------------------

// Classify a notification as email / event / other based on its source.
// Use exact matches (plus a small whitelist of aliases) rather than
// substring matching — `src.includes('cal')` previously matched e.g.
// 'decals-tracker' or any source string containing 'cal'.
const EMAIL_SOURCES = new Set(['gmail', 'email']);
const EVENT_SOURCES = new Set(['calendar', 'google calendar', 'cal']);
function classifyNotif(n) {
  const src = String(n?.source || '').toLowerCase().trim();
  if (EMAIL_SOURCES.has(src)) return 'email';
  if (EVENT_SOURCES.has(src)) return 'event';
  return 'other';
}

function getNotifCounts() {
  const total = localNotifications.length;
  let emails = 0;
  let events = 0;
  localNotifications.forEach((n) => {
    const k = classifyNotif(n);
    if (k === 'email') emails++;
    else if (k === 'event') events++;
  });
  return { total, emails, events };
}

function updateStatusStrip({ runningCount } = {}) {
  const pillRunning = document.getElementById('pillRunning');
  const pillNotif = document.getElementById('pillNotif');
  const pillEmail = document.getElementById('pillEmail');
  const pillEvents = document.getElementById('pillEvents');
  const clockEl = document.getElementById('statusClock');
  if (!pillRunning) return; // not on home view

  if (typeof runningCount === 'number') {
    pillRunning.innerHTML = `<span class="dot"></span>${runningCount} ${runningCount === 1 ? 'app' : 'apps'} running`;
    pillRunning.classList.toggle('muted', runningCount === 0);
  }

  const { total, emails, events } = getNotifCounts();
  if (total > 0) {
    pillNotif.classList.remove('muted');
    pillNotif.innerHTML = `<span class="dot"></span>${total} notification${total === 1 ? '' : 's'}`;
  } else {
    pillNotif.classList.add('muted');
    pillNotif.innerHTML = `<span class="dot"></span>No notifications`;
  }

  if (emails > 0) {
    pillEmail.removeAttribute('hidden');
    pillEmail.classList.remove('muted');
    pillEmail.innerHTML = `<span class="dot"></span>${emails} unread email${emails === 1 ? '' : 's'}`;
  } else {
    pillEmail.setAttribute('hidden', 'true');
  }

  if (events > 0) {
    pillEvents.removeAttribute('hidden');
    pillEvents.classList.remove('muted');
    pillEvents.innerHTML = `<span class="dot"></span>${events} event${events === 1 ? '' : 's'} soon`;
  } else {
    pillEvents.setAttribute('hidden', 'true');
  }

  if (clockEl) {
    const d = new Date();
    clockEl.textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
}

function updateSmartGreeting({ runningCount } = {}) {
  const sub = document.getElementById('homeSubtitle');
  if (!sub) return;
  const { total, events } = getNotifCounts();

  const parts = [];
  if (total > 0) {
    parts.push(`<b>${total}</b> notification${total === 1 ? '' : 's'} waiting`);
  }
  if (events > 0) {
    parts.push(`<b>${events}</b> event${events === 1 ? '' : 's'} in the next two hours`);
  }

  if (parts.length === 0) {
    const r = typeof runningCount === 'number' ? runningCount : 0;
    sub.innerHTML = r > 0
      ? `Everything's quiet. <b>${r}</b> app${r === 1 ? '' : 's'} running.`
      : `Everything's quiet.`;
  } else {
    sub.innerHTML = `You have ${parts.join(' and ')}.`;
  }
}

// Keep the clock ticking on the home view.
let clockTickTimer = null;
function startClockTick() {
  stopClockTick();
  clockTickTimer = setInterval(() => {
    const clockEl = document.getElementById('statusClock');
    if (!clockEl) return stopClockTick();
    const d = new Date();
    clockEl.textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }, 30000);
}
function stopClockTick() {
  if (clockTickTimer !== null) {
    clearInterval(clockTickTimer);
    clockTickTimer = null;
  }
}

function startHomePolling() {
  stopHomePolling();
  probeAllAndUpdateCards();
  homeProbeTimer = setInterval(probeAllAndUpdateCards, 30000);
  startClockTick();
}

function stopHomePolling() {
  if (homeProbeTimer !== null) {
    clearInterval(homeProbeTimer);
    homeProbeTimer = null;
  }
  stopClockTick();
}

// ---------------------------------------------------------------------------
// Main-area state machine
// ---------------------------------------------------------------------------

// Lazy room init — only runs once, after projects are loaded.
let _roomInitAttempted = false;

// Re-entry guard for the kill-server prompt. macOS trackpad taps can fire
// contextmenu multiple times for a single gesture; without this lock the
// "Kill process on port…?" dialog stacks up.
let _killPromptInFlight = false;
async function requestKillForProject(projectId) {
  if (!projectId || _killPromptInFlight) return;
  _killPromptInFlight = true;
  try {
    const res = await API.killProjectServer(projectId);
    if (!res || res.cancelled) return;
    if (res.ok === false) { showToast(res.error || 'Could not kill server process.'); return; }
    if (res.killed > 0) showToast(`Killed ${res.killed} process${res.killed === 1 ? '' : 'es'} on port ${res.port}.`);
    else showToast(`Nothing was listening on port ${res.port}.`);
    probeAllAndUpdateCards();
    setTimeout(() => probeAllAndUpdateCards(), 400);
    setTimeout(() => probeAllAndUpdateCards(), 1200);
  } catch (err) {
    showToast(String(err?.message || err));
  } finally {
    _killPromptInFlight = false;
  }
}
function ensureRoomInit() {
  if (_roomInitAttempted) {
    // Re-feed projects in case they changed since first init
    if (typeof MiseRoom !== 'undefined' && MiseRoom.isReady?.()) {
      MiseRoom.updateProjects(projects);
    }
    return;
  }
  if (typeof MiseRoom === 'undefined' || typeof THREE === 'undefined') return;
  if (!projects || projects.length === 0) return;
  // Don't mount the 3D scene while the first-run wizard is showing — there's
  // no point burning a WebGL context + render loop behind a modal the user
  // is still reading. finishOnboarding's `await loadData()` re-enters this
  // path once state.firstRun has flipped to false.
  if (state?.firstRun) return;
  const container = document.getElementById('roomContainer');
  if (!container) return;
  container.removeAttribute('hidden');
  MiseRoom.init({
    container,
    projects,
    onOpenProject: (projectId) => onOpenProject(projectId),
    // Show the appHeader as soon as the launch transition starts so the
    // topbar is visible throughout the zoom/white phase rather than popping
    // in only after the WebContentsView mounts.
    // DEMO MODE: no launch transition (no WebContentsView mounts), so don't
    // flash the app-header pill on click — the faux preview opens instead.
    onLaunchStart: () => {},
    // Captures a PNG of the project's loaded page — used by the diorama to fade
    // FROM white TO the (visually identical) screenshot of the loaded app,
    // then mount the actual WebContentsView (snap is invisible).
    capturePreview: (projectId) => API.capturePreview?.(projectId),
    // Right-click on a furniture piece prompts to kill that project's server.
    // Replaces the old [data-card-id] contextmenu handler that used to live
    // on the home dashboard.
    onPieceContextMenu: (projectId) => requestKillForProject(projectId),
  });
  _roomInitAttempted = true;
}

function setMainState(kind, opts = {}) {
  stopHomePolling();

  if (kind === 'home') {
    renderHome();
    return;
  }

  // Leaving home → hide the room canvas so the embed/loading view has the stage.
  if (typeof MiseRoom !== 'undefined' && MiseRoom.isReady?.()) {
    MiseRoom.hide();
  }

  const hint = document.querySelector('.hint');
  if (!hint) return;
  hint.className = 'hint';

  // For error states, dismiss the launch transition's white veil so the user
  // can actually see the error text. (Other states have the WebContentsView
  // mounted on top, so the veil being up is invisible anyway.)
  if (kind === 'error' && typeof MiseRoom !== 'undefined' && MiseRoom.endLaunchTransition) {
    MiseRoom.endLaunchTransition();
  }

  if (kind === 'opening') {
    // Tinted-blank transitional state: the atmosphere wash is already in,
    // but we don't want the home grid OR the "Starting X…" copy flashing
    // in the brief window before the WebContentsView mounts.
    hint.innerHTML = '';
  } else if (kind === 'loading') {
    hint.innerHTML = `
      <div class="hintTitle hintLoading">Starting ${escapeHtml(opts.title || 'app')}…</div>
      <div class="hintText">Waiting for the server to come up</div>
    `;
  } else if (kind === 'error') {
    hint.innerHTML = `
      <div class="hintTitle hintError">Could not open project</div>
      <div class="hintText">${escapeHtml(opts.error || 'Unknown error')}</div>
    `;
  }
}

// ---------------------------------------------------------------------------
// App header bar
// ---------------------------------------------------------------------------

function showAppHeader(project) {
  // Guard against the project being undefined — onOpenProject's success path
  // re-uses the `project` reference it captured before the async openProject
  // call, and that reference can be undefined if the entry was removed or
  // renamed in the meantime. Without this check, `project.title` throws and
  // the user is left with a half-mounted shell.
  if (!project) return;
  const header = document.getElementById('appHeader');
  const iconEl = document.getElementById('appHeaderIcon');
  const nameEl = document.getElementById('appHeaderName');
  if (!header || !iconEl || !nameEl) return;
  iconEl.innerHTML = getProjectIconHTML(project, 22);
  nameEl.innerHTML = renderMisenLabel(project.title || project.id);
  // Colour the strip's hairline + wordmark suffix with the app's accent.
  const accent = window.MisenBrand?.appFor?.(project.id)?.accent;
  if (accent) {
    header.style.setProperty('--app-accent-color', accent);
  } else {
    header.style.removeProperty('--app-accent-color');
  }
  header.removeAttribute('hidden');
  // Re-render the split pill in case its visibility/contents need to update
  // alongside the primary header.
  renderSplitIndicator();
}

function hideAppHeader() {
  document.getElementById('appHeader')?.setAttribute('hidden', 'true');
  hideSplitPicker();
}

// ---------------------------------------------------------------------------
// Split-screen — picker, indicator, and toggle
// ---------------------------------------------------------------------------

function renderSplitIndicator() {
  const indicator = document.getElementById('appHeaderSplit');
  const iconEl = document.getElementById('appHeaderSplitIcon');
  const nameEl = document.getElementById('appHeaderSplitName');
  const btn = document.getElementById('splitBtn');
  if (!indicator || !iconEl || !nameEl) return;

  if (splitProjectId) {
    const project = projects.find((p) => p.id === splitProjectId);
    if (project) {
      iconEl.innerHTML = getProjectIconHTML(project, 16);
      nameEl.innerHTML = renderMisenLabel(project.title || project.id);
      indicator.removeAttribute('hidden');
    }
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      btn.setAttribute('title', 'Close split (⌘⇧\\)');
      const lbl = btn.querySelector('.appHeaderBtnLabel');
      if (lbl) lbl.textContent = 'Unsplit';
    }
  } else {
    indicator.setAttribute('hidden', 'true');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('title', 'Split (⌘⇧\\)');
      const lbl = btn.querySelector('.appHeaderBtnLabel');
      if (lbl) lbl.textContent = 'Split';
    }
  }
}

function showSplitPicker() {
  const picker = document.getElementById('splitPicker');
  const list = document.getElementById('splitPickerList');
  if (!picker || !list) return;

  // Build the candidate list: every embeddable project. The active primary
  // IS selectable — picking it opens a fresh second instance of that app
  // (e.g. two recipes side-by-side in Kitchen). External apps still skipped
  // since they can't be embedded.
  const candidates = projects.filter(
    (p) => p.kind !== 'external' && p.embed?.url
  );

  if (candidates.length === 0) {
    list.innerHTML = `<div class="splitPickerEmpty">No other apps to open.</div>`;
  } else {
    list.innerHTML = candidates
      .map((p) => {
        const icon = getProjectIconHTML(p, 16);
        const title = renderMisenLabel(p.title || p.id);
        return `<button class="splitPickerItem" type="button" data-split-id="${escapeHtml(p.id)}">
          ${icon}<span>${title}</span>
        </button>`;
      })
      .join('');
  }
  picker.removeAttribute('hidden');

  // Make room: the picker lives in the renderer DOM but the embedded
  // WebContentsView is a native layer drawn on top of the renderer. Without
  // carving space for it, the picker would be painted but covered. We
  // measure AFTER paint (rAF) so getBoundingClientRect sees the real size,
  // then ask main to shrink the embed view from the right edge by the
  // picker's width plus a small margin. The 16px tail covers the picker's
  // `right: 12px` CSS offset plus a tiny gutter so the embed doesn't kiss
  // the picker's left edge.
  requestAnimationFrame(() => {
    const rect = picker.getBoundingClientRect();
    const offset = Math.ceil(rect.width + 16);
    API.setEmbedRightOffset?.(offset);
  });

  // Focus the first item for keyboard navigation. Falls back silently if
  // there are no items.
  const first = list.querySelector('.splitPickerItem');
  if (first) first.focus();
}

function hideSplitPicker() {
  document.getElementById('splitPicker')?.setAttribute('hidden', 'true');
  // Restore normal embed bounds. Idempotent — calling with 0 when already
  // 0 is a no-op on main.
  API.setEmbedRightOffset?.(0);
}

function isSplitPickerOpen() {
  return !document.getElementById('splitPicker')?.hasAttribute('hidden');
}

async function enterSplitWith(projectId) {
  hideSplitPicker();
  if (!projectId || projectId === activeProjectId) return;
  try {
    const res = await API.openProjectInSplit?.(projectId);
    if (!res || !res.ok) {
      showToast(`Split failed: ${res?.error || 'unknown error'}`);
      return;
    }
    // splitProjectId is updated via onSplitChanged below — we don't set it
    // here so the renderer state stays sourced from main's authoritative state.
  } catch (e) {
    showToast(`Split failed: ${String(e?.message || e)}`);
  }
}

async function closeSplitPane() {
  hideSplitPicker();
  try {
    await API.closeSplit?.();
  } catch (e) {
    console.warn('[misen] closeSplit failed:', e);
  }
}

function toggleSplit() {
  // Split is only meaningful when a primary app is open.
  if (!activeProjectId) return;
  if (splitProjectId) {
    closeSplitPane();
    return;
  }
  if (isSplitPickerOpen()) {
    hideSplitPicker();
  } else {
    showSplitPicker();
  }
}

// ---------------------------------------------------------------------------
// Go home (hide embed, return to dashboard)
// ---------------------------------------------------------------------------

async function goHome() {
  await API.hideEmbed?.();
  activeProjectId = null;
  // hideEmbed in main also tears down the split pane, so mirror that here.
  splitProjectId = null;
  hideAppHeader();
  render();
  setMainState('home');
}

// ---------------------------------------------------------------------------
// Open a project
// ---------------------------------------------------------------------------

async function onOpenProject(projectId) {
  // ── DEMO MODE ────────────────────────────────────────────────────────
  // On the public web there are no local servers to launch, so instead of
  // mounting a WebContentsView we show a static "faux preview" (a screenshot
  // + blurb). The room stays put underneath; closing the preview returns the
  // user to the home view exactly as it was.
  pushRecent(projectId);
  if (window.__demoPreview) {
    window.__demoPreview(projectId);
    return;
  }
}

async function persistSidebarOrder() {
  const orderedIds = projects.map((p) => p.id);
  const res = await API.saveProjectOrder?.(orderedIds);
  if (!res?.ok) {
    showToast(`Failed to save order: ${res?.error || 'unknown error'}`);
  }
}

function moveProjectBefore(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const sourceIndex = projects.findIndex((p) => p.id === sourceId);
  if (sourceIndex < 0) return false;
  const [moved] = projects.splice(sourceIndex, 1);
  // Recompute target's index after the splice — it may have shifted left.
  const insertIndex = projects.findIndex((p) => p.id === targetId);
  if (insertIndex < 0) {
    // Target not found (e.g. dropped below the last row). Re-insert where
    // it was so we don't silently delete the row.
    projects.splice(sourceIndex, 0, moved);
    return false;
  }
  projects.splice(insertIndex, 0, moved);
  return true;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function attachDelegates() {
  // Sidebar list clicks
  function handleContainerClick(e) {
    const openMain = e.target?.closest?.('[data-action="open"]');
    if (openMain) {
      const row = openMain.closest('.row');
      const projectId = row?.getAttribute('data-id');
      if (projectId) onOpenProject(projectId);
    }
  }
  allList.addEventListener('click', handleContainerClick);

  allList.addEventListener('dragstart', (e) => {
    const row = e.target?.closest?.('.row');
    if (!row) {
      e.preventDefault();
      return;
    }
    dragProjectId = row.getAttribute('data-id');
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragProjectId || '');
    }
  });

  allList.addEventListener('dragover', (e) => {
    if (!dragProjectId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });

  allList.addEventListener('drop', async (e) => {
    if (!dragProjectId) return;
    e.preventDefault();
    const row = e.target?.closest?.('.row');
    const targetId = row?.getAttribute('data-id');
    const changed = moveProjectBefore(dragProjectId, targetId);
    dragProjectId = null;
    document.querySelectorAll('.row.dragging').forEach((el) => el.classList.remove('dragging'));
    if (changed) {
      render();
      setMainState('home');
      await persistSidebarOrder();
    }
  });

  allList.addEventListener('dragend', () => {
    dragProjectId = null;
    document.querySelectorAll('.row.dragging').forEach((el) => el.classList.remove('dragging'));
  });

  // Brand logo → go home
  document.querySelector('.brand')?.addEventListener('click', goHome);

  // Replace the legacy <img src="icon.svg"> with the master constellation
  // so the launcher's brand chip uses the same icon language as the home
  // grid and embedded apps.
  const logoImg = document.querySelector('.logo .logoImg');
  if (logoImg && window.MisenBrand?.MASTER) {
    const svg = window.MisenBrand.constellationSVG(window.MisenBrand.MASTER, {
      size: 40,
      showGrid: true,
      bg: window.MisenBrand.PAPER,
      radius: 8,
    });
    logoImg.outerHTML = svg;
  }

  // Paint the appHeader's home chip with the master constellation, and wire
  // it to goHome(). The chip is the only persistent brand mark in the shell
  // now that the sidebar is gone, so it doubles as a "back to home" affordance.
  const homeBtn = document.getElementById('appHeaderHome');
  const homeIconEl = document.getElementById('appHeaderHomeIcon');
  if (homeIconEl && window.MisenBrand?.MASTER) {
    homeIconEl.innerHTML = window.MisenBrand.constellationSVG(
      window.MisenBrand.MASTER,
      { size: 22, showGrid: false, radius: 4 }
    );
  }
  if (homeBtn) {
    homeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      goHome();
    });
  }

  // Paint the shell-level switcher with the master constellation and wire
  // it to open the dropdown. This is the home view's visual entry point —
  // ⌘K still works, but the button gives users who don't know the shortcut
  // an obvious, clickable affordance.
  const shellSwitcher = document.getElementById('shellSwitcher');
  const shellSwitcherIcon = document.getElementById('shellSwitcherIcon');
  if (shellSwitcherIcon && window.MisenBrand?.MASTER) {
    shellSwitcherIcon.innerHTML = window.MisenBrand.constellationSVG(
      window.MisenBrand.MASTER,
      { size: 22, showGrid: false, radius: 4 }
    );
  }
  if (shellSwitcher) {
    shellSwitcher.addEventListener('click', (e) => {
      e.stopPropagation();
      // Center the switcher beneath the button on home (no appHeader to
      // anchor against). Match the centring math the ⌘K handler uses.
      if (switcherEl) {
        switcherEl.style.left = '14px';
        switcherEl.style.top = '52px';
        switcherEl.style.transform = '';
      }
      toggleAppSwitcher();
    });
  }

  // Split-screen button — toggle the split picker, or close split if active.
  document.getElementById('splitBtn')?.addEventListener('click', (e) => {
    e.stopPropagation(); // don't immediately re-close via the document click
    toggleSplit();
  });

  // Picker items — click chooses the project for the right pane.
  document.getElementById('splitPickerList')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-split-id]');
    if (!btn) return;
    const projectId = btn.getAttribute('data-split-id');
    if (projectId) enterSplitWith(projectId);
  });

  // Click outside the picker closes it. Bound at the document level so a
  // click anywhere in the shell (sidebar, home view) dismisses the picker.
  document.addEventListener('click', (e) => {
    if (!isSplitPickerOpen()) return;
    const insidePicker = e.target?.closest?.('#splitPicker');
    const onSplitBtn   = e.target?.closest?.('#splitBtn');
    if (!insidePicker && !onSplitBtn) hideSplitPicker();
  });

  // ─── App switcher dropdown ───────────────────────────────────────
  // Replaces the old constellation sidebar. Click the appHeader's icon+wordmark
  // (or hit ⌘K) to open a searchable list of every app. Selecting an entry
  // calls openProject() and closes the dropdown.
  const switcherEl     = document.getElementById('appSwitcher');
  const switcherSearch = document.getElementById('appSwitcherSearch');
  const switcherList   = document.getElementById('appSwitcherList');
  const switcherEmpty  = document.getElementById('appSwitcherEmpty');
  const switcherTrigger = document.getElementById('appHeaderInfo');
  let switcherIndex = 0; // currently highlighted row

  function isSwitcherOpen() {
    return switcherEl && !switcherEl.hasAttribute('hidden');
  }

  function buildSwitcherEntries(filter) {
    const q = (filter || '').trim().toLowerCase();
    // Sort: recents first (most recent at top), then everything else
    // alphabetical by id. Hidden-from-home items still appear here — the
    // switcher is the comprehensive surface, not the curated home view.
    const recents = loadRecents();
    const recentSet = new Set(recents);
    const inRecents = recents
      .map((id) => projects.find((p) => p.id === id))
      .filter(Boolean);
    const others = projects
      .filter((p) => !recentSet.has(p.id))
      .slice()
      .sort((a, b) => (a.id || '').localeCompare(b.id || ''));

    const all = [...inRecents, ...others];
    if (!q) return { recents: inRecents, others, all };

    const match = (p) => {
      const id = (p.id || '').toLowerCase();
      const title = (p.title || '').toLowerCase();
      const brand = window.MisenBrand?.appFor?.(p.id);
      const label = (brand?.label || '').toLowerCase();
      return id.includes(q) || title.includes(q) || label.includes(q);
    };
    return {
      recents: inRecents.filter(match),
      others:  others.filter(match),
      all:     all.filter(match),
    };
  }

  function renderSwitcherRow(p, idx) {
    const accent = window.MisenBrand?.appFor?.(p.id)?.accent || '';
    const styleAttr = accent ? ` style="--app-accent-color:${accent}"` : '';
    const isActive = p.id === activeProjectId;
    return `
      <button class="appSwitcherItem${isActive ? ' is-current' : ''}" type="button"
              data-app-id="${escapeHtml(p.id)}"
              data-row-idx="${idx}"
              role="option"
              aria-selected="${isActive ? 'true' : 'false'}"${styleAttr}>
        <span class="appSwitcherItemIcon" aria-hidden="true">${getProjectIconHTML(p, 28)}</span>
        <span class="appSwitcherItemBody">
          <span class="appSwitcherItemName">${renderMisenLabel(p.title || p.id)}</span>
          <span class="appSwitcherItemId">${escapeHtml(p.id)}</span>
        </span>
        <span class="appSwitcherItemDot" aria-hidden="true"></span>
      </button>
    `;
  }

  function renderSwitcher(filter = '') {
    if (!switcherList) return [];
    const { recents, others } = buildSwitcherEntries(filter);
    const flat = [];
    let html = '';
    if (recents.length) {
      html += `<div class="appSwitcherSection">Recents</div>`;
      recents.forEach((p) => { html += renderSwitcherRow(p, flat.length); flat.push(p); });
    }
    if (others.length) {
      html += `<div class="appSwitcherSection">All apps</div>`;
      others.forEach((p) => { html += renderSwitcherRow(p, flat.length); flat.push(p); });
    }
    switcherList.innerHTML = html;
    if (switcherEmpty) {
      if (flat.length === 0) switcherEmpty.removeAttribute('hidden');
      else switcherEmpty.setAttribute('hidden', 'true');
    }
    switcherIndex = 0;
    highlightSwitcherRow(0);
    return flat;
  }

  // Cached flat list of currently-rendered rows for keyboard navigation.
  let switcherRows = [];

  function highlightSwitcherRow(idx) {
    if (!switcherList) return;
    const items = switcherList.querySelectorAll('.appSwitcherItem');
    items.forEach((el) => el.classList.remove('is-active'));
    if (idx < 0 || idx >= items.length) return;
    switcherIndex = idx;
    const target = items[idx];
    target.classList.add('is-active');
    target.scrollIntoView({ block: 'nearest' });
  }

  function openAppSwitcher() {
    if (!switcherEl) return;
    switcherEl.removeAttribute('hidden');
    if (switcherTrigger) switcherTrigger.setAttribute('aria-expanded', 'true');
    if (switcherSearch) switcherSearch.value = '';
    switcherRows = renderSwitcher('');
    // Focus the search input on open so typing filters immediately.
    queueMicrotask(() => switcherSearch?.focus());
  }

  function closeAppSwitcher() {
    if (!switcherEl) return;
    switcherEl.setAttribute('hidden', 'true');
    if (switcherTrigger) switcherTrigger.setAttribute('aria-expanded', 'false');
  }

  function toggleAppSwitcher() {
    if (isSwitcherOpen()) closeAppSwitcher();
    else openAppSwitcher();
  }

  if (switcherTrigger) {
    switcherTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAppSwitcher();
    });
    switcherTrigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleAppSwitcher();
      }
    });
  }

  if (switcherList) {
    switcherList.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('[data-app-id]');
      if (!btn) return;
      const id = btn.getAttribute('data-app-id');
      if (id) {
        closeAppSwitcher();
        onOpenProject(id);
      }
    });
  }

  if (switcherSearch) {
    switcherSearch.addEventListener('input', () => {
      switcherRows = renderSwitcher(switcherSearch.value);
    });
    switcherSearch.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (switcherRows.length) highlightSwitcherRow(Math.min(switcherIndex + 1, switcherRows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (switcherRows.length) highlightSwitcherRow(Math.max(switcherIndex - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = switcherRows[switcherIndex];
        if (pick) {
          closeAppSwitcher();
          onOpenProject(pick.id);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeAppSwitcher();
      }
    });
  }

  // Click outside closes the switcher.
  document.addEventListener('click', (e) => {
    if (!isSwitcherOpen()) return;
    if (e.target?.closest?.('#appSwitcher')) return;
    if (e.target?.closest?.('#appHeaderInfo')) return;
    if (e.target?.closest?.('#shellSwitcher')) return;
    closeAppSwitcher();
  });

  // ⌘K / Ctrl+K opens the switcher from anywhere — including the home view
  // where the appHeader (and its trigger) is hidden. This is the only way
  // to invoke the switcher without the appHeader visible, since the brand
  // sidebar that used to do this job is gone.
  window.addEventListener('keydown', (e) => {
    const isModifier = e.metaKey || e.ctrlKey;
    if (isModifier && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      // Center the dropdown on screen when there's no appHeader to anchor it
      // beneath (i.e., on the home view).
      if (switcherEl) {
        const onHome = document.getElementById('appHeader')?.hasAttribute('hidden');
        if (onHome) {
          switcherEl.style.left = '50%';
          switcherEl.style.top = '80px';
          switcherEl.style.transform = 'translateX(-50%)';
        } else {
          switcherEl.style.left = '12px';
          switcherEl.style.top = 'var(--header-h)';
          switcherEl.style.transform = '';
        }
      }
      toggleAppSwitcher();
    }
  });

  // Keyboard shortcut: Cmd/Ctrl+Shift+\ toggles split. Bound at the window
  // level so it works whether the shell or an embed has focus — embed views
  // forward un-handled key events through the main process eventually, but
  // the renderer's window listener catches anything that bubbles here.
  // Note: when an embed has focus, this listener WON'T fire (the keystroke
  // is consumed by the embedded webContents). To cover that case, the embed
  // view's `before-input-event` in main.js could send a "toggle split"
  // message — but for v1 the user can press the Split button or click on
  // the shell first. (Esc / Cmd+R already work that way.)
  window.addEventListener('keydown', (e) => {
    const isModifier = e.metaKey || e.ctrlKey;
    if (isModifier && e.shiftKey && (e.key === '\\' || e.code === 'Backslash')) {
      e.preventDefault();
      toggleSplit();
    }
    // Escape is intentionally NOT handled here. Main's before-input-event
    // sends 'misen:goHome' on bare Esc; the onGoHome handler below
    // arbitrates between "close picker" vs. "go home" so we don't double-act
    // on the same keystroke (which used to close the picker AND tear down
    // the embed).
  });

  // Home view: click opens projects / notifications, right-click kills the
  // project's local server. Bound once here against the persistent .hint
  // element — DON'T move this back into renderHome(), or every home re-render
  // will stack another listener and a single right-click will fire N times.
  const homeEl = document.querySelector('.hint');
  if (homeEl) {
    homeEl.addEventListener('click', (e) => {
      // Only act when home is actually showing — embed/loading states reuse
      // .hint as a generic container.
      if (!homeEl.classList.contains('homeView')) return;
      const item = e.target.closest('[data-card-id]');
      if (item) {
        const projectId = item.getAttribute('data-card-id');
        if (projectId) onOpenProject(projectId);
        return;
      }
      const notif = e.target.closest('[data-notif-id]');
      if (notif) {
        const url = notif.getAttribute('data-notif-url');
        if (url) API.openUrlExternal?.(url);
      }
    });

    // Right-click on a [data-card-id] in the home dashboard → kill that
    // project's server. Kept for compatibility in case a dashboard mode is
    // re-added; the room view wires its own contextmenu through MiseRoom.
    homeEl.addEventListener('contextmenu', (e) => {
      if (!homeEl.classList.contains('homeView')) return;
      const item = e.target.closest('[data-card-id]');
      if (!item) return;
      e.preventDefault();
      const projectId = item.getAttribute('data-card-id');
      requestKillForProject(projectId);
    });
  }
}

// Mirror server-startup progress events from the main process.
API.onStatus?.((data) => {
  if (data.state === 'starting') {
    const project = projects.find((p) => p.id === data.projectId);
    setMainState('loading', { title: project?.title || data.projectId });
  }
});

// Main process pings us during boot-all so the grid re-probes immediately
// (and again at staggered intervals) instead of waiting up to 30 s for the
// next polling tick — apps light up the moment their server binds.
API.onReprobe?.(() => {
  if (typeof probeAllAndUpdateCards === 'function') probeAllAndUpdateCards();
});

// Main process asks us to return to the home dashboard (e.g. Escape pressed
// while an embed has focus, or while the shell has focus).
API.onGoHome?.(() => {
  // If the split picker is open, Escape should dismiss the picker rather
  // than tearing down the whole embed. Both signals fire on the same key
  // (main's before-input-event runs ahead of any renderer keydown), so we
  // arbitrate here.
  if (isSplitPickerOpen()) {
    hideSplitPicker();
    return;
  }
  // Only meaningful when something is embedded; on the home screen this is a no-op.
  if (activeProjectId) goHome();
});

// Main process tells us when split state changes (open or close), including
// when the split was closed reactively (e.g. killing the split's server).
// We mirror its authoritative value rather than maintaining a local copy.
API.onSplitChanged?.((data) => {
  splitProjectId = data?.splitProjectId || null;
  renderSplitIndicator();
});

// ── Desktop mode ────────────────────────────────────────────────────────────
// When Misen runs as a desktop surface, toggle a body class so the shell can
// go transparent (letting the real desktop show through the gaps), and tell the
// diorama to drop its opaque background so the wallpaper shows behind the room.
function applyDesktopState(state) {
  const active = !!(state && state.active);
  document.body.classList.toggle('desktop-mode', active);
  document.body.classList.toggle('desktop-layer', active && !!state.layer);
  document.body.classList.toggle('desktop-clickthrough', active && !!state.clickThrough);
  document.body.classList.toggle('desktop-roomonly', active && !!state.roomOnly);
  // NOTE: see-through diorama is intentionally OFF. Making the 3D canvas + shell
  // transparent rendered the whole window invisible (the room stopped
  // compositing against the transparent window, and nothing opaque was left to
  // paint). Desktop mode now keeps the opaque cream surface that works. The
  // setBackgroundTransparent() plumbing is left in place for a future, more
  // careful pass (e.g. only the dead band above the back wall).
  // window.MiseRoom?.setBackgroundTransparent?.(active);
}
// Pull current state on load (robust against missing the initial push)…
API.getDesktopState?.().then(applyDesktopState).catch(() => {});
// …and react to live changes (click-through toggle, etc.).
API.onDesktopState?.(applyDesktopState);
// Toasts pushed from main (grab/drop feedback in wallpaper mode).
API.onToast?.((msg) => { if (msg) showToast(msg); });

// In-app entry to desktop mode (the home-view "Desktop" pill). Relaunches Misen
// at the wallpaper level; the hotkeys (⌃⌥⌘D / ⌃⌥⌘L / ⌃⌥⌘R) take it from there.
(() => {
  const btn = document.getElementById('desktopModeBtn');
  if (btn) btn.addEventListener('click', () => { API.enterDesktopMode?.('layer'); });
})();

// Live-push: a new notification arrived from main process — refresh the widget.
API.onNotification?.((notif) => {
  // Prepend and cap at 50, then re-render if on home screen
  localNotifications = [notif, ...localNotifications.filter((n) => n.id !== notif.id)].slice(0, 50);
  updateNotifBadge(localNotifications.length);
  // Re-render widget only if the section is currently in the DOM
  if (document.getElementById('notifSection')) {
    renderNotifWidget();
  }
  // If we're on the home view, refresh the rail (so the new notif appears
  // in Events/Inbox immediately) and re-skin the per-app pill badges so
  // their counts stay accurate.
  if (document.querySelector('.hint.homeView')) {
    refreshPullRail?.();
    refreshAppPillBadges?.();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function loadData() {
  const result = await API.listProjects();
  projects = sortProjectsBySavedOrder(result.projects || [], result.state?.projectOrder || []);
  state = result.state || { recent: [] };
  if (!Array.isArray(state.recent)) state.recent = [];
  render();
  setMainState('home');
  if (state.firstRun) showOnboarding();
  else injectHelpBtn();
}

// ---------------------------------------------------------------------------
// Onboarding wizard
// ---------------------------------------------------------------------------

function showOnboarding() {
  const overlay = document.getElementById('onboarding');
  if (!overlay) return;
  overlay.removeAttribute('hidden');

  // Make the rest of the shell inert so screen readers + keyboard navigation
  // stay inside the wizard while it's open. `inert` is the modern way; we
  // also stamp `aria-hidden` for older ATs. Both are reverted in
  // finishOnboarding via _restoreInert below.
  const sidebar = document.querySelector('.sidebar');
  const mainEl  = document.querySelector('.main');
  const restoreFns = [];
  for (const el of [sidebar, mainEl]) {
    if (!el) continue;
    const hadInert      = el.hasAttribute('inert');
    const hadAriaHidden = el.getAttribute('aria-hidden');
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    restoreFns.push(() => {
      if (!hadInert) el.removeAttribute('inert');
      if (hadAriaHidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', hadAriaHidden);
    });
  }
  overlay._restoreInert = () => { restoreFns.forEach((fn) => fn()); };

  let currentStep = 1;
  const totalSteps = 4;

  // Track chosen appsDir for step 3. Default is the literal '~/misen-apps' —
  // main.js's saveSetup expands the leading ~ before any fs.mkdirSync, so
  // we don't need to leak the user's home path into the UI here.
  let chosenAppsDir = '~/misen-apps';

  // Focus the first interactive control on the current step so keyboard
  // users land somewhere useful instead of focus staying on whatever
  // triggered the wizard (or on document.body).
  function focusFirstControl() {
    const visibleStep = overlay.querySelector('.ob-step:not([hidden])');
    if (!visibleStep) return;
    const target = visibleStep.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (target) target.focus();
  }

  function goToStep(n) {
    currentStep = Math.max(1, Math.min(totalSteps, n));
    overlay.querySelectorAll('.ob-step').forEach((el) => {
      const s = parseInt(el.dataset.step, 10);
      s === currentStep ? el.removeAttribute('hidden') : el.setAttribute('hidden', '');
    });
    overlay.querySelectorAll('.ob-dot').forEach((el) => {
      const d = parseInt(el.dataset.dot, 10);
      el.classList.toggle('ob-dot--active', d === currentStep);
    });
    focusFirstControl();
  }

  // Esc dismisses the wizard (same path as Skip). Bound on document so it
  // catches the key regardless of which child element has focus. The
  // listener removes itself in finishOnboarding via _onboardingKeyHandler.
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishOnboarding(false);
    }
  };
  document.addEventListener('keydown', onKeydown, true);
  overlay._onboardingKeyHandler = onKeydown;

  // Step 3: Browse button — opens native folder picker
  const browseBtn = document.getElementById('obBrowseBtn');
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      const chosen = await API.pickFolder?.();
      if (chosen) {
        chosenAppsDir = chosen;
        const display = document.getElementById('obFolderPath');
        // Collapse the user's home prefix to '~' for display only — the full
        // path still lives in chosenAppsDir and gets sent to main as-is.
        if (display) display.textContent = chosen.replace(/^\/Users\/[^/]+/, '~');
        const note = document.getElementById('obFolderNote');
        if (note) note.textContent = chosen;
      }
    });
  }

  // Step 3: Confirm — save config then advance
  const folderNext = document.getElementById('obFolderNext');
  if (folderNext) {
    folderNext.addEventListener('click', async () => {
      folderNext.disabled = true;
      folderNext.textContent = 'Saving…';
      try {
        // Resolve ~ if user never opened the picker
        const absDir = chosenAppsDir.startsWith('~')
          ? chosenAppsDir  // main.js resolves this via os.homedir()
          : chosenAppsDir;
        await API.saveSetup?.({ appsDir: absDir });
      } catch (e) {
        console.warn('[onboarding] saveSetup failed', e);
      }
      folderNext.disabled = false;
      folderNext.textContent = 'Looks good →';
      goToStep(currentStep + 1);
    });
  }

  overlay.addEventListener('click', (e) => {
    if (e.target.matches('[data-ob-next]'))    goToStep(currentStep + 1);
    if (e.target.matches('[data-ob-back]'))    goToStep(currentStep - 1);
    if (e.target.matches('[data-ob-skip]'))    finishOnboarding(false);
    if (e.target.matches('[data-ob-finish]'))  finishOnboarding(false);
    if (e.target.matches('[data-ob-tour]'))    finishOnboarding(true);
  });

  goToStep(1);
}

async function finishOnboarding(startTour) {
  const overlay = document.getElementById('onboarding');
  if (overlay) {
    overlay.setAttribute('hidden', '');
    // Detach the Esc handler and restore inert/aria-hidden on the sidebar +
    // main shell. Guards in case showOnboarding's setup didn't run (defensive
    // — shouldn't happen in practice, but cheap).
    if (overlay._onboardingKeyHandler) {
      document.removeEventListener('keydown', overlay._onboardingKeyHandler, true);
      overlay._onboardingKeyHandler = null;
    }
    if (typeof overlay._restoreInert === 'function') {
      overlay._restoreInert();
      overlay._restoreInert = null;
    }
  }
  state.firstRun = false;
  await API.dismissOnboarding?.();
  // Reload so a freshly seeded projects.json (from saveSetup) appears in the sidebar
  await loadData();
  injectHelpBtn();
  if (startTour) startTooltipTour();
}

function injectHelpBtn() {
  if (document.getElementById('helpBtn')) return; // already there
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const btn = document.createElement('button');
  btn.id = 'helpBtn';
  btn.className = 'helpBtn';
  btn.type = 'button';
  btn.title = 'Take the tour';
  btn.textContent = 'Take the tour';
  btn.addEventListener('click', () => startTooltipTour());
  sidebar.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Tooltip tour
// ---------------------------------------------------------------------------

const TOUR_STEPS = [
  {
    targetId: 'allList',
    text: 'The sidebar lists all your apps. Click one to open it right here inside Misen — no browser tab needed.',
  },
  {
    targetId: 'roomContainer',
    fallbackSelector: '.mainBody',
    text: 'The home view shows your app grid. Hover an app to see its status; click to launch.',
  },
  {
    targetId: 'logoBadge',
    fallbackSelector: '.brand',
    text: 'This badge lights up when an app has a notification for you — like a new digest or a reminder.',
  },
  // The corner "Apps" switcher pill was removed (the diorama's left-column
  // app list replaces it), so its tour step is gone too. ⌘K still works.
];

let tourStepIdx = 0;

function startTooltipTour() {
  tourStepIdx = 0;
  const overlay = document.getElementById('tourOverlay');
  const skip = document.getElementById('tourSkip');
  const next = document.getElementById('tourNext');
  if (!overlay) return;

  overlay.removeAttribute('hidden');

  skip.onclick = () => endTour();
  next.onclick = () => {
    tourStepIdx++;
    if (tourStepIdx >= TOUR_STEPS.length) endTour();
    else renderTourStep();
  };

  renderTourStep();
}

function renderTourStep() {
  const step = TOUR_STEPS[tourStepIdx];
  if (!step) return;

  // Resolve a usable spotlight target. The primary lookup is by id; if the
  // matched element is hidden (zero-sized — e.g. #logoBadge before any
  // notification arrives), fall through to the fallback selector before
  // giving up. Without this, the spotlight would collapse to a 0×0 point
  // somewhere off-frame and the tooltip would point at nothing.
  const hasSize = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  let target = document.getElementById(step.targetId);
  if (!hasSize(target) && step.fallbackSelector) {
    target = document.querySelector(step.fallbackSelector);
  }
  if (!hasSize(target)) target = null;

  const spotlight = document.getElementById('tourSpotlight');
  const tooltip   = document.getElementById('tourTooltip');
  const text      = document.getElementById('tourText');
  const counter   = document.getElementById('tourCounter');
  const nextBtn   = document.getElementById('tourNext');

  text.textContent = step.text;
  counter.textContent = `${tourStepIdx + 1} / ${TOUR_STEPS.length}`;
  nextBtn.textContent = tourStepIdx === TOUR_STEPS.length - 1 ? 'Done' : 'Next →';

  if (target) {
    const r = target.getBoundingClientRect();
    const PAD = 10;
    Object.assign(spotlight.style, {
      top:    `${r.top    - PAD}px`,
      left:   `${r.left   - PAD}px`,
      width:  `${r.width  + PAD * 2}px`,
      height: `${r.height + PAD * 2}px`,
    });
    spotlight.removeAttribute('hidden');

    // Position tooltip: prefer below, fall back to above if no room.
    const TIP_GAP = 16;
    const tipTop = r.bottom + PAD + TIP_GAP;
    const tipLeft = Math.max(16, r.left);
    Object.assign(tooltip.style, {
      top:  `${tipTop}px`,
      left: `${tipLeft}px`,
    });
  } else {
    // No target found — center tooltip and hide spotlight.
    spotlight.setAttribute('hidden', '');
    Object.assign(tooltip.style, {
      top:  '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    });
  }
}

function endTour() {
  const overlay = document.getElementById('tourOverlay');
  if (overlay) overlay.setAttribute('hidden', '');
}

attachDelegates();
loadData();
reportShellLayout();

// Read the computed values of --sidebar-w and --header-h and push them to
// main, so the embedded WebContentsView's bounds stay aligned with the
// shell chrome without main and CSS having to keep hardcoded values in sync.
// Called once at bootstrap (CSS is loaded by the time renderer.js runs —
// the <link> is in <head>, this script is at the bottom of <body>).
function reportShellLayout() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const parsePx = (v) => {
      const n = parseFloat(String(v).trim());
      return Number.isFinite(n) ? n : null;
    };
    const sidebarWidth = parsePx(cs.getPropertyValue('--sidebar-w'));
    const headerHeight = parsePx(cs.getPropertyValue('--header-h'));
    if (sidebarWidth == null || headerHeight == null) return;
    API.reportLayout?.({ sidebarWidth, headerHeight });
  } catch (_) {
    // Fall back to main's hardcoded defaults — non-fatal, just means the
    // embed view's bounds stay at 76/44 even if the CSS values diverge.
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

// `toastTimer` is referenced from inside `showToast` below. The function
// itself is hoisted, but the `let` is NOT — so any caller that runs before
// this line executes hits a temporal-dead-zone ReferenceError. Keeping the
// declaration co-located with its only function looks tidy but means anyone
// who calls showToast during bootstrap (e.g. from inside attachDelegates,
// or during early error handling) will throw and abort the surrounding
// function. Moved to the top of the file for safety. See the `let toastTimer`
// near the top.
function showToast(msg) {
  const el = document.getElementById('toast');
  const tmsg = document.getElementById('toastMsg');
  if (!el || !tmsg) return;
  tmsg.textContent = msg;
  el.classList.add('show');
  el.removeAttribute('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el.setAttribute('hidden', 'true');
  }, 3200);
}
