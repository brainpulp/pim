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
  const simRef = useRef(null)          // member bubbles sim
  const packSimRef = useRef(null)      // pack-circles sim (self-bunching, non-overlapping, draggable)
  const bubblesRef = useRef([])
  const packsRef = useRef([])          // [{gi,opt,name,color,r,x,y,fx,fy,anchored}]
  const groupsRef = useRef([])
  const zoomRef = useRef(null)
  const selectedRef = useRef(new Set())
  const heldKeysRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [tf, setTf] = useState(d3.zoomIdentity)
  const [heldKeys, setHeldKeysState] = useState(() => new Set())
  const [hoverGroup, setHoverGroup] = useState(null)   // >=0 pack index, -1 = untag (outside all packs)
  const [selected, setSelected] = useState(() => new Set())
  const [filter, setFilter] = useState('')
  const [anchoredTick, setAnchoredTick] = useState(0)  // re-render when a pack is (un)anchored
  const matches = (label) => !filter.trim() || String(label || '').toLowerCase().includes(filter.trim().toLowerCase())
  const setHeldKeys = (s) => { heldKeysRef.current = s; setHeldKeysState(s) }

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
    // Filtered-out items are fully removed from the layout so packs re-pack around what remains.
    return { groups, bubbles: raw.filter(b => matches(b.label)) }
  }

  // Pack radius = the MINIMUM circle that holds its members (tight-pack them with packSiblings,
  // take the enclosing radius). Recomputed on every membership change → packs shrink/grow to fit.
  const rFit = (gi, bubbles) => {
    const circles = []
    bubbles.forEach(b => { if (b.group === gi) circles.push({ r: b.r + 3 }) })
    if (!circles.length) return 62
    d3.packSiblings(circles)
    const enc = d3.packEnclose(circles) || { r: 62 }
    return enc.r + 12
  }

  // Create both sims once. Packs: collide (never overlap) + gentle centre gravity → self-bunching.
  // Members: pull to their pack centre, collide, and are HARD-CONTAINED inside the pack circle each
  // tick (so belonging is unambiguous and packs can't visually overrun each other).
  useEffect(() => {
    const packSim = d3.forceSimulation([])
      .force('x', d3.forceX(FW / 2).strength(0.02))
      .force('y', d3.forceY(FH / 2).strength(0.02))
      .force('collide', d3.forceCollide(p => p.r + 22).strength(1).iterations(3))
      .alphaDecay(0.03).velocityDecay(0.62)
      .on('tick', () => {
        // Hard no-overlap: separate any pair of packs that still overlaps (collide can lag under
        // drag/anchor). Anchored packs (fx set) stay put; the other one yields.
        const packs = packsRef.current, GAP = 14
        for (let i = 0; i < packs.length; i++) for (let j = i + 1; j < packs.length; j++) {
          const a = packs[i], b = packs[j]
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + GAP
          if (d < min) {
            const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d
            const aFix = a.fx != null, bFix = b.fx != null
            if (aFix && !bFix) { b.x += ux * push; b.y += uy * push }
            else if (bFix && !aFix) { a.x -= ux * push; a.y -= uy * push }
            else if (!aFix && !bFix) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
          }
        }
        setTick(t => t + 1)
      })
    packSimRef.current = packSim

    const sim = d3.forceSimulation([])
      .force('charge', d3.forceManyBody().strength(-5))
      .force('collide', d3.forceCollide(b => b.r + 2).strength(0.9))
      .alphaDecay(0.02).velocityDecay(0.55)
      .on('tick', () => {
        const packs = packsRef.current, held = heldKeysRef.current
        const bs = bubblesRef.current
        // Hard node–node separation so bubbles NEVER visibly overlap (collide alone only converges
        // over several ticks). A dragged node (fx set) shoves others but isn't itself displaced.
        for (let i = 0; i < bs.length; i++) {
          const a = bs[i]
          for (let j = i + 1; j < bs.length; j++) {
            const b = bs[j]
            const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 1.5
            if (d < min) {
              const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d
              const aFix = a.fx != null, bFix = b.fx != null
              if (aFix && !bFix) { b.x += ux * push; b.y += uy * push }
              else if (bFix && !aFix) { a.x -= ux * push; a.y -= uy * push }
              else if (!aFix && !bFix) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
            }
          }
        }
        for (const b of bs) {
          if (b.fx != null || held.has(b.key)) continue
          const own = b.group >= 0 ? packs[b.group] : null
          // push out of packs it doesn't belong to (a moving pack shoves non-members aside)…
          for (const c of packs) {
            if (c === own) continue
            const dx = b.x - c.x, dy = b.y - c.y, d = Math.hypot(dx, dy)
            const min = c.r + b.r + 2
            if (d < min) { const dd = d || 1; b.x = c.x + dx / dd * min; b.y = c.y + dy / dd * min; b.vx *= 0.4; b.vy *= 0.4 }
          }
          // …and keep members inside their own pack.
          if (own) {
            const dx = b.x - own.x, dy = b.y - own.y, d = Math.hypot(dx, dy) || 1
            const max = Math.max(0, own.r - b.r - 4)
            if (d > max) { b.x = own.x + dx / d * max; b.y = own.y + dy / d * max; b.vx *= 0.4; b.vy *= 0.4 }
          }
        }
        setTick(t => t + 1)
      })
    simRef.current = sim
    return () => { packSim.stop(); sim.stop() }
  }, [])

  const structureKey = useMemo(() => {
    const opt = (def?.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows
  }, [nodes, def])

  // Reconcile packs + bubbles whenever tags/filter change. Packs keep their position + anchor across
  // retags (matched by opt); only their radius adapts, and the pack sim eases neighbours apart — so
  // moving one item never makes the whole board fly.
  useEffect(() => {
    const { groups, bubbles } = build()
    groupsRef.current = groups
    // seed positions for brand-new packs via packSiblings (nice initial bunch)
    const gc = groups.map((g, gi) => ({ r: rFit(gi, bubbles) }))
    d3.packSiblings(gc); const enc = d3.packEnclose(gc) || { x: 0, y: 0 }
    const prevPacks = new Map((packsRef.current || []).map(p => [p.opt, p]))
    const packs = groups.map((g, gi) => {
      const ex = prevPacks.get(g.opt)
      if (ex) { ex.gi = gi; ex.name = g.name; ex.color = g.color; ex.r = gc[gi].r; return ex }
      return { gi, opt: g.opt, name: g.name, color: g.color, r: gc[gi].r,
        x: FW / 2 + (gc[gi].x - enc.x), y: FH / 2 + (gc[gi].y - enc.y), anchored: false }
    })
    packsRef.current = packs

    const prev = bubblesRef.current || []
    const prevByKey = new Map(prev.map(b => [b.key, b]))
    const prevByNode = new Map(); prev.forEach(b => { if (!prevByNode.has(b.nodeId)) prevByNode.set(b.nodeId, b) })
    const next = bubbles.map(d => {
      const ex = prevByKey.get(d.key)
      if (ex) { ex.group = d.group; ex.r = d.r; ex.color = d.color; ex.label = d.label; return ex }
      const seed = prevByNode.get(d.nodeId)
      const c = d.group >= 0 ? packs[d.group] : { x: FW / 2, y: FH / 2 }
      const j = (hashStr(d.key) % 24) - 12
      return { ...d, x: seed?.x ?? c.x + j, y: seed?.y ?? c.y + j, vx: 0, vy: 0 }
    })
    bubblesRef.current = next
    const live = new Set(next.map(b => b.key))
    const sel = new Set([...selectedRef.current].filter(k => live.has(k)))
    if (sel.size !== selectedRef.current.size) { selectedRef.current = sel; setSelected(sel) }

    const packSim = packSimRef.current, sim = simRef.current; if (!packSim || !sim) return
    packSim.nodes(packs); packSim.alpha(0.5).restart()
    sim.nodes(next)
    sim.force('x', d3.forceX(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].x : FW / 2).strength(b => b.group >= 0 ? 0.35 : 0.04))
    sim.force('y', d3.forceY(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].y : FH / 2).strength(b => b.group >= 0 ? 0.35 : 0.04))
    sim.alpha(0.7).restart()
    setTick(t => t + 1)
  }, [structureKey, filter]) // eslint-disable-line

  // Pan / zoom (bubble + pack drags fall through the filter; empty-canvas drag pans).
  useEffect(() => {
    if (!svgRef.current) return
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.3, 8])
      .filter(e => {
        if (e.type === 'mousedown' && e.target?.closest?.('[data-bubble],[data-pack]')) return false
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
  const dropTarget = (p) => {
    let best = null, bd = Infinity
    packsRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } })
    const c = packsRef.current[best]
    if (best == null || !c) return -1
    return Math.hypot(p.x - c.x, p.y - c.y) > c.r + 30 ? -1 : best   // outside every pack → untag
  }

  const setSel = (next) => { selectedRef.current = next; setSelected(next) }
  const toggleSelect = (key, additive) => {
    const prev = selectedRef.current
    const next = new Set(additive ? prev : [])
    if (additive && prev.has(key)) next.delete(key); else next.add(key)
    setSel(next)
  }

  // ── Drag a pack → it anchors where you drop it; members follow. Double-click / badge releases it.
  const startPackDrag = (e, pack) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = pack.x - p0.x, oy = pack.y - p0.y
    packSimRef.current.alphaTarget(0.3).restart()
    simRef.current.alphaTarget(0.3).restart()   // keep members warm so they follow + get shoved aside
    const move = ev => {
      const p = toWorld(ev); let x = p.x + ox, y = p.y + oy
      // clamp the dragged pack out of every other pack so packs never overlap
      for (const c of packsRef.current) {
        if (c === pack) continue
        const dx = x - c.x, dy = y - c.y, d = Math.hypot(dx, dy), min = pack.r + c.r + 14
        if (d < min) { const dd = d || 1; x = c.x + dx / dd * min; y = c.y + dy / dd * min }
      }
      pack.fx = x; pack.fy = y; pack.x = x; pack.y = y; setTick(t => t + 1)
    }
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      pack.anchored = true            // fx/fy retained → stays put under the force layout
      packSimRef.current.alphaTarget(0); simRef.current.alphaTarget(0)
      setAnchoredTick(t => t + 1)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const releasePack = (pack) => { pack.fx = null; pack.fy = null; pack.anchored = false; packSimRef.current.alpha(0.5).restart(); setAnchoredTick(t => t + 1) }
  const releaseAllPacks = () => { packsRef.current.forEach(p => { p.fx = null; p.fy = null; p.anchored = false }); packSimRef.current.alpha(0.6).restart(); setAnchoredTick(t => t + 1) }

  // ── Press a bubble → click selects; drag moves it (or the whole selection) and retags on drop.
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
      if (list.length) { onRetagMany(list, targetOpt, additive) }
      else sim.alpha(0.4).restart()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const bubbles = bubblesRef.current
  const packs = packsRef.current
  const dragging = heldKeys.size > 0
  const zoomed = tf.k !== 1 || tf.x !== 0 || tf.y !== 0
  const untaggedCount = bubbles.filter(b => b.group === -1).length
  const anchoredAny = packs.some(p => p.anchored)
  const clearSelection = () => { if (selectedRef.current.size) setSel(new Set()) }
  void anchoredTick

  return (<>
    <div style={styles.filterBox}>
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter items…"
        style={styles.filterInput} onMouseDown={e => e.stopPropagation()} />
      {filter && <button style={styles.filterClear} onClick={() => setFilter('')}>×</button>}
      {selected.size > 0 && <span style={styles.selCount}>{selected.size} selected</span>}
    </div>
    {anchoredAny && <button style={{ ...styles.reset, bottom: 48 }} onClick={releaseAllPacks}>⊙ Release packs</button>}
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
        {/* Pack circles: fixed boundary, members contained inside. Drag to anchor, double-click to release. */}
        {packs.map(p => {
          const isTarget = dragging && hoverGroup === p.gi
          const count = bubbles.filter(b => b.group === p.gi).length
          return (
            <g key={'o' + p.gi} data-pack="1" style={{ cursor: 'grab' }}
              onMouseDown={e => startPackDrag(e, p)} onDoubleClick={e => { e.stopPropagation(); if (p.anchored) releasePack(p) }}>
              <circle cx={p.x} cy={p.y} r={p.r} fill={p.color + '1e'}
                stroke={isTarget ? '#7fd8a8' : p.color} strokeWidth={isTarget ? 4 : 2.5}
                strokeDasharray={p.anchored ? '2 7' : undefined} />
              <text x={p.x} y={p.y - p.r - 10} textAnchor="middle" fontSize={26} fontWeight={700}
                fill={isTarget ? '#7fd8a8' : p.color}
                style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: 4 }}>
                {p.name} · {count}
              </text>
              {p.anchored && (
                <text x={p.x} y={p.y - p.r + 14} textAnchor="middle" fontSize={18} fill={p.color}
                  style={{ cursor: 'pointer' }} onMouseDown={e => { e.stopPropagation(); releasePack(p) }}>⊙</text>
              )}
            </g>
          )
        })}
        {bubbles.map(b => {
          const held = heldKeys.has(b.key)
          const isSel = selected.has(b.key)
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
