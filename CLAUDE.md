# PIM — Claude Working Document

## ⚠️ DEVICE SYNC — CRITICAL RULE
**Before switching devices or ending a session, ALWAYS:**
```bash
git add -A && git commit -m "wip: session end" && git push
```
**Before starting work on any device, ALWAYS:**
```bash
git pull
```
Features built locally but not pushed are PERMANENTLY LOST when the other device deploys. This has happened multiple times. There are no exceptions to this rule.

## What this app is
Personal Information Manager — a second-brain app combining a force-directed D3.js node graph, outline sidebar, Supabase persistence, and GitHub Pages hosting.

## Stack
- **Vite + React** (no TypeScript)
- **D3.js** — force simulation for the graph canvas
- **Zustand** — graph state (`src/lib/graphStore.js`)
- **Supabase** (`fnzdkqrkranedtgysqcf`, shared with gastos, `public.pim_projects` table) — auth + persistence
- **GitHub Pages** — `base: '/pim/'` in vite.config.js; `npm run deploy`
- **@react-three/fiber + @react-three/drei + three** — 3D model nodes (shape `'3d'`)

## File structure
```
src/
  lib/
    graphStore.js         # Zustand: topology + view-dependent state + all actions
    db.js                 # Supabase helpers (pim_projects table)
    supabase.js           # Supabase client
  pages/
    Graph.jsx             # D3 force canvas, NodeShape, NodeToolbar, split layout
    Projects.jsx          # Project picker: create/open/rename/delete
  components/
    OutlinePanel.jsx      # Sidebar tree with mouse-based drag-drop
    ViewManager.jsx       # View list: new, duplicate, rename, delete
    Node3DViewer.jsx      # r3f Canvas inside SVG foreignObject; GLB + OBJ only
  App.jsx                 # Auth gate → project picker → graph
  index.css               # Global reset + outline/view row CSS
```

## Data model

### View-independent (shared across all views)
```js
nodes: [{ id, label, notes, modelData?, modelType?, modelThumb? }]
edges: [{ id, source: nodeId, target: nodeId }]
```

### View-dependent (per view in `views[i].nodeProps[nodeId]`)
```js
{ scale, fillColor, strokeColor, visible, fx, fy, shape, containedIn,
  model3dCam: { pos:[x,y,z], target:[x,y,z] }   // 3D camera state per view
}
// shape: 'circle'|'ellipse'|'roundrect'|'rect'|'diamond'|'none'|'frame'|'3d'
```

### Views
```js
views: [{ id, name, nodeProps: {[nodeId]: {...}}, drillRoot: null|nodeId,
          bgColor, images: [], slides: [] }]
activeViewId: string
```

### Key exports from graphStore.js
```js
NODE_R = 44
DEFAULT_NODE_PROPS = { scale, fillColor, strokeColor, visible, fx, fy, shape, containedIn }
FILL_COLORS = [16 vivid colors]
SHAPES = ['circle', 'ellipse', 'roundrect', 'rect', 'diamond', 'none']  // '3d' added inline in toolbar
```

### Key store actions
```
addNode(label, parentId?, x?, y?) → id
updateLabel(id, label)
updateNotes(id, notes)
deleteNode(id)
addEdge(source, target)
removeEdge(id)
reparentNode(nodeId, newParentId)
setNodeViewProp(nodeId, prop, value)
setAnchor(id, fx, fy) / releaseAnchor(id) / releaseAllAnchors()
addView / duplicateView / renameView / deleteView / setActiveView
setDrillRoot(nodeId) / exitDrill()
setViewBgColor(color)
addImage / updateImage / deleteImage
addSlide / removeSlide / reorderSlides
set3DModel(id, modelData, modelType)   // modelData = base64, modelType = 'glb'|'obj'
setModelThumb(id, thumb)               // JPEG data URL captured from canvas
loadProjectData({ nodes, edges, views, activeViewId })
```

