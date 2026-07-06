import { useMemo, useState, useRef, useEffect } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'
import { buildTree } from '../lib/hierarchy'

// Two packing modes share one shell:
//  • Hierarchy (edges) → deterministic zoomable circle-pack (ref: mbostock/1747543).
//  • Group-by-tag      → CLUSTERED FORCE layout (see TagPackForce). Packs self-organise and
//    bunch tightly (d3.packSiblings); DRAG an item onto another pack to retag it — it glides
//    into place instead of the whole diagram re-laying-out. Alt-drag adds a second tag.

const D = 932                      // world size of the hierarchy pack square (SVG viewBox)
const DEPTH_FILL = ['#12122a', '#1b2452', '#26346f', '#33459a', '#4557c0', '#6f7fe0']

export default function PackView({ projectId }) {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const setNodeProp = useGraphStore(s => s.setNodeProp)
  const numberDefs = propertyDefs.filter(d => d.type === 'number')
  const tagDefs = propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect')

  const [sizeBy, setSizeBy] = useState(null)         // null = size by item count, else Number propId
  const [groupProp, setGroupProp] = useState(null)   // null = edge hierarchy, else group-by-tag propId
  const [menuOpen, setMenuOpen] = useState(false)
  const [srcMenu, setSrcMenu] = useState(false)
  const sizeLabel = sizeBy ? (propertyDefs.find(d => d.id === sizeBy)?.name || 'property') : 'items'
  const srcLabel = groupProp ? (propertyDefs.find(d => d.id === groupProp)?.name || 'tag') : 'Hierarchy'
  const groupDef = groupProp ? propertyDefs.find(d => d.id === groupProp) : null

  const decorOf = useMemo(() => {
    const np = views.find(v => v.id === activeViewId)?.nodeProps || {}
    return id => {
      const p = np[id] || {}
      const em = (p.nodeEmojis || [])[0] || null
      return { color: p.fillColor && p.fillColor !== 'none' ? p.fillColor : null,
        stroke: p.strokeColor || null, strokeWidth: p.strokeWidth || null, emoji: em }
    }
  }, [views, activeViewId])

  // ── Retag by moving an item between tag-packs (writes node.props + saves) ────
  const retag = (nodeId, sourceOpt, targetOpt, additive) => {
    const def = propertyDefs.find(d => d.id === groupProp); if (!def) return
    const node = useGraphStore.getState().nodes.find(n => n.id === nodeId)
    const raw = node?.props?.[groupProp]
    let value
    if (def.type === 'multiSelect') {
      let tags = Array.isArray(raw) ? [...raw] : (raw ? [raw] : [])
      if (!additive && sourceOpt && sourceOpt !== '__untagged__') tags = tags.filter(x => x !== sourceOpt)
      if (targetOpt !== '__untagged__' && !tags.includes(targetOpt)) tags.push(targetOpt)
      value = tags
    } else {
      value = targetOpt === '__untagged__' ? null : targetOpt
    }
    setNodeProp(nodeId, groupProp, value)
    if (projectId) {
      const s = useGraphStore.getState()
      saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs })
        .catch(e => console.error('Save:', e))
    }
  }

  // ── Hierarchy (edges) mode: deterministic zoomable pack ─────────────────────
  const root = useMemo(() => {
    if (groupProp) return null
    const tree = buildTree(nodes, edges, { decorOf, sizeBy })
    const h = d3.hierarchy(tree).sum(d => d.value || 0).sort((a, b) => (b.value || 0) - (a.value || 0))
    return d3.pack().size([D, D]).padding(3)(h)
  }, [nodes, edges, decorOf, sizeBy, groupProp])
  const descendants = root ? root.descendants() : []
  const colorFor = (d) => d.data.color || DEPTH_FILL[Math.min(d.depth, DEPTH_FILL.length - 1)]

  const svgRef = useRef(null)
  const zoomRef = useRef(null)
  const [t, setT] = useState(d3.zoomIdentity)
  useEffect(() => {
    if (groupProp || !svgRef.current) return
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.5, 48])
      .filter(e => { if (e.type === 'dblclick') return false; return !e.ctrlKey && !e.button })
      .on('zoom', e => setT(e.transform))
    zoomRef.current = zoom
    sel.call(zoom)
    return () => sel.on('.zoom', null)
  }, [groupProp])
  const fitTo = (cx, cy, r, dur = 640) => {
    if (!zoomRef.current || !svgRef.current) return
    const kk = Math.max(0.5, Math.min(48, D / (2 * r * 1.06)))
    const T = d3.zoomIdentity.translate(D / 2 - kk * cx, D / 2 - kk * cy).scale(kk)
    d3.select(svgRef.current).transition().duration(dur).call(zoomRef.current.transform, T)
  }
  const fitAll = () => fitTo(D / 2, D / 2, D / 2, 480)
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !groupProp) fitAll() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line
  const zoomed = t.k !== 1 || t.x !== 0 || t.y !== 0

  return (
    <div style={styles.wrap}>
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative' }}>
          <button style={styles.btn} onClick={() => setSrcMenu(o => !o)}>{groupProp ? '❃' : '⬡'} {trim(srcLabel, 16)} ▾</button>
          {srcMenu && (<>
            <div style={styles.backdrop} onClick={() => setSrcMenu(false)} />
            <div style={styles.menu} onClick={e => e.stopPropagation()}>
              <div style={{ ...styles.item, color: !groupProp ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp(null); setSrcMenu(false) }}>{!groupProp && '✓ '}Hierarchy (edges)</div>
              <div style={styles.mlabel}>Group by tag</div>
              {tagDefs.length ? tagDefs.map(d => (
                <div key={d.id} style={{ ...styles.item, color: groupProp === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp(d.id); setSrcMenu(false) }}>{groupProp === d.id && '✓ '}{d.name}</div>
              )) : <div style={{ ...styles.item, color: '#8090b8', fontSize: '0.74rem' }}>No Select/Tags property</div>}
            </div>
          </>)}
        </div>
        {!groupProp && (
          <div style={{ position: 'relative' }}>
            <button style={styles.btn} onClick={() => setMenuOpen(o => !o)}>size: {trim(sizeLabel, 14)} ▾</button>
            {menuOpen && (<>
              <div style={styles.backdrop} onClick={() => setMenuOpen(false)} />
              <div style={styles.menu} onClick={e => e.stopPropagation()}>
                <div style={{ ...styles.item, color: !sizeBy ? '#fff' : '#c5d0ff' }} onClick={() => { setSizeBy(null); setMenuOpen(false) }}>{!sizeBy && '✓ '}Item count</div>
                <div style={styles.mlabel}>By Number property</div>
                {numberDefs.length ? numberDefs.map(d => (
                  <div key={d.id} style={{ ...styles.item, color: sizeBy === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { setSizeBy(d.id); setMenuOpen(false) }}>{sizeBy === d.id && '✓ '}{d.name}</div>
                )) : <div style={{ ...styles.item, color: '#8090b8', fontSize: '0.74rem' }}>No Number property</div>}
              </div>
            </>)}
          </div>
        )}
      </div>
      <div style={styles.hint}>{groupProp ? 'drag an item onto another pack to retag · Alt-drag to add a 2nd tag · scroll = zoom · drag empty = pan' : 'scroll = zoom · drag = pan · click a circle to zoom'}</div>

      {groupProp ? (
        <TagPackForce key={groupProp} def={groupDef} nodes={nodes} decorOf={decorOf} onRetag={retag} />
      ) : (<>
        {zoomed && <button style={styles.reset} onClick={fitAll}>⟳ Fit</button>}
        <svg ref={svgRef} viewBox={`0 0 ${D} ${D}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}>
          <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
            {descendants.map(d => {
              const isLeaf = !d.children
              const dStroke = d.data.stroke
              return (
                <circle key={d.data.id} cx={d.x} cy={d.y} r={d.r}
                  fill={colorFor(d)} fillOpacity={isLeaf ? 0.92 : 0.45}
                  stroke={dStroke || '#0c0c1a'}
                  strokeWidth={dStroke ? Math.max(d.data.strokeWidth || 1.5, 1.4) / t.k : 1 / t.k}
                  style={{ cursor: d.children ? 'zoom-in' : 'default' }}
                  onClick={e => { e.stopPropagation(); if (d.children) fitTo(d.x, d.y, d.r) }}
                />
              )
            })}
            {descendants.filter(d => d.depth > 0 && d.data.label).map(d => {
              const isLeaf = !d.children
              const fontSize = isLeaf ? d.r * 0.34 : Math.min(d.r * 0.15, 16)
              const maxChars = Math.max(4, Math.floor((1.75 * d.r) / (fontSize * 0.56)))
              const lines = wrapText(d.data.label, maxChars).slice(0, isLeaf ? 8 : 2)
              const lh = fontSize * 1.08
              if (isLeaf) {
                const y0 = d.y - (lines.length - 1) / 2 * lh
                return (
                  <text key={'t' + d.data.id} textAnchor="middle" dominantBaseline="middle"
                    fontSize={fontSize} fill="#eef2ff" pointerEvents="none"
                    style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.18, fontWeight: 600 }}>
                    {lines.map((ln, i) => <tspan key={i} x={d.x} y={y0 + i * lh}>{ln}</tspan>)}
                  </text>
                )
              }
              const y0 = d.y - d.r + fontSize * 1.1
              return (
                <text key={'t' + d.data.id} textAnchor="middle" dominantBaseline="hanging"
                  fontSize={fontSize} fill="#cdd6f5" pointerEvents="none"
                  style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.2, fontWeight: 600 }}>
                  {lines.map((ln, i) => <tspan key={i} x={d.x} y={y0 + i * lh}>{ln}</tspan>)}
                </text>
              )
            })}
            {descendants.filter(d => d.data.emoji && d.r * t.k > 12).map(d => {
              const em = d.data.emoji, sz = Math.min(d.r * 0.28, 30)
              const ex = d.x + d.r * 0.5, ey = d.y - d.r * 0.5
              return em.type === 'image'
                ? <image key={'e' + d.data.id} href={em.emoji} x={ex - sz / 2} y={ey - sz / 2} width={sz} height={sz} style={{ pointerEvents: 'none' }} />
                : <text key={'e' + d.data.id} x={ex} y={ey} fontSize={sz} textAnchor="middle" dominantBaseline="central" pointerEvents="none">{em.emoji}</text>
            })}
          </g>
        </svg>
        {descendants.length <= 1 && <div style={styles.empty}>Nothing to pack yet — add some nodes in the graph.</div>}
      </>)}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Clustered force packing for group-by-tag. One d3 force sim; packs are laid out with
// packSiblings so they bunch tightly and never overlap. Each item is a bubble that carries
// its full label. Drag a bubble onto another pack → onRetag → it glides into the new pack.
// (Proven engine ported from the PackLab prototype.)
// ─────────────────────────────────────────────────────────────────────────────
const FW = 1100, FH = 760
const NODE_COLORS = ['#7c8cff', '#4fd1c5', '#f6ad55', '#fc8181', '#b794f4', '#68d391', '#f6e05e', '#63b3ed', '#f687b3', '#a0aec0']
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const radiusFor = (label) => {
  const len = String(label || '').replace(/\s+/g, ' ').trim().length
  return Math.max(30, Math.min(66, 24 + Math.sqrt(Math.max(len, 4)) * 6.6))
}

function TagPackForce({ def, nodes, decorOf, onRetag }) {
  const svgRef = useRef(null)
  const gRef = useRef(null)
  const simRef = useRef(null)
  const bubblesRef = useRef([])
  const centersRef = useRef([])
  const groupsRef = useRef([])
  const zoomRef = useRef(null)
  const [, setTick] = useState(0)
  const [tf, setTf] = useState(d3.zoomIdentity)
  const [draggingKey, setDraggingKey] = useState(null)
  const [hoverGroup, setHoverGroup] = useState(null)

  // Desired bubbles + groups from the current store state. One bubble per (node, tag value);
  // multi-tag nodes are mirrored; untagged nodes fall into an "(untagged)" pack.
  const build = () => {
    const opts = def?.options || []
    const groups = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(groups.map((g, i) => [g.opt, i]))
    let hasUntagged = false
    const raw = []
    nodes.forEach(n => {
      const v = n.props?.[def.id]
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
      const valid = ids.filter(id => idx.has(id))
      const color = decorOf?.(n.id)?.color || NODE_COLORS[hashStr(String(n.id)) % NODE_COLORS.length]
      if (!valid.length) { hasUntagged = true; raw.push({ nodeId: n.id, opt: '__untagged__', label: n.label || '(untitled)', color }) }
      else valid.forEach(id => raw.push({ nodeId: n.id, opt: id, label: n.label || '(untitled)', color }))
    })
    if (hasUntagged) { groups.push({ opt: '__untagged__', name: '(untagged)', color: '#5a6478' }); idx.set('__untagged__', groups.length - 1) }
    raw.forEach(b => { b.group = idx.get(b.opt); b.key = b.nodeId + '@' + b.opt; b.r = radiusFor(b.label) })
    return { groups, bubbles: raw }
  }

  // Bunch the packs (packSiblings → touching, non-overlapping), each sized to hold its members.
  const computeCenters = (groups, bubbles) => {
    const gc = groups.map((g, gi) => {
      let area = 0
      bubbles.forEach(b => { if (b.group === gi) { const r = b.r + 5; area += Math.PI * r * r } })
      const pr = Math.max(84, Math.sqrt(area / Math.PI) * 1.22) + 24
      return { gi, r: pr }
    })
    d3.packSiblings(gc)
    const enc = d3.packEnclose(gc) || { x: 0, y: 0, r: 1 }
    return gc.map(c => ({ x: FW / 2 + (c.x - enc.x), y: FH / 2 + (c.y - enc.y), r: c.r }))
  }

  // Create the sim once.
  useEffect(() => {
    const sim = d3.forceSimulation([])
      .force('charge', d3.forceManyBody().strength(-7))
      .alphaDecay(0.02).velocityDecay(0.55)
      .on('tick', () => setTick(t => t + 1))
    simRef.current = sim
    return () => sim.stop()
  }, [])

  // Reconcile bubbles whenever the tag data changes (this fires after every retag → glide).
  const structureKey = useMemo(() => {
    const opt = (def?.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows
  }, [nodes, def])

  useEffect(() => {
    const { groups, bubbles } = build()
    groupsRef.current = groups
    const centers = computeCenters(groups, bubbles)
    centersRef.current = centers
    const prev = bubblesRef.current || []
    const prevByKey = new Map(prev.map(b => [b.key, b]))
    const prevByNode = new Map(); prev.forEach(b => { if (!prevByNode.has(b.nodeId)) prevByNode.set(b.nodeId, b) })
    const next = bubbles.map(d => {
      const ex = prevByKey.get(d.key)
      if (ex) { ex.group = d.group; ex.r = d.r; ex.color = d.color; ex.label = d.label; return ex }
      const seed = prevByNode.get(d.nodeId)      // same node, moved tag → start from where it was (glide)
      const c = centers[d.group] || { x: FW / 2, y: FH / 2 }
      const j = (hashStr(d.key) % 24) - 12
      return { ...d, x: seed?.x ?? c.x + j, y: seed?.y ?? c.y + j, vx: 0, vy: 0 }
    })
    bubblesRef.current = next
    const sim = simRef.current; if (!sim) return
    sim.nodes(next)
    // forceX/Y cache targets on init → re-create so they read the current groups + centres.
    sim.force('x', d3.forceX(b => centersRef.current[b.group].x).strength(0.2))
    sim.force('y', d3.forceY(b => centersRef.current[b.group].y).strength(0.2))
    sim.force('collide', d3.forceCollide(b => b.r + 2).strength(0.9))
    sim.alpha(0.6).restart()
    setTick(t => t + 1)
  }, [structureKey]) // eslint-disable-line

  // Pan / zoom (empty-canvas drag pans; bubble drags fall through the filter).
  useEffect(() => {
    if (!svgRef.current) return
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.3, 8])
      .filter(e => {
        if (e.type === 'mousedown' && e.target?.closest?.('[data-bubble]')) return false
        return !e.ctrlKey && !e.button
      })
      .on('zoom', e => setTf(e.transform))
    zoomRef.current = zoom
    sel.call(zoom)
    return () => sel.on('.zoom', null)
  }, [])
  const fitAll = () => {
    if (!zoomRef.current || !svgRef.current) return
    d3.select(svgRef.current).transition().duration(420).call(zoomRef.current.transform, d3.zoomIdentity)
  }

  const toWorld = (ev) => {
    const g = gRef.current, svg = svgRef.current
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY
    const loc = pt.matrixTransform(g.getScreenCTM().inverse())
    return { x: loc.x, y: loc.y }
  }
  const nearestGroup = (p) => {
    let best = null, bd = Infinity
    centersRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } })
    return best
  }

  const startDrag = (e, b) => {
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current
    setDraggingKey(b.key); sim.alphaTarget(0.3).restart()
    b.fx = b.x; b.fy = b.y
    const onMove = ev => { const p = toWorld(ev); b.fx = p.x; b.fy = p.y; b.x = p.x; b.y = p.y; setHoverGroup(nearestGroup(p)) }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const p = toWorld(ev); const tg = nearestGroup(p)
      b.fx = null; b.fy = null
      setDraggingKey(null); setHoverGroup(null)
      sim.alphaTarget(0)
      const groups = groupsRef.current
      const additive = def.type === 'multiSelect' && ev.altKey
      if (tg != null && groups[tg] && (groups[tg].opt !== b.opt || additive)) {
        b.x = p.x; b.y = p.y   // seed the reborn bubble at the drop point so it glides, not teleports
        onRetag(b.nodeId, b.opt, groups[tg].opt, additive)
      } else {
        sim.alpha(0.4).restart()   // no-op drop → let it settle back
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Pack outline = tight bounding circle of the members near the pack home (strays ignored so a
  // bubble in transit never balloons the outline). Empty packs still show at a minimum radius.
  const bubbles = bubblesRef.current
  const groups = groupsRef.current
  const outlines = groups.map((g, gi) => {
    const home = centersRef.current[gi] || { x: FW / 2, y: FH / 2 }
    const mem = bubbles.filter(b => b.group === gi && b.key !== draggingKey && b.x != null)
    const count = bubbles.filter(b => b.group === gi).length
    if (!mem.length) return { gi, cx: home.x, cy: home.y, r: 60, count, name: g.name, color: g.color }
    const withD = mem.map(n => ({ n, d: Math.hypot(n.x - home.x, n.y - home.y) }))
    const sorted = withD.map(o => o.d).sort((a, b) => a - b)
    const cutoff = Math.max(120, sorted[Math.floor(sorted.length / 2)] * 2.2 + 50)
    let core = withD.filter(o => o.d <= cutoff).map(o => o.n); if (!core.length) core = mem
    const cx = core.reduce((s, n) => s + n.x, 0) / core.length
    const cy = core.reduce((s, n) => s + n.y, 0) / core.length
    let r = 0; core.forEach(n => { r = Math.max(r, Math.hypot(n.x - cx, n.y - cy) + n.r) })
    return { gi, cx, cy, r: r + 14, count, name: g.name, color: g.color }
  })
  const dragging = draggingKey != null
  const zoomed = tf.k !== 1 || tf.x !== 0 || tf.y !== 0

  return (<>
    {zoomed && <button style={styles.reset} onClick={fitAll}>⟳ Fit</button>}
    {!bubbles.length && <div style={styles.empty}>No items — tag some nodes with “{def?.name}” in the graph or table.</div>}
    <svg ref={svgRef} viewBox={`0 0 ${FW} ${FH}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}>
      <g ref={gRef} transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
        {outlines.map(p => {
          const isTarget = dragging && hoverGroup === p.gi
          return (
            <g key={'o' + p.gi} data-bucket={p.name} pointerEvents={dragging ? 'auto' : 'none'}>
              <circle cx={p.cx} cy={p.cy} r={p.r} fill={p.color + '1e'}
                stroke={isTarget ? '#7fd8a8' : p.color} strokeWidth={isTarget ? 4 : 2.5} />
              <text x={p.cx} y={p.cy - p.r - 10} textAnchor="middle" fontSize={26} fontWeight={700}
                fill={isTarget ? '#7fd8a8' : p.color}
                style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: 4 }}>
                {p.name} · {p.count}
              </text>
            </g>
          )
        })}
        {bubbles.map(b => {
          const held = draggingKey === b.key
          const fs = Math.max(9, b.r * 0.3)
          const maxChars = Math.max(5, Math.floor((1.7 * b.r) / (fs * 0.56)))
          const lines = wrapText(b.label, maxChars).slice(0, 6)
          const lh = fs * 1.05
          const y0 = (b.y || 0) - (lines.length - 1) / 2 * lh
          return (
            <g key={b.key} data-bubble="1" transform={`translate(${b.x || 0},${b.y || 0})`}
              style={{ cursor: 'grab' }} onMouseDown={e => startDrag(e, b)}>
              <circle r={b.r} fill={b.color} fillOpacity={0.95}
                stroke={held ? '#fff' : '#0c0c1a'} strokeWidth={held ? 4 : 1.5} />
              <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill="#0c0c1a" pointerEvents="none"
                style={{ fontWeight: 700 }}>
                {lines.map((ln, i) => <tspan key={i} x={0} y={y0 - (b.y || 0) + i * lh}>{ln}</tspan>)}
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  </>)
}

function trim(s, n) { return s && s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : (s || '') }

// Greedy word-wrap into lines of at most `maxChars`; very long words are hard-broken.
function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  const pushLong = w => { while (w.length > maxChars) { lines.push(w.slice(0, maxChars)); w = w.slice(maxChars) } return w }
  for (let w of words) {
    if (w.length > maxChars) { if (cur) { lines.push(cur); cur = '' } w = pushLong(w) }
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

const styles = {
  wrap: { position: 'relative', height: '100%', width: '100%', background: '#0c0c1a', overflow: 'hidden' },
  svg: { width: '100%', height: '100%', display: 'block', cursor: 'grab' },
  hint: { position: 'absolute', top: 14, right: 16, zIndex: 5, color: '#8090b8', fontSize: '0.72rem', userSelect: 'none' },
  reset: { position: 'absolute', bottom: 14, right: 16, zIndex: 5, background: 'rgba(18,18,42,0.9)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '5px 11px', cursor: 'pointer', fontSize: '0.78rem' },
  btn: { background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 190, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  mlabel: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
}
