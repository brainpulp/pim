// Flowchart ⇄ text (Mermaid-flavored) two-way conversion.
//
// The graph already IS a node/edge model, so a flowchart is just a view of it: each node carries a
// short stable `flowId` (readable alias used in the text) plus a shape; edges may carry a label.
// We generate Mermaid `flowchart` text from the graph and parse it back, matching nodes by flowId so
// hand-placed positions survive text edits (the caller preserves positions for survivors).
//
// Supported node shapes ⇄ brackets:
//   [ "x" ]     rectangle   → shape 'rect'      (process)
//   ( "x" )     rounded     → shape 'roundrect' (process)
//   { "x" }     diamond     → shape 'diamond'   (decision)
//   ([ "x" ])   stadium     → shape 'ellipse'   (start/end)
//   (( "x" ))   circle      → shape 'circle'
// Edges: `A --> B`, `A --> |label| B`, `A --- B`. Chains `A --> B --> C` are supported.

const SHAPE_BY_KIND = { rect: 'rect', round: 'roundrect', diamond: 'diamond', stadium: 'ellipse', circle: 'circle' }

// slugify a label into a short, unique-ish flow id (letters/digits/underscore, alpha-initial).
export function slugifyFlowId(label, taken) {
  let base = String(label || 'n').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'n$1').slice(0, 18)
  if (!base) base = 'n'
  let id = base, i = 2
  while (taken.has(id)) { id = `${base}_${i++}` }
  taken.add(id)
  return id
}

function bracketFor(shape, label) {
  const t = `"${String(label ?? '').replace(/"/g, "'")}"`
  switch (shape) {
    case 'diamond': return `{${t}}`
    case 'ellipse': return `([${t}])`
    case 'circle': return `((${t}))`
    case 'roundrect': return `(${t})`
    default: return `[${t}]`   // rect / none / anything else
  }
}

// Build Mermaid text from the graph. `flowIdOf(id)` returns a node's flow alias (already ensured).
export function graphToMermaid(nodeList, edgeList, shapeOf, flowIdOf) {
  const lines = ['flowchart TD']
  const idset = new Set(nodeList.map(n => n.id))
  nodeList.forEach(n => {
    lines.push(`  ${flowIdOf(n.id)}${bracketFor(shapeOf(n.id), n.label || '')}`)
  })
  edgeList.forEach(e => {
    if (!idset.has(e.source) || !idset.has(e.target)) return
    const lbl = e.label ? ` |"${String(e.label).replace(/"/g, "'")}"|` : ''
    lines.push(`  ${flowIdOf(e.source)} -->${lbl} ${flowIdOf(e.target)}`)
  })
  return lines.join('\n')
}

// Parse one node token like `A`, `A["Start"]`, `chk{"OK?"}` → { flowId, label?, shape? }.
function parseNodeToken(tok) {
  const m = String(tok).trim().match(/^([A-Za-z0-9_]+)\s*([\s\S]*)$/)
  if (!m) return null
  const flowId = m[1]
  const rest = (m[2] || '').trim()
  if (!rest) return { flowId }
  const strip = s => s.replace(/^"|"$/g, '').replace(/^'|'$/g, '').trim()
  let kind = null, inner = null
  let mm
  if ((mm = rest.match(/^\(\[([\s\S]*)\]\)$/))) { kind = 'stadium'; inner = mm[1] }
  else if ((mm = rest.match(/^\(\(([\s\S]*)\)\)$/))) { kind = 'circle'; inner = mm[1] }
  else if ((mm = rest.match(/^\{([\s\S]*)\}$/))) { kind = 'diamond'; inner = mm[1] }
  else if ((mm = rest.match(/^\[([\s\S]*)\]$/))) { kind = 'rect'; inner = mm[1] }
  else if ((mm = rest.match(/^\(([\s\S]*)\)$/))) { kind = 'round'; inner = mm[1] }
  if (kind == null) return { flowId }
  return { flowId, label: strip(inner), shape: SHAPE_BY_KIND[kind] }
}