## Graph canvas — behavior rules (DO NOT regress)
- **D3 force simulation**: nodes float and seek balance. `alphaDecay: 0.015`.
- **Drag node body** → anchors node at drop position. Orange stroke + ⊙ badge appear.
- **⊙ badge** (top-left, only when anchored) → releases anchor, D3 resumes.
- **Eye icon** → hides node in active view.
- **× button** → confirm delete modal.
- **Scale handle** (bottom-right) → drag to resize (scale 0.3–6.0).
- **Blue connector dot** (right side) → drag to node = edge; drag to empty = new node.
- **Double-click** node label → inline edit.
- **Click node** → select, shows **NodeToolbar** popup (icon row + drilldown panels for color/shape/note).
- **Shapes**: `shapeDims(shape, r)` returns `{ halfW, halfH }`. Shape `'3d'` = r*2.5 square.
- **Frame nodes** (`shape: 'frame'`): large containers; nodes dragged inside get `containedIn` set. Bounding force keeps contained nodes inside.
- **3D nodes** (`shape: '3d'`): also act as frames — dragging nodes onto them sets `containedIn`. Live r3f canvas renders inside SVG `<foreignObject>` (placed before regular nodes so PIM nodes paint on top). When selected, the node `<g>` gets `pointer-events: none` so orbit controls work. Label shown as SVG text caption below the box. Double-clicking caption also opens edit. Accepts GLB + OBJ files only (not GLTF JSON — no external resource resolution).
- **Keyboard**: Enter (selected) = create sister. Enter (editing) = commit only (stopPropagation). Esc = deselect. Arrow keys = navigate tree. In presentation mode, arrows navigate slides.
- **Presentation mode**: all UI hidden except bottom prev/next counter. Esc exits.
- **Slides**: frame nodes added to slideshow; SlideSidebar manages order. Presenting zooms to each frame.

## 3D node architecture
- **SVG foreignObject approach**: `<foreignObject>` placed inside SVG `<g transform>` BEFORE regular nodes. This ensures PIM nodes paint on top visually. The foreignObject is in graph/canvas coordinates (not screen), so it zooms/pans with D3 naturally.
- **Orbit controls**: selected 3D node's `<g>` gets `pointer-events: none` → events fall through to foreignObject → r3f OrbitControls receive them.
- **Controls**: LMB = orbit, MMB = pan, scroll = zoom, RMB = pan (Sketchfab style).
- **Thumbnail**: captured via `toDataURL` (requires `preserveDrawingBuffer: true`) 300ms after first frame. Stored in `node.modelThumb`. Displayed as SVG `<image>` when node is not selected.
- **Blob URL lifetime**: not revoked until component unmounts or model is replaced (previous URL revoked after 5s delay to avoid async loader race).
- **GLB only** (not GLTF JSON): GLTF JSON references external `.bin`/textures by relative path, unresolvable from blob URL. Users must export as GLB.
- **Camera**: `model3dCam: { pos, target }` saved to viewNodeProps on orbit `onEnd`. Restored on mount inside `CameraController` component via `useThree()`.

## Outline sidebar — behavior rules (DO NOT regress)
- Mouse-based drag (NOT HTML5 drag API). `data-outline-id` on each row.
- `document.elementFromPoint` during mousemove + `getBoundingClientRect` relY for before/after/into.
- Double-click label → rename. Hover actions: ⊳ drill, ●/◌ visibility, + add child, × delete.

## ViewManager — behavior rules (DO NOT regress)
- Lives below outline in left sidebar.
- Active view highlighted. Click → switch. Double-click → rename.
- + new, ⧉ duplicate (deep-copy nodeProps), × delete (blocked if only 1 view).

## D3 + React integration pattern
- D3 sim in `simRef.current`; positions in mutable `simNodesRef`/`simEdgesRef`.
- React re-renders via rAF-throttled `setTick` (scheduleRender).
- Store holds topology only (no x/y). View props (fx/fy/shape/etc.) are separate.
- **Anchor release**: must clear `simNode.fx = null; simNode.fy = null` directly on live D3 node.
- **TDZ gotcha**: never reference a `const` declared later in the same function body inside a `useEffect` deps array — silent crash in production.

## Auth + Supabase — CRITICAL
- PIM now has its **own dedicated Supabase project** (`ikztpvxfgmhmrcwolwgx`, name: "pim"). No longer shared with gastos.
- PIM uses **`public.pim_projects`** (NOT `pim.` schema).
- `db.js` uses `supabase.from('pim_projects')` with no `.schema()` call.
- Auth: email + password (`signInWithPassword` / `signUp`). User: maxi.goldschwartz@gmail.com.
- Storage bucket: `pim-models` (public, 50MB limit) — for 3D model GLB/OBJ files and thumbnails.
- Old broken project: `fnzdkqrkranedtgysqcf` (gastos) — still has gastos data on disk but DB is crash-looping from Nano compute exhaustion.

## Deploy
```bash
npm run deploy   # vite build && gh-pages -d dist
```
Live: https://brainpulp.github.io/pim/
Repo: https://github.com/brainpulp/pim

**CRITICAL: The user tests on the live GitHub Pages URL, NOT localhost. Always run `npm run deploy` after every set of changes.**

## UI color rule — NEVER REGRESS
**Never use dark grey text on a dark background.** The canvas background is `#0c0c1a`. Minimum readable text color on it is `#7080a0`. Do not use `#334`, `#445`, `#556` or any similar near-black color for text or labels anywhere in the app. Use `#7080a0` or brighter for secondary labels, `#8090b8` for tertiary hints, `#c5d0ff` for primary labels.

