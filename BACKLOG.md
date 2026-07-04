# PIM — Backlog & Task Tracker

Source of truth for open work, parked decisions, and a log of what shipped.
Maintained by Claude across sessions; updated after each change. Mirror to Notion on request.

Legend: 🟢 open · ⏳ waiting on Maxi · 💤 idea/needs decision · ✅ done · ❌ won't do

---

## Organize = deterministic circle packing (like d3's pack example) (2026-07-04, FINAL)

Force layouts kept exploding / merging into concentric blobs. The user pointed at d3's classic circle-pack
example (strongriley d3 pack / countries-by-population) as the target. So: **deterministic circle packing**,
no force. `d3.packSiblings` packs each group's members into a tight circle; the group circles are packed
together (bunched, non-overlapping — verified). Nodes are pinned at their packed slots but **glide** there via
a short rAF tween (0.22 lerp) so it still animates. A retag re-packs deterministically (stable member sort →
stable packing) and the tween eases nodes to their new slots. Pack outline = the packed enclosing circle
(hugs members). Empty packs = small fixed circle (drop target). Cluster centre anchored once per session.

### (superseded) — clustered force layout attempt

Landed on the right model after two wrong turns (over-strong force → explosions; then static pinning →
"loose/anchored, not self-organizing"). Now it's a proper clustered force layout:
- Gentle forces, configured **once** on entry: `forceX/forceY` toward each node's group centre (strength 0.1),
  `forceManyBody(-22)`, `forceCollide(nodeRadius+3)`. Nothing pinned — nodes float and self-organize.
- Group centres computed once per session, spaced by each group's expected blob size and **packed together**
  (`d3.packSiblings`), not on a grid. Lanes = same blobs in a row.
- Per-node target centre lives in a **ref the force reads each tick**. A retag just updates that ref + a
  gentle reheat (`alpha≈0.3`) — no force reconfig, no position reset → the one moved node drifts to its new
  pack, everything else barely stirs. This killed the explosions.
- **Pack outlines are drawn live** around the members (centroid + extent), so each pack is exactly as big as
  it needs to be and grows/shrinks as the layout settles. Empty packs keep a small circle as a drop target.
- Known limit: group centres are fixed at entry, so dragging many nodes into one pack can eventually crowd a
  neighbour — re-enter Organize to re-fit. A "Re-fit" button is the easy next step if needed.

## Recent fixes (2026-07-04, cont.)

Organize mode polish (the real home for tag-packing + drag-to-retag with real nodes):
- **Pack titles bigger** (22px bold) and **packs less transparent** (fill ~14%, stroke ~70%).
- **Drags no longer reshuffle the whole graph:** the group key set is now complete + stable (every
  option gets a pack), so a retag doesn't change the pack count and the grid never reflows; and the
  effect's re-run on a data change no longer resets positions / hard-restarts — it just nudges the one
  node whose group changed (alpha 0.15; drop handler 0.2).
- **Empty packs stay** as visible drop targets (seeded from all options + always an "(empty)" bucket).
- **Show links (segments) toggle** in the Organize popover, default **off** — edges hidden while packing.
- **Frames hidden** while organizing (packs replace them).
- **Context menu no longer pops when panning:** it now opens on right-button *mouseup* only if the
  pointer didn't move (native menu always suppressed; open decided after the gesture, not at press).

## Recent fixes (2026-07-04)

- **Table:** column headers had z-index 0, so scrolling let body cells paint over them — titles collided and were
  unclickable (rename dead). Fixed the sticky stack: headers z3, corner (Name) z4, sticky Name body cells z2,
  regular body cells 0. Rename target widened to the whole header cell (double-click) + ellipsis on long names.
- **Pack:** replaced the CSS click-to-zoom with real **d3.zoom** (scroll = zoom, drag = pan, click a circle to fit),
  so you can zoom into a tag-pack until items are big enough to grab — fixes "drag & drop doesn't work" (leaves were
  too tiny to hit). Leaf drags are excluded from pan via the zoom filter + `data-leaf`. Hover-zoom kept as a bonus.

## Open / in progress

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | In-node image handles don't work | ✅ | Fixed — the transparent double-click overlay sat on top and stole their mousedown; moved it to the bottom of the stack. |
| 2 | Instagram reels import (link + thumbnail + folders) | ⏳ | Waiting on a sample of the JSON export (2–3 entries) to confirm fields → then ~1–3 days. Folders = frame nodes, thumbnails = image nodes, dbl-click = inline embed. |
| 3 | Persist **undo** across reloads | 💤 | Undo history is in-memory today (clears on refresh). Could persist per-project. |
| 4 | Pin Fracasos + turn off its orbit | 💤 | So it stops drifting off-screen. One-off data tweak. |
| 5 | Round shapes: "grow to a cap, then shrink" | 💤 | Middle ground vs current pure shrink-to-fit, so small circles with lots of text aren't tiny. |
| 6 | Delete backup project "Hot ideas — backup 2026-06-29" | ⏳ | Safety copy. Now doubly important — it's what restored Hot ideas after the wipe. Keep for now. |
| 7 | Notion-style DB — Phase 2 (per-node property editor on canvas) | ✅ | Done — "Properties" fly-out in NodeToolbar; shared PropertyField component with the Table. |
| 8 | Notion-style DB — Phase 3 (on-canvas chips + filter) | ✅ | Done — chips under nodes (opt-in per property) + non-destructive property filter on the graph. (Sort + persisted filter = future.) |

