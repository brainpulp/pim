import { useRef, useState, useEffect, useMemo } from 'react'
import * as d3 from 'd3'

// STANDALONE PROTOTYPE — generic clustered-bubble force layout with drag-to-regroup.
// No cosmetics, no PIM entanglement: one clean d3 force simulation that nothing else touches.
// Circles cluster by group; drag a circle onto another group's pack and it reassigns + re-clusters.

const GROUPS = ['A', 'B', 'C', 'D', 'E']
const COLORS = ['#5b6af0', '#22c55e', '#f59e0b', '#ef4444', '#a855f7']
const W = 1000, H = 720

export default function PackLab() {
  const svgRef = useRef(null)
  const simRef = useRef(null)
  const nodesRef = useRef(null)
  const [, setTick] = useState(0)
  const [draggingId, setDraggingId] = useState(null)   // exclude the dragged circle from its pack outline

  // Fixed group centres, laid out in a ring so the clusters bunch together.
  const centers = useMemo(() => {
    const R = 210, cx = W / 2, cy = H / 2
    return GROUPS.map((g, i) => {
      const a = (i / GROUPS.length) * 2 * Math.PI - Math.PI / 2
      return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }
    })
  }, [])

  // 60 circles, deterministic sizes/groups, seeded near their group centre.
  if (!nodesRef.current) {
    nodesRef.current = Array.from({ length: 60 }, (_, i) => {
      const group = i % GROUPS.length
      return { id: i, group, r: 12 + ((i * 13) % 22), x: centers[group].x + (i % 7) * 4, y: centers[group].y + (i % 5) * 4 }
    })
  }

  useEffect(() => {
    const nodes = nodesRef.current
    const sim = d3.forceSimulation(nodes)
      .force('x', d3.forceX(d => centers[d.group].x).strength(0.28))
      .force('y', d3.forceY(d => centers[d.group].y).strength(0.28))
      .force('collide', d3.forceCollide(d => d.r + 2).strength(0.9))
      .force('charge', d3.forceManyBody().strength(-6))
      .alphaDecay(0.02).velocityDecay(0.4)
      .on('tick', () => setTick(t => t + 1))
    simRef.current = sim
    return () => sim.stop()
  }, [centers])

  const nodes = nodesRef.current

  // Live pack outline per group. Robust to STRAYS: a member that's far from the cluster core
  // (in transit or mis-dropped) is dropped from the outline calc, so the pack can never balloon
  // across the canvas to chase it. Centred on the tight core of members near the group's home.
  const packCirclesExcluding = (excludeId) => GROUPS.map((g, gi) => {
    const home = centers[gi]
    const mem = nodes.filter(n => n.group === gi && n.id !== excludeId && n.x != null)
    if (!mem.length) return { gi, cx: home.x, cy: home.y, r: 40, count: 0 }
    // core = members within a sane distance of the group's home (force pulls them here anyway).
    // Distances beyond that are strays; ignore them for the outline (but still count them).
    const withD = mem.map(n => ({ n, d: Math.hypot(n.x - home.x, n.y - home.y) }))
    const sorted = withD.map(o => o.d).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const cutoff = Math.max(90, median * 2.2 + 40)
    let core = withD.filter(o => o.d <= cutoff).map(o => o.n)
    if (!core.length) core = mem
    const cx = core.reduce((s, n) => s + n.x, 0) / core.length
    const cy = core.reduce((s, n) => s + n.y, 0) / core.length
    let r = 0; core.forEach(n => { r = Math.max(r, Math.hypot(n.x - cx, n.y - cy) + n.r) })
    return { gi, cx, cy, r: r + 10, count: mem.length }
  })
  const packs = packCirclesExcluding(draggingId)

  // client→SVG using the SVG's own transform matrix — correct under any DPI / zoom / scroll.
  const toSvg = (ev) => {
    const svg = svgRef.current
    const pt = svg.createSVGPoint()
    pt.x = ev.clientX; pt.y = ev.clientY
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse())
    return { x: loc.x, y: loc.y }
  }

  const startDrag = (e, node) => {
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current
    setDraggingId(node.id)
    sim.alphaTarget(0.3).restart()
    node.fx = node.x; node.fy = node.y
    const onMove = ev => { const p = toSvg(ev); node.fx = p.x; node.fy = p.y }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const p = toSvg(ev)
      // Assign to the NEAREST pack centre (centres are well separated, so this is unambiguous).
      let best = 0, bd = Infinity
      centers.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } })
      node.group = best
      // Hard-place it at the new pack's centre so it can never be left stuck in the old one.
      node.x = centers[best].x + ((node.id % 5) - 2) * 6
      node.y = centers[best].y + ((node.id % 3) - 1) * 6
      node.fx = null; node.fy = null; node.vx = 0; node.vy = 0
      setDraggingId(null)
      sim.alphaTarget(0).alpha(0.6).restart()   // collide spreads it into the pack
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div style={{ height: '100%', width: '100%', background: '#0c0c1a', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: '#c5d0ff', padding: '10px 16px', fontSize: 14 }}>
        Clustered force packing — 60 circles, 5 packs. <b>Drag a circle onto another pack</b> to reassign it.
        <span style={{ color: '#7fd8a8', marginLeft: 10 }}>build v4 · {new Date(__BUILD_TIME__).toISOString().slice(11, 16)}</span>
      </div>
      <svg ref={svgRef} width={W} height={H} style={{ display: 'block', margin: '0 auto', background: '#0c0c1a' }}>
        {/* pack outlines + labels (behind) */}
        {packs.map(p => (
          <g key={p.gi} pointerEvents="none">
            <circle cx={p.cx} cy={p.cy} r={p.r} fill={COLORS[p.gi] + '22'} stroke={COLORS[p.gi]} strokeWidth={2} />
            <text x={p.cx} y={p.cy - p.r - 8} textAnchor="middle" fontSize={18} fontWeight={700} fill={COLORS[p.gi]}>
              {GROUPS[p.gi]} · {p.count}
            </text>
          </g>
        ))}
        {/* circles */}
        {nodes.map(n => (
          <g key={n.id} transform={`translate(${n.x || 0},${n.y || 0})`} style={{ cursor: 'grab' }}
            onMouseDown={e => startDrag(e, n)}>
            <circle r={n.r} fill={COLORS[n.group]} stroke="#0c0c1a" strokeWidth={1.5} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={Math.max(9, n.r * 0.7)} fill="#fff" pointerEvents="none">{n.id}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}
