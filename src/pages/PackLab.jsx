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

  // Live pack outline per group = bounding circle of that group's members.
  // `exclude` drops the actively-dragged circle so its old pack shrinks away from it immediately.
  const packCirclesExcluding = (excludeId) => GROUPS.map((g, gi) => {
    const mem = nodes.filter(n => n.group === gi && n.id !== excludeId && n.x != null)
    if (!mem.length) return { gi, cx: centers[gi].x, cy: centers[gi].y, r: 40, count: 0 }
    const cx = mem.reduce((s, n) => s + n.x, 0) / mem.length
    const cy = mem.reduce((s, n) => s + n.y, 0) / mem.length
    let r = 0; mem.forEach(n => { r = Math.max(r, Math.hypot(n.x - cx, n.y - cy) + n.r) })
    return { gi, cx, cy, r: r + 10, count: mem.length }
  })
  const packs = packCirclesExcluding(draggingId)

  // Manual drag (client→svg is 1:1 because the svg is drawn at exactly W×H).
  const startDrag = (e, node) => {
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current
    const rect = svgRef.current.getBoundingClientRect()
    const sx = W / rect.width, sy = H / rect.height   // in case the browser scaled it
    setDraggingId(node.id)
    sim.alphaTarget(0.3).restart()
    node.fx = node.x; node.fy = node.y
    const onMove = ev => { node.fx = (ev.clientX - rect.left) * sx; node.fy = (ev.clientY - rect.top) * sy }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const dx = (ev.clientX - rect.left) * sx, dy = (ev.clientY - rect.top) * sy
      // Assign by the pack outline you DROP INSIDE (excluding the dragged node so its old pack
      // doesn't count). If inside none, fall back to nearest centre.
      const circles = packCirclesExcluding(node.id)
      const inside = circles.filter(p => Math.hypot(dx - p.cx, dy - p.cy) <= p.r)
      let best
      if (inside.length) best = inside.sort((a, b) => Math.hypot(dx - a.cx, dy - a.cy) - Math.hypot(dx - b.cx, dy - b.cy))[0].gi
      else { best = 0; let bd = Infinity; circles.forEach(p => { const d = (dx - p.cx) ** 2 + (dy - p.cy) ** 2; if (d < bd) { bd = d; best = p.gi } }) }
      node.group = best            // reassign to the pack it was dropped on
      node.fx = null; node.fy = null
      setDraggingId(null)
      sim.alphaTarget(0).alpha(0.5).restart()   // let the force carry it into its new pack
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div style={{ height: '100%', width: '100%', background: '#0c0c1a', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: '#c5d0ff', padding: '10px 16px', fontSize: 14 }}>
        Clustered force packing — 60 circles, 5 packs. <b>Drag a circle onto another pack</b> to reassign it.
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
