import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import OutlinePanel from '../components/OutlinePanel'

const NODE_R = 34

export default function Graph() {
  const svgRef = useRef()
  const simRef = useRef(null)
  const simNodesRef = useRef([])
  const simEdgesRef = useRef([])
  const zoomTransformRef = useRef(d3.zoomIdentity)
  const frameRef = useRef(null)
  const [tick, setTick] = useState(0)
  const [connecting, setConnecting] = useState(null) // { sourceId, x1, y1, x2, y2 } in sim space

  const storeNodes = useGraphStore(s => s.nodes)
  const storeEdges = useGraphStore(s => s.edges)
  const addNode = useGraphStore(s => s.addNode)
  const addEdge = useGraphStore(s => s.addEdge)
  const setAnchor = useGraphStore(s => s.setAnchor)
  const releaseAnchor = useGraphStore(s => s.releaseAnchor)
  const updateLabel = useGraphStore(s => s.updateLabel)
  const deleteNode = useGraphStore(s => s.deleteNode)

  const scheduleRender = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      setTick(t => t + 1)
    })
  }, [])

  // Sync store topology → D3 simulation
  useEffect(() => {
    const posById = {}
    simNodesRef.current.forEach(n => {
      posById[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy }
    })

    const cx = svgRef.current ? svgRef.current.clientWidth / 2 : 500
    const cy = svgRef.current ? svgRef.current.clientHeight / 2 : 350

    simNodesRef.current = storeNodes.map(n => ({
      id: n.id,
      label: n.label,
      x: posById[n.id]?.x ?? cx + (Math.random() - 0.5) * 120,
      y: posById[n.id]?.y ?? cy + (Math.random() - 0.5) * 120,
      vx: posById[n.id]?.vx ?? 0,
      vy: posById[n.id]?.vy ?? 0,
      fx: n.fx ?? null,
      fy: n.fy ?? null,
    }))

    const nodeById = Object.fromEntries(simNodesRef.current.map(n => [n.id, n]))
    simEdgesRef.current = storeEdges
      .filter(e => nodeById[e.source] && nodeById[e.target])
      .map(e => ({ id: e.id, source: nodeById[e.source], target: nodeById[e.target] }))

    if (!simRef.current) {
      simRef.current = d3.forceSimulation(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(150).strength(0.4))
        .force('charge', d3.forceManyBody().strength(-500))
        .force('collide', d3.forceCollide(NODE_R + 12))
        .alphaDecay(0.015)
        .on('tick', scheduleRender)
    } else {
      simRef.current
        .nodes(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(150).strength(0.4))
        .alpha(0.4).restart()
    }
  }, [storeNodes, storeEdges, scheduleRender])

  // Zoom setup
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    const zoom = d3.zoom()
      .scaleExtent([0.08, 4])
      .on('zoom', e => {
        zoomTransformRef.current = e.transform
        scheduleRender()
      })
    svg.call(zoom)
    // prevent double-click zoom (we use dblclick for label editing)
    svg.on('dblclick.zoom', null)
    return () => svg.on('.zoom', null)
  }, [scheduleRender])

  // Convert client coords → simulation space
  const clientToSim = useCallback((clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect()
    const mx = clientX - rect.left
    const my = clientY - rect.top
    return zoomTransformRef.current.invert([mx, my])
  }, [])

  // Drag node body → anchor it
  const handleNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return

    simRef.current.alphaTarget(0.3).restart()

    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      simNode.fx = sx
      simNode.fy = sy
    }
    const onUp = ue => {
      simRef.current.alphaTarget(0)
      const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
      simNode.fx = sx
      simNode.fy = sy
      setAnchor(nodeId, sx, sy)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setAnchor])

  // Drag connector handle → draw temp edge → connect to target node
  const handleConnectorMouseDown = useCallback((e, sourceId) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const sourceNode = simNodesRef.current.find(n => n.id === sourceId)
    if (!sourceNode) return

    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      setConnecting({ sourceId, x1: sourceNode.x, y1: sourceNode.y, x2: sx, y2: sy })
    }
    const onUp = ue => {
      const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
      const target = simNodesRef.current.find(n => {
        if (n.id === sourceId) return false
        const dx = (n.x || 0) - sx
        const dy = (n.y || 0) - sy
        return Math.sqrt(dx * dx + dy * dy) < NODE_R + 12
      })
      if (target) addEdge(sourceId, target.id)
      setConnecting(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, addEdge])

  const T = zoomTransformRef.current

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <OutlinePanel />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <svg
          ref={svgRef}
          style={{ width: '100%', height: '100%', background: '#0c0c1a', display: 'block', cursor: 'default' }}
        >
          <defs>
            <marker id="arrow" markerWidth="7" markerHeight="7" refX="20" refY="3.5" orient="auto">
              <path d="M0,0 L0,7 L7,3.5 z" fill="#334155" />
            </marker>
            <marker id="arrow-hover" markerWidth="7" markerHeight="7" refX="20" refY="3.5" orient="auto">
              <path d="M0,0 L0,7 L7,3.5 z" fill="#5b6af0" />
            </marker>
          </defs>

          <g transform={`translate(${T.x},${T.y}) scale(${T.k})`}>
            {/* Edges */}
            {simEdgesRef.current.map(e => {
              const s = e.source; const t = e.target
              if (!s || !t || s.x == null) return null
              // Shorten line so arrow sits at node edge
              const dx = t.x - s.x; const dy = t.y - s.y
              const dist = Math.sqrt(dx * dx + dy * dy) || 1
              const ux = dx / dist; const uy = dy / dist
              const x1 = s.x + ux * (NODE_R + 2)
              const y1 = s.y + uy * (NODE_R + 2)
              const x2 = t.x - ux * (NODE_R + 2)
              const y2 = t.y - uy * (NODE_R + 2)
              return (
                <line key={e.id}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="#334155" strokeWidth={1.5}
                  markerEnd="url(#arrow)"
                />
              )
            })}

            {/* Temp connection line while dragging connector */}
            {connecting && (
              <line
                x1={connecting.x1} y1={connecting.y1}
                x2={connecting.x2} y2={connecting.y2}
                stroke="#5b6af0" strokeWidth={1.5}
                strokeDasharray="5,4" opacity={0.7}
              />
            )}

            {/* Nodes */}
            {simNodesRef.current.map(n => (
              <NodeShape
                key={n.id}
                node={n}
                onMouseDown={handleNodeMouseDown}
                onConnectorMouseDown={handleConnectorMouseDown}
                onRelease={releaseAnchor}
                onDelete={deleteNode}
                onLabelChange={updateLabel}
              />
            ))}
          </g>
        </svg>

        {/* Floating add-node button */}
        <button style={addNodeBtnStyle} onClick={() => addNode('New node')}>
          + Node
        </button>
      </div>
    </div>
  )
}

