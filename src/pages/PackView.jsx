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

  // ── Retag one or many items in a single batch (writes node.props + one save) ─
  // list = [{ nodeId, sourceOpt }]. targetOpt '__untagged__' clears the tag (drop outside packs).
  const retagMany = (list, targetOpt, additive) => {
    const def = propertyDefs.find(d => d.id === groupProp); if (!def || !list.length) return
    list.forEach(({ nodeId, sourceOpt }) => {
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
    })
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
        <TagPackForce key={groupProp} def={groupDef} nodes={nodes} decorOf={decorOf} onRetagMany={retagMany} />
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
// Relative luminance of a #rrggbb colour → pick legible text (dark on light fills, light on dark).
const hexLum = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0.35
  const n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
  const f = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function TagPackForce({ def, nodes, decorOf, onRetagMany }) {
  const svgRef = useRef(null)
  const gRef = useRef(null)
  const simRef = useRef(null)
  const bubblesRef = useRef([])
  const centersRef = useRef([])
  const groupsRef = useRef([])
  const zoomRef = useRef(null)
  const selectedRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [tf, setTf] = useState(d3.zoomIdentity)
  const [heldKeys, setHeldKeys] = useState(() => new Set())
  const [hoverGroup, setHoverGroup] = useState(null)   // >=0 pack index, -1 = untag (outside all packs)
  const [selected, setSelected] = useState(() => new Set())
  const [filter, setFilter] = useState('')
  const matches = (label) => !filter.trim() || String(label || '').toLowerCase().includes(filter.trim().toLowerCase())

  // Desired bubbles + real packs from the store. One bubble per (node, tag value); multi-tag nodes
  // are mirrored. UNTAGGED nodes get group -1 → no pack, just a weak pull to the centroid.
  const build = () => {
    const opts = def?.options || []
    const groups = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(groups.map((g, i) => [g.opt, i]))
    const raw = []
    nodes.forEach(n => {
      const v = n.props?.[def.id]
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
      const valid = ids.filter(id => idx.has(id))
      const color = decorOf?.(n.id)?.color || NODE_COLORS[hashStr(String(n.id)) % NODE_COLORS.length]
      const label = n.label || '(untitled)'
      if (!valid.length) raw.push({ nodeId: n.id, opt: '__untagged__', group: -1, label, color })
      else valid.forEach(id => raw.push({ nodeId: n.id, opt: id, group: idx.get(id), label, color }))
    })
    raw.forEach(b => { b.key = b.nodeId + '@' + b.opt; b.r = radiusFor(b.label) })
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
      const c = d.group >= 0 ? centers[d.group] : { x: FW / 2, y: FH / 2 }
      const j = (hashStr(d.key) % 24) - 12
      return { ...d, x: seed?.x ?? c.x + j, y: seed?.y ?? c.y + j, vx: 0, vy: 0 }
    })
    bubblesRef.current = next
    // prune selection of bubbles that no longer exist
    const live = new Set(next.map(b => b.key))
    const sel = new Set([...selectedRef.current].filter(k => live.has(k)))
    if (sel.size !== selectedRef.current.size) { selectedRef.current = sel; setSelected(sel) }
    const sim = simRef.current; if (!sim) return
    sim.nodes(next)
    // forceX/Y cache targets on init → re-create so they read the current groups + centres.
    // Packed bubbles pull to their pack centre; untagged (group -1) drift weakly to the centroid.
    sim.force('x', d3.forceX(b => (b.group >= 0 && centersRef.current[b.group]) ? centersRef.current[b.group].x : FW / 2).strength(b => b.group >= 0 ? 0.2 : 0.045))
    sim.force('y', d3.forceY(b => (b.group >= 0 && centersRef.current[b.group]) ? centersRef.current[b.group].y : FH / 2).strength(b => b.group >= 0 ? 0.2 : 0.045))
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
  // Which pack a drop lands in — or -1 (untag) if it's dropped outside every pack outline.
  const dropTarget = (p) => {
    const tg = nearestGroup(p); const c = centersRef.current[tg]
    if (tg == null || !c) return -1
    return Math.hypot(p.x - c.x, p.y - c.y) > c.r + 34 ? -1 : tg
  }

  const setSel = (next) => { selectedRef.current = next; setSelected(next) }
  const toggleSelect = (key, additive) => {
    const prev = selectedRef.current
    const next = new Set(additive ? prev : [])
    if (additive && prev.has(key)) next.delete(key); else next.add(key)
    setSel(next)
  }

  // Press → click selects; drag beyond threshold moves the bubble (or the whole selection) and,
  // on release, retags every moved item to the pack it was dropped on (or untags it).
  const startPress = (e, b) => {
    e.preventDefault(); e.stopPropagation()
    if (!matches(b.label)) return
    const sim = simRef.current
    const start = toWorld(e)
    const groupMove = selectedRef.current.has(b.key) && selectedRef.current.size > 1
    const keys = groupMove ? [...selectedRef.current] : [b.key]
    const moving = bubblesRef.current.filter(x => keys.includes(x.key))
    const offs = moving.map(x => ({ b: x, dx: x.x - start.x, dy: x.y - start.y }))
    let moved = false
    const onMove = ev => {
      const p = toWorld(ev)
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > 5) {
        moved = true; sim.alphaTarget(0.3).restart(); setHeldKeys(new Set(keys))
      }
      if (moved) {
        offs.forEach(o => { o.b.fx = p.x + o.dx; o.b.fy = p.y + o.dy; o.b.x = o.b.fx; o.b.y = o.b.fy })
        setHoverGroup(dropTarget(p)); setTick(t => t + 1)
      }
    }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!moved) { toggleSelect(b.key, ev.shiftKey || ev.metaKey || ev.ctrlKey); return }
      const p = toWorld(ev)
      offs.forEach(o => { o.b.fx = null; o.b.fy = null })
      setHeldKeys(new Set()); setHoverGroup(null); sim.alphaTarget(0)
      const tg = dropTarget(p)
      const groups = groupsRef.current
      const targetOpt = tg < 0 ? '__untagged__' : groups[tg].opt
      const additive = def.type === 'multiSelect' && ev.altKey
      const list = offs
        .map(o => ({ nodeId: o.b.nodeId, sourceOpt: o.b.opt }))
        .filter(it => tg < 0 ? it.sourceOpt !== '__untagged__' : (targetOpt !== it.sourceOpt || additive))
      if (list.length) { onRetagMany(list, targetOpt, additive) }   // store change → reconcile → glide
      else sim.alpha(0.4).restart()
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
    const mem = bubbles.filter(b => b.group === gi && !heldKeys.has(b.key) && b.x != null)
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
  const dragging = heldKeys.size > 0
  const zoomed = tf.k !== 1 || tf.x !== 0 || tf.y !== 0
  const untaggedCount = bubbles.filter(b => b.group === -1).length
  const clearSelection = () => { if (selectedRef.current.size) setSel(new Set()) }

  return (<>
    <div style={styles.filterBox}>
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter items…"
        style={styles.filterInput} onMouseDown={e => e.stopPropagation()} />
      {filter && <button style={styles.filterClear} onClick={() => setFilter('')}>×</button>}
      {selected.size > 0 && <span style={styles.selCount}>{selected.size} selected</span>}
    </div>
    {zoomed && <button style={styles.reset} onClick={fitAll}>⟳ Fit</button>}
    {!bubbles.length && <div style={styles.empty}>No items — tag some nodes with “{def?.name}” in the graph or table.</div>}
    <svg ref={svgRef} viewBox={`0 0 ${FW} ${FH}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}>
      <rect x={0} y={0} width={FW} height={FH} fill="transparent" onMouseDown={clearSelection} />
      <g ref={gRef} transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
        {untaggedCount > 0 && (
          <text x={FW / 2} y={26} textAnchor="middle" fontSize={15} fill="#8090b8" pointerEvents="none">
            untagged: {untaggedCount} — drag one onto a pack to tag it · drag a tagged item to open space to untag
          </text>
        )}
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
          const held = heldKeys.has(b.key)
          const isSel = selected.has(b.key)
          const dim = !matches(b.label)
          const light = hexLum(b.color) > 0.55
          const textFill = light ? '#0c0c1a' : '#f2f5ff'
          const fs = Math.max(9, b.r * 0.3)
          const maxChars = Math.max(5, Math.floor((1.7 * b.r) / (fs * 0.56)))
          const lines = wrapText(b.label, maxChars).slice(0, 6)
          const lh = fs * 1.05
          const y0 = -(lines.length - 1) / 2 * lh
          const stroke = held ? '#ffffff' : isSel ? '#ffd34d' : 'rgba(232,238,255,0.4)'
          const sw = held ? 4 : isSel ? 3.5 : 1.25
          return (
            <g key={b.key} data-bubble="1" transform={`translate(${b.x || 0},${b.y || 0})`}
              opacity={dim ? 0.12 : 1} pointerEvents={dim ? 'none' : 'auto'}
              style={{ cursor: 'grab' }} onMouseDown={e => startPress(e, b)}>
              <circle r={b.r} fill={b.color} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} />
              <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={textFill} pointerEvents="none"
                style={{ fontWeight: 700, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
                {lines.map((ln, i) => <tspan key={i} x={0} y={y0 + i * lh}>{ln}</tspan>)}
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
  filterBox: { position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 5, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', borderRadius: 8, padding: '3px 6px' },
  filterInput: { background: 'transparent', border: 'none', outline: 'none', color: '#e6ebff', fontSize: '0.82rem', width: 180, padding: '3px 4px' },
  filterClear: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 4px' },
  selCount: { color: '#ffd34d', fontSize: '0.74rem', paddingRight: 4, whiteSpace: 'nowrap' },
}
