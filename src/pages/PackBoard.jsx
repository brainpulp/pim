import { useRef, useState, useEffect, useMemo } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'

// Multi-pack / multi-tree CANVAS (feature #1, first slice). One shared pannable canvas hosts several
// independent "circle pack" clusters — each groups the same nodes by a different tag property. Add
// packs with "+ Circle pack", drag a pack's header to move its whole cluster. Retag by dragging an
// item between sub-packs within a cluster. Persisted per-project in localStorage for now.

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

export default function PackBoard({ projectId }) {
  const nodes = useGraphStore(s => s.nodes)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const setNodeProp = useGraphStore(s => s.setNodeProp)
  const tagDefs = propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect')

  const svgRef = useRef(null), gRef = useRef(null), zoomRef = useRef(null)
  const [tf, setTf] = useState(d3.zoomIdentity)
  const [systems, setSystems] = useState([])   // [{ id, propId, x, y }]
  const [adding, setAdding] = useState(false)

  const decorColor = useMemo(() => {
    const np = views.find(v => v.id === activeViewId)?.nodeProps || {}
    return id => { const p = np[id] || {}; return (p.fillColor && p.fillColor !== 'none' && p.fillColor !== 'transparent') ? p.fillColor : null }
  }, [views, activeViewId])
  const nodeVisible = (id) => (views.find(v => v.id === activeViewId)?.nodeProps?.[id]?.visible !== false)

  // Persist systems per project (localStorage first slice).
  useEffect(() => {
    if (!projectId) return
    try { const raw = localStorage.getItem(`pim:board:${projectId}`); if (raw) setSystems(JSON.parse(raw)) } catch { /* ignore */ }
  }, [projectId])
  const saveSystems = (next) => { setSystems(next); try { if (projectId) localStorage.setItem(`pim:board:${projectId}`, JSON.stringify(next)) } catch { /* ignore */ } }

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

  const addSystem = (propId) => {
    const n = systems.length
    const x = 300 + (n % 3) * 620, y = 300 + Math.floor(n / 3) * 560
    saveSystems([...systems, { id: crypto.randomUUID(), propId, x, y }])
    setAdding(false)
  }
  const removeSystem = (id) => saveSystems(systems.filter(s => s.id !== id))
  const moveSystem = (id, x, y) => { setSystems(prev => prev.map(s => s.id === id ? { ...s, x, y } : s)); }
  const commitSystems = () => { try { if (projectId) localStorage.setItem(`pim:board:${projectId}`, JSON.stringify(systems)) } catch { /* ignore */ } }

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

  const visibleNodes = useMemo(() => nodes.filter(n => nodeVisible(n.id)), [nodes, views, activeViewId]) // eslint-disable-line

  return (
    <div style={styles.wrap} onContextMenu={e => e.preventDefault()}>
      <div style={styles.toolbar}>
        <div style={{ position: 'relative' }}>
          <button style={styles.addBtn} onClick={() => setAdding(o => !o)} disabled={!tagDefs.length}>+ Circle pack</button>
          {adding && (<>
            <div style={styles.backdrop} onClick={() => setAdding(false)} />
            <div style={styles.menu} onClick={e => e.stopPropagation()}>
              <div style={styles.mlabel}>Group by tag</div>
              {tagDefs.length ? tagDefs.map(d => (
                <div key={d.id} style={styles.item} onClick={() => addSystem(d.id)}>{d.name}</div>
              )) : <div style={{ ...styles.item, color: '#8090b8' }}>No Select/Tags property</div>}
            </div>
          </>)}
        </div>
        <span style={{ color: '#8090b8', fontSize: '0.74rem' }}>{systems.length} pack{systems.length === 1 ? '' : 's'} · drag a pack’s header to move it · scroll = zoom · drag empty = pan</span>
      </div>
      {!systems.length && <div style={styles.empty}>No circle packs yet. Click <b style={{ color: '#8ab4ff' }}>+ Circle pack</b> and pick a tag property to add one.</div>}
      <svg ref={svgRef} style={styles.svg}>
        <g ref={gRef} transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
          {systems.map(sys => {
            const def = propertyDefs.find(d => d.id === sys.propId)
            if (!def) return null
            return (
              <Cluster key={sys.id} sys={sys} def={def} nodes={visibleNodes} decorColor={decorColor}
                toWorld={toWorld} onRetag={(nid, so, to, add) => retag(sys.propId, nid, so, to, add)}
                onMove={moveSystem} onCommitMove={commitSystems} onRemove={() => removeSystem(sys.id)} />
            )
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
          let cx = 0, cy = 0, n = 0
          for (const b of bs) if (b.group === p.gi) { cx += b.x; cy += b.y; n++ }
          if (n) { cx /= n; cy /= n; p.x += (cx - p.x) * 0.2; p.y += (cy - p.y) * 0.2; let md = 0; for (const b of bs) if (b.group === p.gi) { const d = Math.hypot(b.x - p.x, b.y - p.y) + b.r; if (d > md) md = d } p.r += ((md + 6) - p.r) * 0.25 } else p.r += (42 - p.r) * 0.25
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
      {/* system header (drag to move the whole cluster) */}
      <g data-syshead="1" transform={`translate(${(bounds.minX + bounds.maxX) / 2},${headY})`} style={{ cursor: 'grab' }} onMouseDown={startHeadDrag}>
        <rect x={-110} y={-16} width={220} height={30} rx={7} fill="#141428" stroke="#2d3a6a" />
        <text x={-96} y={4} fontSize={15} fontWeight={700} fill="#c5d0ff">{def.name}</text>
        <text x={92} y={5} fontSize={16} fill="#f87171" textAnchor="middle" style={{ cursor: 'pointer' }}
          onMouseDown={e => { e.stopPropagation(); if (confirm(`Remove the “${def.name}” circle pack?`)) onRemove() }}>×</text>
      </g>
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
      {bubbles.map(b => {
        const isHeld = held.has(b.key), light = hexLum(b.color) > 0.55, tf = light ? '#0c0c1a' : '#f2f5ff'
        const fs = Math.max(8, b.r * 0.3), maxChars = Math.max(5, Math.floor((1.7 * b.r) / (fs * 0.56)))
        const lines = wrapText(b.label, maxChars).slice(0, 5), lh = fs * 1.05, y0 = -(lines.length - 1) / 2 * lh
        return (
          <g key={b.key} data-bubble="1" transform={`translate(${b.x || 0},${b.y || 0})`} style={{ cursor: 'grab' }} onMouseDown={e => startDrag(e, b)}>
            <circle r={b.r} fill={b.color} fillOpacity={0.96} stroke={isHeld ? '#fff' : 'rgba(232,238,255,0.4)'} strokeWidth={isHeld ? 3.5 : 1.2} />
            <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={tf} pointerEvents="none"
              style={{ fontWeight: 700, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
              {lines.map((ln, i) => <tspan key={i} x={0} y={y0 + i * lh}>{ln}</tspan>)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

const styles = {
  wrap: { position: 'relative', height: '100%', width: '100%', background: '#0c0c1a', overflow: 'hidden' },
  svg: { width: '100%', height: '100%', display: 'block', cursor: 'grab' },
  toolbar: { position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', gap: 12, alignItems: 'center' },
  addBtn: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 190, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  mlabel: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
}
