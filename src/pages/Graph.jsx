import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as d3 from 'd3'
import useGraphStore, { DEFAULT_NODE_PROPS, NODE_R, FILL_COLORS, STROKE_COLORS } from '../lib/graphStore'
import OutlinePanel from '../components/OutlinePanel'
import ViewManager from '../components/ViewManager'
import { loadProject, saveProject } from '../lib/db'

export default function Graph({ projectId, projectName, onBack }) {
  const svgRef = useRef()
  const simRef = useRef(null)
  const zoomBehaviorRef = useRef(null)
  const simNodesRef = useRef([])
  const simEdgesRef = useRef([])
  const zoomTransformRef = useRef(d3.zoomIdentity)
  const frameRef = useRef(null)
  const [tick, setTick] = useState(0)
  const [connecting, setConnecting] = useState(null)
  const [selected, setSelected] = useState(null) // { id, type: 'node'|'edge' }

  const loadProjectData = useGraphStore(s => s.loadProjectData)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState('saved') // 'saved' | 'saving' | 'error'
  const saveTimer = useRef(null)

  // Load project data on mount
  useEffect(() => {
    setLoading(true)
    loadProject(projectId)
      .then(data => {
        loadProjectData({
          nodes: data.nodes,
          edges: data.edges,
          views: data.views,
          activeViewId: data.active_view_id,
        })
      })
      .catch(e => console.error('Failed to load project:', e))
      .finally(() => setLoading(false))
  }, [projectId]) // eslint-disable-line

  const storeNodes   = useGraphStore(s => s.nodes)
  const storeEdges   = useGraphStore(s => s.edges)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const views        = useGraphStore(s => s.views)
  const addNode       = useGraphStore(s => s.addNode)
  const addEdge       = useGraphStore(s => s.addEdge)
  const removeEdge    = useGraphStore(s => s.removeEdge)
  const deleteNode    = useGraphStore(s => s.deleteNode)
  const setAnchor     = useGraphStore(s => s.setAnchor)
  const releaseAnchor = useGraphStore(s => s.releaseAnchor)
  const updateLabel   = useGraphStore(s => s.updateLabel)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const setDrillRoot  = useGraphStore(s => s.setDrillRoot)
  const exitDrill     = useGraphStore(s => s.exitDrill)

  const activeView   = views.find(v => v.id === activeViewId) || views[0]
  const viewNodeProps = activeView?.nodeProps || {}
  const drillRoot    = activeView?.drillRoot || null

  // Auto-save (debounced 1.5s after last change, skip while loading)
  useEffect(() => {
    if (loading) return
    setSaveStatus('saving')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        await saveProject(projectId, { nodes: storeNodes, edges: storeEdges, views, activeViewId })
        setSaveStatus('saved')
      } catch (e) {
        console.error('Save failed:', e)
        setSaveStatus('error')
      }
    }, 1500)
    return () => clearTimeout(saveTimer.current)
  }, [storeNodes, storeEdges, views, activeViewId, projectId, loading]) // eslint-disable-line

  const getVP = useCallback((nodeId) => ({
    ...DEFAULT_NODE_PROPS, ...(viewNodeProps[nodeId] || {}),
  }), [viewNodeProps])

  // Visible node IDs: drill mode or individual hide
  const visibleNodeIds = useMemo(() => {
    if (drillRoot) {
      const desc = new Set([drillRoot])
      const queue = [drillRoot]
      while (queue.length) {
        const curr = queue.shift()
        storeEdges.forEach(e => {
          if (e.source === curr && !desc.has(e.target)) { desc.add(e.target); queue.push(e.target) }
        })
      }
      return desc
    }
    return new Set(storeNodes.filter(n => viewNodeProps[n.id]?.visible !== false).map(n => n.id))
  }, [drillRoot, storeNodes, storeEdges, viewNodeProps])

  const scheduleRender = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; setTick(t => t + 1) })
  }, [])

  // Sync topology → simulation
  useEffect(() => {
    const posById = {}
    simNodesRef.current.forEach(n => { posById[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy } })
    const cx = svgRef.current?.clientWidth / 2 || 500
    const cy = svgRef.current?.clientHeight / 2 || 350

    simNodesRef.current = storeNodes.map(n => {
      const vp = { ...DEFAULT_NODE_PROPS, ...(viewNodeProps[n.id] || {}) }
      return {
        id: n.id, label: n.label,
        x: posById[n.id]?.x ?? cx + (Math.random() - 0.5) * 120,
        y: posById[n.id]?.y ?? cy + (Math.random() - 0.5) * 120,
        vx: posById[n.id]?.vx ?? 0, vy: posById[n.id]?.vy ?? 0,
        fx: vp.fx ?? null, fy: vp.fy ?? null,
      }
    })

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
  }, [storeNodes, storeEdges, scheduleRender]) // intentionally exclude viewNodeProps

  // View switch → reload anchors from new view
  useEffect(() => {
    const { views, activeViewId } = useGraphStore.getState()
    const vp = views.find(v => v.id === activeViewId)?.nodeProps || {}
    simNodesRef.current.forEach(n => {
      const p = { ...DEFAULT_NODE_PROPS, ...(vp[n.id] || {}) }
      n.fx = p.fx ?? null
      n.fy = p.fy ?? null
    })
    if (simRef.current) simRef.current.alpha(0.3).restart()
  }, [activeViewId])

  // Zoom setup
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    zoomBehaviorRef.current = d3.zoom()
      .scaleExtent([0.08, 4])
      .filter(e => {
        if (e.type === 'wheel') return true
        if (e.type === 'mousedown') return e.target === svgRef.current
        return true
      })
      .on('zoom', e => { zoomTransformRef.current = e.transform; scheduleRender() })
    svg.call(zoomBehaviorRef.current)
    svg.on('dblclick.zoom', null)
    return () => svg.on('.zoom', null)
  }, [scheduleRender])

  // Keyboard: Delete selected / Escape to deselect
  useEffect(() => {
    const onKey = e => {
      if (document.activeElement?.tagName === 'INPUT') return
      if (e.key === 'Escape') { setSelected(null); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selected) return
        if (selected.type === 'edge') removeEdge(selected.id)
        if (selected.type === 'node') deleteNode(selected.id)
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, removeEdge, deleteNode])

  const clientToSim = useCallback((clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect()
    return zoomTransformRef.current.invert([clientX - rect.left, clientY - rect.top])
  }, [])

  // Drag node body → anchor
  const handleNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    setSelected({ id: nodeId, type: 'node' })
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    simRef.current.alphaTarget(0.3).restart()
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      simNode.fx = sx; simNode.fy = sy
    }
    const onUp = ue => {
      simRef.current.alphaTarget(0)
      const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
      simNode.fx = sx; simNode.fy = sy
      setAnchor(nodeId, sx, sy)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setAnchor])

  // Drag connector → connect or create new node
  const handleConnectorMouseDown = useCallback((e, sourceId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
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
        const dx = (n.x || 0) - sx, dy = (n.y || 0) - sy
        return Math.sqrt(dx * dx + dy * dy) < NODE_R + 20
      })
      if (target) {
        addEdge(sourceId, target.id)
      } else {
        // Drop on empty space → spawn new node at that position
        addNode('New node', sourceId, sx, sy)
      }
      setConnecting(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, addEdge, addNode])

  // Release anchor: clear sim node fx/fy immediately + update store
  const handleRelease = useCallback((nodeId) => {
    releaseAnchor(nodeId)
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (simNode) { simNode.fx = null; simNode.fy = null }
    if (simRef.current) simRef.current.alpha(0.3).restart()
  }, [releaseAnchor])

  // Zoom extents
  const zoomExtents = useCallback(() => {
    const vis = simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && n.x != null)
    if (!vis.length || !svgRef.current || !zoomBehaviorRef.current) return
    const xs = vis.map(n => n.x), ys = vis.map(n => n.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const w = svgRef.current.clientWidth, h = svgRef.current.clientHeight, pad = 100
    const k = Math.min((w - pad * 2) / Math.max(maxX - minX, 1), (h - pad * 2) / Math.max(maxY - minY, 1), 2)
    const t = d3.zoomIdentity.translate(w / 2 - k * (minX + maxX) / 2, h / 2 - k * (minY + maxY) / 2).scale(k)
    d3.select(svgRef.current).call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
  }, [visibleNodeIds, scheduleRender])

  const T = zoomTransformRef.current
  const selectedNode = selected?.type === 'node'
    ? simNodesRef.current.find(n => n.id === selected.id)
    : null

  if (loading) return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', background: '#0c0c1a' }}>
      Loading project…
    </div>
  )

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left sidebar */}
      <div style={sidebarStyle}>
        <OutlinePanel
          selectedNodeId={selected?.type === 'node' ? selected.id : null}
          onSelectNode={id => setSelected({ id, type: 'node' })}
        />
        <ViewManager />
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <svg ref={svgRef}
          style={{ width: '100%', height: '100%', background: '#0c0c1a', display: 'block' }}
          onClick={() => setSelected(null)}
        >
          <defs>
            <marker id="arr" markerWidth="7" markerHeight="7" refX="20" refY="3.5" orient="auto">
              <path d="M0,0 L0,7 L7,3.5 z" fill="#334155" />
            </marker>
            <marker id="arr-sel" markerWidth="7" markerHeight="7" refX="20" refY="3.5" orient="auto">
              <path d="M0,0 L0,7 L7,3.5 z" fill="#5b6af0" />
            </marker>
          </defs>

          <g transform={`translate(${T.x},${T.y}) scale(${T.k})`}>
            {/* Edges */}
            {simEdgesRef.current.map(e => {
              const s = e.source, t = e.target
              if (!s || !t || s.x == null) return null
              if (!visibleNodeIds.has(s.id) || !visibleNodeIds.has(t.id)) return null
              const isSel = selected?.id === e.id && selected?.type === 'edge'
              const sr = NODE_R * (getVP(s.id).scale || 1)
              const tr = NODE_R * (getVP(t.id).scale || 1)
              const dx = t.x - s.x, dy = t.y - s.y, dist = Math.sqrt(dx * dx + dy * dy) || 1
              const ux = dx / dist, uy = dy / dist
              const x1 = s.x + ux * (sr + 2), y1 = s.y + uy * (sr + 2)
              const x2 = t.x - ux * (tr + 2), y2 = t.y - uy * (tr + 2)
              const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
              return (
                <g key={e.id}
                  onClick={ev => { ev.stopPropagation(); setSelected({ id: e.id, type: 'edge' }) }}
                  style={{ cursor: 'pointer' }}
                >
                  {/* Wide invisible hit area */}
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
                  <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={isSel ? '#5b6af0' : '#334155'}
                    strokeWidth={isSel ? 2.5 : 1.5}
                    markerEnd={`url(#${isSel ? 'arr-sel' : 'arr'})`}
                  />
                  {isSel && (
                    <g transform={`translate(${mx},${my})`}
                      onClick={ev => { ev.stopPropagation(); removeEdge(e.id); setSelected(null) }}
                      style={{ cursor: 'pointer' }}
                    >
                      <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
                      <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect: 'none' }}>×</text>
                    </g>
                  )}
                </g>
              )
            })}

            {/* Temp connection line */}
            {connecting && (
              <line x1={connecting.x1} y1={connecting.y1} x2={connecting.x2} y2={connecting.y2}
                stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.7} />
            )}

            {/* Nodes */}
            {simNodesRef.current
              .filter(n => visibleNodeIds.has(n.id))
              .map(n => (
                <NodeShape key={n.id} node={n}
                  viewProps={getVP(n.id)}
                  isSelected={selected?.id === n.id && selected?.type === 'node'}
                  onMouseDown={handleNodeMouseDown}
                  onConnectorMouseDown={handleConnectorMouseDown}
                  onRelease={handleRelease}
                  onDelete={deleteNode}
                  onLabelChange={updateLabel}
                />
              ))}
          </g>
        </svg>

        {/* Node toolbar overlay */}
        {selectedNode && visibleNodeIds.has(selectedNode.id) && (
          <NodeToolbar
            x={T.x + (selectedNode.x || 0) * T.k}
            y={T.y + (selectedNode.y || 0) * T.k + NODE_R * (getVP(selectedNode.id).scale || 1) * T.k + 12}
            viewProps={getVP(selectedNode.id)}
            onSetProp={(p, v) => setNodeViewProp(selectedNode.id, p, v)}
            onRelease={() => releaseAnchor(selectedNode.id)}
            onDrill={() => { setDrillRoot(selectedNode.id); setSelected(null) }}
            onHide={() => { setNodeViewProp(selectedNode.id, 'visible', false); setSelected(null) }}
          />
        )}

        {/* Project name + save status (top-left of canvas) */}
        <div style={{ position: 'absolute', top: 10, left: 12, display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
          <span style={{ fontSize: '0.75rem', color: '#333', fontWeight: 600 }}>{projectName}</span>
          <span style={{ fontSize: '0.68rem', color: saveStatus === 'error' ? '#f87171' : saveStatus === 'saving' ? '#5b6af0' : '#2a3a2a' }}>
            {saveStatus === 'error' ? '● save failed' : saveStatus === 'saving' ? '● saving…' : '● saved'}
          </span>
        </div>

        {/* Canvas buttons */}
        <div style={canvasBtnsStyle}>
          {drillRoot && (
            <button style={canvasBtnStyle} onClick={exitDrill}>↑ Exit Drill</button>
          )}
          <button style={canvasBtnStyle} onClick={zoomExtents}>⊡ Fit</button>
          <button style={canvasBtnStyle} onClick={() => addNode('New node')}>+ Node</button>
        </div>
      </div>
    </div>
  )
}

