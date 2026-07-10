import { useRef, useState, useEffect, useMemo } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'

// Multi-pack / multi-tree CANVAS (feature #1). One shared pannable canvas hosts several independent
// clusters. Two kinds:
//   • "Circle pack" — groups nodes by a tag property into nested, non-overlapping bubbles.
//   • "Property tree" — a force-directed tree: property name = root, its values = 1st generation,
//     the items holding each value = 2nd generation (leaves). Drag a leaf onto another value to retag.
// Add with "+ Add" → pick a kind + property. Drag a cluster's header to move it. Retag by dragging an
// item between groups within a cluster. Layout is saved on the active view (syncs across devices).

const NODE_COLORS = ['#7c8cff', '#4fd1c5', '#f6ad55', '#fc8181', '#b794f4', '#68d391', '#f6e05e', '#63b3ed', '#f687b3', '#a0aec0']
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const radiusFor = (label) => { const len = String(label || '').replace(/\s+/g, ' ').trim().length; return Math.max(28, Math.min(60, 22 + Math.sqrt(Math.max(len, 4)) * 6.2)) }
const hexLum = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0.35; const n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255; const f = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let cur = ''
  const pushLong = w => { while (w.length > maxChars) { lines.push(w.slice(0, maxChars)); w = w.slice(maxChars) } return w }
  for (let w of words) { if (w.length > maxChars) { if (cur) { lines.push(cur); cur = '' } w = pushLong(w) } if (!cur) cur = w; else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w; else { lines.push(cur); cur = w } }
  if (cur) lines.push(cur); return lines.length ? lines : ['']
}
const EMPTY = []