## Won't do (for now)

| Item | Why |
|------|-----|
| Ownership-hijack RLS trigger | Declined — editor-members can rewrite a project's `user_id` (confirmed by testing). Re-open if sharing goes wider. |

---

## SPEC — Layout Modes (pack / kanban / tag-tree) over the DB

**Core principle — two independent axes; a mode only edits its own axis:**
- **Axis A = topology** (`edges[]`, the mind-map tree). Edited *only* by mind-map interactions.
- **Axis B = data** (`node.props`). Edited by the Table and by structured modes.
- Structured layouts (pack/kanban/tag-tree) are **projections of Axis B**. Their groups/columns/mother-tags
  are **property values**, not nodes/edges. Dragging a node into a group **writes `node.props[groupBy]`** —
  never an edge. So the hierarchy is safe by construction.

**Positions rule (prevents modes clobbering each other):**
- Mind map → positions **persisted** per node per view (`fx/fy`).
- Pack/kanban/tag-tree → positions **computed, never persisted**. Drag edits the *data*, layout recomputes.
- ⇒ flipping to a structured layout and back leaves the mind map exactly as arranged. Non-destructive.

**A view gains (all optional, default off → no migration):**
```
view.layout    = 'mindmap' | 'pack' | 'kanban' | 'tagtree'   (default mindmap)
view.groupBy   = propId | null      // pack cells / kanban columns / tag parents
view.encodings = { color, size, outline, animation }   // channel → propId | null
view.autoFit   = bool
view.showEdges = bool               // default false in structured layouts
```
Switch mode = flip `view.layout` in place; duplicate the view (existing) to keep mindmap + pack side by side.

**Visual resolver** `resolve(node, view) → {fill,size,outline,anim}`: an encoded channel **overrides** the
manual value; manual value **preserved underneath** (turning the encoding off restores it). Used by all layouts.

**Decisions (locked 2026-07-02):**
- Multi-group membership → **clone/mirror** the node into each group (ghosted duplicates; edits sync — one node).
- Blob/Venn overlap (node once, in the intersection) = **opt-in later, only when ≤3 groups** (Euler diagrams are
  geometrically impossible past ~4 sets). Not the foundation.
- Uncategorized → explicit "(empty)" group. Number/date grouping → binned ranges.
- Kanban intra-column order = a Number property (deferred).
- "Organize" quick-toggle on the current view (animated): Group by / Layout / Filter / Fit; **Done** reverts,
  **Save as view** freezes. Nodes tween from mindmap positions to group cells.

**Build order:** A) Pack + drag-to-reassign (single-select groupBy, computed positions, autoFit) · B) visual
encodings (shared resolver) · C) kanban · D) tag-tree + multi-tag mirrors (then optional blobs).

**More views requested (2026-07-03) — two families:**
- **Projection layouts** (ride the force sim + pan/zoom + NodeShape): mindmap · pack/organize (done) · kanban ·
  **lanes/bubble** (ref: armollica `2dcfd66a`) = dots in lanes by a category, radius←Number, fill←Select.
  **SHIPPED** — the ▦ Organize control now has a ⚙ settings popover: Layout **Pack | Lanes**, Group by, **Size by**
  (Number → radius), **Color by** (Select → fill). Encodings are the shared resolver (`encodedScaleFor` /
  `encodedColorFor`), visual-only (manual scale/color restored on Done), and drive the collide radius so sized
  nodes don't overlap. Still needs hands-on force tuning + a real dataset check.