// Parse Mermaid flowchart text → { nodes: [{flowId,label,shape}], edges: [{source,target,label}] }.
// Node ids are flowIds (aliases); the caller maps them to real node ids.
export function parseMermaid(text) {
  const nodes = new Map()   // flowId -> {flowId,label?,shape?}
  const edges = []
  const record = (tok) => {
    const n = parseNodeToken(tok); if (!n) return null
    const prev = nodes.get(n.flowId) || { flowId: n.flowId }
    if (n.label != null) prev.label = n.label
    if (n.shape != null) prev.shape = n.shape
    nodes.set(n.flowId, prev)
    return n.flowId
  }
  String(text || '').split(/\r?\n/).forEach(raw => {
    let line = raw.trim()
    if (!line) return
    if (/^(flowchart|graph)\b/i.test(line)) return
    if (/^(subgraph|end|classDef|class|style|linkStyle|%%)/i.test(line)) return
    line = line.replace(/;+\s*$/, '')
    if (!/(-->|---)/.test(line)) { record(line); return }   // pure node definition
    // Edge chain: NODE (arrow (|label|)? NODE)+
    const arrowRe = /\s*(-->|---)\s*(?:\|([^|]*)\|)?\s*/g
    let lastIndex = 0, prevId = null, m
    // first token = substring up to the first arrow
    const firstArrow = line.match(/(-->|---)/)
    if (!firstArrow) { record(line); return }
    prevId = record(line.slice(0, firstArrow.index))
    arrowRe.lastIndex = firstArrow.index
    while ((m = arrowRe.exec(line)) !== null) {
      const label = (m[2] || '').replace(/^"|"$/g, '').trim()
      // node token runs from end of this arrow to the next arrow (or end of line)
      arrowRe.lastIndex = m.index + m[0].length
      const nextArrow = line.slice(arrowRe.lastIndex).match(/(-->|---)/)
      const end = nextArrow ? arrowRe.lastIndex + nextArrow.index : line.length
      const tok = line.slice(arrowRe.lastIndex, end)
      const curId = record(tok)
      if (prevId && curId) edges.push({ source: prevId, target: curId, label: label || undefined })
      prevId = curId
      if (!nextArrow) break
      arrowRe.lastIndex = end
      lastIndex = end
    }
    void lastIndex
  })
  return { nodes: [...nodes.values()], edges }
}

// Simple layered (top-down) layout for flowchart nodes lacking a position. Returns { [flowId]: {x,y} }.
// Roots (no incoming edge) go on the top row; each node's depth = longest path from a root.
export function layeredLayout(parsedNodes, parsedEdges, opts = {}) {
  const dx = opts.dx ?? 200, dy = opts.dy ?? 130, ox = opts.ox ?? 0, oy = opts.oy ?? 0
  const ids = parsedNodes.map(n => n.flowId)
  const incoming = {}, outgoing = {}
  ids.forEach(id => { incoming[id] = []; outgoing[id] = [] })
  parsedEdges.forEach(e => { if (outgoing[e.source]) outgoing[e.source].push(e.target); if (incoming[e.target]) incoming[e.target].push(e.source) })
  const depth = {}
  const roots = ids.filter(id => incoming[id].length === 0)
  const queue = (roots.length ? roots : ids.slice(0, 1)).map(id => (depth[id] = 0, id))
  const seen = new Set(queue)
  while (queue.length) {
    const id = queue.shift()
    outgoing[id].forEach(t => { const d = depth[id] + 1; if (depth[t] == null || d > depth[t]) depth[t] = d; if (!seen.has(t)) { seen.add(t); queue.push(t) } })
  }
  ids.forEach((id, i) => { if (depth[id] == null) depth[id] = 0 })
  // group by depth, spread horizontally
  const byDepth = {}
  ids.forEach(id => { (byDepth[depth[id]] = byDepth[depth[id]] || []).push(id) })
  const pos = {}
  Object.keys(byDepth).forEach(d => {
    const row = byDepth[d]
    row.forEach((id, i) => { pos[id] = { x: ox + (i - (row.length - 1) / 2) * dx, y: oy + Number(d) * dy } })
  })
  return pos
}