export default function PackBoard({ projectId }) {
  const nodes = useGraphStore(s => s.nodes)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const setNodeProp = useGraphStore(s => s.setNodeProp)
  const setBoardSystems = useGraphStore(s => s.setBoardSystems)
  const tagDefs = propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect')

  const svgRef = useRef(null), gRef = useRef(null), zoomRef = useRef(null)
  const [tf, setTf] = useState(d3.zoomIdentity)
  const [systems, setSystems] = useState([])   // working copy: [{ id, propId, x, y, kind }]
  const [adding, setAdding] = useState(false)

  const activeView = views.find(v => v.id === activeViewId)

  const decorColor = useMemo(() => {
    const np = activeView?.nodeProps || {}
    return id => { const p = np[id] || {}; return (p.fillColor && p.fillColor !== 'none' && p.fillColor !== 'transparent') ? p.fillColor : null }
  }, [activeView])
  // Full graph-view cosmetics for a node (so tree leaves mirror the graph): fill, stroke, dash, shape,
  // scale, emoji, text color — read from the active view's nodeProps.
  const decorOf = useMemo(() => {
    const np = activeView?.nodeProps || {}
    return id => {
      const p = np[id] || {}
      const shape = p.shape && !['frame', '3d', 'image', 'none'].includes(p.shape) ? p.shape : null
      return {
        fill: (p.fillColor && p.fillColor !== 'none' && p.fillColor !== 'transparent') ? p.fillColor : null,
        textColor: p.textColor || null,
        stroke: (p.strokeColor && p.strokeColor !== 'none') ? p.strokeColor : null,
        strokeWidth: p.strokeWidth,
        strokeDash: p.strokeDash,
        shape,
        scale: p.scale || 1,
        emoji: (p.nodeEmojis || [])[0] || null,
      }
    }
  }, [activeView])
  const nodeVisible = (id) => (activeView?.nodeProps?.[id]?.visible !== false)

  // Load layout from the active view; one-time migrate legacy localStorage layout into the view.
  useEffect(() => {
    if (!activeView) return
    if (Array.isArray(activeView.boardSystems)) { setSystems(activeView.boardSystems); return }
    let legacy = null
    try { const raw = localStorage.getItem(`pim:board:${projectId}`); if (raw) legacy = JSON.parse(raw) } catch { /* ignore */ }
    if (legacy && legacy.length) { setSystems(legacy); setBoardSystems(legacy); persist(legacy) }
    else setSystems([])
  }, [activeViewId]) // eslint-disable-line

  const persist = (next) => {
    if (!projectId) return
    const s = useGraphStore.getState()
    const views2 = s.views.map(v => v.id === s.activeViewId ? { ...v, boardSystems: next } : v)
    saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: views2, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e))
  }
  // Commit to store + DB (add / remove / move-end). Move-drag itself stays local for smoothness.
  const commit = (next) => { setSystems(next); setBoardSystems(next); persist(next) }

  useEffect(() => {
    if (!svgRef.current) return
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.15, 4])
      .filter(e => { if (e.type === 'mousedown' && e.target?.closest?.('[data-bubble],[data-syshead]')) return false; return !e.ctrlKey && !e.button })
      .on('zoom', e => setTf(e.transform))
    zoomRef.current = zoom; sel.call(zoom)
    return () => sel.on('.zoom', null)
  }, [])

  const toWorld = (ev) => { const g = gRef.current, svg = svgRef.current; const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const l = pt.matrixTransform(g.getScreenCTM().inverse()); return { x: l.x, y: l.y } }

  const addSystem = (propId, kind) => {
    const n = systems.length
    const x = 300 + (n % 3) * 640, y = 300 + Math.floor(n / 3) * 580
    commit([...systems, { id: crypto.randomUUID(), propId, x, y, kind }])
    // Leave the menu open so several packs/trees can be added in a row; click away to dismiss.
  }
  const removeSystem = (id) => commit(systems.filter(s => s.id !== id))
  const systemsRef = useRef(systems); systemsRef.current = systems
  const moveSystem = (id, x, y) => setSystems(prev => prev.map(s => s.id === id ? { ...s, x, y } : s))
  const commitMove = () => commit(systemsRef.current)   // latest moved positions

  const retag = (propId, nodeId, sourceOpt, targetOpt, additive) => {
    const def = propertyDefs.find(d => d.id === propId); if (!def) return
    const node = useGraphStore.getState().nodes.find(n => n.id === nodeId)
    const raw = node?.props?.[propId]
    let value
    if (def.type === 'multiSelect') {
      let tags = Array.isArray(raw) ? [...raw] : (raw ? [raw] : [])
      if (!additive && sourceOpt && sourceOpt !== '__untagged__') tags = tags.filter(x => x !== sourceOpt)
      if (targetOpt !== '__untagged__' && !tags.includes(targetOpt)) tags.push(targetOpt)
      value = tags
    } else value = targetOpt === '__untagged__' ? null : targetOpt
    setNodeProp(nodeId, propId, value)
    if (projectId) { const s = useGraphStore.getState(); saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e)) }
  }

  const visibleNodes = useMemo(() => nodes.filter(n => nodeVisible(n.id)), [nodes, activeView]) // eslint-disable-line

  return (
    <div style={styles.wrap} onContextMenu={e => e.preventDefault()}>
      <div style={styles.toolbar}>
        <div style={{ position: 'relative' }}>
          <button style={styles.addBtn} onClick={() => setAdding(o => !o)} disabled={!tagDefs.length}>+ Add</button>
          {adding && (<>
            <div style={styles.backdrop} onClick={() => setAdding(false)} />
            <div style={styles.menu} onClick={e => e.stopPropagation()}>
              {!tagDefs.length && <div style={{ ...styles.item, color: '#8090b8' }}>No Select/Tags property</div>}
              {tagDefs.length > 0 && <>
                <div style={styles.mlabel}>◎ Circle pack — group by</div>
                {tagDefs.map(d => (<div key={'p' + d.id} style={styles.item} onClick={() => addSystem(d.id, 'pack')}>{d.name}</div>))}
                <div style={{ ...styles.mlabel, marginTop: 4 }}>⌥ Property tree — branch by</div>
                {tagDefs.map(d => (<div key={'t' + d.id} style={styles.item} onClick={() => addSystem(d.id, 'tree')}>{d.name}</div>))}
              </>}
            </div>
          </>)}
        </div>
        <span style={{ color: '#8090b8', fontSize: '0.74rem' }}>{systems.length} cluster{systems.length === 1 ? '' : 's'} · pick from the menu repeatedly to add more · drag a header to move · scroll = zoom · drag empty = pan</span>
      </div>
      {!systems.length && <div style={styles.empty}>Nothing here yet. Click <b style={{ color: '#8ab4ff' }}>+ Add</b> and pick a circle pack or a property tree.</div>}
      <svg ref={svgRef} style={styles.svg}>
        <g ref={gRef} transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
          {systems.map(sys => {
            const def = propertyDefs.find(d => d.id === sys.propId)
            if (!def) return null
            const common = {
              key: sys.id, sys, def, nodes: visibleNodes, decorColor, decorOf, toWorld,
              onRetag: (nid, so, to, add) => retag(sys.propId, nid, so, to, add),
              onMove: moveSystem, onCommitMove: commitMove, onRemove: () => removeSystem(sys.id),
            }
            return sys.kind === 'tree' ? <TreeCluster {...common} /> : <Cluster {...common} />
          })}
        </g>
      </svg>
    </div>
  )
}

