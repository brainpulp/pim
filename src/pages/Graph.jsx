import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as d3 from 'd3'
import useGraphStore, { DEFAULT_NODE_PROPS, NODE_R, FILL_COLORS, TEXT_COLORS, SHAPES } from '../lib/graphStore'
import ViewManager from '../components/ViewManager'
import OutlinePanel from '../components/OutlinePanel'
import { loadProject, saveProject } from '../lib/db'

// ── Shape geometry ────────────────────────────────────────────────────────────
// Returns { halfW, halfH } — the bounding half-dimensions of a shape at scale r
function shapeDims(shape, r) {
  switch (shape) {
    case 'ellipse':   return { halfW: r * 1.45, halfH: r * 0.9 }
    case 'roundrect': return { halfW: r * 1.5,  halfH: r * 0.85 }
    case 'diamond':   return { halfW: r * 1.15, halfH: r * 1.15 }
    case 'none':      return { halfW: r * 1.2,  halfH: r * 0.55 }
    default:          return { halfW: r,         halfH: r }
  }
}

// ── Direction-aware clip distance (how far from center to node edge along dir) ─
function clipDist(shape, halfW, halfH, ux, uy) {
  if (shape === 'circle') return halfW
  // Ellipse formula works well as approximation for all shapes
  const denom = Math.sqrt((ux / halfW) ** 2 + (uy / halfH) ** 2)
  return denom > 0 ? 1 / denom : halfW
}