// ─── NodeShape ────────────────────────────────────────────────────────────────

function NodeShape({ node, viewProps, isSelected, onMouseDown, onConnectorMouseDown, onRelease, onDelete, onLabelChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const inputRef = useRef()

  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])
  // Select all text when editing starts
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const commitEdit = () => { onLabelChange(node.id, draft); setEditing(false) }

  const isAnchored = node.fx != null
  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const fontSize = Math.max(8, Math.round(11.5 * scale))
  const fill = viewProps.fillColor || DEFAULT_NODE_PROPS.fillColor
  const stroke = isAnchored ? '#f6ad55' : isSelected ? '#5b6af0' : (viewProps.strokeColor || DEFAULT_NODE_PROPS.strokeColor)
  const x = node.x ?? 0, y = node.y ?? 0

  return (
    <g transform={`translate(${x},${y})`}
      onMouseDown={e => onMouseDown(e, node.id)}
      onClick={e => e.stopPropagation()}
      style={{ cursor: isAnchored ? 'move' : 'grab' }}
    >
      {/* Selection / anchor glow */}
      {(isSelected || isAnchored) && (
        <circle r={r + 5} fill="none"
          stroke={isAnchored ? '#f6ad55' : '#5b6af0'}
          strokeWidth={1} opacity={0.2}
        />
      )}

      {/* Main body */}
      <circle r={r} fill={fill} stroke={stroke} strokeWidth={isAnchored || isSelected ? 2 : 1.5} />

      {/* Label */}
      {editing ? (
        <foreignObject x={-r + 4} y={-11} width={(r - 4) * 2} height={22}
          onMouseDown={e => e.stopPropagation()}>
          <input ref={inputRef} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
            style={{ width: '100%', background: '#1e1e3a', border: 'none', outline: '1px solid #5b6af0', borderRadius: 3, color: '#fff', textAlign: 'center', fontSize: fontSize - 1, padding: '1px 0' }}
          />
        </foreignObject>
      ) : (
        <text textAnchor="middle" dominantBaseline="middle"
          fill="#c7d0f8" fontSize={fontSize} fontFamily="-apple-system, sans-serif"
          style={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label}
        </text>
      )}

      {/* Invisible overlay: double-click to edit */}
      <circle r={r} fill="transparent"
        onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true) }}
        style={{ cursor: 'text' }}
      />

      {/* Connector handle */}
      <circle cx={r + 6} cy={0} r={5}
        fill="#5b6af0" stroke="#0c0c1a" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectorMouseDown(e, node.id) }}
        style={{ cursor: 'crosshair' }}
      />

      {/* Release anchor (top-left, only when anchored) */}
      {isAnchored && (
        <g transform={`translate(${-r + 2},${-r + 2})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRelease(node.id) }}
          style={{ cursor: 'pointer' }}
        >
          <circle r={9} fill="#1a1a2e" stroke="#f6ad55" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#f6ad55" style={{ userSelect: 'none' }}>⊙</text>
        </g>
      )}

      {/* Delete (top-right, only when selected) */}
      {isSelected && (
        <g transform={`translate(${r - 2},${-r + 2})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDelete(node.id) }}
          style={{ cursor: 'pointer' }}
        >
          <circle r={8} fill="#1a1a2e" stroke="#4a3a3a" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#f87171" style={{ userSelect: 'none' }}>×</text>
        </g>
      )}
    </g>
  )
}