// One independent pack cluster, positioned at (sys.x, sys.y) on the shared canvas, running its own
// force layout in LOCAL coordinates (centered on 0,0). Mirrors the proven single-pack mechanics.
function Cluster({ sys, def, nodes, decorColor, toWorld, onRetag, onMove, onCommitMove, onRemove }) {
  const simRef = useRef(null), packSimRef = useRef(null)
  const bubblesRef = useRef([]), packsRef = useRef([]), groupsRef = useRef([])
  const heldRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [held, setHeld] = useState(() => new Set())
  const [hover, setHover] = useState(null)

  const build = () => {
    const opts = def.options || []
    const groups = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(groups.map((g, i) => [g.opt, i]))
    const raw = []
    nodes.forEach(n => {
      const v = n.props?.[def.id]
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
      const valid = ids.filter(id => idx.has(id))
      const color = decorColor?.(n.id) || NODE_COLORS[hashStr(String(n.id)) % NODE_COLORS.length]
      const label = n.label || '(untitled)'
      if (!valid.length) raw.push({ nodeId: n.id, opt: '__untagged__', group: -1, label, color })
      else valid.forEach(id => raw.push({ nodeId: n.id, opt: id, group: idx.get(id), label, color }))
    })
    raw.forEach(b => { b.key = b.nodeId + '@' + b.opt; b.r = radiusFor(b.label) })
    return { groups, bubbles: raw }
  }
  const structureKey = useMemo(() => {
    const opt = (def.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows
  }, [nodes, def])

  useEffect(() => {
    const packSim = d3.forceSimulation([])
      .force('x', d3.forceX(0).strength(0.05)).force('y', d3.forceY(0).strength(0.05))
      .force('collide', d3.forceCollide(p => p.r + 6).strength(1).iterations(3))
      .alphaDecay(0.03).velocityDecay(0.62).on('tick', () => {
        const ps = packsRef.current
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j]; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 6
          if (d < min) { const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d; a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
        }
        setTick(t => t + 1)
      })
    packSimRef.current = packSim
    const sim = d3.forceSimulation([]).force('charge', d3.forceManyBody().strength(-5))
      .force('collide', d3.forceCollide(b => b.r + 2).strength(0.9)).alphaDecay(0.02).velocityDecay(0.55)
      .on('tick', () => {
        const packs = packsRef.current, h = heldRef.current, bs = bubblesRef.current
        for (let pass = 0; pass < 3; pass++) {
          for (const b of bs) {
            if (b.fx != null || h.has(b.key)) continue
            const own = b.group >= 0 ? packs[b.group] : null
            for (const c of packs) { if (c === own) continue; const dx = b.x - c.x, dy = b.y - c.y, d = Math.hypot(dx, dy), min = c.r + b.r + 2; if (d < min) { const dd = d || 1; b.x = c.x + dx / dd * min; b.y = c.y + dy / dd * min; b.vx *= 0.4; b.vy *= 0.4 } }
            if (own) { const dx = b.x - own.x, dy = b.y - own.y, d = Math.hypot(dx, dy) || 1, max = Math.max(0, own.r - b.r - 2); if (d > max) { b.x = own.x + dx / d * max; b.y = own.y + dy / d * max; b.vx *= 0.4; b.vy *= 0.4 } }
          }
          for (let i = 0; i < bs.length; i++) { const a = bs[i]; for (let j = i + 1; j < bs.length; j++) { const b = bs[j]; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 1.5; if (d < min) { const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d; const af = a.fx != null || h.has(a.key), bf = b.fx != null || h.has(b.key); if (af && !bf) { b.x += ux * push; b.y += uy * push } else if (bf && !af) { a.x -= ux * push; a.y -= uy * push } else if (!af && !bf) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 } } } }
        }
        for (const p of packs) {
          // Exclude the bubble being dragged so the pack doesn't grow to chase it out of the circle
          // (that would stop a drag-out from ever reading as "outside" → no untag).
          let cx = 0, cy = 0, n = 0
          for (const b of bs) if (b.group === p.gi && !h.has(b.key)) { cx += b.x; cy += b.y; n++ }
          if (n) { cx /= n; cy /= n; p.x += (cx - p.x) * 0.2; p.y += (cy - p.y) * 0.2; let md = 0; for (const b of bs) if (b.group === p.gi && !h.has(b.key)) { const d = Math.hypot(b.x - p.x, b.y - p.y) + b.r; if (d > md) md = d } p.r += ((md + 6) - p.r) * 0.25 } else p.r += (42 - p.r) * 0.25
        }
        setTick(t => t + 1)
      })
    simRef.current = sim
    return () => { packSim.stop(); sim.stop() }
  }, [])

  useEffect(() => {
    const { groups, bubbles } = build()
    groupsRef.current = groups
    const gc = groups.map(() => ({ r: 60 }))
    d3.packSiblings(gc); const enc = d3.packEnclose(gc) || { x: 0, y: 0 }
    const prev = new Map((packsRef.current || []).map(p => [p.opt, p]))
    const packs = groups.map((g, gi) => {
      const ex = prev.get(g.opt); if (ex) { ex.gi = gi; ex.name = g.name; ex.color = g.color; return ex }
      return { gi, opt: g.opt, name: g.name, color: g.color, r: 60, x: gc[gi].x - enc.x, y: gc[gi].y - enc.y }
    })
    packsRef.current = packs
    const prevB = bubblesRef.current || [], byKey = new Map(prevB.map(b => [b.key, b])), byNode = new Map()
    prevB.forEach(b => { if (!byNode.has(b.nodeId)) byNode.set(b.nodeId, b) })
    const next = bubbles.map(d => {
      const ex = byKey.get(d.key); if (ex) { ex.group = d.group; ex.r = d.r; ex.color = d.color; ex.label = d.label; return ex }
      const seed = byNode.get(d.nodeId); const c = d.group >= 0 ? packs[d.group] : { x: 0, y: 0 }; const j = (hashStr(d.key) % 22) - 11
      return { ...d, x: seed?.x ?? c.x + j, y: seed?.y ?? c.y + j, vx: 0, vy: 0 }
    })
    bubblesRef.current = next
    const ps = packSimRef.current, sm = simRef.current; if (!ps || !sm) return
    ps.nodes(packs); ps.alpha(0.5).restart()
    sm.nodes(next)
    sm.force('x', d3.forceX(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].x : 0).strength(b => b.group >= 0 ? 0.5 : 0.05))
    sm.force('y', d3.forceY(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].y : 0).strength(b => b.group >= 0 ? 0.5 : 0.05))
    sm.alpha(0.7).restart(); setTick(t => t + 1)
  }, [structureKey]) // eslint-disable-line

  const setHeldKeys = (s) => { heldRef.current = s; setHeld(s) }
  const local = (ev) => { const p = toWorld(ev); return { x: p.x - sys.x, y: p.y - sys.y } }   // canvas world → cluster-local
  const dropTarget = (p) => { let best = null, bd = Infinity; packsRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } }); const c = packsRef.current[best]; if (best == null || !c) return -1; return Math.hypot(p.x - c.x, p.y - c.y) > c.r + 30 ? -1 : best }

  const startDrag = (e, b) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current; const start = local(e)
    b.fx = b.x; b.fy = b.y; setHeldKeys(new Set([b.key])); sim.alphaTarget(0.3).restart()
    const move = ev => { const p = local(ev); b.fx = p.x; b.fy = p.y; b.x = p.x; b.y = p.y; setHover(dropTarget(p)); setTick(t => t + 1) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = local(ev); const tg = dropTarget(p); b.fx = null; b.fy = null; setHeldKeys(new Set()); setHover(null); sim.alphaTarget(0)
      const groups = groupsRef.current; const targetOpt = tg < 0 ? '__untagged__' : groups[tg].opt
      if (Math.hypot(p.x - start.x, p.y - start.y) > 4 && (tg < 0 ? b.opt !== '__untagged__' : targetOpt !== b.opt)) onRetag(b.nodeId, b.opt, targetOpt, false)
      else sim.alpha(0.3).restart()
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const startHeadDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = sys.x - p0.x, oy = sys.y - p0.y
    const move = ev => { const p = toWorld(ev); onMove(sys.id, p.x + ox, p.y + oy) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); onCommitMove() }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const bubbles = bubblesRef.current, packs = packsRef.current
  const dragging = held.size > 0
  const bounds = packs.reduce((a, p) => ({ minY: Math.min(a.minY, p.y - p.r), minX: Math.min(a.minX, p.x - p.r), maxX: Math.max(a.maxX, p.x + p.r) }), { minY: 0, minX: 0, maxX: 0 })
  const headY = (packs.length ? bounds.minY : 0) - 46

  return (
    <g transform={`translate(${sys.x},${sys.y})`}>
      <ClusterHeader def={def} kind="pack" cx={(bounds.minX + bounds.maxX) / 2} y={headY} onHead={startHeadDrag} onRemove={onRemove} />
      {packs.map(p => {
        const count = bubbles.filter(b => b.group === p.gi).length
        const isT = dragging && hover === p.gi
        return (
          <g key={'o' + p.gi} pointerEvents="none">
            <circle cx={p.x} cy={p.y} r={p.r} fill={p.color + '1e'} stroke={isT ? '#7fd8a8' : p.color} strokeWidth={isT ? 3.5 : 2} />
            <text x={p.x} y={p.y - p.r - 7} textAnchor="middle" fontSize={17} fontWeight={800} fill={isT ? '#7fd8a8' : p.color}
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 5, strokeLinejoin: 'round' }}>{p.name} · {count}</text>
          </g>
        )
      })}
      {bubbles.map(b => <Bubble key={b.key} b={b} held={held.has(b.key)} onDown={e => startDrag(e, b)} />)}
    </g>
  )
}