- **Computed hierarchy layouts** (bypass the force sim; own full-page view, `d3.hierarchy`):
  **zoomable circle packing** (ref: mbostock/1747543) — **SHIPPED** as a new top-level **pack** tab. `src/pages/PackView.jsx`
  + shared `src/lib/hierarchy.js` (`buildTree` projects the edge DAG to a strict tree: first-parent-wins, cycles broken,
  orphans re-attached; `buildTagTree` for the radial tag view). d3.pack, CSS-transform click-to-zoom (Esc / ← to go up),
  labels for **every node at every level** (complete text, **word-wrapped** to fit each circle; parent titles hug the
  top edge), a **source selector** (Hierarchy edges **or** group-by-tag → `buildTagTree`), a **size-by** control
  (Item count / any Number property), and node **decorations mirrored from the active view** — fill, stroke, and a
  small first-emoji badge (`decorOf` in `hierarchy.js`). **Drag-to-retag:** in group-by-tag mode, dragging a leaf
  item onto another tag-pack rewrites `node.props[tagProp]` (multi-select moves that one membership; single-select
  replaces; drop on "(untagged)" clears) and persists via `saveProject`. Drop target highlights; a chip follows the
  cursor. Hit-testing via `elementFromPoint` + `data-bucket` (leaves get `pointer-events:none` mid-drag so the bucket
  beneath is found). **Hover-zoom:** hovering a leaf magnifies it (Bostock-style) so tiny items are readable and
  grabbable — an on-top overlay with the enlarged circle + wrapped label + emoji; you can grab it from there.
  **Alt-drag** (multi-select only) = additive: keep the source tag, add the target (chip turns green, "ADD tag"). · **radial dendrogram** (ref: mbostock/4339607 — tree drawn radially; can also be fed the tag→nodes
  hierarchy). **SHIPPED** as a new top-level **radial** tab. `src/pages/RadialView.jsx`: d3.cluster + d3.linkRadial,
  scroll-zoom / drag-pan (d3.zoom), **click a node to spin it to the top + zoom in** (rAF rotation tween + d3.zoom
  transition; ⟳ Reset), a source selector (Hierarchy edges **or** group-by-tag → the tag→nodes tree with multi-tag
  mirrors), node fill+stroke from active-view colors. Read-only. **TODO:** hand-check label crowding on big trees.

**All three requested views (2026-07-03) shipped.** Remaining polish across the set: force/label tuning, a size-by
control in the pack tab, kanban (Phase C), and letting these views participate in per-view layout (`view.layout`)
rather than being global tabs, if that's wanted.

**Progress:** A (Slice 1 + 2) **shipped, needs hands-on tuning** — top-right **▦ Organize** control groups by any
Select/Tags/Checkbox property. Force-clusters visible nodes into a grid of dashed "bubble" cells (labelled + count),
non-destructive (never writes `fx/fy`; **Done** ✕ restores the mind map exactly). Dragging a node into a cell writes
that group's property value (the "(empty)" cell clears it) and re-clusters. Grid rect anchored per session so edits
don't drift it. **Still to do:** autoFit (frame the packed groups), tune force strengths / cell padding by hand, and
multi-select drop semantics. Slices remaining: B (encodings) · C (kanban) · D (tag-tree + mirrors).

---

## Incident (2026-06-30) — "Hot ideas" blanked, restored

A **failed project load** left the store empty and the autosave wrote that empty doc over the
project (0 nodes). Restored from the 2026-06-29 backup (82 nodes). **Fix shipped:** autosave now
refuses to run unless the project loaded successfully (`loadOkRef` guard). Not caused by feature
work — a latent load/save bug, likely triggered by the flaky Supabase connection.

## Shipped this session (2026-06-30)

- ✅ Two node resize handles: scale-both (corner) vs scale-shape-only (box grows, text reflows).
- ✅ Tooltips on all node handles.
- ✅ Slides: right-click menu (background color, present-from-here, remove).
- ✅ Nav: project title centered; removed redundant outline "+ Root".
- ✅ Reload restores zoom (instant localStorage viewport persistence).
- ✅ Autosave guard so a failed load can't blank a project (see incident).
- ✅ NodeToolbar sub-sections are fly-out submenus (top menu stays; open on hover).
- ✅ Delete handle (red ×) on node hover, top-left.
- ✅ Node handles counter-scale to zoom (clamped 0.4–2.5×) — no longer huge/tiny at extremes.
- ✅ Legibility sweep: replaced banned near-black text greys app-wide; codified the rule in CLAUDE.md.
- ✅ Notion-style DB Phase 0 (per-project property schema: `property_defs` column + store actions + node.props).
- ✅ Notion-style DB Phase 1 (Table view = live grid: typed columns, add/rename/retype/delete, rows, inline options).

## Shipped earlier this session (2026-06-29)

- ✅ Edge blur: feathers all four sides evenly (gradient mask; was a hard line on the short axis).
- ✅ Restored "Fracasos" — was hidden by a collapsed ancestor ("Elementos emocionales del dilema"), not deleted.
- ✅ **Search** spotlight (Cmd/Ctrl+K or `/`): finds nodes; reveals hidden / drilled / collapsed nodes.
- ✅ **Undo** coverage extended (node creation, drag-reparent, drag-into-frame; delete/hide/edge already covered).
- ✅ Node text: double-click selects words while editing (overlay no longer steals clicks).
- ✅ Node text fit: round shapes shrink-to-fit inside the curve; rectangles get a Miro-style right-edge width handle (on selection).
- ✅ **Multi-node delete**: Delete key now works on rubber-band selection (confirm + single undo).
- ✅ **Reload restores zoom/pan** (drill + active view already persisted).

## Security note (sharing)

Editor-members can read+edit a shared project (correct) but can also rewrite its `user_id`
and hijack ownership (confirmed). Fix on file if needed: a `before update` trigger blocking
non-owners from changing `user_id`. Currently **not applied** (per decision above).
