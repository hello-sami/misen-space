/* Diorama configuration — pure data extracted from diorama.js (§1 app
   registry + §2 room dimensions / palette). Loaded as a plain <script>
   BEFORE diorama.js, which reads window.MiseDioramaConfig. Edit THIS file
   to add, move, or remove an app, or to retune room size / colors. */
(function (global) {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // §1 · App config — ONE entry per app. Edit here to add, move, or
  //                    remove an app from the diorama.
  // ══════════════════════════════════════════════════════════════════
  //
  // Each row: { app, item, surface?, slot? }
  //   app     — project.id (must match Misen's projects.json)
  //   item    — key from §7 ITEMS catalog (the 3D piece for this app)
  //   surface — 'floor' | 'wall'   (omit for first-fit on item's default)
  //   slot    — preferred placement on that surface; omit to first-fit
  //
  // Slot syntax:
  //   floor:  'c,r'           — 7×5 grid; (0,0) is back-left; rows
  //                             increase toward viewer. Cells (3,0)+(4,0)
  //                             are blocked by the static desk; the
  //                             leftmost back column is blocked by the
  //                             static shelf.
  //   wall:   'panel:c,r'     — panel is 'back' (5×3) or 'left' (4×3)
  //
  // Pieces with footprint > 1 cell occupy adjacent cells starting at
  // the slot anchor — see the inline notes below.
  //
  // To remove an app from the diorama: delete its row (the launcher app
  // itself stays — only the diorama mapping goes).
  // ──────────────────────────────────────────────────────────────────
  const APPS = [
    // Telephoto corner shot: the camera (see setupScene) is inside the
    // room looking sharply at the back-right corner with a 42° FOV.
    // Only the BACK wall and the new RIGHT wall are in frame; the
    // left wall, the open fourth wall, and most of the floor sit
    // outside the view cone.
    //
    // Layout strategy: every launcher is mounted on a wall — items
    // that used to be free-standing floor furniture (plant, TV, file
    // boxes, etc.) are now wall-mounted poster-equivalents. The desk
    // decoration stays on the floor (it's directly under the camera's
    // look-target and reads as the room's anchor), and the tabletop
    // launchers stay on the desk. The right wall is a 5×3 grid (new —
    // mirror of the left wall but wider), see §8 WallSurface.

    // ── Wall: back panel (27×15) — ALL launchers live here ──────────
    // The head-on telephoto camera sees only the central ~20 cols and
    // bottom ~10 rows of the back wall. Layout packs the 14 launchers
    // into cols 4-22, rows 0-9, with the shelf decoration as the
    // hero centerpiece directly above the desk. The two side walls
    // are not used at this camera angle.
    //
    // The desk sits in front of the back wall (occluding rows 0-2
    // visually below desk height), but wall items at row 0+ are above
    // the desk-top silhouette and read clearly.
    //
    // Vertical bands:
    //   Row 0-5 — calendars (3×6 vertical) on left/right edges
    //   Row 0-2 — atlas wallMap + flanking corkboards (above desk)
    //   Row 3-5 — shelf decoration (centerpiece) + flanking posters
    //   Row 6-8 — second wallMap + 4 posters
    //   Row 9-11 — library + follows-audit (rows 9-10 visible, row 11
    //              at the very top of frame and may be slightly clipped
    //              depending on canvas aspect ratio)

    // Back wall layout — all items packed into the safe zones around
    // the back-wall window. Window occupies roughly cols 10-20, rows
    // 2-10, so everything goes either LEFT of the window (cols 0-8),
    // RIGHT of it (cols 21-23), or ABOVE it (the shelf decoration
    // sits at rows 11-13, cols 11-16). Items are uniform 3×3 except
    // for the two 3×6 wall calendars on the outer edges. The two
    // formerly-6×3 items (atlas wallMap, media-tracker) were shrunk
    // to 3×3 in their catalog entries to fit this grid cleanly.

    // LEFT side, col strip 0-2 (leftmost edge):
    { app: 'daily-journal',        item: 'glbMirror',            surface: 'wall',  slot: 'back:0,0'  }, // art-deco mirror, 3×3 at top-left.
    // garden-tracker moved off the back wall — now launches from a
    // floor-standing snake plant beside the desk.
    { app: 'garden-tracker',       item: 'glbSnakePlant2',       surface: 'floor', slot: '16,0' },        // 1×1, back-right corner just beside the desk.
    // library moved off the back wall — now launches from a small
    // red filing cabinet on the floor in the gap between the TV
    // cabinet (cols 4-7) and the desk (cols 9-14).
    { app: 'library',              item: 'glbFilingCabinet',     surface: 'floor', slot: '8,0' },        // 1×1, between media cabinet and desk, against the back wall.
    { app: 'project-sketchbook',   item: 'sketchbookPainting',   surface: 'wall',  slot: 'back:0,12' }, // 3×3 → cols 0..2, rows 12..14.

    // LEFT side, col strip 3-5 (middle-left, full column):
    { app: 'whiteboard-tasks',     item: 'glbWhiteboard',        surface: 'wall',  slot: 'back:3,0'  }, // 4×3 → cols 3..6, rows 0..2.
    { app: 'digest',               item: 'digestPainting',       surface: 'wall',  slot: 'back:3,3'  }, // 3×3 → cols 3..5, rows 3..5.
    // residency-tracker ("Studio") moved from a wall painting to a
    // small framed painting standing on the desk — see glbPintura in §7.
    { app: 'residency-tracker',    item: 'glbPintura',           surface: 'tabletop', slot: 'host:floor:9,0:deskUnit:top:1,1' },
    // kitchen moved from a wall painting to a small mug sitting on the
    // desk. Tabletop slot top:4,4 — front-middle of the desk, like a
    // coffee mug near the keyboard.
    { app: 'kitchen',              item: 'glbMug',               surface: 'tabletop', slot: 'host:floor:9,0:deskUnit:top:4,4' },
    { app: 'atlas',                item: 'wallMap',              surface: 'wall',  slot: 'back:3,12' }, // 3×3 → cols 3..5, rows 12..14.

    // LEFT side, col strip 6-8 (just left of window — top half only,
    // leaving rows 0-8 as breathing space adjacent to the window):
    { app: 'follows-audit',        item: 'followsAuditPainting', surface: 'wall',  slot: 'back:6,9'  }, // 3×3 → cols 6..8, rows 9..11.
    // media-tracker moved off the back wall — it now launches from a
    // physical media cabinet on the floor to the left of the desk.
    { app: 'media-tracker',        item: 'glbTvCabinet',         surface: 'floor', slot: '4,0' },        // 4×2 → cols 4..7, rows 0..1, just left of the desk at col 9.

    // RIGHT side, col strip 21-23:
    { app: 'events-digest',        item: 'calendar',             surface: 'wall',  slot: 'back:21,0'  }, // 3×3 → cols 21..23, rows 0..2.
    { app: 'organize-cms',         item: 'cmsPainting',          surface: 'wall',  slot: 'back:21,6'  }, // 3×3 → cols 21..23, rows 6..8.
    { app: 'day-planner',          item: 'dayPlannerPainting',   surface: 'wall',  slot: 'back:21,9'  }, // 3×3 → cols 21..23, rows 9..11.
    { app: 'igstories-viewer',     item: 'igstoriesPainting',    surface: 'wall',  slot: 'back:21,12' }, // 3×3 → cols 21..23, rows 12..14.

    // ── Wall: right + left panels ────────────────────────────────────
    // Not used by APPS at this camera angle (side walls are out of
    // frame). Kept usable for manual catalog placement.

    // ── Tabletop: on the static desk ─────────────────────────────────
    // Desk lives at floor slot '9,0' (post-fine-grid) → host key is
    // host:floor:9,0:deskUnit. Tabletop tier coords (the part after
    // ':top:') are in TIER cells, not floor cells, so they're
    // unaffected by the floor-grid scaling.
    // Tabletop slots use the densified 12×6 grid (was 4×2). Items are
    // 1×1 footprints, so the cell-center mapping is c → 3c+1, r → 3r+1
    // — this is the only mapping that preserves visual position when
    // tripling the grid (c → 3c lands on a cell CORNER, half a cell off
    // from the original center). MIGRATIONS[14] applies the same +1
    // offset to carried-forward saves.
    { app: 'email-whiteboard-app', item: 'glbInbox',     surface: 'tabletop', slot: 'host:floor:9,0:deskUnit:top:7,1' },
    { app: 'email-whiteboard-v2',  item: 'glbInbox',     surface: 'tabletop', slot: 'host:floor:9,0:deskUnit:top:10,1' },
    { app: 'job-search',           item: 'glbLaptop',    surface: 'tabletop', slot: 'host:floor:9,0:deskUnit:top:4,1' },
    // font-manager moved from the desk typewriter to a wall poster
    // (the Helvetica documentary movie poster). Slot back:3,6 just
    // freed up when residency-tracker moved off the wall to the desk.
    { app: 'font-manager',         item: 'fontManagerPainting',  surface: 'wall', slot: 'back:3,6' },
    { app: 'ereader',              item: 'bookStack',    surface: 'tabletop', slot: 'host:floor:9,0:deskUnit:top:10,4' }, // small stack of books on the corner of the desk
    // Sheet-music-tracker launches from a floor-standing electric piano
    // tucked against the right wall, centered under the right-wall window
    // (window center is world z ≈ -0.5 → floor grid row ≈ 5; col 17 is
    // the rightmost unblocked column with EDGE_BLOCK=3).
    { app: 'sheet-music-tracker',  item: 'glbElectricPiano', surface: 'floor', slot: '17,5' },
  ];

  // Home-studio proportions: ~5.4×4.0m floor, 3.0m ceiling. Previous
  // 6.5×4.5×4.0m made the desk + chair read as "doll furniture in a
  // cathedral." 3.0m is at the high end of residential ceilings; the
  // wall gallery (15-row × 27-col grid above the desk) needs to fit
  // between the desk top (y≈0.78) and the new ceiling, so wall panel
  // bottomY + cellH are tuned in §8 WallSurface to land at top y ≈
  // 2.85m. Floor grid cells auto-rescale (ROOM.width/depth / cols).
  const ROOM = { width: 5.4, depth: 4.0, height: 3.0 };
  const FACTORY_SCALE_FLOOR = 0.4;
  const FACTORY_SCALE_WALL  = 0.3;

  // Static RIGHT-wall window — baked into the right wall geometry at
  // setupRoom time (right wall isn't slot-backed so it's safe to cut
  // statically). Coordinates are WALL-LOCAL to the right-wall plane:
  // the plane has width=ROOM.depth and is rotated y=-π/2 + positioned at
  // (ROOM.width/2, ROOM.height/2, 0), so:
  //   local x in [-D/2, D/2]   → world z (local +x maps to world +z = front)
  //   local y in [-H/2, H/2]   → world y - ROOM.height/2
  // Window sits toward the BACK half of the right wall (local x < 0,
  // so world z < 0) so it reads as a side window next to the back-wall
  // workspace, partially clipped at the camera's right edge.
  const RIGHT_WINDOW = {
    x: -0.50,  // wall-local x; world z = -0.50 (slightly back of room center)
    y: 0.30,   // wall-local y; world y = 2.0 + 0.30 = 2.30 (mid-upper wall)
    w: 1.80,   // window "width" runs along world Z — 1.8m along the right wall
    h: 1.60,   // 1.6m tall
  };

  const PALETTE = {
    bg:        0xf2e8d8,
    wall:      0xd6c2a4,
    floor:     0xc69970,
    floorTile: 0xa37c54,
    highlight: 0x7fb8a7,
    invalid:   0xc8806f,
    cream:     0xf7eddc,
    pink:      0xf2b8c2, pinkDeep: 0xe48a99,
    mint:      0xb8e0c8, lavender: 0xc8b8e0,
    peach:     0xf5cda3, butter:   0xf3df9f,
    sage:      0xc8d4a8, sky:      0xb8d6e5,
    terracotta:0xd99a7a, charcoal: 0x4a4339,
    shelfWood: 0x8a6644, shelfWoodDark: 0x6e4d2c,
  };

  global.MiseDioramaConfig = {
    APPS, ROOM, FACTORY_SCALE_FLOOR, FACTORY_SCALE_WALL, RIGHT_WINDOW, PALETTE,
  };
})(window);