// Property tree: root (property) → value nodes (1st gen) → item leaves (2nd gen). Force-directed in
// LOCAL coordinates with the root pinned at 0,0; values held on a ring; leaves pulled to their value.
// Drag a leaf onto another value node to retag (same semantics as the pack cluster).
function TreeCluster({ sys, def, nodes, decorOf, toWorld, onRetag, onMove, onCommitMove, onRemove }) {
  const simRef = useRef(null)
  const fnodesRef = useRef([]), valuesRef = useRef([])
  const heldRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [held, setHeld] = useState(() => new Set())
  const [hover, setHover] = useState(null)

  const build = () => {
    const opts = def.options || []
    const values = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(values.map((v, i) => [v.opt, i]))
    const leaves = []
    let hasUntagged = false
    nodes.forEach(n => {
      const v = n.props?.[def.id]
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
      const valid = ids.filter(id => idx.has(id))
      const dec = decorOf?.(n.id) || {}
      const color = dec.fill || NODE_COLORS[hashStr(String(n.id)) % NODE_COLORS.length]
      const label = n.label || '(untitled)'
      // Size and collision radius honour the node's graph-view shape + scale so leaves mirror the graph.
      const scl = Math.min(1.8, Math.max(0.65, dec.scale || 1))
      const baseR = radiusFor(label) * 0.7 * scl
      const shape = dec.shape || 'circle'
      const bound = (shape === 'ellipse' || shape === 'rect' || shape === 'roundrect') ? baseR * 1.34 : shape === 'diamond' ? baseR * 1.16 : baseR
      const mk = (opt) => ({ nodeId: n.id, opt, label, color, decor: dec, shape, baseR, r: bound })
      if (!valid.length) { hasUntagged = true; leaves.push(mk('__untagged__')) }
      else valid.forEach(id => leaves.push(mk(id)))
    })
    if (hasUntagged) values.push({ opt: '__untagged__', name: '(untagged)', color: '#6b7394' })
    return { values, leaves }
  }
  const structureKey = useMemo(() => {
    const opt = (def.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows
  }, [nodes, def])

  useEffect(() => {
    const sim = d3.forceSimulation([])
      .force('charge', d3.forceManyBody().strength(d => d.kind === 'leaf' ? -60 : -200))
      .force('link', d3.forceLink([]).id(d => d.id).distance(l => l.kind === 'rv' ? 190 : 78).strength(l => l.kind === 'rv' ? 0.08 : 0.5))
      .force('collide', d3.forceCollide(d => d.r + 4).strength(0.9).iterations(2))
      .force('radial', d3.forceRadial(d => d.kind === 'value' ? 200 : 0, 0, 0).strength(d => d.kind === 'value' ? 0.55 : 0))
      .alphaDecay(0.025).velocityDecay(0.5)
      .on('tick', () => {
        const fns = fnodesRef.current, h = heldRef.current
        const root = fns.find(f => f.kind === 'root'); if (root) { root.x = 0; root.y = 0; root.fx = 0; root.fy = 0 }
        // Hard node separation so leaves never overlap (force alone leaves slow residual overlap).
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < fns.length; i++) { const a = fns[i]; if (a.kind === 'root') continue; for (let j = i + 1; j < fns.length; j++) { const b = fns[j]; if (b.kind === 'root') continue; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 2; if (d < min) { const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d; const af = a.fx != null || h.has(a.id), bf = b.fx != null || h.has(b.id); if (af && !bf) { b.x += ux * push; b.y += uy * push } else if (bf && !af) { a.x -= ux * push; a.y -= uy * push } else if (!af && !bf) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 } } } }
        }
        setTick(t => t + 1)
      })
    simRef.current = sim
    return () => sim.stop()
  }, [])

  useEffect(() => {
    const { values, leaves } = build()
    const prev = new Map((fnodesRef.current || []).map(f => [f.id, f]))
    const root = prev.get('__root__') || { id: '__root__', kind: 'root', x: 0, y: 0, fx: 0, fy: 0 }
    root.r = Math.max(34, Math.min(52, 24 + Math.sqrt(def.name.length) * 5)); root.name = def.name
    const vnodes = values.map((v, i) => {
      const id = 'v:' + v.opt; const ex = prev.get(id)
      const ang = (i / Math.max(1, values.length)) * Math.PI * 2
      const base = ex || { id, kind: 'value', x: Math.cos(ang) * 200, y: Math.sin(ang) * 200, vx: 0, vy: 0 }
      base.opt = v.opt; base.name = v.name; base.color = v.color; base.r = Math.max(26, Math.min(46, 18 + Math.sqrt(v.name.length) * 4.5))
      return base
    })
    const vById = new Map(vnodes.map(v => [v.opt, v]))
    const lnodes = leaves.map(d => {
      const id = 'l:' + d.nodeId + '@' + d.opt; const ex = prev.get(id)
      const parent = vById.get(d.opt) || root
      const j = (hashStr(id) % 40) - 20
      const base = ex || { id, kind: 'leaf', x: parent.x + j, y: parent.y + j, vx: 0, vy: 0 }
      base.opt = d.opt; base.nodeId = d.nodeId; base.label = d.label; base.color = d.color
      base.decor = d.decor; base.shape = d.shape; base.baseR = d.baseR; base.r = d.r
      return base
    })
    const fns = [root, ...vnodes, ...lnodes]
    fnodesRef.current = fns; valuesRef.current = vnodes
    const links = [
      ...vnodes.map(v => ({ source: root.id, target: v.id, kind: 'rv' })),
      ...lnodes.map(l => ({ source: 'v:' + l.opt, target: l.id, kind: 'vl' })),
    ]
    const sm = simRef.current; if (!sm) return
    sm.nodes(fns)
    sm.force('link').links(links)
    sm.alpha(0.8).restart(); setTick(t => t + 1)
  }, [structureKey]) // eslint-disable-line

  const setHeldKeys = (s) => { heldRef.current = s; setHeld(s) }
  const local = (ev) => { const p = toWorld(ev); return { x: p.x - sys.x, y: p.y - sys.y } }
  const dropTarget = (p) => { let best = null, bd = Infinity; valuesRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } }); const c = valuesRef.current[best]; if (best == null || !c) return -1; return Math.hypot(p.x - c.x, p.y - c.y) > c.r + 40 ? -1 : best }

  const startDrag = (e, b) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current; const start = local(e)
    b.fx = b.x; b.fy = b.y; setHeldKeys(new Set([b.id])); sim.alphaTarget(0.3).restart()
    const move = ev => { const p = local(ev); b.fx = p.x; b.fy = p.y; b.x = p.x; b.y = p.y; setHover(dropTarget(p)); setTick(t => t + 1) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = local(ev); const tg = dropTarget(p); b.fx = null; b.fy = null; setHeldKeys(new Set()); setHover(null); sim.alphaTarget(0)
      const vals = valuesRef.current; const targetOpt = tg < 0 ? '__untagged__' : vals[tg].opt
      if (Math.hypot(p.x - start.x, p.y - start.y) > 4 && targetOpt !== b.opt) onRetag(b.nodeId, b.opt, targetOpt, false)
      else sim.alpha(0.3).restart()
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const startHeadDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = sys.x - p0.x, oy = sys.y - p0.y
    const move = ev => { const p = toWorld(ev); onMove(sys.id, p.x + ox, p.y + oy) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); onCommitMove() }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const fns = fnodesRef.current, values = valuesRef.current
  const root = fns.find(f => f.kind === 'root')
  const leaves = fns.filter(f => f.kind === 'leaf')
  const dragging = held.size > 0
  const minY = fns.reduce((m, f) => Math.min(m, f.y - f.r), 0)
  const headY = minY - 44
  const countByOpt = {}; leaves.forEach(l => { countByOpt[l.opt] = (countByOpt[l.opt] || 0) + 1 })

  return (
    <g transform={`translate(${sys.x},${sys.y})`}>
      <ClusterHeader def={def} kind="tree" cx={0} y={headY} onHead={startHeadDrag} onRemove={onRemove} />
      {/* links: root→value then value→leaf */}
      <g pointerEvents="none">
        {root && values.map(v => (
          <line key={'e' + v.id} x1={root.x} y1={root.y} x2={v.x} y2={v.y} stroke={v.color} strokeOpacity={0.5} strokeWidth={2} />
        ))}
        {leaves.map(l => { const v = values.find(x => x.opt === l.opt); if (!v) return null
          return <line key={'e' + l.id} x1={v.x} y1={v.y} x2={l.x} y2={l.y} stroke={l.color} strokeOpacity={0.28} strokeWidth={1.4} /> })}
      </g>
      {/* root */}
      {root && (
        <g pointerEvents="none" transform={`translate(${root.x},${root.y})`}>
          <circle r={root.r} fill="#141428" stroke="#7c8cff" strokeWidth={2.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight={800} fill="#c5d0ff"
            style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 4, strokeLinejoin: 'round' }}>
            {wrapText(root.name, 9).slice(0, 3).map((ln, i, a) => <tspan key={i} x={0} y={(i - (a.length - 1) / 2) * 14}>{ln}</tspan>)}
          </text>
        </g>
      )}
      {/* value nodes (1st generation) */}
      {values.map(v => {
        const isT = dragging && hover != null && values[hover] === v
        return (
          <g key={v.id} pointerEvents="none" transform={`translate(${v.x},${v.y})`}>
            <circle r={v.r} fill={v.color + '2a'} stroke={isT ? '#7fd8a8' : v.color} strokeWidth={isT ? 3.5 : 2.4} />
            <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fontWeight={800} fill={isT ? '#7fd8a8' : '#e8eeff'}
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 4, strokeLinejoin: 'round' }}>
              {wrapText(v.name, 9).slice(0, 2).map((ln, i, a) => <tspan key={i} x={0} y={(i - (a.length - 1) / 2) * 13 - 4}>{ln}</tspan>)}
              <tspan x={0} y={12} fontSize={10} fillOpacity={0.85}>· {countByOpt[v.opt] || 0}</tspan>
            </text>
          </g>
        )
      })}
      {/* item leaves (2nd generation) — real graph nodes with their cosmetics; draggable to retag */}
      {leaves.map(l => <LeafNode key={l.id} b={l} held={held.has(l.id)} onDown={e => startDrag(e, l)} />)}
    </g>
  )
}

