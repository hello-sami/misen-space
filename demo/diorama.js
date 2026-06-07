/**
 * MiseDiorama — small fixed-camera "diorama" home view for Misen.
 *
 * Exposes the `window.MiseRoom` API surface so renderer.js drives it without
 * knowing the implementation.
 *
 * Architecture:
 *   - Fixed camera, no orbit. Four bound surfaces: floor, wall, desk, shelf.
 *   - Each surface owns its own slot scheme. No global collision.
 *   - Items declare which surface they bind to + a footprint.
 *   - Each app maps to one item type via the APPS array. App-tagged items
 *     launch their project on click; decorative items do nothing in normal
 *     mode (only removable in edit mode).
 *
 * Public API (window.MiseRoom):
 *   init({ container, projects, onOpenProject, onLaunchStart, ... })
 *   updateProjects(projects)
 *   show() / hide() / isReady()
 *   endLaunchTransition()    — no-op stub
 *   refreshModels()          — reload GLB cache
 *
 * Persistence:  localStorage key  "misen.dioramaLayout" (schemaVersion field
 *               inside the JSON migrates the layout forward; see §15)
 *
 * ─────────────────────────────────────────────────────────────────────
 *  TABLE OF CONTENTS — search "§N" to jump
 * ─────────────────────────────────────────────────────────────────────
 *  §1   App config            APPS array (edit me to add/move apps)
 *  §2   Room dimensions       ROOM size, FACTORY_SCALE, PALETTE
 *  §3   Module state          let vars, GLB cache, runtime state
 *  §4   Mesh helpers          mat / box / cyl / sph / group / place
 *  §5   Item factories        the 3D pieces (grouped by category)
 *      §5a  Floor: appliances & electronics
 *      §5b  Floor: work surfaces (desks, tables, easel)
 *      §5c  Floor: storage & shelves
 *      §5d  Floor: instruments & decor
 *      §5e  Wall
 *      §5f  Tabletop trinkets
 *  §6   Wrappers              makeScaled / makeFromGlb
 *  §7   ITEMS catalog         factories + footprints + tabletop tiers
 *  §8   Surfaces              Floor / Wall / Tabletop slot grids
 *  §9   Room geometry         physical desk + shelf + walls
 *  §10  Placement engine      placePersisted / auto-placer
 *  §11  Slot markers          edit-mode slot highlights
 *  §12  UI overlays + CSS     top bar, catalog, modal markup
 *  §13  Modal + move mode     launch popup, single-piece relocate
 *  §14  Pointer handling      raycast hit-tests, hover, click
 *  §15  Persistence           localStorage save/load
 *  §16  Resize / animation / public API
 */
(function (global) {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // §1 · App config — see diorama.config.js (window.MiseDioramaConfig).
  //      Edit THAT file to add, move, or remove an app in the diorama.
  // ══════════════════════════════════════════════════════════════════
  const { APPS, ROOM, FACTORY_SCALE_FLOOR, FACTORY_SCALE_WALL, RIGHT_WINDOW, PALETTE } =
    global.MiseDioramaConfig;

  // Derived lookups — kept for the rest of the file's call sites.
  // Edit APPS above; these regenerate automatically.
  const APP_TO_ITEM = Object.fromEntries(APPS.map(a => [a.app, a.item]));
  const PREFERRED_SLOTS = Object.fromEntries(
    APPS.filter(a => a.surface && a.slot).map(a => [a.app, { surface: a.surface, slot: a.slot }])
  );


  // ══════════════════════════════════════════════════════════════════
  // §2 · Room dimensions + palette
  // ══════════════════════════════════════════════════════════════════
    // Room dimensions, scales, window cutout, and palette live in
    // diorama.config.js (destructured at the top of §1 above).

  // ══════════════════════════════════════════════════════════════════
  // §3 · Module state
  // ══════════════════════════════════════════════════════════════════
  let initialized = false;
  let container = null;
  let canvas = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  // ── Responsive framing ───────────────────────────────────────────
  // BASE_FOV is the vertical FOV the back-wall gallery was hand-tuned at
  // (see setupScene); DESIGN_ASPECT is the canvas aspect (w/h) it was
  // framed for. `baseFov` is the live source of truth the debug tools
  // edit — the actual camera.fov is DERIVED from it on every resize by
  // applyResponsiveFov(). Narrower-than-design windows widen the FOV
  // ("fit: contain") so the gallery's outer columns never crop; wider
  // windows keep BASE_FOV exactly, preserving the telephoto look.
  // 72° FOV — a moderate wide angle that frames the home-studio room
  // naturally without the fish-eye distortion of the earlier 120°
  // pass. Side walls (incl. the right wall window) still wrap into
  // the edges from the front-of-room camera position. Tune in the
  // in-app camera debugger (press `C`).
  const BASE_FOV = 52.0;
  const DESIGN_ASPECT = 1.5;   // tune by eye; at/above this, FOV stays at base
  const MAX_FOV = 60.0;        // ceiling so ultra-narrow windows don't zoom to nothing
  let baseFov = BASE_FOV;
  // (All post-processing removed — scene renders direct-to-canvas via
  // renderer.render. composer/ssaoPass kept as nulls for any code paths
  // that still check them defensively.)
  let composer = null;
  let ssaoPass = null;
  let _envMap = null;

  // Light + material refs captured during scene setup so the lighting
  // debugger can mutate them in real time.
  const _lights = {
    ambient: null,
    winLight: null,    winHelper: null,
    ceilLight: null,   ceilHelper: null,
    fillLight: null,   fillHelper: null,
    wallMat: null,
    sky: null,
  };

  let world = null;
  let projects = [];
  let onOpenProjectCb = null;
  let onLaunchStartCb = null;
  let onPieceContextMenuCb = null;

  let SURFACES = null;
  let ITEMS = null;
  const GLB_CACHE = {};
  const state = {
    armedItem: null,
    slotMarkers: [],
    hoverMarker: null,
    // Per-frame set of markers currently visible (opacity > 0). Avoids
    // walking the full slotMarkers array each pointermove just to zero
    // the opacity of inactive ones — with 200+ markers in the fine
    // grid, that work shows up as drag jank. Resetting only this small
    // set (typically 0-2 items) keeps pointermove cheap.
    activeMarkers: [],
    // The top-level placed mesh currently under the cursor (or null).
    // Mutate via setHoveredMesh() — kept as a setter for symmetry with
    // the other hover-related state changes.
    hoveredMesh: null,
    // appId of the app currently "linked" — i.e. the one the side app-list
    // and the 3D launcher object are jointly spotlighting. Set by hovering
    // EITHER the object (onPointerMove) OR its name in the side list. Drives
    // the list-row highlight, the object's emissive glow, and the connector
    // line between the two. Cleared (null) when neither is hovered. See
    // setLinkedApp() / updateConnector() / rebuildAppList() in §14.
    linkedAppId: null,
    placements: [],   // { placementId, itemId, surface, slot, appId? }
    // When set, the user is in single-piece move mode triggered from the
    // app modal's "Move" button. The piece has been temporarily removed
    // from the scene; if the user cancels (Esc / click-outside), we
    // restore it to its original slot. If they click a valid slot, we
    // re-place there with the same appId.
    movingPiece: null,  // { itemId, surface, slot, appId }
    // When the user arms an item from the catalog and that item is bound
    // to an app launcher (e.g. glbLaptop → job-search), this holds the
    // appId the upcoming placement should claim. Cleared on commit /
    // cancel via disarm(). Decorative arms leave this null.
    armedAppId: null,
    // Drag-to-move (sticky-grab) state. Mousedown on a placed piece sets
    // dragCandidate; if the cursor moves > DRAG_THRESHOLD_PX before
    // pointerup, the candidate is promoted to heldPiece and follows the
    // cursor freely (mouseup is then ignored). The next pointerdown on the
    // canvas drops the held piece at lastValidSlot. If pointerup happens
    // before the threshold, it's a plain click — the launch modal opens.
    dragCandidate: null, // { startX, startY, placement }
    // heldPiece: the piece currently following the cursor. Three entry
    // points spawn into held mode:
    //   1. drag-pickup of an existing placement (pickUpHeld)
    //   2. modal Move → pickUpHeld of the clicked placement
    //   3. catalog Add → spawnHeldFromCatalog (isNew: true)
    // For (1) and (2), originalSurface/originalSlot point at where the
    // piece came from, so cancelHeld can restore it. For (3) there's no
    // origin — isNew = true and drop pushes a 'place' command instead of
    // 'move'; cancel/remove just discard.
    //
    // mesh.position.x/z are written directly by onPointerMove as the
    // cursor moves. targetY carries the Y so the animation loop can
    // layer a bob on top without losing the resting height.
    heldPiece: null,     // { def, mesh, isNew?, originalSurface?, originalSlot?,
                         //   originalRotation, currentRotation, appId,
                         //   lastValidSurface, lastValidSlot, targetY,
                         //   pickedUpTrinkets }
  };

  // Cursor-pixel distance before a mousedown-on-piece turns into a drag
  // (anything below this is treated as a click → launch modal).
  const DRAG_THRESHOLD_PX = 6;
  // World-units the held piece floats above its snap target.
  const HELD_LIFT = 0.18;
  // Held tilt — was previously a small "lifted" rotation applied to
  // floor pieces while held, intended as a held-piece flourish. Zeroed
  // out per user feedback: it made the desk look skewed during drag.
  // Wall/tabletop are kept upright regardless.
  const HELD_TILT_X = 0;
  const HELD_TILT_Z = 0;

  let raycaster = null;
  let mouse = null;
  let markerGroup = null;

  let appHoverEl = null;     // floating "title" tooltip for apps
  let modalEl = null;        // launch / move confirmation modal
  let modalOpen = false;
  let winMenuEl = null;      // window popup — Blinds / Change scene
  let winMenuOpen = false;
  let wallMenuEl = null;     // wall popup — paint color picker
  let wallMenuOpen = false;
  // Wall meshes — geometry is rebuilt with real rectangular holes
  // (ShapeGeometry) for each window placement. See rebuildWallGeometry()
  // and glbWindow's `cutsThroughWall` flag. _rightWallMesh exists so
  // wall-inference (in onPointerMove) can raycast against it the same
  // way as back/left — needed for smooth wall drag.
  let _backWallMesh = null;
  let _leftWallMesh = null;
  let _rightWallMesh = null;
  // Interactive right-wall blinds. Built in setupRoom right after the
  // window casing block; raised/lowered via the "Blinds" action in the
  // window popup that a click on the window opens (see onPointerDown →
  // openWindowMenu). Each frame the loop lerps `currentTilt` toward
  // `targetTilt` and writes it to every slat's rotation.z. Null until
  // setupRoom runs.
  //   { slats: Mesh[], hitPlane: Mesh, openTilt, closedTilt,
  //     currentTilt, targetTilt, isOpen }
  let _blinds = null;
  let heldBarEl = null;      // floating Rotate / Cancel toolbar (held mode)
  let heldHintEl = null;     // bottom-of-canvas instructional pill (held mode)

  // Side panel listing every placed launcher app as plaintext, plus the
  // SVG overlay that draws a connector line from a hovered name to its
  // 3D object (and vice versa). See §14 setLinkedApp / updateConnector.
  let appListEl = null;
  let overlayRoot = null;    // .mainBody — coord origin for the list + line
  let connectorSvgEl = null;
  let connectorLineEl = null;
  let connectorDotEl = null;
  // Object-glow easing: the emissive highlight eases in/out over a few
  // frames instead of snapping. _glowMesh is the mesh currently carrying
  // (or releasing) the glow; _glowT eases toward _glowTarget each frame in
  // updateGlow(). See setLinkedApp / setMeshHighlightAmount in §14.
  let _glowMesh = null;
  let _glowT = 0;
  let _glowTarget = 0;
  // Mirror cursor-reflection overlay: a clip box matching the mirror glass's
  // on-screen quad, holding a flipped pointer glyph that tracks the real
  // cursor mirrored across the glass's centerline. See updateMirrorReflection.
  let mirrorClipEl = null;
  let mirrorCursorEl = null;
  let _lastCursorPx = null;   // {x,y} canvas-relative, for per-frame re-aim
  // Small lead-in before the glow starts ramping, so brushing across items
  // doesn't flash. Kept in sync with the CSS transition-delay on the row
  // highlight + connector line (HOVER_DELAY_MS below). Seconds.
  let _glowDelay = 0;
  const GLOW_DELAY = 0.05;

  let resizeObserver = null;
  let animFrame = null;
  let pendingDefaults = false;
  // Shadow maps are expensive (3 lights, one at 4096²) and the scene is
  // static apart from blinds tweens and edit-mode geometry changes, so we
  // disable per-frame shadow re-rendering (renderer.shadowMap.autoUpdate =
  // false in setupScene) and re-render shadows only on frames where this
  // flag is set. markShadowsDirty() requests one refreshed frame; the
  // animation loop also forces a refresh while the blinds are tweening or a
  // piece is being dragged. Camera parallax does NOT need a shadow refresh
  // (directional-light shadow cameras are fixed; only the view moves).
  let shadowsDirty = true;
  // Number of upcoming frames to force shadow re-renders for. Some scene
  // changes (especially move + replace flows that detach an old mesh and
  // build a fresh one) leave a ghost in the shadow map if we only force
  // a single frame's update — the new mesh's world matrix hasn't settled
  // yet on that frame, so the rerendered shadow still reflects the
  // pre-move state. Holding the dirty flag for a few frames gives the
  // matrix world / shadow camera time to converge.
  let shadowRefreshFrames = 0;
  function markShadowsDirty() { shadowsDirty = true; shadowRefreshFrames = 3; }

  // Desktop-surface support: when true, the scene's background and the WebGL
  // clear color both go fully transparent, so any part of the frame without
  // room geometry (e.g. the space above the back wall, or out the window)
  // reveals whatever is behind the Electron window — the real desktop wallpaper.
  // Called by renderer.js from the desktop-mode state. Safe to call before the
  // scene exists: the desired value is stashed and applied once init() runs.
  let _bgTransparent = false;
  function setBackgroundTransparent(on) {
    _bgTransparent = !!on;
    if (!renderer || !scene || typeof THREE === 'undefined') return;
    if (_bgTransparent) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    } else {
      scene.background = new THREE.Color(PALETTE.bg);
      renderer.setClearColor(new THREE.Color(PALETTE.bg), 1);
    }
    markShadowsDirty();
  }

  // Free GPU resources for a detached mesh subtree. Call this whenever a
  // mesh leaves the scene for good — edit-mode delete, drag-replace,
  // updateProjects() prune, GLB hot-swap. Without it the geometries /
  // materials / textures leak on the GPU.
  //
  // CRITICAL: GLB instances are produced by `cached.clone(true)`, which
  // SHARES the cached root's geometry across every clone (only the material
  // is re-cloned per instance — see makeFromGlb). So for a mesh tagged with
  // userData.glbSourcePath we must dispose ONLY its per-instance material and
  // leave the geometry alone, or we'd corrupt the cache and every sibling
  // instance. Procedural items (box/cyl/sph/withOutline) build fresh geometry
  // AND material per factory call, so those are safe to dispose in full.
  function disposeObject(obj) {
    if (!obj) return;
    obj.traverse(o => {
      // Stop any per-instance timers the factory installed (e.g. the
      // day-planner poster's day-roll interval) before freeing GPU state —
      // otherwise the interval keeps its CanvasTexture/canvas alive.
      if (o.userData && o.userData._dayRollInterval != null) {
        clearInterval(o.userData._dayRollInterval);
        o.userData._dayRollInterval = null;
      }
      const isSharedGlbGeom = o.userData && o.userData.glbSourcePath;
      if (!isSharedGlbGeom && o.geometry && typeof o.geometry.dispose === 'function') {
        o.geometry.dispose();
      }
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (!m) continue;
        // Dispose any texture maps the material holds before the material.
        for (const v of Object.values(m)) {
          if (v && v.isTexture && typeof v.dispose === 'function') v.dispose();
        }
        if (typeof m.dispose === 'function') m.dispose();
      }
    });
  }

  // Cursor parallax — base camera position/target are captured once after
  // initRenderer; each frame the camera nudges a fraction of these ranges
  // toward the cursor's NDC, then re-aims at the (fixed) base target so the
  // diorama "sways" without losing focus. Values are world units; ranges
  // were chosen relative to the ~7-unit eye→target distance to read as a
  // gentle peek, not a swing. See updateParallax() / onPointerMove().
  // Camera parallax — the camera position nudges a tiny amount toward
  // the cursor each frame, then re-aims at the (fixed) base target so
  // the diorama "sways" without losing focus. Combined with the
  // pushed-back sky (see SKY_DEPTH in setupRoom), this reads as
  // genuine depth through the window — far objects parallax less than
  // near ones because they're farther from the moving camera.
  // Ranges are world units at the limits of the cursor NDC range
  // [-1, 1]. Keep small — the goal is "I almost don't notice, but
  // the room feels alive."
  // PARALLAX_RANGE_X/Y are `let` (not `const`) so the lighting
  // debugger can adjust them at runtime. PARALLAX_LERP_RATE stays
  // const — the smoothing rate isn't a perceptual knob worth
  // exposing.
  // Cursor parallax disabled (both ranges 0) — the camera stays locked and no
  // longer drifts toward the pointer. Bump these in the lighting debugger if you
  // ever want the subtle "room feels alive" peek back.
  let PARALLAX_RANGE_X = 0.000;
  let PARALLAX_RANGE_Y = 0.000;
  const PARALLAX_LERP_RATE = 5.0;
  let _parallaxBasePos = null;
  let _parallaxBaseTarget = null;
  let _parallaxTargetX = 0;
  let _parallaxTargetY = 0;
  let _parallaxX = 0;
  let _parallaxY = 0;

  // Animated sky — set in setupRoom() to an update(dt) function that
  // advances drifting clouds on the sky canvas texture each frame.
  // Null until setupRoom has run; the render loop calls it optionally.
  let _skyUpdate = null;

  // Light + material references, populated in setupRoom(). The
  // lighting debugger (§19) grabs these to mutate intensity, color,
  // shadow radius etc. in real time. Helpers are added but hidden
  // by default; the debugger toggles their .visible flag.
  // Layout persistence — stable key, with a `schemaVersion` field inside
  // the JSON so future schema changes migrate forward (see migrate() at
  // §15) instead of resetting the user's layout. Pre-versioning, we
  // bumped the key itself (v7, v8…) and threw out stale data; old keys
  // are auto-imported on first load via LEGACY_STORAGE_KEYS.
  const STORAGE_KEY = 'misen.dioramaLayout';
  const CURRENT_SCHEMA = 15;
  const LEGACY_STORAGE_KEYS = ['misen.dioramaLayout.v8'];

  // Wall paint color — clicking any wall opens a color picker that
  // repaints all three walls together (they share one material). The
  // chosen hex is persisted separately from the layout so it survives
  // reloads. DEFAULT_WALL_COLOR mirrors the wallMat hex set in setupRoom;
  // keep the two in sync if the factory default ever changes.
  const WALL_COLOR_KEY = 'misen.dioramaWallColor.v1';
  const DEFAULT_WALL_COLOR = '#1c2b22';
  // Curated presets for the picker. Default first so "Reset" reads as
  // "back to the deep sage." Warm gallery off-white, sage, clay, slate,
  // blush, and ink give a spread of light/dark and warm/cool.
  const WALL_COLOR_PRESETS = [
    { hex: '#1c2b22', name: 'Deep sage (default)' },
    { hex: '#e0d8c4', name: 'Warm off-white' },
    { hex: '#8a9a82', name: 'Sage' },
    { hex: '#b08868', name: 'Clay' },
    { hex: '#5a6472', name: 'Slate' },
    { hex: '#d9b5a8', name: 'Blush' },
    { hex: '#2a2620', name: 'Ink' },
  ];
  function loadWallColor() {
    try {
      const v = localStorage.getItem(WALL_COLOR_KEY);
      if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
    } catch (e) {}
    return DEFAULT_WALL_COLOR;
  }
  function saveWallColor(hex) {
    try { localStorage.setItem(WALL_COLOR_KEY, hex); } catch (e) {}
  }
  // Repaint all walls live. wallMat is shared across back/left/right, so
  // a single color set updates every wall in one frame.
  function applyWallColor(hex) {
    if (_lights.wallMat) _lights.wallMat.color.set(hex);
  }

  // Camera debug mode — press `C` in the running diorama to enter a
  // free-camera editing mode. Drag orbits the camera around the current
  // look-target, scroll wheel zooms, arrow keys pan the target, [/]
  // adjust FOV. An HUD overlay shows the live values plus a Copy button
  // that puts a paste-ready snippet on the clipboard. Press `C` again
  // (or click Done) to exit; changes are ephemeral — paste the snippet
  // into setupScene() to make them permanent. See §17.
  const cameraDebug = {
    enabled: false,
    hudEl: null,
    dragLast: null,
    // Original camera state captured on first entry so Reset works.
    defaults: null,
  };

  // Lighting debugger state — toggled with `L`. Defaults snapshot
  // taken on first entry so Reset can restore them.
  const lightingDebug = {
    enabled: false,
    hudEl: null,
    defaults: null,
  };


  // ══════════════════════════════════════════════════════════════════
  // §4 · Mesh helpers — tiny primitive builders the item factories compose.
  // ══════════════════════════════════════════════════════════════════
  function mat(color, opts = {}) {
    // MeshPhysicalMaterial — superset of MeshStandard with clearcoat support.
    // clearcoat: 0.35 adds a thin lacquer layer that catches the key light
    // as a sharp specular highlight on top of the diffuse colour, giving
    // painted/varnished furniture a real sheen without looking plastic.
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.68,
      metalness: 0.05,
      clearcoat: 0.35,
      clearcoatRoughness: 0.25,
      ...opts
    });
  }
  function metalMat(color) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.7, flatShading: true });
  }
  function emissiveMat(color, em) {
    return new THREE.MeshStandardMaterial({ color, emissive: em, roughness: 0.6, flatShading: true });
  }

  // ── Cartoon outline (inverted-hull) ──────────────────────────────
  // For each furniture mesh we attach a slightly-inflated black sibling
  // with BackSide rendering. The original mesh draws on top, so all you
  // see of the inflated copy is a rim around the silhouette.
  //
  // Knobs: OUTLINE_SCALE controls thickness (relative to the mesh's
  // own scale), OUTLINE_COLOR the ink color. Tweak in one place.
  // Cached material so all outlines share GPU state.
  const OUTLINE_SCALE = 1.04;
  const OUTLINE_COLOR = 0x1a1410;
  const _outlineMat = new THREE.MeshBasicMaterial({
    color: OUTLINE_COLOR,
    side: THREE.BackSide,
  });
  // Outlines disabled — kept as a pass-through so box/cyl/sph callers
  // don't need editing. To re-enable, restore the inverted-hull body
  // below (creates a slightly-inflated BackSide sibling and adds it as
  // a child of the mesh).
  function withOutline(mesh, _scale = OUTLINE_SCALE) {
    return mesh;
  }

  function box(w, h, d, color, opts) {
    return withOutline(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts)));
  }
  function cyl(rTop, rBot, h, color, segs = 16, opts) {
    return withOutline(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, segs), mat(color, opts)));
  }
  function sph(r, color, segs = 12, opts) {
    return withOutline(new THREE.Mesh(new THREE.SphereGeometry(r, segs, segs), mat(color, opts)));
  }
  function place(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }
  function group(...meshes) {
    const g = new THREE.Group();
    meshes.forEach(m => { if (m) { m.castShadow = true; m.receiveShadow = true; g.add(m); } });
    return g;
  }

  // ══════════════════════════════════════════════════════════════════
  // §5 · Item factories
  // ══════════════════════════════════════════════════════════════════
  //
  // Each factory takes an accent `color` and returns a Group whose origin
  // (y=0) is the bottom of the piece, so it sits cleanly on its surface.
  // Floor & wall factories get scaled/wrapped by makeScaled in §6 before
  // landing in the §7 ITEMS catalog. Tabletop trinkets are built at final
  // size and skip the wrapper.
  //
  // Footprint notes in the comments below are in cells (floor/wall grid
  // units), defaulting to 1×1 when not specified. The bigger ones are
  // also declared as `footprint:` in §7.

  // ── §5b · Wall: floating shelf ───────────────────────────────────
  // Single floating shelf — one clean wall-mounted plank, no visible
  // supports (hardware is hidden inside the wall). Wall-item coordinate
  // space: x = along the wall, z = protrudes into room, y = vertical.
  // The slot anchor is the mesh origin; shelf board sits at y=0.
  function makeFloatingWallShelf(color) {
    const meshes = [];
    const W = 1.55;   // board width  (spans 2 left-wall cells × 0.85 m)
    const D = 0.22;   // board depth  (protrudes from wall)
    const T = 0.04;   // board thickness

    // Main board — warm pine
    meshes.push(place(box(W, T, D, 0xc4956a), 0, 0, D / 2));
    // Subtle shadow line on the underside
    meshes.push(place(box(W, 0.007, D, 0x9a6e48), 0, -T / 2 - 0.003, D / 2));

    return group(...meshes);
  }

  // ── §5c · Wall: corkboard, calendar, posters, world map ─────────
  function makeCorkboard(color) {
    const board = place(box(1.6, 1.2, 0.08, 0xc89668), 0, 1.6, 0);
    const frame = place(box(1.7, 1.3, 0.04, color), 0, 1.6, -0.03);
    const colors = [0xfff066, 0xffb6c1, 0x90ee90, 0x87ceeb];
    const notes = [];
    for (let i = 0; i < 5; i++) {
      const n = place(box(0.28, 0.28, 0.02, colors[i % colors.length]),
        -0.5 + (i % 3) * 0.45, 1.7 - Math.floor(i / 3) * 0.4, 0.06);
      notes.push(n);
    }
    return group(board, frame, ...notes);
  }
  // Framed poster — wall art that sits inside a single wall cell.
  // Built at FINAL world size (no makeScaled wrapper) so each instance
  // can carry its own art-style + palette via opts.
  //   opts.w, opts.h     — outer poster dimensions (default fits a left-
  //                        wall cell with margin: 0.55 × 0.42)
  //   opts.frame         — frame color (dark wood by default)
  //   opts.mat           — paper-mat border color (cream by default)
  //   opts.art           — array of 1+ colors used by the art style
  //   opts.style         — 'horizon' | 'stripes' | 'circle'
  function makeFramedPoster(opts) {
    opts = opts || {};
    const W = opts.w || 0.55;
    const H = opts.h || 0.42;
    const D = 0.035;
    const frameColor = opts.frame || 0x2a2218;
    const matColor   = opts.mat   || 0xf2ead6;
    const artColors  = opts.art   || [0xd97a5f, 0xefe2c8, 0x3d5a80];
    const style      = opts.style || 'stripes';

    const meshes = [];
    // Outer frame
    meshes.push(box(W, H, D, frameColor));
    // Paper mat border (slightly proud of the frame face)
    const matBorder = 0.04;
    const matBoard = box(W - matBorder * 2, H - matBorder * 2, D * 0.5, matColor);
    matBoard.position.z = D * 0.30;
    meshes.push(matBoard);
    // Art region
    const artBorder = 0.08;
    const artW = Math.max(0.01, W - artBorder * 2);
    const artH = Math.max(0.01, H - artBorder * 2);

    if (style === 'horizon') {
      // Stacked horizontal color bands — landscape/abstract feel
      const bandH = artH / artColors.length;
      for (let i = 0; i < artColors.length; i++) {
        const y = artH / 2 - (i + 0.5) * bandH;
        const band = box(artW, bandH, 0.005, artColors[i]);
        band.position.set(0, y, D * 0.55);
        meshes.push(band);
      }
    } else if (style === 'circle') {
      // Solid background + single contrast disc — bold graphic poster
      const bg = box(artW, artH, 0.005, artColors[0]);
      bg.position.z = D * 0.55;
      meshes.push(bg);
      const cR = Math.min(artW, artH) * 0.35;
      const circle = new THREE.Mesh(
        new THREE.CircleGeometry(cR, 24),
        mat(artColors[1] || 0xffffff)
      );
      circle.position.z = D * 0.58;
      meshes.push(circle);
    } else {
      // Vertical color stripes (default)
      const stripeW = artW / artColors.length;
      for (let i = 0; i < artColors.length; i++) {
        const x = -artW / 2 + (i + 0.5) * stripeW;
        const s = box(stripeW, artH, 0.005, artColors[i]);
        s.position.set(x, 0, D * 0.55);
        meshes.push(s);
      }
    }
    return group(...meshes);
  }
  // 3D wall calendar — a printed blank monthly planner painted onto the
  // FRONT face of a thin slab so it reads as a physical wall calendar
  // with a few centimeters of depth.
  //
  // The texture is drawn procedurally to a canvas — blue grid lines,
  // serif day headers, "MONTH ___" / "YEAR ___" header — so no external
  // image file is required. Side / top / bottom faces get a warm off-
  // white "paper edge" material; only the front face shows the print.
  //
  // Wall coordinate space (see makeFloatingWallShelf): x runs along the
  // wall, +z points into the room, y is vertical. Mesh origin sits on
  // the wall plane; we offset by D/2 so the back face is flush with the
  // wall and the slab sits proud of it.
  function makeWallCalendar3D() {
    // ── Texture: canvas at 800×800 (square, ~equal proportion to the
    // reference template). The aspect must match the box's W:H or the
    // grid will stretch.
    const canvas = document.createElement('canvas');
    canvas.width  = 800;
    canvas.height = 800;
    const ctx = canvas.getContext('2d');

    const BLUE  = '#1f6fb8';
    const BLACK = '#000000';

    // Paper background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 800, 800);

    // MONTH header box + label (top-left)
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 4;
    ctx.strokeRect(22, 22, 440, 80);
    ctx.fillStyle = BLACK;
    ctx.font = '700 56px Georgia, "Times New Roman", serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('MONTH', 42, 62);
    // Blank line where the month name would be written
    ctx.strokeStyle = BLACK;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(210, 82); ctx.lineTo(450, 82); ctx.stroke();

    // YEAR header (top-right)
    ctx.fillText('YEAR', 510, 62);
    ctx.beginPath(); ctx.moveTo(632, 82); ctx.lineTo(778, 82); ctx.stroke();

    // Day-of-week headers
    const days = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
    ctx.font = '600 20px Georgia, "Times New Roman", serif';
    ctx.fillStyle = BLACK;
    ctx.textAlign = 'center';
    const MARGIN = 22;
    const colW = (800 - 2 * MARGIN) / 7;
    const headerY = 140;
    for (let i = 0; i < 7; i++) {
      ctx.fillText(days[i], MARGIN + colW * (i + 0.5), headerY);
    }

    // 6×7 grid
    const gridTop    = 165;
    const gridBottom = 780;
    const rowH = (gridBottom - gridTop) / 6;
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 3;
    for (let r = 0; r <= 6; r++) {
      const y = gridTop + r * rowH;
      ctx.beginPath(); ctx.moveTo(MARGIN, y); ctx.lineTo(800 - MARGIN, y); ctx.stroke();
    }
    for (let c = 0; c <= 7; c++) {
      const x = MARGIN + c * colW;
      ctx.beginPath(); ctx.moveTo(x, gridTop); ctx.lineTo(x, gridBottom); ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // ── Materials. BoxGeometry's six face groups are ordered
    //   [+x (right), -x (left), +y (top), -y (bottom), +z (front), -z (back)]
    // We paint the calendar onto +z (the wall-facing-room normal) and
    // give every other face a warm off-white "paper edge" so the
    // slab's side profile reads as printed paper, not a billboard.
    const sideMat = new THREE.MeshStandardMaterial({
      color: 0xece5d2, roughness: 0.88, metalness: 0,
    });
    const frontMat = new THREE.MeshStandardMaterial({
      map: tex,
      color: 0xffffff,
      roughness: 0.82, metalness: 0,
      toneMapped: false,
    });
    const mats = [sideMat, sideMat, sideMat, sideMat, frontMat, sideMat];

    const W = 0.55;   // slightly inset inside the 3-col / 0.6m wall slot
    const H = 0.55;   // square to match the canvas aspect
    const D = 0.04;   // 4cm: visible depth without looking like a brick
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), mats);
    slab.castShadow = true;
    slab.receiveShadow = true;
    // Push forward so the back of the slab sits on the wall plane
    // rather than half-buried in it.
    slab.position.z = D / 2;

    return group(slab);
  }

  // Framed image panel — loads a JPG/PNG from disk and wraps it in a
  // wooden frame. Used by every "real artwork" wall item (the world
  // map, the kitchen still life, etc.). Texture loads asynchronously;
  // if the file is missing, the panel falls back to a neutral
  // parchment color so the frame still renders cleanly.
  //
  // opts:
  //   path        — texture URL relative to the page (e.g. 'posters/map.jpg')
  //   W, H        — inner panel size in world units. Pick to match the
  //                 image's aspect ratio so the subject doesn't stretch,
  //                 and to fit inside the item's wall slot once the
  //                 frame extends 0.05 beyond each edge.
  //   frameColor  — wooden frame hex (default warm brown).
  // Shared frame + mat + group builder for framed wall art. Both
  // makeImagePoster (texture from a file) and makeCanvasPoster (texture
  // drawn into an offscreen canvas) differ only in how they build the
  // painting material — the museum mat, the proportionally-inset painting
  // panel, and the four wooden frame bars are identical, so they live here.
  //
  //   panelMat   — the painting surface material (caller owns its texture).
  //   W, H       — inner panel size in world units.
  //   frameColor — frame hex. Pure black (default) stays truly black under
  //                any lighting/tone-mapping because 0 × anything = 0; any
  //                non-zero color lifts to visible gray once multiple lights
  //                sum past 1.0 in linear space.
  function framePanel(panelMat, W, H, frameColor = 0x000000) {
    // White mat — fills the frame's inner opening (W × H), sits just behind
    // the painting, and shows as a warm off-white border around it (the
    // painting panel below is inset, museum-style). Warm tone so it doesn't
    // read as harsh against the warm wall.
    const matMaterial = new THREE.MeshStandardMaterial({
      color: 0xf5f0e4,
      roughness: 0.95,
      metalness: 0,
    });
    const matPlane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), matMaterial);
    matPlane.position.set(0, 0, -0.015);
    matPlane.receiveShadow = true;

    // Painting — scaled down proportionally so the mat shows as a ~6%
    // border on each side. Proportional (not absolute) scaling preserves
    // the image's aspect ratio so the subject isn't distorted.
    const PAINTING_SCALE = 0.88;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(W * PAINTING_SCALE, H * PAINTING_SCALE), panelMat);
    panel.position.set(0, 0, -0.005);
    panel.castShadow = false;
    panel.receiveShadow = true;

    // Wooden frame bars, picture-rail style (2.5cm thick, 3.5cm deep).
    //   clearcoat:0     — no varnish sheen washing dark colors toward gray.
    //   roughness:0.95  — fully matte, just enough shading to read as 3D.
    //   metalness:0     — pure dielectric, no metallic reflection.
    // No toneMapped:false here — the frame goes through the renderer's tone
    // mapping like the rest of the room, so it doesn't visually float in
    // front when a tone curve is enabled.
    const frameOpts = { clearcoat: 0, roughness: 0.95, metalness: 0 };
    const fw = W + 0.05, fh = H + 0.05, th = 0.025, dep = 0.035;
    const topBar   = place(box(fw, th, dep, frameColor, frameOpts), 0,  fh / 2 - th / 2, 0);
    const botBar   = place(box(fw, th, dep, frameColor, frameOpts), 0, -fh / 2 + th / 2, 0);
    const leftBar  = place(box(th, fh, dep, frameColor, frameOpts), -fw / 2 + th / 2, 0, 0);
    const rightBar = place(box(th, fh, dep, frameColor, frameOpts),  fw / 2 - th / 2, 0, 0);
    // Shadow casting on the bars is critical: without it the frame is just a
    // colored band and the painting reads as a flat decal. With it the frame
    // casts a gap-shadow on the wall AND a thin inner shadow on the panel.
    [topBar, botBar, leftBar, rightBar].forEach((b) => {
      b.castShadow = true;
      b.receiveShadow = true;
    });

    const g = new THREE.Group();
    g.add(matPlane, panel, topBar, botBar, leftBar, rightBar);
    return g;
  }

  function makeImagePoster(opts) {
    // Default frame is pure black. With multiple lights summing >1.0
    // in linear space, any non-zero color × lighting lifts the result
    // into visible gray (this is why 0x141414 was still reading as
    // mid-charcoal). Pure 0x000000 stays 0 under any lighting because
    // 0 × anything = 0. Subtle Fresnel reflection at grazing edges
    // from the matte PBR material gives the frame just enough surface
    // hint that it doesn't read as a flat decal.
    const { path, W, H, frameColor = 0x000000 } = opts;

    // Painting plane uses MeshStandardMaterial so it responds to the
    // room's lighting — dims on the shadow side, brightens where the
    // window/ceiling/fill catch it, and receives cast shadows from
    // desk items in front of it. The same plane was MeshBasicMaterial
    // earlier (back when ACES was crushing contrast and we needed
    // paintings to bypass lighting entirely); now that the rig is
    // tuned and NoToneMapping is the default, lighting response is
    // the right call.
    //
    // toneMapped:false keeps the painting bypassing any tone-mapping
    // curve the user might re-enable via the lighting debugger — so
    // toggling ACES on doesn't suddenly crush the artworks. roughness
    // 0.9 and metalness 0 are matte-canvas defaults that minimize
    // specular Fresnel highlights at grazing angles.
    // roughness 0.95 to match the frame — at 0.9 the painting picked
    // up a slightly different Fresnel response than the matte frame
    // around it, which read as "two different materials stuck together"
    // rather than "canvas inside a wooden frame."
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc4ad7a, // parchment fallback if the image fails to load
      roughness: 0.95,
      metalness: 0,
      toneMapped: false,
    });

    new THREE.TextureLoader().load(
      path,
      (tex) => {
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        mat.map = tex;
        mat.color.set(0xffffff); // let the texture show at full brightness
        mat.needsUpdate = true;
      },
      undefined,
      () => { /* leave parchment-color fallback if the file isn't there */ }
    );

    return framePanel(mat, W, H, frameColor);
  }

  // Framed canvas panel — same frame + mat structure as makeImagePoster,
  // but the painting texture is drawn by a `paint(ctx, w, h)` callback
  // into an offscreen canvas. The callback is re-run whenever the local
  // calendar day changes, so the texture stays current without a page
  // reload — important for the day-planner poster, which needs to show
  // each viewer's actual today.
  //
  // opts:
  //   paint  — (ctx, w, h) => void. Draws into a 1200×789 canvas.
  //   W, H   — inner panel size in world units (same meaning as makeImagePoster).
  //   frameColor — frame hex (default pure black, matching makeImagePoster).
  function makeCanvasPoster(opts) {
    const { paint, W, H, frameColor = 0x000000 } = opts;

    // Canvas resolution: 1200×789 to match the existing day-planner.jpg
    // dimensions (so swapping in a date-poster doesn't change apparent
    // sharpness or aspect on the wall).
    // Match the panel aspect ratio so the rendered art doesn't stretch —
    // portrait panels get a portrait canvas, landscape stays landscape.
    // 1200px on the longer side keeps the texture sharp without bloating
    // the GPU upload.
    const longSide = 1200;
    const aspect = W / H;
    const CW = aspect >= 1 ? longSide : Math.round(longSide * aspect);
    const CH = aspect >= 1 ? Math.round(longSide / aspect) : longSide;
    const canvas = document.createElement('canvas');
    canvas.width = CW; canvas.height = CH;
    const ctx = canvas.getContext('2d');
    paint(ctx, CW, CH);

    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // Re-run the paint callback once a minute and check whether the
    // local calendar day has rolled over. If so, redraw and flag the
    // texture for re-upload. Cheap: a Date() compare + maybe a canvas
    // redraw, no allocations in the steady state.
    let lastDay = new Date().toDateString();
    const dayRollInterval = setInterval(() => {
      const today = new Date().toDateString();
      if (today === lastDay) return;
      lastDay = today;
      paint(ctx, CW, CH);
      tex.needsUpdate = true;
    }, 60 * 1000);

    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
      toneMapped: false,
    });

    const g = framePanel(mat, W, H, frameColor);
    // Tracked so disposeObject() can clearInterval when this poster is torn
    // down (edit-mode delete, drag-replace, refreshModels swap). Otherwise
    // the interval — and the CanvasTexture/ctx/canvas it closes over — leaks.
    g.userData._dayRollInterval = dayRollInterval;
    return g;
  }

  // Day-planner poster paint routine — runs against the viewer's local
  // Date(), so every person looking at the diorama sees their own today.
  // Layout: weekday across the top, large day-number centered, month +
  // year across the bottom. Cream background matches the room's warm
  // palette.
  function paintTodayPoster(ctx, w, h) {
    const now = new Date();
    const weekday = now.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
    const day = String(now.getDate());
    const monthYear = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase();

    ctx.fillStyle = '#f5f1ea';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#2a2a2a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Scale type to canvas height so portrait and landscape both look
    // balanced — the day-number takes ~45% of the height, the labels
    // ~8%, with the weekday and month each offset ~28% from center.
    const dayPx = Math.round(h * 0.45);
    const labelPx = Math.round(h * 0.08);
    const labelOffset = Math.round(h * 0.28);

    ctx.font = labelPx + 'px Helvetica, Arial, sans-serif';
    ctx.fillText(weekday, w / 2, h / 2 - labelOffset);

    ctx.font = 'bold ' + dayPx + 'px Helvetica, Arial, sans-serif';
    ctx.fillText(day, w / 2, h / 2);

    ctx.font = labelPx + 'px Helvetica, Arial, sans-serif';
    ctx.fillText(monthYear, w / 2, h / 2 + labelOffset);
  }

  // World map (Atlas app). 16:9 image, now sized to fit a 3×3 wall
  // slot (≈ 0.70 × 0.55) instead of the wider 6×3 — gallery layout
  // moved all items off the back-wall window, so atlas matches the
  // rest of the wall grid.
  function makeWallMap() {
    // Was 0.60 × 0.337 at the old 3×3 cell (0.70 × 0.55). Scaled by
    // 0.70 to fit the new home-studio 3×3 cell (0.55 × 0.40m): the
    // frame outer (W+0.05 × H+0.05) must clear the cell footprint
    // or paintings overlap their neighbors.
    return makeImagePoster({ path: 'posters/map.jpg', W: 0.735, H: 0.380 });
  }

  // Kitchen still life painting (kitchen app). Image aspect ~6:5 so
  // panel is roughly square. Sized for the new 3×3 wall cell.
  function makeKitchenPainting() {
    return makeImagePoster({ path: 'posters/kitchen.jpg', W: 0.662, H: 0.551 });
  }

  // Animated sky-backdrop. Renders into an offscreen canvas: sky
  // gradient (static) + drifting clouds (per-frame) + city silhouette
  // at the horizon (static). Returns { texture, update(dt) } — the
  // texture is fed to the sky-plane material in setupRoom; the update
  // is wired into the render loop so clouds advance in real time.
  //
  // Pairs with the camera parallax (PARALLAX_RANGE_X/Y) and the
  // pushed-back sky planes (SKY_DEPTH in setupRoom). The combination
  // gives "view through a window at a distant city, clouds drifting,
  // perspective shifting slightly with the cursor."
  //
  // Performance: redraws the whole canvas each call. At 1024×512 it's
  // a few MB/frame of texture upload — cheap on any modern GPU, but
  // a damping check inside update() skips redraws if dt accumulates
  // less than ~33ms, capping the effective sky refresh at ~30 fps.
  function makeAnimatedSky() {
    const PW = 1024, PH = 512;
    const cv = document.createElement('canvas');
    cv.width = PW; cv.height = PH;
    const ctx = cv.getContext('2d');

    // Pre-compose the static layer (sky gradient + city silhouette)
    // once into a buffer canvas. Each frame we drawImage() this and
    // then paint clouds on top — saves regenerating the gradient and
    // silhouette every redraw.
    const bg = document.createElement('canvas');
    bg.width = PW; bg.height = PH;
    const bgCtx = bg.getContext('2d');

    // Horizon line — the visual eye-level where sky meets ground. The
    // window's view cone hits the sky plane around canvas y 0.33–0.57
    // (math: camera at world y=1.65 looks through window at y 1.4–3.0,
    // which maps to that band on the y=-4..8 sky plane). So everything
    // below ~0.57 was wasted — clouds and buildings drawn there never
    // showed through the window. Horizon at 0.50 puts the city band
    // squarely in the middle of the visible window region.
    const HORIZON_Y = PH * 0.50;

    // Deterministic RNG — seeded so the skyline/hills/stars don't
    // reshuffle on every reload (or every "Change scene" recompose).
    function mulberry32(seed) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // ── Scenes ────────────────────────────────────────────────────────
    // The view through the window. "Change scene" in the window popup
    // cycles sceneIndex through these and recomposes the static bg layer
    // (gradient + silhouette + optional stars). Clouds drift on top of
    // whichever scene is active, tinted per-scene via `cloud`.
    //   grad  — vertical gradient stops [position, css color]; clustered
    //           around HORIZON_Y so atmospheric perspective lands at eye
    //           level.
    //   style — 'city' (boxy skyline) or 'hills' (rounded ridgelines).
    //   far/near — silhouette colors; far is lighter (atmospheric depth).
    //   stars — draw a starfield above the horizon (night scenes).
    //   cloud — "r, g, b" tint for the drifting cloud puffs.
    const SCENES = [
      { // Daytime city — the original look.
        name: 'Daytime',
        grad: [[0, '#7da8d4'], [0.35, '#aecde0'], [0.48, '#e8d8c0'], [0.55, '#d6c2a0'], [1, '#b8a078']],
        style: 'city', far: '#9aa6b8', near: '#3a4a5e', cloud: '255, 250, 240',
      },
      { // Golden hour — warm sky, deep dusky skyline.
        name: 'Sunset',
        grad: [[0, '#3b4a7a'], [0.30, '#a86a8e'], [0.46, '#e89a6a'], [0.54, '#f2c074'], [1, '#7a4a4e']],
        style: 'city', far: '#7a5a7e', near: '#2a1c33', cloud: '255, 214, 196',
      },
      { // Night — deep navy, starfield, near-black skyline.
        name: 'Night',
        grad: [[0, '#0a1230'], [0.40, '#16244a'], [0.50, '#27365e'], [0.56, '#1d2747'], [1, '#0c1124']],
        style: 'city', far: '#28304e', near: '#0c1222', stars: true, cloud: '120, 134, 168',
      },
      { // Rolling hills — no city; layered green ridgelines.
        name: 'Hills',
        grad: [[0, '#8fb6d8'], [0.40, '#c2dbe6'], [0.52, '#dfe7cf'], [0.60, '#c2d2a8'], [1, '#8aa472']],
        style: 'hills', far: '#9ab38f', near: '#5f7e54', cloud: '255, 252, 246',
      },
      { // ── Photo-backed scene ──────────────────────────────────────────
        // A real image fills the window instead of the procedural skyline,
        // with the same drifting clouds composited on top and a slow Ken
        // Burns pan for life. To add more, drop a jpg/png in the app and add
        // another entry like this one ({ name, photo, pan, cloud }). `photo`
        // is an app-relative URL; `pan:true` enables the slow drift; `cloud`
        // tints the clouds to match the photo's light.
        name: 'City Photo',
        photo: 'textures/skyline.jpg',
        pan: false,
        cloud: '255, 250, 240',
      },
      { // Misty snow-capped mountains over a spruce forest. Already overcast,
        // so the procedural cloud layer is turned OFF — a still, fixed view.
        name: 'Mountains',
        photo: 'windows/mountains.jpg',
        pan: false,
        clouds: false,
        cloud: '235, 240, 245',
      },
      { // Sunny industrial city street, clear blue sky — fixed view with
        // drifting white clouds, which read naturally over the open sky.
        name: 'City Street',
        photo: 'windows/street.jpg',
        pan: false,
        cloud: '255, 252, 248',
      },
    ];
    let sceneIndex = 0;
    let cloudRGB = SCENES[0].cloud;

    // City silhouette — a row of boxy buildings along the horizon. Far
    // buildings are lighter; near ones are darker and a touch lower so
    // they occlude the far layer.
    function drawSkyline(rng, color, baseY, scaleH, scaleW) {
      bgCtx.fillStyle = color;
      let x = -20;
      while (x < PW + 20) {
        const w = (18 + rng() * 60) * scaleW;
        const h = (25 + rng() * 110) * scaleH;
        // Buildings rise from baseY upward by h, and their base fills
        // down to the bottom of the canvas so there's no horizon gap.
        bgCtx.fillRect(x, baseY - h, w, h + (PH - baseY));
        x += w - 2;
      }
    }

    // Rounded ridgeline — a run of overlapping quadratic humps along
    // baseY, filled down to the canvas bottom. Stand-in for distant hills.
    function drawHills(rng, color, baseY, amp) {
      bgCtx.fillStyle = color;
      bgCtx.beginPath();
      bgCtx.moveTo(0, PH);
      bgCtx.lineTo(0, baseY);
      let x = 0;
      while (x < PW) {
        const span = 80 + rng() * 140;
        const peakY = baseY - (20 + rng() * amp);
        bgCtx.quadraticCurveTo(x + span / 2, peakY, x + span, baseY - rng() * amp * 0.4);
        x += span;
      }
      bgCtx.lineTo(PW, PH);
      bgCtx.closePath();
      bgCtx.fill();
    }

    // Starfield above the horizon — small dots at varied brightness.
    function drawStars(rng, count) {
      bgCtx.fillStyle = '#ffffff';
      for (let i = 0; i < count; i++) {
        const sx = rng() * PW;
        const sy = rng() * (HORIZON_Y - 12);
        const r  = rng() < 0.85 ? 0.7 : 1.4;
        bgCtx.globalAlpha = 0.35 + rng() * 0.6;
        bgCtx.beginPath();
        bgCtx.arc(sx, sy, r, 0, Math.PI * 2);
        bgCtx.fill();
      }
      bgCtx.globalAlpha = 1;
    }

    // ── Photo scenes ──────────────────────────────────────────────────
    // Photo-backed scenes load their image lazily. Until it's ready,
    // composeBg falls back to a plain sky gradient so the window is never
    // blank; when the image finishes loading we repaint the active scene.
    const _photoCache = {}; // url -> { img, ready }
    function getPhoto(url) {
      if (_photoCache[url]) return _photoCache[url];
      const rec = { img: new Image(), ready: false };
      rec.img.onload = () => {
        rec.ready = true;
        // If the photo that just loaded is the one on screen, repaint now.
        if (SCENES[sceneIndex].photo === url) { composeBg(); draw(); tex.needsUpdate = true; }
      };
      rec.img.src = url;
      _photoCache[url] = rec;
      return rec;
    }
    // Draw `img` to COVER the PW×PH canvas (fill, preserve aspect, center-
    // crop) at an optional zoom + pan. zoom>1 crops tighter, leaving margin
    // that panX/panY (each in [-1,1]) slide within — so the Ken Burns drift
    // never reveals an edge. All sampling stays inside the image bounds, so
    // there are no clamp artifacts.
    function drawPhotoCover(c2, img, zoom, panX, panY) {
      const cr = PW / PH, ir = img.width / img.height;
      let sw, sh;
      if (ir > cr) { sh = img.height; sw = sh * cr; } // image wider → fit height
      else         { sw = img.width;  sh = sw / cr; } // image taller → fit width
      sw /= zoom; sh /= zoom;
      const sx = (img.width  - sw) * 0.5 + panX * (img.width  - sw) * 0.5;
      const sy = (img.height - sh) * 0.5 + panY * (img.height - sh) * 0.5;
      c2.drawImage(img, sx, sy, sw, sh, 0, 0, PW, PH);
    }

    // Paint the static backdrop for the active scene into the bg buffer.
    // Re-run whenever sceneIndex changes; clouds are painted over it each
    // frame in draw().
    function composeBg() {
      const sc = SCENES[sceneIndex];
      cloudRGB = sc.cloud;
      // Photo scene: bake the (un-panned) image into the bg buffer as the
      // fallback/static layer. When `pan` is on, draw() redraws the photo
      // live each frame with the Ken Burns offset; this buffer is what shows
      // for non-panning photo scenes and during the load of panning ones.
      if (sc.photo) {
        const rec = getPhoto(sc.photo);
        if (rec.ready) { drawPhotoCover(bgCtx, rec.img, sc.pan ? 1.08 : 1.0, 0, 0); }
        else { bgCtx.fillStyle = '#9fb6cf'; bgCtx.fillRect(0, 0, PW, PH); }
        return;
      }
      const grad = bgCtx.createLinearGradient(0, 0, 0, PH);
      for (const [pos, col] of sc.grad) grad.addColorStop(pos, col);
      bgCtx.fillStyle = grad;
      bgCtx.fillRect(0, 0, PW, PH);
      if (sc.stars) drawStars(mulberry32(99), 220);
      // Far layer first (lighter, sits at horizon), then near layer on
      // top — slightly larger/lower so it occludes the far one, faking depth.
      if (sc.style === 'hills') {
        drawHills(mulberry32(7),  sc.far,  HORIZON_Y + 10, 70);
        drawHills(mulberry32(42), sc.near, HORIZON_Y + 30, 120);
      } else {
        drawSkyline(mulberry32(7),  sc.far,  HORIZON_Y + 6,  0.55, 0.7);
        drawSkyline(mulberry32(42), sc.near, HORIZON_Y + 22, 1.0,  1.0);
      }
    }
    composeBg();

    // Cloud blobs: each is a horizontal row of overlapping alpha-disks
    // so the silhouette is fluffy without needing a real shape. Speeds
    // vary so clouds at different "depths" drift at different rates.
    // Y range is constrained to ABOVE the horizon so clouds appear in
    // the sky, not in the city silhouette.
    const CLOUD_Y_MIN = PH * 0.10;
    const CLOUD_Y_MAX = HORIZON_Y - 30;
    const clouds = [];
    const rng = mulberry32(1234);
    for (let i = 0; i < 7; i++) {
      clouds.push({
        x:     rng() * PW,
        y:     CLOUD_Y_MIN + rng() * (CLOUD_Y_MAX - CLOUD_Y_MIN),
        r:     18 + rng() * 40,
        speed: 4  + rng() * 10,      // canvas px / second
        puffs: 4  + Math.floor(rng() * 4),
        alpha: 0.55 + rng() * 0.30,
      });
    }
    function recycleCloud(c) {
      c.x     = -c.r * 3;
      c.y     = CLOUD_Y_MIN + Math.random() * (CLOUD_Y_MAX - CLOUD_Y_MIN);
      c.r     = 18 + Math.random() * 40;
      c.speed = 4  + Math.random() * 10;
      c.puffs = 4  + Math.floor(Math.random() * 4);
      c.alpha = 0.55 + Math.random() * 0.30;
    }

    function draw() {
      const sc = SCENES[sceneIndex];
      if (sc.photo && sc.pan) {
        const rec = getPhoto(sc.photo);
        if (rec.ready) {
          // Slow, gentle drift — two out-of-phase low-frequency waves so the
          // pan never loops obviously. Amplitude 0.6 keeps it well inside the
          // 8% margin from zoom 1.08. This runs inside the 30fps redraw, so
          // it costs nothing beyond the canvas re-upload we already do.
          const panX = Math.sin(_kbT * 0.05)  * 0.6;
          const panY = Math.cos(_kbT * 0.037) * 0.45;
          drawPhotoCover(ctx, rec.img, 1.08, panX, panY);
        } else {
          ctx.drawImage(bg, 0, 0); // gradient fallback while the image loads
        }
      } else {
        ctx.drawImage(bg, 0, 0);
      }
      // Drifting clouds on top — unless the scene opts out (`clouds:false`),
      // e.g. a photo that's already overcast and doesn't need fake puffs.
      if (sc.clouds === false) return;
      for (const c of clouds) {
        ctx.fillStyle = `rgba(${cloudRGB}, ${c.alpha})`;
        for (let p = 0; p < c.puffs; p++) {
          const px = c.x + (p - (c.puffs - 1) / 2) * c.r * 0.55;
          const py = c.y + Math.sin(p * 1.3) * 6;
          ctx.beginPath();
          ctx.arc(px, py, c.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

    // ~30fps cap on sky redraw — clouds move slowly, no benefit to
    // burning GPU bandwidth at the full render rate.
    let _accum = 0;
    // Ken Burns clock for photo scenes — advanced every frame (cheap), read
    // by draw() to offset the photo pan. Independent of the redraw throttle.
    let _kbT = 0;
    // Cloud drift speed multiplier. 1.0 = original pace. Was
    // previously exposed via the lighting debugger; baked in now.
    // Default 0.5× — clouds drift slowly across the side window so the
    // view reads as ambient atmosphere, not high winds.
    let _speedMul = 2.95;
    const REDRAW_INTERVAL = 1 / 30;
    function update(dt) {
      _kbT += dt; // advance the Ken Burns clock (used only by photo scenes)
      // Always advance positions (cheap), but throttle the actual
      // redraw to keep texture-upload cost bounded.
      for (const c of clouds) {
        c.x += c.speed * _speedMul * dt;
        if (c.x - c.r * 3 > PW) recycleCloud(c);
      }
      _accum += dt;
      if (_accum >= REDRAW_INTERVAL) {
        _accum = 0;
        draw();
        tex.needsUpdate = true;
      }
    }
    function setSpeed(mul) { _speedMul = mul; }
    function getSpeed() { return _speedMul; }

    // Advance to the next scene: recompose the static backdrop and force
    // an immediate redraw so the change shows without waiting for the
    // throttled cloud tick. Returns the new scene's display name.
    function nextScene() {
      sceneIndex = (sceneIndex + 1) % SCENES.length;
      composeBg();
      draw();
      tex.needsUpdate = true;
      return SCENES[sceneIndex].name;
    }
    function getSceneName() { return SCENES[sceneIndex].name; }

    draw();
    return { texture: tex, update, setSpeed, getSpeed, nextScene, getSceneName };
  }

  // ── §5d · Tabletop trinkets ──────────────────────────────────────
  // Built at final size — no makeScaled wrapper. Group has y=0 at the
  // bottom of the item, so TabletopSurface can drop it straight onto
  // the tier's surface plane.
  function makeBookStack(color) {
    const b1 = place(box(0.18, 0.04, 0.13, color || 0xc04035), 0, 0.02, 0);
    const b2 = place(box(0.16, 0.035, 0.12, 0x3f6bc4), 0.005, 0.058, 0.005);
    const b3 = place(box(0.14, 0.03, 0.11, 0x4a7c44), -0.005, 0.090, -0.005);
    return group(b1, b2, b3);
  }

  // ══════════════════════════════════════════════════════════════════
  // §6 · Wrappers — scale + center + GLB
  // ══════════════════════════════════════════════════════════════════
  function makeScaled(factory, color, scale, opts = {}) {
    return () => {
      const built = factory(color);
      built.scale.setScalar(scale);
      const wrapper = new THREE.Group();
      wrapper.add(built);
      if (opts.centerY) {
        const bbox = new THREE.Box3().setFromObject(wrapper);
        const center = new THREE.Vector3(); bbox.getCenter(center);
        built.position.y -= center.y;
      }
      return wrapper;
    };
  }
  // makeWindowBorder removed along with the glbWindow item (its only
  // caller). If glbWindow is reintroduced, restore from git history.

  function makeFromGlb(path, opts = {}) {
    const targetH = opts.targetHeight || 1.0;
    return () => {
      const cached = GLB_CACHE[path];
      if (!cached) {
        const placeholder = box(0.3, targetH, 0.3, 0xc0a888);
        placeholder.position.y = targetH / 2;
        const wrapper = group(placeholder);
        // Tag so swapPlaceholdersForPath can find & replace this once the
        // GLB finishes loading. preloadGlbs is fire-and-forget, so the
        // first render of any GLB-backed item after a fresh init lands here.
        wrapper.userData.glbPlaceholderPath = path;
        return wrapper;
      }
      const cloned = cached.clone(true);
      // First pass — collect SkinnedMesh nodes. For static decor (e.g.
      // the Sketchfab corkboard), the skinning is dead weight: it
      // renders the bind pose but doesn't follow parent-scope scaling
      // because the skinning shader produces positions in a coordinate
      // system that bypasses our wrapper scale. Replacing each
      // SkinnedMesh with a regular Mesh (same geometry, same material
      // but with skinning flag off) makes the scene graph scale work
      // normally without changing how the model looks.
      const skinnedSwaps = [];
      cloned.traverse(o => {
        if (o.isSkinnedMesh) skinnedSwaps.push(o);
      });
      for (const sm of skinnedSwaps) {
        const m = new THREE.Mesh(sm.geometry, sm.material);
        m.name = sm.name;
        m.position.copy(sm.position);
        m.rotation.copy(sm.rotation);
        m.scale.copy(sm.scale);
        m.matrix.copy(sm.matrix);
        m.matrixAutoUpdate = sm.matrixAutoUpdate;
        m.matrixWorldNeedsUpdate = true;
        m.castShadow = sm.castShadow; m.receiveShadow = sm.receiveShadow;
        m.visible = sm.visible;
        const parent = sm.parent;
        if (parent) {
          parent.add(m);
          parent.remove(sm);
        }
      }

      cloned.traverse(o => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          // Disable the skinning shader flag for the replaced meshes —
          // otherwise three.js compiles the wrong shader variant and
          // either produces zero vertices or falls back to bind-pose
          // garbage. Safe for non-skinned originals: the flag is false
          // by default on regular materials.
          if (o.material.skinning) o.material.skinning = false;
          o.castShadow = true; o.receiveShadow = true;
          // Tag every mesh in the clone with the source GLB path. This is
          // what lets refreshModels() swap already-loaded models in place:
          // swapPlaceholdersForPath looks for either the placeholder tag
          // (first-load path) OR this glbSourcePath tag (refresh path).
          o.userData.glbSourcePath = path;
          // Per-mesh post-process — used by glbWindow to make the glass
          // sub-mesh transparent without affecting the frame/handle that
          // share the same source material in the GLB.
          if (opts.onMesh) opts.onMesh(o);
        }
      });
      // Pre-rotate the model inside the wrapper for GLBs whose natural
      // "width" axis isn't along X. Done BEFORE bbox so centering accounts
      // for the rotated bounds. Doesn't affect user drag-rotate, which
      // operates on the wrapper, not the cloned content.
      if (opts.rotateX) cloned.rotation.x = opts.rotateX;
      if (opts.rotateY) cloned.rotation.y = opts.rotateY;
      if (opts.rotateZ) cloned.rotation.z = opts.rotateZ;
      // Two-layer wrap so factory-applied scale survives the async
      // placeholder swap. swapPlaceholdersForPath does
      // `newMesh.scale.copy(oldMesh.scale)` on the returned root — if the
      // factory's scale lives on that root, the swap clobbers it back to
      // whatever the placeholder had (1,1,1). Keeping the outer wrapper
      // at identity scale means the swap is a no-op, while the inner
      // group carries our actual scaling/centering.
      //
      // The inner-group route also sidesteps an unrelated bug with
      // FBX-imported GLBs (e.g. the Sketchfab corkboard) whose root
      // nodes have `matrix` set: the GLTF loader marks those nodes
      // matrixAutoUpdate=false, so setting position/scale directly on
      // cloned would be a silent no-op. The inner Group is a fresh
      // Three.js node with matrixAutoUpdate=true, so its TRS values
      // propagate through.
      const inner = new THREE.Group();
      inner.add(cloned);
      const wrapper = new THREE.Group();
      wrapper.add(inner);

      const bbox = new THREE.Box3().setFromObject(cloned);
      const size = new THREE.Vector3(); bbox.getSize(size);
      // targetWidth scales against the X axis — useful for flat/horizontal
      // models where Y (height) is tiny and would produce a huge scale.
      // forcedScale bypasses bbox-derived scaling — needed for GLBs with
      // skinned meshes where Box3.setFromObject reads only the bind-pose
      // bounds (not the rendered geometry) and produces a wildly wrong
      // scale factor. Caller supplies the absolute scale directly.
      const scale = opts.forcedScale != null
        ? opts.forcedScale
        : (opts.targetWidth ? opts.targetWidth / size.x : targetH / size.y);
      inner.scale.setScalar(scale);

      // For matrix-mode root nodes (e.g. FBX-imported GLBs), setting
      // inner.scale isn't enough — bone world transforms used by the
      // skinning shader are derived through matrixWorld, which works,
      // but some GLBs route skinned mesh rendering through skeleton
      // bones whose inverse-bind matrices are baked in absolute space.
      // The reliable fix: also scale the matrix-mode root directly so
      // the bones inherit the scale through their own matrix update.
      // We do this only when forcedScale is set, to avoid touching the
      // already-working GLBs.
      if (opts.forcedScale != null) {
        cloned.traverse(node => {
          if (node.matrixAutoUpdate === false && node.matrix) {
            const s = new THREE.Matrix4().makeScale(scale, scale, scale);
            node.matrix.premultiply(s);
            // After mutating matrix directly we must flag world for re-derivation.
            node.matrixWorldNeedsUpdate = true;
          }
        });
      }

      // Recompute bbox in wrapper-local space after scaling so centering
      // offsets are correct relative to the scaled geometry.
      const scaledBbox = new THREE.Box3().setFromObject(inner);
      const center = new THREE.Vector3(); scaledBbox.getCenter(center);
      inner.position.x -= center.x;
      inner.position.z -= center.z;
      // Floor/tabletop pieces want their bottom at y=0 (so they sit on the
      // surface). Wall pieces want vertical centering inside their slot
      // (so the slot anchor lands at the visual middle of the map/poster).
      if (opts.centerY) inner.position.y -= center.y;
      else inner.position.y -= scaledBbox.min.y;
      return wrapper;
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // §7 · ITEMS catalog — built lazily so room geometry can be set up
  //      first. Items map 1:1 to factories. Each entry has surface +
  //      factory + (optional) footprint + (optional) tabletops tiers.
  // ══════════════════════════════════════════════════════════════════
  function buildItems() {
    return {
      // ── Floor ──────────────────────────────────────────────────────
      // The diorama desk — host for the tabletop trinkets (laptop,
      // inboxes, typewriter, books).
      // Standing-desk GLB swapped in for the previous procedural box.
      // targetHeight: DESK.h (0.78m) scales the GLB uniformly so the
      // top of its bounding box lands at the tabletop tier (y=DESK.h+
      // 0.001), keeping the existing laptop/inbox/typewriter/etc.
      // placements visually on the desk surface. If the GLB's natural
      // width:depth proportions don't match DESK.w × DESK.d after this
      // height-based scale, the trinkets may sit slightly inside or
      // outside the actual desktop edges — easy to fix by adjusting
      // DESK.w/d or the tabletop tier's w/d multipliers (0.88, 0.85).
      deskUnit:     { id: 'deskUnit',     surface: 'floor', label: 'Desk',            footprint: { w: 6, d: 3 },
                      source: 'glb',
                      factory: makeFromGlb('models/standing-desk.glb', { targetHeight: DESK.h }),
                      tabletops: [
                        // Tripled from 4×2 → 12×6 so the desktop has the
                        // same fine-grained placement granularity as the
                        // floor/wall grids. Trinket footprints all bumped
                        // to {w:3,d:3} (see §7 tabletop entries) so each
                        // item still reserves the same physical area as
                        // it did on the 4×2 grid — only the snap step
                        // got finer. Existing saved placements are
                        // migrated by MIGRATIONS[13].
                        { id: 'top', y: DESK.h + 0.001, w: DESK.w * 0.88, d: DESK.d * 0.85, cols: 12, rows: 6 },
                      ] },
      // Office chair — low-poly GLB. Bumped to 1.10m total height
      // (was 0.95m) to read as a substantial high-back exec chair
      // next to the now-larger desk. Seat still tucks under the 0.78m
      // desk top. Default footprint (1×1) is fine — the chair base is
      // ~55cm square, comfortably inside one floor cell.
      glbOfficeChair: { id: 'glbOfficeChair', surface: 'floor', label: 'Office chair', source: 'glb',
                      factory: makeFromGlb('models/office-chair.glb', { targetHeight: 1.10 }) },
      // Area rug — flat decoration that sprawls under the desk and
      // chair. Authored Z-up, but the Sketchfab parent node matrices
      // bake in the Z-up→Y-up rotation already, so we do NOT add a
      // rotateX (that double-rotated it into a vertical billboard).
      // layer:'rug' opts the carpet out of collision: it doesn't reserve
      // cells (other items render on top of it) AND it ignores other
      // items + blocked edge cells when finding valid slots, so you can
      // drag it anywhere in the room without "no valid slot" rejection.
      // targetWidth 3.0m → classic ~3m × 2m area-rug proportions.
      glbCarpet:    { id: 'glbCarpet',    surface: 'floor', label: 'Carpet', source: 'glb',
                      layer: 'rug',
                      factory: makeFromGlb('models/carpet.glb', {
                        targetWidth: 3.0,
                      }) },
      // Red filing cabinet — used as the library launcher. Compact 1×1
      // footprint and targetHeight 0.40m for a small accent piece in
      // the back-left corner. The GLB uses the deprecated spec-gloss
      // extension, so each mesh gets reskinned in MeshStandardMaterial
      // (same workaround as the whiteboard / TV cabinet / snake plant)
      // so the scene lights affect it cleanly.
      glbFilingCabinet: { id: 'glbFilingCabinet', surface: 'floor', label: 'Filing cabinet', source: 'glb',
                      footprint: { w: 1, d: 1 },
                      factory: makeFromGlb('models/filing-cabinet-red.glb', {
                        targetHeight: 0.70,
                        onMesh: (o) => {
                          const old = o.material;
                          if (!old) return;
                          if (old.map) old.map.encoding = THREE.sRGBEncoding;
                          o.material = new THREE.MeshStandardMaterial({
                            color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
                            map: old.map || null,
                            roughness: 0.70,
                            metalness: 0,
                            side: THREE.DoubleSide,
                          });
                        },
                      }) },
      // Standing snake plant in a pot — floor decoration / launcher for
      // garden-tracker. Default 1×1 footprint (~26cm × 27cm) is fine —
      // the plant base is small. targetHeight 0.85m for a roughly knee-
      // to-hip-high specimen. Same material reskin as the other GLBs so
      // the leaves pick up scene light cleanly.
      glbSnakePlant2: { id: 'glbSnakePlant2', surface: 'floor', label: 'Snake plant', source: 'glb',
                      factory: makeFromGlb('models/snake-plant-2.glb', {
                        targetHeight: 0.85,
                        onMesh: (o) => {
                          const old = o.material;
                          if (!old) return;
                          if (old.map) old.map.encoding = THREE.sRGBEncoding;
                          o.material = new THREE.MeshStandardMaterial({
                            color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
                            map: old.map || null,
                            roughness: 0.85,
                            metalness: 0,
                            side: THREE.DoubleSide,
                          });
                        },
                      }) },
      // TV cabinet with DVD player / VHS / PS3 / TV on top. Used by
      // media-tracker. Footprint 4×2 (cols × rows on the 21×15 floor
      // grid) ≈ 1.03m wide × 0.53m deep, with targetHeight 1.1m so the
      // TV sits at roughly eye-level for someone seated. Same
      // spec-gloss material workaround as the whiteboard — re-skin in
      // MeshStandardMaterial so the scene lights affect every sub-part
      // (wood cabinet, plastic devices, screen, DVD cases).
      glbTvCabinet: { id: 'glbTvCabinet', surface: 'floor', label: 'Media cabinet', source: 'glb',
                      footprint: { w: 4, d: 2 },
                      factory: makeFromGlb('models/tv-cabinet.glb', {
                        targetHeight: 1.10,
                        onMesh: (o) => {
                          const old = o.material;
                          if (!old) return;
                          if (old.map) old.map.encoding = THREE.sRGBEncoding;
                          o.material = new THREE.MeshStandardMaterial({
                            color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
                            map: old.map || null,
                            roughness: 0.80,
                            metalness: 0,
                            side: THREE.DoubleSide,
                          });
                        },
                      }) },
      // Floor-standing electric piano on its stand. Used by
      // sheet-music-tracker (replaces the older `piano` tabletop trinket).
      // targetHeight 0.90m ≈ a real stage piano on its X-stand. The GLB is
      // a Sketchfab export with the standard Y-up orientation baked in, so
      // no rotateX/Y is needed. Same MeshStandardMaterial reskin as the
      // other Sketchfab GLBs so scene lights affect it cleanly. 1×1
      // footprint — the body is ~1.3m wide once scaled, but the visual
      // overhang past the anchor cell is fine alongside the open floor by
      // the window.
      glbElectricPiano: { id: 'glbElectricPiano', surface: 'floor', label: 'Electric piano', source: 'glb',
                      footprint: { w: 1, d: 1 },
                      factory: makeFromGlb('models/electric-piano.glb', {
                        targetHeight: 0.5625,
                        onMesh: (o) => {
                          const old = o.material;
                          if (!old) return;
                          if (old.map) old.map.encoding = THREE.sRGBEncoding;
                          o.material = new THREE.MeshStandardMaterial({
                            color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
                            map: old.map || null,
                            roughness: 0.70,
                            metalness: 0,
                            side: THREE.DoubleSide,
                          });
                        },
                      }) },

      // ── Wall ───────────────────────────────────────────────────────
      // Floating shelf — wall-mounted plank used as the gallery
      // centerpiece (DECORATIONS seeds it directly above the desk).
      floatingWallShelf: { id: 'floatingWallShelf', surface: 'wall', label: 'Floating shelf',
                      footprint: { w: 6, h: 3 },
                      factory: makeFloatingWallShelf,
                      tabletops: [
                        // Tripled 3×1 → 9×3 for parity with the densified
                        // deskUnit grid. No APPS rows reference the shelf
                        // tabletop today so no slot translation needed
                        // beyond MIGRATIONS[13] for any decorative items.
                        { id: 'top', y: 0.025, z: 0.11, w: 1.27, d: 0.16, cols: 9, rows: 3 },
                      ] },
      corkboard:  { id: 'corkboard',  surface: 'wall', label: 'Corkboard',
                    factory: makeScaled(makeCorkboard,    0xc9a467, FACTORY_SCALE_WALL, { centerY: true }) },
      // Wall whiteboard planner — used by whiteboard-tasks. The GLB is
      // authored lying flat (board face up, as if on a tabletop), so we
      // rotate +90° around X to stand it up against the wall with its
      // face pointing into the room. Footprint kept at 4×3 to preserve
      // the slot anchor's visual position; targetWidth 0.40m makes the
      // board roughly half the size of the original render.
      //
      // The GLB ships with the deprecated KHR_materials_pbrSpecularGlossiness
      // extension, which newer three.js versions no longer parse. The
      // resulting fallback material doesn't react to scene lights so the
      // board reads as a flat, unlit grey next to the warmly-lit
      // paintings. onMesh upgrades each mesh's material to
      // MeshStandardMaterial — keeping the diffuse map so the printed
      // planner layout still shows — so the room's directional lighting
      // affects it like every other wall piece.
      glbWhiteboard: { id: 'glbWhiteboard', surface: 'wall', label: 'Whiteboard planner', source: 'glb',
                    footprint: { w: 4, h: 3 },
                    factory: makeFromGlb('models/whiteboard-planner.glb', {
                      targetWidth: 0.40,
                      rotateX: Math.PI / 2,
                      centerY: true,
                      onMesh: (o) => {
                        const old = o.material;
                        if (!old) return;
                        // Ensure the diffuse texture is treated as sRGB —
                        // without this, three.js's color-managed pipeline
                        // double-applies gamma and the board reads dark.
                        if (old.map) old.map.encoding = THREE.sRGBEncoding;
                        o.material = new THREE.MeshStandardMaterial({
                          color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
                          map: old.map || null,
                          // Re-use the diffuse map as an emissive map so the
                          // board has a baseline self-illumination — real
                          // whiteboards reflect a lot of ambient light, and
                          // without this the scene's relatively dim
                          // ambient + warm directional rig leaves it
                          // darker than the paintings. intensity 0.55
                          // keeps the warm directional shading visible
                          // while floating the board's brightness up.
                          emissive: new THREE.Color(0xffffff),
                          emissiveMap: old.map || null,
                          // Pushed to 1.0 so the board renders at its full
                          // texture brightness regardless of room lighting
                          // — matches Sami's "near white" target. Lit
                          // shading still layers on top via the base map.
                          emissiveIntensity: 1.0,
                          roughness: 0.78,
                          metalness: 0,
                          // Original GLB material was doubleSided. Without
                          // this, MeshStandardMaterial defaults to FrontSide
                          // and any mesh whose front-facing normals point
                          // into the wall renders blank from the room — the
                          // "backwards" effect Sami flagged.
                          side: THREE.DoubleSide,
                        });
                      },
                    }) },
      // Wall calendar — printed planner texture on a thin slab. Footprint
      // 3×3 because the design is square-ish, not tall;
      // events-digest still anchors at back:21,0 — see §1 APPS.
      calendar:   { id: 'calendar',   surface: 'wall', label: 'Wall calendar',  footprint: { w: 3, h: 3 },
                    factory: makeWallCalendar3D },
      // Art-deco wall mirror (daily-journal launcher). The GLB ships with
      // the deprecated KHR_materials_pbrSpecularGlossiness extension that
      // newer three.js can't parse, so its three materials fall back to a
      // dead grey — onMesh rebuilds each as a MeshStandardMaterial keyed by
      // the original material name:
      //   "Espejo"        → the glass: dark + fully metallic + very smooth,
      //                      so it reflects the scene's HDRI environment map
      //                      like real glass. Tagged isMirrorGlass so the
      //                      cursor-reflection overlay can find its screen quad.
      //   "Espejo_Cobre"  → the art-deco copper frame.
      //   "No_reflejo"    → matte dark backing.
      // centerY centers it vertically in its wall slot like the posters.
      glbMirror:  { id: 'glbMirror', surface: 'wall', label: 'Mirror', source: 'glb',
                    footprint: { w: 3, h: 3 },
                    factory: makeFromGlb('models/mirror.glb', {
                      targetHeight: 0.62,
                      centerY: true,
                      onMesh: (o) => {
                        const old = o.material;
                        if (!old) return;
                        const name = old.name || '';
                        if (/cobre/i.test(name)) {
                          o.material = new THREE.MeshStandardMaterial({
                            color: 0xc77b4a, metalness: 0.9, roughness: 0.35,
                          });
                          o.material.envMapIntensity = 1.0;
                        } else if (/espejo/i.test(name)) {
                          // The reflective glass. Light silver + fully metallic
                          // + mirror-smooth (roughness ~0) so it reflects the
                          // scene environment map brightly and sharply, like the
                          // glossy mirror material in the original model. A
                          // dark tint here darkens the reflection, so keep it
                          // near-white. Still slightly transparent so the wall
                          // reads through a touch.
                          o.material = new THREE.MeshStandardMaterial({
                            color: 0xd6dde2, metalness: 1.0, roughness: 0.01,
                            transparent: true, opacity: 0.88,
                          });
                          o.material.envMapIntensity = 2.4;
                          o.userData.isMirrorGlass = true;
                        } else {
                          o.material = new THREE.MeshStandardMaterial({
                            color: 0x1a1622, metalness: 0.0, roughness: 0.8,
                          });
                        }
                      },
                    }) },
      // Framed image posters — JPGs from /posters loaded by makeImagePoster.
      // W/H per item is chosen to match the source image's aspect ratio
      // so the painting doesn't stretch. Files that are missing fall
      // back to a parchment-coloured panel inside the wooden frame.
      wallMap:               { id: 'wallMap',               surface: 'wall', label: 'World map',                footprint: { w: 3, h: 3 },
                               factory: makeWallMap },
      kitchenPainting:       { id: 'kitchenPainting',       surface: 'wall', label: 'Kitchen still life',       footprint: { w: 3, h: 3 },
                               factory: makeKitchenPainting },
      // All painting W/H multiplied by 0.70 from their original values
      // when wall cells shrank to the home-studio grid (0.55m × 0.40m
      // for a 3×3 footprint). The frame outer dimensions are
      // (W+0.05) × (H+0.05); previous H values (0.43–0.45) put the
      // frame outer at 0.48–0.50m vertical, overflowing the 0.40m
      // cell by ~10cm and visually stacking onto adjacent rows. New
      // values keep aspect ratios but fit comfortably with margin.

      // Portrait-orientation pieces (image taller than wide).
      gardenPainting:        { id: 'gardenPainting',        surface: 'wall', label: 'Botanical illustration',   footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/garden-tracker.jpg',      W: 0.380, H: 0.551 }) },
      // Projects (project-sketchbook) — 3D corkboard GLB on the wall.
      // Uses forcedScale because the GLB has skinned meshes whose render
      // size doesn't map cleanly to Box3-derived auto-scaling. 0.4 lands
      // the board around 0.4m wide on the wall, matching the other 3×3
      // wall items (mirror, framed posters, etc.). centerY puts the
      // slot anchor at the visual middle of the board.
      sketchbookPainting:    { id: 'sketchbookPainting',    surface: 'wall', label: 'Corkboard',                source: 'glb', footprint: { w: 3, h: 3 },
                               factory: makeFromGlb('models/projects-corkboard.glb', { forcedScale: 1.4, centerY: true }) },
      digestPainting:        { id: 'digestPainting',        surface: 'wall', label: 'Reader',                   footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/digest.jpg',              W: 0.470, H: 0.551 }) },
      libraryPainting:       { id: 'libraryPainting',       surface: 'wall', label: 'The Bookworm',             footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/library.jpg',             W: 0.306, H: 0.551 }) },
      // Helvetica documentary movie poster — launcher for font-manager.
      // Portrait orientation (~460×680 source), aspect 0.676; sized to
      // match the other portrait posters' 0.315m height.
      fontManagerPainting:   { id: 'fontManagerPainting',   surface: 'wall', label: 'Helvetica poster',         footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/font-manager.jpg',        W: 0.373, H: 0.551 }) },
      // Landscape-orientation pieces (image wider than tall).
      residencyPainting:     { id: 'residencyPainting',     surface: 'wall', label: 'View of Delft',            footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/residency-tracker.jpg',   W: 0.662, H: 0.551 }) },
      // Day-planner poster — dynamic. Renders today's date onto a canvas
      // texture using the viewer's local Date(), so it shows the correct
      // day for whoever's looking at the diorama (not Sami's day baked
      // into a static jpg). Auto-refreshes once a minute to catch the
      // midnight rollover without a reload.
      dayPlannerPainting:    { id: 'dayPlannerPainting',    surface: 'wall', label: "Today's date",             footprint: { w: 3, h: 3 },
                               factory: () => makeCanvasPoster({ paint: paintTodayPoster,                W: 0.483, H: 0.735 }) },
      igstoriesPainting:     { id: 'igstoriesPainting',     surface: 'wall', label: 'Group of friends',         footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/igstories-viewer.jpg',    W: 0.735, H: 0.411 }) },
      // organize-cms — protest website CMS. New source image is
      // portrait 1280×1642 (ratio 0.78), so W/H here are flipped from
      // the other landscape posters. Sized to match the 75% bump applied
      // to the rest of the wall art.
      cmsPainting:           { id: 'cmsPainting',           surface: 'wall', label: 'Organize poster',          footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/organize-cms.jpg',        W: 0.574, H: 0.735 }) },
      followsAuditPainting:  { id: 'followsAuditPainting',  surface: 'wall', label: 'Bar scene',                footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/follows-audit.jpg',       W: 0.735, H: 0.411 }) },
      // Landscape painting for media-tracker.
      mediaTrackerPainting:  { id: 'mediaTrackerPainting',  surface: 'wall', label: 'Panoramic landscape',      footprint: { w: 3, h: 3 },
                               factory: () => makeImagePoster({ path: 'posters/media-tracker.jpg',       W: 0.735, H: 0.441 }) },
      // Procedural posters — kept as fallbacks; no APP currently uses them.
      posterArt:    { id: 'posterArt',    surface: 'wall', label: 'Residency poster',
                      factory: () => makeFramedPoster({ style: 'horizon', art: [0x6b8aab, 0xd9a47a, 0xf2cc8f] }) },
      posterSketch: { id: 'posterSketch', surface: 'wall', label: 'Sketchbook poster',
                      factory: () => makeFramedPoster({ style: 'stripes', art: [0xefe2c8, 0x81b29a, 0x3d5a80] }) },
      posterAudit:  { id: 'posterAudit',  surface: 'wall', label: 'Audit poster',
                      factory: () => makeFramedPoster({ style: 'circle',  art: [0x2a2218, 0xd97a5f] }) },

      // ── Tabletop ───────────────────────────────────────────────────
      // GLB-backed trinkets that sit on the desk. Footprint defaults to
      // 1×1: with the desk top a 12×6 grid (was 4×2), items snap on any
      // single cell. Meshes may overflow their 1-cell anchor visually,
      // which is fine — overlap risk is the price for fine granularity
      // (3×3 fp reserved each item a full quarter of the desk, killing
      // most snap targets). APPS slots use the cell-center mapping
      // (c → 3c+1, r → 3r+1) so existing seeded positions stay put.
      piano:        { id: 'piano',        surface: 'tabletop', label: 'Piano', source: 'glb',
                      factory: makeFromGlb('models/piano.glb', { targetWidth: 0.55, rotateX: -Math.PI / 2 }) },
      bookStack:    { id: 'bookStack',    surface: 'tabletop', label: 'Stack of books', source: 'glb',
                      factory: makeFromGlb('models/books.glb', { targetHeight: 0.45 }) },
      glbInbox:     { id: 'glbInbox',     surface: 'tabletop', label: 'Inbox tray', source: 'glb',
                      factory: makeFromGlb('models/inbox.glb', { targetHeight: 0.30 }) },
      // Item id stays `glbLaptop` (not `glbImac`) so existing
      // localStorage placements and the §1 APPS mapping for `job-search`
      // keep resolving without a migration. Only the model + label
      // changed. targetHeight bumped from 0.20 → 0.32 because an iMac
      // sits taller than a laptop (monitor + stand vs flat clamshell).
      glbLaptop:    { id: 'glbLaptop',    surface: 'tabletop', label: 'iMac', source: 'glb',
                      factory: makeFromGlb('models/imac.glb', {
                        targetHeight: 0.58,
                        // Replace the iMac's bundled screen art with our
                        // own poster. The screen sub-mesh uses a material
                        // literally named "Screen" (verified via GLB
                        // JSON dump); when we spot it, load our texture
                        // and assign it as both the diffuse and emissive
                        // map so the wallpaper still glows.
                        onMesh: (o) => {
                          if (!o.material || o.material.name !== 'Screen') return;
                          // The GLB ships emissive at full white so the
                          // original screen art glows like a real display.
                          // With a photo wallpaper that reads as blown-out
                          // — half the screen is sky and the emissive
                          // doubles up the brightness. Dial emissive way
                          // down so the wallpaper shows at its true colors
                          // with just a gentle screen-glow on top.
                          // Kill the screen-glow path entirely — at any
                          // emissive intensity > 0 the wallpaper photo
                          // gets blown out. Treat the screen as a flat
                          // painted texture lit by the room's lights only.
                          o.material.emissiveIntensity = 0;
                          o.material.emissive.set(0x000000);
                          new THREE.TextureLoader().load('posters/imac-screen.jpg', (tex) => {
                            tex.encoding = THREE.sRGBEncoding;
                            tex.flipY = false; // GLB UVs assume non-flipped
                            o.material.map = tex;
                            o.material.emissiveMap = null;
                            o.material.color.set(0xffffff);
                            o.material.needsUpdate = true;
                          });
                        },
                      }) },
      glbTypewriter:{ id: 'glbTypewriter',surface: 'tabletop', label: 'Typewriter', source: 'glb',
                      factory: makeFromGlb('models/typewriter.glb', { targetHeight: 0.18 }) },
      // Coffee mug on the desk — launcher for kitchen. Sketchfab GLB
      // with baked Y-up orientation, no rotation needed. targetHeight
      // 0.11m (~real mug ~10-12cm tall). Same MeshStandardMaterial
      // reskin as the other Sketchfab GLBs.
      glbMug:       { id: 'glbMug',       surface: 'tabletop', label: 'Coffee mug', source: 'glb',
                      factory: makeFromGlb('models/mug.glb', {
                        targetHeight: 0.11,
                        onMesh: (o) => {
                          const old = o.material;
                          if (!old) return;
                          if (old.map) old.map.encoding = THREE.sRGBEncoding;
                          o.material = new THREE.MeshStandardMaterial({
                            color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
                            map: old.map || null,
                            roughness: 0.55,
                            metalness: 0,
                            side: THREE.DoubleSide,
                          });
                        },
                      }) },
      // Small framed easel painting standing on the desk — launcher for
      // residency-tracker ("Studio"). Sketchfab GLB with the standard
      // baked Y-up orientation, so no rotation. targetHeight 0.22m
      // (~tabletop photo-frame size). Same MeshStandardMaterial reskin
      // as the other Sketchfab GLBs so the scene lights affect it.
      glbPintura:   { id: 'glbPintura',   surface: 'tabletop', label: 'Studio painting', source: 'glb',
                      factory: makeFromGlb('models/pintura-painting.glb', {
                        targetHeight: 0.40,
                        onMesh: (o) => {
                          const old = o.material;
                          if (!old) return;
                          if (old.map) old.map.encoding = THREE.sRGBEncoding;
                          o.material = new THREE.MeshStandardMaterial({
                            color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
                            map: old.map || null,
                            roughness: 0.75,
                            metalness: 0,
                            side: THREE.DoubleSide,
                          });
                        },
                      }) },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // §8 · Surfaces
  // ══════════════════════════════════════════════════════════════════
  // Diorama desk + shelf are not surfaces here — apps don't map onto
  // them in §1. Floor + wall are sufficient to host every app. (We keep
  // desk/shelf as physical structures for atmosphere; they show up as
  // tabletop hosts in §9, so trinkets can land on them.)
  const BACK_WALL_Z = -ROOM.depth / 2;

  class Surface {
    constructor(id) { this.id = id; this.placements = new Map(); }
    getSlotsForItem(_def) { return []; }
    place(_def, _slot, _mesh) { return null; }
    remove(placementId) {
      const p = this.placements.get(placementId);
      if (!p) return false;
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      // Free the detached subtree's GPU resources. This is the universal
      // teardown path (edit-mode delete, modal Move, updateProjects prune),
      // so it's the right single place to dispose. NOTE: the drag flow
      // (pickUpHeld) deliberately does NOT route through here — it reuses
      // the live mesh — so disposal can't corrupt a held piece.
      disposeObject(p.mesh);
      this.placements.delete(placementId);
      markShadowsDirty();
      return true;
    }
  }

  // Multi-panel wall surface. Slot keys are namespaced "panelId:c,r"
  // so each panel (back / left / right) owns its own grid. Items on
  // side walls are rotated ±π/2 around y so their "front" faces into
  // the room (left wall rotation +π/2, right wall rotation -π/2).
  //
  // Grid sizes (cols × rows) per wall — 3× scale from the earlier
  // coarse layout, matching the floor's fine grid:
  //   back   27 × 15  — was 9 × 5. Cells are ~23cm × 18cm.
  //   right  15 × 15  — was 5 × 5.
  //   left   12 × 15  — was 4 × 5. Not used by APPS today; kept usable.
  // Wall item footprints scale by 3 in the same way floor footprints
  // did (default fp went from {w:1, h:1} to {w:3, h:3}; explicit fps
  // multiplied to preserve physical size). MIGRATIONS[12] scales
  // existing saved wall placements 3× to keep them physically in place.
  class WallSurface extends Surface {
    constructor() {
      super('wall');
      // Cell sizes tuned for the 5.4×4.0×3.0m "home-studio" ROOM:
      //   bottomY 0.85 → just above the 0.78m desk top
      //   cellH 0.40/3 ≈ 0.133m → 15 rows × 0.133 = 2.00m grid height,
      //                           top at y = 0.85 + 2.00 = 2.85m (under 3.0m ceiling)
      //   back cellW 0.55/3 ≈ 0.183m → 27 cols × 0.183 = 4.95m (fits in 5.4m width)
      //   left/right cellW 0.72/3 = 0.24m → 12/15 cols × 0.24 = 2.88/3.60m (fits in 4.0m depth)
      this.panels = {
        back: {
          cols: 27, rows: 15,
          cellW: 0.55 / 3, cellH: 0.40 / 3,
          bottomY: 0.85,
          rotation: 0,
          // (c, r, fp.w, fp.h) → world position of slot anchor
          toWorld: (c, r, fpw, fph, p) => {
            const startX = -(p.cols * p.cellW) / 2 + p.cellW / 2;
            const startY = p.bottomY + p.cellH / 2;
            return new THREE.Vector3(
              startX + (c + (fpw - 1) / 2) * p.cellW,
              startY + (r + (fph - 1) / 2) * p.cellH,
              BACK_WALL_Z + 0.02
            );
          },
        },
        left: {
          cols: 12, rows: 15,
          cellW: 0.72 / 3, cellH: 0.40 / 3,
          bottomY: 0.85,
          rotation: Math.PI / 2,
          // c runs along z (back→front), r along y (bottom→top)
          toWorld: (c, r, fpw, fph, p) => {
            const startZ = -(p.cols * p.cellW) / 2 + p.cellW / 2;
            const startY = p.bottomY + p.cellH / 2;
            return new THREE.Vector3(
              -ROOM.width / 2 + 0.02,
              startY + (r + (fph - 1) / 2) * p.cellH,
              startZ + (c + (fpw - 1) / 2) * p.cellW
            );
          },
        },
        right: {
          // Mirror of `left` — 15 × 15 at the fine wall scale. The
          // new camera angle makes the right wall the hero surface.
          // Anchored just inside x=+ROOM.width/2; rotation -π/2 makes
          // items face into the room.
          cols: 15, rows: 15,
          cellW: 0.72 / 3, cellH: 0.40 / 3,
          bottomY: 0.85,
          rotation: -Math.PI / 2,
          // c=0 is at the back of the room (z negative), c=cols-1 at
          // the front — same convention as `left` so authors don't
          // have to flip mental models between walls.
          toWorld: (c, r, fpw, fph, p) => {
            const startZ = -(p.cols * p.cellW) / 2 + p.cellW / 2;
            const startY = p.bottomY + p.cellH / 2;
            return new THREE.Vector3(
              ROOM.width / 2 - 0.02,
              startY + (r + (fph - 1) / 2) * p.cellH,
              startZ + (c + (fpw - 1) / 2) * p.cellW
            );
          },
        },
      };
    }
    parseSlot(slotKey) {
      // Backward compat: slots without a panel prefix are on the back wall
      if (slotKey.includes(':')) {
        const [panelId, coords] = slotKey.split(':');
        const [c, r] = coords.split(',').map(Number);
        return { panelId, c, r };
      }
      const [c, r] = slotKey.split(',').map(Number);
      return { panelId: 'back', c, r };
    }
    occupiedCells() {
      // Per-panel occupied cell sets so panels don't pollute each other.
      const occ = {};
      for (const id of Object.keys(this.panels)) occ[id] = new Set();
      for (const p of this.placements.values()) {
        const def = ITEMS[p.itemId]; if (!def) continue;
        // Default wall footprint is 3×3 at the fine wall grid — one
        // "logical block" matching the 3× scale-up. Items omitting an
        // explicit footprint (corkboard, posterArt, …) now occupy the
        // same physical area they did at the old 1×1 default.
        const fp = def.footprint || { w: 3, h: 3 };
        const { panelId, c, r } = this.parseSlot(p.slot);
        const set = occ[panelId]; if (!set) continue;
        for (let dc = 0; dc < fp.w; dc++)
          for (let dr = 0; dr < fp.h; dr++) set.add(`${c + dc},${r + dr}`);
      }
      return occ;
    }
    getSlotsForItem(def) {
      if (def.surface !== 'wall') return [];
      const fp = def.footprint || { w: 3, h: 3 };
      const occByPanel = this.occupiedCells();
      const slots = [];
      for (const [panelId, panel] of Object.entries(this.panels)) {
        const occ = occByPanel[panelId];
        for (let r = 0; r <= panel.rows - fp.h; r++) {
          for (let c = 0; c <= panel.cols - fp.w; c++) {
            let valid = true;
            for (let dc = 0; dc < fp.w && valid; dc++)
              for (let dr = 0; dr < fp.h && valid; dr++)
                if (occ.has(`${c + dc},${r + dr}`)) valid = false;
            slots.push({
              slotKey: `${panelId}:${c},${r}`,
              worldPos: panel.toWorld(c, r, fp.w, fp.h, panel),
              valid,
              rotation: panel.rotation,
              cellW: panel.cellW,
              cellH: panel.cellH,
            });
          }
        }
      }
      return slots;
    }
    place(def, slotKey, mesh) {
      const found = this.getSlotsForItem(def).find(s => s.slotKey === slotKey && s.valid);
      if (!found) return null;
      mesh.position.copy(found.worldPos);
      if (found.rotation) mesh.rotation.y = found.rotation;
      world.add(mesh);
      // Deterministic placementId — surface + slot uniquely identify a
      // placement (slot occupancy guarantees no collision), and stability
      // across sessions matters for tabletop hosts (their key IS this id).
      const id = `wall:${slotKey}:${def.id}`;
      this.placements.set(id, { itemId: def.id, slot: slotKey, mesh });
      return id;
    }
  }

  // Tabletop surface — items live on TOP of other pieces (the static desk and
  // shelf, plus any flat-topped floor item like a coffee table or nightstand).
  // Each "host" registers a mesh + an array of "tiers" (e.g. a single top
  // surface for a coffee table, or one tier per shelf for a bookcase). Items
  // placed here are added as children of the host's mesh, so they translate /
  // rotate with the host automatically. Slot keys are namespaced
  //   "host:<hostKey>:<tierId>:<c>,<r>"
  // so the tabletop surface can find which host + tier they belong to on
  // restore.
  //
  // Static hosts (DESK / SHELF) get sentinel keys like "static:desk".
  // Dynamic hosts (placed pieces with a `tabletops` config in their item def)
  // get the host's placementId as the key.
  class TabletopSurface extends Surface {
    constructor() {
      super('tabletop');
      // Map<hostKey, { hostKey, mesh, tabletops: [...] }>
      this.hosts = new Map();
    }
    registerHost(hostKey, mesh, tabletops) {
      if (!Array.isArray(tabletops) || !tabletops.length) return;
      this.hosts.set(hostKey, { hostKey, mesh, tabletops });
    }
    unregisterHost(hostKey) {
      // Cascade: remove every tabletop placement that lives on this host, so
      // we don't leave orphan entries in state.placements (caller is
      // responsible for popping them out of state.placements via the
      // returned list).
      const removed = [];
      for (const [pid, p] of [...this.placements.entries()]) {
        const parsed = this.parseSlot(p.slot);
        if (parsed && parsed.hostKey === hostKey) {
          this.remove(pid);
          removed.push(pid);
        }
      }
      this.hosts.delete(hostKey);
      return removed;
    }
    parseSlot(slotKey) {
      // "host:<hostKey>:<tierId>:<c>,<r>"
      // hostKey itself can contain colons (e.g. "floor:1,1:piano-12345"), so
      // split from both ends.
      if (!slotKey.startsWith('host:')) return null;
      const lastColon = slotKey.lastIndexOf(':');
      const cr = slotKey.slice(lastColon + 1).split(',').map(Number);
      const rest = slotKey.slice(0, lastColon); // "host:<hostKey>:<tierId>"
      const tierColon = rest.lastIndexOf(':');
      const tierId = rest.slice(tierColon + 1);
      const hostKey = rest.slice(5, tierColon); // strip "host:"
      return { hostKey, tierId, c: cr[0], r: cr[1] };
    }
    occupiedCellsByHostTier() {
      const occ = {};
      for (const p of this.placements.values()) {
        const parsed = this.parseSlot(p.slot); if (!parsed) continue;
        const def = ITEMS[p.itemId]; if (!def) continue;
        const fp = def.footprint || { w: 1, d: 1 };
        const k = `${parsed.hostKey}|${parsed.tierId}`;
        if (!occ[k]) occ[k] = new Set();
        for (let dc = 0; dc < fp.w; dc++)
          for (let dr = 0; dr < fp.d; dr++)
            occ[k].add(`${parsed.c + dc},${parsed.r + dr}`);
      }
      return occ;
    }
    getSlotsForItem(def) {
      if (def.surface !== 'tabletop') return [];
      const fp = def.footprint || { w: 1, d: 1 };
      const occByHostTier = this.occupiedCellsByHostTier();
      const slots = [];
      for (const [hostKey, host] of this.hosts.entries()) {
        for (const tier of host.tabletops) {
          const cellW = tier.w / tier.cols;
          const cellD = tier.d / tier.rows;
          const occ = occByHostTier[`${hostKey}|${tier.id}`] || new Set();
          for (let r = 0; r <= tier.rows - fp.d; r++) {
            for (let c = 0; c <= tier.cols - fp.w; c++) {
              let valid = true;
              for (let dc = 0; dc < fp.w && valid; dc++)
                for (let dr = 0; dr < fp.d && valid; dr++)
                  if (occ.has(`${c + dc},${r + dr}`)) valid = false;
              const lx = (tier.x || 0) - tier.w / 2 + (c + fp.w / 2) * cellW;
              const lz = (tier.z || 0) - tier.d / 2 + (r + fp.d / 2) * cellD;
              const localPos = new THREE.Vector3(lx, tier.y, lz);
              // World position via host mesh — used for marker placement and
              // to keep the existing slot-marker rendering pipeline (which
              // expects world coords) unchanged.
              const worldPos = localPos.clone();
              host.mesh.updateMatrixWorld(true);
              host.mesh.localToWorld(worldPos);
              slots.push({
                slotKey: `host:${hostKey}:${tier.id}:${c},${r}`,
                worldPos, localPos,
                hostKey, tierId: tier.id,
                cellW, cellD,
                // Pass the host mesh through so the slot marker can be
                // parented to it (and inherit its rotation/translation
                // automatically). Reading host.mesh.rotation.y misses
                // any non-Y rotation a host might pick up later; using
                // the actual mesh as the parent is robust to that.
                hostMesh: host.mesh,
                valid,
              });
            }
          }
        }
      }
      return slots;
    }
    place(def, slotKey, mesh) {
      const found = this.getSlotsForItem(def).find(s => s.slotKey === slotKey && s.valid);
      if (!found) return null;
      const host = this.hosts.get(found.hostKey);
      if (!host) return null;
      // Parent into the host's mesh in LOCAL coords so the item moves with
      // the host (and is automatically detached if the host is removed).
      mesh.position.copy(found.localPos);
      host.mesh.add(mesh);
      const id = `tabletop:${slotKey}:${def.id}`;
      this.placements.set(id, { itemId: def.id, slot: slotKey, mesh });
      return id;
    }
  }

  class FloorSurface extends Surface {
    constructor() {
      super('floor');
      // Fine grid (21×15) — was 7×5. Each old cell is now 3×3 new ones,
      // so cells are ~31cm × 30cm in world units. Every floor-item
      // footprint, every APPS slot coordinate, and every saved-layout
      // placement is scaled by FLOOR_GRID_SCALE (see MIGRATIONS[10]).
      // The 3× factor is reflected in:
      //   - `cols`/`rows` here
      //   - `GRID_COLS`/`GRID_ROWS` in setupRoom (persistent floor grid)
      //   - `EDGE_BLOCK` below (preserves the old 1-cell camera-edge
      //     buffer at the new resolution)
      //   - Floor-surface footprint defaults `{ w: 3, d: 3 }`
      this.cols = 21; this.rows = 15;
      this.cellW = ROOM.width / this.cols;
      this.cellD = ROOM.depth / this.rows;
      this.blockedCells = new Set();
      // Camera sits at the front-right corner (high x / high z), so the
      // cells closest to the camera get blocked entirely — anything
      // placed there would dominate the foreground or clip the frame.
      // Pre-scale this was 1 row / 1 col; at 3× resolution we block 3
      // cells deep on each edge to preserve the same physical buffer.
      const EDGE_BLOCK = 3;
      // Front edge: block the 3 rows closest to the camera across all cols.
      for (let c = 0; c < this.cols; c++) {
        for (let dr = 0; dr < EDGE_BLOCK; dr++) {
          this.blockedCells.add(`${c},${this.rows - 1 - dr}`);
        }
      }
      // Right edge: only block in the FRONT HALF of the room. Back-half
      // right-edge cells are far enough from the camera that they don't
      // clip the foreground, and leaving them placeable means items can
      // sit flush against the right wall — e.g. the floor electric piano
      // tucked under the right-wall window (which spans roughly rows 2-8).
      // Without this carve-out the whole right column reads as a no-go
      // strip even where the wall is empty.
      const RIGHT_BLOCK_FROM_ROW = Math.floor(this.rows / 2); // row 7 → blocks rows 7..14 on cols 18..20
      for (let r = RIGHT_BLOCK_FROM_ROW; r < this.rows; r++) {
        for (let dc = 0; dc < EDGE_BLOCK; dc++) {
          this.blockedCells.add(`${this.cols - 1 - dc},${r}`);
        }
      }
    }
    occupiedCells() {
      const occ = new Set();
      for (const p of this.placements.values()) {
        const def = ITEMS[p.itemId]; if (!def) continue;
        if (def.layer === 'rug') continue;
        // Default footprint = 1×1 (a single ~31cm cell). Earlier this
        // was {3,3} to preserve the physical 90cm block from the
        // pre-fine-grid era, but that meant small items reserved nine
        // cells of mostly-empty space and read as if they had a
        // generous "clear zone" around them. With {1,1} as the default,
        // items without an explicit footprint pack tightly; anything
        // genuinely larger (tallShelf, deskUnit, coffeeTable, …)
        // declares its footprint explicitly in §7.
        const fp = def.footprint || { w: 1, d: 1 };
        // A rotated piece (90°/270°) occupies the swapped footprint.
        const turns = Math.round((p.rotation || 0) / (Math.PI / 2));
        const effFp = (turns % 2 === 0) ? fp : { w: fp.d, d: fp.w };
        const [c, r] = p.slot.split(',').map(Number);
        for (let dc = 0; dc < effFp.w; dc++)
          for (let dr = 0; dr < effFp.d; dr++) occ.add(`${c + dc},${r + dr}`);
      }
      return occ;
    }
    getSlotsForItem(def) {
      if (def.surface !== 'floor') return [];
      const fp = def.footprint || { w: 1, d: 1 };
      const occ = this.occupiedCells();
      const slots = [];
      for (let r = 0; r <= this.rows - fp.d; r++) {
        for (let c = 0; c <= this.cols - fp.w; c++) {
          let valid = true;
          for (let dc = 0; dc < fp.w && valid; dc++) {
            for (let dr = 0; dr < fp.d && valid; dr++) {
              const k = `${c + dc},${r + dr}`;
              // Rugs bypass BOTH the camera-edge block AND other items'
              // occupied cells — they're decorative underlay and the
              // user wants total freedom to drag them anywhere.
              if (def.layer === 'rug') continue;
              if (this.blockedCells.has(k) || occ.has(k)) valid = false;
            }
          }
          const ax = -ROOM.width / 2 + (c + fp.w / 2) * this.cellW;
          const az = -ROOM.depth / 2 + (r + fp.d / 2) * this.cellD;
          slots.push({ slotKey: `${c},${r}`, worldPos: new THREE.Vector3(ax, 0, az), valid });
        }
      }
      return slots;
    }
    place(def, slotKey, mesh) {
      const found = this.getSlotsForItem(def).find(s => s.slotKey === slotKey && s.valid);
      if (!found) return null;
      mesh.position.copy(found.worldPos);
      if (def.layer === 'rug') mesh.position.y = 0.005;
      world.add(mesh);
      const id = `floor:${slotKey}:${def.id}`;
      this.placements.set(id, { itemId: def.id, slot: slotKey, mesh });
      return id;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // §9 · Room geometry — physical structures + scene + GLB preload
  // ══════════════════════════════════════════════════════════════════
  // DESK dimensions used by the deskUnit ITEM's GLB scaling and its
  // tabletop tier. Not a placement — the desk is a regular movable item
  // now (see deskUnit in §7 + ensureDecorations() below).
  // Hero desk sized to dominate the back wall: 2.4m wide / 0.75m deep /
  // 2.4m wide × 0.90m deep × 0.78m tall. The depth was bumped from
  // 0.75m to 0.90m so the desk mesh fills its 6×3 floor footprint (3
  // cells × cellD 0.30m = 0.90m). With the old 0.75m depth, placing
  // the desk at r=0 left a visible 7.5cm gap between the mesh's back
  // edge and the back wall — the user couldn't drag it flush against
  // the wall. At 0.90m the mesh exactly fills the footprint so r=0
  // anchors the desk's back edge ON the wall plane.
  // Sized up after the 2026-05 home-studio room rescale: a 2.4m desk
  // in a 5.4m room still read as small. 3.0m × 1.0m × 0.78m is closer
  // to a real "executive home office" footprint (think double-monitor
  // setup with room for inbox trays + a laptop dock). Mesh overhangs
  // its 6×3 floor-cell footprint on all sides — that's fine, the
  // footprint only governs placement validity, not visual bounds.
  const DESK = {
    w: 3.0, d: 1.00, h: 0.78,
  };

  // ── §9 · setup ───────────────────────────────────────────────────
  function setupScene() {
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    container.style.position = 'relative';
    container.appendChild(canvas);

    // A GPU reset / driver hiccup (common on macOS laptops that switch
    // between integrated and discrete GPUs, and in long-lived Electron
    // windows) fires 'webglcontextlost'. Without handling it, the next
    // renderer.render() throws, the rAF chain never re-arms, and the home
    // view freezes for the rest of the session. Pause the loop on loss and
    // resume it on restore (Three re-uploads GPU resources as we re-render).
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (animFrame != null) { cancelAnimationFrame(animFrame); animFrame = null; }
      console.warn('[diorama] WebGL context lost — pausing render loop');
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[diorama] WebGL context restored — resuming');
      markShadowsDirty();
      // Only resume the loop if the diorama is actually visible — if the
      // context was lost while hidden behind a launched app, show() will
      // restart it. Resuming here would render a fully-occluded scene.
      if (container && !container.hasAttribute('hidden')) startAnimation();
    }, false);

    // `alpha: true` lets the canvas have a transparent clear color when the
    // diorama runs as a desktop surface (see setBackgroundTransparent). It's a
    // no-op in normal mode: scene.background stays opaque and the clear color
    // is forced opaque just below, so nothing changes unless we ask it to.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Don't re-render shadow maps every frame — the scene is static except
    // for blinds tweens / edit-mode changes. The animation loop flips
    // needsUpdate on only when something actually moved (see shadowsDirty).
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.outputEncoding = THREE.sRGBEncoding;
    // No tone mapping — we want sharp, direct contrast across the
    // whole scene. ACES (previously here) was rolling blacks toward
    // charcoal and softening mid-tones for a "cinematic" feel, which
    // read as a haze over the room. NoToneMapping passes linear→sRGB
    // values straight through, so colors land at their actual values.
    //
    // Side effect: bright surfaces can clip toward white if the
    // lighting rig overdrives them. If anything reads too hot,
    // turn down the relevant light's intensity in the lighting
    // setup below rather than reintroducing tone-curve smoothing.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 0.45;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.bg);
    // Force an opaque clear color to match the background. setBackgroundTransparent
    // flips both of these together when running as a desktop surface.
    renderer.setClearColor(new THREE.Color(PALETTE.bg), 1);
    // Re-apply desktop transparency if it was requested before the scene existed.
    if (_bgTransparent) setBackgroundTransparent(true);
    // Fog disabled (was new THREE.Fog(0xcdb89a, 4.1, 14.0)). At 120°
    // FOV the strong fog read as "smoke in the room" rather than
    // atmospheric depth — corners of the wide frame were too hazed.
    // Re-enable via the lighting debugger if a softer look is wanted.
    scene.fog = null;
    // (HDRI environment removed — was hurting the scene's contrast
    // by washing in too much uniform ambient from the studio HDR.)

    // Three-quarter angle on the back-wall workspace (shelf + posters
    // + desk) with the right wall edging into the right side of frame
    // so the relocated RIGHT_WINDOW reads as a "window off to the
    // side." Camera stays in the front-left area of the room and the
    // look-target is shifted RIGHT (positive X) so the view rotates
    // toward the right wall. Pair with BASE_FOV=42° (was 34°) to widen
    // enough that the right wall isn't completely cropped. Tune in the
    // in-app camera debugger (press `C`).
    camera = new THREE.PerspectiveCamera(baseFov, 1, 0.1, 60);
    camera.position.set(-0.70, 1.62, 2.73);
    const _camTarget = new THREE.Vector3(2.60, 0.70, -11.30);
    camera.lookAt(_camTarget);
    _parallaxBasePos = camera.position.clone();
    _parallaxBaseTarget = _camTarget.clone();

    // (Post-processing pipeline removed — scene renders direct to canvas.)

    // ── Lighting rig (re-tunable via lighting debugger, press `L`) ─
    // HDRI handles ambient + reflections. The lights below add the
    // directionality / contrast that HDRI alone can't provide.
    // Ceiling and fill start at 0 intensity (off) — dial up as needed
    // via the debugger. Ambient is similarly low since HDRI does most
    // of that work; bump it up only if shadows crush too dark.

    // Ambient is intentionally lower than before so the sun streak from
    // winLight carries more of the room's brightness — that way dropping
    // the shades produces a real "the room got dim" contrast. The blinds
    // animation also lerps this value (see _blinds.ambientBase) so
    // ambient sags slightly when the shades are down.
    const ambient = new THREE.AmbientLight(0xfff1d8, 0.38);
    scene.add(ambient);
    _lights.ambient = ambient;

    // Window — positioned OUTSIDE the right wall, aligned with the
    // RIGHT_WINDOW cutout (world x≈3.25, y=2.30, z=-0.50). From there
    // it shines through the opening into the room so shadows fall
    // leftward across the floor, reading as "afternoon sun streaming
    // through the side window." Currently off (intensity 0); turn up
    // in the debugger to use it.
    // winLight intensity was 0.13 (effectively off — was meant for
    // manual debugger use). Bumped to 0.95 so the sun streak is the
    // dominant light source when the shades are up. With ambient dropped
    // to 0.38, raising vs lowering the shades now produces a strong
    // "bright noon vs. cozy afternoon" swing instead of a subtle nudge.
    const winLight = new THREE.DirectionalLight(0xfff2dc, 0.95);
    winLight.position.set(6.0, 3.5, -0.5);           // outside & slightly above the side window
    winLight.target.position.set(5.08, 3.11, -0.58); // aimed back at the window to streak sunlight inward
    scene.add(winLight.target);
    winLight.castShadow = true;
    winLight.shadow.mapSize.set(4096, 4096);
    winLight.shadow.camera.near = 0.5;
    winLight.shadow.camera.far  = 14;
    winLight.shadow.camera.left   = -4;
    winLight.shadow.camera.right  =  4;
    winLight.shadow.camera.top    =  4;
    winLight.shadow.camera.bottom = -3;
    winLight.shadow.bias = -0.0004;
    winLight.shadow.normalBias = 0.015;
    winLight.shadow.radius = 20.50;
    scene.add(winLight);
    _lights.winLight = winLight;
    _lights.winHelper = new THREE.DirectionalLightHelper(winLight, 1.0);
    _lights.winHelper.visible = false;
    scene.add(_lights.winHelper);

    const ceilLight = new THREE.DirectionalLight(0xeae2d0, 0.29);
    ceilLight.position.set(-0.5, 7, 0.5);
    ceilLight.target.position.set(-0.50, 6.74, -0.47);
    scene.add(ceilLight.target);
    // Fill light only — does NOT cast shadows. winLight is the sole shadow
    // caster so that drawing the blinds (which dims winLight) only fades the
    // one shadow in place. If ceil/fill also cast, dimming winLight lets
    // their differently-angled shadows take over and the shadow appears to
    // jump position. From this fixed camera their shadows were mostly hidden
    // behind their objects anyway, so the lit look is essentially unchanged.
    ceilLight.castShadow = false;
    ceilLight.shadow.mapSize.set(2048, 2048);
    ceilLight.shadow.camera.near = 0.5;
    ceilLight.shadow.camera.far  = 10;
    ceilLight.shadow.camera.left   = -4;
    ceilLight.shadow.camera.right  =  4;
    ceilLight.shadow.camera.top    =  4;
    ceilLight.shadow.camera.bottom = -4;
    ceilLight.shadow.bias = -0.0004;
    ceilLight.shadow.normalBias = 0.015;
    ceilLight.shadow.radius = 24.75;
    scene.add(ceilLight);
    _lights.ceilLight = ceilLight;
    _lights.ceilHelper = new THREE.DirectionalLightHelper(ceilLight, 1.0);
    _lights.ceilHelper.visible = false;
    scene.add(_lights.ceilHelper);

    const fillLight = new THREE.DirectionalLight(0xfff1d8, 0.18);
    fillLight.position.set(0, 3, 6);
    fillLight.target.position.set(-0.44, 2.76, 5.14);
    scene.add(fillLight.target);
    fillLight.castShadow = false; // fill only — see ceilLight note (winLight is the sole caster)
    fillLight.shadow.mapSize.set(2048, 2048);
    fillLight.shadow.camera.near = 0.5;
    fillLight.shadow.camera.far  = 14;
    fillLight.shadow.camera.left   = -4;
    fillLight.shadow.camera.right  =  4;
    fillLight.shadow.camera.top    =  4;
    fillLight.shadow.camera.bottom = -3;
    fillLight.shadow.bias = -0.0004;
    fillLight.shadow.normalBias = 0.015;
    fillLight.shadow.radius = 13.50;
    scene.add(fillLight);
    _lights.fillLight = fillLight;
    _lights.fillHelper = new THREE.DirectionalLightHelper(fillLight, 1.0);
    _lights.fillHelper.visible = false;
    scene.add(_lights.fillHelper);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    markerGroup = new THREE.Group();
    scene.add(markerGroup);

    onResize();
  }

  function setupRoom() {
    world = new THREE.Group();
    scene.add(world);

    // floor
    const floorTex = new THREE.TextureLoader().load('textures/wood-floor.jpg');
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    // Floor plane extends past the room's placement grid in every
    // direction so the camera doesn't see past the room edges to the
    // sky backdrop. The FLOOR SURFACE (slot grid in FloorSurface) is
    // unchanged at ROOM.width × ROOM.depth, so items still only place
    // inside the room — the extra is purely visual.
    const FLOOR_OVERHANG = 3.0;
    const floorW = ROOM.width + FLOOR_OVERHANG * 2;
    const floorD = ROOM.depth + FLOOR_OVERHANG * 2;
    // Repeat scaled with the bigger floor so the herringbone tile stays
    // consistent in size at the room dimensions. Equal U/V because the
    // texture is square (2048×2048) and the herringbone pattern reads
    // best at the same density in both axes — ~3 tile repeats across
    // the room gives chevrons sized like real ~15cm boards.
    floorTex.repeat.set(3 * floorW / ROOM.width, 3 * floorD / ROOM.depth);
    floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // Normal + roughness maps derived from the wood-floor albedo (Sobel
    // height→normal, luminance→roughness; see textures/*.normal.png /
    // *.rough.png). The normal map gives the grain real relief so the key
    // light grazes across the boards instead of reading as a printed photo,
    // and the roughness map varies the gloss so the floor no longer catches
    // the light as one flat sheet (a big part of the earlier "flat" look).
    // Both MUST stay in linear space — do NOT set sRGBEncoding on them —
    // and share the diffuse map's wrap + repeat + anisotropy so the grain,
    // relief and gloss all line up board-for-board.
    const _floorAux = (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.copy(floorTex.repeat);
      t.anisotropy = floorTex.anisotropy;
      return t;
    };
    const floorNormalTex = _floorAux(new THREE.TextureLoader().load('textures/wood-floor.normal.png'));
    const floorRoughTex  = _floorAux(new THREE.TextureLoader().load('textures/wood-floor.rough.png'));
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorW, floorD),
      new THREE.MeshStandardMaterial({
        map: floorTex,
        normalMap: floorNormalTex,
        // normalScale < 1 keeps the grain relief subtle (real boards are
        // nearly flat); bump toward 1.0 for a more rugged, rustic plank.
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughnessMap: floorRoughTex,
        // roughness is a MULTIPLIER on the map (which already bakes the
        // 0.50–0.80 range), so keep it at 1.0 to use the map's values as-is.
        roughness: 1.0,
        metalness: 0.04,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    world.add(floor);
    // Persistent floor grid — lines at the actual FloorSurface cell
    // boundaries (21 cols × 15 rows over ROOM.width × ROOM.depth, so
    // each cell is roughly 30cm square). Always visible: this is the
    // Sims / Animal Crossing build-mode look, not just placement-time
    // highlights. FloorSurface constants are duplicated here because
    // SURFACES isn't constructed yet when setupRoom runs; if
    // FloorSurface's dimensions change, update both.
    const GRID_COLS = 21;
    const GRID_ROWS = 15;
    const GRID_CELL_W = ROOM.width / GRID_COLS;
    const GRID_CELL_D = ROOM.depth / GRID_ROWS;
    const gridMat = new THREE.LineBasicMaterial({
      color: PALETTE.floorTile, transparent: true, opacity: 0.32,
    });
    // Vertical lines (along z, one per column boundary including the
    // outer edges).
    for (let c = 0; c <= GRID_COLS; c++) {
      const x = -ROOM.width / 2 + c * GRID_CELL_W;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, 0.001, -ROOM.depth / 2),
        new THREE.Vector3(x, 0.001,  ROOM.depth / 2),
      ]);
      world.add(new THREE.Line(g, gridMat));
    }
    // Horizontal lines (along x, one per row boundary).
    for (let r = 0; r <= GRID_ROWS; r++) {
      const z = -ROOM.depth / 2 + r * GRID_CELL_D;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-ROOM.width / 2, 0.001, z),
        new THREE.Vector3( ROOM.width / 2, 0.001, z),
      ]);
      world.add(new THREE.Line(g, gridMat));
    }

    // Shared stucco-relief loader for the ceiling + walls. The diffuse
    // colour stays flat (no `map`); we only drive a normal map (and, on the
    // walls, a roughness map) off wall-stucco.jpg so painted plaster catches
    // the light with real surface texture instead of reading as a flat fill.
    // `repU`/`repV` are tile counts because these surfaces use 0–1 UVs
    // (PlaneGeometry, and buildWallGeometry's normalised wall UVs). These
    // maps MUST stay linear — never set sRGBEncoding on a normal/roughness
    // map or the lighting goes wrong.
    const _stuccoTex = (file, repU, repV) => {
      const t = new THREE.TextureLoader().load(file);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repU, repV);
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return t;
    };

    // ── Ceiling ───────────────────────────────────────────────────────
    // Flat plane at y=ROOM.height, normal facing down into the room.
    // NO overhang (unlike the floor) — extending past the room would
    // jut into the camera's view cone through the right-wall window
    // and visibly block the upper portion of the sky. The walls meet
    // the ceiling flush at y=ROOM.height, so no overhang is needed
    // for visual sealing. Warm off-white, slightly lighter than the
    // wall hex (0xb4ac9c) so the camera reads the top of the frame
    // as "ceiling, not wall."
    // castShadow:false — directional lights coming from above (winLight,
    // ceilLight) should still illuminate the room. receiveShadow:true
    // catches any upward-cast shadows from items below (none today,
    // but cheap to keep on).
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.width, ROOM.depth),
      new THREE.MeshStandardMaterial({
        color: 0xe8e0d2, roughness: 0.92, metalness: 0,
        // Very subtle plaster texture — just enough to break up the flat
        // off-white so the ceiling doesn't read as a blank card.
        normalMap: _stuccoTex('textures/wall-stucco.normal.png', 3.8, 2.8),
        normalScale: new THREE.Vector2(0.25, 0.25),
      })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, ROOM.height, 0);
    ceiling.castShadow = false;
    ceiling.receiveShadow = true;
    world.add(ceiling);

    // Flat painted walls — warm gallery off-white.
    // Tweak the hex here to repaint the whole room instantly. Note
    // the lighting rig totals ~1.9× intensity at lit surfaces and
    // ~0.3× at shadowed ones, so this hex is chosen to (a) not clip
    // to pure white on the lit side, and (b) still read as warm
    // off-white rather than dark beige on the shadow side. Source
    // sRGB lands around #e0d8c4 lit and #4a4538 shadowed — that's
    // the dynamic range that makes the room feel volumetric.
    // Stucco normal + roughness on the walls: keep the flat sage colour
    // (set elsewhere via the palette / lighting debugger) but give the paint
    // plaster relief and slight gloss variation. roughness stays at 1.0 as a
    // multiplier — the map already bakes the 0.82–0.95 range. normalScale is
    // modest so the texture reads as a wall, not orange-peel.
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x1c2b22, roughness: 1.0, metalness: 0,
      normalMap: _stuccoTex('textures/wall-stucco.normal.png', 3.8, 2.1),
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughnessMap: _stuccoTex('textures/wall-stucco.rough.png', 3.8, 2.1),
    });
    _lights.wallMat = wallMat;
    // Restore any user-chosen wall paint (click-a-wall color picker).
    // Done here so it overrides the factory hex the moment the material
    // exists, before the first render.
    applyWallColor(loadWallColor());

    // Walls are built as ShapeGeometry — a rectangle with rectangular
    // holes punched out for each window. Real geometry holes (vs the
    // earlier alphaMap discard) are reliable across Three.js versions
    // and don't fight the renderer's transparency sort. The mesh
    // geometry is rebuilt by rebuildWallGeometry() on every save.
    //
    // v7: back wall is now SOLID — the big architectural window has
    // been removed in favour of the low-poly diorama look (the task
    // board lives on the left wall, not against the back). User-placed
    // glbWindow items can still cut their own holes via cutsThroughWall.
    // receiveShadow:true on every wall so the wooden frames around
    // paintings cast proper gap-shadows onto the wall behind them —
    // that's the cue the eye reads as "this thing is attached to
    // the wall" rather than "this thing is floating in front of it."
    const wall = new THREE.Mesh(
      buildWallGeometry(ROOM.width, ROOM.height, []),
      wallMat
    );
    wall.position.set(0, ROOM.height / 2, BACK_WALL_Z);
    wall.receiveShadow = true;
    world.add(wall);
    _backWallMesh = wall;

    // Left wall (faces +x toward the room).
    // PlaneGeometry default normal is +z; rotate +π/2 around Y to face +x.
    const leftWall = new THREE.Mesh(
      buildWallGeometry(ROOM.depth, ROOM.height, []),
      wallMat
    );
    leftWall.rotation.y = Math.PI / 2;
    leftWall.position.set(-ROOM.width / 2, ROOM.height / 2, 0);
    leftWall.receiveShadow = true;
    world.add(leftWall);
    _leftWallMesh = leftWall;

    // Right wall (faces -x toward the room). Holds the static window
    // (RIGHT_WINDOW const) baked directly into its geometry — the right
    // wall has no slot grid so a static cut is safe and avoids paying
    // the rebuild cost on every dynamic wall change.
    const rightHoles = [{
      x: RIGHT_WINDOW.x,
      y: RIGHT_WINDOW.y,
      w: RIGHT_WINDOW.w,
      h: RIGHT_WINDOW.h,
    }];
    const rightWall = new THREE.Mesh(
      buildWallGeometry(ROOM.depth, ROOM.height, rightHoles),
      wallMat
    );
    rightWall.rotation.y = -Math.PI / 2;
    rightWall.position.set(ROOM.width / 2, ROOM.height / 2, 0);
    rightWall.receiveShadow = true;
    world.add(rightWall);
    _rightWallMesh = rightWall;

    // ── Window casing / molding ───────────────────────────────────────
    // Four wooden bars wrapping the RIGHT_WINDOW cutout. The right wall
    // is rotated y=-π/2, so wall-local +X maps to world +Z (front of
    // room). Casing bars therefore run along world Z (for top/bottom)
    // and world Y (for front/back jambs), and protrude into the room
    // along world -X.
    {
      const winMolMat = new THREE.MeshStandardMaterial({
        color: 0xf0ece4, roughness: 0.60, metalness: 0,
      });
      const MW = 0.08;            // casing width (visible band of trim)
      const MD = 0.04;            // casing depth (protrusion from wall)
      const winW = RIGHT_WINDOW.w; // along world Z
      const winH = RIGHT_WINDOW.h; // along world Y
      const cx   = RIGHT_WINDOW.x;                          // wall-local x → world z
      const cy   = ROOM.height / 2 + RIGHT_WINDOW.y;        // world y of window center
      const wx   = ROOM.width / 2 - MD / 2 - 0.005;         // world x, just proud of wall plane
      const wz   = cx;                                      // world z = wall-local x (see above)
      const outerW = winW + 2 * MW;

      // Top/bottom bars span the window's Z extent; thickness along Y is MW; depth along X is MD.
      // castShadow:false on all four casing bars — at winLight's
      // strong angle the bars project a hard window-frame rectangle
      // onto the floor that reads as a graphic overlay, not light. The
      // light streak from the cutout itself (an absence of shadow caster
      // in the wall opening) is enough atmosphere; the casing only
      // needs to receive shadow so it picks up the room's overall light.
      const top = new THREE.Mesh(new THREE.BoxGeometry(MD, MW, outerW), winMolMat);
      top.position.set(wx, cy + winH / 2 + MW / 2, wz);
      top.castShadow = false; top.receiveShadow = true;
      world.add(top);

      const bot = new THREE.Mesh(new THREE.BoxGeometry(MD, MW, outerW), winMolMat);
      bot.position.set(wx, cy - winH / 2 - MW / 2, wz);
      bot.castShadow = false; bot.receiveShadow = true;
      world.add(bot);

      // Front/back jambs span the window's Y extent; thickness along Z is MW; depth along X is MD.
      const frontJamb = new THREE.Mesh(new THREE.BoxGeometry(MD, winH, MW), winMolMat);
      frontJamb.position.set(wx, cy, wz + winW / 2 + MW / 2);
      frontJamb.castShadow = false; frontJamb.receiveShadow = true;
      world.add(frontJamb);

      const backJamb = new THREE.Mesh(new THREE.BoxGeometry(MD, winH, MW), winMolMat);
      backJamb.position.set(wx, cy, wz - winW / 2 - MW / 2);
      backJamb.castShadow = false; backJamb.receiveShadow = true;
      world.add(backJamb);

      // ── Interactive shades (click the window to raise/lower) ─────────
      // Horizontal slats stacked vertically. Click toggles between two
      // poses:
      //   CLOSED — slats spread evenly across the window, narrow gaps
      //            ("slots") between each one. Light shows through the
      //            slats themselves (translucent fabric) AND through the
      //            gaps. The window is mostly covered.
      //   OPEN   — slats bunch up at the top of the window, like a Roman
      //            shade pulled up. Most of the window is clear; the
      //            stacked slats sit as a small band along the top.
      //
      // Each slat has two stored y-positions (userData.closedY/openY)
      // and the animation loop lerps position.y between them by
      // `progress` (1 = closed/spread, 0 = open/bunched).
      //
      // Translucent material lets the sky tint through the slats —
      // combined with the gaps, this reads as "light filtering through
      // the blinds" rather than a solid panel.
      const blindMat = new THREE.MeshStandardMaterial({
        color: 0xf6ecd6, roughness: 0.6, metalness: 0,
        transparent: true,
        opacity: 0.92,           // mostly solid — only a faint tint of sky bleeds through the slat itself
        side: THREE.DoubleSide,  // backface visible from outside-the-room rays
        depthWrite: false,       // so slats behind don't punch holes in slats in front
      });
      const SLAT_COUNT  = 24;     // many slats, tightly packed → only thin slots of light show through
      const SLAT_THK    = 0.006;  // along local X — slim edge profile
      const SLAT_W      = 0.055;  // along local Y — slat face height (≈ 80% of spacing, leaving ~1cm slots)
      const SLAT_L      = winW - 0.06; // along local Z — leave clearance from jambs
      const SLAT_MARGIN = 0.04;    // top/bottom clearance from window edges
      const slatBlindX  = ROOM.width / 2 - 0.05; // just inside the wall plane

      // Closed: evenly spread across the window's vertical span.
      const spanH         = winH - 2 * SLAT_MARGIN;
      const closedSpacing = spanH / (SLAT_COUNT - 1);
      // Open: slats bunched into a tight stack at the very top. Stack
      // height is a thin band so the bunched slats read as a valance,
      // not a wall. openLift raises the whole stack a touch so it tucks
      // up under the top molding — the shades read as pulled higher.
      const openStackH    = winH * 0.15;
      const openSpacing   = openStackH / (SLAT_COUNT - 1);
      const openLift      = 0.06;

      const slats = [];
      for (let i = 0; i < SLAT_COUNT; i++) {
        const slat = new THREE.Mesh(
          new THREE.BoxGeometry(SLAT_THK, SLAT_W, SLAT_L),
          blindMat
        );
        // closedY: spread from window bottom (i=0) to top (i=N-1).
        // openY:   stack tight just below the window top, top slat at the
        //          same position it occupies when closed.
        const closedY = cy + (-spanH / 2 + i * closedSpacing);
        const openY   = cy + ( spanH / 2 - (SLAT_COUNT - 1 - i) * openSpacing) + openLift;
        // Start at openY so the room loads with the shades up — matches
        // the _blinds.currentProgress = 0 initial state below.
        slat.position.set(slatBlindX, openY, wz);
        slat.castShadow = false;
        slat.receiveShadow = true;
        // Render after the opaque scene so the sky tint composites
        // correctly through the translucent fabric.
        slat.renderOrder = 1;
        slat.userData.closedY = closedY;
        slat.userData.openY   = openY;
        world.add(slat);
        slats.push(slat);
      }

      // Invisible click target — sized slightly larger than the window
      // opening for forgiving clicks at the edges. visible:true with
      // opacity:0 so raycaster still hits it (visible:false would
      // disqualify it).
      const hitPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(winW + 0.04, winH + 0.04),
        new THREE.MeshBasicMaterial({
          transparent: true, opacity: 0, depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      hitPlane.position.set(ROOM.width / 2 - 0.03, cy, wz);
      hitPlane.rotation.y = -Math.PI / 2;
      world.add(hitPlane);

      _blinds = {
        slats,
        hitPlane,
        // 1 = fully closed (spread), 0 = fully open (bunched at top).
        // Animation loop lerps current → target. Default to OPEN — the
        // room reads brightest on first paint (sun streaming in) and
        // the user can click the window to draw the shades.
        currentProgress: 0,
        targetProgress:  0,
        isOpen: true,
        // Window-light coupling. Captured at setup so the animation
        // loop can scale `_lights.winLight.intensity` AND
        // `_lights.ambient.intensity` with the shade position. Tune both
        // base values via the lighting debugger (press L) WITH SHADES
        // UP, so these snapshots reflect the desired "open" reference.
        //   winLight: drops to 6% when fully drawn — kills the sun
        //     streak almost entirely (matches blackout-shade feel).
        //   ambient:  drops to 55% — the room overall dims but stays
        //     readable; HDRI/ceil/fill keep it from going pitch black.
        winLightBase:        _lights.winLight ? _lights.winLight.intensity : 0,
        winLightDimAtClosed: 0.06,
        ambientBase:         _lights.ambient  ? _lights.ambient.intensity  : 0,
        ambientDimAtClosed:  0.55,
      };
    }

    // ── Wainscoting / baseboard molding ───────────────────────────────
    // Builds a classic base-molding strip + raised panel frames for a
    // given wall width. Items are in the group's local XY plane; the
    // group is then positioned just in front of each wall so the molding
    // protrudes into the room toward +Z (local), which maps correctly
    // after any Y rotation applied to the group.
    function buildMolding(wallW) {
      const g = new THREE.Group();
      const moldMat = new THREE.MeshStandardMaterial({ color: 0xf0ece4, roughness: 0.60, metalness: 0 });

      const BASE_H = 0.10;  // baseboard height
      const BASE_D = 0.06;  // baseboard depth (protrusion)

      // Baseboard strip only
      const base = new THREE.Mesh(new THREE.BoxGeometry(wallW, BASE_H, BASE_D), moldMat);
      base.position.set(0, BASE_H / 2, BASE_D / 2);
      base.castShadow = true; base.receiveShadow = true;
      g.add(base);

      return g;
    }

    // Back wall — group sits just in front of the wall plane
    const backMolding = buildMolding(ROOM.width);
    backMolding.position.set(0, 0, BACK_WALL_Z + 0.012);
    world.add(backMolding);

    // Left wall — same geometry rotated +90° so it runs along Z
    const leftMolding = buildMolding(ROOM.depth);
    leftMolding.rotation.y = Math.PI / 2;
    leftMolding.position.set(-ROOM.width / 2 + 0.012, 0, 0);
    world.add(leftMolding);

    // Right wall molding — mirror of the left
    const rightMolding = buildMolding(ROOM.depth);
    rightMolding.rotation.y = -Math.PI / 2;
    rightMolding.position.set(ROOM.width / 2 - 0.012, 0, 0);
    world.add(rightMolding);

    // Sky planes behind each wall — visible only through window cutouts.
    // Sized larger than their walls so the cut edges always have sky
    // backing (no black slivers if a window straddles the wall edge).
    //
    // The texture comes from makeAnimatedSky(): a canvas that draws a
    // sky gradient + city silhouette + drifting clouds. We capture its
    // update(dt) into _skyUpdate so the render loop can advance the
    // clouds each frame. fog/toneMapped are both off so the backdrop
    // renders at its true colors regardless of the scene's lighting
    // and post-processing.
    const sky = makeAnimatedSky();
    _skyUpdate = sky.update;
    _lights.sky = sky;
    const skyMat = new THREE.MeshBasicMaterial({
      map: sky.texture,
      fog: false,
      toneMapped: false,
    });
    // Sky planes pushed far behind their walls so the view through the
    // window reads as genuine outdoor distance, not a sticker stuck on
    // the back of the wall. SKY_DEPTH is the world-unit offset from
    // the wall plane; the visible window cone at the sky scales with
    // (1 + SKY_DEPTH / d_window), so doubling the depth roughly
    // doubles the world-span of canvas content shown through the
    // window.
    //
    // At 20 the window views ~55% of the canvas vertically (cloud
    // band + horizon + city silhouette all in view at once), compared
    // to ~24% at the original 5. The existing plane size still covers
    // the wider cone at all reasonable parallax/orbit angles.
    //
    // Pairs with the camera parallax (PARALLAX_RANGE_X/Y) to produce
    // the through-the-window depth effect — near objects shift more
    // than the far sky as the camera nudges with the cursor.
    const SKY_DEPTH = 20.0;

    // backSky plane removed when the architectural window moved off the
    // back wall — the back wall is now solid, so no skybox ever rendered
    // behind it. Restore from git history if a back window is reintroduced.

    const leftSky = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.depth + 12, ROOM.height + 8),
      skyMat
    );
    leftSky.rotation.y = Math.PI / 2;
    leftSky.position.set(-ROOM.width / 2 - SKY_DEPTH, ROOM.height / 2, 0);
    world.add(leftSky);

    // Right sky — sized + positioned for the live camera framing.
    //
    // With the current camera (0.07, 1.60, 2.38) → target
    // (1.70, 0.70, -11.30), the line of sight through the RIGHT_WINDOW
    // center (2.7, 1.80, -0.50) hits this sky plane (at world x ≈ 22.7)
    // at ≈ (22.7, 3.32, -22.40) — way off in -z. A symmetric mirror of
    // the leftSky plane (16m × 11m centered at z=0) misses it
    // entirely, so the window would render onto the scene-background
    // color instead of the animated sky.
    //
    // Solution: enlarge to 50m × 25m and center on the cone hit point.
    // The horizon (canvas v=0.5) lands at the plane Y center, so the
    // city silhouette appears in the middle of the visible patch
    // through the window. Re-aim if you nudge the camera materially
    // (in the C-debugger): position center should approximately equal
    // the line-of-sight intersection at sky-plane x.
    const rightSky = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 25),
      skyMat
    );
    rightSky.rotation.y = -Math.PI / 2;
    // Y nudged down from the cone-center (3.32) so the whole outdoor view
    // sits lower in the window — easier to take in the full scene
    // (clouds + horizon + skyline) from the current oblique camera angle.
    rightSky.position.set(ROOM.width / 2 + SKY_DEPTH, 2.55, -22.40);
    world.add(rightSky);

    // No static fixtures left — the desk and shelf are now movable items
    // (deskUnit + glbShelf in §7), seeded by ensureDecorations().
    SURFACES = {
      wall: new WallSurface(),
      floor: new FloorSurface(),
      tabletop: new TabletopSurface(),
    };
  }

  // ── Mirror reflection environment ────────────────────────────────────
  // The scene-wide HDRI environment was removed (it washed out contrast),
  // so a fully-metallic material has nothing to reflect and renders black.
  // We load the HDRI separately and assign it as an env map to ONLY the
  // mirror glass material(s) — scene.environment stays null, so the rest of
  // the room's lighting/contrast is unaffected, but the mirror reflects it.
  function loadMirrorEnv() {
    if (_envMap || typeof THREE.RGBELoader === 'undefined' || !renderer) return;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      new THREE.RGBELoader().load('hdris/studio_small_03_1k.hdr', (hdrTex) => {
        hdrTex.mapping = THREE.EquirectangularReflectionMapping;
        _envMap = pmrem.fromEquirectangular(hdrTex).texture;
        hdrTex.dispose();
        pmrem.dispose();
        applyMirrorEnv();
      }, undefined, () => { /* HDRI failed to load — mirror just stays dark */ });
    } catch (e) { /* ignore */ }
  }
  // Retrofit the env map onto any mirror-glass materials currently in the
  // scene. Safe to call repeatedly (after the HDRI loads, after the mirror
  // is placed, after a model refresh) — whichever happens last wins.
  function applyMirrorEnv() {
    if (!_envMap || !scene) return;
    scene.traverse(o => {
      if (o.isMesh && o.userData && o.userData.isMirrorGlass && o.material) {
        o.material.envMap = _envMap;
        o.material.needsUpdate = true;
      }
    });
  }

  // Load all GLBs in parallel. When every load has settled (success or
  // error), onAllLoaded() fires — used during init to defer placement
  // until the cache is warm so no placeholder boxes ever appear.
  // Called without a callback by refreshModels(), which uses the
  // existing swapPlaceholdersForPath mechanism instead.
  function preloadGlbs(onAllLoaded, oldCache) {
    const loader = new THREE.GLTFLoader();
    const paths = [
      'models/piano.glb',
      'models/inbox.glb',
      'models/office-chair.glb',
      'models/standing-desk.glb',
      'models/imac.glb',
      'models/typewriter.glb',
      'models/whiteboard-planner.glb',
      'models/tv-cabinet.glb',
      'models/snake-plant-2.glb',
      'models/filing-cabinet-red.glb',
      'models/carpet.glb',
      'models/electric-piano.glb',
      'models/pintura-painting.glb',
      'models/mug.glb',
      'models/mirror.glb',
      'models/projects-corkboard.glb',
      'models/books.glb',
    ];
    let remaining = paths.length;
    function settle() {
      remaining--;
      if (remaining === 0 && onAllLoaded) onAllLoaded();
    }
    for (const path of paths) {
      loader.load(path, (gltf) => {
        const root = gltf.scene;
        root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        GLB_CACHE[path] = root;
        // No-op during init (no placements yet); useful when called from
        // refreshModels() where placements already exist.
        swapPlaceholdersForPath(path);
        // refreshModels() path: every in-scene clone of `path` has now been
        // re-cloned from the fresh root above, so the previous cached root's
        // geometry (shared with the now-swapped-out old clones, hence skipped
        // by disposeObject during the swap) is finally unreferenced. Dispose
        // it here — only on success, so a failed reload never frees a root
        // whose old clones are still on screen. (No oldCache on cold start.)
        if (oldCache && oldCache[path]) {
          disposeObject(oldCache[path]);
          delete oldCache[path];
        }
        settle();
      }, undefined, (err) => {
        // Count failures too — never block the room on a bad asset.
        console.warn('[diorama] failed to load GLB:', path, err);
        settle();
      });
    }
  }

  // Replace any in-scene wrappers backed by `path` with a freshly-built
  // mesh that uses the (now-cached) GLB. Matches two cases:
  //   1. Placeholder beige boxes from a cold start (tagged with
  //      userData.glbPlaceholderPath on the wrapper) — first-load swap.
  //   2. Already-built GLB clones from a previous load (their child meshes
  //      carry userData.glbSourcePath) — refreshModels swap.
  // Preserves transform, userData, parent, and re-parents any tabletop
  // children if the swapped piece is a host (e.g. deskUnit has trinkets).
  function swapPlaceholdersForPath(path) {
    if (!state || !Array.isArray(state.placements)) return;
    let swapped = false;
    for (const p of state.placements) {
      const surface = SURFACES[p.surface];
      if (!surface) continue;
      const rec = surface.placements.get(p.placementId);
      if (!rec || !rec.mesh) continue;
      const oldMesh = rec.mesh;
      // Match either the cold-start placeholder tag (on the wrapper) or
      // the per-mesh source tag stamped on each cloned mesh above. Walk
      // children for the second case rather than introspecting every
      // candidate's whole subtree on the outside.
      let matches = (oldMesh.userData.glbPlaceholderPath === path);
      if (!matches) {
        oldMesh.traverse(c => {
          if (!matches && c.isMesh && c.userData.glbSourcePath === path) matches = true;
        });
      }
      if (!matches) continue;

      const def = ITEMS[p.itemId];
      if (!def || typeof def.factory !== 'function') continue;

      const newMesh = def.factory();
      newMesh.position.copy(oldMesh.position);
      newMesh.rotation.copy(oldMesh.rotation);
      newMesh.scale.copy(oldMesh.scale);

      newMesh.userData.placementId = p.placementId;
      newMesh.userData.surfaceId = p.surface;
      newMesh.userData.itemId = p.itemId;
      if (oldMesh.userData.appId) newMesh.userData.appId = oldMesh.userData.appId;
      // Preserve the original (pre-userScale) baseScale across the swap.
      // newMesh.scale was just clobbered by oldMesh.scale above, which on
      // a user-resized item already includes the userScale multiplier —
      // cloning it here would compound on the next drag. Reach back to
      // the placeholder's stashed baseScale when it has one, else fall
      // back to the freshly-cloned scale.
      newMesh.userData.baseScale = (oldMesh.userData.baseScale || newMesh.scale).clone();
      newMesh.userData.baseY = newMesh.position.y;
      newMesh.traverse(c => {
        if (c.isMesh) {
          c.userData.placementId = p.placementId;
          c.userData.surfaceId = p.surface;
          c.userData.appId = oldMesh.userData.appId || null;
        }
      });

      // If this piece is a tabletop host, move its trinket children onto
      // the new wrapper before we detach the old one.
      if (SURFACES.tabletop && SURFACES.tabletop.hosts.has(p.placementId)) {
        for (const child of [...oldMesh.children]) {
          // Skip the GLB/placeholder geometry itself — children whose
          // placementId belongs to a tabletop placement on this host are
          // the trinkets we want to migrate.
          if (child.userData && child.userData.placementId &&
              child.userData.placementId !== p.placementId) {
            newMesh.add(child);
          }
        }
        const host = SURFACES.tabletop.hosts.get(p.placementId);
        if (host) host.mesh = newMesh;
      }

      const parent = oldMesh.parent;
      if (parent) {
        parent.remove(oldMesh);
        parent.add(newMesh);
      }
      // Any migrated trinket children were already re-parented onto newMesh
      // above, so the old subtree now only owns geometry we're replacing.
      disposeObject(oldMesh);
      rec.mesh = newMesh;
      swapped = true;
    }
    if (swapped) markShadowsDirty();
  }

  // ══════════════════════════════════════════════════════════════════
  // §10 · Placement engine
  // ══════════════════════════════════════════════════════════════════
  function placePersisted(itemId, surfaceId, slotKey, opts = {}) {
    const def = ITEMS[itemId];
    if (!def) return null;
    const surface = SURFACES[surfaceId];
    if (!surface) return null;
    const mesh = def.factory();
    // surface.place() validates against def.footprint as-is. For a rotated
    // floor piece with a non-square footprint, that check sees the wrong
    // shape (e.g. a 2×1 piano rotated 90° actually needs a 1×2 patch).
    // Pass an effective-footprint clone in that case so validation matches
    // the rotated occupancy. def.id is preserved on the clone so the
    // generated placementId is identical, and occupiedCells() later reads
    // ITEMS[itemId] (the original def) — both safe.
    const rotation = opts.rotation || 0;
    let defForFit = def;
    if (rotation && surfaceId === 'floor') {
      const turns = Math.round(rotation / (Math.PI / 2));
      if (turns % 2 !== 0) {
        // Default floor footprint is 1×1 (single cell).
        const fp = def.footprint || { w: 1, d: 1 };
        defForFit = Object.assign({}, def, { footprint: { w: fp.d, d: fp.w } });
      }
    }
    const placementId = surface.place(defForFit, slotKey, mesh);
    if (!placementId) {
      if (mesh.parent) mesh.parent.remove(mesh);
      return null;
    }
    // Apply persisted rotation. Wall items already have rotation set by
    // the panel (left wall = π/2); skip for those. Floor & tabletop:
    // additive y-rotation. (Floor rotation may shift the mesh's center
    // for non-square footprints — see rotatePlacement for the math.)
    if (rotation && surfaceId !== 'wall') {
      applyFloorRotation(mesh, def, slotKey, rotation, surfaceId);
    }
    // Mirror rotation onto the surface's internal record so its
    // occupiedCells() reports the rotated footprint.
    const surfaceRecord = surface.placements.get(placementId);
    if (surfaceRecord) surfaceRecord.rotation = rotation;
    mesh.userData.placementId = placementId;
    mesh.userData.surfaceId = surfaceId;
    mesh.userData.itemId = itemId;
    if (opts.appId) mesh.userData.appId = opts.appId;
    mesh.traverse(c => {
      if (c.isMesh) {
        c.userData.placementId = placementId;
        c.userData.surfaceId = surfaceId;
        c.userData.appId = opts.appId || null;
      }
    });
    // Capture base transform as a record of the piece's resting pose.
    // (Hover-lift and click-bounce both removed — these fields are kept
    // as metadata in case anything else wants to reference the resting
    // pose later.) Grabbed AFTER applyFloorRotation since rotation can
    // shift Y. baseScale is captured BEFORE applying userScale so the
    // resize handle can recover the natural size to multiply against.
    mesh.userData.baseScale = mesh.scale.clone();
    mesh.userData.baseY = mesh.position.y;
    // Persisted user-resize multiplier (drag-corner UI). Only meaningful
    // on wall items today — applied uniformly to the wrapper. Default 1
    // means no resize; values <1 shrink, >1 grow.
    const userScale = typeof opts.userScale === 'number' && opts.userScale > 0
      ? opts.userScale : 1;
    if (userScale !== 1) {
      mesh.scale.set(
        mesh.userData.baseScale.x * userScale,
        mesh.userData.baseScale.y * userScale,
        mesh.userData.baseScale.z * userScale,
      );
    }
    state.placements.push({
      placementId, itemId, surface: surfaceId, slot: slotKey,
      appId: opts.appId || null, rotation,
      userScale,
    });
    // If this piece declares tabletops, register it as a host so other items
    // can land on top of it. The host key is the placementId itself.
    if (def.tabletops && SURFACES.tabletop) {
      SURFACES.tabletop.registerHost(placementId, mesh, def.tabletops);
    }
    // A new caster entered the scene — refresh shadow maps on the next frame.
    markShadowsDirty();
    return placementId;
  }

  // Applies a quarter-turn rotation to a placed floor/tabletop mesh.
  // Floor pieces with non-square footprint shift their world center because
  // the slot anchor stays at the same (c,r) but the rotated footprint
  // extends in a different direction. Tabletop items (1×1 by default)
  // just rotate in place.
  function applyFloorRotation(mesh, def, slotKey, rotation, surfaceId) {
    mesh.rotation.y = rotation;
    if (surfaceId !== 'floor') return;
    const fp = def.footprint || { w: 1, d: 1 };
    const turns = Math.round(rotation / (Math.PI / 2));
    const effFp = (turns % 2 === 0) ? fp : { w: fp.d, d: fp.w };
    const fs = SURFACES.floor;
    const [c, r] = slotKey.split(',').map(Number);
    mesh.position.x = -ROOM.width / 2 + (c + effFp.w / 2) * fs.cellW;
    mesh.position.z = -ROOM.depth / 2 + (r + effFp.d / 2) * fs.cellD;
  }

  // Bumps a placement's rotation by +90°. For floor pieces with non-square
  // footprint, the rotated footprint must still fit the grid (no out-of-
  // bounds, no blocked cells, no overlap with other placements). Returns
  // true if applied, false if the rotation would overflow.
  function rotatePlacement(placementId) {
    const placement = state.placements.find(p => p.placementId === placementId);
    if (!placement) return false;
    if (placement.surface === 'wall') return false;
    const sObj = SURFACES[placement.surface];
    const sp = sObj && sObj.placements.get(placementId);
    if (!sp || !sp.mesh) return false;
    const def = ITEMS[placement.itemId];
    if (!def) return false;

    const nextRot = ((placement.rotation || 0) + Math.PI / 2) % (Math.PI * 2);

    if (placement.surface === 'floor') {
      const fp = def.footprint || { w: 1, d: 1 };
      const turns = Math.round(nextRot / (Math.PI / 2));
      const newFp = (turns % 2 === 0) ? fp : { w: fp.d, d: fp.w };
      const fs = SURFACES.floor;
      const [c, r] = placement.slot.split(',').map(Number);
      if (c + newFp.w > fs.cols || r + newFp.d > fs.rows) return false;
      // Cells the piece currently occupies (don't count as blockers).
      const turnsCur = Math.round((placement.rotation || 0) / (Math.PI / 2));
      const curFp = (turnsCur % 2 === 0) ? fp : { w: fp.d, d: fp.w };
      const selfCells = new Set();
      for (let dc = 0; dc < curFp.w; dc++)
        for (let dr = 0; dr < curFp.d; dr++) selfCells.add(`${c + dc},${r + dr}`);
      const occ = fs.occupiedCells();
      for (let dc = 0; dc < newFp.w; dc++) {
        for (let dr = 0; dr < newFp.d; dr++) {
          const k = `${c + dc},${r + dr}`;
          if (fs.blockedCells.has(k)) return false;
          if (occ.has(k) && !selfCells.has(k)) return false;
        }
      }
    }

    applyFloorRotation(sp.mesh, def, placement.slot, nextRot, placement.surface);
    placement.rotation = nextRot;
    // The surface's internal record needs the new rotation too, so
    // occupiedCells() returns the rotated footprint.
    sp.rotation = nextRot;
    // Rotation can shift the mesh's resting Y for non-square footprints —
    // refresh the cached baseY so it stays in sync with the new pose.
    sp.mesh.userData.baseY = sp.mesh.position.y;
    markShadowsDirty();  // caster reoriented → refresh shadows
    savePlacements();
    return true;
  }

  function removePlacement(placementId) {
    const idx = state.placements.findIndex(p => p.placementId === placementId);
    if (idx < 0) return;
    const p = state.placements[idx];
    // If the removed piece is a tabletop host, unregister it first. That
    // also removes any tabletop placements sitting on it; we need to mirror
    // those removals in state.placements so the saved layout doesn't keep
    // referencing a host that's gone.
    if (SURFACES.tabletop && SURFACES.tabletop.hosts.has(placementId)) {
      const removedTabletopIds = SURFACES.tabletop.unregisterHost(placementId);
      for (const tid of removedTabletopIds) {
        const tIdx = state.placements.findIndex(x => x.placementId === tid);
        if (tIdx >= 0) state.placements.splice(tIdx, 1);
      }
    }
    SURFACES[p.surface].remove(placementId);
    // Re-fetch idx because the splice above may have shifted positions.
    const idx2 = state.placements.findIndex(x => x.placementId === placementId);
    if (idx2 >= 0) state.placements.splice(idx2, 1);
    if (state.armedItem) showSlotsForItem(state.armedItem);
    savePlacements();
  }

  // ══════════════════════════════════════════════════════════════════
  // §11b · Command layer — undo / redo
  // ══════════════════════════════════════════════════════════════════
  //
  // Every USER-INITIATED placement mutation pushes a command onto
  // undoStack. Internal flows — loadPlacements restore, ensureDecorations
  // seeding, app auto-placement on render — deliberately don't, so undo
  // never tries to reverse setup work. ⌘Z / ⌘⇧Z drive the stacks; both
  // are session-only and capped at MAX_UNDO entries.
  //
  // Undo/redo are no-ops while a piece is armed or held — committing the
  // in-flight gesture first keeps the stack consistent with the visible
  // scene. (Trying to undo mid-drag is otherwise ambiguous: do we drop
  // the held piece first, or unwind the previous action and then drop?
  // The "no-op" answer sidesteps the question; the user can Esc out and
  // then undo.)
  //
  // Commands reference placements by CONTENT (itemId + surface + slot),
  // not by placementId. placementIds embed the slot, so they change on
  // every Move — content matching is the stable lookup. The one
  // ambiguity this introduces: if two placements share the same item at
  // overlapping slots (impossible by construction — slot occupancy
  // prevents it), the lookup could pick the wrong one. In practice we
  // never see that.
  //
  // Command shapes:
  //   { type: 'place',  itemId, surface, slot, appId, rotation }
  //   { type: 'remove', itemId, surface, slot, appId, rotation, trinkets }
  //   { type: 'move',   itemId, appId,
  //                     from: { surface, slot, rotation },
  //                     to:   { surface, slot, rotation },
  //                     trinkets }
  //   { type: 'rotate', itemId, surface, slot, from, to }
  //
  // `trinkets` is the snapshot from pickedUpTrinkets — tabletop items
  // sitting on a moved/removed host that need to ride along.
  const MAX_UNDO = 50;
  const undoStack = [];
  const redoStack = [];

  // ── Persistent deleted-items history ─────────────────────────────
  // The in-memory undoStack only survives the current session. So if
  // Sami deletes the carpet, reloads, and THEN realizes he wants it
  // back, Cmd+Z can't help him. The deletedHistory below is a separate
  // localStorage-backed log of every 'remove' command pushed in any
  // session. A floating "Restore" button pops the most recent entry
  // back into the scene.
  const _deletedHistory = [];
  const DELETED_HISTORY_KEY = 'misen.dioramaDeleted.v1';
  const DELETED_HISTORY_MAX = 50;
  let restoreBtnEl = null;
  function saveDeletedHistory() {
    try { localStorage.setItem(DELETED_HISTORY_KEY, JSON.stringify(_deletedHistory)); } catch (e) {}
  }
  function loadDeletedHistory() {
    try {
      const raw = localStorage.getItem(DELETED_HISTORY_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        _deletedHistory.length = 0;
        _deletedHistory.push(...arr);
      }
    } catch (e) {}
  }
  function updateRestoreUI() {
    if (!restoreBtnEl) return;
    const n = _deletedHistory.length;
    if (n === 0) {
      restoreBtnEl.classList.remove('show');
    } else {
      restoreBtnEl.classList.add('show');
      const countEl = restoreBtnEl.querySelector('.dior-restore-count');
      if (countEl) countEl.textContent = String(n);
    }
  }
  function restoreLastDeleted() {
    if (state.heldPiece || state.armedItem) return;
    const cmd = _deletedHistory.pop();
    if (!cmd) return;
    // applyCommand handles 'remove' inverse → re-add at original slot
    // with original rotation and any trinkets that were riding the host.
    applyCommand(cmd, 'inverse');
    savePlacements();
    saveDeletedHistory();
    updateRestoreUI();
  }

  function pushCommand(cmd) {
    undoStack.push(cmd);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    // Persist deletions separately so they survive reloads. Cap at
    // DELETED_HISTORY_MAX to avoid unbounded growth.
    if (cmd.type === 'remove') {
      _deletedHistory.push(cmd);
      if (_deletedHistory.length > DELETED_HISTORY_MAX) _deletedHistory.shift();
      saveDeletedHistory();
      updateRestoreUI();
    }
  }

  function findPlacementByContent(itemId, surface, slot) {
    return state.placements.find(
      p => p.itemId === itemId && p.surface === surface && p.slot === slot
    );
  }

  // Rotate a placement to an absolute quarter-turn. Quantized rotation
  // means at most 3 calls to rotatePlacement (which always bumps by 90°).
  // Returns true on success, false if a quarter-turn was blocked by
  // collision (rotation undo can fail if something else has been placed
  // in the cells the rotated footprint needs).
  function setRotation(placementId, targetRotation) {
    const TAU = Math.PI * 2;
    const norm = ((targetRotation % TAU) + TAU) % TAU;
    for (let i = 0; i < 4; i++) {
      const p = state.placements.find(x => x.placementId === placementId);
      if (!p) return false;
      if (Math.abs((p.rotation || 0) - norm) < 1e-3) return true;
      if (!rotatePlacement(placementId)) return false;
    }
    return false;
  }

  function applyCommand(cmd, direction) {
    // direction: 'forward' (apply / redo) or 'inverse' (undo)
    switch (cmd.type) {
      case 'place': {
        if (direction === 'forward') {
          placePersisted(cmd.itemId, cmd.surface, cmd.slot, {
            appId: cmd.appId || undefined,
            rotation: cmd.rotation || 0,
          });
        } else {
          const target = findPlacementByContent(cmd.itemId, cmd.surface, cmd.slot);
          if (target) removePlacement(target.placementId);
        }
        break;
      }
      case 'remove': {
        if (direction === 'forward') {
          const target = findPlacementByContent(cmd.itemId, cmd.surface, cmd.slot);
          if (target) removePlacement(target.placementId);
        } else {
          placePersisted(cmd.itemId, cmd.surface, cmd.slot, {
            appId: cmd.appId || undefined,
            rotation: cmd.rotation || 0,
          });
          if (cmd.trinkets && cmd.trinkets.length) {
            const host = findPlacementByContent(cmd.itemId, cmd.surface, cmd.slot);
            if (host) rePlaceTrinkets(cmd.trinkets, host.placementId);
          }
        }
        break;
      }
      case 'move': {
        const from = direction === 'forward' ? cmd.from : cmd.to;
        const to   = direction === 'forward' ? cmd.to   : cmd.from;
        const target = findPlacementByContent(cmd.itemId, from.surface, from.slot);
        if (target) removePlacement(target.placementId);
        placePersisted(cmd.itemId, to.surface, to.slot, {
          appId: cmd.appId || undefined,
          rotation: to.rotation || 0,
        });
        if (cmd.trinkets && cmd.trinkets.length) {
          const host = findPlacementByContent(cmd.itemId, to.surface, to.slot);
          if (host) rePlaceTrinkets(cmd.trinkets, host.placementId);
        }
        break;
      }
      case 'rotate': {
        const target = findPlacementByContent(cmd.itemId, cmd.surface, cmd.slot);
        if (!target) break;
        setRotation(target.placementId, direction === 'forward' ? cmd.to : cmd.from);
        break;
      }
    }
  }

  function undo() {
    if (state.heldPiece || state.armedItem) return;
    const cmd = undoStack.pop();
    if (!cmd) return;
    applyCommand(cmd, 'inverse');
    redoStack.push(cmd);
    savePlacements();
  }

  function redo() {
    if (state.heldPiece || state.armedItem) return;
    const cmd = redoStack.pop();
    if (!cmd) return;
    applyCommand(cmd, 'forward');
    undoStack.push(cmd);
    savePlacements();
  }

  // Seed default decorative pieces (no app binding) on first run. Each
  // entry has a stable `id` — once seeded it's recorded in localStorage
  // (DECORATIONS_SEEDED_KEY) so it never seeds again. That means a
  // user-removed decoration stays removed, and multi-instance
  // decorations (e.g. two windows) each track independently.
  const DECORATIONS = [
    // Shelf moved ABOVE the back-wall window. The window blocks cols
    // 10-20 rows 2-10; the shelf at cols 11-16 rows 11-13 sits in
    // the clear band above. Desk position unchanged.
    { id: 'shelf',     itemId: 'floatingWallShelf', surface: 'wall',  slot: 'back:11,11' },
    { id: 'desk',      itemId: 'deskUnit',  surface: 'floor', slot: '9,0' },
    // Office chair tucked in front of the desk. Desk occupies cols 9-14,
    // rows 0-2; col 11 puts the chair roughly under where the laptop sits
    // (tabletop col 1) and row 3 is the first cell in front of the desk.
    // rotation: Math.PI faces the chair toward the back wall so its back
    // is toward the camera — i.e. seated user would face the desk.
    { id: 'officeChair', itemId: 'glbOfficeChair', surface: 'floor', slot: '11,3', rotation: Math.PI },
    // Area rug centered under the desk area. Slot 10,3 puts the rug's
    // 1×1 anchor at the cell just in front of the desk; the mesh
    // (~3m × 2m) sprawls outward, reaching back under the desk legs
    // and forward into the room.
    // Decoration id `carpet-v2` (was `carpet`) so when Sami accidentally
    // deletes the carpet, bumping the id forces a fresh seed on next
    // load — the old `carpet` id is in the seeded set but `carpet-v2`
    // is fresh. (For non-accidental re-seeds, the new persistent
    // restore-deleted feature is the recommended path.)
    { id: 'carpet-v2', itemId: 'glbCarpet', surface: 'floor', slot: '10,3' },
  ];
  // Bumped on each major decoration redesign so the seeded set restarts
  // and ensureDecorations re-places anything whose footprint or default
  // slot changed. The desk + shelf decorations are re-claimed via itemId
  // match in ensureDecorations so they aren't duplicated.
  // v9: desk un-rotated and moved from left-wall to back-wall center.
  // v10: shelf decoration moved from left wall to the new right-wall
  // panel.
  // v11: walls scaled 3× (fine grid).
  // v12: camera went head-on, side walls dropped from the layout.
  // v13: layout shifted 3 cols left to fit the left-panned camera.
  // Shelf moved from back:11,3 to back:8,3.
  // v14: gallery moved entirely off the back-wall window. Shelf moved
  // to back:11,11 (above window); all app paintings repacked into
  // cols 0-8 and 21-23 (flanking the window).
  // v15: added office chair decoration in front of the desk (floor:11,3).
  const DECORATIONS_SEEDED_KEY = 'misen.dioramaDecsSeeded.v16';
  function loadSeededDecorations() {
    try {
      return new Set(JSON.parse(localStorage.getItem(DECORATIONS_SEEDED_KEY) || '[]'));
    } catch (e) { return new Set(); }
  }
  function saveSeededDecorations(seeded) {
    try { localStorage.setItem(DECORATIONS_SEEDED_KEY, JSON.stringify([...seeded])); }
    catch (e) { /* ignore */ }
  }
  // Build a ShapeGeometry rectangle of size (W × H) with rectangular
  // holes punched out at each `holes` entry. Holes are in wall-local
  // coordinates centered on the wall plane (so x ∈ [-W/2, W/2],
  // y ∈ [-H/2, H/2]). UVs are normalized to [0, 1] across the full
  // rect so the wall texture sampling stays consistent across rebuilds.
  function buildWallGeometry(W, H, holes) {
    const shape = new THREE.Shape();
    shape.moveTo(-W / 2, -H / 2);
    shape.lineTo( W / 2, -H / 2);
    shape.lineTo( W / 2,  H / 2);
    shape.lineTo(-W / 2,  H / 2);
    shape.closePath();
    for (const h of holes) {
      const path = new THREE.Path();
      const x0 = h.x - h.w / 2, x1 = h.x + h.w / 2;
      const y0 = h.y - h.h / 2, y1 = h.y + h.h / 2;
      path.moveTo(x0, y0);
      path.lineTo(x1, y0);
      path.lineTo(x1, y1);
      path.lineTo(x0, y1);
      path.closePath();
      shape.holes.push(path);
    }
    const geom = new THREE.ShapeGeometry(shape);
    // ShapeGeometry sets UVs to vertex positions, which is wrong for a
    // tiling stucco map. Re-derive UVs as normalized (x, y) over the
    // full rect.
    const pos = geom.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2]     = (pos.getX(i) + W / 2) / W;
      uv[i * 2 + 1] = (pos.getY(i) + H / 2) / H;
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geom;
  }

  // Rebuild both wall meshes' geometry based on current state.placements.
  // Items flagged `cutsThroughWall` (today: glbWindow) become rectangular
  // holes at HOLE_SCALE × their slot footprint, in the wall's local
  // coordinate frame.
  function rebuildWallGeometry() {
    if (!_backWallMesh || !SURFACES || !SURFACES.wall) return;
    const HOLE_SCALE = 0.85;
    const wallSurface = SURFACES.wall;
    // No static cuts on the back/left walls — the architectural window
    // moved to the right wall (RIGHT_WINDOW const, baked statically in
    // setupRoom). Only user-placed cutsThroughWall items punch holes in
    // these dynamic walls.
    const backHoles = [];
    const leftHoles = [];
    for (const p of state.placements) {
      if (p.surface !== 'wall') continue;
      const def = ITEMS[p.itemId];
      if (!def || !def.cutsThroughWall) continue;
      const parsed = wallSurface.parseSlot(p.slot);
      if (!parsed) continue;
      const panel = wallSurface.panels[parsed.panelId];
      if (!panel) continue;
      const fp = def.footprint || { w: 3, h: 3 };
      const startC = -(panel.cols * panel.cellW) / 2 + panel.cellW / 2;
      const startR = panel.bottomY + panel.cellH / 2;
      const slotCx = startC + (parsed.c + (fp.w - 1) / 2) * panel.cellW;
      const slotCy = startR + (parsed.r + (fp.h - 1) / 2) * panel.cellH;
      const holeW = fp.w * panel.cellW * HOLE_SCALE;
      const holeH = fp.h * panel.cellH * HOLE_SCALE;
      // Map slot center to wall-local coordinates. For the back wall the
      // panel's c-axis runs along world X, which IS the wall-local X. For
      // the left wall, the wall mesh is rotated +π/2 around Y so its
      // local X axis points along world -Z — slotCx here is computed in
      // world Z (the left panel's c-axis), so we have to negate it to
      // express it in the wall mesh's local X frame.
      const localX = parsed.panelId === 'left' ? -slotCx : slotCx;
      const localY = slotCy - ROOM.height / 2;
      const hole = { x: localX, y: localY, w: holeW, h: holeH };
      if (parsed.panelId === 'back') backHoles.push(hole);
      else if (parsed.panelId === 'left') leftHoles.push(hole);
    }
    const backGeom = buildWallGeometry(ROOM.width, ROOM.height, backHoles);
    const leftGeom = buildWallGeometry(ROOM.depth, ROOM.height, leftHoles);
    if (_backWallMesh.geometry) _backWallMesh.geometry.dispose();
    if (_leftWallMesh && _leftWallMesh.geometry) _leftWallMesh.geometry.dispose();
    _backWallMesh.geometry = backGeom;
    if (_leftWallMesh) _leftWallMesh.geometry = leftGeom;
    markShadowsDirty();  // wall geometry changed → refresh shadows once
  }

  function ensureDecorations() {
    const seeded = loadSeededDecorations();
    // For users upgrading from before this seeded-flag mechanism: if a
    // placement of a decoration's itemId already exists in saved state,
    // claim it as already-seeded so we don't spawn a duplicate. Tracked
    // per-pass so two same-itemId decorations each grab a distinct
    // pre-existing placement.
    //
    // Caveat: a DECORATIONS_SEEDED_KEY version bump is meant to relocate
    // pieces whose intended slot has changed (e.g. v9 moved the desk from
    // left:0,0 to floor:3,0). If we find the existing piece at a DIFFERENT
    // slot than dec.slot, we treat it as "needs relocation" — remove it
    // (snapshotting trinkets if it's a tabletop host) and let the normal
    // placePersisted path below seed it at the new slot. Trinkets are
    // replayed onto the new host once it lands.
    const claimed = new Set();
    const relocatedTrinkets = [];   // { hostDecId, trinkets[] }
    let added = 0;
    let touched = false;
    for (const dec of DECORATIONS) {
      if (seeded.has(dec.id)) continue;
      const existing = state.placements.find(p =>
        p.itemId === dec.itemId && !p.appId && !claimed.has(p.placementId)
      );
      if (existing) {
        const sameSlot = (existing.surface === dec.surface && existing.slot === dec.slot);
        if (sameSlot) {
          claimed.add(existing.placementId);
          seeded.add(dec.id);
          touched = true;
          continue;
        }
        // Relocation needed. If the piece hosts trinkets, snapshot them so
        // they can be re-placed on the newly-seeded host below; otherwise
        // they'd be silently discarded by the host removal.
        const carriedTrinkets = [];
        if (SURFACES.tabletop && SURFACES.tabletop.hosts.has(existing.placementId)) {
          for (const tp of state.placements) {
            if (tp.surface !== 'tabletop') continue;
            const parsed = SURFACES.tabletop.parseSlot(tp.slot);
            if (!parsed || parsed.hostKey !== existing.placementId) continue;
            carriedTrinkets.push({
              itemId: tp.itemId,
              tierId: parsed.tierId,
              c: parsed.c,
              r: parsed.r,
              appId: tp.appId || null,
              rotation: tp.rotation || 0,
            });
          }
        }
        removePlacement(existing.placementId);
        if (carriedTrinkets.length) relocatedTrinkets.push({ hostDecId: dec.id, trinkets: carriedTrinkets });
        // Fall through to the placePersisted path below.
      }
      const decOpts = dec.rotation ? { rotation: dec.rotation } : {};
      let placementId = placePersisted(dec.itemId, dec.surface, dec.slot, decOpts);
      if (!placementId) {
        // Preferred slot blocked (e.g. another item already there, or
        // multi-cell footprint conflict). Fall back to first valid slot
        // on the same surface so the decoration always lands somewhere.
        const def = ITEMS[dec.itemId];
        const surface = SURFACES[dec.surface];
        if (def && surface) {
          const firstValid = surface.getSlotsForItem(def).find(s => s.valid);
          if (firstValid) {
            placementId = placePersisted(dec.itemId, dec.surface, firstValid.slotKey, decOpts);
            if (placementId) {
              console.warn('[diorama] decoration', dec.id, 'fell back from', dec.slot, '→', firstValid.slotKey);
            }
          }
        }
        if (!placementId) {
          console.warn('[diorama] decoration', dec.id, 'could not be placed (no valid slot)');
        }
      }
      if (placementId) {
        claimed.add(placementId);
        seeded.add(dec.id);
        added++;
        touched = true;
        // Replay any trinkets we snapshotted off the previous (relocated)
        // host onto the new host placementId. Done here, per-decoration,
        // so trinkets land before the next decoration's seed runs.
        const carried = relocatedTrinkets.find(r => r.hostDecId === dec.id);
        if (carried) rePlaceTrinkets(carried.trinkets, placementId);
      }
    }
    if (touched) saveSeededDecorations(seeded);
    // Replay any tabletop trinkets that were deferred during loadPlacements
    // because their static:desk host no longer exists. The new dynamic
    // desk's placementId encodes its current slot, so use whichever
    // deskUnit placement is in state.placements.
    const deferred = state._deferredStaticDeskTrinkets;
    if (deferred && deferred.length) {
      const deskPlacement = state.placements.find(p => p.itemId === 'deskUnit' && !p.appId);
      if (deskPlacement) {
        const newHostKey = deskPlacement.placementId; // e.g. floor:4,0:deskUnit
        for (const p of deferred) {
          const newSlot = p.slot.replace('static:desk', newHostKey);
          placePersisted(p.itemId, 'tabletop', newSlot, {
            appId: p.appId || undefined,
            rotation: p.rotation || 0,
          });
          added++;
        }
      }
      state._deferredStaticDeskTrinkets = null;
    }
    if (added > 0) savePlacements();
  }

  // First-fit auto placer for app items
  function placeAppItemAuto(project) {
    const itemId = APP_TO_ITEM[project.id];
    if (!itemId) return false;
    const def = ITEMS[itemId];
    if (!def) return false;

    // Try preferred slot first
    const preferred = PREFERRED_SLOTS[project.id];
    if (preferred && SURFACES[preferred.surface]) {
      const got = placePersisted(itemId, preferred.surface, preferred.slot, { appId: project.id });
      if (got) return true;
      console.warn('[diorama] preferred slot full for', project.id, '— falling back', preferred);
    }
    // Fall back to first valid slot on item's bound surface
    const surface = SURFACES[def.surface];
    if (!surface) return false;
    const slots = surface.getSlotsForItem(def);
    const firstValid = slots.find(s => s.valid);
    if (firstValid) {
      placePersisted(itemId, def.surface, firstValid.slotKey, { appId: project.id });
      console.warn('[diorama] auto-placed', project.id, 'at fallback', def.surface, firstValid.slotKey);
      return true;
    }
    console.warn('[diorama] NO valid slot for', project.id, '— item not shown');
    return false;
  }

  function autoPlaceAllApps() {
    // Place wall items first (smaller pool, more constraints), then floor,
    // then tabletop (which depend on floor hosts being placed already).
    const order = { wall: 0, floor: 1, tabletop: 2 };
    const rank = (id) => {
      const itemId = APP_TO_ITEM[id]; if (!itemId) return 9;
      const def = ITEMS[itemId]; if (!def) return 9;
      return order[def.surface] ?? 9;
    };
    const ordered = projects.slice().sort((a, b) => rank(a.id) - rank(b.id));
    for (const proj of ordered) placeAppItemAuto(proj);
  }

  function clearAllPlacements() {
    // Remove tabletop placements first so their meshes detach cleanly while
    // their hosts still exist; then remove the hosts (and unregister them).
    for (const p of [...state.placements]) {
      if (p.surface === 'tabletop') SURFACES.tabletop.remove(p.placementId);
    }
    for (const p of [...state.placements]) {
      if (p.surface === 'tabletop') continue;
      if (SURFACES.tabletop && SURFACES.tabletop.hosts.has(p.placementId)) {
        SURFACES.tabletop.unregisterHost(p.placementId);
      }
      SURFACES[p.surface].remove(p.placementId);
    }
    state.placements = [];
  }

  function rebuildAppPlacements() {
    clearAllPlacements();
    autoPlaceAllApps();
    savePlacements();
  }

  // ══════════════════════════════════════════════════════════════════
  // §11 · Slot markers (only shown in edit mode while an item is armed)
  // ══════════════════════════════════════════════════════════════════
  function clearMarkers() {
    // Walk slotMarkers (not markerGroup.children) because tabletop markers
    // get parented to their host mesh — they live outside markerGroup.
    for (const m of state.slotMarkers) {
      if (m.parent) m.parent.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material && m.material.dispose) m.material.dispose();
    }
    state.slotMarkers = [];
    state.hoverMarker = null;
    // activeMarkers holds references into slotMarkers; the meshes are
    // now disposed, so just clear the array.
    state.activeMarkers.length = 0;
  }
  function makeSlotMarker(item, slot) {
    // Sims / Animal Crossing-style placement feedback: markers start
    // INVISIBLE (opacity 0) so the room doesn't fill with a sea of
    // tinted tiles when something is armed. The pointermove handler
    // reveals exactly one marker — the cell(s) under the cursor — at
    // full tint, sized to the item's footprint, coloured green if the
    // drop is valid or red if it isn't. The grid lines burned into the
    // floor (added in setupRoom) carry the rest of the visual cue.
    //
    // Markers stay as raycast hit targets (raycasting ignores opacity),
    // so the existing snap-to-marker code paths don't need to change.
    const validColor = PALETTE.highlight;
    const invalidColor = PALETTE.invalid;
    const color = slot.valid ? validColor : invalidColor;
    let marker;
    if (item.surface === 'wall') {
      const fp = item.footprint || { w: 3, h: 3 };
      const cellW = slot.cellW || (0.7 / 3);
      const cellH = slot.cellH || (0.55 / 3);
      // 0.98 (was 0.85): tile nearly edge-to-edge so the cursor
      // reliably lands on a marker rather than falling into a gap.
      // Walls have no free-fly fallback, so misses there cost more
      // than they do on the floor — the held mesh just stops at the
      // last snap. The 2% inset still lets the wall texture peek
      // between adjacent markers when multiple are highlighted.
      const w = fp.w * cellW * 0.98;
      const h = fp.h * cellH * 0.98;
      marker = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      marker.position.copy(slot.worldPos);
      // Match the panel's rotation, then offset slightly along its normal
      // so the marker doesn't z-fight the wall.
      const r = slot.rotation || 0;
      marker.rotation.y = r;
      marker.position.x += Math.sin(r) * 0.005;
      marker.position.z += Math.cos(r) * 0.005;
    } else if (item.surface === 'tabletop') {
      // Flat marker in the host's LOCAL frame — actual parenting onto
      // the host happens in showSlotsForItem, which is what makes the
      // marker rotate / translate with the host automatically.
      const fp = item.footprint || { w: 1, d: 1 };
      const cellW = slot.cellW || 0.18;
      const cellD = slot.cellD || 0.18;
      // 0.95 (was 0.82): nearly edge-to-edge for reliable cursor hits.
      // Tabletop tiers are small in world space (a few cm per cell);
      // the wider gap at 0.82 made misses common.
      const w = fp.w * cellW * 0.95;
      const d = fp.d * cellD * 0.95;
      marker = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.copy(slot.localPos);
      marker.position.y += 0.003;
    } else {
      // Floor markers — default footprint is 1×1 (single cell).
      const fp = item.footprint || { w: 1, d: 1 };
      const fs = SURFACES.floor;
      // 0.98 (was 0.92): markers tile nearly edge-to-edge so the cursor
      // almost always lands on a marker and the user gets continuous
      // green/red footprint feedback instead of falling into free-fly
      // gaps. The 2% inset still lets the persistent floor grid lines
      // peek between tiles.
      const w = fp.w * fs.cellW * 0.98;
      const d = fp.d * fs.cellD * 0.98;
      marker = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.copy(slot.worldPos);
      marker.position.y = 0.01;
    }
    marker.userData = { isMarker: true, slotKey: slot.slotKey, valid: slot.valid, surface: item.surface };
    return marker;
  }
  function showSlotsForItem(item) {
    clearMarkers();
    const surface = SURFACES[item.surface]; if (!surface) return;
    for (const slot of surface.getSlotsForItem(item)) {
      const m = makeSlotMarker(item, slot);
      // Tabletop markers parent onto the host so they inherit any
      // rotation/translation the host has picked up. Floor + wall
      // markers stay in markerGroup (they're already in world coords).
      if (item.surface === 'tabletop' && slot.hostMesh) {
        slot.hostMesh.add(m);
      } else {
        markerGroup.add(m);
      }
      state.slotMarkers.push(m);
    }
  }
  function disarm() {
    state.armedItem = null;
    state.armedAppId = null;
    clearMarkers();
  }

  // appsUsingItem / findUnplacedAppForItem / isItemPlaceable removed
  // alongside the "+ Add" catalog UI — they only existed to drive the
  // catalog's enabled/disabled item buttons and the catalog-spawn
  // app-claim flow.

  // ══════════════════════════════════════════════════════════════════
  // §12 · UI overlays — app hover tooltip + click-modal + move hint
  // ══════════════════════════════════════════════════════════════════
  function setupUI() {
    // app hover tooltip
    appHoverEl = document.createElement('div');
    appHoverEl.className = 'dior-hover';
    container.appendChild(appHoverEl);

    // Mirror cursor-reflection overlay (clip box + flipped pointer glyph).
    // Lives inside the frame so it's clipped to the scene; positioned/sized
    // by updateMirrorReflection to match the mirror glass on screen.
    mirrorClipEl = document.createElement('div');
    mirrorClipEl.className = 'dior-mirror-clip';
    mirrorCursorEl = document.createElement('div');
    mirrorCursorEl.className = 'dior-mirror-cursor';
    // Open-hand ("grab") glyph — matches the cursor the canvas shows when
    // hovering a launcher object. Stroke-drawn (Lucide "hand").
    mirrorCursorEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" ' +
      'stroke="rgba(248,248,252,0.95)" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/>' +
      '<path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/>' +
      '<path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/>' +
      '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34' +
      'l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>';
    mirrorClipEl.appendChild(mirrorCursorEl);
    container.appendChild(mirrorClipEl);

    // The list + connector live on the diorama frame's PARENT (.mainBody),
    // not inside the frame itself, so the list sits in its own column to
    // the left and the connector line can cross the frame's clipped edge.
    // overlayRoot is the coordinate origin for all overlay math below.
    overlayRoot = container.parentElement || container;

    // Side app list — populated by rebuildAppList() once placements exist.
    // Pointer events: hovering a row links it to its object (and draws the
    // connector); leaving the panel clears the link; clicking launches.
    // Inserted BEFORE the frame so it lands as the left flex column.
    appListEl = document.createElement('div');
    appListEl.className = 'dior-applist';
    overlayRoot.insertBefore(appListEl, container);
    appListEl.addEventListener('pointerover', (e) => {
      const item = e.target.closest('.dior-applist-item');
      if (item) setLinkedApp(item.dataset.appId);
    });
    appListEl.addEventListener('pointerleave', () => setLinkedApp(null));
    appListEl.addEventListener('click', (e) => {
      const item = e.target.closest('.dior-applist-item');
      if (!item || !item.dataset.appId) return;
      const appId = item.dataset.appId;
      if (onLaunchStartCb) onLaunchStartCb(appId);
      if (onOpenProjectCb) onOpenProjectCb(appId);
    });
    // Keep a drag started on the panel from reaching the canvas (which
    // would otherwise begin a parallax/placement interaction).
    appListEl.addEventListener('pointerdown', (e) => e.stopPropagation());

    // Connector overlay — one SVG spanning .mainBody, holding the line +
    // an end dot. Coordinates are in overlayRoot pixels (no viewBox),
    // updated every frame by updateConnector() while a link is active.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    connectorSvgEl = document.createElementNS(SVG_NS, 'svg');
    connectorSvgEl.setAttribute('class', 'dior-connector');
    // Elbow leader line: a polyline with a short flat horizontal stub
    // leaving the name, then an angled run to the object.
    connectorLineEl = document.createElementNS(SVG_NS, 'polyline');
    connectorLineEl.setAttribute('class', 'dior-connector-line');
    connectorDotEl = document.createElementNS(SVG_NS, 'circle');
    connectorDotEl.setAttribute('class', 'dior-connector-dot');
    connectorDotEl.setAttribute('r', '4');
    connectorSvgEl.appendChild(connectorLineEl);
    connectorSvgEl.appendChild(connectorDotEl);
    overlayRoot.appendChild(connectorSvgEl);

    // UI overlay styles live in diorama.css (linked from index.html).

    // single-piece move hint (shown only while one piece is being moved)
    const moveHintEl = document.createElement('div');
    moveHintEl.className = 'dior-move-hint';
    moveHintEl.innerHTML = `<b>Moving piece.</b> Click a glowing slot to place · <kbd>Esc</kbd> to cancel`;
    container.appendChild(moveHintEl);

    // Held-piece toolbar (sticky-grab). Shown only while a piece follows
    // the cursor. Pointerdown handlers stop propagation so clicks on the
    // bar itself don't fall through to the canvas (which would commit a
    // drop). The Rotate button is hidden for wall pieces — see showHeldUI.
    heldBarEl = document.createElement('div');
    heldBarEl.className = 'dior-held-bar';
    heldBarEl.innerHTML = `
      <button class="dior-held-btn dior-held-rotate" type="button" title="Rotate (R)">
        <span class="glyph">↻</span><span>Rotate</span>
      </button>
      <button class="dior-held-btn dior-held-remove" type="button" title="Remove">
        <span class="glyph">🗑</span><span>Remove</span>
      </button>
      <button class="dior-held-btn dior-held-cancel" type="button" title="Cancel (Esc)">
        <span class="glyph">×</span><span>Cancel</span>
      </button>
    `;
    container.appendChild(heldBarEl);
    // Stop pointerdown on the bar from reaching the canvas (which would
    // commit a drop). Pointerup is left to bubble — the window-level
    // onPointerUp is a no-op when held, so propagation doesn't matter.
    heldBarEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    heldBarEl.querySelector('.dior-held-rotate').addEventListener('click', (e) => {
      e.stopPropagation();
      rotateHeld();
    });
    heldBarEl.querySelector('.dior-held-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeHeld();
    });
    heldBarEl.querySelector('.dior-held-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      cancelHeld();
    });

    // ── Restore-deleted floating button ──────────────────────────────
    // Shown only when _deletedHistory is non-empty. Clicking pops the
    // most recent removal and places it back at its original slot.
    restoreBtnEl = document.createElement('button');
    restoreBtnEl.className = 'dior-restore';
    restoreBtnEl.type = 'button';
    restoreBtnEl.title = 'Restore last deleted item';
    restoreBtnEl.innerHTML = `<span class="glyph">↺</span><span>Restore</span><span class="dior-restore-count">0</span>`;
    restoreBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreLastDeleted();
    });
    restoreBtnEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    container.appendChild(restoreBtnEl);

    // Per-held-piece hint reuses the move-hint pill so we don't duplicate
    // styles. We swap its innerHTML in showHeldUI.
    heldHintEl = moveHintEl;

    // Catalog UI removed — the room is a curated app-launcher gallery
    // and the apps auto-place themselves at their APPS slots, so
    // manual "+ Add" placement is redundant. Drag-pickup + modal Move
    // still let the user reposition existing pieces.

    // launch / move / rotate modal
    modalEl = document.createElement('div');
    modalEl.className = 'dior-modal-bg';
    modalEl.innerHTML = `
      <div class="dior-modal" role="dialog" aria-modal="true">
        <button class="dior-modal-close" type="button" aria-label="Close">×</button>
        <h2 class="dior-modal-title">App</h2>
        <p class="dior-modal-sub"></p>
        <div class="dior-modal-summary" hidden></div>
        <div class="dior-modal-row">
          <button class="dior-btn dior-modal-rotate" type="button">Rotate</button>
          <button class="dior-btn dior-modal-resize" type="button">Resize</button>
          <button class="dior-btn dior-modal-move" type="button">Move</button>
          <button class="dior-btn dior-modal-launch primary" type="button">Launch →</button>
        </div>
      </div>
    `;
    container.appendChild(modalEl);
    modalEl._moveHintEl = moveHintEl;

    modalEl.querySelector('.dior-modal-close').addEventListener('click', closeModal);
    modalEl.querySelector('.dior-modal-launch').addEventListener('click', () => {
      const appId = modalEl._currentAppId;
      closeModal();
      if (!appId) return;
      if (onLaunchStartCb) onLaunchStartCb(appId);
      if (onOpenProjectCb) onOpenProjectCb(appId);
    });
    modalEl.querySelector('.dior-modal-move').addEventListener('click', () => {
      const placement = modalEl._currentPlacement;
      closeModal();
      if (placement) pickUpHeld(placement);
    });
    // Resize — explicit entry into the drag-corner mode. Closes the modal
    // and pins the resize handle to the picked wall placement so the user
    // can drag it without having to chase a hover target. The pinned
    // state is cleared on drag-end (savePlacements path) or Escape.
    modalEl.querySelector('.dior-modal-resize').addEventListener('click', () => {
      const placement = modalEl._currentPlacement;
      closeModal();
      if (placement && placement.surface === 'wall') enterResizeMode(placement);
    });
    // Rotate stays open so multiple clicks can chain to 180/270/360.
    // After each click we re-anchor the bubble in case the piece's
    // bounding box shifted (rotated piano now has a different top).
    modalEl.querySelector('.dior-modal-rotate').addEventListener('click', () => {
      const placement = modalEl._currentPlacement;
      if (!placement) return;
      // Snapshot identity + rotation BEFORE the bump — rotatePlacement
      // mutates state.placements in place, so reading the rotation
      // after is the new value, not the old.
      const before = state.placements.find(p => p.placementId === placement.placementId);
      if (!before) return;
      const fromRot = before.rotation || 0;
      const itemId = before.itemId;
      const surface = before.surface;
      const slot = before.slot;
      const ok = rotatePlacement(placement.placementId);
      if (ok) {
        const after = state.placements.find(p => p.placementId === placement.placementId);
        if (after) {
          pushCommand({
            type: 'rotate',
            itemId, surface, slot,
            from: fromRot,
            to: after.rotation || 0,
          });
        }
        positionModalForPlacement(placement);
      }
    });
    // Click on the backdrop (but not the inner modal card) closes
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) closeModal();
    });

    // Window popup — opened by clicking the right-wall window. Offers
    // "Blinds" (raise/lower the shades) and "Change scene" (cycle the
    // view outside). Reuses the speech-bubble chrome via .dior-winmenu.
    winMenuEl = document.createElement('div');
    winMenuEl.className = 'dior-modal-bg dior-winmenu';
    winMenuEl.innerHTML = `
      <div class="dior-modal" role="dialog" aria-modal="true">
        <button class="dior-modal-close" type="button" aria-label="Close">×</button>
        <h2 class="dior-modal-title">Window</h2>
        <p class="dior-modal-sub"></p>
        <div class="dior-winmenu-row">
          <button class="dior-btn dior-winmenu-blinds" type="button">Blinds</button>
          <button class="dior-btn dior-winmenu-scene" type="button">Change scene</button>
        </div>
      </div>
    `;
    container.appendChild(winMenuEl);
    winMenuEl.querySelector('.dior-modal-close').addEventListener('click', closeWindowMenu);
    winMenuEl.querySelector('.dior-winmenu-blinds').addEventListener('click', () => {
      toggleBlinds();
      closeWindowMenu();
    });
    winMenuEl.querySelector('.dior-winmenu-scene').addEventListener('click', () => {
      // Cycle the outdoor view; keep the popup open and reflect the new
      // scene name in the sub-line so repeated taps chain through scenes.
      if (_lights.sky && _lights.sky.nextScene) {
        const name = _lights.sky.nextScene();
        const subEl = winMenuEl.querySelector('.dior-modal-sub');
        if (subEl) subEl.textContent = name;
      }
    });
    winMenuEl.addEventListener('click', (e) => {
      if (e.target === winMenuEl) closeWindowMenu();
    });

    // Wall popup — opened by clicking any wall. A row of preset swatches
    // plus a native color input to pick any custom color; both repaint
    // all three walls live and persist the choice. Reuses the
    // speech-bubble chrome via .dior-wallmenu.
    wallMenuEl = document.createElement('div');
    wallMenuEl.className = 'dior-modal-bg dior-wallmenu';
    const _swatchHtml = WALL_COLOR_PRESETS.map((p) =>
      `<button class="dior-wall-swatch" type="button" data-hex="${p.hex}" ` +
      `title="${escapeHtml(p.name)}" aria-label="${escapeHtml(p.name)}" ` +
      `style="background:${p.hex}"></button>`
    ).join('');
    wallMenuEl.innerHTML = `
      <div class="dior-modal" role="dialog" aria-modal="true">
        <button class="dior-modal-close" type="button" aria-label="Close">×</button>
        <h2 class="dior-modal-title">Wall color</h2>
        <p class="dior-modal-sub">Pick a paint</p>
        <div class="dior-wall-swatches">${_swatchHtml}</div>
        <div class="dior-wall-custom">
          <label class="dior-wall-custom-label">
            <input class="dior-wall-color-input" type="color" value="${DEFAULT_WALL_COLOR}">
            <span>Custom…</span>
          </label>
          <button class="dior-btn dior-wall-reset" type="button">Reset</button>
        </div>
      </div>
    `;
    container.appendChild(wallMenuEl);
    const _colorInput = wallMenuEl.querySelector('.dior-wall-color-input');
    // Live-paint helper: applies + persists + reflects the active swatch.
    const _setWall = (hex) => {
      applyWallColor(hex);
      saveWallColor(hex);
      if (_colorInput) _colorInput.value = hex;
      wallMenuEl.querySelectorAll('.dior-wall-swatch').forEach((b) => {
        b.classList.toggle('active', b.dataset.hex.toLowerCase() === hex.toLowerCase());
      });
    };
    wallMenuEl.querySelector('.dior-modal-close').addEventListener('click', closeWallMenu);
    wallMenuEl.querySelectorAll('.dior-wall-swatch').forEach((b) => {
      b.addEventListener('click', () => _setWall(b.dataset.hex));
    });
    if (_colorInput) _colorInput.addEventListener('input', () => _setWall(_colorInput.value));
    wallMenuEl.querySelector('.dior-wall-reset').addEventListener('click', () => _setWall(DEFAULT_WALL_COLOR));
    wallMenuEl.addEventListener('click', (e) => {
      if (e.target === wallMenuEl) closeWallMenu();
    });
    wallMenuEl._setWall = _setWall;

    // pointer events on canvas
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', () => {
      _parallaxTargetX = 0;
      _parallaxTargetY = 0;
      hideMirrorReflection();
    });
    canvas.addEventListener('pointerdown', onPointerDown);
    // pointerup is on window so a release outside the canvas (e.g. user
    // mousedowns on a piece, drags off the canvas, then releases) still
    // clears the drag candidate. The handler is a no-op while held.
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('contextmenu', onContextMenu);

    // Camera debug — scroll-to-zoom. Active only when debug mode is on;
    // otherwise the wheel is ignored (no page-scroll inside the canvas
    // either way, but passive:false lets us preventDefault to be safe).
    canvas.addEventListener('wheel', (e) => {
      if (!cameraDebug.enabled) return;
      e.preventDefault();
      cameraDebugZoom(e.deltaY);
    }, { passive: false });
    document.addEventListener('keydown', (e) => {
      // While the diorama is hidden behind a launched app's WebContentsView,
      // ignore global keys — otherwise ⌘Z / C / L / Escape meant for the
      // embedded app would drive the (invisible) room (undo, debug HUDs…).
      if (!container || container.hasAttribute('hidden')) return;
      // Camera debug mode owns most input while active. Toggle and
      // navigation keys are handled here; everything else is suppressed
      // so placement shortcuts don't fire mid-orbit.
      if (cameraDebug.enabled) {
        if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') {
          exitCameraDebug(); e.preventDefault(); return;
        }
        // Arrow keys / PageUp/Down pan the target (xz plane + y axis).
        const PAN = 0.1;
        if (e.key === 'ArrowLeft')  { cameraDebugPanTarget(-PAN, 0, 0); e.preventDefault(); return; }
        if (e.key === 'ArrowRight') { cameraDebugPanTarget(+PAN, 0, 0); e.preventDefault(); return; }
        if (e.key === 'ArrowUp')    { cameraDebugPanTarget(0, 0, -PAN); e.preventDefault(); return; }
        if (e.key === 'ArrowDown')  { cameraDebugPanTarget(0, 0, +PAN); e.preventDefault(); return; }
        if (e.key === 'PageUp')     { cameraDebugPanTarget(0, +PAN, 0); e.preventDefault(); return; }
        if (e.key === 'PageDown')   { cameraDebugPanTarget(0, -PAN, 0); e.preventDefault(); return; }
        if (e.key === '[') { cameraDebugAdjustFov(-1); e.preventDefault(); return; }
        if (e.key === ']') { cameraDebugAdjustFov(+1); e.preventDefault(); return; }
        return; // suppress any other shortcut while debugging
      }
      if (e.key === 'Escape') {
        if (wallMenuOpen) closeWallMenu();
        else if (winMenuOpen) closeWindowMenu();
        else if (modalOpen) closeModal();
        else if (state.heldPiece) cancelHeld();
        else if (state.armedItem) cancelArmedOrMove();
        else if (RESIZE.pinnedPid != null) exitResizeMode();
      } else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) {
        // Toggle camera debug mode. Don't toggle mid-gesture — finish
        // whatever's in flight first so the HUD doesn't appear over a
        // half-placed piece.
        if (modalOpen || state.heldPiece || state.armedItem) return;
        toggleCameraDebug();
        e.preventDefault();
      } else if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey) {
        // Toggle the lighting/material debugger. Same mid-gesture guard.
        if (modalOpen || state.heldPiece || state.armedItem) return;
        toggleLightingDebug();
        e.preventDefault();
      } else if ((e.key === 'r' || e.key === 'R') && state.heldPiece) {
        // R-key shortcut for rotate while held — keyboard equivalent of
        // the floating Rotate button. Doesn't fight any text inputs since
        // the diorama has none.
        rotateHeld();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        // ⌘Z (Cmd on macOS, Ctrl on Win/Linux) → undo. No-op while a
        // piece is armed/held — undo() guards that explicitly so the
        // stack stays consistent with the visible scene.
        e.preventDefault();
        undo();
      } else if ((e.metaKey || e.ctrlKey) && (
                 (e.shiftKey && (e.key === 'z' || e.key === 'Z'))
                 || e.key === 'y' || e.key === 'Y')) {
        // ⌘⇧Z (Mac) and ⌘Y (Win/Linux convention, also accepted on Mac).
        e.preventDefault();
        redo();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // §13 · Modal + single-piece move
  // ══════════════════════════════════════════════════════════════════
  // Per-app summary fetchers. Each returns a Promise resolving to either
  // null (no data / failure — summary stays hidden) or an object:
  //   { label, count, items: string[], more? }
  // Add an entry here to give an app a quick-summary block in its launch
  // bubble. Fetchers should be cheap (single fetch, ~1.5 s timeout) and
  // tolerate the server being down — the modal must always still open.
  const APP_SUMMARIES = {
    'whiteboard-tasks': async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch('http://127.0.0.1:8748/api/tasks', { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        const data = await res.json();
        const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        const items = tasks.slice(0, 3).map((s) => String(s));
        return {
          label: 'Open tasks',
          count: tasks.length,
          items,
          more: tasks.length > items.length ? tasks.length - items.length : 0,
        };
      } catch {
        return null;
      }
    },
    'day-planner': async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        // /api/calendar/events (primary calendar) accepts ISO from/to. The
        // /api/gcal/events endpoint pulls across ALL calendars but only
        // accepts a single date param — the 48 h horizon below is more
        // useful for "what's next", so we trade one-calendar scope for a
        // forward-looking window.
        const now = new Date();
        const horizon = new Date(now.getTime() + 48 * 60 * 60 * 1000);
        const url = `http://127.0.0.1:8764/api/calendar/events?from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(horizon.toISOString())}`;
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        const data = await res.json();
        const events = Array.isArray(data?.events) ? data.events : [];
        // Drop anything that has already ended; sort soonest-first by start.
        const nowMs = Date.now();
        const future = events
          .map((e) => ({ ...e, _startMs: Date.parse(e.start) }))
          .filter((e) => Number.isFinite(e._startMs) && Date.parse(e.end || e.start) >= nowMs - 5 * 60 * 1000)
          .sort((a, b) => a._startMs - b._startMs);
        const items = future.slice(0, 3).map((e) => {
          const when = formatEventWhen(e._startMs, e.allDay);
          const title = String(e.title || '(untitled)');
          return `${when} · ${title}`;
        });
        return {
          label: 'Next up',
          count: future.length,
          items,
          more: future.length > items.length ? future.length - items.length : 0,
        };
      } catch {
        return null;
      }
    },
  };

  // Kitchen — last 3 recipes (most-recently created first). Stored shape:
  // { recipes: [{ title, dish, createdAt, ... }] }. The list isn't
  // guaranteed sorted; sort by createdAt descending, falling back to the
  // original order for entries without a timestamp.
  APP_SUMMARIES['kitchen'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8745/api/recipes', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const recipes = Array.isArray(data?.recipes) ? data.recipes : [];
      const sorted = recipes.slice().sort((a, b) => {
        const ta = Date.parse(a?.createdAt || '') || 0;
        const tb = Date.parse(b?.createdAt || '') || 0;
        return tb - ta;
      });
      const items = sorted.slice(0, 3).map((r) => String(r?.title || r?.dish || '(untitled)'));
      return {
        label: 'Recent recipes',
        count: recipes.length,
        items,
        more: recipes.length > items.length ? recipes.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Daily Journal — storage is a single dict keyed by ISO date (YYYY-MM-DD)
  // → markdown string. Summary surfaces (a) whether today already has an
  // entry, and (b) the 2 most recent prior dates with a short snippet.
  APP_SUMMARIES['daily-journal'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8749/api/entries', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const entries = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
      const todayIso = (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();
      // Sort dates newest-first; only keep keys with non-empty text.
      const dates = Object.keys(entries)
        .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && String(entries[k] || '').trim().length > 0)
        .sort((a, b) => (a < b ? 1 : -1));
      const wroteToday = dates[0] === todayIso;
      const items = [];
      items.push(wroteToday ? `✓ today — written` : `· today — not yet`);
      // Show up to 2 prior dates, with a ~28-char snippet of the markdown
      // (strip leading headings / quote markers so the snippet reads cleanly).
      const priors = wroteToday ? dates.slice(1, 3) : dates.slice(0, 2);
      const snippet = (md) => {
        const s = String(md || '')
          .replace(/^#+\s*/gm, '')
          .replace(/[*_>`]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return s.length > 32 ? s.slice(0, 32) + '…' : s;
      };
      const niceDate = (iso) => {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      };
      priors.forEach((iso) => {
        items.push(`${niceDate(iso)} · ${snippet(entries[iso])}`);
      });
      return {
        label: 'Journal',
        count: dates.length,
        items,
        // "+N more" doesn't really fit here — items isn't a top-3 of dates,
        // it's a status line + 2 priors. Suppress the "more" tail.
        more: 0,
      };
    } catch {
      return null;
    }
  };

  // Email Whiteboard — top 3 unread senders. The API bridge already
  // exposes /api/inbox?q=is:unread; Misen's home rail polls it for badges,
  // so we know the endpoint is stable. Strip "Name <addr>" → "Name", and
  // fall back to the bare address if no display name was set.
  const emailSummary = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8744/api/inbox?q=is:unread&max=10', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const msgs = Array.isArray(data?.messages) ? data.messages : [];
      const senderOf = (from) => {
        const s = String(from || '').trim();
        const m = /^"?([^"<]+?)"?\s*<[^>]+>$/.exec(s);
        if (m) return m[1].trim();
        return s || '(unknown)';
      };
      const items = msgs.slice(0, 3).map((m) => {
        const sender = senderOf(m.from);
        const subject = String(m.subject || '(no subject)');
        return `${sender} — ${subject}`;
      });
      return {
        label: 'Unread',
        count: msgs.length,
        items,
        more: msgs.length > items.length ? msgs.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };
  // Both v1 and v2 share the same API bridge on 8744, so wire both ids.
  APP_SUMMARIES['email-whiteboard-app'] = emailSummary;
  APP_SUMMARIES['email-whiteboard-v2']  = emailSummary;

  // Media Tracker — currently-consuming items (status="in_progress"), most
  // recently updated first. The /api/entries endpoint returns a bare array
  // (not wrapped in { entries: … } like the others). Type tag lets a glance
  // distinguish a book in progress from a show or game.
  APP_SUMMARIES['media-tracker'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8747/api/entries?status=in_progress', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      const typeAbbr = { book: 'bk', tv: 'tv', movie: 'mv', game: 'gm', podcast: 'pod', music: 'mus' };
      const items = rows.slice(0, 3).map((r) => {
        const tag = typeAbbr[String(r?.type || '').toLowerCase()] || String(r?.type || '').slice(0, 3);
        const title = String(r?.title || '(untitled)');
        return `${tag} · ${title}`;
      });
      return {
        label: 'In progress',
        count: rows.length,
        items,
        more: rows.length > items.length ? rows.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Library — 3 most recently saved bookmarks. /api/bookmarks already
  // supports sort=newest + limit, and returns a total alongside the rows
  // so the count chip reflects the entire library, not just the page.
  APP_SUMMARIES['library'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8752/api/bookmarks?sort=newest&limit=3', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data?.bookmarks) ? data.bookmarks : [];
      const total = Number(data?.total) || rows.length;
      const items = rows.slice(0, 3).map((b) => String(b?.title || b?.url || '(untitled)'));
      return {
        label: 'Recent',
        count: total,
        items,
        more: total > items.length ? total - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Job Search — active applications (anything that's not "rejected"),
  // already sorted updated_at DESC by the server. Format is
  // "company · title" so the company is the at-a-glance anchor.
  APP_SUMMARIES['job-search'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8756/api/applications', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      const active = rows.filter((a) => String(a?.status || '').toLowerCase() !== 'rejected');
      const items = active.slice(0, 3).map((a) => {
        const company = String(a?.company || '').trim();
        const title = String(a?.title || '(untitled role)').trim();
        return company ? `${company} · ${title}` : title;
      });
      return {
        label: 'Active applications',
        count: active.length,
        items,
        more: active.length > items.length ? active.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Residency Tracker — opportunities with the soonest deadlines first,
  // skipping ones already resolved (accepted/rejected/withdrawn). The
  // deadline chip uses ISO yyyy-mm-dd → "Jun 14" so the row reads as
  // "deadline · org name".
  APP_SUMMARIES['residency-tracker'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8757/api/opportunities', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      const RESOLVED = new Set(['accepted', 'rejected', 'withdrawn']);
      const open = rows.filter((o) => !RESOLVED.has(String(o?.status || '').toLowerCase()));
      const fmt = (iso) => {
        if (!iso) return 'no date';
        const d = new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso);
        if (Number.isNaN(d.getTime())) return 'no date';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      };
      const items = open.slice(0, 3).map((o) => {
        const when = fmt(o?.deadline);
        const title = String(o?.title || o?.organization || '(untitled)');
        return `${when} · ${title}`;
      });
      return {
        label: 'Upcoming',
        count: open.length,
        items,
        more: open.length > items.length ? open.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Garden Tracker — open garden tasks (water, fertilize, plant, etc.).
  // /api/data returns { db: { beds, plantings, tasks, wiki } }. Tasks are
  // stored as a flat list; show pending ones (filter out done if a `done`
  // flag exists, otherwise show first 3).
  APP_SUMMARIES['garden-tracker'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8750/api/data', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const tasks = Array.isArray(data?.db?.tasks) ? data.db.tasks : [];
      const open = tasks.filter((t) => !t?.done && !t?.completed);
      const items = open.slice(0, 3).map((t) => String(t?.text || t?.title || t?.name || '(task)'));
      return {
        label: 'Garden tasks',
        count: open.length,
        items,
        more: open.length > items.length ? open.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Digest — message snapshot, count = unique messages pending across all
  // sources (iMessage, Signal, WhatsApp). Each message has sender + text/
  // preview; "sender · snippet" reads well at a glance.
  APP_SUMMARIES['digest'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8753/api/messages', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const msgs = Array.isArray(data?.messages) ? data.messages : [];
      const total = Number(data?.count) || msgs.length;
      const items = msgs.slice(0, 3).map((m) => {
        const sender = String(m?.sender || m?.from || m?.source || '');
        const text = String(m?.text || m?.preview || m?.snippet || '');
        const trimmed = text.length > 36 ? text.slice(0, 36) + '…' : text;
        return sender && trimmed ? `${sender} · ${trimmed}` : (sender || trimmed || '(message)');
      });
      return {
        label: 'Messages',
        count: total,
        items,
        more: total > items.length ? total - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Events Digest — server returns events sorted soonest-first (with-date
  // ahead of no-date). Show 3 upcoming with their date chip.
  APP_SUMMARIES['events-digest'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8754/api/events', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const events = Array.isArray(data) ? data : [];
      // Drop events whose date already passed; keep undated at the end.
      const now = Date.now() - 86_400_000; // include today
      const filtered = events.filter((e) => {
        if (!e?.date) return true;
        const t = Date.parse(e.date);
        return !Number.isFinite(t) || t >= now;
      });
      const fmt = (iso) => {
        if (!iso) return 'no date';
        const d = new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso);
        if (Number.isNaN(d.getTime())) return 'no date';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      };
      const items = filtered.slice(0, 3).map((e) => {
        const when = fmt(e?.date);
        const title = String(e?.title || '(untitled)');
        return `${when} · ${title}`;
      });
      return {
        label: 'Upcoming events',
        count: filtered.length,
        items,
        more: filtered.length > items.length ? filtered.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Atlas — top-level countries (no parent_id), sorted by descendant place
  // count so the "loudest" regions surface first. Shape rows include
  // `place_count` already, so we can lean on it.
  APP_SUMMARIES['atlas'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8758/api/locations', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      const sorted = rows.slice().sort((a, b) => (Number(b?.place_count) || 0) - (Number(a?.place_count) || 0));
      const items = sorted.slice(0, 3).map((r) => {
        const name = String(r?.name || '(unknown)');
        const n = Number(r?.place_count) || 0;
        return n > 0 ? `${name} · ${n} place${n === 1 ? '' : 's'}` : name;
      });
      return {
        label: 'Top regions',
        count: rows.length,
        items,
        more: rows.length > items.length ? rows.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // IG Stories Viewer — capture stats. /api/stats returns totalStories,
  // uniqueUsers, and a dailyCounts series. Surface those as three readable
  // rows (most recent date, totals).
  APP_SUMMARIES['igstories-viewer'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:3000/api/stats', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const total = Number(data?.totalStories) || 0;
      const users = Number(data?.uniqueUsers) || 0;
      const daily = Array.isArray(data?.dailyCounts) ? data.dailyCounts : [];
      const last = daily[0];
      const items = [];
      if (last) items.push(`${last.date} · ${last.count} captured`);
      items.push(`${users} unique account${users === 1 ? '' : 's'}`);
      if (daily.length > 1) items.push(`${daily.length}-day window`);
      return {
        label: 'Stories captured',
        count: total,
        items,
        more: 0,
      };
    } catch {
      return null;
    }
  };

  // Project Sketchbook — projects, sorted is_active DESC then title.
  // The active ones bubble naturally to the top of the response, so the
  // first 3 are usually "what's live right now".
  APP_SUMMARIES['project-sketchbook'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8761/api/projects', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      const active = rows.filter((p) => p?.is_active || p?.isActive);
      const head = active.length > 0 ? active : rows;
      const items = head.slice(0, 3).map((p) => String(p?.title || '(untitled)'));
      return {
        label: active.length > 0 ? 'Active projects' : 'Projects',
        count: rows.length,
        items,
        more: rows.length > items.length ? rows.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Font Manager — favorited families. /api/fonts returns the entire
  // catalog (heavy) so we lean on /api/favorites instead — it's small,
  // fast, and the favorites list is what's worth glancing at.
  APP_SUMMARIES['font-manager'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8762/api/favorites', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const favs = Array.isArray(data) ? data : [];
      const items = favs.slice(0, 3).map((s) => String(s));
      return {
        label: 'Favorites',
        count: favs.length,
        items,
        more: favs.length > items.length ? favs.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Follows Audit — relationship stats. /api/stats returns counts by
  // bucket (following, followers, mutuals, following-only, follower-only,
  // unknown). Render the three most actionable buckets.
  APP_SUMMARIES['follows-audit'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8759/api/stats', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const following = Number(data?.following) || 0;
      const followingOnly = Number(data?.followingOnly) || 0;
      const followerOnly = Number(data?.followerOnly) || 0;
      const mutuals = Number(data?.mutuals) || 0;
      const items = [
        `${mutuals} mutual${mutuals === 1 ? '' : 's'}`,
        `${followingOnly} following-only`,
        `${followerOnly} follower-only`,
      ];
      return {
        label: 'Relationships',
        count: following,
        items,
        more: 0,
      };
    } catch {
      return null;
    }
  };

  // Organize CMS — pages across cities / states / topics. The endpoint
  // already sorts by type then title, so the first 3 reflect the
  // canonical type order. Each page row carries an `initiative count`.
  APP_SUMMARIES['organize-cms'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8763/api/pages', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      const items = rows.slice(0, 3).map((p) => {
        const t = String(p?.type || '').slice(0, 3);
        const title = String(p?.title || p?.slug || '(untitled)');
        const n = Number(p?.count) || 0;
        return n > 0 ? `${t} · ${title} (${n})` : `${t} · ${title}`;
      });
      return {
        label: 'Pages',
        count: rows.length,
        items,
        more: rows.length > items.length ? rows.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Ereader — books in the local library. /api/library returns
  // { books: [{ title, ... }], folders: [...] }. Show last 3 added.
  APP_SUMMARIES['ereader'] = async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8760/api/library', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      const books = Array.isArray(data?.books) ? data.books : [];
      // No guaranteed ordering — sort by addedAt / createdAt if present.
      const sorted = books.slice().sort((a, b) => {
        const ta = Date.parse(a?.addedAt || a?.createdAt || '') || 0;
        const tb = Date.parse(b?.addedAt || b?.createdAt || '') || 0;
        return tb - ta;
      });
      const items = sorted.slice(0, 3).map((b) => String(b?.title || '(untitled)'));
      return {
        label: 'Library',
        count: books.length,
        items,
        more: books.length > items.length ? books.length - items.length : 0,
      };
    } catch {
      return null;
    }
  };

  // Short, glanceable time chip for a calendar event start. Reused by the
  // day-planner summary fetcher. Today → "2:30p"; tomorrow → "tmrw 2:30p";
  // later in the 48h window → "Fri 2:30p". All-day items skip the time.
  function formatEventWhen(startMs, allDay) {
    const d = new Date(startMs);
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const dayMs = 86_400_000;
    const diffDays = Math.floor((d.getTime() - startOfToday.getTime()) / dayMs);
    const time = (() => {
      let h = d.getHours();
      const m = d.getMinutes();
      const suf = h >= 12 ? 'p' : 'a';
      h = h % 12; if (h === 0) h = 12;
      return m === 0 ? `${h}${suf}` : `${h}:${String(m).padStart(2, '0')}${suf}`;
    })();
    if (allDay) {
      if (diffDays <= 0) return 'today';
      if (diffDays === 1) return 'tmrw';
      return d.toLocaleDateString(undefined, { weekday: 'short' });
    }
    if (diffDays <= 0) return time;
    if (diffDays === 1) return `tmrw ${time}`;
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }

  // Token-based race guard so an in-flight summary fetch for app A doesn't
  // paint into a modal that has since been re-opened for app B.
  let _summaryRequestToken = 0;

  function escSummary(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderModalSummary(summary) {
    const box = modalEl.querySelector('.dior-modal-summary');
    if (!box) return;
    if (!summary) { box.setAttribute('hidden', 'true'); box.innerHTML = ''; return; }
    const { label, count, items = [], more = 0 } = summary;
    const listHtml = items.length === 0
      ? `<li class="dior-modal-summary-empty">nothing here yet</li>`
      : items.map((t) => `<li><span class="dior-modal-summary-text" title="${escSummary(t)}">${escSummary(t)}</span></li>`).join('');
    box.innerHTML = `
      <div class="dior-modal-summary-head">
        <span>${escSummary(label || 'Summary')}</span>
        <span class="dior-modal-summary-count">${escSummary(String(count ?? items.length))}</span>
      </div>
      <ul class="dior-modal-summary-list">${listHtml}</ul>
      ${more > 0 ? `<div class="dior-modal-summary-more">+${more} more</div>` : ''}
    `;
    box.removeAttribute('hidden');
  }

  function openAppModal(placement) {
    if (!placement || !placement.appId) return;
    const project = projects.find(p => p.id === placement.appId);
    if (!project) return;
    const titleEl = modalEl.querySelector('.dior-modal-title');
    const subEl   = modalEl.querySelector('.dior-modal-sub');
    titleEl.textContent = project.title || project.id;
    // `project.room` was removed from projects.json when the rooms concept
    // was retired; the sub-line is left blank rather than re-purposed so the
    // bubble stays compact. If you want to surface something else here
    // (domain label? port?), wire it through projects.json first.
    subEl.textContent = '';
    modalEl._currentAppId = placement.appId;
    modalEl._currentPlacement = placement;
    // Wall pieces face their panel; rotating them would fight the panel
    // orientation. Hide Rotate for them.
    const rotateBtn = modalEl.querySelector('.dior-modal-rotate');
    if (rotateBtn) rotateBtn.style.display = (placement.surface === 'wall') ? 'none' : '';
    // Resize is wall-only — flips the visibility opposite to Rotate so
    // the row only ever shows one of the two on each placement.
    const resizeBtn = modalEl.querySelector('.dior-modal-resize');
    if (resizeBtn) resizeBtn.style.display = (placement.surface === 'wall') ? '' : 'none';
    modalEl.classList.add('show');
    modalOpen = true;
    appHoverEl.classList.remove('show');

    // Reset the summary slot, then if this app has a registered summary
    // fetcher, kick it off async. The modal already shows immediately —
    // the summary fills in once data arrives (or stays hidden on failure).
    renderModalSummary(null);
    const fetcher = APP_SUMMARIES[placement.appId];
    if (fetcher) {
      const token = ++_summaryRequestToken;
      const requestedAppId = placement.appId;
      const requestedPlacement = placement;
      fetcher().then((summary) => {
        // Stale-result guard: bail if a newer fetch was started, or the
        // modal was closed, or it's now showing a different app.
        if (token !== _summaryRequestToken) return;
        if (!modalOpen) return;
        if (modalEl._currentAppId !== requestedAppId) return;
        renderModalSummary(summary);
        // Height likely changed — re-anchor the bubble to its piece.
        positionModalForPlacement(requestedPlacement);
      });
    }

    // Anchor the speech bubble to the piece's screen position.
    positionModalForPlacement(placement);
  }

  function positionModalForPlacement(placement) {
    const surface = SURFACES[placement.surface];
    const p = surface && surface.placements.get(placement.placementId);
    if (!p || !p.mesh) return;

    // Project the piece's TOP (slightly above its mesh origin) to screen.
    // Using the mesh.position + a small lift makes the bubble sit above
    // the visible item rather than at its base.
    const bbox = new THREE.Box3().setFromObject(p.mesh);
    const anchor = new THREE.Vector3(
      (bbox.min.x + bbox.max.x) / 2,
      bbox.max.y,
      (bbox.min.z + bbox.max.z) / 2
    );
    const v = anchor.clone().project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const px = (v.x * 0.5 + 0.5) * rect.width  + (rect.left - cRect.left);
    const py = (-v.y * 0.5 + 0.5) * rect.height + (rect.top  - cRect.top);

    const card = modalEl.querySelector('.dior-modal');
    // Pre-measure to handle clamping (forces layout once)
    card.style.left = '0px'; card.style.top = '0px';
    card.style.visibility = 'hidden';
    card.classList.remove('below');
    // Reset so getBoundingClientRect reflects natural size
    void card.offsetWidth;
    const cardW = card.offsetWidth || 240;
    const cardH = card.offsetHeight || 120;

    const margin = 8;
    const gap = 14;          // distance between piece and bubble
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // Default: bubble sits above the piece, tail at the bottom pointing down.
    let left = px - 28;                  // tail near the bubble's left edge
    let top  = py - cardH - gap;
    let below = false;
    if (top < margin) {
      // Not enough space above — flip below.
      top = py + gap;
      below = true;
    }
    // Clamp horizontally
    if (left + cardW > containerW - margin) left = containerW - cardW - margin;
    if (left < margin) left = margin;
    // Clamp vertically (just in case the piece is way off-screen)
    if (top + cardH > containerH - margin) top = containerH - cardH - margin;
    if (top < margin) top = margin;

    // Tail sits under the piece's projected x. Compute relative to the
    // bubble's final left edge, clamped within sensible bounds.
    let tailX = px - left - 8;
    tailX = Math.max(12, Math.min(cardW - 24, tailX));

    card.style.left = left + 'px';
    card.style.top  = top + 'px';
    card.style.setProperty('--tail-x', tailX + 'px');
    card.style.setProperty('--anchor-x', tailX + 'px');
    card.style.setProperty('--anchor-y', below ? '0%' : '100%');
    card.classList.toggle('below', below);
    card.style.visibility = '';
  }

  function closeModal() {
    modalEl.classList.remove('show');
    modalEl._currentAppId = null;
    modalEl._currentPlacement = null;
    modalOpen = false;
  }

  // Open the window popup, anchored to the clicked point on the window
  // (a world-space Vector3 from the blinds-plane raycast hit).
  function openWindowMenu(worldPoint) {
    if (!winMenuEl) return;
    const subEl = winMenuEl.querySelector('.dior-modal-sub');
    if (subEl) {
      subEl.textContent =
        (_lights.sky && _lights.sky.getSceneName) ? _lights.sky.getSceneName() : '';
    }
    winMenuEl.classList.add('show');
    winMenuOpen = true;
    appHoverEl.classList.remove('show');
    positionWinMenuAt(worldPoint);
  }

  function closeWindowMenu() {
    if (!winMenuEl) return;
    winMenuEl.classList.remove('show');
    winMenuOpen = false;
  }

  // Open the wall color picker, anchored to the clicked point on the
  // wall (a world-space Vector3 from the wall raycast hit). Syncs the
  // swatch highlight + custom input to the current paint first.
  function openWallMenu(worldPoint) {
    if (!wallMenuEl) return;
    const cur = loadWallColor();
    if (wallMenuEl._setWall) {
      // Reflect current color without re-persisting (value is already saved).
      const input = wallMenuEl.querySelector('.dior-wall-color-input');
      if (input) input.value = cur;
      wallMenuEl.querySelectorAll('.dior-wall-swatch').forEach((b) => {
        b.classList.toggle('active', b.dataset.hex.toLowerCase() === cur.toLowerCase());
      });
    }
    wallMenuEl.classList.add('show');
    wallMenuOpen = true;
    appHoverEl.classList.remove('show');
    positionWinMenuAt(worldPoint, wallMenuEl);
  }

  function closeWallMenu() {
    if (!wallMenuEl) return;
    wallMenuEl.classList.remove('show');
    wallMenuOpen = false;
  }

  // Anchor the popup's speech bubble above a world-space point, with the
  // same clamping/flip logic as positionModalForPlacement.
  function positionWinMenuAt(worldPoint, menuEl = winMenuEl) {
    const v = worldPoint.clone().project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const px = (v.x * 0.5 + 0.5) * rect.width  + (rect.left - cRect.left);
    const py = (-v.y * 0.5 + 0.5) * rect.height + (rect.top  - cRect.top);

    const card = menuEl.querySelector('.dior-modal');
    card.style.left = '0px'; card.style.top = '0px';
    card.style.visibility = 'hidden';
    card.classList.remove('below');
    void card.offsetWidth;
    const cardW = card.offsetWidth || 168;
    const cardH = card.offsetHeight || 120;

    const margin = 8;
    const gap = 14;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    let left = px - 28;
    let top  = py - cardH - gap;
    let below = false;
    if (top < margin) { top = py + gap; below = true; }
    if (left + cardW > containerW - margin) left = containerW - cardW - margin;
    if (left < margin) left = margin;
    if (top + cardH > containerH - margin) top = containerH - cardH - margin;
    if (top < margin) top = margin;

    let tailX = px - left - 8;
    tailX = Math.max(12, Math.min(cardW - 24, tailX));

    card.style.left = left + 'px';
    card.style.top  = top + 'px';
    card.style.setProperty('--tail-x', tailX + 'px');
    card.style.setProperty('--anchor-x', tailX + 'px');
    card.style.setProperty('--anchor-y', below ? '0%' : '100%');
    card.classList.toggle('below', below);
    card.style.visibility = '';
  }

  function enterMoveMode(placement) {
    // Snapshot the piece's identity, then remove it visually so the
    // user can re-place it (including on its original slot).
    state.movingPiece = {
      itemId: placement.itemId,
      surface: placement.surface,
      slot: placement.slot,
      appId: placement.appId,
      rotation: placement.rotation || 0,
      userScale: placement.userScale || 1,
      // Snapshot any tabletop trinkets the piece is hosting so we can
      // re-place them on the new (or original) host once the move
      // commits. Mirrors pickUpHeld's pickedUpTrinkets path so the modal
      // Move flow has parity with drag-to-move on hosts like the desk
      // (without this, moving the desk silently wipes the laptop,
      // inboxes, toast, typewriter, and book stack).
      pickedUpTrinkets: [],
    };
    if (SURFACES.tabletop && SURFACES.tabletop.hosts.has(placement.placementId)) {
      for (const p of state.placements) {
        if (p.surface !== 'tabletop') continue;
        const parsed = SURFACES.tabletop.parseSlot(p.slot);
        if (!parsed || parsed.hostKey !== placement.placementId) continue;
        state.movingPiece.pickedUpTrinkets.push({
          itemId: p.itemId,
          tierId: parsed.tierId,
          c: parsed.c,
          r: parsed.r,
          appId: p.appId || null,
          rotation: p.rotation || 0,
        });
      }
      const removedTabletopIds = SURFACES.tabletop.unregisterHost(placement.placementId);
      for (const tid of removedTabletopIds) {
        const tIdx = state.placements.findIndex(x => x.placementId === tid);
        if (tIdx >= 0) state.placements.splice(tIdx, 1);
      }
    }
    SURFACES[placement.surface].remove(placement.placementId);
    const idx = state.placements.findIndex(p => p.placementId === placement.placementId);
    if (idx >= 0) state.placements.splice(idx, 1);
    // Arm with the same item def so slot markers appear for that surface.
    // Build the markers from the ROTATED footprint so what reads as a valid
    // green cell is what placePersisted will actually try to fit on commit.
    // Without this, a rotated non-square piece (e.g. a 4×2 TV cabinet turned
    // 90°) shows un-rotated 4×2 valid cells but commits as 2×4 — landing it
    // off-grid or on a blocker, where placePersisted returns null and the
    // piece is lost. (The drag-to-move path already does this; this brings
    // the modal Move path to parity.)
    const def = ITEMS[placement.itemId];
    if (def) {
      state.armedItem = def;
      showSlotsForItem(rotatedDefClone(def, placement.rotation || 0));
    }
    if (modalEl && modalEl._moveHintEl) modalEl._moveHintEl.classList.add('show');
  }

  function cancelArmedOrMove() {
    if (state.movingPiece) {
      // Restore the piece at its original slot AND rotation, then re-host
      // any trinkets that were sitting on it. placePersisted returns the
      // new host's placementId (which encodes the slot, so it's stable on
      // round-trip back to the original slot).
      const { itemId, surface, slot, appId, rotation, pickedUpTrinkets, userScale } = state.movingPiece;
      state.movingPiece = null;
      const newHostPid = placePersisted(itemId, surface, slot, { appId, rotation, userScale });
      rePlaceTrinkets(pickedUpTrinkets, newHostPid);
      savePlacements();
    }
    if (modalEl && modalEl._moveHintEl) modalEl._moveHintEl.classList.remove('show');
    disarm();
  }

  // armFromCatalog removed alongside the "+ Add" catalog UI. The
  // remaining held-mode entry points are pickUpHeld (drag-pickup) and
  // modal Move; both reposition existing placements rather than
  // spawning new ones. If a "spawn from catalog" flow is needed again,
  // restore from git history before catalog cleanup.

  // ── Sticky-grab drag flow ────────────────────────────────────────
  function showHeldUI(def) {
    if (heldBarEl) {
      // Wall pieces can't y-rotate (panel orientation is fixed) — hide the
      // Rotate button rather than letting clicks no-op silently.
      const rotateBtn = heldBarEl.querySelector('.dior-held-rotate');
      if (rotateBtn) rotateBtn.style.display = (def && def.surface === 'wall') ? 'none' : '';
      heldBarEl.classList.add('show');
    }
    if (heldHintEl) {
      heldHintEl.innerHTML = `<b>Carrying.</b> Click to drop · <kbd>R</kbd> rotate · <kbd>Esc</kbd> cancel`;
      heldHintEl.classList.add('show');
    }
  }
  function hideHeldUI() {
    if (heldBarEl) heldBarEl.classList.remove('show');
    if (heldHintEl) {
      heldHintEl.classList.remove('show');
      // Restore the original move-hint copy in case enterMoveMode reuses it.
      heldHintEl.innerHTML = `<b>Moving piece.</b> Click a glowing slot to place · <kbd>Esc</kbd> to cancel`;
    }
  }

  // Toggle a red "invalid placement" tint on the held piece. Sims-style
  // feedback: instead of a green/red footprint tile under the mesh, the
  // ITEM itself glows red when the snap target is blocked/occupied.
  // Implemented via the emissive channel so the mesh's base color and
  // any textures still show through under the tint.
  //
  // Tracks originals on each material's userData on first apply so we
  // can restore exactly when validity flips back. Idempotent — calling
  // with the same flag twice in a row is a no-op via h._tintInvalid.
  function setHeldTint(h, invalid) {
    if (!h || !h.mesh) return;
    if (h._tintInvalid === invalid) return;
    h._tintInvalid = invalid;
    h.mesh.traverse(o => {
      if (!o.isMesh || !o.material || !o.material.emissive) return;
      const mat = o.material;
      if (mat.userData._tintBefore === undefined) {
        mat.userData._tintBefore = {
          emissive: mat.emissive.getHex(),
          emissiveIntensity: mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1,
        };
      }
      if (invalid) {
        mat.emissive.setHex(0xc8806f); // PALETTE.invalid
        mat.emissiveIntensity = 0.55;
      } else {
        mat.emissive.setHex(mat.userData._tintBefore.emissive);
        mat.emissiveIntensity = mat.userData._tintBefore.emissiveIntensity;
      }
    });
  }


  // Mousedown on a placed piece records a dragCandidate (see
  // onPointerDown). Once the cursor crosses DRAG_THRESHOLD_PX, the
  // candidate is promoted via pickUpHeld() and the piece "sticks" to the
  // cursor: pointermove updates its world position, pointerup is ignored,
  // and the next pointerdown commits a drop at lastValidSlot. Esc /
  // hide() route through cancelHeld() which restores the original slot.
  // Build a footprint-rotated def clone for showing snap markers and
  // validating drops while a non-square piece is held. Wall pieces don't
  // rotate; tabletop pieces are 1×1 so there's nothing to swap.
  function rotatedDefClone(def, rotation) {
    if (!rotation) return def;
    if (def.surface !== 'floor') return def;
    const turns = Math.round(rotation / (Math.PI / 2));
    if (turns % 2 === 0) return def;
    const fp = def.footprint || { w: 1, d: 1 };
    return Object.assign({}, def, { footprint: { w: fp.d, d: fp.w } });
  }

  function pickUpHeld(placement) {
    const def = ITEMS[placement.itemId];
    if (!def) return false;
    const surface = SURFACES[placement.surface];
    const rec = surface && surface.placements.get(placement.placementId);
    if (!rec || !rec.mesh) return false;
    const mesh = rec.mesh;

    // If this piece hosts tabletop trinkets, snapshot them so they can be
    // re-placed on the new (or original) host after the move. The host's
    // placementId is encoded in the trinket slot key, and a moved host
    // gets a fresh placementId — see dropHeld for the slot-key rebuild.
    let pickedUpTrinkets = [];
    if (SURFACES.tabletop && SURFACES.tabletop.hosts.has(placement.placementId)) {
      for (const p of state.placements) {
        if (p.surface !== 'tabletop') continue;
        const parsed = SURFACES.tabletop.parseSlot(p.slot);
        if (!parsed || parsed.hostKey !== placement.placementId) continue;
        pickedUpTrinkets.push({
          itemId: p.itemId,
          tierId: parsed.tierId,
          c: parsed.c,
          r: parsed.r,
          appId: p.appId || null,
          rotation: p.rotation || 0,
        });
      }
      // unregisterHost detaches the trinket meshes and clears them from
      // the tabletop registry; mirror that into state.placements.
      const removedTabletopIds = SURFACES.tabletop.unregisterHost(placement.placementId);
      for (const tid of removedTabletopIds) {
        const tIdx = state.placements.findIndex(x => x.placementId === tid);
        if (tIdx >= 0) state.placements.splice(tIdx, 1);
      }
    }

    // Detach from the surface's registry and from its parent (host or
    // world). Re-parent to `world` so we can drive position directly.
    surface.placements.delete(placement.placementId);
    if (mesh.parent) mesh.parent.remove(mesh);
    world.add(mesh);
    // Force a shadow re-render on the next frame so the held piece's
    // shadow tracks it from the moment it's lifted instead of leaving a
    // static shadow at the old slot for one frame.
    markShadowsDirty();
    const idx = state.placements.findIndex(p => p.placementId === placement.placementId);
    if (idx >= 0) state.placements.splice(idx, 1);

    state.heldPiece = {
      def, mesh,
      originalSurface: placement.surface,
      originalSlot: placement.slot,
      originalRotation: placement.rotation || 0,
      currentRotation: placement.rotation || 0,
      appId: placement.appId,
      lastValidSurface: placement.surface,
      lastValidSlot: placement.slot,
      targetY: 0,
      pickedUpTrinkets,
      // Carry the user-resize through pickup → drop so a resized poster
      // doesn't snap back to 1× when you move it.
      userScale: placement.userScale || 1,
    };
    state.armedItem = def;
    showSlotsForItem(rotatedDefClone(def, state.heldPiece.currentRotation));

    // Suppress hover effects while carrying.
    setHoveredMesh(null);
    appHoverEl.classList.remove('show');
    canvas.style.cursor = 'grabbing';
    showHeldUI(def);
    return true;
  }

  // Re-place the trinkets that were sitting on a moved/cancelled host.
  // The host's NEW placementId is needed because tabletop slot keys
  // encode the host's placementId, and a re-placed floor host gets a
  // fresh id encoding its (possibly new) slot.
  function rePlaceTrinkets(trinkets, newHostPlacementId) {
    if (!trinkets || !trinkets.length || !newHostPlacementId) return;
    for (const t of trinkets) {
      const slotKey = `host:${newHostPlacementId}:${t.tierId}:${t.c},${t.r}`;
      placePersisted(t.itemId, 'tabletop', slotKey, {
        appId: t.appId || undefined,
        rotation: t.rotation,
      });
    }
  }

  // Re-place the held piece at its lastValidSlot using the current
  // rotation. placePersisted rebuilds a fresh mesh via def.factory(), so
  // the carried mesh is discarded — that's why baseScale / hover state
  // don't need to be threaded through.
  function dropHeld() {
    const h = state.heldPiece;
    if (!h) return;
    // Catalog spawns can be clicked before the cursor finds a valid
    // slot. Bail rather than commit-at-null — the piece stays held and
    // the user can keep dragging.
    if (h.isNew && !h.lastValidSlot) return;
    // Refuse drop when the cursor is currently over an invalid cell.
    // The mesh is already glowing red as feedback; clicking should
    // not snap the piece back to its last valid spot (jarring) — keep
    // the piece held so the user can move to a valid cell. Esc still
    // works to fully cancel.
    if (h._currentSnapValid === false) return;
    state.heldPiece = null;
    if (h.mesh.parent) h.mesh.parent.remove(h.mesh);
    // placePersisted rebuilds a fresh mesh below, so the carried one is
    // discarded for good — free its GPU resources.
    disposeObject(h.mesh);
    const newPid = placePersisted(h.def.id, h.lastValidSurface, h.lastValidSlot, {
      appId: h.appId,
      rotation: h.currentRotation,
      userScale: h.userScale,
    });
    rePlaceTrinkets(h.pickedUpTrinkets, newPid);

    if (h.isNew) {
      // Catalog spawn → committed Place command. Rotation is captured
      // since the user can R-rotate before dropping.
      if (newPid) {
        pushCommand({
          type: 'place',
          itemId: h.def.id,
          surface: h.lastValidSurface,
          slot: h.lastValidSlot,
          appId: h.appId || null,
          rotation: h.currentRotation || 0,
        });
      }
    } else if (newPid && (h.lastValidSurface !== h.originalSurface
                   || h.lastValidSlot !== h.originalSlot
                   || h.currentRotation !== h.originalRotation)) {
      // Existing-piece pickup → Move command, but only if anything
      // actually changed. A drag that ends back on the original slot
      // with the same rotation is effectively a no-op and shouldn't
      // burn an undo step. Rotation while held is folded into the same
      // Move (R-key bumps h.currentRotation; the modal Rotate button is
      // a separate code path that pushes its own 'rotate' command).
      pushCommand({
        type: 'move',
        itemId: h.def.id,
        appId: h.appId || null,
        from: { surface: h.originalSurface, slot: h.originalSlot, rotation: h.originalRotation },
        to:   { surface: h.lastValidSurface, slot: h.lastValidSlot, rotation: h.currentRotation },
        trinkets: h.pickedUpTrinkets || [],
      });
    }
    savePlacements();
    hideHeldUI();
    disarm();
    canvas.style.cursor = 'default';
  }

  function cancelHeld() {
    const h = state.heldPiece;
    if (!h) return;
    state.heldPiece = null;
    if (h.mesh.parent) h.mesh.parent.remove(h.mesh);
    // Restore (below) rebuilds a fresh mesh, so discard the carried one.
    disposeObject(h.mesh);
    if (!h.isNew) {
      // Existing-piece pickup → restore at original slot with original
      // rotation and re-host any trinkets that were riding on it. Fresh
      // catalog spawns have no original to restore — the mesh has been
      // detached above and we just exit.
      const newPid = placePersisted(h.def.id, h.originalSurface, h.originalSlot, {
        appId: h.appId,
        rotation: h.originalRotation,
        userScale: h.userScale,
      });
      rePlaceTrinkets(h.pickedUpTrinkets, newPid);
      savePlacements();
    }
    hideHeldUI();
    disarm();
    canvas.style.cursor = 'default';
  }

  // Discard the held piece. pickUpHeld re-parented the mesh to `world`
  // (so it could follow the cursor), so we have to detach it here —
  // skipping this leaves a frozen ghost copy in the scene. Trinkets
  // that were sitting on this host are also discarded (their meshes
  // were removed during pickUpHeld via unregisterHost). App-bound
  // launchers will be re-auto-placed by updateProjects on the next
  // diorama render — so an explicit Remove of, say, the laptop will
  // undo itself on the next view-switch. That's the current "apps
  // always have a launcher" guarantee.
  function removeHeld() {
    const h = state.heldPiece;
    if (!h) return;
    state.heldPiece = null;
    if (h.mesh && h.mesh.parent) h.mesh.parent.remove(h.mesh);
    // Discarded for good (app-bound launchers get re-auto-placed fresh).
    disposeObject(h.mesh);
    markShadowsDirty();
    if (!h.isNew) {
      // Record so undo can restore the piece at its original slot with
      // its original rotation and any trinkets that were riding on it.
      // pickUpHeld already snapshotted the trinkets and unregistered the
      // host, so we have everything we need. For a fresh catalog spawn
      // (isNew) the piece was never committed — Remove and Cancel are
      // the same thing; no undo step is recorded.
      pushCommand({
        type: 'remove',
        itemId: h.def.id,
        surface: h.originalSurface,
        slot: h.originalSlot,
        appId: h.appId || null,
        rotation: h.originalRotation || 0,
        trinkets: h.pickedUpTrinkets || [],
      });
      savePlacements();
    }
    hideHeldUI();
    disarm();
    canvas.style.cursor = 'default';
  }

  // Bumps the held piece's rotation by +90°. Re-renders the snap markers
  // for the rotated footprint and migrates lastValidSlot if it no longer
  // fits. Wall pieces are immovable in y-rotation so the call is a no-op.
  function rotateHeld() {
    const h = state.heldPiece;
    if (!h) return;
    if (h.def.surface === 'wall') return;
    h.currentRotation = (h.currentRotation + Math.PI / 2) % (Math.PI * 2);
    const defForMarkers = rotatedDefClone(h.def, h.currentRotation);
    showSlotsForItem(defForMarkers);
    // Keep lastValidSlot if the rotated footprint still fits there, else
    // fall back to the first valid slot on the same surface.
    const stillValid = state.slotMarkers.find(
      m => m.userData.slotKey === h.lastValidSlot && m.userData.valid
    );
    if (!stillValid) {
      const anyValid = state.slotMarkers.find(m => m.userData.valid);
      if (anyValid) {
        h.lastValidSlot = anyValid.userData.slotKey;
        h.lastValidSurface = anyValid.userData.surface;
      }
    }
    h.mesh.rotation.y = h.currentRotation;
  }

  // ══════════════════════════════════════════════════════════════════
  // §14 · Pointer handling
  // ══════════════════════════════════════════════════════════════════
  function getPointerNDC(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function getPlacedTargets() {
    const targets = [];
    world.traverse(c => {
      if (c.isMesh && c.userData.placementId) targets.push(c);
    });
    return targets;
  }

  // setHoveredMesh: simple setter for state.hoveredMesh — no visual
  // highlight applied. Hover still drives the cursor and the app
  // tooltip; the piece itself doesn't change appearance.
  function setHoveredMesh(mesh) {
    if (state.hoveredMesh === mesh) return;
    state.hoveredMesh = mesh;
  }
  function findPlacedAncestor(obj) {
    // Walk up while the placementId STAYS THE SAME, then stop. Every
    // descendant Mesh of a placed item gets userData.placementId stamped
    // on it (see placePersisted), so the topmost ancestor sharing that
    // same id is the placement's root Group (returned by the factory).
    //
    // Why "while same" and not "topmost any-id": tabletop items are
    // children of their HOST mesh, which has a DIFFERENT placementId. If
    // we walked all the way up we'd return the host instead of the
    // tabletop item — so a click on the mug would always trigger the desk.
    // Stopping at the boundary preserves the right semantics for both
    // floor/wall items (single-id chain) and tabletop items (nested).
    let leaf = obj;
    while (leaf && !(leaf.userData && leaf.userData.placementId)) leaf = leaf.parent;
    if (!leaf) return null;
    const targetId = leaf.userData.placementId;
    let result = leaf;
    let cur = leaf.parent;
    while (cur && cur.userData && cur.userData.placementId === targetId) {
      result = cur;
      cur = cur.parent;
    }
    return result;
  }

  // ── App list ⇄ object linking ───────────────────────────────────────
  // The side list and the 3D launcher objects spotlight each other on
  // hover. setLinkedApp() is the single entry point both directions call;
  // it owns the row highlight, the object's emissive glow, and showing the
  // connector line. updateConnector() re-aims the line each frame (the
  // object drifts with camera parallax). rebuildAppList() regenerates the
  // list whenever the set of placed apps changes.

  // Root mesh for an app's placement (the thing the line points at).
  function findAppMesh(appId) {
    if (!appId) return null;
    const pl = state.placements.find(p => p.appId === appId);
    if (!pl) return null;
    const surface = SURFACES[pl.surface];
    const rec = surface && surface.placements.get(pl.placementId);
    return rec ? rec.mesh : null;
  }

  // Emissive glow toggle for the linked object. Mirrors setHeldTint's
  // store-then-restore approach but on its own userData key (_hlBefore) so
  // it never collides with the red invalid-placement tint. GLB instances
  // get cloned materials (see makeFromGlb), so tinting one app's object
  // never bleeds into another that shares the same source model.
  // `amt` is the glow strength, 0..1, so the highlight can ease in/out
  // rather than snap. amt≈0 restores the material to its stored original
  // and forgets it.
  function setMeshHighlightAmount(mesh, amt) {
    if (!mesh) return;
    mesh.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (!mat.emissive) continue;
        if (amt > 0.001) {
          if (mat.userData._hlBefore === undefined) {
            mat.userData._hlBefore = {
              emissive: mat.emissive.getHex(),
              emissiveIntensity: mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1,
            };
          }
          const before = mat.userData._hlBefore;
          // Self-lit pieces (posters/paintings carry an emissiveMap at full
          // white) would just turn muddy teal if we overwrote the color, so
          // brighten them in place instead. Matte furniture has no glow of
          // its own — tint those teal so they actually read as picked out.
          const selfLit = !!mat.emissiveMap || before.emissive !== 0x000000;
          if (selfLit) {
            mat.emissiveIntensity = before.emissiveIntensity * (1 + 0.28 * amt);
          } else {
            mat.emissive.setHex(PALETTE.highlight);
            mat.emissiveIntensity = 0.26 * amt;
          }
        } else if (mat.userData._hlBefore !== undefined) {
          mat.emissive.setHex(mat.userData._hlBefore.emissive);
          mat.emissiveIntensity = mat.userData._hlBefore.emissiveIntensity;
          mat.userData._hlBefore = undefined;
        }
      }
    });
  }

  // Per-frame easing of the object glow toward _glowTarget (1 = linked,
  // 0 = releasing). When a release finishes, restore + forget the mesh.
  function updateGlow(dt) {
    if (!_glowMesh) return;
    // Hold for the lead-in delay before ramping (matches the line/row).
    if (_glowDelay > 0) { _glowDelay -= dt; return; }
    const k = 1 - Math.exp(-14 * dt);
    _glowT += (_glowTarget - _glowT) * k;
    if (_glowTarget === 0 && _glowT < 0.02) {
      setMeshHighlightAmount(_glowMesh, 0);  // snap to fully restored
      _glowMesh = null;
      _glowT = 0;
      return;
    }
    setMeshHighlightAmount(_glowMesh, _glowT);
  }

  // Project a mesh's bounding-box center to overlayRoot-pixel coords (the
  // list + connector share that origin). `behind` is true when the point is
  // behind the camera, in which case the caller should hide the line.
  const _connProjV = new THREE.Vector3();
  function worldToContainer(mesh) {
    const bbox = new THREE.Box3().setFromObject(mesh);
    if (bbox.isEmpty()) return { x: 0, y: 0, behind: true };
    _connProjV.set(
      (bbox.min.x + bbox.max.x) / 2,
      (bbox.min.y + bbox.max.y) / 2,
      (bbox.min.z + bbox.max.z) / 2
    );
    _connProjV.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    const oRect = overlayRoot.getBoundingClientRect();
    return {
      x: (_connProjV.x * 0.5 + 0.5) * rect.width  + (rect.left - oRect.left),
      y: (-_connProjV.y * 0.5 + 0.5) * rect.height + (rect.top  - oRect.top),
      behind: _connProjV.z > 1,
    };
  }

  // Set (or clear, with null) the linked app. Idempotent — repeat calls
  // with the same id are a no-op, so it's safe to call on every pointermove.
  function setLinkedApp(appId) {
    appId = appId || null;
    if (state.linkedAppId === appId) return;
    state.linkedAppId = appId;
    // Restart the lead-in delay on every change so the glow engages/releases
    // in step with the CSS-delayed row highlight + connector fade.
    _glowDelay = GLOW_DELAY;
    // Sync row highlights (CSS handles the 120ms background fade).
    if (appListEl) {
      appListEl.querySelectorAll('.dior-applist-item').forEach(el => {
        el.classList.toggle('active', el.dataset.appId === appId);
      });
    }
    const mesh = appId ? findAppMesh(appId) : null;
    if (appId) {
      // Hand the glow to the new mesh. If it's a different object than the
      // one currently glowing, snap the old one off so the new one eases in
      // from zero rather than cross-fading mid-value.
      if (mesh !== _glowMesh) {
        if (_glowMesh) setMeshHighlightAmount(_glowMesh, 0);
        _glowMesh = mesh;
        _glowT = 0;
      }
      _glowTarget = 1;
      updateConnector();
    } else {
      // Ease the glow back out (updateGlow restores once it reaches 0) and
      // let the connector fade via its CSS opacity transition.
      _glowTarget = 0;
      if (connectorSvgEl) connectorSvgEl.classList.remove('show');
    }
  }

  // Re-aim the connector line from the active list row's inner (right)
  // edge to the linked object's on-screen position. Called from setLinkedApp
  // and once per animation frame (the object moves with parallax).
  function updateConnector() {
    if (!state.linkedAppId || !connectorSvgEl) return;
    const item = appListEl && appListEl.querySelector('.dior-applist-item.active');
    const mesh = findAppMesh(state.linkedAppId);
    if (!item || !mesh) { connectorSvgEl.classList.remove('show'); return; }
    const target = worldToContainer(mesh);
    if (target.behind) { connectorSvgEl.classList.remove('show'); return; }
    const oRect = overlayRoot.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    // List is its own column on the left, so its inner edge facing the
    // scene is the right side of the row.
    const ax = iRect.right - oRect.left;
    const ay = (iRect.top + iRect.height / 2) - oRect.top;
    // Elbow: run flat off the name, then angle to the object. The flat
    // part scales with the horizontal gap so distant objects get a long
    // flat run and only a short angled finish (min 56px so close objects
    // still read as an elbow). Clamped so it never overshoots the object.
    const dx = Math.max(0, target.x - ax);
    const STUB = Math.max(56, dx * 0.62);
    const ex = Math.min(ax + STUB, target.x);
    connectorSvgEl.classList.add('show');
    connectorLineEl.setAttribute(
      'points',
      ax + ',' + ay + ' ' + ex + ',' + ay + ' ' + target.x + ',' + target.y
    );
    connectorDotEl.setAttribute('cx', target.x);
    connectorDotEl.setAttribute('cy', target.y);
  }

  // Rebuild the side list from the apps that currently have a placed
  // object. Order follows the launcher's own project order. Preserves any
  // active link by re-stamping the .active class via the `active` check.
  function rebuildAppList() {
    if (!appListEl) return;
    // Don't show the left column while the diorama frame itself is hidden
    // (an app is embedded) — the list is a sibling of the frame, so it
    // would otherwise float in the layout next to the embed.
    if (container && container.hasAttribute('hidden')) {
      appListEl.style.display = 'none';
      return;
    }
    const placedIds = new Set(state.placements.filter(p => p.appId).map(p => p.appId));
    const rows = projects.filter(p => placedIds.has(p.id));
    if (!rows.length) { appListEl.style.display = 'none'; return; }
    appListEl.style.display = '';
    const active = state.linkedAppId;
    appListEl.innerHTML =
      '<div class="dior-applist-title">Apps</div>' +
      rows.map(p =>
        '<button type="button" class="dior-applist-item' +
        (p.id === active ? ' active' : '') + '" data-app-id="' +
        escapeHtml(p.id) + '">' + escapeHtml(p.title || p.id) + '</button>'
      ).join('');
  }


  // While dragging, ray a horizontal plane at the surface's natural height
  // so the piece can free-fly between slots (rather than only snapping when
  // the cursor is exactly on a marker). Falls back to the slot anchor if
  // the cursor would project outside the room.
  const _floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  // Back-wall plane (z = BACK_WALL_Z = -ROOM.depth/2). Used as a
  // fallback when the cursor ray points above the floor horizon — see
  // projectCursorToFloor below.
  const _backWallProjPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -BACK_WALL_Z);
  const _heldHitPoint = new THREE.Vector3();
  function projectCursorToFloor() {
    if (raycaster.ray.intersectPlane(_floorPlane, _heldHitPoint)) return _heldHitPoint;
    // Cursor's ray points above the floor horizon (e.g. user dragged
    // the cursor toward the back of the screen to push a piece against
    // the back wall). Fall back to projecting onto the back wall: the
    // ray definitely hits it, and the x of that hit is what the user
    // is pointing at. We force y=0 so the caller can treat the result
    // as a floor coordinate; the z stays at BACK_WALL_Z, which makes
    // the cell-anchor inference clamp the row to 0 (back of room).
    if (raycaster.ray.intersectPlane(_backWallProjPlane, _heldHitPoint)) {
      _heldHitPoint.y = 0;
      return _heldHitPoint;
    }
    return null;
  }

  // Resolve which tabletop cell the cursor is targeting, in SCREEN SPACE —
  // not by raycasting the marker meshes, and not by ray↔plane intersection.
  // Why screen space: a tier can be mounted where the camera sees its top
  // nearly edge-on (the floating wall shelf, viewed from below, has its
  // whole top hidden behind the board's front lip). Raycasting the tiny
  // markers then never registers a hit, AND ray↔plane intersection is
  // useless too — at a grazing angle the hit point slides metres along the
  // plane for a one-pixel cursor move, so it almost never lands inside the
  // tier's shallow depth. Projecting each candidate cell to the screen and
  // picking the one nearest the cursor is robust at ANY viewing angle.
  //
  // Returns the nearest cell's slotKey (matching the markers built by
  // showSlotsForItem) when the cursor is within ~0.32 NDC of a cell, else
  // null. Cost is O(cells) per call (~100 cells across desk + shelf), which
  // is fine per pointermove.
  const _ttCellWP = new THREE.Vector3();
  function inferTabletopSlotKey(def) {
    if (!SURFACES.tabletop || !def) return null;
    const fp = def.footprint || { w: 1, d: 1 };
    let bestKey = null, bestDist = Infinity;
    for (const [hostKey, host] of SURFACES.tabletop.hosts.entries()) {
      if (!host.mesh) continue;
      host.mesh.updateMatrixWorld(true);
      for (const tier of host.tabletops) {
        const cellW = tier.w / tier.cols;
        const cellD = tier.d / tier.rows;
        for (let r = 0; r <= tier.rows - fp.d; r++) {
          for (let c = 0; c <= tier.cols - fp.w; c++) {
            // Footprint-center anchor in the host's local frame → world →
            // normalized device coords, then compare to the cursor (mouse).
            const lx = (tier.x || 0) - tier.w / 2 + (c + fp.w / 2) * cellW;
            const lz = (tier.z || 0) - tier.d / 2 + (r + fp.d / 2) * cellD;
            _ttCellWP.set(lx, tier.y, lz);
            host.mesh.localToWorld(_ttCellWP);
            _ttCellWP.project(camera);
            if (_ttCellWP.z > 1) continue;  // behind the camera
            const dx = _ttCellWP.x - mouse.x;
            const dy = _ttCellWP.y - mouse.y;
            const d = dx * dx + dy * dy;
            if (d < bestDist) {
              bestDist = d;
              bestKey = `host:${hostKey}:${tier.id}:${c},${r}`;
            }
          }
        }
      }
    }
    // Don't snap to a far-off tier when the cursor is nowhere near one.
    return bestDist <= 0.32 * 0.32 ? bestKey : null;
  }

  // ── Mirror cursor reflection ─────────────────────────────────────────
  // Find the mirror's glass sub-mesh (tagged isMirrorGlass in glbMirror's
  // onMesh) and project its world bounding box to canvas pixels, returning
  // the on-screen rectangle of the glass — or null if there's no mirror, or
  // it's behind the camera / degenerate on screen. The canvas fills the
  // container, so these pixels double as container-relative overlay coords.
  const _mirrorProjV = new THREE.Vector3();
  function getMirrorGlassRect() {
    const root = findAppMesh('daily-journal');
    if (!root) return null;
    let glass = null;
    root.traverse(o => { if (o.userData && o.userData.isMirrorGlass) glass = o; });
    if (!glass) return null;
    const bbox = new THREE.Box3().setFromObject(glass);
    if (bbox.isEmpty()) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let anyFront = false;
    for (let i = 0; i < 8; i++) {
      _mirrorProjV.set(
        (i & 1) ? bbox.max.x : bbox.min.x,
        (i & 2) ? bbox.max.y : bbox.min.y,
        (i & 4) ? bbox.max.z : bbox.min.z
      );
      _mirrorProjV.project(camera);
      if (_mirrorProjV.z > 1) continue;  // corner behind the camera
      anyFront = true;
      const px = (_mirrorProjV.x * 0.5 + 0.5) * rect.width;
      const py = (-_mirrorProjV.y * 0.5 + 0.5) * rect.height;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    if (!anyFront || maxX - minX < 2 || maxY - minY < 2) return null;
    return { minX, minY, maxX, maxY };
  }

  // Show a mirror-image hand inside the mirror glass when the cursor (canvas
  // pixels) is over it. Rather than reversing the cursor's movement, the
  // reflected hand simply trails the real cursor by a small fixed diagonal
  // offset (~20px), clipped to the glass edges. Hidden when off the glass.
  const MIRROR_OFFSET_X = -13;  // lower-LEFT of the cursor (~18px diagonal)
  const MIRROR_OFFSET_Y = 13;
  function updateMirrorReflection(cx, cy) {
    if (!mirrorClipEl) return;
    const r = getMirrorGlassRect();
    if (!r || cx < r.minX || cx > r.maxX || cy < r.minY || cy > r.maxY) {
      mirrorClipEl.classList.remove('show');
      return;
    }
    mirrorClipEl.style.left = r.minX + 'px';
    mirrorClipEl.style.top = r.minY + 'px';
    mirrorClipEl.style.width = (r.maxX - r.minX) + 'px';
    mirrorClipEl.style.height = (r.maxY - r.minY) + 'px';
    mirrorCursorEl.style.left = ((cx + MIRROR_OFFSET_X) - r.minX) + 'px';
    mirrorCursorEl.style.top = ((cy + MIRROR_OFFSET_Y) - r.minY) + 'px';
    mirrorClipEl.classList.add('show');
  }
  function hideMirrorReflection() {
    if (mirrorClipEl) mirrorClipEl.classList.remove('show');
  }

  function onPointerMove(e) {
    // Wall-item resize takes priority — it owns the pointer until release.
    // Hold here BEFORE the parallax / debug branches so the handle drag
    // can't be hijacked by camera orbit or hover updates mid-stream.
    if (RESIZE.dragging) {
      updateResizeDrag(e);
      e.preventDefault();
      return;
    }
    // Always update the parallax target from the cursor — it's
    // independent of placement/hover and of camera debug orbiting.
    // Putting it above the debug gate means the sky still drifts with
    // the cursor when you're tweaking the camera, which is what you
    // want while iterating on the look.
    const local = getPointerNDC(e);
    if (!state.heldPiece) {
      _parallaxTargetX = mouse.x;
      _parallaxTargetY = mouse.y;
    }

    // Camera debug mode owns the rest of the pointer — orbit on drag,
    // ignore the placement/hover logic below entirely.
    if (cameraDebug.enabled) {
      if (cameraDebug.dragLast) {
        const dx = e.clientX - cameraDebug.dragLast.x;
        const dy = e.clientY - cameraDebug.dragLast.y;
        cameraDebug.dragLast = { x: e.clientX, y: e.clientY };
        cameraDebugOrbit(dx, dy);
      }
      return;
    }
    raycaster.setFromCamera(mouse, camera);

    // Drag promotion: a mousedown-on-piece becomes a sticky-grab once the
    // cursor leaves a small dead zone. Anything inside is still a click.
    if (state.dragCandidate && !state.heldPiece) {
      const dx = e.clientX - state.dragCandidate.startX;
      const dy = e.clientY - state.dragCandidate.startY;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        const cand = state.dragCandidate;
        state.dragCandidate = null;
        pickUpHeld(cand.placement);
      }
    }

    // Mirror cursor reflection — track during normal hovering; suppress
    // while carrying/placing a piece. Stash the cursor px so the animation
    // loop can re-aim it as the mirror drifts with camera parallax.
    _lastCursorPx = { x: local.x, y: local.y };
    if (state.heldPiece || state.armedItem) {
      hideMirrorReflection();
    } else {
      updateMirrorReflection(local.x, local.y);
    }

    // Held: reveal the marker under the cursor (green if valid, red if
    // not), snap the mesh to it on valid cells, free-fly across the
    // floor between markers. Sims / Animal Crossing feel: at any moment
    // exactly one footprint-shaped highlight is visible, the rest of
    // the grid stays as just the persistent floor lines.
    if (state.heldPiece) {
      const h = state.heldPiece;
      // Reset previously-highlighted markers (cheap — typically 0–2).
      for (const m of state.activeMarkers) {
        m.material.opacity = 0;
        m.scale.set(1, 1, 1);
      }
      state.activeMarkers.length = 0;

      let snapMarker = null;
      if (h.def.surface === 'floor') {
        // FLOOR: always-snap via cell-anchor inference. No raycast, no
        // free-fly. Project the cursor onto the floor plane, compute
        // the cell anchor whose footprint center is closest to that
        // projection, clamp to the valid anchor range, and snap.
        //
        // Why not raycast against markers + a free-fly fallback (the
        // previous approach)? At marker boundaries the cursor would
        // briefly miss all hits, the code would switch from
        // snap-to-marker (target = cell center) to free-fly (target =
        // cursor position), then switch back on the next frame — the
        // lerp would chase an oscillating target and the mesh would
        // jitter "between cells". Inference picks ONE deterministic
        // anchor per cursor position; the target only changes when
        // the cursor crosses a cell boundary, and lerp turns each
        // crossing into a clean glide.
        const fs = SURFACES.floor;
        const rotatedDef = rotatedDefClone(h.def, h.currentRotation);
        const fp = rotatedDef.footprint || { w: 1, d: 1 };
        const p = projectCursorToFloor();
        if (p) {
          let cellC = Math.round((p.x + ROOM.width / 2) / fs.cellW - fp.w / 2);
          let cellR = Math.round((p.z + ROOM.depth / 2) / fs.cellD - fp.d / 2);
          cellC = Math.max(0, Math.min(fs.cols - fp.w, cellC));
          cellR = Math.max(0, Math.min(fs.rows - fp.d, cellR));
          const inferKey = cellC + ',' + cellR;
          snapMarker = state.slotMarkers.find(m => m.userData.slotKey === inferKey) || null;
        }
      } else if (h.def.surface === 'wall') {
        // WALL: same inference approach as floor. Raycast against the
        // actual wall meshes (cheap — only 3 meshes), find the hit
        // panel, convert the world hit point to a cell anchor, snap
        // there. Avoids the raycast-against-many-overlapping-markers
        // approach which would have hit order flip unpredictably as
        // the cursor moved across overlapping markers, causing the
        // mesh to jitter between adjacent cells.
        const wallSurface = SURFACES.wall;
        const fp = h.def.footprint || { w: 3, h: 3 };
        const wallMeshes = [_backWallMesh, _leftWallMesh, _rightWallMesh].filter(Boolean);
        const wallHits = raycaster.intersectObjects(wallMeshes, false);
        if (wallHits.length) {
          const hit = wallHits[0];
          const hp = hit.point;
          let panelId = null;
          let panel = null;
          let cRaw = 0, rRaw = 0;
          if (hit.object === _backWallMesh) {
            panelId = 'back';
            panel = wallSurface.panels.back;
            const startX = -(panel.cols * panel.cellW) / 2 + panel.cellW / 2;
            const startY = panel.bottomY + panel.cellH / 2;
            cRaw = (hp.x - startX) / panel.cellW - (fp.w - 1) / 2;
            rRaw = (hp.y - startY) / panel.cellH - (fp.h - 1) / 2;
          } else if (hit.object === _leftWallMesh) {
            panelId = 'left';
            panel = wallSurface.panels.left;
            const startZ = -(panel.cols * panel.cellW) / 2 + panel.cellW / 2;
            const startY = panel.bottomY + panel.cellH / 2;
            cRaw = (hp.z - startZ) / panel.cellW - (fp.w - 1) / 2;
            rRaw = (hp.y - startY) / panel.cellH - (fp.h - 1) / 2;
          } else if (hit.object === _rightWallMesh) {
            panelId = 'right';
            panel = wallSurface.panels.right;
            const startZ = -(panel.cols * panel.cellW) / 2 + panel.cellW / 2;
            const startY = panel.bottomY + panel.cellH / 2;
            cRaw = (hp.z - startZ) / panel.cellW - (fp.w - 1) / 2;
            rRaw = (hp.y - startY) / panel.cellH - (fp.h - 1) / 2;
          }
          if (panel) {
            const cellC = Math.max(0, Math.min(panel.cols - fp.w, Math.round(cRaw)));
            const cellR = Math.max(0, Math.min(panel.rows - fp.h, Math.round(rRaw)));
            const inferKey = panelId + ':' + cellC + ',' + cellR;
            snapMarker = state.slotMarkers.find(m => m.userData.slotKey === inferKey) || null;
          }
        }
      } else {
        // TABLETOP: cursor-inference against each host tier's PLANE — see
        // inferTabletopSlotKey for the why (occluded/edge-on markers can't
        // be raycast reliably, e.g. the high floating shelf seen from below).
        const bestKey = inferTabletopSlotKey(h.def);
        if (bestKey) {
          snapMarker = state.slotMarkers.find(m => m.userData.slotKey === bestKey) || null;
        }
      }

      if (snapMarker) {
        // No translucent footprint tile under the mesh — the held mesh
        // itself is the placement preview. Move it to the snap cell
        // every frame; tint it red when the cell would reject the drop.
        const _snapWP = new THREE.Vector3();
        snapMarker.getWorldPosition(_snapWP);
        h.mesh.position.x = _snapWP.x;
        h.mesh.position.z = _snapWP.z;
        h.targetY = _snapWP.y + (h.def.surface === 'wall' ? 0 : HELD_LIFT);
        h.mesh.visible = true;
        setHeldTint(h, !snapMarker.userData.valid);
        h._currentSnapValid = !!snapMarker.userData.valid;
        if (snapMarker.userData.valid) {
          h.lastValidSlot = snapMarker.userData.slotKey;
          h.lastValidSurface = snapMarker.userData.surface;
        }
      } else {
        // Cursor doesn't project onto any panel — keep the mesh at its
        // last position and clear any red tint so it doesn't get stuck
        // glowing when the user pans away.
        setHeldTint(h, false);
        h._currentSnapValid = false;
      }
      appHoverEl.classList.remove('show');
      setHoveredMesh(null);
      setLinkedApp(null);
      return;
    }

    if (state.armedItem) {
      // Marker hover (modal-Move path, where the piece isn't held but
      // the user is choosing a destination). Same Sims-style treatment:
      // one footprint highlight under the cursor, red for invalid hover,
      // everything else hidden against the persistent floor grid. The
      // closest-anchor tiebreak matches the held-mode logic — see the
      // big comment in the heldPiece branch above for why this is
      // needed on a fine grid with overlapping footprints.
      // Reset only the markers we lit up last frame (see activeMarkers
      // comment in the heldPiece branch).
      for (const m of state.activeMarkers) {
        m.material.opacity = 0;
        m.scale.set(1, 1, 1);
      }
      state.activeMarkers.length = 0;
      state.hoverMarker = null;
      canvas.style.cursor = 'default';
      let pick = null;
      if (state.armedItem.surface === 'tabletop') {
        // Tabletop destinations use plane-inference too (markers may be
        // occluded/edge-on — same reason as the held branch).
        const bestKey = inferTabletopSlotKey(state.armedItem);
        if (bestKey) pick = state.slotMarkers.find(m => m.userData.slotKey === bestKey) || null;
      } else {
        const hits = raycaster.intersectObjects(state.slotMarkers, false);
        if (hits.length === 1) {
          pick = hits[0].object;
        } else if (hits.length > 1) {
          const cursorWP = projectCursorToFloor();
          if (cursorWP) {
            let bestDist = Infinity;
            const _mWP = new THREE.Vector3();
            for (const hit of hits) {
              const m = hit.object;
              m.getWorldPosition(_mWP);
              const dx = _mWP.x - cursorWP.x;
              const dz = _mWP.z - cursorWP.z;
              const d = dx * dx + dz * dz;
              if (d < bestDist) {
                bestDist = d;
                pick = m;
              }
            }
          } else {
            pick = hits[0].object;
          }
        }
      }
      if (pick) {
        pick.material.opacity = pick.userData.valid ? 0.7 : 0.45;
        pick.scale.set(1.05, 1.05, 1.05);
        state.activeMarkers.push(pick);
        if (pick.userData.valid) {
          state.hoverMarker = pick;
          canvas.style.cursor = 'pointer';
        }
      }
      appHoverEl.classList.remove('show');
      // Don't highlight placed pieces while the user is actively placing.
      setHoveredMesh(null);
      setLinkedApp(null);
      return;
    }

    // not armed — hover over any placed piece shows the grab cursor and
    // highlights it. Pieces with an appId additionally pop a title
    // tooltip; decorative pieces (no appId) just get the cursor + lift.
    const hits = raycaster.intersectObjects(getPlacedTargets(), true);
    canvas.style.cursor = 'default';
    let pieceHit = null;
    for (const h of hits) {
      const o = findPlacedAncestor(h.object);
      if (o && o.userData.placementId) { pieceHit = o; break; }
    }
    if (pieceHit) {
      canvas.style.cursor = 'grab';
      setHoveredMesh(pieceHit);
      if (pieceHit.userData.appId) {
        const project = projects.find(p => p.id === pieceHit.userData.appId);
        if (project) {
          // Object hover shows the floating title tooltip only — NO connector
          // line. The line is reserved for hovering the app NAME in the side
          // list (see appListEl pointerover). Clear any active link so an
          // object hover never leaves a line dangling.
          setLinkedApp(null);
          appHoverEl.innerHTML = escapeHtml(project.title || project.id);
          appHoverEl.style.left = (local.x) + 'px';
          appHoverEl.style.top = (local.y) + 'px';
          appHoverEl.classList.add('show');
          return;
        }
      }
      setLinkedApp(null);
      appHoverEl.classList.remove('show');
      return;
    }
    // Window hover — show a pointer cursor so the affordance is
    // discoverable. Checked after the piece hit-test so a placed item
    // overlapping the window still wins.
    if (_blinds && _blinds.hitPlane) {
      const blindHits = raycaster.intersectObject(_blinds.hitPlane, false);
      if (blindHits.length) {
        canvas.style.cursor = 'pointer';
        appHoverEl.classList.remove('show');
        setHoveredMesh(null);
        setLinkedApp(null);
        return;
      }
    }
    appHoverEl.classList.remove('show');
    setHoveredMesh(null);
    setLinkedApp(null);
  }

  // Flip the shades between raised and lowered. The animation loop
  // smoothly tweens `currentProgress` toward `targetProgress` so the
  // slats glide rather than snap. progress = 1 → fully closed (slats
  // spread across the window); progress = 0 → fully open (slats bunched
  // in a stack at the top).
  function toggleBlinds() {
    if (!_blinds) return;
    _blinds.isOpen = !_blinds.isOpen;
    _blinds.targetProgress = _blinds.isOpen ? 0 : 1;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    // Camera debug: start an orbit-drag instead of any placement work.
    if (cameraDebug.enabled) {
      cameraDebug.dragLast = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (modalOpen || winMenuOpen || wallMenuOpen) return;  // popup backdrop captures these; canvas is dormant
    getPointerNDC(e);
    raycaster.setFromCamera(mouse, camera);

    // Resize handle takes priority over every other pointer-down path:
    // when it's visible and the cursor lands on it, we start a resize
    // drag and short-circuit the rest (no sticky-grab, no modal click).
    if (pickResizeHandle()) {
      if (beginResizeDrag(e)) {
        e.preventDefault();
        return;
      }
    }

    // Sticky-grab: any pointerdown on the canvas while a piece is held
    // commits a drop at lastValidSlot. (Bar buttons stop propagation so
    // their clicks don't reach here.)
    if (state.heldPiece) {
      dropHeld();
      return;
    }

    if (state.armedItem) {
      // Two armed paths: modal Move (state.movingPiece set, restoring
      // the original piece on cancel) and catalog placement (no
      // movingPiece — decorative item with no appId).
      const hits = raycaster.intersectObjects(state.slotMarkers, false);
      if (hits.length) {
        const m = hits[0].object;
        if (m.userData.valid) {
          // Markers now reflect the rotated footprint (see enterMoveMode),
          // so the piece commits at its original rotation.
          if (state.movingPiece) {
            const { appId, rotation, pickedUpTrinkets,
                    surface: fromSurface, slot: fromSlot, userScale } = state.movingPiece;
            state.movingPiece = null;
            // Preserve the original rotation (used to be silently dropped)
            // and re-host snapshotted trinkets at their original tier/cell.
            // newHostPid encodes the NEW slot, so the trinket slot keys
            // get rebuilt against it inside rePlaceTrinkets. userScale is
            // threaded through so a resized wall poster keeps its size
            // across the move (otherwise it'd snap back to 1× on drop).
            const movedItemId = state.armedItem.id;
            const toSurface = state.armedItem.surface;
            const toSlot = m.userData.slotKey;
            let newHostPid = placePersisted(
              movedItemId, toSurface, toSlot,
              { appId, rotation: rotation || 0, userScale }
            );
            // Safety net: if the placement somehow fails (e.g. a rounding
            // edge case at the grid boundary), restore the piece at its
            // original slot rather than vaporising it. The origin slot was
            // just vacated by enterMoveMode, so it's guaranteed free.
            const placedAtTarget = !!newHostPid;
            if (!newHostPid) {
              newHostPid = placePersisted(
                movedItemId, fromSurface, fromSlot,
                { appId, rotation: rotation || 0, userScale }
              );
            }
            rePlaceTrinkets(pickedUpTrinkets, newHostPid);
            // Only record the move if the piece actually landed on the
            // target and the destination differs from the origin — clicking
            // the original slot (or falling back to it) is a no-op from the
            // user's perspective and shouldn't burn an undo step.
            if (placedAtTarget && (fromSurface !== toSurface || fromSlot !== toSlot)) {
              pushCommand({
                type: 'move',
                itemId: movedItemId,
                appId: appId || null,
                from: { surface: fromSurface, slot: fromSlot, rotation: rotation || 0 },
                to:   { surface: toSurface,   slot: toSlot,   rotation: rotation || 0 },
                trinkets: pickedUpTrinkets || [],
              });
            }
          } else {
            // Legacy click-to-place path. The only entry that sets
            // state.armedItem without heldPiece is modal Move (handled
            // by the if-block above). The catalog UI that used to also
            // reach here has been removed. Branch kept as a safety net
            // in case a future flow arms an item without going through
            // held mode.
            const opts = state.armedAppId ? { appId: state.armedAppId } : {};
            const placedItemId = state.armedItem.id;
            const placedSurface = state.armedItem.surface;
            const placedSlot = m.userData.slotKey;
            const placedPid = placePersisted(placedItemId, placedSurface, placedSlot, opts);
            if (placedPid) {
              pushCommand({
                type: 'place',
                itemId: placedItemId,
                surface: placedSurface,
                slot: placedSlot,
                appId: opts.appId || null,
                rotation: 0,
              });
            }
          }
          savePlacements();
          if (modalEl && modalEl._moveHintEl) modalEl._moveHintEl.classList.remove('show');
          disarm();
          return;
        }
      }
      // Clicked outside any valid slot: cancel (and restore if moving).
      cancelArmedOrMove();
      return;
    }

    // Click the right-wall window to open the window popup (Blinds /
    // Change scene). Checked here (not earlier) so an in-progress
    // placement / drag / armed catalog pick keeps priority. Returns
    // before the piece hit-test so we don't accidentally treat the click
    // as a drag-candidate on something behind the window.
    if (_blinds && _blinds.hitPlane) {
      const blindHits = raycaster.intersectObject(_blinds.hitPlane, false);
      if (blindHits.length) {
        openWindowMenu(blindHits[0].point);
        return;
      }
    }

    // Click a bare wall to open the paint color picker. Tested AFTER the
    // placed-piece hit test below would otherwise win... but we want a
    // click on empty wall (not on a poster/shelf) to paint, so we check
    // the walls only if no placed piece is under the cursor. Do the piece
    // hit-test first, then fall back to walls.
    {
      const pieceHits = raycaster.intersectObjects(getPlacedTargets(), true);
      let pieceUnderCursor = false;
      for (const h of pieceHits) {
        const o = findPlacedAncestor(h.object);
        if (o && o.userData.placementId) {
          const placement = state.placements.find(p => p.placementId === o.userData.placementId);
          if (placement) {
            state.dragCandidate = { startX: e.clientX, startY: e.clientY, placement };
            pieceUnderCursor = true;
            break;
          }
        }
      }
      if (pieceUnderCursor) return;

      const wallMeshes = [_backWallMesh, _leftWallMesh, _rightWallMesh].filter(Boolean);
      if (wallMeshes.length) {
        const wallHits = raycaster.intersectObjects(wallMeshes, false);
        if (wallHits.length) {
          openWallMenu(wallHits[0].point);
          return;
        }
      }
    }

    // Mousedown on any placed piece (app-tagged or decorative) — record a
    // candidate. Whether this becomes a click (→ launch modal, only for
    // app pieces) or a drag (→ sticky-grab, any piece) depends on what
    // happens next: see DRAG_THRESHOLD_PX promotion in onPointerMove and
    // the click commit in onPointerUp.
    const hits = raycaster.intersectObjects(getPlacedTargets(), true);
    for (const h of hits) {
      const o = findPlacedAncestor(h.object);
      if (!o || !o.userData.placementId) continue;
      const placement = state.placements.find(p => p.placementId === o.userData.placementId);
      if (!placement) continue;
      state.dragCandidate = {
        startX: e.clientX,
        startY: e.clientY,
        placement,
      };
      return;
    }
  }

  function onPointerUp(e) {
    if (e.button !== 0) return;
    // Resize handle drag wins over the rest. End it and bail so the
    // pending click-to-open-modal logic below doesn't fire (we don't
    // want letting go of the corner to also launch the app).
    if (RESIZE.dragging) {
      endResizeDrag();
      e.preventDefault();
      return;
    }
    // Camera debug: end the orbit-drag.
    if (cameraDebug.enabled) {
      cameraDebug.dragLast = null;
      canvas.style.cursor = 'grab';
      return;
    }
    // Held pieces stick — pointerup is intentionally inert. The next
    // pointerdown on the canvas commits the drop.
    if (state.heldPiece) return;
    // No drag happened: it was a plain click on a piece → open modal.
    if (state.dragCandidate) {
      const { placement } = state.dragCandidate;
      state.dragCandidate = null;
      setHoveredMesh(null);
      openAppModal(placement);
    }
  }

  function onContextMenu(e) {
    e.preventDefault();
    // Right-click is inert in camera debug mode.
    if (cameraDebug.enabled) return;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(getPlacedTargets(), true);
    for (const h of hits) {
      const o = findPlacedAncestor(h.object);
      if (o && o.userData.appId && onPieceContextMenuCb) {
        onPieceContextMenuCb(o.userData.appId);
        return;
      }
    }
  }

  function escapeHtml(s) {
    // Quotes are escaped too because this value is also interpolated into a
    // double-quoted attribute (data-app-id="…") in the app-list markup; a
    // project id containing a quote would otherwise break out of it.
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  // ══════════════════════════════════════════════════════════════════
  // §15 · Persistence — only stores user-modified placements; auto-placed
  //       app items get re-derived if no save exists.
  // ══════════════════════════════════════════════════════════════════
  function savePlacements() {
    try {
      const data = state.placements.map(p => ({
        itemId: p.itemId, surface: p.surface, slot: p.slot,
        appId: p.appId || null, rotation: p.rotation || 0,
        // Only emit userScale when it's set to something other than 1 —
        // keeps the saved JSON small for the common case and lets older
        // readers ignore the field gracefully.
        ...(p.userScale && p.userScale !== 1 ? { userScale: p.userScale } : {}),
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: CURRENT_SCHEMA,
        placements: data,
      }));
    } catch (e) {
      // Don't let a save failure (quota exceeded, serialization error,
      // localStorage disabled) throw into the caller — but do surface it,
      // since a silent failure means the user's edits won't persist.
      console.warn('[diorama] failed to persist layout:', e);
    }
    // Wall holes follow placement state — rebuild geometry on each save.
    rebuildWallGeometry();
  }

  // Schema migrations. Each key `N` is a function that upgrades data from
  // version (N-1) → N in place. Add entries here when changing the saved
  // JSON shape (NOT when renaming items — those rewrites live as ad-hoc
  // remappings inside loadPlacements and are content-level, not shape-
  // level). Migrations run sequentially from the saved version up to
  // CURRENT_SCHEMA, so each one only needs to know its own step.
  const MIGRATIONS = {
    // 8 → 9: introduce schemaVersion field; ensure every placement has a
    // rotation field (older saves omitted it for unrotated pieces). No
    // structural change to placement entries beyond that.
    9: (data) => {
      for (const p of (data.placements || [])) {
        if (typeof p.rotation !== 'number') p.rotation = 0;
      }
      return data;
    },
    // 11 → 12: walls scaled 3× (back 9×5 → 27×15, right 5×5 → 15×15,
    // left 4×5 → 12×15). Cells are 3× finer. Mirrors what migration
    // 10 did to the floor. Saved wall placements scale c → c*3,
    // r → r*3 (and item footprints scale 3× independently in the
    // ITEMS catalog), so each item lands at the same physical
    // position on the new grid.
    12: (data) => {
      const SCALE = 3;
      for (const p of (data.placements || [])) {
        if (p.surface !== 'wall') continue;
        if (typeof p.slot !== 'string') continue;
        const m = p.slot.match(/^(back|left|right):(\d+),(\d+)$/);
        if (!m) continue;
        const panel = m[1];
        const c = parseInt(m[2], 10);
        const r = parseInt(m[3], 10);
        p.slot = panel + ':' + (c * SCALE) + ',' + (r * SCALE);
      }
      return data;
    },
    // 12 → 13: tabletop tiers scaled 3× per axis (deskUnit top
    // 4×2 → 12×6, floatingWallShelf top 3×1 → 9×3). Pure triple of the
    // trailing c,r — this was originally paired with 3×3 footprints,
    // but those got pulled in v14 (see below).
    13: (data) => {
      const SCALE = 3;
      for (const p of (data.placements || [])) {
        if (p.surface !== 'tabletop') continue;
        if (typeof p.slot !== 'string') continue;
        const m = p.slot.match(/^(host:.+):(\d+),(\d+)$/);
        if (!m) continue;
        const c = parseInt(m[2], 10);
        const r = parseInt(m[3], 10);
        p.slot = m[1] + ':' + (c * SCALE) + ',' + (r * SCALE);
      }
      return data;
    },
    // 13 → 14: tabletop footprints reverted to 1×1 (3×3 was reserving a
    // full quarter of the desk per item, killing valid snap targets).
    // For 1×1 items, the cell-center-preserving map is c → 3c+1 rather
    // than c → 3c. v13 already tripled, so v14 just adds +1 to c and r
    // to land on the cell center. Net effect for a save coming all the
    // way from v8: c → 3c+1, r → 3r+1, matching the §1 APPS slots.
    14: (data) => {
      for (const p of (data.placements || [])) {
        if (p.surface !== 'tabletop') continue;
        if (typeof p.slot !== 'string') continue;
        const m = p.slot.match(/^(host:.+):(\d+),(\d+)$/);
        if (!m) continue;
        const c = parseInt(m[2], 10);
        const r = parseInt(m[3], 10);
        p.slot = m[1] + ':' + (c + 1) + ',' + (r + 1);
      }
      return data;
    },
    // 10 → 11: back-wall grid went from 5×3 to 9×5 (kept cellW/cellH,
    // added 4 cols and 2 rows). The grid is centered, so adding 4 cols
    // shifts the centerline — old col c is at the same physical x as
    // new col c+2. Adding rows at the top doesn't shift r. Right and
    // left walls added rows only (cellW unchanged, cols unchanged),
    // so they need no migration.
    11: (data) => {
      for (const p of (data.placements || [])) {
        if (p.surface !== 'wall') continue;
        if (typeof p.slot !== 'string') continue;
        if (!p.slot.startsWith('back:')) continue;
        const m = p.slot.match(/^back:(\d+),(\d+)$/);
        if (!m) continue;
        const c = parseInt(m[1], 10);
        const r = parseInt(m[2], 10);
        p.slot = 'back:' + (c + 2) + ',' + r;
      }
      return data;
    },
    // 9 → 10: floor grid went from 7×5 to 21×15 (3× finer). Floor
    // placement coordinates and the floor-host references inside
    // tabletop slot keys both need to be scaled by 3 so existing
    // layouts land in the same physical positions on the new grid.
    // Wall slots and tabletop tier coords are NOT touched — wall
    // panels still use their original grid, and tier (c, r) inside a
    // host are tier-local cells unrelated to the floor.
    10: (data) => {
      const SCALE = 3;
      const placements = data.placements || [];
      for (const p of placements) {
        if (p.surface === 'floor' && typeof p.slot === 'string') {
          const [c, r] = p.slot.split(',').map(Number);
          if (Number.isFinite(c) && Number.isFinite(r)) {
            p.slot = `${c * SCALE},${r * SCALE}`;
          }
        } else if (p.surface === 'tabletop' && typeof p.slot === 'string'
                   && p.slot.startsWith('host:floor:')) {
          // Format: "host:floor:<c>,<r>:<hostItemId>:<tierId>:<tc>,<tr>"
          // (6 parts split on ':'). Scale ONLY the floor (c,r) part.
          // Static hosts ("host:static:desk:...") are untouched — they
          // don't go through floor coords.
          const parts = p.slot.split(':');
          if (parts.length === 6) {
            const [hc, hr] = parts[2].split(',').map(Number);
            if (Number.isFinite(hc) && Number.isFinite(hr)) {
              parts[2] = `${hc * SCALE},${hr * SCALE}`;
              p.slot = parts.join(':');
            }
          }
        }
      }
      return data;
    },
    // 14 → 15: introduce optional userScale on placements (drag-corner
    // resize). No structural rewrite — the field is just absent on
    // existing entries, which loadPlacements treats as scale=1.
    15: (data) => data,
  };
  function migrate(data) {
    // Pre-versioning saves wrote `{ v: 6, placements: [...] }` under a
    // bumped storage key (v8 was the latest). Treat any legacy file
    // without a schemaVersion as version 8 — that's the contract the
    // legacy key implied.
    let v = data.schemaVersion;
    if (typeof v !== 'number') v = 8;
    while (v < CURRENT_SCHEMA) {
      const next = v + 1;
      const fn = MIGRATIONS[next];
      if (fn) data = fn(data) || data;
      v = next;
    }
    data.schemaVersion = CURRENT_SCHEMA;
    return data;
  }

  function loadPlacements() {
    try {
      // Read the stable key first; fall back to legacy per-version keys
      // so users coming from v8 don't lose their layout on upgrade.
      let raw = localStorage.getItem(STORAGE_KEY);
      let importedFromLegacy = false;
      if (!raw) {
        for (const legacyKey of LEGACY_STORAGE_KEYS) {
          const r = localStorage.getItem(legacyKey);
          if (r) { raw = r; importedFromLegacy = true; break; }
        }
      }
      if (!raw) return false;
      let data = JSON.parse(raw);
      data = migrate(data);
      const list = data.placements || [];
      if (!list.length) {
        // Legacy file was empty/corrupted — write the migrated shape so
        // the new key is initialized and we stop reading the old one.
        if (importedFromLegacy) savePlacements();
        return false;
      }
      // Order matters: floor/wall placements MUST be restored before
      // tabletop placements, since tabletop slots are addressed by their
      // host piece's placementId. (Static hosts like the desk and shelf
      // are always available, so their tabletop items can load whenever.)
      const sorted = list.slice().sort((a, b) => {
        const aT = a.surface === 'tabletop' ? 1 : 0;
        const bT = b.surface === 'tabletop' ? 1 : 0;
        return aT - bT;
      });
      // Migrate old glb-prefixed item ids that were folded into the
      // natural names. Only entries pointing at items still in the
      // catalog are kept.
      const ITEM_ALIAS = { glbPiano: 'piano' };
      // Per-app item swaps — same surface, just a content upgrade.
      // The procedural posters (posterArt / posterSketch / posterAudit)
      // and the shared wallMap were swapped out for per-app framed
      // image paintings. Each app's saved placement on the old item
      // gets rewritten to its new one on load, so the slot stays put
      // and the painting just appears in place of the old graphic.
      const APP_ITEM_SWAPS = {
        'garden-tracker':     { from: 'posterArt',    to: 'gardenPainting' },
        'residency-tracker':  { from: 'posterArt',    to: 'residencyPainting' },
        'project-sketchbook': { from: 'posterSketch', to: 'sketchbookPainting' },
        'digest':             { from: 'posterArt',    to: 'digestPainting' },
        'media-tracker':      { from: 'wallMap',      to: 'mediaTrackerPainting' },
        'day-planner':        { from: 'posterAudit',  to: 'dayPlannerPainting' },
        'igstories-viewer':   { from: 'posterArt',    to: 'igstoriesPainting' },
        'library':            { from: 'posterSketch', to: 'libraryPainting' },
        'organize-cms':       { from: 'corkboard',    to: 'cmsPainting' },
        'follows-audit':      { from: 'posterAudit',  to: 'followsAuditPainting' },
        // 2026-05: whiteboard-tasks moved from corkboard panel → GLB
        // whiteboard planner. Rewrites the saved itemId at load so the
        // existing back:3,0 placement just swaps graphics in place.
        'whiteboard-tasks':   { from: 'corkboard',    to: 'glbWhiteboard' },
        // daily-journal swapped its wall calendar for an art-deco mirror,
        // same back:0,0 slot — rewrite the saved itemId so the mirror just
        // appears in place of the calendar.
        'daily-journal':      { from: 'calendar',     to: 'glbMirror' },
      };
      // Tabletop trinkets that were sitting on the (now-removed) static
      // desk need their host key rewritten to point at the new dynamic
      // desk — but the dynamic desk doesn't exist yet during load
      // (ensureDecorations seeds it after). Defer those here and the
      // post-decoration replay inside ensureDecorations finishes the job.
      const deferredStaticDeskTrinkets = [];
      for (const p of sorted) {
        // Catalog-trim catch-all: drop any saved placement whose item
        // is no longer in the ITEMS catalog. The catalog was reduced
        // to just the items used by APPS and DECORATIONS, so anything
        // else in saved data (tv, nightstand, coffeeTable, fileBoxes,
        // posters that got renamed, etc.) needs to be shed. ITEMS is
        // the source of truth — placePersisted would silently fail
        // for unknown itemIds anyway; dropping here is just cleaner.
        if (p.itemId && !ITEMS[p.itemId] && !ITEM_ALIAS[p.itemId]) continue;
        // Kitchen swapped from a desk toast (tabletop) to a framed
        // still-life painting (wall). Surface change — drop the
        // stored placement so updateProjects re-places kitchen at the
        // new wall slot.
        if (p.appId === 'kitchen' && p.itemId === 'glbToast' && p.surface === 'tabletop') continue;
        // Atlas swapped from a floor globe to a wall map. The surface is
        // different so we can't just rename the item — drop the stored
        // placement and let updateProjects → placeAppItemAuto put atlas at
        // the new APPS default (back:1,2 wall).
        if (p.appId === 'atlas' && p.itemId === 'globe') continue;
        // media-tracker moved off the wall (mediaTrackerPainting / older
        // wallMap) to a floor TV cabinet. Surface change wall→floor —
        // drop the stale wall placement so the auto-placer seeds
        // glbTvCabinet at the new floor:4,0 slot.
        if (p.appId === 'media-tracker' && p.surface === 'wall'
            && (p.itemId === 'mediaTrackerPainting' || p.itemId === 'wallMap')) continue;
        // garden-tracker moved off the back wall (gardenPainting /
        // older posterArt) to a floor-standing snake plant. Surface
        // change wall→floor — drop the stale wall placement so the
        // auto-placer seeds glbSnakePlant2 at the new floor:16,0 slot.
        if (p.appId === 'garden-tracker' && p.surface === 'wall'
            && (p.itemId === 'gardenPainting' || p.itemId === 'posterArt')) continue;
        // library moved off the back wall (libraryPainting / older
        // posterSketch) to a floor filing cabinet, then again from
        // floor:0,0 (back-left corner, partially clipped by the
        // camera) to floor:8,0 (visible in the gap between the TV
        // cabinet and desk). Drop both the stale wall placement AND
        // any old floor:0,0 placement so the auto-placer seeds the
        // current GLB at the new slot.
        if (p.appId === 'library' && p.surface === 'wall'
            && (p.itemId === 'libraryPainting' || p.itemId === 'posterSketch')) continue;
        if (p.appId === 'library' && p.surface === 'floor'
            && p.itemId === 'glbFilingCabinet' && p.slot === '0,0') continue;
        // Email whiteboard apps moved from wall whiteboards to desk inbox
        // trays — surface change wall→tabletop, same drop-and-replace.
        if ((p.appId === 'email-whiteboard-app' || p.appId === 'email-whiteboard-v2')
            && p.itemId === 'whiteboard') continue;
        // job-search moved from floor filing cabinet to desk laptop —
        // surface change floor→tabletop, drop-and-replace.
        if (p.appId === 'job-search' && p.itemId === 'filingCab') continue;
        // font-manager moved from floor primitive typewriter (or its
        // intermediate glbTypewriter floor placement) to a desk
        // tabletop typewriter — surface change, drop-and-replace.
        if (p.appId === 'font-manager'
            && (p.itemId === 'typewriter' || (p.itemId === 'glbTypewriter' && p.surface === 'floor'))) continue;
        // sheet-music-tracker moved from the small tabletop `piano`
        // trinket on the desk to a floor-standing `glbElectricPiano`
        // tucked under the right-wall window. Surface change
        // tabletop→floor — drop so the auto-placer seeds it at the new
        // floor:17,5 slot from APPS.
        if (p.appId === 'sheet-music-tracker' && p.itemId === 'piano' && p.surface === 'tabletop') continue;
        // residency-tracker ("Studio") moved from a back-wall framed
        // painting to a small desk-top `glbPintura` painting. Surface
        // change wall→tabletop — drop so the auto-placer seeds it at the
        // new host:floor:9,0:deskUnit:top:1,1 slot from APPS.
        if (p.appId === 'residency-tracker' && p.itemId === 'residencyPainting' && p.surface === 'wall') continue;
        // font-manager moved from the desk typewriter to a wall poster
        // (Helvetica documentary). Surface change tabletop→wall — drop
        // so the auto-placer seeds fontManagerPainting at back:3,6.
        if (p.appId === 'font-manager' && p.itemId === 'glbTypewriter' && p.surface === 'tabletop') continue;
        // kitchen moved from a back-wall painting to a desk-top mug.
        // Surface change wall→tabletop — drop so the auto-placer seeds
        // glbMug at host:floor:9,0:deskUnit:top:4,4.
        if (p.appId === 'kitchen' && p.itemId === 'kitchenPainting' && p.surface === 'wall') continue;
        // (Removed: a one-time migration used to drop atlas/wallMap and
        // events-digest/calendar wall placements when the big back-wall
        // window was introduced, so updateProjects could re-seed them at
        // their new APPS slots. But those rules matched the apps' CURRENT
        // item+surface regardless of slot, so they kept firing on every
        // load — discarding any user move and snapping atlas/events-digest
        // back to the APPS default each launch. The relocation has long
        // since settled, so the rules now only break retention. Removed,
        // same reasoning as the defensive wall-slot check noted below.)
        // Corner-shot layout: 8 launchers that used to be floor furniture
        // are now wall posters on back+right walls. Drop their stored
        // floor placements so updateProjects re-places them at the new
        // wall slots from APPS.
        if (p.appId === 'garden-tracker'    && p.itemId === 'potPlant'    && p.surface === 'floor') continue;
        if (p.appId === 'daily-journal'     && p.itemId === 'nightstand'  && p.surface === 'floor') continue;
        if (p.appId === 'library'           && p.itemId === 'tallShelf'   && p.surface === 'floor') continue;
        if (p.appId === 'organize-cms'      && p.itemId === 'fileBoxes'   && p.surface === 'floor') continue;
        if (p.appId === 'media-tracker'     && p.itemId === 'tv'          && p.surface === 'floor') continue;
        if (p.appId === 'digest'            && p.itemId === 'coffeeTable' && p.surface === 'floor') continue;
        if (p.appId === 'day-planner'       && p.itemId === 'deskPlanner' && p.surface === 'floor') continue;
        if (p.appId === 'igstories-viewer'  && p.itemId === 'phoneTripod' && p.surface === 'floor') continue;
        // Same layout shift, but for the left-wall launchers that moved
        // to back+right walls. Wall-to-wall, surface unchanged; drop so
        // they land at the new APPS slot rather than their old left:* slot.
        if (p.appId === 'residency-tracker' && p.itemId === 'posterArt'   && p.surface === 'wall'
            && typeof p.slot === 'string' && p.slot.startsWith('left:')) continue;
        if (p.appId === 'project-sketchbook'&& p.itemId === 'posterSketch'&& p.surface === 'wall'
            && typeof p.slot === 'string' && p.slot.startsWith('left:')) continue;
        if (p.appId === 'whiteboard-tasks'  && p.itemId === 'corkboard'   && p.surface === 'wall'
            && typeof p.slot === 'string' && p.slot.startsWith('left:')) continue;
        if (p.appId === 'follows-audit'     && p.itemId === 'posterAudit' && p.surface === 'wall'
            && typeof p.slot === 'string' && p.slot.startsWith('left:')) continue;
        // (Removed 2026-05: a defensive "drop any wall app placement
        // whose slot doesn't match APPS" check used to live here. It
        // was meant for legacy grid refactors but it also nuked
        // legitimate user moves on reload — i.e. if you dragged a wall
        // launcher to a new slot, the save persisted but the next load
        // dropped it and re-seeded at the APPS default. Active grid
        // changes are now handled by explicit per-item drop rules
        // above plus the schema migrations.)
        // Drop any stale glbWindow placement. No APP currently uses
        // glbWindow as a launcher; if it's in the saved data it's
        // probably left over from a manual catalog placement on an
        // earlier wall grid, and after migration the wall-cut hole
        // ends up in the wrong place, exposing the sky-backdrop and
        // making other wall items look translucent.
        if (p.itemId === 'glbWindow') continue;
        // Head-on camera consolidation: side walls (left/right) are
        // out of frame at the current camera angle. Drop any wall
        // placement on those panels so the layout collapses to the
        // back wall cleanly. App-bound items get re-auto-placed at
        // their new back-wall APPS slots; decorations (like the old
        // floatingWallShelf at right:0,0) get re-seeded via the
        // bumped DECORATIONS_SEEDED_KEY.
        if (p.surface === 'wall' && typeof p.slot === 'string'
            && (p.slot.startsWith('right:') || p.slot.startsWith('left:'))) continue;
        // Defer: stored static:desk slot keys can't resolve until the
        // dynamic deskUnit is seeded.
        if (p.surface === 'tabletop' && typeof p.slot === 'string'
            && p.slot.startsWith('host:static:desk:')) {
          deferredStaticDeskTrinkets.push(p);
          continue;
        }
        let itemId = ITEM_ALIAS[p.itemId] || p.itemId;
        const swap = p.appId && APP_ITEM_SWAPS[p.appId];
        if (swap && itemId === swap.from) itemId = swap.to;
        placePersisted(itemId, p.surface, p.slot, {
          appId: p.appId || undefined,
          rotation: p.rotation || 0,
          userScale: p.userScale,
        });
      }
      // Stash for ensureDecorations to replay once the dynamic desk exists.
      if (deferredStaticDeskTrinkets.length) {
        state._deferredStaticDeskTrinkets = deferredStaticDeskTrinkets;
      }
      // Promote the migrated data to the new stable key so subsequent
      // loads skip the legacy lookup. We don't delete the old key — one
      // release cycle of overlap is cheap insurance if a migration is
      // wrong and we need to roll back.
      if (importedFromLegacy) savePlacements();
      return true;
    } catch (e) {
      // A corrupt/unparseable layout would otherwise be silently discarded
      // and immediately overwritten by autoPlaceAllApps() — the user loses
      // their whole arrangement with no signal. Preserve the raw value under
      // a `.corrupt` key so it's recoverable, and surface the failure.
      console.warn('[diorama] failed to load saved layout — falling back to auto-placement:', e);
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) localStorage.setItem(STORAGE_KEY + '.corrupt', raw);
      } catch (_) { /* localStorage unavailable — nothing more we can do */ }
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // §16 · Resize / animation / public API
  // ══════════════════════════════════════════════════════════════════
  function onResize() {
    if (!container || !renderer) return;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    applyResponsiveFov();   // re-derives camera.fov from baseFov + aspect, then updates the matrix
  }

  // Derives the live vertical FOV from baseFov so the whole back-wall
  // gallery stays framed at any window aspect ("fit: contain"). When the
  // canvas is wider than DESIGN_ASPECT the view is height-limited and we
  // keep baseFov exactly (telephoto preserved). When it's narrower, a
  // fixed vertical FOV would crop the gallery's outer columns, so we widen
  // the FOV by the aspect shortfall (zoom out) — revealing a little more
  // floor / ceiling instead of losing launchers. Clamped at MAX_FOV so an
  // ultra-narrow window doesn't shrink the room to nothing.
  function applyResponsiveFov() {
    if (!camera) return;
    const widen = Math.max(1, DESIGN_ASPECT / camera.aspect);
    const halfRad = Math.atan(Math.tan(baseFov * Math.PI / 360) * widen);
    camera.fov = Math.min(MAX_FOV, halfRad * 360 / Math.PI);
    camera.updateProjectionMatrix();
  }

  // ── §16 · animation ──────────────────────────────────────────────
  let _clock = null;
  function startAnimation() {
    // Idempotent: if the loop is already running (or we're resuming after
    // hide() paused it) don't stack a second rAF chain.
    if (animFrame != null) return;
    if (!_clock) _clock = new THREE.Clock();
    else _clock.getDelta();  // discard the gap accumulated while paused so
                             // the first frame after resume isn't a huge dt
    function loop() {
      // Pull deltaT first; .elapsedTime then reflects the same updated
      // clock state without double-advancing it.
      const dt = _clock.getDelta();
      const t = _clock.elapsedTime;
      // (Sims-style placement: no pulse on un-hovered markers — they
      // stay invisible against the persistent floor grid. The hover
      // marker's opacity is driven directly by the pointermove handler.
      // The pulse loop that used to live here is gone with the
      // "sea of slots" visualization that needed it.)
      // (Per-placement hover lift + click bounce both removed — pieces
      // stay at their resting pose. The held piece below is the only
      // placement-area mesh that animates per frame.)
      // Held piece sits on top of the per-placement loop (its mesh has
      // been removed from state.placements). Apply the bob + tilt here so
      // the visuals stay frame-rate-independent.
      updateHeldAnimation(t, dt);
      updateParallax(dt);
      // Ease the object glow in/out (runs while a glow is settling, even
      // after the link itself cleared, so the fade-out completes).
      updateGlow(dt);
      // The linked object drifts with camera parallax, so re-aim the
      // connector line every frame while a link is active.
      if (state.linkedAppId) updateConnector();
      // Likewise keep the mirror reflection aligned as the mirror drifts
      // with parallax, even when the cursor is holding still over the glass.
      if (mirrorClipEl && mirrorClipEl.classList.contains('show') && _lastCursorPx) {
        updateMirrorReflection(_lastCursorPx.x, _lastCursorPx.y);
      }
      // Refresh shadow maps only when geometry actually moved this frame:
      // a discrete edit (markShadowsDirty), the blinds mid-tween, or a piece
      // being dragged. Otherwise the static maps from the last refresh stand.
      const blindsMoving = _blinds &&
        Math.abs(_blinds.targetProgress - _blinds.currentProgress) > 0.0015;
      if (shadowsDirty || shadowRefreshFrames > 0 || blindsMoving || state.heldPiece) {
        renderer.shadowMap.needsUpdate = true;
        shadowsDirty = false;
        if (shadowRefreshFrames > 0) shadowRefreshFrames--;
      }
      if (_skyUpdate) _skyUpdate(dt);
      // Smoothly tween each shade slat between its closedY and openY.
      // Rate=5 gives a soft ~700ms raise/lower — quick enough to feel
      // responsive, slow enough to read as fabric in motion. Same
      // progress value also drives the window directional light's
      // intensity so closing the shades visibly dims the sun streak.
      if (_blinds) {
        const k = 1 - Math.exp(-5 * dt);
        _blinds.currentProgress += (_blinds.targetProgress - _blinds.currentProgress) * k;
        const p = _blinds.currentProgress;
        for (const s of _blinds.slats) {
          s.position.y = s.userData.openY + (s.userData.closedY - s.userData.openY) * p;
        }
        // Couple the room lighting to the shade position:
        //   winLight (sun streak): full base at p=0 (open), 6% at p=1
        //   ambient (overall room): full base at p=0, 55% at p=1
        // The lerp on progress (above) already eases this, so no
        // separate easing needed here. ambient drops less aggressively
        // than winLight — losing the sun streak is the main effect; the
        // ambient sag is a subtle reinforcement.
        if (_lights.winLight) {
          const winFactor = 1 - p * (1 - _blinds.winLightDimAtClosed);
          _lights.winLight.intensity = _blinds.winLightBase * winFactor;
        }
        if (_lights.ambient) {
          const ambFactor = 1 - p * (1 - _blinds.ambientDimAtClosed);
          _lights.ambient.intensity = _blinds.ambientBase * ambFactor;
        }
      }
      renderer.render(scene, camera);
      animFrame = requestAnimationFrame(loop);
    }
    loop();
  }

  // Eases the camera toward the cursor's last NDC by a small fraction of
  // PARALLAX_RANGE_*, then re-aims at the fixed base target so the focal
  // point stays locked. Frozen while a piece is held — dragging shouldn't
  // shift the snap targets under the cursor.
  function updateParallax(dt) {
    if (!camera || !_parallaxBasePos) return;
    const k = 1 - Math.exp(-PARALLAX_LERP_RATE * dt);
    _parallaxX += (_parallaxTargetX - _parallaxX) * k;
    _parallaxY += (_parallaxTargetY - _parallaxY) * k;
    camera.position.set(
      _parallaxBasePos.x + _parallaxX * PARALLAX_RANGE_X,
      _parallaxBasePos.y + _parallaxY * PARALLAX_RANGE_Y,
      _parallaxBasePos.z
    );
    camera.lookAt(_parallaxBaseTarget);
  }

  // Layers a small bob + held-tilt on top of the cursor-driven position
  // set in onPointerMove. Floor pieces tilt; wall/tabletop stay upright
  // because their orientation is constrained by the host surface.
  function updateHeldAnimation(t, dt) {
    const h = state.heldPiece;
    if (!h || !h.mesh) return;
    // X/Z are written directly in onPointerMove (no lerp — felt laggy
    // on the fine grid). Only Y is computed per frame so the bob stays
    // frame-rate-independent.
    const bob = (h.def.surface === 'wall') ? 0 : Math.sin(t * 4.2) * 0.018;
    h.mesh.position.y = h.targetY + bob;
    if (h.def.surface === 'floor') {
      h.mesh.rotation.x = HELD_TILT_X;
      h.mesh.rotation.z = HELD_TILT_Z;
      // y-rotation is the user-controlled facing (rotateHeld writes it).
    }
  }

  // ── §16 · public API ─────────────────────────────────────────────
  function init(opts) {
    if (initialized) {
      if (opts && opts.projects) updateProjects(opts.projects);
      return;
    }
    if (!opts || !opts.container) {
      console.error('MiseDiorama.init: container is required');
      return;
    }
    if (typeof THREE === 'undefined') {
      console.error('MiseDiorama.init: THREE is not loaded');
      return;
    }
    container = opts.container;
    projects = (opts.projects || []).slice();
    onOpenProjectCb = opts.onOpenProject || null;
    onLaunchStartCb = opts.onLaunchStart || null;
    onPieceContextMenuCb = opts.onPieceContextMenu || null;

    try {
      setupScene();
    } catch (err) {
      // WebGL unavailable / blocklisted / context-creation failure. Don't
      // leave a blank stage with no explanation — show a plain-DOM message
      // and bail cleanly so isReady() honestly stays false.
      console.error('MiseDiorama.init: WebGL setup failed', err);
      container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;' +
        'height:100%;color:#888;font:14px system-ui;text-align:center;padding:24px">' +
        '3D home view unavailable (WebGL could not start on this machine).</div>';
      return;
    }
    setupRoom();
    ITEMS = buildItems();
    setupUI();
    // Kick off the mirror's reflection env map (async; retrofits onto the
    // glass once both the HDRI and the placed mirror are ready).
    loadMirrorEnv();

    // Start rendering immediately so the room shell (floor, walls, sky)
    // is visible while GLBs warm up. Placement is deferred into the
    // preloadGlbs callback so items snap in all at once — no placeholder
    // boxes ever appear.
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(container);
    }
    startAnimation();
    requestAnimationFrame(() => requestAnimationFrame(onResize));

    preloadGlbs(() => {
      const loaded = loadPlacements();
      // Hydrate the persistent deletion log + refresh the restore-button
      // visibility so the "Restore (N)" pill shows immediately if there
      // were prior-session deletions waiting to be brought back.
      loadDeletedHistory();
      updateRestoreUI();
      // ensureDecorations seeds the movable desk + shelf if they're absent
      // (and replays any deferred static:desk trinkets onto the new desk).
      // It MUST run before autoPlaceAllApps because most desk-bound apps
      // reference the desk's placementId in their preferred slot — without
      // the desk in place, those preferred slots wouldn't resolve.
      ensureDecorations();
      if (!loaded) {
        autoPlaceAllApps();
        savePlacements();
      }
      // Cut window holes for any wall items already in state — savePlacements
      // does this on every change, but reloading with no state-changing
      // events would otherwise leave the walls solid until the first edit.
      rebuildWallGeometry();

      initialized = true;
      // Reconcile against the project list so any app missing from the saved
      // layout (e.g. dropped by a migration in loadPlacements, or freshly added
      // to projects.json since the layout was saved) gets auto-placed at its
      // APPS-default slot. Without this, a migration that drops a stored
      // placement leaves the app invisible until the next ensureRoomInit
      // re-feed from renderer.js — which only happens on later view switches.
      updateProjects(projects);
      // Populate the side app list now that every launcher is placed.
      rebuildAppList();
      // The mirror is now placed — apply the reflection env map (no-op if
      // the HDRI is still loading; loadMirrorEnv's callback retries).
      applyMirrorEnv();
    });
  }

  function updateProjects(newProjects) {
    projects = (newProjects || []).slice();
    if (!initialized) return;
    // CRITICAL: do NOT clobber the user's layout here. updateProjects fires
    // every time renderer.js refreshes the project list — including when the
    // user just navigates back to home from an app. Wiping placements would
    // throw away every customization they've made.
    //
    // Reconcile minimally:
    //   • Add: any new app in the project list that isn't placed yet → auto-place.
    //   • Remove: any placement whose appId no longer exists in the project list.
    //   • Keep everything else untouched.
    const validAppIds = new Set(projects.map(p => p.id));
    const placedAppIds = new Set();
    // Drop placements for apps that no longer exist (renamed, deleted, etc.)
    for (const p of [...state.placements]) {
      if (p.appId && !validAppIds.has(p.appId)) {
        // If this piece is also a tabletop host, cascade-remove its
        // children so we don't leave orphan tabletop entries behind.
        if (SURFACES.tabletop && SURFACES.tabletop.hosts.has(p.placementId)) {
          const removedTabletopIds = SURFACES.tabletop.unregisterHost(p.placementId);
          for (const tid of removedTabletopIds) {
            const tIdx = state.placements.findIndex(x => x.placementId === tid);
            if (tIdx >= 0) state.placements.splice(tIdx, 1);
          }
        }
        SURFACES[p.surface].remove(p.placementId);
        const idx = state.placements.indexOf(p);
        if (idx >= 0) state.placements.splice(idx, 1);
      } else if (p.appId) {
        placedAppIds.add(p.appId);
      }
    }
    // Auto-place any new apps the user hasn't seen yet
    let added = 0;
    for (const project of projects) {
      if (!APP_TO_ITEM[project.id]) continue;
      if (placedAppIds.has(project.id)) continue;
      if (placeAppItemAuto(project)) added++;
    }
    if (added > 0) savePlacements();
    // Reflect any added/removed apps in the side list.
    rebuildAppList();
  }

  function show() {
    if (!container) return;
    container.style.display = '';
    container.removeAttribute('hidden');
    // The list + connector are siblings of the frame, so reveal them with
    // it (hide() collapses them during the embedded-app view).
    if (connectorSvgEl) connectorSvgEl.style.display = '';
    rebuildAppList();   // restores appListEl's display when rows exist
    // Resume the render loop, which hide() paused while the diorama was
    // covered by a launched app's WebContentsView. Re-render the shadow
    // maps once on the resume frame in case anything changed while hidden.
    if (renderer) renderer.shadowMap.needsUpdate = true;
    startAnimation();
    requestAnimationFrame(() => requestAnimationFrame(onResize));
  }
  function hide() {
    // Actually hide the room container during launch transitions. Without
    // this, there's a 50–1000ms window between Launch click and the
    // WebContentsView mounting where the room canvas is still visible on
    // the left while .hint (now stripped of its `roomMode` rail layout)
    // expands to flex:1 on the right — producing a brief "split screen"
    // flash of the empty rail next to the room. Hiding the container
    // collapses the layout so .hint takes the full width as a blank stage,
    // which the WebContentsView then covers seamlessly.
    if (!container) return;
    // Clean up any in-flight drag so the next show() doesn't reveal a
    // ghost piece floating in the scene.
    if (state.heldPiece) cancelHeld();
    if (state.dragCandidate) state.dragCandidate = null;
    // Clear any active link so the next show() doesn't reopen with a stale
    // glow/connector left over from before the launch transition.
    setLinkedApp(null);
    // Collapse the left list column + connector too — otherwise they'd keep
    // taking layout/space beside the embedded app's WebContentsView.
    if (appListEl) appListEl.style.display = 'none';
    if (connectorSvgEl) connectorSvgEl.style.display = 'none';
    hideMirrorReflection();
    container.setAttribute('hidden', '');
    // Pause the render loop: while hidden the diorama is fully covered by
    // the launched app's WebContentsView (often for a long time), so there
    // is no point drawing a 3-shadow-map scene at 60fps that nobody sees.
    // show() calls startAnimation() again to resume.
    if (animFrame != null) { cancelAnimationFrame(animFrame); animFrame = null; }
  }
  function isReady() { return initialized; }
  function endLaunchTransition() { /* stub for renderer.js compatibility */ }
  function refreshModels() {
    // Snapshot the current roots and clear the cache, then reload. The old
    // roots are disposed per-path inside preloadGlbs once their in-scene
    // clones have been swapped to the freshly-loaded geometry — disposing
    // here (before the swap) would corrupt clones that share the old
    // geometry during the async reload window.
    const oldCache = {};
    for (const k of Object.keys(GLB_CACHE)) { oldCache[k] = GLB_CACHE[k]; delete GLB_CACHE[k]; }
    preloadGlbs(null, oldCache);
  }

  // ══════════════════════════════════════════════════════════════════
  // §17 · Camera debug mode — interactive tool for tuning the view
  // ══════════════════════════════════════════════════════════════════
  //
  // Press `C` while the diorama is running to enter free-camera mode.
  // The HUD overlay (top-right of the canvas) shows live camera values
  // and exposes Copy / Reset / Done buttons. The Copy snippet is
  // paste-ready into setupScene() to make the view permanent.
  //
  // Controls:
  //   drag           orbit camera around the current target
  //   scroll         zoom in/out (camera-to-target distance)
  //   arrows         pan target left/right/up/down in the floor plane
  //                  (Up = away from camera, Down = toward camera)
  //   PageUp/Down    raise / lower target
  //   [  ]           decrease / increase FOV
  //   Esc or C       exit debug mode
  //
  // Implementation notes:
  //   • Existing pointermove/down/up handlers early-return when
  //     `cameraDebug.enabled` is true so they don't fight the orbit
  //     controls. Same for the keydown handler.
  //   • The wheel listener is attached unconditionally but only acts
  //     while debug is on.
  //   • State changes are ephemeral. To persist, paste the Copy snippet
  //     into the `camera = new THREE.PerspectiveCamera(...)` block in
  //     setupScene().
  function toggleCameraDebug() {
    if (cameraDebug.enabled) exitCameraDebug();
    else enterCameraDebug();
  }
  function enterCameraDebug() {
    cameraDebug.enabled = true;
    if (!cameraDebug.defaults) {
      cameraDebug.defaults = {
        position: camera.position.clone(),
        target: _parallaxBaseTarget.clone(),
        fov: baseFov,
      };
    }
    ensureCameraDebugHUD();
    cameraDebug.hudEl.style.display = 'block';
    updateCameraDebugHUD();
    canvas.style.cursor = 'grab';
  }
  function exitCameraDebug() {
    cameraDebug.enabled = false;
    if (cameraDebug.hudEl) cameraDebug.hudEl.style.display = 'none';
    cameraDebug.dragLast = null;
    canvas.style.cursor = 'default';
  }
  function ensureCameraDebugHUD() {
    if (cameraDebug.hudEl) return;
    // Inline styles keep the HUD self-contained — no dependency on the
    // existing dior-* style block, so deleting this section in the
    // future is a clean removal.
    const style = document.createElement('style');
    style.textContent = `
      .dior-camdebug {
        position: absolute; top: 12px; right: 12px;
        background: rgba(20, 16, 12, 0.88); color: #f3df9f;
        font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
        padding: 12px 14px; border-radius: 8px; z-index: 1000;
        min-width: 220px; box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        user-select: none; pointer-events: auto;
      }
      .dior-camdebug .cd-row {
        display: flex; justify-content: space-between; gap: 12px;
      }
      .dior-camdebug .cd-row b { color: #fff; }
      .dior-camdebug kbd {
        font: inherit; background: rgba(255,255,255,0.12);
        padding: 0 5px; border-radius: 3px; font-size: 11px;
      }
      .dior-camdebug .cd-val { color: #fff; }
      .dior-camdebug .cd-hint {
        margin-top: 8px; font-size: 11px; opacity: 0.7; line-height: 1.55;
      }
      .dior-camdebug .cd-btns {
        display: flex; gap: 6px; margin-top: 10px;
      }
      .dior-camdebug button {
        flex: 1; font: inherit; padding: 5px 8px; cursor: pointer;
        background: #3a2f24; color: #f3df9f;
        border: 1px solid #5a4a3a; border-radius: 4px;
      }
      .dior-camdebug button:hover { background: #5a4a3a; }
      .dior-camdebug .cd-status {
        margin-top: 8px; font-size: 11px; color: #b8d6e5; min-height: 14px;
      }
    `;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.className = 'dior-camdebug';
    el.innerHTML = `
      <div class="cd-row"><b>Camera debug</b> <kbd>C</kbd> to close</div>
      <div class="cd-row">pos <span class="cd-val" data-pos></span></div>
      <div class="cd-row">target <span class="cd-val" data-target></span></div>
      <div class="cd-row">fov <span class="cd-val" data-fov></span></div>
      <div class="cd-hint">
        drag = orbit · scroll = zoom<br>
        arrows = pan target · PgUp/PgDn = raise/lower<br>
        <kbd>[</kbd> <kbd>]</kbd> = FOV
      </div>
      <div class="cd-btns">
        <button data-act="copy">Copy</button>
        <button data-act="reset">Reset</button>
        <button data-act="done">Done</button>
      </div>
      <div class="cd-status" data-status></div>
    `;
    // Stop pointer events on the HUD itself from reaching the canvas.
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation());

    container.appendChild(el);
    cameraDebug.hudEl = el;

    el.querySelector('[data-act="copy"]').addEventListener('click', () => {
      const snippet = formatCameraSnippet();
      const setOK = () => setCameraDebugStatus('Copied — paste into setupScene()');
      const setErr = () => setCameraDebugStatus('Copy failed; check console');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(snippet).then(setOK).catch(() => {
          console.log('[cameraDebug] snippet:\n' + snippet);
          setErr();
        });
      } else {
        console.log('[cameraDebug] snippet:\n' + snippet);
        setCameraDebugStatus('Clipboard unavailable — see console');
      }
    });
    el.querySelector('[data-act="reset"]').addEventListener('click', () => {
      if (!cameraDebug.defaults) return;
      camera.position.copy(cameraDebug.defaults.position);
      _parallaxBaseTarget.copy(cameraDebug.defaults.target);
      baseFov = cameraDebug.defaults.fov;
      applyResponsiveFov();
      camera.lookAt(_parallaxBaseTarget);
      _parallaxBasePos = camera.position.clone();
      updateCameraDebugHUD();
      setCameraDebugStatus('Reset to start values');
    });
    el.querySelector('[data-act="done"]').addEventListener('click', exitCameraDebug);
  }
  function setCameraDebugStatus(text) {
    if (!cameraDebug.hudEl) return;
    const s = cameraDebug.hudEl.querySelector('[data-status]');
    s.textContent = text;
    setTimeout(() => { if (s && s.textContent === text) s.textContent = ''; }, 2500);
  }
  function formatCameraSnippet() {
    const p = camera.position;
    const t = _parallaxBaseTarget;
    return (
      'camera = new THREE.PerspectiveCamera(' + baseFov.toFixed(1) + ', 1, 0.1, 60);  // = BASE_FOV\n' +
      'camera.position.set(' + p.x.toFixed(2) + ', ' + p.y.toFixed(2) + ', ' + p.z.toFixed(2) + ');\n' +
      'camera.lookAt(' + t.x.toFixed(2) + ', ' + t.y.toFixed(2) + ', ' + t.z.toFixed(2) + ');\n' +
      '_parallaxBaseTarget = new THREE.Vector3(' + t.x.toFixed(2) + ', ' + t.y.toFixed(2) + ', ' + t.z.toFixed(2) + ');\n'
    );
  }
  function updateCameraDebugHUD() {
    if (!cameraDebug.hudEl) return;
    const fmt = (v) => v.toFixed(2);
    const p = camera.position;
    const t = _parallaxBaseTarget;
    cameraDebug.hudEl.querySelector('[data-pos]').textContent =
      fmt(p.x) + ', ' + fmt(p.y) + ', ' + fmt(p.z);
    cameraDebug.hudEl.querySelector('[data-target]').textContent =
      fmt(t.x) + ', ' + fmt(t.y) + ', ' + fmt(t.z);
    cameraDebug.hudEl.querySelector('[data-fov]').textContent =
      baseFov.toFixed(1) + '°';
  }
  function cameraDebugOrbit(dx, dy) {
    const t = _parallaxBaseTarget;
    const offset = camera.position.clone().sub(t);
    const r = offset.length();
    if (r < 1e-3) return;
    let theta = Math.atan2(offset.x, offset.z);
    let phi = Math.asin(Math.max(-1, Math.min(1, offset.y / r)));
    const SPEED = 0.005;
    theta -= dx * SPEED;
    phi += dy * SPEED;
    // Clamp phi to avoid flipping at the poles.
    const EPS = 0.05;
    phi = Math.max(-Math.PI / 2 + EPS, Math.min(Math.PI / 2 - EPS, phi));
    const cphi = Math.cos(phi);
    offset.set(r * cphi * Math.sin(theta), r * Math.sin(phi), r * cphi * Math.cos(theta));
    camera.position.copy(t).add(offset);
    camera.lookAt(t);
    _parallaxBasePos = camera.position.clone();
    updateCameraDebugHUD();
  }
  function cameraDebugZoom(deltaY) {
    const t = _parallaxBaseTarget;
    const offset = camera.position.clone().sub(t);
    const r = offset.length();
    if (r < 1e-3) return;
    // deltaY > 0 (wheel down) = zoom out; deltaY < 0 = zoom in.
    const SPEED = 0.0015;
    const newR = Math.max(0.5, Math.min(40, r * (1 + deltaY * SPEED)));
    offset.normalize().multiplyScalar(newR);
    camera.position.copy(t).add(offset);
    camera.lookAt(t);
    _parallaxBasePos = camera.position.clone();
    updateCameraDebugHUD();
  }
  function cameraDebugPanTarget(dx, dy, dz) {
    _parallaxBaseTarget.x += dx;
    _parallaxBaseTarget.y += dy;
    _parallaxBaseTarget.z += dz;
    camera.lookAt(_parallaxBaseTarget);
    updateCameraDebugHUD();
  }
  function cameraDebugAdjustFov(delta) {
    baseFov = Math.max(10, Math.min(120, baseFov + delta));
    applyResponsiveFov();
    updateCameraDebugHUD();
  }

  // ══════════════════════════════════════════════════════════════════
  // §19 · Lighting / material live debugger
  // ══════════════════════════════════════════════════════════════════
  // Toggle with `L`. Live sliders for every light, HDRI, SSAO, fog,
  // camera, sky, and scene-level knobs. Reset restores values from
  // first entry. Copy puts a paste-ready snippet on the clipboard.

  function toggleLightingDebug() {
    if (lightingDebug.enabled) exitLightingDebug();
    else enterLightingDebug();
  }
  function enterLightingDebug() {
    lightingDebug.enabled = true;
    if (!lightingDebug.defaults) lightingDebug.defaults = snapshotLightingState();
    ensureLightingDebugHUD();
    lightingDebug.hudEl.style.display = 'block';
    syncLightingDebugHUDFromState();
  }
  function exitLightingDebug() {
    lightingDebug.enabled = false;
    if (lightingDebug.hudEl) lightingDebug.hudEl.style.display = 'none';
  }
  function getLightAngles(light) {
    if (!light || !light.target) return { yaw: 0, pitch: 0 };
    const dir = new THREE.Vector3().subVectors(light.target.position, light.position);
    if (dir.lengthSq() < 1e-8) return { yaw: 0, pitch: 0 };
    dir.normalize();
    return {
      pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI,
      yaw:   Math.atan2(dir.x, dir.z) * 180 / Math.PI,
    };
  }
  function setLightAngles(light, yawDeg, pitchDeg) {
    if (!light || !light.target) return;
    const yaw = yawDeg * Math.PI / 180;
    const pitch = pitchDeg * Math.PI / 180;
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw)
    );
    light.target.position.copy(light.position).add(dir);
    light.target.updateMatrixWorld();
  }
  function applyLightAngle(light, helper, prop, val) {
    if (!light) return;
    const cur = getLightAngles(light);
    const yaw   = prop === 'yaw'   ? val : cur.yaw;
    const pitch = prop === 'pitch' ? val : cur.pitch;
    setLightAngles(light, yaw, pitch);
    if (helper) helper.update();
  }
  const TONE_MAPS = [
    { label: 'None',     name: 'NoToneMapping',         value: THREE.NoToneMapping },
    { label: 'Linear',   name: 'LinearToneMapping',     value: THREE.LinearToneMapping },
    { label: 'Reinhard', name: 'ReinhardToneMapping',   value: THREE.ReinhardToneMapping },
    { label: 'Cineon',   name: 'CineonToneMapping',     value: THREE.CineonToneMapping },
    { label: 'ACES',     name: 'ACESFilmicToneMapping', value: THREE.ACESFilmicToneMapping },
  ];
  function snapshotLightingState() {
    const L = _lights;
    const lightSnap = (light) => light ? {
      intensity: light.intensity,
      shadowRadius: light.shadow ? light.shadow.radius : 0,
      ...getLightAngles(light),
    } : null;
    return {
      ambient: L.ambient ? L.ambient.intensity : 0,
      win:  lightSnap(L.winLight),
      ceil: lightSnap(L.ceilLight),
      fill: lightSnap(L.fillLight),
      wallColor: L.wallMat ? '#' + L.wallMat.color.getHexString() : '#b4ac9c',
      toneMap:   renderer ? renderer.toneMapping : 0,
      exposure:  renderer ? renderer.toneMappingExposure : 1,
      fov:        camera ? baseFov : 34,
      parallaxX:  PARALLAX_RANGE_X,
      parallaxY:  PARALLAX_RANGE_Y,
      skySpeed:   (L.sky && L.sky.getSpeed) ? L.sky.getSpeed() : 1,
      fogOn:      !!(scene && scene.fog),
      fogColor:   (scene && scene.fog) ? '#' + scene.fog.color.getHexString() : '#cdb89a',
      fogNear:    (scene && scene.fog) ? scene.fog.near : 4,
      fogFar:     (scene && scene.fog) ? scene.fog.far  : 18,
    };
  }
  function applyLightingState(s) {
    const L = _lights;
    if (L.ambient) L.ambient.intensity = s.ambient;
    const restoreLight = (light, helper, snap) => {
      if (!light || !snap) return;
      light.intensity = snap.intensity;
      if (light.shadow) light.shadow.radius = snap.shadowRadius;
      setLightAngles(light, snap.yaw, snap.pitch);
      if (helper) helper.update();
    };
    restoreLight(L.winLight, L.winHelper, s.win);
    restoreLight(L.ceilLight, L.ceilHelper, s.ceil);
    restoreLight(L.fillLight, L.fillHelper, s.fill);
    if (L.wallMat) L.wallMat.color.set(s.wallColor);
    if (renderer) {
      renderer.toneMapping = s.toneMap;
      renderer.toneMappingExposure = s.exposure;
    }
    if (camera) { baseFov = s.fov; applyResponsiveFov(); }
    PARALLAX_RANGE_X = s.parallaxX;
    PARALLAX_RANGE_Y = s.parallaxY;
    if (L.sky && L.sky.setSpeed) L.sky.setSpeed(s.skySpeed);
    applyFogState(s.fogOn, s.fogColor, s.fogNear, s.fogFar);
  }
  function applyFogState(on, colorHex, near, far) {
    if (!scene) return;
    if (!on) { scene.fog = null; return; }
    if (scene.fog && scene.fog.isFog) {
      scene.fog.color.set(colorHex);
      scene.fog.near = near; scene.fog.far = far;
    } else {
      scene.fog = new THREE.Fog(colorHex, near, far);
    }
  }
  function ensureLightingDebugHUD() {
    if (lightingDebug.hudEl) return;
    const style = document.createElement('style');
    style.textContent = `
      .dior-lightdebug { position: absolute; top: 12px; left: 12px;
        background: rgba(20, 16, 12, 0.92); color: #f3df9f;
        font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
        padding: 10px 12px; border-radius: 8px; z-index: 1000;
        width: 280px; box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        user-select: none; pointer-events: auto;
        max-height: calc(100vh - 24px); overflow-y: auto; }
      .dior-lightdebug .ld-title { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      .dior-lightdebug .ld-title b { color: #fff; }
      .dior-lightdebug kbd { font: inherit; background: rgba(255,255,255,0.12);
        padding: 0 5px; border-radius: 3px; font-size: 11px; }
      .dior-lightdebug .ld-h { margin: 8px 0 4px; font-size: 11px; opacity: 0.75;
        text-transform: uppercase; letter-spacing: 0.05em;
        border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px; }
      .dior-lightdebug .ld-r { display: grid; grid-template-columns: 84px 1fr 46px;
        gap: 6px; align-items: center; margin: 3px 0; }
      .dior-lightdebug .ld-r label { font-size: 11px; opacity: 0.85; }
      .dior-lightdebug .ld-r input[type=range] { width: 100%; accent-color: #d6a45c; }
      .dior-lightdebug .ld-r input[type=color] { width: 46px; height: 22px; padding: 0;
        border: 1px solid rgba(255,255,255,0.2); border-radius: 3px; background: transparent; }
      .dior-lightdebug .ld-r input[type=checkbox] { accent-color: #d6a45c; }
      .dior-lightdebug .ld-r select { width: 100%; font: inherit; background: #2a201a;
        color: #f3df9f; border: 1px solid #5a4a3a; border-radius: 3px; padding: 2px 4px; }
      .dior-lightdebug .ld-v { text-align: right; font-size: 11px; color: #fff; }
      .dior-lightdebug .ld-btns { display: flex; gap: 6px; margin-top: 10px; }
      .dior-lightdebug button { flex: 1; font: inherit; padding: 5px 8px; cursor: pointer;
        background: #3a2f24; color: #f3df9f; border: 1px solid #5a4a3a; border-radius: 4px; }
      .dior-lightdebug button:hover { background: #5a4a3a; }
      .dior-lightdebug .ld-status { margin-top: 8px; font-size: 11px; color: #b8d6e5; min-height: 14px; }
    `;
    document.head.appendChild(style);
    const toneOpts = TONE_MAPS.map((t, i) => '<option value="' + i + '">' + t.label + '</option>').join('');
    const lightRows = (k, label) => `
      <div class="ld-h">${label}</div>
      <div class="ld-r"><label>intensity</label><input type="range" data-k="${k}" data-p="intensity" min="0" max="2" step="0.01"><span class="ld-v" data-d="${k}-intensity"></span></div>
      <div class="ld-r"><label>yaw°</label><input type="range" data-k="${k}" data-p="yaw" min="-180" max="180" step="1"><span class="ld-v" data-d="${k}-yaw"></span></div>
      <div class="ld-r"><label>pitch°</label><input type="range" data-k="${k}" data-p="pitch" min="-90" max="90" step="1"><span class="ld-v" data-d="${k}-pitch"></span></div>
      <div class="ld-r"><label>shadow blur</label><input type="range" data-k="${k}" data-p="shadowRadius" min="0" max="30" step="0.25"><span class="ld-v" data-d="${k}-shadowRadius"></span></div>
      <div class="ld-r"><label>show helper</label><input type="checkbox" data-k="${k}" data-p="helper"><span></span></div>`;
    const el = document.createElement('div');
    el.className = 'dior-lightdebug';
    el.innerHTML = `
      <div class="ld-title"><b>Lighting debug</b> <kbd>L</kbd> to close</div>
      <div class="ld-h">Ambient</div>
      <div class="ld-r"><label>intensity</label><input type="range" data-k="ambient" data-p="intensity" min="0" max="1.5" step="0.01"><span class="ld-v" data-d="ambient"></span></div>
      ${lightRows('win',  'Window')}
      ${lightRows('ceil', 'Ceiling')}
      ${lightRows('fill', 'Front fill')}
      <div class="ld-h">Camera</div>
      <div class="ld-r"><label>FOV°</label><input type="range" data-k="camera" data-p="fov" min="10" max="90" step="0.5"><span class="ld-v" data-d="fov"></span></div>
      <div class="ld-r"><label>parallax X</label><input type="range" data-k="camera" data-p="parallaxX" min="0" max="0.5" step="0.005"><span class="ld-v" data-d="parallaxX"></span></div>
      <div class="ld-r"><label>parallax Y</label><input type="range" data-k="camera" data-p="parallaxY" min="0" max="0.5" step="0.005"><span class="ld-v" data-d="parallaxY"></span></div>
      <div class="ld-h">Sky</div>
      <div class="ld-r"><label>cloud speed</label><input type="range" data-k="sky" data-p="speed" min="0" max="3" step="0.05"><span class="ld-v" data-d="skySpeed"></span></div>
      <div class="ld-h">Atmosphere (fog)</div>
      <div class="ld-r"><label>enable</label><input type="checkbox" data-k="fog" data-p="enable"><span></span></div>
      <div class="ld-r"><label>color</label><input type="color" data-k="fog" data-p="color"><span></span></div>
      <div class="ld-r"><label>near</label><input type="range" data-k="fog" data-p="near" min="0" max="30" step="0.1"><span class="ld-v" data-d="fogNear"></span></div>
      <div class="ld-r"><label>far</label><input type="range" data-k="fog" data-p="far" min="2" max="80" step="0.5"><span class="ld-v" data-d="fogFar"></span></div>
      <div class="ld-h">Scene</div>
      <div class="ld-r"><label>wall color</label><input type="color" data-k="scene" data-p="wallColor"><span></span></div>
      <div class="ld-r"><label>tone map</label><select data-k="scene" data-p="toneMap">${toneOpts}</select><span></span></div>
      <div class="ld-r"><label>exposure</label><input type="range" data-k="scene" data-p="exposure" min="0" max="3" step="0.01"><span class="ld-v" data-d="exposure"></span></div>
      <div class="ld-btns">
        <button data-act="copy">Copy</button>
        <button data-act="reset">Reset</button>
        <button data-act="done">Done</button>
      </div>
      <div class="ld-status" data-status></div>
    `;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation());
    container.appendChild(el);
    lightingDebug.hudEl = el;
    const onChange = (e) => {
      const t = e.target; const k = t.dataset.k, p = t.dataset.p;
      if (!k || !p) return;
      handleLightingDebugChange(k, p, t);
    };
    el.addEventListener('input', onChange);
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.type === 'color' || t.tagName === 'SELECT' || t.type === 'checkbox') onChange(e);
    });
    el.querySelector('[data-act="copy"]').addEventListener('click', () => {
      const snippet = formatLightingSnippet();
      const setOK = () => setLightingDebugStatus('Copied — paste into setupScene()');
      const setErr = () => setLightingDebugStatus('Copy failed; check console');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(snippet).then(setOK).catch(() => {
          console.log('[lightingDebug] snippet:\n' + snippet);
          setErr();
        });
      } else {
        console.log('[lightingDebug] snippet:\n' + snippet);
        setLightingDebugStatus('Clipboard unavailable — see console');
      }
    });
    el.querySelector('[data-act="reset"]').addEventListener('click', () => {
      if (!lightingDebug.defaults) return;
      applyLightingState(lightingDebug.defaults);
      syncLightingDebugHUDFromState();
      setLightingDebugStatus('Reset to start values');
    });
    el.querySelector('[data-act="done"]').addEventListener('click', exitLightingDebug);
  }
  function handleLightingDebugChange(k, p, target) {
    const L = _lights;
    const val = target.type === 'checkbox' ? target.checked
              : (target.type === 'color' ? target.value
              : (target.tagName === 'SELECT' ? parseInt(target.value, 10)
              : parseFloat(target.value)));
    const handleLight = (light, helper) => {
      if (!light) return;
      if (p === 'helper') { if (helper) helper.visible = val; }
      else if (p === 'shadowRadius') { if (light.shadow) light.shadow.radius = val; }
      else if (p === 'yaw' || p === 'pitch') { applyLightAngle(light, helper, p, val); }
      else { light[p] = val; if (helper) helper.update(); }
    };
    if (k === 'ambient' && L.ambient) L.ambient.intensity = val;
    else if (k === 'win')  handleLight(L.winLight,  L.winHelper);
    else if (k === 'ceil') handleLight(L.ceilLight, L.ceilHelper);
    else if (k === 'fill') handleLight(L.fillLight, L.fillHelper);
    else if (k === 'hdri') {
      if (p === 'enable') scene.environment = val ? _envMap : null;
      else if (p === 'intensity') {
        scene.traverse((obj) => {
          if (obj.isMesh && obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) if ('envMapIntensity' in m) m.envMapIntensity = val;
          }
        });
      }
    } else if (k === 'ssao' && ssaoPass) {
      if (p === 'enable') ssaoPass.enabled = val;
      else ssaoPass[p] = val;
    } else if (k === 'scene') {
      if (p === 'wallColor' && L.wallMat) L.wallMat.color.set(val);
      else if (p === 'toneMap' && renderer) renderer.toneMapping = TONE_MAPS[val].value;
      else if (p === 'exposure' && renderer) renderer.toneMappingExposure = val;
    } else if (k === 'camera') {
      if (p === 'fov' && camera) { baseFov = val; applyResponsiveFov(); }
      else if (p === 'parallaxX') PARALLAX_RANGE_X = val;
      else if (p === 'parallaxY') PARALLAX_RANGE_Y = val;
    } else if (k === 'sky') {
      if (p === 'speed' && L.sky && L.sky.setSpeed) L.sky.setSpeed(val);
    } else if (k === 'fog') {
      const el = lightingDebug.hudEl;
      const onEl    = el.querySelector('input[type=checkbox][data-k="fog"][data-p="enable"]');
      const colorEl = el.querySelector('input[type=color][data-k="fog"][data-p="color"]');
      const nearEl  = el.querySelector('input[type=range][data-k="fog"][data-p="near"]');
      const farEl   = el.querySelector('input[type=range][data-k="fog"][data-p="far"]');
      applyFogState(
        p === 'enable' ? val : (onEl ? onEl.checked : false),
        p === 'color'  ? val : (colorEl ? colorEl.value : '#cdb89a'),
        p === 'near'   ? val : (nearEl ? parseFloat(nearEl.value) : 4),
        p === 'far'    ? val : (farEl ? parseFloat(farEl.value)   : 18)
      );
    }
    updateLightingDebugReadouts();
  }
  function setLightingDebugStatus(text) {
    if (!lightingDebug.hudEl) return;
    const s = lightingDebug.hudEl.querySelector('[data-status]');
    s.textContent = text;
    setTimeout(() => { if (s && s.textContent === text) s.textContent = ''; }, 2500);
  }
  function syncLightingDebugHUDFromState() {
    if (!lightingDebug.hudEl) return;
    const el = lightingDebug.hudEl;
    const L = _lights;
    const setRange   = (k, p, v) => { const r = el.querySelector('input[type=range][data-k="' + k + '"][data-p="' + p + '"]'); if (r) r.value = v; };
    const setChecked = (k, p, v) => { const c = el.querySelector('input[type=checkbox][data-k="' + k + '"][data-p="' + p + '"]'); if (c) c.checked = v; };
    const syncLight = (k, light, helper) => {
      if (!light) return;
      const a = getLightAngles(light);
      setRange(k, 'intensity', light.intensity);
      setRange(k, 'yaw', a.yaw);
      setRange(k, 'pitch', a.pitch);
      if (light.shadow) setRange(k, 'shadowRadius', light.shadow.radius);
      setChecked(k, 'helper', helper ? helper.visible : false);
    };
    if (L.ambient) setRange('ambient', 'intensity', L.ambient.intensity);
    syncLight('win',  L.winLight,  L.winHelper);
    syncLight('ceil', L.ceilLight, L.ceilHelper);
    syncLight('fill', L.fillLight, L.fillHelper);
    const hdriOn = el.querySelector('input[type=checkbox][data-k="hdri"][data-p="enable"]');
    if (hdriOn) hdriOn.checked = !!scene.environment;
    let envI = 1.0;
    scene.traverse((obj) => {
      if (envI === 1.0 && obj.isMesh && obj.material) {
        const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (m && 'envMapIntensity' in m) envI = m.envMapIntensity;
      }
    });
    setRange('hdri', 'intensity', envI);
    if (camera) setRange('camera', 'fov', baseFov);
    setRange('camera', 'parallaxX', PARALLAX_RANGE_X);
    setRange('camera', 'parallaxY', PARALLAX_RANGE_Y);
    if (L.sky && L.sky.getSpeed) setRange('sky', 'speed', L.sky.getSpeed());
    if (ssaoPass) {
      const ssaoOn = el.querySelector('input[type=checkbox][data-k="ssao"][data-p="enable"]');
      if (ssaoOn) ssaoOn.checked = !!ssaoPass.enabled;
      setRange('ssao', 'kernelRadius', ssaoPass.kernelRadius);
      setRange('ssao', 'minDistance',  ssaoPass.minDistance);
      setRange('ssao', 'maxDistance',  ssaoPass.maxDistance);
    }
    const fogOn = el.querySelector('input[type=checkbox][data-k="fog"][data-p="enable"]');
    const fogColor = el.querySelector('input[type=color][data-k="fog"][data-p="color"]');
    if (fogOn) fogOn.checked = !!(scene && scene.fog);
    if (fogColor) fogColor.value = (scene && scene.fog) ? '#' + scene.fog.color.getHexString() : '#cdb89a';
    setRange('fog', 'near', (scene && scene.fog) ? scene.fog.near : 4);
    setRange('fog', 'far',  (scene && scene.fog) ? scene.fog.far  : 18);
    if (L.wallMat) {
      const ci = el.querySelector('input[type=color][data-k="scene"][data-p="wallColor"]');
      if (ci) ci.value = '#' + L.wallMat.color.getHexString();
    }
    if (renderer) {
      const sel = el.querySelector('select[data-k="scene"][data-p="toneMap"]');
      if (sel) {
        const idx = TONE_MAPS.findIndex((t) => t.value === renderer.toneMapping);
        if (idx >= 0) sel.value = idx;
      }
      setRange('scene', 'exposure', renderer.toneMappingExposure);
    }
    updateLightingDebugReadouts();
  }
  function updateLightingDebugReadouts() {
    if (!lightingDebug.hudEl) return;
    const el = lightingDebug.hudEl;
    const L = _lights;
    const setText = (key, txt) => { const s = el.querySelector('[data-d="' + key + '"]'); if (s) s.textContent = txt; };
    const txt = (k, light) => {
      if (!light) return;
      const a = getLightAngles(light);
      setText(k + '-intensity',    light.intensity.toFixed(2));
      setText(k + '-yaw',          a.yaw.toFixed(0) + '°');
      setText(k + '-pitch',        a.pitch.toFixed(0) + '°');
      if (light.shadow) setText(k + '-shadowRadius', light.shadow.radius.toFixed(1));
    };
    if (L.ambient) setText('ambient', L.ambient.intensity.toFixed(2));
    txt('win',  L.winLight);
    txt('ceil', L.ceilLight);
    txt('fill', L.fillLight);
    let envI = null;
    scene.traverse((obj) => {
      if (envI === null && obj.isMesh && obj.material) {
        const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (m && 'envMapIntensity' in m) envI = m.envMapIntensity;
      }
    });
    if (envI !== null) setText('hdriIntensity', envI.toFixed(2));
    if (camera)   setText('fov',       baseFov.toFixed(1) + '°');
    setText('parallaxX', PARALLAX_RANGE_X.toFixed(3));
    setText('parallaxY', PARALLAX_RANGE_Y.toFixed(3));
    if (L.sky && L.sky.getSpeed) setText('skySpeed', L.sky.getSpeed().toFixed(2) + '×');
    if (ssaoPass) {
      setText('ssaoRadius',  ssaoPass.kernelRadius.toFixed(3));
      setText('ssaoMinDist', ssaoPass.minDistance.toFixed(4));
      setText('ssaoMaxDist', ssaoPass.maxDistance.toFixed(3));
    }
    if (scene && scene.fog) {
      setText('fogNear', scene.fog.near.toFixed(1));
      setText('fogFar',  scene.fog.far.toFixed(1));
    } else {
      setText('fogNear', '—'); setText('fogFar', '—');
    }
    if (renderer) setText('exposure', renderer.toneMappingExposure.toFixed(2));
  }
  function formatLightingSnippet() {
    const L = _lights;
    const lines = [];
    const hex = (c) => '0x' + c.getHexString();
    const tgt = (light, name) => {
      const t = light.target.position;
      lines.push(name + '.target.position.set(' + t.x.toFixed(2) + ', ' + t.y.toFixed(2) + ', ' + t.z.toFixed(2) + ');');
    };
    if (L.ambient) lines.push('ambient.intensity = ' + L.ambient.intensity.toFixed(3) + ';');
    const dumpLight = (light, name) => {
      if (!light) return;
      lines.push(name + '.intensity = ' + light.intensity.toFixed(2) + ';');
      if (light.shadow) lines.push(name + '.shadow.radius = ' + light.shadow.radius.toFixed(2) + ';');
      tgt(light, name);
    };
    dumpLight(L.winLight,  'winLight');
    dumpLight(L.ceilLight, 'ceilLight');
    dumpLight(L.fillLight, 'fillLight');
    if (L.wallMat) lines.push('wallMat.color.set(' + hex(L.wallMat.color) + ');');
    if (renderer) {
      const tm = TONE_MAPS.find((t) => t.value === renderer.toneMapping) || TONE_MAPS[0];
      lines.push('renderer.toneMapping = THREE.' + tm.name + ';');
      lines.push('renderer.toneMappingExposure = ' + renderer.toneMappingExposure.toFixed(2) + ';');
    }
    if (camera) {
      lines.push('// set BASE_FOV (design fov, near the camera declaration) to ' + baseFov.toFixed(1) + ';');
    }
    lines.push('PARALLAX_RANGE_X = ' + PARALLAX_RANGE_X.toFixed(3) + ';');
    lines.push('PARALLAX_RANGE_Y = ' + PARALLAX_RANGE_Y.toFixed(3) + ';');
    if (L.sky && L.sky.getSpeed) lines.push('// cloud speed multiplier: ' + L.sky.getSpeed().toFixed(2) + 'x');
    if (scene && scene.fog) {
      lines.push('scene.fog = new THREE.Fog(' + hex(scene.fog.color) + ', ' + scene.fog.near.toFixed(1) + ', ' + scene.fog.far.toFixed(1) + ');');
    } else {
      lines.push('scene.fog = null;');
    }
    return lines.join('\n') + '\n';
  }

  // ══════════════════════════════════════════════════════════════════
  // §16 · Wall-item drag-corner resize
  //   • A small blue handle appears at the top-right corner of the
  //     hovered wall item.
  //   • Pointer-down on the handle starts a resize. Pointer-move scales
  //     the item proportionally about its center; pointer-up commits and
  //     persists the new scale to localStorage.
  //   • Per-placement multiplier is stored in placement.userScale and
  //     applied on load via placePersisted (see §10 and §15).
  // ══════════════════════════════════════════════════════════════════
  const RESIZE = {
    handle: null,           // THREE.Mesh — the visible blue corner ball
    hoveredPid: null,       // placementId currently shown the handle for
    pinnedPid: null,        // explicit resize mode (modal "Resize" button) —
                            // handle stays attached to this placementId
                            // regardless of hover until the user drags +
                            // releases, presses Esc, or clicks empty space.
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startUserScale: 1,
    dragPlacement: null,
    MIN: 0.25,
    MAX: 4.0,
    PIXELS_PER_DOUBLING: 200, // 200px drag right+up doubles size
  };

  // Called by the modal Resize button: pin the handle to a specific wall
  // placement so the user can drag without chasing it via hover.
  function enterResizeMode(placement) {
    if (!placement || placement.surface !== 'wall') return;
    const surface = SURFACES[placement.surface];
    const rec = surface && surface.placements.get(placement.placementId);
    if (!rec || !rec.mesh) return;
    RESIZE.pinnedPid = placement.placementId;
    RESIZE.hoveredPid = placement.placementId;
    showResizeHandleForWall(placement, rec.mesh);
    if (canvas) canvas.style.cursor = 'nwse-resize';
  }
  // Called when the user is done with explicit resize mode — drag-release,
  // Esc, or click-elsewhere all exit through here.
  function exitResizeMode() {
    if (RESIZE.pinnedPid == null) return;
    RESIZE.pinnedPid = null;
    if (!RESIZE.dragging) {
      hideResizeHandle();
      if (canvas) canvas.style.cursor = '';
    }
  }

  function ensureResizeHandle() {
    if (RESIZE.handle) return RESIZE.handle;
    // Small bright sphere, depth-tested so it occludes behind walls but
    // renders on top of the wall art it sits on. renderOrder ensures it
    // draws over the framed poster's mat/frame so it's always visible.
    const geom = new THREE.SphereGeometry(0.04, 20, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2a6df4, depthTest: false, transparent: true, opacity: 0.95,
    });
    const handle = new THREE.Mesh(geom, mat);
    handle.renderOrder = 999;
    handle.userData.isResizeHandle = true;
    handle.visible = false;
    world.add(handle);
    RESIZE.handle = handle;
    return handle;
  }

  // Position the handle at the top-right corner of the wall mesh's world
  // bbox, nudged slightly forward (+z toward the room) so it stands clear
  // of the frame. The handle's scale is set proportional to the wall
  // item's bbox so it stays prominent on bigger posters (was a fixed-
  // radius sphere; on a 4× poster it looked like a flyspeck).
  function positionResizeHandleFor(mesh) {
    const handle = ensureResizeHandle();
    const bbox = new THREE.Box3().setFromObject(mesh);
    if (bbox.isEmpty()) return;
    const cz = (bbox.min.z + bbox.max.z) / 2;
    handle.position.set(bbox.max.x, bbox.max.y, cz + 0.01);
    // Geometry radius is 0.04m (see ensureResizeHandle); aim for the
    // visible ball to be ~10% of the wall item's larger in-plane edge,
    // floored so it never disappears on tiny items.
    const w = bbox.max.x - bbox.min.x;
    const h = bbox.max.y - bbox.min.y;
    const target = Math.max(0.06, 0.1 * Math.max(w, h));
    const s = target / 0.04;
    handle.scale.set(s, s, s);
  }

  function showResizeHandleForWall(placement, mesh) {
    if (!mesh) return;
    // Pinned mode: the handle is locked to a specific placement (set by
    // the modal Resize button). Refuse to redirect to another item just
    // because the cursor moved — only the pinned placement can claim it.
    if (RESIZE.pinnedPid != null && placement.placementId !== RESIZE.pinnedPid) return;
    ensureResizeHandle();
    RESIZE.hoveredPid = placement.placementId;
    positionResizeHandleFor(mesh);
    RESIZE.handle.visible = true;
  }
  function hideResizeHandle() {
    // Pinned mode (explicit resize from modal) keeps the handle visible
    // regardless of hover state — only exitResizeMode or a completed
    // drag can take it down.
    if (RESIZE.pinnedPid != null) return;
    if (RESIZE.handle) RESIZE.handle.visible = false;
    RESIZE.hoveredPid = null;
  }

  // Find the placement under the cursor restricted to wall items only.
  // Returns { placement, mesh } or null. Reused by hover + handle-pickup.
  function pickWallPlacement() {
    const hits = raycaster.intersectObjects(getPlacedTargets(), true);
    for (const h of hits) {
      const o = findPlacedAncestor(h.object);
      if (!o || !o.userData.placementId) continue;
      if (o.userData.surfaceId !== 'wall') return null;
      const placement = state.placements.find(p => p.placementId === o.userData.placementId);
      if (!placement) return null;
      return { placement, mesh: o };
    }
    return null;
  }

  // Raycast the handle itself. Called from onPointerDown BEFORE the
  // normal placement hit-test so a click on the handle starts a resize
  // rather than a sticky-grab of the underlying poster.
  function pickResizeHandle() {
    if (!RESIZE.handle || !RESIZE.handle.visible) return null;
    const hits = raycaster.intersectObject(RESIZE.handle, false);
    return hits.length ? RESIZE.handle : null;
  }

  function beginResizeDrag(e) {
    if (!RESIZE.hoveredPid) return false;
    const placement = state.placements.find(p => p.placementId === RESIZE.hoveredPid);
    if (!placement) return false;
    RESIZE.dragging = true;
    RESIZE.dragStartX = e.clientX;
    RESIZE.dragStartY = e.clientY;
    RESIZE.startUserScale = placement.userScale || 1;
    RESIZE.dragPlacement = placement;
    if (canvas) canvas.style.cursor = 'nwse-resize';
    return true;
  }

  // Drag right OR up grows the item; drag left OR down shrinks it.
  // Combined diagonal motion compounds — i.e. dx+dy maps to a single
  // size delta. Exponential mapping so the relative growth feels even
  // regardless of starting size.
  function updateResizeDrag(e) {
    if (!RESIZE.dragging || !RESIZE.dragPlacement) return;
    const dx = e.clientX - RESIZE.dragStartX;
    const dy = -(e.clientY - RESIZE.dragStartY);
    const factor = Math.pow(2, (dx + dy) / RESIZE.PIXELS_PER_DOUBLING);
    let newScale = RESIZE.startUserScale * factor;
    newScale = Math.max(RESIZE.MIN, Math.min(RESIZE.MAX, newScale));
    applyUserScale(RESIZE.dragPlacement, newScale);
  }

  function applyUserScale(placement, scale) {
    placement.userScale = scale;
    const surface = SURFACES[placement.surface];
    if (!surface) return;
    const rec = surface.placements.get(placement.placementId);
    if (!rec || !rec.mesh) return;
    const base = rec.mesh.userData.baseScale;
    if (!base) return;
    rec.mesh.scale.set(base.x * scale, base.y * scale, base.z * scale);
    if (RESIZE.handle && RESIZE.handle.visible) positionResizeHandleFor(rec.mesh);
    // Force the next animation frame to re-render the shadow map. Without
    // this, the cast shadow on the wall stays sized to the OLD geometry
    // until something else (held piece, blinds, save) flips the dirty
    // flag — so the poster grows but its shadow lags behind, looking
    // detached.
    markShadowsDirty();
  }

  function endResizeDrag() {
    if (!RESIZE.dragging) return;
    RESIZE.dragging = false;
    RESIZE.dragPlacement = null;
    if (canvas) canvas.style.cursor = '';
    savePlacements();
    // Explicit (modal-button) resize sessions end after the first drag.
    // Pinned hover sessions just go back to hover-driven behavior.
    if (RESIZE.pinnedPid != null) {
      RESIZE.pinnedPid = null;
      hideResizeHandle();
    }
  }

  global.MiseRoom = {
    init, updateProjects, show, hide, isReady, endLaunchTransition, refreshModels,
    setBackgroundTransparent,
  };
  // Also export under a more-specific name in case the user wants both modules
  // loaded for A/B-style switching.
  global.MiseDiorama = global.MiseRoom;
})(window);
