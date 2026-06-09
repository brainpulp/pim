# PIM — Claude Working Document

## What this app is
Personal Information Manager — a second-brain app combining a force-directed node graph and a table view, with Supabase persistence per user.

## Stack
- **Vite + React** (no TypeScript)
- **D3.js** — force simulation for the graph canvas
- **Zustand** — graph state (`src/lib/graphStore.js`)
- **TanStack Table** — table view
- **Supabase** (`fnzdkqrkranedtgysqcf`, gastos project, `pim` schema) — auth + persistence
- **Netlify** — hosting (not yet configured)

## File structure
```
src/
  lib/
    graphStore.js         # Zustand: view-independent + view-dependent state
    supabase.js           # Supabase client
  pages/
    Graph.jsx             # D3 force canvas + node toolbar + side panels
    Table.jsx             # Table view (placeholder)
  components/
    Auth.jsx              # Magic link auth
    OutlinePanel.jsx      # Sidebar tree reflecting graph structure
    ViewManager.jsx       # View list: new, duplicate, rename, delete
  App.jsx                 # Nav + auth gate
  index.css               # Global reset + outline/view row CSS
```

## Data model

### View-independent (never changes across views)
```js
nodes: [{ id, label }]
edges: [{ id, source: nodeId, target: nodeId }]
```

### View-dependent (per view, stored in `views[i].nodeProps[nodeId]`)
```js
{ scale, fillColor, strokeColor, visible, fx, fy }
// defaults: { scale:1, fillColor:'#12122a', strokeColor:'#2d3a6a', visible:true, fx:null, fy:null }
```

### Views
```js
views: [{ id, name, nodeProps: {[nodeId]: {...}}, drillRoot: null|nodeId }]
activeViewId: string
```

### Key exports from graphStore.js
```js
NODE_R = 34
DEFAULT_NODE_PROPS = { scale, fillColor, strokeColor, visible, fx, fy }
FILL_COLORS = [8 dark colors]
STROKE_COLORS = [8 ring colors]
```

### Key store actions
```
addNode(label, parentId?, x?, y?) → id
updateLabel(id, label)
deleteNode(id)
addEdge(source, target)
removeEdge(id)
setNodeViewProp(nodeId, prop, value)   // writes to active view's nodeProps
setAnchor(id, fx, fy)                  // writes fx/fy to active view
releaseAnchor(id)                      // clears fx/fy in active view
addView(name?)
duplicateView(viewId)
renameView(viewId, name)
deleteView(viewId)
setActiveView(viewId)
setDrillRoot(nodeId)                   // show only subtree in active view
exitDrill()
```

## Graph canvas — behavior rules (DO NOT regress)
- **D3 force simulation**: nodes float and seek balance. `alphaDecay: 0.015`.
- **Drag node body** → anchors node at drop position. Orange ring + ⊙ badge appear.
- **⊙ badge** (top-left of anchored node) → releases anchor, D3 resumes.
- **Blue connector dot** (right side) → drag to another node = new edge; drag to empty space = create new node at drop position.
- **Temp dashed line** shown while dragging connector.
- **Double-click** node label → inline edit (select-all on open).
- **× button** (top-right) → delete node + all edges.
- **Click edge** → select edge (highlight blue, × midpoint button appears). Delete key also removes selected edge.
- **Click node** → select node, shows **NodeToolbar** below it with:
  - Fill color palette (8 swatches)
  - Ring/stroke color palette (8 swatches)
  - Size ± buttons (scale step 0.2, min 0.3, max 3.0)
  - Hide button (hides in active view only)
  - Drill button (sets drillRoot = this node in active view)
- **⊡ Fit button** (bottom-right) → zoom extents to all visible nodes.
- **+ Node button** (bottom-right) → adds free-floating node.
- **Zoom/pan** via D3 zoom; pan only fires on bare SVG background (not nodes).
- **Escape** key → deselect. **Delete** key → delete selected node or edge.
- **Drill mode**: only the drillRoot node + its descendants are visible. "Exit Drill" button top-right.
- Node + text scale together via `scale` view prop (text fontSize = `max(8, 11.5 * scale)`).

## Outline sidebar — behavior rules (DO NOT regress)
- Width: 220px, dark `#111118`.
- Reflects graph structure: edges = parent→child relationships.
- **Multi-parent + cycle nodes** appear with `⇢` indicator. Cycle fix: after building from roots, any unseen nodes are appended as top-level items.
- **Double-click** label → rename (select-all on open).
- **⊳ button** (hover) → drill into node.
- **●/◌ button** (hover) → toggle visibility in active view.
- **+ button** (hover) → add child node.
- **× button** (hover) → delete node.
- **+ Root button** (header) → add free-floating node.
- Expand/collapse chevron per node.

## ViewManager — behavior rules (DO NOT regress)
- Lives in left sidebar below outline panel.
- Shows list of all views; active view highlighted.
- **+ button** → create new view (blank nodeProps, no drill).
- **⧉ button** (hover) → duplicate view (deep-copy nodeProps).
- **× button** (hover, only if >1 view) → delete view.
- **Double-click label** → rename view.
- **Click row** → switch active view.
- **⊙ drill badge** (header, only in drill mode) → exit drill.
- Switching views updates D3 simulation `fx/fy` anchors from new view's nodeProps.

## D3 + React integration pattern
- D3 simulation in `simRef.current`, positions in mutable `simNodesRef`/`simEdgesRef`.
- React re-renders triggered via rAF-throttled `setTick`.
- Store holds topology only (no x/y). View props (including fx/fy) are separate.
- `simNodesRef.current[n].fx/fy` set directly for D3; store saves them for persistence/view-switch.
- View switch `useEffect` reads new view's nodeProps and updates sim node `fx/fy` in place.
- D3 zoom filter: pan only activates on `e.target === svgRef.current` (prevents pan during node drag).

## Auth
- Magic link via Supabase (`signInWithOtp`).
- `emailRedirectTo: window.location.origin`.
- Allowed redirect URLs: `https://brainpulp.github.io/gastos/**`, `http://localhost:5173/**`, `http://localhost:5173`.
- Site URL is still gastos (`https://brainpulp.github.io/gastos/`) — **do NOT change it** (would break gastos).

## Supabase — CRITICAL
- Shared project with gastos (`fnzdkqrkranedtgysqcf`). **Do not touch gastos schema or auth site URL.**
- PIM data will go in a `pim` schema (not yet created).
- RLS not yet set up.

## What's NOT done yet
- [ ] Persistence: graph state not saved to Supabase (only in memory)
- [ ] `pim` schema migration + RLS policies
- [ ] Netlify deploy
- [ ] Table view wired to real data
- [ ] Node notes / rich content per node
- [ ] Search / filter
