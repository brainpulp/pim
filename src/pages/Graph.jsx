import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as d3 from 'd3'
import useGraphStore, { DEFAULT_NODE_PROPS, NODE_R, FILL_COLORS } from '../lib/graphStore'
import OutlinePanel from '../components/OutlinePanel'
import ViewManager from '../components/ViewManager'
import { loadProject, saveProject } from '../lib/db'

export default function Graph({ projectId, projectName }) {
  const svgRef = useRef()
  const simRef = useRef(null)
  const zoomBehaviorRef = useRef(null)
  const simNodesRef = useRef([])
  const simEdgesRef = useRef([])
  const zoomTransformRef = useRef(d3.zoomIdentity)
  const frameRef = useRef(null)
  const [tick, setTick] = useState(0)
  const [connecting, setConnecting] = useState(null)
  const [selected, setSelected] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(220)

  const loadProjectData   = useGraphStore(s => s.loadProjectData)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState('saved')
  const saveTimer = useRef(null)

  useEffect(() => {
    setLoading(true)
    loadProject(projectId)
      .then(data => loadProjectData({ nodes: data.nodes, edges: data.edges, views: data.views, activeViewId: data.active_view_id }))
      .catch(e => console.error('Load failed:', e))
      .finally(() => setLoading(false))
  }, [projectId]) // eslint-disable-line

  const storeNodes      = useGraphStore(s => s.nodes)
  const storeEdges      = useGraphStore(s => s.edges)
  const activeViewId    = useGraphStore(s => s.activeViewId)
  const views           = useGraphStore(s => s.views)
  const addNode         = useGraphStore(s => s.addNode)
  const addEdge         = useGraphStore(s => s.addEdge)
  const removeEdge      = useGraphStore(s => s.removeEdge)
  const deleteNode      = useGraphStore(s => s.deleteNode)
  const setAnchor       = useGraphStore(s => s.setAnchor)
  const releaseAnchor   = useGraphStore(s => s.releaseAnchor)
  const releaseAllAnchors = useGraphStore(s => s.releaseAllAnchors)
  const updateLabel     = useGraphStore(s => s.updateLabel)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const setDrillRoot    = useGraphStore(s => s.setDrillRoot)
  const exitDrill       = useGraphStore(s => s.exitDrill)

  const activeView    = views.find(v => v.id === activeViewId) || views[0]
  const viewNodeProps = activeView?.nodeProps || {}
  const drillRoot     = activeView?.drillRoot || null

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

  // Topology → sim
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
      simRef.current.nodes(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(150).strength(0.4))
        .alpha(0.4).restart()
    }
  }, [storeNodes, storeEdges, scheduleRender]) // eslint-disable-line

  // View switch → reload anchors
  useEffect(() => {
    const { views, activeViewId } = useGraphStore.getState()
    const vp = views.find(v => v.id === activeViewId)?.nodeProps || {}
    simNodesRef.current.forEach(n => {
      const p = { ...DEFAULT_NODE_PROPS, ...(vp[n.id] || {}) }
      n.fx = p.fx ?? null; n.fy = p.fy ?? null
    })
    if (simRef.current) simRef.current.alpha(0.3).restart()
  }, [activeViewId])

  // Zoom — pan when clicking canvas background (not on a node)
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    zoomBehaviorRef.current = d3.zoom()
      .scaleExtent([0.08, 4])
      .filter(e => {
        if (e.type === 'wheel') return true
        if (e.type === 'mousedown') return !e.target.closest?.('[data-node]')
        return true
      })
      .on('zoom', e => { zoomTransformRef.current = e.transform; scheduleRender() })
    svg.call(zoomBehaviorRef.current)
    svg.on('dblclick.zoom', null)
    return () => svg.on('.zoom', null)
  }, [scheduleRender])

  // Keyboard
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
      if (target) addEdge(sourceId, target.id)
      else addNode('New node', sourceId, sx, sy)
      setConnecting(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, addEdge, addNode])

  const handleScaleMouseDown = useCallback((e, nodeId, currentScale) => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const startDist = Math.sqrt((sx0 - simNode.x) ** 2 + (sy0 - simNode.y) ** 2)
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const dist = Math.sqrt((sx - simNode.x) ** 2 + (sy - simNode.y) ** 2)
      if (startDist < 1) return
      setNodeViewProp(nodeId, 'scale', Math.max(0.3, Math.min(3, Math.round(currentScale * dist / startDist * 10) / 10)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleRelease = useCallback((nodeId) => {
    releaseAnchor(nodeId)
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (simNode) { simNode.fx = null; simNode.fy = null }
    if (simRef.current) simRef.current.alpha(0.3).restart()
  }, [releaseAnchor])

  const handleReleaseAll = useCallback(() => {
    releaseAllAnchors()
    simNodesRef.current.forEach(n => { n.fx = null; n.fy = null })
    if (simRef.current) simRef.current.alpha(0.5).restart()
  }, [releaseAllAnchors])

  const zoomExtents = useCallback(() => {
    const vis = simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && n.x != null && !isNaN(n.x))
    if (!vis.length || !svgRef.current || !zoomBehaviorRef.current) return
    const xs = vis.map(n => n.x), ys = vis.map(n => n.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const rangeX = Math.max(maxX - minX, NODE_R * 6)
    const rangeY = Math.max(maxY - minY, NODE_R * 6)
    const w = svgRef.current.clientWidth, h = svgRef.current.clientHeight, pad = 80
    const k = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY, 2.5)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const t = d3.zoomIdentity.translate(w / 2 - k * cx, h / 2 - k * cy).scale(k)
    d3.select(svgRef.current).call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
  }, [visibleNodeIds, scheduleRender])

  const handleSplitMouseDown = useCallback(() => {
    const onMove = e => setSidebarWidth(Math.max(140, Math.min(500, e.clientX)))
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

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
      <div style={{ width: sidebarWidth, minWidth: sidebarWidth, display: 'flex', flexDirection: 'column', background: '#111118', overflow: 'hidden' }}>
        <OutlinePanel
          selectedNodeId={selected?.type === 'node' ? selected.id : null}
          onSelectNode={id => setSelected({ id, type: 'node' })}
        />
        <ViewManager />
      </div>

      {/* Resize handle */}
      <div style={{ width: 4, cursor: 'col-resize', background: '#1e1e2e', flexShrink: 0 }}
        onMouseDown={handleSplitMouseDown}
        onMouseEnter={e => e.currentTarget.style.background = '#5b6af0'}
        onMouseLeave={e => e.currentTarget.style.background = '#1e1e2e'}
      />

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
                <g key={e.id} onClick={ev => { ev.stopPropagation(); setSelected({ id: e.id, type: 'edge' }) }} style={{ cursor: 'pointer' }}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
                  <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={isSel ? '#5b6af0' : '#334155'}
                    strokeWidth={isSel ? 2.5 : 1.5}
                    markerEnd={`url(#${isSel ? 'arr-sel' : 'arr'})`}
                  />
                  {isSel && (
                    <g transform={`translate(${mx},${my})`}
                      onClick={ev => { ev.stopPropagation(); removeEdge(e.id); setSelected(null) }}
                      style={{ cursor: 'pointer' }}>
                      <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
                      <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect: 'none' }}>×</text>
                    </g>
                  )}
                </g>
              )
            })}

            {connecting && (
              <line x1={connecting.x1} y1={connecting.y1} x2={connecting.x2} y2={connecting.y2}
                stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.7} />
            )}

            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id)).map(n => (
              <NodeShape key={n.id} node={n}
                viewProps={getVP(n.id)}
                isSelected={selected?.id === n.id && selected?.type === 'node'}
                onMouseDown={handleNodeMouseDown}
                onConnectorMouseDown={handleConnectorMouseDown}
                onScaleMouseDown={handleScaleMouseDown}
                onRelease={handleRelease}
                onDelete={deleteNode}
                onLabelChange={updateLabel}
                onHide={id => { setNodeViewProp(id, 'visible', false); setSelected(null) }}
              />
            ))}
          </g>
        </svg>

        {/* Node toolbar (fill colors + drill only) */}
        {selectedNode && visibleNodeIds.has(selectedNode.id) && (
          <NodeToolbar
            x={T.x + (selectedNode.x || 0) * T.k}
            y={T.y + (selectedNode.y || 0) * T.k + NODE_R * (getVP(selectedNode.id).scale || 1) * T.k + 12}
            viewProps={getVP(selectedNode.id)}
            onSetFill={c => setNodeViewProp(selectedNode.id, 'fillColor', c)}
            onDrill={() => { setDrillRoot(selectedNode.id); setSelected(null) }}
          />
        )}

        {/* Save status */}
        <div style={{ position: 'absolute', top: 10, left: 12, pointerEvents: 'none' }}>
          <span style={{ fontSize: '0.68rem', color: saveStatus === 'error' ? '#f87171' : saveStatus === 'saving' ? '#5b6af0' : '#2a3a2a' }}>
            {saveStatus === 'error' ? '● save failed' : saveStatus === 'saving' ? '● saving…' : '● saved'}
          </span>
        </div>

        {/* Canvas buttons */}
        <div style={canvasBtnsStyle}>
          {drillRoot && <button style={canvasBtnStyle} onClick={exitDrill}>↑ Exit Drill</button>}
          <button style={canvasBtnStyle} onClick={handleReleaseAll}>⊙ Free All</button>
          <button style={canvasBtnStyle} onClick={zoomExtents}>⊡ Fit</button>
          <button style={canvasBtnStyle} onClick={() => addNode('New node')}>+ Node</button>
        </div>
      </div>
    </div>
  )
}