// Shared draggable header chip for a cluster.
function ClusterHeader({ def, kind, cx, y, onHead, onRemove }) {
  const glyph = kind === 'tree' ? '⌥' : '◎'
  return (
    <g data-syshead="1" transform={`translate(${cx},${y})`} style={{ cursor: 'grab' }} onMouseDown={onHead}>
      <rect x={-118} y={-16} width={236} height={30} rx={7} fill="#141428" stroke="#2d3a6a" />
      <text x={-104} y={4} fontSize={13} fill="#8ab4ff">{glyph}</text>
      <text x={-86} y={4} fontSize={15} fontWeight={700} fill="#c5d0ff">{def.name}</text>
      <text x={100} y={5} fontSize={16} fill="#f87171" textAnchor="middle" style={{ cursor: 'pointer' }}
        onMouseDown={e => { e.stopPropagation(); if (confirm(`Remove the “${def.name}” ${kind === 'tree' ? 'tree' : 'circle pack'}?`)) onRemove() }}>×</text>
    </g>
  )
}

// strokeDash → SVG dasharray (mirrors the graph's dashArray).
function dashArrayB(dash, sw = 1.4) {
  if (dash === 'dashed') return `${Math.max(3, sw * 2.6)},${Math.max(2, sw * 1.8)}`
  if (dash === 'dotted') return `${Math.max(0.4, sw * 0.55)},${Math.max(2, sw * 1.9)}`
  return undefined
}