## Past gotchas / never regress
- `"Invalid schema: pim"` → never use `.schema('pim')` in db.js
- Anchor not releasing → must also set `simNode.fx/fy = null` directly on D3 node
- Pan broken → zoom filter must use `closest('[data-node]')`, not `=== svgRef.current`
- Toolbar flicker → node `<g>` needs `onClick={e => e.stopPropagation()}`
- TDZ crash (blank page after login) → `scheduleRender` declared after a `useEffect` that referenced it in deps — remove from deps array
- Enter key creates unwanted node → input `onKeyDown` needs both `e.preventDefault()` AND `e.stopPropagation()` for Enter/Escape/Tab to prevent bubbling to canvas keyboard handler
- GLTF files fail to load → only GLB works (no external resource resolution from blob URL); reject `.gltf` in file picker
- 3D canvas on top of PIM nodes → use SVG `<foreignObject>` placed BEFORE regular nodes in SVG paint order, not an absolute div overlay
- gh-pages blocked → don't commit `.github/workflows/` without a PAT with `workflow` scope
- Wheel zoom broken on toolbar → NodeToolbar is an HTML div overlay after `</svg>`; wheel events never reach D3. Fix: `onWheel` on toolbar div dispatches `new WheelEvent('wheel', {...})` to `svgRef.current`
- Node margins too large → D3 force values were too strong; current values: `charge(-300)`, `link distance(120)`, `forceCollide(NODE_R+8)` — do not increase these

## Last session (2026-06-15) — continued

### Changes
- Moved canvas buttons (Free, Fit, +Node, +Frame, +Root, +View, BG picker) into left sidebar below ViewManager. ViewManager also moved from canvas overlay into sidebar.
- Removed nav action buttons (+ View, + Frame, + Node, + Root) from App.jsx nav header.
- `onSetNavActions` prop removed from Graph; `addFrameToCenter` is now a local `useCallback`.
- Added `sideToolBtnStyle` constant for sidebar tool strip buttons.
- Smart/curly quotes replaced with straight quotes throughout Graph.jsx (rolldown/Vite 8 is strict about these in JSX attribute positions).
- Added `AnimatedG` SVG component: wraps node visual content with optional RAF-driven motion (shake/circle/jerk/updown/sideways/scale) and CSS `hue-rotate` color cycling. Pauses on hover/select.
- NodeShape now reads `viewProps.nodeMotion` and `viewProps.nodeColorCycle`; passes them to AnimatedG.
- NodeToolbar: added ✦ (motion) and ❋ (radiate) buttons to main icon row.
  - Motion panel: type grid (○ ≋ ◎ ⚡ ↕ ↔ ⬡), speed+intensity +/- controls, color cycle toggle with speed.
  - Radiate panel: propagates fillColor/shape/both to direct edge-children of the selected node.
- CSS keyframe `pim-hue-cycle` added to index.css for color cycling.
- viewProps keys: `nodeMotion: { type, speed, intensity } | null`, `nodeColorCycle: number (0=off, seconds)`

## Last session (2026-06-15)
- Migrated to dedicated Supabase project (ikztpvxfgmhmrcwolwgx)
- Fixed 3D viewer positioning: absolute div with CSS transform for smooth GPU-composited movement
- PNG thumbnails (replaces JPEG): preserves alpha so SVG fill color shows through
- liveThumbsRef: thumbnail updates instantly on deselect without waiting for storage upload
- Orbit-end thumbnail recapture: camera angle always reflected in thumbnail after orbit
- Fixed Ctrl+Enter creating sister instead of child (Enter handler was missing modifier guard)
- NodeToolbar for 3D nodes now appears above the box (not below) so caption text is editable
- Transparent fill option added to NodeToolbar FILL palette (checkered swatch)
- 3D nodes auto-set to transparent fill when shape is switched to '3d'
- Project rename: stopPropagation on rowActions container; double-click on name span; single-click in nav

## TODO
- [ ] Investigate and fix any remaining 3D node jerkiness during pan/zoom
- [ ] Test project rename thoroughly on live site (Projects page + nav header)
- [ ] Restore alphabiotec project (blocked: need to delete old gastos project or upgrade to Pro $25/mo)

## KNOWN ISSUES
- alphabiotec project is paused (to make room for pim on free plan). To restore: delete old gastos project or upgrade to Pro.
- Old pim project data is gone (DB crash). Fresh start on new project.

## BACKLOG

### Notion-style node metadata
**Priority:** medium | **Effort:** tags+status = ~1 day; full suite = ~1 week