// ─── NodeShape ────────────────────────────────────────────────────────────────

function NodeShape({ node, viewProps, isSelected, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onRelease, onDelete, onHide, onLabelChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const inputRef = useRef()

  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const commitEdit = () => { onLabelChange(node.id, draft); setEditing(false) }

  const isAnchored = node.fx != null
  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const fontSize = Math.max(8, Math.round(11.5 * scale))
  const fill = viewProps.fillColor || DEFAULT_NODE_PROPS.fillColor
  const stroke = isAnchored ? '#f6ad55' : (viewProps.strokeColor || DEFAULT_NODE_PROPS.strokeColor)
  const x = node.x ?? 0, y = node.y ?? 0
  const hx = r * 0.707, hy = r * 0.707 // scale handle at 45°

  return (
    <g transform={`translate(${x},${y})`}
      data-node="true"
      onMouseDown={e => onMouseDown(e, node.id)}
      onClick={e => e.stopPropagation()}
      style={{ cursor: isAnchored ? 'move' : 'grab' }}
    >
      {/* Selection / anchor glow */}
      {(isSelected || isAnchored) && (
        <circle r={r + 6} fill="none"
          stroke={isAnchored ? '#f6ad55' : '#5b6af0'}
          strokeWidth={1.5} opacity={0.35}
        />
      )}

      <circle r={r} fill={fill} stroke={stroke} strokeWidth={isAnchored ? 2.5 : 1.5} />

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

      {/* Double-click overlay */}
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

      {/* Scale handle (bottom-right, selected only) */}
      {isSelected && (
        <g transform={`translate(${hx},${hy})`}
          onMouseDown={e => { e.stopPropagation(); onScaleMouseDown(e, node.id, scale) }}
          style={{ cursor: 'nwse-resize' }}>
          <circle r={6} fill="#0c0c1a" stroke="#5b6af0" strokeWidth={1.5} />
          <line x1={-3} y1={-3} x2={3} y2={3} stroke="#5b6af0" strokeWidth={1.5} />
          <line x1={0} y1={-3} x2={3} y2={0} stroke="#5b6af0" strokeWidth={1} />
        </g>
      )}

      {/* Release anchor (top-left, when anchored) */}
      {isAnchored && (
        <g transform={`translate(${-r + 2},${-r + 2})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRelease(node.id) }}
          style={{ cursor: 'pointer' }}>
          <circle r={9} fill="#1a1a2e" stroke="#f6ad55" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#f6ad55" style={{ userSelect: 'none' }}>⊙</text>
        </g>
      )}

      {/* Eye / hide (top-left, when selected and not anchored) */}
      {isSelected && !isAnchored && (
        <g transform={`translate(${-r + 2},${-r + 2})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onHide(node.id) }}
          style={{ cursor: 'pointer' }}>
          <circle r={9} fill="#1a1a2e" stroke="#555" strokeWidth={1.5} />
          <EyeIcon />
        </g>
      )}

      {/* Delete (top-right, selected only) */}
      {isSelected && (
        <g transform={`translate(${r - 2},${-r + 2})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDelete(node.id) }}
          style={{ cursor: 'pointer' }}>
          <circle r={8} fill="#1a1a2e" stroke="#4a3a3a" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#f87171" style={{ userSelect: 'none' }}>×</text>
        </g>
      )}
    </g>
  )
}

function EyeIcon() {
  return (
    <g>
      <ellipse rx={5} ry={3.5} fill="none" stroke="#aaa" strokeWidth={1.2} />
      <circle r={1.5} fill="#aaa" />
    </g>
  )
}

// ─── NodeToolbar (fill colors + drill only) ───────────────────────────────────

function NodeToolbar({ x, y, viewProps, onSetFill, onDrill }) {
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, transform: 'translateX(-50%)',
        background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8,
        padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5,
        boxShadow: '0 4px 20px rgba(0,0,0,0.6)', zIndex: 20, pointerEvents: 'all',
      }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <span style={tlLabel}>Fill</span>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', maxWidth: 160 }}>
          {FILL_COLORS.map(c => (
            <div key={c} onClick={() => onSetFill(c)} style={{
              width: 15, height: 15, borderRadius: '50%', background: c,
              border: viewProps.fillColor === c ? '2.5px solid #fff' : '1.5px solid rgba(255,255,255,0.15)',
              cursor: 'pointer', flexShrink: 0,
              boxShadow: viewProps.fillColor === c ? '0 0 0 1px #5b6af0' : 'none',
            }} />
          ))}
        </div>
        <button style={{ ...tlBtn, marginLeft: 4 }} onClick={onDrill}>⊳ Drill</button>
      </div>
    </div>
  )
}

const tlLabel = { fontSize: 9, color: '#555', width: 22, flexShrink: 0 }
const tlBtn = { background: 'transparent', border: '1px solid #2d3a6a', color: '#aaa', cursor: 'pointer', fontSize: '0.72rem', padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }
const canvasBtnsStyle = { position: 'absolute', bottom: '1.25rem', right: '1.25rem', display: 'flex', gap: 8 }
const canvasBtnStyle = {
  padding: '0.45rem 0.85rem', borderRadius: 7,
  border: '1px solid #2d3a6a', background: '#12122a',
  color: '#5b6af0', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
  boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
}
