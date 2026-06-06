/* misen.space/demo — web stub for the Electron bridge (window.miseAPI).
 *
 * The real Misen launcher (index.html + renderer.js) talks to the Electron
 * main process through window.miseAPI. On the public web there's no main
 * process and no local servers, so this file provides a faithful no-op stub
 * of that bridge plus the faux "app preview" shown when a piece/app is
 * opened. It MUST load before renderer.js (which captures window.miseAPI at
 * eval time and calls listProjects() on startup).
 */
(function () {
  'use strict';

  let PROJECTS = [];
  const noop = () => {};
  const unsub = () => noop;            // event subscribers return an unsubscribe fn

  // ── Seed Sami's real furniture layout ──────────────────────────────
  // The diorama reads its arrangement from localStorage ("misen.dioramaLayout")
  // and falls back to config defaults when empty. To make the public demo match
  // Sami's actual Misen, we fetch his exported layout and write it in BEFORE the
  // room initializes. We must also pre-fill the "decorations seeded" set so the
  // diorama's ensureDecorations() doesn't relocate the shelf/desk/chair/carpet
  // back to their default slots. Gated by a version string so visitors can still
  // rearrange (their changes stick until we bump SEED_VERSION).
  const SEED_VERSION = 'sami-layout-2026-06-06';
  async function seedLayout() {
    try {
      if (localStorage.getItem('misen.demoLayoutSeed') === SEED_VERSION) return;
      const res = await fetch('diorama-layout.json');
      const layout = await res.json();
      localStorage.setItem('misen.dioramaLayout', JSON.stringify(layout));
      // Decoration ids from diorama.js DECORATIONS[]; marking them seeded stops
      // ensureDecorations() from moving the matching pieces to default slots.
      localStorage.setItem('misen.dioramaDecsSeeded.v16',
        JSON.stringify(['shelf', 'desk', 'officeChair', 'carpet-v2']));
      localStorage.removeItem('misen.dioramaDeleted.v1');
      localStorage.setItem('misen.demoLayoutSeed', SEED_VERSION);
    } catch (e) { /* fall back to default layout */ }
  }

  // ── The stubbed bridge ─────────────────────────────────────────────
  window.miseAPI = {
    // Data
    listProjects: async () => {
      // Seed the saved layout first — renderer.js awaits listProjects() before
      // initializing the room, so localStorage is set before loadPlacements().
      await seedLayout();
      try {
        const res = await fetch('projects.json');
        const data = await res.json();
        PROJECTS = data.projects || [];
      } catch (e) {
        PROJECTS = [];
      }
      return {
        projects: PROJECTS,
        state: { recent: [], projectOrder: null, firstRun: false },
      };
    },
    capturePreview: async () => null,
    probeAll: async () => ({}),                 // no live servers → nothing "running"
    getNotifications: async () => [],
    getDesktopState: async () => null,          // → applyDesktopState(null): normal mode

    // Actions — all no-ops on the web. onOpenProject in renderer.js is
    // intercepted to show the faux preview instead of calling openProject.
    openProject: async () => ({ ok: false }),
    openProjectInSplit: async () => ({ ok: false }),
    closeSplit: noop,
    hideEmbed: noop,
    killProjectServer: async () => ({ cancelled: true }),
    saveProjectOrder: noop,
    reportLayout: noop,
    setEmbedRightOffset: noop,
    openUrlExternal: (url) => { try { window.open(url, '_blank', 'noopener'); } catch (e) {} },
    enterDesktopMode: noop,
    pickFolder: async () => null,
    saveSetup: async () => ({ ok: true }),
    dismissOnboarding: async () => ({ ok: true }),

    // Event subscriptions — never fire; return a no-op unsubscribe.
    onStatus: unsub,
    onToast: unsub,
    onSplitChanged: unsub,
    onReprobe: unsub,
    onNotification: unsub,
    onGoHome: unsub,
    onDesktopState: unsub,
  };

  // ── Faux app preview ───────────────────────────────────────────────
  const POSTERS = {
    'day-planner': 'day-planner.jpg', 'digest': 'digest.jpg',
    'follows-audit': 'follows-audit.jpg', 'font-manager': 'font-manager.jpg',
    'garden-tracker': 'garden-tracker.jpg', 'igstories-viewer': 'igstories-viewer.jpg',
    'kitchen': 'kitchen.jpg', 'library': 'library.jpg',
    'media-tracker': 'media-tracker.jpg', 'organize-cms': 'organize-cms.jpg',
    'project-sketchbook': 'project-sketchbook.jpg', 'residency-tracker': 'residency-tracker.jpg',
    'atlas': 'map.jpg',
  };
  const BLURBS = {
    'day-planner': 'A daily agenda — calendar events and to-dos in one calm view.',
    'library': 'A personal library of bookmarks and links worth keeping.',
    'organize-cms': 'A lightweight CMS for organizing notes and content.',
    'ereader': 'Read and keep track of your ebook collection.',
    'events-digest': 'A digest of nearby events worth showing up for.',
    'font-manager': 'Browse, preview, and manage a font collection.',
    'email-whiteboard-app': 'Email reimagined as a spatial whiteboard.',
    'email-whiteboard-v2': 'The next iteration of the email whiteboard.',
    'igstories-viewer': 'A quiet, no-feed way to catch up on stories.',
    'daily-journal': 'A simple, private daily journal.',
    'kitchen': 'Recipes, meal planning, and what is for dinner.',
    'media-tracker': 'Track films, shows, and books in one place.',
    'digest': 'A unified digest of messages across services.',
    'residency-tracker': 'Track art residencies, grants, and open calls.',
    'atlas': 'A personal map of places worth remembering.',
    'garden-tracker': 'Keep tabs on your plants and garden.',
    'project-sketchbook': 'A sketchbook for ideas and ongoing projects.',
    'sheet-music-tracker': 'Organize and practice your sheet music.',
    'follows-audit': 'Audit who you follow across social accounts.',
    'whiteboard-tasks': 'Tasks laid out on a spatial whiteboard.',
    'job-search': 'Track job applications, leads, and follow-ups.',
  };
  const ICONS = {
    'ereader': '📖', 'events-digest': '🎟️', 'email-whiteboard-app': '📥',
    'email-whiteboard-v2': '📥', 'daily-journal': '✍️', 'sheet-music-tracker': '🎼',
    'whiteboard-tasks': '✅', 'job-search': '💼',
  };

  let overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'demoPreview';
    overlay.className = 'preview';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="preview-card">' +
        '<div class="preview-shot"></div>' +
        '<div class="preview-body">' +
          '<p class="preview-eyebrow">Preview</p>' +
          '<h2 class="preview-title"></h2>' +
          '<p class="preview-blurb"></p>' +
          '<p class="preview-note">This is a static preview. In the real Misen, ' +
          'clicking a piece launches the app live — each one runs locally on its ' +
          'own machine, no cloud.</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hidePreview(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePreview(); });
    return overlay;
  }

  function hidePreview() {
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => { overlay.hidden = true; }, 200);
  }

  window.__demoPreview = function (projectId) {
    const proj = PROJECTS.find((p) => p.id === projectId);
    const o = ensureOverlay();
    const shot = o.querySelector('.preview-shot');
    o.querySelector('.preview-title').textContent = (proj && proj.title) || projectId;
    o.querySelector('.preview-blurb').textContent =
      BLURBS[projectId] || 'A local-first app in the Misen suite.';

    const poster = POSTERS[projectId];
    if (poster) {
      shot.className = 'preview-shot';
      shot.style.backgroundImage = `url("posters/${poster}")`;
      shot.innerHTML = '';
    } else {
      shot.className = 'preview-shot placeholder';
      shot.style.backgroundImage = '';
      shot.innerHTML = `<span class="ph-icon">${ICONS[projectId] || '🪟'}</span>`;
    }
    const close = document.createElement('button');
    close.className = 'preview-close';
    close.setAttribute('aria-label', 'Close preview');
    close.textContent = '×';
    close.addEventListener('click', hidePreview);
    shot.appendChild(close);

    o.hidden = false;
    requestAnimationFrame(() => o.classList.add('show'));
  };
})();