// ── Shape SVG body ────────────────────────────────────────────────────────────
function ShapeBody({ shape, halfW, halfH, r, fill, stroke, strokeWidth }) {
  if (shape === 'none') return null
  if (shape === 'roundrect')
    return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={10} ry={10} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  if (shape === 'ellipse')
    return <ellipse rx={halfW} ry={halfH} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  if (shape === 'diamond')
    return <polygon points={`0,${-halfH} ${halfW},0 0,${halfH} ${-halfW},0`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  // default: circle
  return <circle r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
}

// ── Label rendering (foreignObject for word-wrap) ─────────────────────────────
// Best practice: use HTML foreignObject inside SVG for text wrapping.
// It scales correctly with SVG zoom transforms in all modern browsers.
function NodeLabel({ label, halfW, halfH, fontSize, textColor }) {
  return (
    <foreignObject x={-halfW + 5} y={-halfH + 3} width={(halfW - 5) * 2} height={(halfH - 3) * 2}
      style={{ pointerEvents: 'none', overflow: 'visible' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%',
        color: textColor || '#fff', fontSize, fontFamily: '-apple-system, sans-serif',
        wordBreak: 'break-word', textAlign: 'center', lineHeight: 1.25,
        overflow: 'hidden', userSelect: 'none',
        textShadow: '0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
      }}>
        {label}
      </div>
    </foreignObject>
  )
}

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
  const [hoveredNodeId, setHoveredNodeId] = useState(null)
  const hideTimerRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(null) // nodeId or null
  const [pendingEditId, setPendingEditId] = useState(null)

  const showToolbar = useCallback((nodeId) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    setHoveredNodeId(nodeId)
  }, [])
  const hideToolbar = useCallback(() => {
    hideTimerRef.current = setTimeout(() => setHoveredNodeId(null), 180)
  }, [])

  const loadProjectData   = useGraphStore(s => s.loadProjectData)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState('saved')
  const saveTimer = useRef(null)

  useEffect(() => {
    setLoading(true)
    loadProject(projectId)
      .then(d => loadProjectData({ nodes: d.nodes, edges: d.edges, views: d.views, activeViewId: d.active_view_id }))
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
  const updateNotes     = useGraphStore(s => s.updateNotes)
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
      } catch (e) { console.error('Save:', e); setSaveStatus('error') }
    }, 1500)
    return () => clearTimeout(saveTimer.current)
  }, [storeNodes, storeEdges, views, activeViewId, projectId, loading]) // eslint-disable-line

  const getVP = useCallback((nodeId) => ({
    ...DEFAULT_NODE_PROPS, ...(viewNodeProps[nodeId] || {}),
  }), [viewNodeProps])

  const visibleNodeIds = useMemo(() => {
    if (drillRoot) {
      const desc = new Set([drillRoot])
      const q = [drillRoot]
      while (q.length) {
        const cur = q.shift()
        storeEdges.forEach(e => { if (e.source === cur && !desc.has(e.target)) { desc.add(e.target); q.push(e.target) } })
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
        id: n.id, label: n.label, notes: n.notes || '',
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
        .alphaDecay(0.015).on('tick', scheduleRender)
    } else {
      simRef.current.nodes(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(150).strength(0.4))
        .alpha(0.4).restart()
    }
  }, [storeNodes, storeEdges, scheduleRender]) // eslint-disable-line

  useEffect(() => {
    const { views, activeViewId } = useGraphStore.getState()
    const vp = views.find(v => v.id === activeViewId)?.nodeProps || {}
    simNodesRef.current.forEach(n => {
      const p = { ...DEFAULT_NODE_PROPS, ...(vp[n.id] || {}) }
      n.fx = p.fx ?? null; n.fy = p.fy ?? null
    })
    if (simRef.current) simRef.current.alpha(0.3).restart()
  }, [activeViewId])

  // Zoom — pan on background only (not on nodes)
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    zoomBehaviorRef.current = d3.zoom()
      .scaleExtent([0.04, 10])
      .filter(e => !e.target.closest?.('[data-node]'))
      .on('zoom', e => { zoomTransformRef.current = e.transform; scheduleRender() })
    svg.call(zoomBehaviorRef.current)
    svg.on('dblclick.zoom', null)
    return () => svg.on('.zoom', null)
  }, [scheduleRender, loading])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = e => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') { setSelected(null); setConfirmDelete(null); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        if (selected.type === 'edge') { removeEdge(selected.id); setSelected(null) }
        if (selected.type === 'node') { setConfirmDelete(selected.id) }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        setPendingEditId(addNode('New node', selected?.type === 'node' ? selected.id : null))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, removeEdge, addNode])

  const clientToSim = useCallback((clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect()
    return zoomTransformRef.current.invert([clientX - rect.left, clientY - rect.top])
  }, [])

  const handleNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    setSelected({ id: nodeId, type: 'node' })
    setHoveredNodeId(null) // hide toolbar while dragging
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    simRef.current.alphaTarget(0.3).restart()

    // Shift-drag: collect exclusive descendants (children with only one parent)
    let dragGroup = [simNode]
    if (e.shiftKey) {
      const parentCount = {}
      storeEdges.forEach(ed => { parentCount[ed.target] = (parentCount[ed.target] || 0) + 1 })
      const exclusiveDescendants = (id) => {
        storeEdges.forEach(ed => {
          if (ed.source === id && parentCount[ed.target] === 1) {
            const child = simNodesRef.current.find(n => n.id === ed.target)
            if (child) { dragGroup.push(child); exclusiveDescendants(ed.target) }
          }
        })
      }
      exclusiveDescendants(nodeId)
    }

    const [startSx, startSy] = clientToSim(e.clientX, e.clientY)
    const startPositions = dragGroup.map(n => ({ node: n, ox: n.fx ?? n.x ?? 0, oy: n.fy ?? n.y ?? 0 }))
    let didDrag = false

    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const ddx = sx - startSx, ddy = sy - startSy
      if (!didDrag && Math.abs(ddx) < 2 && Math.abs(ddy) < 2) return
      didDrag = true
      startPositions.forEach(({ node, ox, oy }) => { node.fx = ox + ddx; node.fy = oy + ddy })
    }
    const onUp = ue => {
      simRef.current.alphaTarget(0)
      if (didDrag) {
        const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
        const ddx = sx - startSx, ddy = sy - startSy
        startPositions.forEach(({ node, ox, oy }) => {
          node.fx = ox + ddx; node.fy = oy + ddy
          setAnchor(node.id, node.fx, node.fy)
        })
      }
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setAnchor, storeEdges])

  const handleConnectorMouseDown = useCallback((e, sourceId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const src = simNodesRef.current.find(n => n.id === sourceId)
    if (!src) return
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      setConnecting({ sourceId, x1: src.x, y1: src.y, x2: sx, y2: sy })
    }
    const onUp = ue => {
      const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
      const hit = simNodesRef.current.find(n => {
        if (n.id === sourceId) return false
        const dx = (n.x||0)-sx, dy = (n.y||0)-sy
        return Math.sqrt(dx*dx+dy*dy) < NODE_R + 20
      })
      if (hit) addEdge(sourceId, hit.id)
      else setPendingEditId(addNode('New node', sourceId, sx, sy))
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
    const startDist = Math.sqrt((sx0 - simNode.x)**2 + (sy0 - simNode.y)**2)
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const d = Math.sqrt((sx - simNode.x)**2 + (sy - simNode.y)**2)
      if (startDist < 1) return
      setNodeViewProp(nodeId, 'scale', Math.max(0.3, Math.min(6, Math.round(currentScale * d / startDist * 10) / 10)))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleRelease = useCallback((nodeId) => {
    releaseAnchor(nodeId)
    const s = simNodesRef.current.find(n => n.id === nodeId)
    if (s) { s.fx = null; s.fy = null }
    simRef.current?.alpha(0.3).restart()
  }, [releaseAnchor])

  const handleReleaseAll = useCallback(() => {
    releaseAllAnchors()
    simNodesRef.current.forEach(n => { n.fx = null; n.fy = null })
    simRef.current?.alpha(0.5).restart()
  }, [releaseAllAnchors])

  const zoomExtents = useCallback(() => {
    const vis = simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && n.x != null && !isNaN(n.x))
    if (!vis.length || !svgRef.current || !zoomBehaviorRef.current) return
    const xs = vis.map(n => n.x), ys = vis.map(n => n.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const w = svgRef.current.clientWidth, h = svgRef.current.clientHeight, pad = 80
    const k = Math.min((w-pad*2) / Math.max(maxX-minX, NODE_R*6), (h-pad*2) / Math.max(maxY-minY, NODE_R*6), 2.5)
    const t = d3.zoomIdentity.translate(w/2 - k*(minX+maxX)/2, h/2 - k*(minY+maxY)/2).scale(k)
    d3.select(svgRef.current).call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
  }, [visibleNodeIds, scheduleRender])

  const handleNodeTab = useCallback((nodeId) => {
    const parentEdge = storeEdges.find(e => e.target === nodeId)
    const parentId = parentEdge?.source || null
    let siblings
    if (parentId) {
      siblings = storeEdges.filter(e => e.source === parentId).map(e => e.target)
    } else {
      const hasParent = new Set(storeEdges.map(e => e.target))
      siblings = storeNodes.filter(n => !hasParent.has(n.id)).map(n => n.id)
    }
    const idx = siblings.indexOf(nodeId)
    const nextId = siblings[idx + 1]
    setPendingEditId(nextId ?? addNode('', parentId))
  }, [storeEdges, storeNodes, addNode])

  const T = zoomTransformRef.current
  const selectedNode = selected?.type === 'node' ? simNodesRef.current.find(n => n.id === selected.id) : null
  const selectedStoreNode = selectedNode ? storeNodes.find(n => n.id === selectedNode.id) : null

  if (loading) return <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'#444', background:'#0c0c1a' }}>Loading project…</div>

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Outline sidebar */}
      <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid #1e1e2e', background: '#0d0d1a', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <OutlinePanel selectedNodeId={selected?.type === 'node' ? selected.id : null} onSelectNode={id => setSelected({ id, type: 'node' })} />
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%', background: '#0c0c1a', display: 'block' }} onClick={() => setSelected(null)}>
          <defs>
            <marker id="arr" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,8 L8,4 z" fill="#334155" /></marker>
            <marker id="arr-sel" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,8 L8,4 z" fill="#5b6af0" /></marker>
          </defs>

          <g transform={`translate(${T.x},${T.y}) scale(${T.k})`}>
            {/* Edges */}
            {simEdgesRef.current.map(e => {
              const s = e.source, t = e.target
              if (!s || !t || s.x == null) return null
              if (!visibleNodeIds.has(s.id) || !visibleNodeIds.has(t.id)) return null
              const isSel = selected?.id === e.id && selected?.type === 'edge'
              const svp = getVP(s.id), tvp = getVP(t.id)
              const { halfW: swW, halfH: swH } = shapeDims(svp.shape || 'circle', NODE_R * (svp.scale||1))
              const { halfW: twW, halfH: twH } = shapeDims(tvp.shape || 'circle', NODE_R * (tvp.scale||1))
              const dx = t.x-s.x, dy = t.y-s.y, dist = Math.sqrt(dx*dx+dy*dy)||1
              const ux = dx/dist, uy = dy/dist
              const sd = clipDist(svp.shape||'circle', swW, swH, ux, uy)
              const td = clipDist(tvp.shape||'circle', twW, twH, ux, uy)
              const x1 = s.x + ux*sd, y1 = s.y + uy*sd
              // Pull endpoint 8 units inside the node so arrowhead overlaps fill — no gap
              const x2 = t.x - ux*(td - 8), y2 = t.y - uy*(td - 8)
              const mx=(x1+x2)/2, my=(y1+y2)/2
              return (
                <g key={e.id} onClick={ev => { ev.stopPropagation(); setSelected({ id: e.id, type: 'edge' }) }} style={{ cursor:'pointer' }}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={isSel?'#5b6af0':'#334155'} strokeWidth={isSel?2.5:1.5} markerEnd={`url(#${isSel?'arr-sel':'arr'})`} />
                  {isSel && (
                    <g transform={`translate(${mx},${my})`} onClick={ev => { ev.stopPropagation(); removeEdge(e.id); setSelected(null) }} style={{ cursor:'pointer' }}>
                      <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
                      <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect:'none' }}>×</text>
                    </g>
                  )}
                </g>
              )
            })}

            {connecting && <line x1={connecting.x1} y1={connecting.y1} x2={connecting.x2} y2={connecting.y2} stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.7} />}

            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id)).map(n => (
              <NodeShape key={n.id} node={n}
                viewProps={getVP(n.id)}
                isSelected={selected?.id === n.id && selected?.type === 'node'}
                isHovered={hoveredNodeId === n.id}
                autoEdit={pendingEditId === n.id}
                onAutoEditDone={() => setPendingEditId(null)}
                onMouseDown={handleNodeMouseDown}
                onConnectorMouseDown={handleConnectorMouseDown}
                onScaleMouseDown={handleScaleMouseDown}
                onDelete={id => setConfirmDelete(id)}
                onLabelChange={updateLabel}
                onTab={handleNodeTab}
                onMouseEnter={() => showToolbar(n.id)}
                onMouseLeave={hideToolbar}
              />
            ))}
          </g>
        </svg>

        {/* Node toolbar — shows on hover */}
        {(() => {
          const hn = hoveredNodeId && simNodesRef.current.find(n => n.id === hoveredNodeId)
          const hs = hn && storeNodes.find(n => n.id === hn.id)
          if (!hn || !hs || !visibleNodeIds.has(hn.id)) return null
          const vp = getVP(hn.id)
          return (
            <NodeToolbar
              x={T.x + (hn.x||0) * T.k}
              y={T.y + (hn.y||0) * T.k + shapeDims(vp.shape||'circle', NODE_R*(vp.scale||1)).halfH * T.k + 14}
              viewProps={vp}
              notes={hs.notes || ''}
              onSetFill={c => setNodeViewProp(hn.id, 'fillColor', c)}
              onSetTextColor={c => setNodeViewProp(hn.id, 'textColor', c)}
              onSetShape={s => setNodeViewProp(hn.id, 'shape', s)}
              onDrill={() => { setDrillRoot(hn.id); setHoveredNodeId(null) }}
              onHide={() => { setNodeViewProp(hn.id, 'visible', false); setHoveredNodeId(null) }}
              onRelease={() => handleRelease(hn.id)}
              onDelete={() => { setConfirmDelete(hn.id); setHoveredNodeId(null) }}
              onNotesChange={notes => updateNotes(hn.id, notes)}
              isAnchored={hn.fx != null}
              onMouseEnter={() => showToolbar(hn.id)}
              onMouseLeave={hideToolbar}
            />
          )
        })()}

        {/* Delete confirm */}
        {confirmDelete && (
          <div style={confirmStyle} onClick={() => setConfirmDelete(null)}>
            <div style={confirmBox} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
                Delete node from <strong>all views</strong>?
              </div>
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button style={confirmCancelBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                <button style={confirmOkBtn} onClick={() => { deleteNode(confirmDelete); setSelected(null); setConfirmDelete(null) }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* Save status */}
        <div style={{ position:'absolute', top:10, left:12, pointerEvents:'none' }}>
          <span style={{ fontSize:'0.68rem', color: saveStatus==='error'?'#f87171':saveStatus==='saving'?'#5b6af0':'#2a3a2a' }}>
            {saveStatus==='error'?'● save failed':saveStatus==='saving'?'● saving…':'● saved'}
          </span>
        </div>

        {/* Canvas buttons */}
        <div style={canvasBtnsStyle}>
          {drillRoot && <button style={canvasBtnStyle} onClick={exitDrill}>↑ Exit Drill</button>}
          <button style={canvasBtnStyle} onClick={handleReleaseAll}>⊙ Free All</button>
          <button style={canvasBtnStyle} onClick={zoomExtents}>⊡ Fit</button>
          <button style={canvasBtnStyle} onClick={() => setPendingEditId(addNode('New node', selected?.type === 'node' ? selected.id : null))}>+ Node</button>
        </div>

        {/* Views floating panel — bottom left */}
        <div style={{ position:'absolute', bottom:'1.25rem', left:'1rem', zIndex:20 }}>
          <ViewManager />
        </div>

        {/* Build timestamp — bottom right */}
        <div style={{ position:'absolute', bottom:'0.5rem', right:'0.75rem', zIndex:20, fontSize:'0.62rem', color:'#333', fontFamily:'monospace', userSelect:'none' }}>
          {new Date(__BUILD_TIME__).toISOString().slice(0,16).replace('T',' ')}
        </div>
      </div>
    </div>
  )
}

// ─── NodeShape ────────────────────────────────────────────────────────────────

function NodeShape({ node, viewProps, isSelected, isHovered, autoEdit, onAutoEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onDelete, onLabelChange, onTab, onMouseEnter, onMouseLeave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const inputRef = useRef()

  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  // Auto-enter edit on creation
  useEffect(() => {
    if (autoEdit) {
      setDraft('')
      setEditing(true)
      onAutoEditDone?.()
    }
  }, []) // eslint-disable-line

  const commitEdit = () => { onLabelChange(node.id, draft.trim() || 'New node'); setEditing(false) }

  const isAnchored = node.fx != null
  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const shape = viewProps.shape || 'circle'
  const { halfW, halfH } = shapeDims(shape, r)
  const fontSize = Math.max(9, Math.round(12 * scale))
  const fill = viewProps.fillColor || DEFAULT_NODE_PROPS.fillColor
  const hasNotes = !!(node.notes && node.notes.length > 0)
  const x = node.x ?? 0, y = node.y ?? 0

  return (
    <g transform={`translate(${x},${y})`}
      data-node="true"
      onMouseDown={e => onMouseDown(e, node.id)}
      onClick={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ cursor: isAnchored ? 'move' : 'grab' }}
    >
      <ShapeBody shape={shape} halfW={halfW} halfH={halfH} r={r} fill={fill} stroke="none" strokeWidth={0} />

      {/* Label (foreignObject for word-wrap) */}
      {!editing && <NodeLabel label={node.label} halfW={halfW} halfH={halfH} fontSize={fontSize} textColor={viewProps.textColor || '#fff'} />}

      {/* Edit input */}
      {editing && (
        <foreignObject x={-halfW + 5} y={-halfH + 3} width={(halfW-5)*2} height={(halfH-3)*2}
          onMouseDown={e => e.stopPropagation()}>
          <input ref={inputRef} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
              if (e.key === 'Escape') setEditing(false)
              if (e.key === 'Tab') { e.preventDefault(); commitEdit(); onTab?.(node.id) }
            }}
            style={{ width:'100%', height:'100%', background:'#1e1e3a', border:'none', outline:'1px solid #5b6af0', borderRadius:4, color:'#fff', textAlign:'center', fontSize: fontSize-1, padding:'2px 4px', boxSizing:'border-box' }}
          />
        </foreignObject>
      )}

      {/* Double-click to edit */}
      <ellipse rx={halfW} ry={halfH} fill="transparent"
        onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true) }}
        style={{ cursor: 'text' }}
      />

      {/* Notes indicator dot */}
      {hasNotes && !isSelected && (
        <circle cx={halfW * 0.5} cy={halfH + 5} r={3} fill="#5b6af0" opacity={0.7} style={{ pointerEvents:'none' }} />
      )}

      {/* Connector handle — hover only */}
      {isHovered && <circle cx={halfW + 7} cy={0} r={5}
        fill="#5b6af0" stroke="#0c0c1a" strokeWidth={1.5}
        onMouseDown={e => { e.stopPropagation(); onConnectorMouseDown(e, node.id) }}
        style={{ cursor:'crosshair' }}
      />}

      {/* Scale handle (hovered) */}
      {isHovered && (
        <g transform={`translate(${halfW},${halfH})`}
          onMouseDown={e => { e.stopPropagation(); onScaleMouseDown(e, node.id, scale) }}
          style={{ cursor:'nwse-resize' }}>
          <circle r={6} fill="#0c0c1a" stroke="#5b6af0" strokeWidth={1.5} />
          <line x1={-3} y1={-3} x2={3} y2={3} stroke="#5b6af0" strokeWidth={1.5} />
          <line x1={0} y1={-3} x2={3} y2={0} stroke="#5b6af0" strokeWidth={1} />
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

// ─── NodeToolbar ──────────────────────────────────────────────────────────────

function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetShape, onDrill, onHide, onRelease, onDelete, onNotesChange, isAnchored, onMouseEnter, onMouseLeave }) {
  const shape = viewProps.shape || 'circle'
  const [notesOpen, setNotesOpen] = useState(false)
  const [notesDraft, setNotesDraft] = useState(notes)

  useEffect(() => { setNotesDraft(notes) }, [notes])

  const shapeIcons = { circle:'○', ellipse:'⬭', roundrect:'▭', diamond:'◇', none:'╌' }

  return (
    <div
      style={{
        position:'absolute', left: x, top: y, transform:'translateX(-50%)',
        background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8,
        padding:'7px 9px', display:'flex', flexDirection:'column', gap:6,
        boxShadow:'0 4px 20px rgba(0,0,0,0.6)', zIndex:20, pointerEvents:'all',
        minWidth: 230,
      }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Fill */}
      <Row label="Fill">
        <div style={{ display:'flex', gap:3, flexWrap:'wrap', flex:1 }}>
          {FILL_COLORS.map(c => (
            <div key={c} onClick={() => onSetFill(c)} style={{
              width:14, height:14, borderRadius:'50%', background:c, cursor:'pointer', flexShrink:0,
              border: viewProps.fillColor===c ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.12)',
              boxShadow: viewProps.fillColor===c ? '0 0 0 1px #5b6af0' : 'none',
            }} />
          ))}
        </div>
      </Row>

      {/* Text color */}
      <Row label="Text">
        <div style={{ display:'flex', gap:3, flexWrap:'wrap', flex:1 }}>
          {TEXT_COLORS.map(c => (
            <div key={c} onClick={() => onSetTextColor(c)} style={{
              width:14, height:14, borderRadius:'50%', background:c, cursor:'pointer', flexShrink:0,
              border: (viewProps.textColor||'#ffffff')===c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)',
            }} />
          ))}
        </div>
      </Row>

      {/* Shape */}
      <Row label="Shape">
        <div style={{ display:'flex', gap:3 }}>
          {SHAPES.map(s => (
            <button key={s} onClick={() => onSetShape(s)} title={s} style={{
              background: shape===s ? '#2d3a6a' : 'transparent',
              border: `1px solid ${shape===s ? '#5b6af0' : '#2d3a6a'}`,
              color: shape===s ? '#fff' : '#666',
              borderRadius:4, cursor:'pointer', fontSize:'0.9rem', padding:'1px 5px', lineHeight:1.4,
            }}>
              {shapeIcons[s]}
            </button>
          ))}
        </div>
      </Row>

      {/* Notes */}
      <Row label="Note">
        <button style={{ ...tlBtn, flex:1, textAlign:'left' }} onClick={() => setNotesOpen(o => !o)}>
          {notesOpen ? '▾ close' : (notes ? '✎ edit note' : '✎ add note')}
        </button>
      </Row>
      {notesOpen && (
        <textarea
          value={notesDraft}
          onChange={e => setNotesDraft(e.target.value)}
          onBlur={() => onNotesChange(notesDraft)}
          placeholder="Notes…"
          rows={4}
          style={{
            background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#c7d0f8',
            borderRadius:5, padding:'6px 8px', fontSize:'0.82rem', resize:'vertical',
            outline:'none', fontFamily:'-apple-system, sans-serif', lineHeight:1.5,
            width:'100%', boxSizing:'border-box',
          }}
        />
      )}

      {/* Actions row */}
      <div style={{ display:'flex', gap:5, marginTop:2 }}>
        {isAnchored && (
          <button style={{ ...tlBtn, color:'#f6ad55' }} onClick={onRelease}>⊙ Free</button>
        )}
        <button style={{ ...tlBtn, color:'#888' }} onClick={onHide}>◌ Hide</button>
        <button style={{ ...tlBtn, color:'#5b6af0' }} onClick={onDrill}>⊳ Drill</button>
        <div style={{ flex:1 }} />
        <button style={{ ...tlBtn, color:'#f87171' }} onClick={onDelete}>✕ Delete</button>
      </div>
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
      <span style={tlLabel}>{label}</span>
      {children}
    </div>
  )
}