// ─── Node shape ────────────────────────────────────────────────────────────────

function NodeShape({ node, onMouseDown, onConnectorMouseDown, onRelease, onDelete, onLabelChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const isAnchored = node.fx != null

  const commitEdit = () => {
    onLabelChange(node.id, draft)
    setEditing(false)
  }

  const x = node.x ?? 0
  const y = node.y ?? 0

  return (
    <g
      transform={`translate(${x},${y})`}
      onMouseDown={e => onMouseDown(e, node.id)}
      style={{ cursor: isAnchored ? 'move' : 'grab' }}
    >
      {/* Shadow / glow for anchored */}
      {isAnchored && (
        <circle r={NODE_R + 4} fill="none" stroke="#f6ad55" strokeWidth={1} opacity={0.25} />
      )}

      {/* Main circle */}
      <circle
        r={NODE_R}
        fill="#12122a"
        stroke={isAnchored ? '#f6ad55' : '#2d3a6a'}
        strokeWidth={isAnchored ? 2 : 1.5}
      />

      {/* Label */}
      {editing ? (
        <foreignObject
          x={-NODE_R + 6} y={-11}
          width={(NODE_R - 6) * 2} height={22}
          onMouseDown={e => e.stopPropagation()}
        >
          <input
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
            style={{
              width: '100%', background: '#1e1e3a', border: 'none',
              outline: '1px solid #5b6af0', borderRadius: 3,
              color: '#fff', textAlign: 'center', fontSize: 11, padding: '1px 0',
            }}
          />
        </foreignObject>
      ) : (
        <text
          textAnchor="middle" dominantBaseline="middle"
          fill="#c7d0f8" fontSize={11.5} fontFamily="-apple-system, sans-serif"
          style={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label}
        </text>
      )}

      {/* Double-click target for editing (invisible overlay) */}
      <circle
        r={NODE_R} fill="transparent"
        onDoubleClick={e => {
          e.stopPropagation()
          setDraft(node.label)
          setEditing(true)
        }}
        style={{ cursor: 'text' }}
      />

      {/* Connector handle — drag to create edge */}
      <circle
        cx={NODE_R + 6} cy={0} r={5}
        fill="#5b6af0" stroke="#0c0c1a" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectorMouseDown(e, node.id) }}
        style={{ cursor: 'crosshair' }}
      />

      {/* Anchor indicator + release button (top-left) */}
      {isAnchored && (
        <g
          transform={`translate(${-NODE_R + 2}, ${-NODE_R + 2})`}
          onClick={e => { e.stopPropagation(); onRelease(node.id) }}
          style={{ cursor: 'pointer' }}
        >
          <circle r={9} fill="#1a1a2e" stroke="#f6ad55" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#f6ad55" style={{ userSelect: 'none' }}>
            ⊙
          </text>
        </g>
      )}

      {/* Delete button (top-right) */}
      <g
        transform={`translate(${NODE_R - 2}, ${-NODE_R + 2})`}
        onClick={e => { e.stopPropagation(); onDelete(node.id) }}
        style={{ cursor: 'pointer' }}
      >
        <circle r={8} fill="#1a1a2e" stroke="#4a3a3a" strokeWidth={1.5} />
        <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#f87171" style={{ userSelect: 'none' }}>
          ×
        </text>
      </g>
    </g>
  )
}

const addNodeBtnStyle = {
  position: 'absolute', bottom: '1.25rem', right: '1.25rem',
  padding: '0.5rem 1rem', borderRadius: 8,
  border: '1px solid #2d3a6a', background: '#12122a',
  color: '#5b6af0', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
  boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
}