Add Notion-style fields to nodes. Data lives on the node object (already freeform JSONB in Supabase — zero schema migration needed). UI is the only work.

**Phase 1 — Tags + Status (recommended starting point)**
- `node.tags = string[]` — colored chips, add/remove from notes panel or a new "Fields" tab in NodeToolbar
- `node.status = 'todo'|'doing'|'done'|null` — colored dot on node corner, dropdown in toolbar
- Visual: tags render as chips below the node label; status as a small corner badge

**Phase 2 — More field types**
- URL/link — single string, opens in new tab, tiny input in toolbar
- Date — native `<input type="date">`, shown as badge on node
- Priority — high/medium/low, same pattern as status
- Number — rating, score, weight
- Custom key-value pairs — open-ended `{ key, value }[]`

**Phase 3 — Power features**
- Filter/hide graph nodes by field value (e.g. hide all where status !== 'done')
- Sort outline by field
- Relations — link node to another node (distinct from visual graph edges)
- Formulas/rollups — computed fields from children values

**Implementation notes**
- All fields view-independent (shared across views), live on `nodes[]` in the store alongside `label`, `notes`
- No DB migration needed — JSONB column already handles arbitrary keys
- UI entry point: expand the existing notes panel into a "Fields" tab, or add a second tab to NodeToolbar color/shape/note panels
- Avoid putting field values in `viewProps` — fields are about the node, not a particular view's presentation

### Arrangement / Z-ordering
**Priority:** low | **Effort:** ~2 hours

Bring-to-front / send-to-back for overlapping nodes. SVG paint order = array order, so reorder `nodes[]` in the store. Could be a right-click context menu item or toolbar icon. Frame nodes always render first already (separate filter pass in Graph.jsx).

### Edge labels
**Priority:** low | **Effort:** ~3 hours

Label text on edges (relationship type). Render as SVG `<text>` at the midpoint of the edge path.

### Node search / spotlight
**Priority:** medium | **Effort:** ~half day

Cmd+K or `/` opens a fuzzy-search popup over all node labels. Selecting one selects + zooms to that node. Simple: filter `storeNodes` by label substring, render a floating list.

### Quick capture mode
**Priority:** high | **Effort:** ~half day
**Source:** Notion "Idea qualifier" (2021)

Global shortcut (e.g. Cmd+Shift+N) opens a minimal floating input anywhere in the app. Type a thought, hit Enter — it drops into the graph as an unanchored node near the current viewport center. No friction, no context-switching. The idea is: capture first, structure later. Nodes created this way could get a visual marker (faint ring, different default color) to indicate "needs organizing."

### Videogame-style rewards
**Priority:** medium | **Effort:** ~1 day
**Source:** Notion note (2026, status: very likely)

When the user creates a node, connects two nodes, or completes a meaningful action, trigger a brief visual + sound reward: particle burst from the node, a satisfying pop sound, a quick scale-bounce animation. Not exploited in serious productivity apps. Small cost, high delight, genuine differentiator. Implementation: CSS keyframe animations + Web Audio API (short synthesized tone, no assets needed).

### AI narrative assistant
**Priority:** high (Pro monetization feature) | **Effort:** ~2-3 days
**Source:** Notion "PIM bot narrativo" (2021)

A conversational layer that knows your graph. Not just "summarize this node" — it reads the whole graph and initiates: "You have 3 unconnected nodes from last week. Your most connected node is X. Which task would make today a good day?" Runs on Claude API. Natural Pro paywall: free users get the graph, Pro users get the assistant. No infra beyond an API call.

### Emotional weight on nodes
**Priority:** low | **Effort:** ~2 hours
**Source:** Notion "emotional intelligence embedded into PIM" (2021)

A single extra field: `node.emotionalWeight` — a 1-5 star rating or a simple emoji (😐🔥❤️). Shown as a small badge on the node. The question it answers: "which task would make this a great day if done?" Distinct from urgency/priority — it's about joy and meaning, not deadlines. Pairs naturally with the AI assistant (which could use it to reorder suggestions).

### Outline depth slider (per-line)
**Priority:** medium | **Effort:** ~1 day
**Source:** Notion note (2026, status: active)

In the outline sidebar, show a slider on hover next to each row that controls how many levels of children are visible below that node. As many notches as existing depth levels. Distinct from the current graph-level expand feature — this is local to the outline and operates per-node. Smooth collapse/expand animation.

### Tasks/nodes as animals (skip — decoration not function)
**Priority:** skip
**Source:** Notion "Tasks as animals" (2016)

Map task parameters (value, speed, joy, urgency) to animal archetypes. Charming concept but fails the "solves real friction" test — the animal vocabulary is learning overhead with no actionable payoff. Better served by emotional weight + status fields.