const tlLabel = { fontSize:9, color:'#555', width:28, flexShrink:0 }
const tlBtn = { background:'transparent', border:'1px solid #2d3a6a', color:'#aaa', cursor:'pointer', fontSize:'0.72rem', padding:'2px 7px', borderRadius:4, whiteSpace:'nowrap' }

// Delete confirm overlay
const confirmStyle = { position:'absolute', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:50 }
const confirmBox = { background:'#16162a', border:'1px solid #2d3a6a', borderRadius:10, padding:'1.25rem 1.5rem', minWidth:260, boxShadow:'0 8px 32px rgba(0,0,0,0.6)' }
const confirmCancelBtn = { padding:'0.35rem 0.9rem', borderRadius:6, border:'1px solid #2d3a6a', background:'transparent', color:'#888', cursor:'pointer', fontSize:'0.82rem' }
const confirmOkBtn = { padding:'0.35rem 0.9rem', borderRadius:6, border:'1px solid #f87171', background:'#2a1a1a', color:'#f87171', cursor:'pointer', fontSize:'0.82rem', fontWeight:600 }
const canvasBtnsStyle = { position:'absolute', bottom:'1.25rem', right:'1.25rem', display:'flex', gap:8 }
const canvasBtnStyle = { padding:'0.45rem 0.85rem', borderRadius:7, border:'1px solid #2d3a6a', background:'#12122a', color:'#5b6af0', cursor:'pointer', fontSize:'0.82rem', fontWeight:600, boxShadow:'0 2px 12px rgba(0,0,0,0.4)' }
