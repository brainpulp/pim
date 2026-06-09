# PIM — Claude Working Document

## What this app is
Personal Information Manager — a second-brain app combining a force-directed D3.js node graph, outline sidebar, Supabase persistence, and GitHub Pages hosting.

## Stack
- **Vite + React** (no TypeScript)
- **D3.js** — force simulation for the graph canvas
- **Zustand** — graph state (`src/lib/graphStore.js`)
- **Supabase** (`fnzdkqrkranedtgysqcf`, shared with gastos, `public.pim_projects` table) — auth + persistence
- **GitHub Pages** — `base: '/pim/'` in vite.config.js; `npm run deploy`

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
  App.jsx                 # Auth gate → project picker → graph
  index.css               # Global reset + outline/view row CSS
```

## Data model

### View-independent (shared across all views)
```js
nodes: [{ id, label, notes }]
edges: [{ id, source: nodeId, target: nodeId }]
```

### View-dependent (per view in `views[i].nodeProps[nodeId]`)
```js
{ scale, fillColor, strokeColor, visible, fx, fy, shape }
// defaults: scale:1, fillColor:'#12122a', strokeColor:'#2d3a6a',
//           visible:true, fx:null, fy:null, shape:'circle'
```

### Views
```js
views: [{ id, name, nodeProps: {[nodeId]: {...}}, drillRoot: null|nodeId }]
activeViewId: string
```

### Key exports from graphStore.js
```js
NODE_R = 34
DEFAULT_NODE_PROPS = { scale, fillColor, strokeColor, visible, fx, fy, shape }
FILL_COLORS = [16 vivid colors]
SHAPES = ['circle', 'ellipse', 'roundrect', 'diamond', 'none']
```

### Key store actions
```
addNode(label, parentId?, x?, y?) → id   // initializes notes: ''
updateLabel(id, label)
updateNotes(id, notes)
deleteNode(id)
addEdge(source, target)
removeEdge(id)
reparentNode(nodeId, newParentId)
setNodeViewProp(nodeId, prop, value)      // writes to active view's nodeProps
setAnchor(id, fx, fy)
releaseAnchor(id)                         // clears fx/fy in active view
releaseAllAnchors()
addView / duplicateView / renameView / deleteView / setActiveView
setDrillRoot(nodeId) / exitDrill()
loadProjectData({ nodes, edges, views, activeViewId })
```

## Graph canvas — behavior rules (DO NOT regress)
- **D3 force simulation**: nodes float and seek balance. `alphaDecay: 0.015`.
- **Drag node body** → anchors node at drop position. Orange stroke + ⊙ badge appear (no glow ring).
- **⊙ badge** (top-left, only when anchored) → releases anchor, D3 resumes.
- **Eye icon** (top-left, only when selected + not anchored) → hides node in active view.
- **× button** (top-right, selected only) → opens confirm modal "Delete from all views?".
- **Scale handle** (bottom-right, selected only) → drag to resize (scale 0.3–3.0).
- **Blue connector dot** (right side of node) → drag to another node = new edge; drag to empty = new node at drop position.
- **Double-click** node label → inline edit (select-all on open).
- **Click node** → select, shows **NodeToolbar** popup below with:
  - Fill color palette (16 swatches)
  - Shape switcher: circle ○ / ellipse ⬭ / roundrect ▭ / diamond ◇ / none ╌
  - Notes toggle → textarea (persists to store); blue dot on node when notes exist
  - ⊙ Free (only when anchored), ◌ Hide, ⊳ Drill, ✕ Delete
- **Node text** uses `<foreignObject>` + flex for word-wrap — scales correctly with D3 zoom.
- **Shapes**: `shapeDims(shape, r)` returns `{ halfW, halfH }` used for clipping, toolbar Y position, hit areas.
- **Click edge** → highlight blue, × midpoint button. Delete key removes selected edge.
- **⊡ Fit** → zoom extents. **+ Node** → add free node. **⊙ Free All** → release all anchors.
- **Cmd+Enter** → new node.
- **Zoom/pan**: D3 zoom; pan filter = `!e.target.closest('[data-node]')` — never fires on nodes.
- **Escape** → deselect. **Delete** → delete selected node (with confirm) or edge.
- **Drill mode**: only drillRoot + descendants visible. "↑ Exit Drill" button appears.

## Outline sidebar — behavior rules (DO NOT regress)
- Mouse-based drag (NOT HTML5 drag API). `data-outline-id` on each row.
- `document.elementFromPoint` during mousemove + `getBoundingClientRect` relY for before/after/into (thresholds: 28% / 72%).
- Expanded by default; chevron collapses subtree.
- Multi-parent / cycle nodes: `⇢` indicator. Cycle fix: unseen nodes appended as top-level after root traversal.
- Double-click label → rename. Hover actions: ⊳ drill, ●/◌ visibility, + add child, × delete.
- "↑ make root" drop zone at top for making a node root-level.

## ViewManager — behavior rules (DO NOT regress)
- Lives below outline in left sidebar.
- Active view highlighted. Click → switch. Double-click → rename.
- + new, ⧉ duplicate (deep-copy nodeProps), × delete (blocked if only 1 view).
- View switch updates D3 sim `fx/fy` from new view's nodeProps.

## D3 + React integration pattern
- D3 sim in `simRef.current`; positions in mutable `simNodesRef`/`simEdgesRef`.
- React re-renders via rAF-throttled `setTick` (scheduleRender).
- Store holds topology only (no x/y). View props (fx/fy/shape/etc.) are separate.
- **Anchor release**: must clear `simNode.fx = null; simNode.fy = null` directly on live D3 node — Zustand update alone doesn't propagate.

## Auth + Supabase — CRITICAL
- Shared Supabase project with gastos (`fnzdkqrkranedtgysqcf`). **DO NOT touch gastos schema, auth site URL, or alphabiotec project.**
- PIM uses **`public.pim_projects`** (NOT `pim.` schema — requires explicit PostgREST exposure).
- `db.js` uses `supabase.from('pim_projects')` with no `.schema()` call.
- Magic link auth; `emailRedirectTo: window.location.origin`.
- Site URL stays as gastos URL — do not change it.

## Deploy
```bash
npm run deploy   # vite build && gh-pages -d dist
```
Live: https://brainpulp.github.io/pim/
Repo: https://github.com/brainpulp/pim

## Dev
```bash
npm run dev   # http://localhost:5173/pim/
```

## Past gotchas / never regress
- `"Invalid schema: pim"` → never use `.schema('pim')` in db.js
- Anchor not releasing → must also set `simNode.fx/fy = null` directly on D3 node
- Pan broken → zoom filter must use `closest('[data-node]')`, not `=== svgRef.current`
- Toolbar flicker → node `<g>` needs `onClick={e => e.stopPropagation()}`
- Project rename stale → `ProjectRow` needs `useEffect(() => { if (!editing) setDraft(project.name) }, [project.name, editing])`
- gh-pages blocked → don't commit `.github/workflows/` without a PAT with `workflow` scope
- Outline `"No nodes yet"` with cycles → fixed by tracking `seen` set and appending unseen nodes as top-level