// ─── NodeToolbar ──────────────────────────────────────────────────────────────

function NodeToolbar({ x, y, viewProps, onSetProp, onRelease, onDrill, onHide }) {
  const scale = viewProps.scale || 1
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, transform: 'translateX(-50%)',
        background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8,
        padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5,
        boxShadow: '0 4px 20px rgba(0,0,0,0.6)', zIndex: 20,
        minWidth: 225, pointerEvents: 'all',
      }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <Row label="Fill">
        {FILL_COLORS.map(c => (
          <Swatch key={c} bg={c} active={viewProps.fillColor === c} onClick={() => onSetProp('fillColor', c)} />
        ))}
      </Row>
      <Row label="Ring">
        {STROKE_COLORS.map(c => (
          <Swatch key={c} bg="transparent" border={c} active={viewProps.strokeColor === c} onClick={() => onSetProp('strokeColor', c)} />
        ))}
      </Row>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
        <span style={tlLabel}>Size</span>
        <button style={tlBtn} onClick={() => onSetProp('scale', +(Math.max(0.3, scale - 0.2)).toFixed(1))}>−</button>
        <span style={{ fontSize: 10, color: '#888', minWidth: 32, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button style={tlBtn} onClick={() => onSetProp('scale', +(Math.min(3, scale + 0.2)).toFixed(1))}>+</button>
        <div style={{ flex: 1 }} />
        <button style={{ ...tlBtn, color: '#666' }} onClick={onHide} title="Hide in this view">Hide</button>
        <button style={{ ...tlBtn, color: '#5b6af0' }} onClick={onDrill} title="Show only this subtree">⊳ Drill</button>
      </div>
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      <span style={tlLabel}>{label}</span>
      {children}
    </div>
  )
}

function Swatch({ bg, border, active, onClick }) {
  return (
    <div onClick={onClick} style={{
      width: 15, height: 15, borderRadius: '50%', background: bg,
      border: active ? '2px solid #fff' : `2px solid ${border || bg}`,
      cursor: 'pointer', flexShrink: 0,
    }} />
  )
}

const tlLabel = { fontSize: 9, color: '#555', width: 22, flexShrink: 0 }
const tlBtn = { background: 'transparent', border: '1px solid #2d3a6a', color: '#aaa', cursor: 'pointer', fontSize: '0.72rem', padding: '1px 6px', borderRadius: 4 }

const sidebarStyle = {
  width: 220, minWidth: 220, display: 'flex', flexDirection: 'column',
  background: '#111118', borderRight: '1px solid #1e1e2e',
}

const canvasBtnsStyle = {
  position: 'absolute', bottom: '1.25rem', right: '1.25rem',
  display: 'flex', gap: 8,
}

const canvasBtnStyle = {
  padding: '0.45rem 0.85rem', borderRadius: 7,
  border: '1px solid #2d3a6a', background: '#12122a',
  color: '#5b6af0', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
  boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
}