// A tree leaf = a real graph node rendered with its graph-view cosmetics (fill/shape/stroke/dash/emoji).
function LeafNode({ b, held, onDown }) {
  const dec = b.decor || {}
  const shape = b.shape || 'circle'
  const s = b.baseR || b.r
  const fill = b.color
  const light = hexLum(fill) > 0.55
  const stroke = held ? '#fff' : (dec.stroke || 'rgba(232,238,255,0.4)')
  const sw = held ? 3 : (dec.strokeWidth || 1.2)
  const dash = held ? undefined : dashArrayB(dec.strokeDash, sw)
  const tf = dec.textColor || (light ? '#0c0c1a' : '#f2f5ff')
  const emoji = dec.emoji
  const fs = Math.max(8, s * 0.32), maxChars = Math.max(5, Math.floor((1.7 * s) / (fs * 0.56)))
  const lines = wrapText(b.label, maxChars).slice(0, 4), lh = fs * 1.05
  const yStart = (emoji ? fs * 0.5 : 0) - (lines.length - 1) / 2 * lh
  let body
  if (shape === 'ellipse') body = <ellipse rx={s * 1.35} ry={s * 0.82} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
  else if (shape === 'roundrect') { const hw = s * 1.3, hh = s * 0.82; body = <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} rx={hh * 0.45} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} /> }
  else if (shape === 'rect') { const hw = s * 1.3, hh = s * 0.82; body = <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} /> }
  else if (shape === 'diamond') body = <polygon points={`0,${-s * 1.15} ${s * 1.15},0 0,${s * 1.15} ${-s * 1.15},0`} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
  else body = <circle r={s} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
  return (
    <g data-bubble="1" transform={`translate(${b.x || 0},${b.y || 0})`} style={{ cursor: 'grab' }} onMouseDown={onDown}>
      {body}
      {emoji && <text textAnchor="middle" dominantBaseline="middle" fontSize={s * 0.7} y={-s * 0.42} pointerEvents="none">{emoji}</text>}
      <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={tf} pointerEvents="none"
        style={{ fontWeight: 700, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
        {lines.map((ln, i) => <tspan key={i} x={0} y={yStart + i * lh}>{ln}</tspan>)}
      </text>
    </g>
  )
}

// A draggable item bubble (used by both pack and tree clusters).
function Bubble({ b, held, onDown }) {
  const light = hexLum(b.color) > 0.55, tf = light ? '#0c0c1a' : '#f2f5ff'
  const fs = Math.max(8, b.r * 0.3), maxChars = Math.max(5, Math.floor((1.7 * b.r) / (fs * 0.56)))
  const lines = wrapText(b.label, maxChars).slice(0, 5), lh = fs * 1.05, y0 = -(lines.length - 1) / 2 * lh
  return (
    <g data-bubble="1" transform={`translate(${b.x || 0},${b.y || 0})`} style={{ cursor: 'grab' }} onMouseDown={onDown}>
      <circle r={b.r} fill={b.color} fillOpacity={0.96} stroke={held ? '#fff' : 'rgba(232,238,255,0.4)'} strokeWidth={held ? 3.5 : 1.2} />
      <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={tf} pointerEvents="none"
        style={{ fontWeight: 700, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
        {lines.map((ln, i) => <tspan key={i} x={0} y={y0 + i * lh}>{ln}</tspan>)}
      </text>
    </g>
  )
}

const styles = {
  wrap: { position: 'relative', height: '100%', width: '100%', background: '#0c0c1a', overflow: 'hidden' },
  svg: { width: '100%', height: '100%', display: 'block', cursor: 'grab' },
  toolbar: { position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', gap: 12, alignItems: 'center' },
  addBtn: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 210, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  mlabel: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
}
