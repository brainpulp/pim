# PIM — Claude Working Document

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
- Shared Supabase project with gastos (`fnzdkqrkranedtgysqcf`). **DO NOT touch gastos schema, auth site URL, or alphabiotec project.**
- PIM uses **`public.pim_projects`** (NOT `pim.` schema).
- `db.js` uses `supabase.from('pim_projects')` with no `.schema()` call.
- Auth: email + password (`signInWithPassword` / `signUp`). User: maxi.goldschwartz@gmail.com.

## Deploy
```bash
npm run deploy   # vite build && gh-pages -d dist
```
Live: https://brainpulp.github.io/pim/
Repo: https://github.com/brainpulp/pim

**CRITICAL: The user tests on the live GitHub Pages URL, NOT localhost. Always run `npm run deploy` after every set of changes.**

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

## Last session (2026-06-14)
- Fixed wheel zoom on NodeToolbar overlay (forwarding to SVG)
- Fixed D3 force spacing (nodes too far apart after device switch)
- Verified: popup, pan, 3D nodes, zoom all working on live site
- Next up: animated view transitions, slideshow manager (project-level), 3D model z/transparency (minor)
