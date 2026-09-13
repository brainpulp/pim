// One-shot arrangement layouts for the graph. Each returns [{ id, x, y }] absolute anchor
// positions. Subtree layouts keep the root where it is and place descendants relative to it.

function childMap(edges) {
  const m = new Map()
  edges.forEach(e => { if (!m.has(e.source)) m.set(e.source, []); m.get(e.source).push(e.target) })
  return m
}

// Tidy-tree coordinates: each node gets { depth, cross } where cross is its position along the
// sibling axis (leaves evenly spaced, internal nodes centered over their children). Cycles/repeats
// are visited once.
function tidyTree(rootId, cmap, gap) {
  const out = new Map()
  const seen = new Set()
  let leaf = 0
  const rec = (id, depth) => {
    if (seen.has(id)) return null
    seen.add(id)
    const kids = (cmap.get(id) || []).filter(k => !seen.has(k))
    let cross
    if (!kids.length) { cross = leaf; leaf += gap }
    else {
      const cs = kids.map(k => rec(k, depth + 1)).filter(c => c != null)
      cross = cs.length ? (cs[0] + cs[cs.length - 1]) / 2 : (cross = leaf, leaf += gap, cross)
    }
    out.set(id, { depth, cross })
    return cross
  }
  rec(rootId, 0)
  return out
}

// Arrange a node's subtree. layout: 'radial' | 'star' | 'balanced' | 'tree-down' | 'tree-right'.
export function arrangeSubtree(rootId, layout, edges, positions, opts = {}) {
  const cmap = childMap(edges)
  const root = positions.get(rootId) || { x: 0, y: 0 }
  const LEVEL = opts.level || 160
  const GAP = opts.gap || 110
  const result = []

  if (layout === 'star') {
    const kids = cmap.get(rootId) || []
    const n = kids.length || 1
    const R = Math.max(LEVEL, (n * GAP) / (2 * Math.PI))
    kids.forEach((k, i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2; result.push({ id: k, x: root.x + R * Math.cos(a), y: root.y + R * Math.sin(a) }) })
    return result
  }

  if (layout === 'balanced') {
    const kids = cmap.get(rootId) || []
    const right = kids.filter((_, i) => i % 2 === 0)
    const left = kids.filter((_, i) => i % 2 === 1)
    const side = (sideKids, dir) => {
      const seen = new Set([rootId]); let leaf = 0; const local = new Map()
      const rec = (id, depth) => {
        if (seen.has(id)) return null
        seen.add(id)
        const ch = (cmap.get(id) || []).filter(k => !seen.has(k))
        let cross
        if (!ch.length) { cross = leaf; leaf += GAP }
        else { const cs = ch.map(k => rec(k, depth + 1)).filter(v => v != null); cross = cs.length ? (cs[0] + cs[cs.length - 1]) / 2 : (cross = leaf, leaf += GAP, cross) }
        local.set(id, { depth, cross })
        return cross
      }
      sideKids.forEach(k => rec(k, 1))
      const cr = [...local.values()].map(v => v.cross)
      const mid = cr.length ? (Math.min(...cr) + Math.max(...cr)) / 2 : 0
      local.forEach((v, id) => result.push({ id, x: root.x + dir * v.depth * LEVEL, y: root.y + (v.cross - mid) }))
    }
    side(right, 1); side(left, -1)
    return result
  }

  // tree-down / tree-right / radial all derive from the tidy tree
  const tt = tidyTree(rootId, cmap, GAP)
  const rootCross = tt.get(rootId)?.cross || 0
  const crosses = [...tt.values()].map(z => z.cross)
  const minC = Math.min(...crosses), maxC = Math.max(...crosses), span = Math.max(1, maxC - minC)
  tt.forEach((v, id) => {
    if (id === rootId) return
    const cross = v.cross - rootCross
    if (layout === 'tree-down') result.push({ id, x: root.x + cross, y: root.y + v.depth * LEVEL })
    else if (layout === 'tree-right') result.push({ id, x: root.x + v.depth * LEVEL, y: root.y + cross })
    else { // radial
      const ang = ((v.cross - minC) / span) * Math.PI * 1.85 - Math.PI * 0.925
      const rad = v.depth * LEVEL
      result.push({ id, x: root.x + rad * Math.sin(ang), y: root.y - rad * Math.cos(ang) })
    }
  })
  return result
}

// Arrange a flat set of nodes (no parent) around their centroid. layout: 'row'|'column'|'grid'|'circle'.
export function arrangeNodes(ids, layout, positions, opts = {}) {
  const GAP = opts.gap || 120
  const n = ids.length
  if (!n) return []
  const pts = ids.map(id => positions.get(id) || { x: 0, y: 0 })
  const cx = pts.reduce((s, p) => s + p.x, 0) / n
  const cy = pts.reduce((s, p) => s + p.y, 0) / n
  const out = []
  if (layout === 'row') ids.forEach((id, i) => out.push({ id, x: cx + (i - (n - 1) / 2) * GAP, y: cy }))
  else if (layout === 'column') ids.forEach((id, i) => out.push({ id, x: cx, y: cy + (i - (n - 1) / 2) * GAP }))
  else if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt(n)); const rows = Math.ceil(n / cols)
    ids.forEach((id, i) => { const r = Math.floor(i / cols), c = i % cols; out.push({ id, x: cx + (c - (cols - 1) / 2) * GAP, y: cy + (r - (rows - 1) / 2) * GAP }) })
  } else { // circle
    const R = Math.max(GAP, (n * GAP) / (2 * Math.PI))
    ids.forEach((id, i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2; out.push({ id, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }) })
  }
  return out
}

export const SUBTREE_LAYOUTS = [
  { key: 'radial', label: 'Radial' },
  { key: 'star', label: 'Star' },
  { key: 'balanced', label: 'Balanced ↔' },
  { key: 'tree-down', label: 'Tree ↓' },
  { key: 'tree-right', label: 'Tree →' },
]
export const FLAT_LAYOUTS = [
  { key: 'row', label: 'Row' },
  { key: 'column', label: 'Column' },
  { key: 'grid', label: 'Grid' },
  { key: 'circle', label: 'Circle' },
]
