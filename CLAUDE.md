# PIM — Claude Working Document

## What this app is
Personal Information Manager — a second-brain app combining a force-directed node graph and a table view, with Supabase persistence per user.

## Stack
- **Vite + React** (no TypeScript)
- **D3.js** — force simulation for the graph canvas
- **Zustand** — graph topology state (`src/lib/graphStore.js`)
- **TanStack Table** — table view
- **Supabase** (`fnzdkqrkranedtgysqcf`, gastos project, `pim` schema) — auth + persistence
- **Netlify** — hosting (not yet configured)

## Current file structure
```
src/
  lib/
    graphStore.js       # Zustand store: nodes, edges, addNode, addEdge, setAnchor, releaseAnchor, updateLabel, deleteNode
    supabase.js         # Supabase client
  pages/
    Graph.jsx           # Main view: OutlinePanel sidebar + D3 force canvas
    Table.jsx           # Table view (placeholder data for now)
  components/
    Auth.jsx            # Magic link auth screen
    OutlinePanel.jsx    # Sidebar tree, reflects graph, editable
  App.jsx               # Nav (graph | table) + auth gate
  index.css             # Global reset + outline hover CSS classes
```

## Graph canvas — behavior rules (DO NOT regress)
- **D3 force simulation**: nodes float and seek balance. `alphaDecay: 0.015`.
- **Drag node body** → anchors node at drop position (`fx`/`fy` set). Orange ring appears.
- **⊙ button** (top-left of anchored node) → releases anchor, D3 resumes pulling it.
- **Blue connector dot** (right side of node) → drag to another node to create a directed edge.
- **Temp dashed line** shown while dragging connector.
- **Double-click** node label → inline edit via `<foreignObject>` input.
- **× button** (top-right) → delete node + all its edges.
- **Zoom/pan** via D3 zoom (double-click zoom disabled — reserved for label edit).
- **+ Node button** (bottom-right, floating) → adds free-floating node at canvas center.
- Arrowhead edges (marker `#arrow`), shortened so arrow sits at node edge.
- Node radius: `NODE_R = 34`.

## Outline sidebar — behavior rules (DO NOT regress)
- Width: 220px, dark background `#111118`.
- Reflects graph structure: edges = parent→child relationships.
- **Multi-parent nodes** appear as clones under each parent branch with a `⇢` indicator.
- Cycle detection via ancestor set prevents infinite loops in tree building.
- **Double-click** label → rename (syncs to graph).
- **+ button** (hover, right) → add child node (creates node + edge in store).
- **× button** (hover, right) → delete node.
- **+ Root button** (header) → add free-floating node.
- Expand/collapse chevron per node.
- Row hover: `background: #1a1a2e`, actions appear (CSS classes `.outline-row`, `.outline-actions`).

## Data model (Zustand store)
```js
nodes: [{ id, label, fx?, fy? }]   // fx/fy = anchored position
edges: [{ id, source: nodeId, target: nodeId }]
```
D3 simulation gets copies of these with `x, y, vx, vy` added.
Store stays clean — no x/y in Zustand (those are D3's domain).

## Auth
- Magic link via Supabase (`signInWithOtp`)
- `emailRedirectTo: window.location.origin`
- Allowed redirect URLs: `https://brainpulp.github.io/gastos/**`, `http://localhost:5173/**`, `http://localhost:5173`
- Site URL is still gastos (`https://brainpulp.github.io/gastos/`) — do NOT change it (would break gastos)

## Supabase — CRITICAL
- Shared project with gastos (`fnzdkqrkranedtgysqcf`). **Do not touch gastos schema or auth site URL.**
- PIM data will go in a `pim` schema (not yet created).
- RLS not yet set up.

## What's NOT done yet
- [ ] Persistence: graph state not saved to Supabase yet (only in memory)
- [ ] `pim` schema migration in Supabase
- [ ] RLS policies
- [ ] Netlify deploy
- [ ] Table view wired to real data

## Design decisions log
- tldraw was evaluated and rejected — replaced with custom D3 force graph
- Multi-parent = one node in graph, cloned entries in outline
- Anchoring on drag (not before) — intentional
- No auto-center force (nodes can drift to edges of canvas freely)
