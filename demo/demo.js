/* misen.space/demo — web bootstrap for the Misen room diorama.
 *
 * The real Misen launcher is an Electron app: clicking a piece launches a
 * local web server and embeds it. On the public web there are no local
 * servers, so this bootstrap:
 *   1. Stubs window.miseAPI so nothing that expects the Electron bridge throws.
 *   2. Initializes the diorama (window.MiseRoom) with the project list.
 *   3. Replaces "launch app" with a faux preview: a static screenshot
 *      (the same poster art the diorama hangs on the walls) + a short blurb.
 */
(function () {
  'use strict';

  // ── 1. Stub the Electron bridge ────────────────────────────────────
  // diorama.js itself doesn't touch window.miseAPI, but stub it defensively
  // so any stray reference resolves to a harmless no-op instead of throwing.
  if (!window.miseAPI) {
    const noop = () => {};
    const noopAsync = () => Promise.resolve(null);
    window.miseAPI = new Proxy({}, {
      get: () => (...args) =>
        (args.length && typeof args[args.length - 1] === 'function') ? noop() : noopAsync(),
    });
  }

  // ── 2. Faux preview content ────────────────────────────────────────
  // appId → screenshot file under posters/. Apps without a screenshot fall
  // back to an icon placeholder.
  const POSTERS = {
    'day-planner': 'day-planner.jpg',
    'digest': 'digest.jpg',
    'follows-audit': 'follows-audit.jpg',
    'font-manager': 'font-manager.jpg',
    'garden-tracker': 'garden-tracker.jpg',
    'igstories-viewer': 'igstories-viewer.jpg',
    'kitchen': 'kitchen.jpg',
    'library': 'library.jpg',
    'media-tracker': 'media-tracker.jpg',
    'organize-cms': 'organize-cms.jpg',
    'project-sketchbook': 'project-sketchbook.jpg',
    'residency-tracker': 'residency-tracker.jpg',
    'atlas': 'map.jpg',
  };

  // appId → one-line blurb for the preview caption.
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

  let projectsById = {};

  function showPreview(appId) {
    const proj = projectsById[appId];
    const title = (proj && proj.title) || appId;
    const blurb = BLURBS[appId] || 'A local-first app in the Misen suite.';
    const poster = POSTERS[appId];

    const overlay = document.getElementById('preview');
    const shot = overlay.querySelector('.preview-shot');
    overlay.querySelector('.preview-title').textContent = title;
    overlay.querySelector('.preview-blurb').textContent = blurb;

    if (poster) {
      shot.className = 'preview-shot';
      shot.style.backgroundImage = `url("posters/${poster}")`;
      shot.innerHTML = '';
    } else {
      shot.className = 'preview-shot placeholder';
      shot.style.backgroundImage = '';
      shot.innerHTML = `<span class="ph-icon">${ICONS[appId] || '🪟'}</span>`;
    }
    // close button lives inside .preview-shot so it sits over the image
    const close = document.createElement('button');
    close.className = 'preview-close';
    close.setAttribute('aria-label', 'Close preview');
    close.textContent = '×';
    close.addEventListener('click', hidePreview);
    shot.appendChild(close);

    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('show'));
  }

  function hidePreview() {
    const overlay = document.getElementById('preview');
    overlay.classList.remove('show');
    setTimeout(() => { overlay.hidden = true; }, 200);
  }

  // ── 3. Boot ────────────────────────────────────────────────────────
  function setStatus(html) {
    const el = document.getElementById('demoStatus');
    if (!el) return;
    if (html === null) { el.remove(); return; }
    el.innerHTML = html;
  }

  function start(projects) {
    projectsById = {};
    projects.forEach((p) => { projectsById[p.id] = p; });

    const container = document.getElementById('roomContainer');
    if (typeof window.MiseRoom === 'undefined' || typeof window.THREE === 'undefined') {
      setStatus('The 3D view could not load (scripts missing).');
      return;
    }

    window.MiseRoom.init({
      container,
      projects,
      onOpenProject: (appId) => showPreview(appId),
      onLaunchStart: () => {},
      onPieceContextMenu: () => {},
    });

    // Drop the loading status once the scene reports ready (poll briefly).
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (window.MiseRoom.isReady && window.MiseRoom.isReady()) {
        setStatus(null);
        clearInterval(t);
      } else if (tries > 60) {        // ~9s; WebGL failed or very slow
        clearInterval(t);
        setStatus(null);
      }
    }, 150);

    // Backdrop + Esc close the preview.
    const overlay = document.getElementById('preview');
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hidePreview(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePreview(); });
  }

  fetch('projects.json')
    .then((r) => r.json())
    .then((data) => start(data.projects || []))
    .catch(() => setStatus('Could not load the project list.'));
})();
