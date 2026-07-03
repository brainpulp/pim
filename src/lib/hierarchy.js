// Build a d3.hierarchy-ready tree from the PIM graph (nodes + edges).
// The mind map is edge-based and can technically be a DAG; for hierarchy layouts we
// project it to a strict tree: each node's parent = its first incoming edge's source.
// Cycles are broken (a node is placed once); anything unreachable from a root is
// re-attached to the synthetic root so no node is silently dropped.

// `decorOf(id) → { color, stroke, strokeWidth, emojis }` supplies each node's visual
// decorations (from the active view) so hierarchy views can mirror the mind map's look.
export function buildTree(nodes, edges, { decorOf, sizeBy } = {}) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const parentOf = new Map()
  edges.forEach(e => {
    if (byId.has(e.source) && byId.has(e.target) && !parentOf.has(e.target)) parentOf.set(e.target, e.source)
  })
  const childrenOf = new Map(nodes.map(n => [n.id, []]))
  parentOf.forEach((p, c) => { if (childrenOf.has(p)) childrenOf.get(p).push(c) })

  const valueOf = (n) => {
    if (sizeBy) { const v = Number(n?.props?.[sizeBy]); if (Number.isFinite(v) && v > 0) return v }
    return 1
  }
  const seen = new Set()
  const make = (id) => {
    if (seen.has(id)) return null   // break cycles / multi-parent
    seen.add(id)
    const n = byId.get(id)
    const kids = (childrenOf.get(id) || []).map(make).filter(Boolean)
    const base = { id, label: n?.label || '(untitled)', ...(decorOf?.(id) || {}) }
    return kids.length ? { ...base, children: kids } : { ...base, value: valueOf(n) }
  }
  const rootIds = nodes.filter(n => !parentOf.has(n.id)).map(n => n.id)
  const children = rootIds.map(make).filter(Boolean)
  nodes.forEach(n => { if (!seen.has(n.id)) { const t = make(n.id); if (t) children.push(t) } })  // orphans/cycles
  return { id: '__root__', label: '', color: null, children: children.length ? children : [{ id: '__empty__', label: '(empty)', value: 1 }] }
}

// A synthetic hierarchy grouped by a Select/Tags property: root → option → member nodes.
// Nodes with no value for the property fall under an "(untagged)" bucket. Multi-tag nodes
// appear under each of their tags (mirrors).
export function buildTagTree(nodes, def, { decorOf, sizeBy } = {}) {
  if (!def) return { id: '__root__', label: '', children: [] }
  const valueOf = (n) => {
    if (sizeBy) { const v = Number(n?.props?.[sizeBy]); if (Number.isFinite(v) && v > 0) return v }
    return 1
  }
  const leaf = (n, suffix) => ({ id: suffix ? n.id + '@' + suffix : n.id, label: n.label || '(untitled)', ...(decorOf?.(n.id) || {}), value: valueOf(n) })
  const buckets = new Map((def.options || []).map(o => [o.id, { id: 'opt:' + o.id, label: o.name, color: o.color || null, children: [] }]))
  const untagged = { id: 'opt:__untagged__', label: '(untagged)', color: '#3a4358', children: [] }
  nodes.forEach(n => {
    const raw = n.props?.[def.id]
    const ids = Array.isArray(raw) ? raw : (raw != null && raw !== '' ? [raw] : [])
    if (!ids.length) { untagged.children.push(leaf(n)); return }
    ids.forEach(id => { const b = buckets.get(id); if (b) b.children.push(leaf(n, id)) })
  })
  const children = [...buckets.values()].filter(b => b.children.length)
  if (untagged.children.length) children.push(untagged)
  return { id: '__root__', label: '', color: null, children }
}
