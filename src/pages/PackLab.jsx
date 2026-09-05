import { useRef, useState, useEffect } from 'react'
import * as d3 from 'd3'

// STANDALONE PROTOTYPE — generic clustered-bubble force layout with drag-to-regroup.
// One clean d3 force simulation. Packs are laid out with packSiblings so they bunch tightly and
// never overlap; nodes cluster into their pack; drag a node onto another pack to reassign it.

const GROUPS = ['A', 'B', 'C', 'D', 'E']
const COLORS = ['#5b6af0', '#22c55e', '#f59e0b', '#ef4444', '#a855f7']   // PACK (outline) colours
const NODE_COLORS = ['#7c8cff', '#4fd1c5', '#f6ad55', '#fc8181', '#b794f4', '#68d391', '#f6e05e', '#63b3ed', '#f687b3', '#a0aec0']
const W = 1000, H = 720

export default function PackLab() {
  const svgRef = useRef(null)
  const simRef = useRef(null)
  const nodesRef = useRef(null)
  const centersRef = useRef([])            // {x,y,r} per group — bunched via packSiblings
  const [, setTick] = useState(0)
  const [draggingId, setDraggingId] = useState(null)
  const [dbg, setDbg] = useState('drag a circle to test')

  if (!nodesRef.current) {
    nodesRef.current = Array.from({ length: 60 }, (_, i) => ({
      id: i, group: i % GROUPS.length, color: NODE_COLORS[i % NODE_COLORS.length], r: 12 + ((i * 13) % 22),
    }))
  }

  // Bunch the packs together (packSiblings → touching, non-overlapping), sized to their contents.
  const computeCenters = () => {
    const nodes = nodesRef.current
    const gc = GROUPS.map((g, gi) => {
      const mem = nodes.filter(n => n.group === gi)
      let area = 0; mem.forEach(n => { const r = n.r + 3; area += Math.PI * r * r })
      const pr = Math.max(52, Math.sqrt(area / Math.PI) * 1.28) + 18
      return { gi, r: pr }
    })
    d3.packSiblings(gc)
    const enc = d3.packEnclose(gc)
    centersRef.current = gc.map(c => ({ x: W / 2 + (c.x - enc.x), y: H / 2 + (c.y - enc.y), r: c.r }))
  }

  useEffect(() => {
    const nodes = nodesRef.current
    computeCenters()
    nodes.forEach(n => { const c = centersRef.current[n.group]; n.x = c.x + (n.id % 7) * 4; n.y = c.y + (n.id % 5) * 4 })
    const sim = d3.forceSimulation(nodes)
      .force('x', d3.forceX(d => centersRef.current[d.group].x).strength(0.22))
      .force('y', d3.forceY(d => centersRef.current[d.group].y).strength(0.22))
      .force('collide', d3.forceCollide(d => d.r + 2).strength(0.9))
      .force('charge', d3.forceManyBody().strength(-6))
      .alphaDecay(0.02).velocityDecay(0.55)
      .on('tick', () => setTick(t => t + 1))
    simRef.current = sim
    return () => sim.stop()
  }, [])

  const nodes = nodesRef.current

  // Pack outline = tight bounding circle of the members near the pack's home (strays ignored, so a
  // node in transit never balloons the outline).
  const packCirclesExcluding = (excludeId) => GROUPS.map((g, gi) => {
    const home = centersRef.current[gi] || { x: W / 2, y: H / 2 }
    const mem = nodes.filter(n => n.group === gi && n.id !== excludeId && n.x != null)
    if (!mem.length) return { gi, cx: home.x, cy: home.y, r: 40, count: 0 }
    const withD = mem.map(n => ({ n, d: Math.hypot(n.x - home.x, n.y - home.y) }))
    const sorted = withD.map(o => o.d).sort((a, b) => a - b)
    const cutoff = Math.max(90, sorted[Math.floor(sorted.length / 2)] * 2.2 + 40)
    let core = withD.filter(o => o.d <= cutoff).map(o => o.n); if (!core.length) core = mem
    const cx = core.reduce((s, n) => s + n.x, 0) / core.length
    const cy = core.reduce((s, n) => s + n.y, 0) / core.length
    let r = 0; core.forEach(n => { r = Math.max(r, Math.hypot(n.x - cx, n.y - cy) + n.r) })
    return { gi, cx, cy, r: r + 10, count: mem.length }
  })
  const packs = packCirclesExcluding(draggingId)

  const toSvg = (ev) => {
    const svg = svgRef.current
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY
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
      let best = 0, bd = Infinity
      centersRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } })
      const fromGroup = node.group
      node.group = best
      // Release it where dropped and let the force GLIDE it into the new pack (eases from rest —
      // gentler than the old instant snap). No teleport: strays don't balloon the outline anyway.
      node.fx = null; node.fy = null
      computeCenters()   // re-bunch the packs for the new sizes
      // forceX/Y cache their targets on init — re-create so they read the new group + new centres.
      sim.force('x', d3.forceX(d => centersRef.current[d.group].x).strength(0.22))
      sim.force('y', d3.forceY(d => centersRef.current[d.group].y).strength(0.22))
      setDraggingId(null)
      setDbg(`#${node.id}: ${GROUPS[fromGroup]}→${GROUPS[best]}`)
      sim.alphaTarget(0).alpha(0.5).restart()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div style={{ height: '100%', width: '100%', background: '#0c0c1a', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: '#c5d0ff', padding: '10px 16px', fontSize: 14 }}>
        Clustered force packing — 60 circles, 5 packs. <b>Drag a circle onto another pack</b> to reassign it.
        <span style={{ color: '#7fd8a8', marginLeft: 10 }}>build v8 · {new Date(__BUILD_TIME__).toISOString().slice(11, 16)}</span>
        <span style={{ color: '#f5c451', marginLeft: 14, fontFamily: 'monospace' }}>{dbg}</span>
      </div>
      <svg ref={svgRef} width={W} height={H} style={{ display: 'block', margin: '0 auto', background: '#0c0c1a' }}>
        {packs.map(p => (
          <g key={p.gi} pointerEvents="none">
            <circle cx={p.cx} cy={p.cy} r={p.r} fill={COLORS[p.gi] + '22'} stroke={COLORS[p.gi]} strokeWidth={2} />
            <text x={p.cx} y={p.cy - p.r - 8} textAnchor="middle" fontSize={18} fontWeight={700} fill={COLORS[p.gi]}>
              {GROUPS[p.gi]} · {p.count}
            </text>
          </g>
        ))}
        {nodes.map(n => (
          <g key={n.id} transform={`translate(${n.x || 0},${n.y || 0})`} style={{ cursor: 'grab' }}
            onMouseDown={e => startDrag(e, n)}>
            <circle r={n.r} fill={n.color} stroke={draggingId === n.id ? '#fff' : '#0c0c1a'} strokeWidth={draggingId === n.id ? 4 : 1.5} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={Math.max(9, n.r * 0.7)} fill="#fff" pointerEvents="none">{n.id}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}
