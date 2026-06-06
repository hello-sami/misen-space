// Misen — brand data + constellation icon renderer
// ─────────────────────────────────────────────────────────────────────
// Single source of truth for the branding system. Each app has:
//   id      — kebab-case id matching projects.json
//   label   — display suffix after "Misen"
//   accent  — unique accent color
//   dots    — constellation positions on the 4×4 Misen grid (col 0-3, row 0-3)
//   lines   — connecting lines [[c,r],[c,r]]
//
// Usable in three ways:
//   1. <script src="misen-brand.js"> in the launcher                 → window.MisenBrand
//   2. require('./misen-brand') from main.js / preload (Node)         → module.exports
//   3. injected into embedded apps via embed-preload.js               → window.MisenBrand

(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (root) root.MisenBrand = lib;
})(typeof window !== 'undefined' ? window : null, function () {
  const PAPER = '#F5F2EC';
  const PAPER_WARM = '#FAF8F3';
  const PAPER_DEEP = '#EFEAE0';
  const INK = '#1A1A1A';
  const INK_SOFT = '#5A5A52';
  const INK_MUTE = '#8A857A';
  const RULE = 'rgba(0,0,0,0.10)';
  const RULE_SOFT = 'rgba(0,0,0,0.06)';
  const MASTER_ACCENT = '#B8541E';

  // ── App catalog ────────────────────────────────────────────────────
  const APPS = [
    { id: 'misen', label: 'Misen', accent: '#B8541E',
      dots: [[0,1,'#C97E0C'],[0,2,'#D85A30'],[0,3,'#256040'],[1,2,'#2C2C2A'],[2,1,'#BA7517'],[2,2,'#7F77DD'],[2,3,'#D4537E']],
      lines: [[[0,1],[0,3]],[[0,1],[1,2]],[[2,1],[1,2]],[[2,1],[2,3]]] },

    { id: 'kitchen', label: 'kitchen', accent: '#B8541E',
      dots: [[0,1],[1,1],[2,1],[3,2]],
      lines: [[[0,1],[2,1]],[[2,1],[3,2]]] },

    { id: 'email-whiteboard-app', label: 'inbox', accent: '#2C4A6B',
      dots: [[0,1],[3,1],[1,2],[2,2],[0,3],[3,3]],
      lines: [[[0,1],[3,1]],[[0,1],[1,2]],[[1,2],[2,2]],[[2,2],[3,1]],[[0,1],[0,3]],[[3,1],[3,3]],[[0,3],[3,3]]] },

    { id: 'email-whiteboard-v2', label: 'inbox v2', accent: '#4A6B8C',
      dots: [[0,1],[3,1],[1,2],[2,2],[0,3],[3,3],[3,0]],
      lines: [[[0,1],[3,1]],[[0,1],[1,2]],[[1,2],[2,2]],[[2,2],[3,1]],[[0,1],[0,3]],[[3,1],[3,3]],[[0,3],[3,3]]] },

    { id: 'whiteboard-tasks', label: 'task', accent: '#6B5B3D',
      dots: [[0,0],[3,0],[0,3],[3,3],[1,2],[2,1]],
      lines: [[[0,0],[3,0]],[[3,0],[3,3]],[[3,3],[0,3]],[[0,3],[0,0]],[[1,2],[2,1]]] },

    { id: 'job-search', label: 'work', accent: '#5C3A1E',
      dots: [[1,0],[2,0],[0,1],[3,1],[0,3],[3,3]],
      lines: [[[1,0],[2,0]],[[1,0],[1,1]],[[2,0],[2,1]],[[0,1],[3,1]],[[0,1],[0,3]],[[3,1],[3,3]],[[0,3],[3,3]]] },

    { id: 'day-planner', label: 'day', accent: '#C97E0C',
      dots: [[1,0],[3,1],[2,3],[0,2],[1,1],[2,1],[1,2],[2,2]],
      lines: [[[1,1],[2,1]],[[2,1],[2,2]],[[2,2],[1,2]],[[1,2],[1,1]]] },

    { id: 'sheet-music-tracker', label: 'score', accent: '#6B4884',
      dots: [[0,0],[3,0],[0,1],[3,1],[0,2],[3,2],[2,3]],
      lines: [[[0,0],[3,0]],[[0,1],[3,1]],[[0,2],[3,2]]] },

    { id: 'residency-tracker', label: 'residency', accent: '#8C3F5C',
      dots: [[1,0],[2,0],[0,2],[3,2],[0,3],[3,3]],
      lines: [[[1,0],[0,2]],[[2,0],[3,2]],[[0,2],[3,2]],[[0,2],[0,3]],[[3,2],[3,3]],[[0,3],[3,3]]] },

    { id: 'project-sketchbook', label: 'sketch', accent: '#4A5C2D',
      dots: [[0,3],[1,2],[2,1],[3,0]],
      lines: [[[3,0],[0,3]]] },

    { id: 'font-manager', label: 'font', accent: '#2C2C2A',
      dots: [[1,0],[2,0],[0,3],[3,3],[1,2],[2,2]],
      lines: [[[1,0],[0,3]],[[2,0],[3,3]],[[1,2],[2,2]]] },

    { id: 'media-tracker', label: 'media', accent: '#D4537E',
      dots: [[0,0],[0,3],[3,1],[3,2]],
      lines: [[[0,0],[0,3]],[[0,0],[3,1]],[[3,1],[3,2]],[[0,3],[3,2]]] },

    { id: 'igstories-viewer', label: 'stories', accent: '#C9486B',
      dots: [[1,0],[2,0],[3,1],[3,2],[2,3],[1,3],[0,2],[0,1]],
      lines: [[[1,0],[2,0]],[[2,0],[3,1]],[[3,1],[3,2]],[[3,2],[2,3]],[[2,3],[1,3]],[[1,3],[0,2]],[[0,2],[0,1]],[[0,1],[1,0]]] },

    { id: 'digest', label: 'digest', accent: '#7F6B3E',
      dots: [[0,0],[2,0],[0,1],[3,1],[0,2],[3,2],[0,3],[2,3]],
      lines: [[[0,0],[2,0]],[[0,1],[3,1]],[[0,2],[3,2]],[[0,3],[2,3]]] },

    { id: 'events-digest', label: 'events', accent: '#8A4F2C',
      dots: [[0,1],[2,1],[0,2],[2,2],[3,1],[3,2]],
      lines: [[[0,1],[2,1]],[[0,2],[2,2]],[[0,1],[0,2]],[[2,1],[2,2]]] },

    { id: 'daily-journal', label: 'diary', accent: '#5C7A8C',
      dots: [[0,1],[3,1],[0,2],[3,2],[0,3],[2,3]],
      lines: [[[0,1],[3,1]],[[0,2],[3,2]],[[0,3],[2,3]]] },

    { id: 'garden-tracker', label: 'garden', accent: '#256040',
      dots: [[1,0],[0,1],[2,1],[1,2],[1,3]],
      lines: [[[1,3],[1,0]],[[1,1],[0,1]],[[1,1],[2,1]]] },

    { id: 'library', label: 'shelf', accent: '#8A6B3F',
      dots: [[0,0],[3,0],[0,1],[3,1],[0,2],[3,2]],
      lines: [[[0,0],[3,0]],[[0,1],[3,1]],[[0,2],[3,2]]] },

    { id: 'ereader', label: 'read', accent: '#3D5A4F',
      dots: [[0,1],[3,1],[1,1],[2,1],[0,3],[3,3],[1,3],[2,3]],
      lines: [[[0,1],[1,1]],[[2,1],[3,1]],[[0,3],[1,3]],[[2,3],[3,3]],[[0,1],[0,3]],[[3,1],[3,3]],[[1,1],[1,3]],[[2,1],[2,3]]] },

    { id: 'follows-audit', label: 'follows', accent: '#6B7547',
      dots: [[1,1],[0,0],[3,0],[0,3],[3,3]],
      lines: [[[1,1],[0,0]],[[1,1],[3,0]],[[1,1],[0,3]],[[1,1],[3,3]]] },

    { id: 'organize-cms', label: 'organize', accent: '#7A6347',
      dots: [[0,0],[1,0],[0,1],[3,1],[0,3],[3,3]],
      lines: [[[0,0],[1,0]],[[1,0],[1,1]],[[0,1],[3,1]],[[0,1],[0,3]],[[3,1],[3,3]],[[0,3],[3,3]]] },

    { id: 'atlas', label: 'map', accent: '#D85A30',
      dots: [[1,0],[2,0],[1,1],[2,1],[1,3]],
      lines: [[[1,0],[2,0]],[[1,1],[2,1]],[[1,0],[1,1]],[[2,0],[2,1]],[[1,1],[1,3]]] },
  ];

  const APPS_BY_ID = APPS.reduce((m, a) => (m[a.id] = a, m), {});
  const MASTER = APPS_BY_ID['misen'];

  function appFor(id) { return APPS_BY_ID[id] || null; }

  // ── Constellation icon → SVG string ───────────────────────────────
  // Pure-string renderer (no React) so it works in renderer.js, the
  // embed-preload, and inside any app that pulls in this script.
  function gridXY(c, r, size) {
    const margin = size * 0.205;
    const step = (size - margin * 2) / 3;
    return [margin + c * step, margin + r * step];
  }

  function constellationSVG(app, opts = {}) {
    if (!app) return '';
    const size = opts.size || 88;
    const showGrid = opts.showGrid !== false;
    const accent = opts.accent || app.accent || MASTER_ACCENT;
    const bg = opts.bg || PAPER;
    const radius = (opts.radius != null ? opts.radius : size * 0.20);
    const dotR = size * 0.062;
    const ghostR = size * 0.045;
    const activeKey = new Set((app.dots || []).map(d => `${d[0]}-${d[1]}`));

    const parts = [];
    parts.push(`<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" fill="${bg}" />`);

    if (showGrid) {
      const ruleColor = 'rgba(0,0,0,0.08)';
      const sw = (size / 220).toFixed(3);
      let g = `<g stroke="${ruleColor}" stroke-width="${sw}">`;
      for (let i = 0; i < 4; i++) {
        const [x] = gridXY(i, 0, size);
        g += `<line x1="${x}" y1="${size*0.07}" x2="${x}" y2="${size*0.93}" />`;
      }
      for (let i = 0; i < 4; i++) {
        const [, y] = gridXY(0, i, size);
        g += `<line x1="${size*0.10}" y1="${y}" x2="${size*0.90}" y2="${y}" />`;
      }
      g += '</g>';
      parts.push(g);
    }

    const ruleLine = 'rgba(0,0,0,0.15)';
    const lineSw = (size / 70).toFixed(3);
    let lg = `<g stroke="${ruleLine}" stroke-width="${lineSw}" stroke-linecap="round">`;
    for (const seg of (app.lines || [])) {
      const [a, b] = seg;
      const [x1, y1] = gridXY(a[0], a[1], size);
      const [x2, y2] = gridXY(b[0], b[1], size);
      lg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    }
    lg += '</g>';
    parts.push(lg);

    if (showGrid) {
      const gw = (size / 160).toFixed(3);
      let gg = '<g>';
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          if (activeKey.has(`${c}-${r}`)) continue;
          const [x, y] = gridXY(c, r, size);
          gg += `<circle cx="${x}" cy="${y}" r="${ghostR}" fill="rgba(0,0,0,0.04)" stroke="rgba(0,0,0,0.13)" stroke-width="${gw}" />`;
        }
      }
      gg += '</g>';
      parts.push(gg);
    }

    let dg = '<g>';
    for (const d of (app.dots || [])) {
      const [x, y] = gridXY(d[0], d[1], size);
      const fill = d[2] || accent;
      dg += `<circle cx="${x}" cy="${y}" r="${dotR}" fill="${fill}" />`;
    }
    dg += '</g>';
    parts.push(dg);

    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  }

  // ── Wordmark HTML ─────────────────────────────────────────────────
  // "Misen <suffix>" with the suffix in the accent. Mirrors the React
  // <MisenMark> in the design, simplified to the default 'space' separator
  // (the system Sami chose).
  function wordmarkHTML(app, opts = {}) {
    if (!app) return '';
    const accent = opts.accent || app.accent || MASTER_ACCENT;
    const ink = opts.ink || 'currentColor';
    const sepColor = opts.sepColor || 'rgba(0,0,0,0.30)';

    if (app.id === 'misen' || !app.label || app.label === 'Misen') {
      return `<span class="mwm" style="color:${ink}">Misen</span>`;
    }
    return (
      `<span class="mwm">` +
        `<span class="mwm-pre" style="color:${ink}">Misen</span>` +
        `<span class="mwm-sep" style="color:${sepColor}"> </span>` +
        `<span class="mwm-suf" style="color:${accent}">${app.label}</span>` +
      `</span>`
    );
  }

  return {
    APPS, APPS_BY_ID, MASTER, MASTER_ACCENT,
    PAPER, PAPER_WARM, PAPER_DEEP, INK, INK_SOFT, INK_MUTE, RULE, RULE_SOFT,
    appFor, constellationSVG, wordmarkHTML,
  };
});
