import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import Node3DViewer from '../components/Node3DViewer'
import * as d3 from 'd3'
import useGraphStore, { DEFAULT_NODE_PROPS, NODE_R, FILL_COLORS, TEXT_COLORS, SHAPES, BG_COLORS } from '../lib/graphStore'
import ViewManager from '../components/ViewManager'
import OutlinePanel from '../components/OutlinePanel'
import { loadProject, saveProject, uploadModel, uploadThumbnail } from '../lib/db'

// â”€â”€ Text measurement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _measureCanvas = null
function measureTextWidth(text, fontSize) {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas')
  const ctx = _measureCanvas.getContext('2d')
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`
  return ctx.measureText(text || ' ').width
}

// For rect/roundrect: box is sized to snugly fit the text content
function getAutoSizeDims(label, fontSize) {
  const PAD_X = 14, PAD_Y = 10, MAX_HALF_W = 180, MIN_HALF_W = 36
  const rawW = measureTextWidth(label, fontSize)
  const halfW = Math.max(MIN_HALF_W, Math.min(MAX_HALF_W, rawW / 2 + PAD_X))
  const lineWidth = halfW * 2 - PAD_X * 2
  const linesCount = Math.max(1, Math.ceil(rawW / lineWidth))
  const halfH = (linesCount * fontSize * 1.35) / 2 + PAD_Y
  return { halfW, halfH }
}

// â”€â”€ Shape geometry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns { halfW, halfH } â€” the bounding half-dimensions of a shape at scale r
// For rect/roundrect, pass label+fontSize to get text-fitted dimensions.
function shapeDims(shape, r, label, fontSize) {
  if ((shape === 'roundrect' || shape === 'rect') && label != null) {
    return getAutoSizeDims(label, fontSize || Math.max(9, Math.round(12 * (r / NODE_R))))
  }
  switch (shape) {
    case '3d':        return { halfW: r * 2.5, halfH: r * 2.5 }
    case 'image':     return { halfW: r * 2.2, halfH: r * 1.6 }
    case 'frame':     return { halfW: r * 4.5, halfH: r * 3.5 }
    case 'ellipse':   return { halfW: r * 1.45, halfH: r * 0.9 }
    case 'roundrect': return { halfW: r * 1.5,  halfH: r * 0.85 }
    case 'rect':      return { halfW: r * 1.5,  halfH: r * 0.85 }
    case 'diamond':   return { halfW: r * 1.15, halfH: r * 1.15 }
    case 'none':      return { halfW: r * 1.2,  halfH: r * 0.55 }
    default:          return { halfW: r,         halfH: r }
  }
}

// â”€â”€ Direction-aware clip distance (how far from center to node edge along dir) â”€
function clipDist(shape, halfW, halfH, ux, uy) {
  if (shape === 'none') return 0   // no visible body â€” point straight to center
  if (shape === 'circle') return halfW
  if (shape === 'none') {
    // Text is much smaller than the container box â€” use tighter clip dimensions
    // so arrows terminate near the actual text rather than the invisible bounding box
    const cW = halfW * 0.5   // ~r*0.6: reasonable text half-width
    const cH = halfH * 0.25  // ~r*0.14: approximate single-line text half-height
    const denom = Math.sqrt((ux / cW) ** 2 + (uy / cH) ** 2)
    return denom > 0 ? 1 / denom : cW
  }
  // Ellipse formula works well as approximation for all shapes
  const denom = Math.sqrt((ux / halfW) ** 2 + (uy / halfH) ** 2)
  return denom > 0 ? 1 / denom : halfW
}

// â”€â”€ Shape SVG body â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ShapeBody({ shape, halfW, halfH, r, fill, stroke, strokeWidth, filter, imageUrl, nodeId }) {
  if (shape === 'none') return null
  if (shape === 'image') {
    const rx = 8
    return (
      <g filter={filter}>
        {imageUrl ? (
          <>
            <defs>
              <clipPath id={`img-clip-${nodeId}`}>
                <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={rx} />
              </clipPath>
            </defs>
            <image href={imageUrl} x={-halfW} y={-halfH} width={halfW*2} height={halfH*2}
              preserveAspectRatio="xMidYMid slice" clipPath={`url(#img-clip-${nodeId})`}
              style={{ pointerEvents:'none' }} />
            <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={rx}
              fill="none" stroke={stroke || 'rgba(255,255,255,0.15)'} strokeWidth={strokeWidth || 1} />
          </>
        ) : (
          <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={rx}
            fill={fill} stroke={stroke || 'rgba(255,255,255,0.15)'} strokeWidth={strokeWidth || 1}
            strokeDasharray="4,3" />
        )}
      </g>
    )
  }
  if (shape === '3d') {
    // Cube wireframe icon centered, scaled to ~30% of the box
    const s = halfH * 0.3
    return (
      <>
        <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={10} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        <g stroke={stroke || '#3d5a8a'} strokeWidth={1.2} fill="none" opacity={0.6}>
          <rect x={-s} y={-s} width={s*2} height={s*2} rx={2} />
          <rect x={-s+s*0.5} y={-s-s*0.5} width={s*2} height={s*2} rx={2} />
          <line x1={-s} y1={-s} x2={-s+s*0.5} y2={-s-s*0.5} />
          <line x1={s} y1={-s} x2={s+s*0.5} y2={-s-s*0.5} />
          <line x1={s} y1={s} x2={s+s*0.5} y2={s-s*0.5} />
        </g>
      </>
    )
  }
  if (shape === 'roundrect')
    return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={halfH * 0.45} ry={halfH * 0.45} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  if (shape === 'rect')
    return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={0} ry={0} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  if (shape === 'ellipse')
    return <ellipse rx={halfW} ry={halfH} fill={fill} stroke={stroke} strokeWidth={strokeWidth} filter={filter} />
  if (shape === 'diamond')
    return <polygon points={`0,${-halfH} ${halfW},0 0,${halfH} ${-halfW},0`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} filter={filter} />
  // default: circle
  return <circle r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} filter={filter} />
}

// â”€â”€ Label rendering (foreignObject for word-wrap) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Best practice: use HTML foreignObject inside SVG for text wrapping.
// It scales correctly with SVG zoom transforms in all modern browsers.
function NodeLabel({ label, halfW, halfH, fontSize, textColor }) {
  return (
    <foreignObject x={-halfW} y={-halfH} width={halfW * 2} height={halfH * 2}
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

export default function Graph({ projectId, projectName, onSetNavActions }) {
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
  const selectedRef = useRef(null)
  useEffect(() => { selectedRef.current = selected }, [selected])
  const [hoveredNodeId, setHoveredNodeId] = useState(null)
  const [isPanning, setIsPanning] = useState(false)
  const [showBgPicker, setShowBgPicker] = useState(false)
  const [keepEditId, setKeepEditId] = useState(null)
  const canvasFocused = useRef(true)
  const hideTimerRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(null) // nodeId or null
  const [confirmDeleteImage, setConfirmDeleteImage] = useState(null) // imageId or null
  const [pendingEditId, setPendingEditId] = useState(null)
  const [selectedImageId, setSelectedImageId] = useState(null)
  const [dragHoverNodeId, setDragHoverNodeId] = useState(null)
  const dragHoverNodeIdRef = useRef(null)
  const [showSlideSidebar, setShowSlideSidebar] = useState(false)
  const [presentingSlideIdx, setPresentingSlideIdx] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(220)

  const showToolbar = useCallback((nodeId) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    setHoveredNodeId(nodeId)
  }, [])
  const hideToolbar = useCallback(() => {
    hideTimerRef.current = setTimeout(() => setHoveredNodeId(null), 300)
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
  const setContainedIn  = useGraphStore(s => s.setContainedIn)
  const reparentNode    = useGraphStore(s => s.reparentNode)
  const addImage        = useGraphStore(s => s.addImage)
  const updateImage     = useGraphStore(s => s.updateImage)
  const deleteImage     = useGraphStore(s => s.deleteImage)
  const addSlide            = useGraphStore(s => s.addSlide)
  const removeSlide         = useGraphStore(s => s.removeSlide)
  const reorderSlides       = useGraphStore(s => s.reorderSlides)
  const addSlideshow        = useGraphStore(s => s.addSlideshow)
  const deleteSlideshow     = useGraphStore(s => s.deleteSlideshow)
  const renameSlideshow     = useGraphStore(s => s.renameSlideshow)
  const setActiveSlideshowId = useGraphStore(s => s.setActiveSlideshowId)
  const setDrillRoot    = useGraphStore(s => s.setDrillRoot)
  const exitDrill       = useGraphStore(s => s.exitDrill)
  const setViewBgColor  = useGraphStore(s => s.setViewBgColor)
  const addView         = useGraphStore(s => s.addView)
  const set3DModel      = useGraphStore(s => s.set3DModel)
  const setModelThumb   = useGraphStore(s => s.setModelThumb)
  const setImageUrl     = useGraphStore(s => s.setImageUrl)

  // Register nav actions with parent App so buttons appear in the top bar
  useEffect(() => {
    if (!onSetNavActions) return
    onSetNavActions({
      addView: () => addView(),
      addFrame: () => {
        if (!svgRef.current) return
        const [cx, cy] = zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2])
        const id = addNode('Frame', null, cx, cy)
        setNodeViewProp(id, 'shape', 'frame')
        setNodeViewProp(id, 'fillColor', '#1a2a4a')
        addSlide(id)
        setTimeout(() => {
          const sn = simNodesRef.current.find(n => n.id === id)
          if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy }
          scheduleRender()
        }, 0)
      },
      addNode: () => {
        setPendingEditId(addNode('New node', selectedRef.current?.type === 'node' ? selectedRef.current.id : null))
      },
      addRoot: () => setPendingEditId(addNode('New node', null)),
    })
  }, [onSetNavActions, addView, addNode, addSlide, setNodeViewProp]) // eslint-disable-line

  const activeView    = views.find(v => v.id === activeViewId) || views[0]
  const viewNodeProps = activeView?.nodeProps || {}
  const drillRoot     = activeView?.drillRoot || null
  const bgColor       = activeView?.bgColor || '#0c0c1a'
  const slideshows    = activeView?.slideshows || [{ id: 'ss-default', name: 'Default', slides: [] }]
  const activeSlideshowId = activeView?.activeSlideshowId || slideshows[0]?.id
  const activeSlideshow   = slideshows.find(ss => ss.id === activeSlideshowId) || slideshows[0]
  const slideIds      = activeSlideshow?.slides || []

  // Mutable ref so D3 forces can always read the latest view props without stale closure
  const viewNodePropsRef = useRef(viewNodeProps)
  viewNodePropsRef.current = viewNodeProps

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
    // Bounding force: keeps floating contained nodes inside their frame
    const boundingForce = () => alpha => {
      const vp = viewNodePropsRef.current
      for (const node of simNodesRef.current) {
        if (node.fx != null) continue
        const containerId = (vp[node.id] || {}).containedIn
        if (!containerId) continue
        const frame = simNodesRef.current.find(n => n.id === containerId)
        if (!frame) continue
        const fvp = vp[containerId] || {}
        const fr = NODE_R * (fvp.scale || 1)
        const { halfW: defHW, halfH: defHH } = shapeDims(fvp.shape === '3d' ? '3d' : 'frame', fr)
        const halfW = fvp.shape === '3d' ? defHW : (fvp.frameHalfW ?? defHW)
        const halfH = fvp.shape === '3d' ? defHH : (fvp.frameHalfH ?? defHH)
        const cx = frame.x || 0, cy = frame.y || 0
        const pad = 30
        if (node.x < cx - halfW + pad) node.vx += alpha * 10
        if (node.x > cx + halfW - pad) node.vx -= alpha * 10
        if (node.y < cy - halfH + pad) node.vy += alpha * 10
        if (node.y > cy + halfH - pad) node.vy -= alpha * 10
      }
    }

    if (!simRef.current) {
      simRef.current = d3.forceSimulation(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(120).strength(0.4))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('collide', d3.forceCollide(NODE_R + 8))
        .force('bound', boundingForce())
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

  const getSiblings = useCallback((nodeId) => {
    const parentEdge = storeEdges.find(e => e.target === nodeId)
    const parentId = parentEdge?.source || null
    const siblings = parentId
      ? storeEdges.filter(e => e.source === parentId).map(e => e.target)
      : storeNodes.filter(n => !new Set(storeEdges.map(e => e.target)).has(n.id)).map(n => n.id)
    return { siblings, parentId }
  }, [storeEdges, storeNodes])

  const handleNodeTab = useCallback((nodeId) => {
    const { siblings } = getSiblings(nodeId)
    const idx = siblings.indexOf(nodeId)
    if (siblings.length < 2) return
    const nextId = siblings[(idx + 1) % siblings.length]
    setSelected({ id: nextId, type: 'node' })
    setPendingEditId(nextId)
  }, [getSiblings])

  const handleCreateSister = useCallback((nodeId) => {
    const { parentId } = getSiblings(nodeId)
    const newId = addNode('New node', parentId)
    setSelected({ id: newId, type: 'node' })
    setPendingEditId(newId)
  }, [getSiblings, addNode])

  // Zoom â€” pan on background only (not on nodes)
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    zoomBehaviorRef.current = d3.zoom()
      .scaleExtent([0.04, 10])
      .filter(e => e.type === 'wheel' || (
        !e.target.closest?.('[data-node]') &&
        !e.target.closest?.('[data-frame]') &&
        !e.target.closest?.('[data-img]') &&
        !e.target.closest?.('[data-3d-canvas]')
      ))
      .on('zoom', e => { zoomTransformRef.current = e.transform; scheduleRender() })
    svg.call(zoomBehaviorRef.current)
    svg.on('dblclick.zoom', null)
    return () => svg.on('.zoom', null)
  }, [scheduleRender, loading])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = e => {
      if (!canvasFocused.current) return
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') {
        if (presentingSlideIdx !== null) { setPresentingSlideIdx(null); return }
        setSelected(null); setSelectedImageId(null); setConfirmDelete(null); return
      }

      // Presentation mode arrow navigation
      if (presentingSlideIdx !== null) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); navigateSlide(-1); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); navigateSlide(1); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); if (slideSimNodes.length > 0) { setPresentingSlideIdx(0); zoomToFrame(slideSimNodes[0]) } return }
        if (e.key === 'ArrowDown') { e.preventDefault(); if (slideSimNodes.length > 0) { const last = slideSimNodes.length - 1; setPresentingSlideIdx(last); zoomToFrame(slideSimNodes[last]) } return }
        return
      }

      // Enter → create sister node (double-click to edit label)
      if (e.key === 'Enter' && selected?.type === 'node') {
        e.preventDefault()
        handleCreateSister(selected.id)
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedImageId) { setConfirmDeleteImage(selectedImageId); return }
        if (selected?.type === 'edge') { removeEdge(selected.id); setSelected(null) }
        if (selected?.type === 'node') { setConfirmDelete(selected.id) }
        return
      }

      // Ctrl/Cmd+Shift+Enter → create sister node
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        if (selected?.type === 'node') {
          const { parentId } = getSiblings(selected.id)
          const newId = addNode('New node', parentId)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        }
        return
      }

      // Ctrl/Cmd+Enter → create child node
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (selected?.type === 'node') {
          const newId = addNode('New node', selected.id)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        }
        return
      }

      // Tab → cycle to next sibling (enter edit mode)
      if (e.key === 'Tab' && selected?.type === 'node') {
        e.preventDefault()
        handleNodeTab(selected.id)
        return
      }

      // ArrowUp → select parent
      if (e.key === 'ArrowUp' && selected?.type === 'node') {
        e.preventDefault()
        const parentEdge = storeEdges.find(ed => ed.target === selected.id)
        if (parentEdge) setSelected({ id: parentEdge.source, type: 'node' })
        return
      }

      // ArrowDown → select first child
      if (e.key === 'ArrowDown' && selected?.type === 'node') {
        e.preventDefault()
        const childEdge = storeEdges.find(ed => ed.source === selected.id)
        if (childEdge) setSelected({ id: childEdge.target, type: 'node' })
        return
      }

      // ArrowLeft/Right → cycle siblings
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected?.type === 'node') {
        e.preventDefault()
        const { siblings } = getSiblings(selected.id)
        const idx = siblings.indexOf(selected.id)
        const delta = e.key === 'ArrowRight' ? 1 : -1
        const nextId = siblings[(idx + delta + siblings.length) % siblings.length]
        if (nextId && nextId !== selected.id) setSelected({ id: nextId, type: 'node' })
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, removeEdge, addNode, getSiblings, handleNodeTab, handleCreateSister, storeEdges, presentingSlideIdx])

  const clientToSim = useCallback((clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect()
    return zoomTransformRef.current.invert([clientX - rect.left, clientY - rect.top])
  }, [])

  const handleNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    canvasFocused.current = true
    setSelected({ id: nodeId, type: 'node' })
    setHoveredNodeId(null) // hide toolbar while dragging
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    simRef.current.alphaTarget(0.3).restart()

    const isFrame = (viewNodePropsRef.current[nodeId] || {}).shape === 'frame'

    // Collect drag group
    let dragGroup = [simNode]
    if (isFrame) {
      // Frame drag: also move all nodes contained in this frame
      simNodesRef.current.forEach(n => {
        if (n.id !== nodeId && (viewNodePropsRef.current[n.id] || {}).containedIn === nodeId)
          dragGroup.push(n)
      })
    } else if (e.shiftKey) {
      // Shift-drag: collect exclusive descendants (children with only one parent)
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
    const startPositions = dragGroup.map(n => ({ node: n, ox: n.fx ?? n.x ?? 0, oy: n.fy ?? n.y ?? 0, wasAnchored: n.fx !== null }))
    let didDrag = false

    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const ddx = sx - startSx, ddy = sy - startSy
      if (!didDrag && Math.abs(ddx) < 2 && Math.abs(ddy) < 2) return
      if (!didDrag) document.body.style.cursor = 'grabbing'
      didDrag = true
      startPositions.forEach(({ node, ox, oy }) => { node.fx = ox + ddx; node.fy = oy + ddy })

      // Hover-detect: find node under cursor to highlight as reparent target
      if (!isFrame) {
        let found = null
        for (const n of simNodesRef.current) {
          if (n.id === nodeId) continue
          const nvp = viewNodePropsRef.current[n.id] || {}
          if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.visible === false) continue
          const nr = NODE_R * (nvp.scale || 1)
          const nLabel = n.label || ''
          const nFontSize = Math.max(9, Math.round(12 * (nvp.scale || 1)))
          const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, nLabel, nFontSize)
          if (Math.abs((n.x || 0) - sx) < halfW && Math.abs((n.y || 0) - sy) < halfH) {
            found = n.id; break
          }
        }
        if (found !== dragHoverNodeIdRef.current) {
          dragHoverNodeIdRef.current = found
          setDragHoverNodeId(found)
        }
      }
    }
    const onUp = ue => {
      document.body.style.cursor = ''
      simRef.current.alphaTarget(0)

      // Clear hover highlight
      dragHoverNodeIdRef.current = null
      setDragHoverNodeId(null)

      if (didDrag) {
        const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
        const ddx = sx - startSx, ddy = sy - startSy

        // Reparent: if dropped on another regular node, make it a child
        if (!isFrame && dragHoverNodeIdRef.current === null) {
          // re-check at drop position since ref was just cleared
          let dropTarget = null
          for (const n of simNodesRef.current) {
            if (n.id === nodeId) continue
            const nvp = viewNodePropsRef.current[n.id] || {}
            if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.visible === false) continue
            const nr = NODE_R * (nvp.scale || 1)
            const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, n.label || '', Math.max(9, Math.round(12 * (nvp.scale || 1))))
            const sp = startPositions.find(p => p.node.id === nodeId)
            const dropX = sp ? sp.ox + ddx : sx, dropY = sp ? sp.oy + ddy : sy
            if (Math.abs((n.x || 0) - dropX) < halfW && Math.abs((n.y || 0) - dropY) < halfH) {
              dropTarget = n.id; break
            }
          }
          if (dropTarget) {
            reparentNode(nodeId, dropTarget)
            // Release so D3 settles near new parent
            simNode.fx = null; simNode.fy = null
            releaseAnchor(nodeId)
            simRef.current.alpha(0.4).restart()
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            return
          }
        }

        startPositions.forEach(({ node, ox, oy, wasAnchored }) => {
          const newX = ox + ddx, newY = oy + ddy
          if (node.id === nodeId || wasAnchored) {
            node.fx = newX; node.fy = newY
            setAnchor(node.id, newX, newY)
          } else {
            node.x = newX; node.y = newY
            node.fx = null; node.fy = null
          }
        })

        // For regular nodes: check if dropped inside a frame → update containedIn
        if (!isFrame) {
          const sp = startPositions.find(p => p.node.id === nodeId)
          const dropX = sp ? sp.ox + ddx : sx
          const dropY = sp ? sp.oy + ddy : sy
          let newContainerId = null
          for (const fn of simNodesRef.current) {
            const fvp = viewNodePropsRef.current[fn.id] || {}
            if ((fvp.shape !== 'frame' && fvp.shape !== '3d') || fvp.visible === false) continue
            const fr = NODE_R * (fvp.scale || 1)
            const { halfW, halfH } = shapeDims(fvp.shape === '3d' ? '3d' : 'frame', fr)
            if (Math.abs(dropX - (fn.x || 0)) < halfW && Math.abs(dropY - (fn.y || 0)) < halfH) {
              newContainerId = fn.id; break
            }
          }
          setContainedIn(nodeId, newContainerId)
        }
      }
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setAnchor, setContainedIn, reparentNode, releaseAnchor, storeEdges])

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

  const handleScaleMouseDown = useCallback((e, nodeId, currentScale, minScale = 0.3, maxScale = 6) => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const startDist = Math.sqrt((sx0 - simNode.x)**2 + (sy0 - simNode.y)**2)
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const d = Math.sqrt((sx - simNode.x)**2 + (sy - simNode.y)**2)
      if (startDist < 1) return
      setNodeViewProp(nodeId, 'scale', Math.max(minScale, Math.min(maxScale, Math.round(currentScale * d / startDist * 10) / 10)))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleFrameResizeMouseDown = useCallback((e, nodeId) => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const newHW = Math.max(80, Math.abs(sx - (simNode.x || 0)))
      const newHH = Math.max(60, Math.abs(sy - (simNode.y || 0)))
      setNodeViewProp(nodeId, 'frameHalfW', newHW)
      setNodeViewProp(nodeId, 'frameHalfH', newHH)
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
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

  const zoomToFrame = useCallback((frameNode, animated = true) => {
    if (!svgRef.current || !zoomBehaviorRef.current) return
    const fvp = { ...DEFAULT_NODE_PROPS, ...(viewNodePropsRef.current[frameNode.id] || {}) }
    const fr = NODE_R * (fvp.scale || 1)
    const { halfW: defHW, halfH: defHH } = shapeDims('frame', fr)
    const halfW = fvp.frameHalfW ?? defHW, halfH = fvp.frameHalfH ?? defHH
    const svgW = svgRef.current.clientWidth, svgH = svgRef.current.clientHeight
    const pad = 40
    const k = Math.min((svgW - pad * 2) / (halfW * 2), (svgH - pad * 2) / (halfH * 2), 3)
    const t = d3.zoomIdentity
      .translate(svgW / 2 - k * (frameNode.x || 0), svgH / 2 - k * (frameNode.y || 0))
      .scale(k)
    const sel = d3.select(svgRef.current)
    if (animated) sel.transition().duration(600).call(zoomBehaviorRef.current.transform, t)
    else sel.call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
  }, [scheduleRender])

  // â”€â”€ Paste images â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const onPaste = e => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))
      if (!item) return
      const blob = item.getAsFile()
      const reader = new FileReader()
      reader.onload = ev => {
        const src = ev.target.result
        const el = new window.Image()
        el.onload = () => {
          const maxW = 400
          const scale = Math.min(1, maxW / el.width)
          const w = Math.round(el.width * scale), h = Math.round(el.height * scale)
          const rect = svgRef.current?.getBoundingClientRect()
          const [cx, cy] = zoomTransformRef.current.invert([
            (rect?.width ?? 800) / 2, (rect?.height ?? 600) / 2,
          ])
          addImage(src, cx, cy, w, h)
        }
        el.src = ev.target.result
      }
      reader.readAsDataURL(blob)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [addImage])

  // â”€â”€ Image interaction (drag / resize / rotate) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleImageMouseDown = useCallback((e, imageId, mode = 'drag') => {
    e.preventDefault()
    canvasFocused.current = true
    setSelectedImageId(imageId)
    setSelected(null)

    const getImg = () => useGraphStore.getState().views
      .find(v => v.id === useGraphStore.getState().activeViewId)
      ?.images?.find(i => i.id === imageId)

    const img = getImg()
    if (!img) return
    const T = zoomTransformRef.current

    if (mode === 'drag') {
      const [startSx, startSy] = [
        (e.clientX - T.x) / T.k,
        (e.clientY - T.y) / T.k,
      ]
      const ox = img.x, oy = img.y
      const onMove = me => {
        const sx = (me.clientX - T.x) / T.k, sy = (me.clientY - T.y) / T.k
        updateImage(imageId, { x: ox + sx - startSx, y: oy + sy - startSy })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)

    } else if (mode === 'resize') {
      const screenCX = T.x + img.x * T.k, screenCY = T.y + img.y * T.k
      const startDist = Math.hypot(e.clientX - screenCX, e.clientY - screenCY)
      const startW = img.width, startH = img.height
      const onMove = me => {
        if (startDist < 1) return
        const d = Math.hypot(me.clientX - screenCX, me.clientY - screenCY)
        const s = d / startDist
        updateImage(imageId, {
          width: Math.max(20, Math.round(startW * s)),
          height: Math.max(10, Math.round(startH * s)),
        })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)

    } else if (mode === 'rotate') {
      const screenCX = T.x + img.x * T.k, screenCY = T.y + img.y * T.k
      const startAngleDeg = Math.atan2(e.clientY - screenCY, e.clientX - screenCX) * 180 / Math.PI
      const startRot = img.rotation || 0
      const onMove = me => {
        const a = Math.atan2(me.clientY - screenCY, me.clientX - screenCX) * 180 / Math.PI
        updateImage(imageId, { rotation: startRot + a - startAngleDeg })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
    }
  }, [updateImage])

  const T = zoomTransformRef.current
  const selectedNode = selected?.type === 'node' ? simNodesRef.current.find(n => n.id === selected.id) : null
  const selectedStoreNode = selectedNode ? storeNodes.find(n => n.id === selectedNode.id) : null

  if (loading) return <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'#444', background:'#0c0c1a' }}>Loading project…</div>

  // Pre-compute edge geometry for two-pass rendering (lines behind nodes, arrowheads on top)
  const edgeData = simEdgesRef.current.map(e => {
    const s = e.source, t = e.target
    if (!s || !t || s.x == null) return null
    if (!visibleNodeIds.has(s.id) || !visibleNodeIds.has(t.id)) return null
    const isSel = selected?.id === e.id && selected?.type === 'edge'
    const svp = getVP(s.id), tvp = getVP(t.id)
    const sLabel = storeNodes.find(n => n.id === s.id)?.label || ''
    const tLabel = storeNodes.find(n => n.id === t.id)?.label || ''
    const sr = NODE_R * (svp.scale||1), tr = NODE_R * (tvp.scale||1)
    const sFontSize = Math.max(9, Math.round(12 * (svp.scale||1)))
    const tFontSize = Math.max(9, Math.round(12 * (tvp.scale||1)))
    const { halfW: swW, halfH: swH } = shapeDims(svp.shape || 'circle', sr, sLabel, sFontSize)
    const { halfW: twW, halfH: twH } = shapeDims(tvp.shape || 'circle', tr, tLabel, tFontSize)
    const dx = t.x-s.x, dy = t.y-s.y, dist = Math.sqrt(dx*dx+dy*dy)||1
    const ux = dx/dist, uy = dy/dist
    const sd = clipDist(svp.shape||'circle', swW, swH, ux, uy)
    const td = clipDist(tvp.shape||'circle', twW, twH, ux, uy)
    const x1 = s.x + ux*(sd - 5), y1 = s.y + uy*(sd - 5)
    const ALEN = 10, AW = 5
    const tipX = t.x - ux*(td - 5), tipY = t.y - uy*(td - 5)
    const basX = tipX - ux*ALEN, basY = tipY - uy*ALEN
    const perpX = -uy, perpY = ux
    const arrowPts = `${tipX},${tipY} ${basX+perpX*AW},${basY+perpY*AW} ${basX-perpX*AW},${basY-perpY*AW}`
    const mx = (x1+basX)/2, my = (y1+basY)/2
    const edgeColor = isSel ? '#5b6af0' : '#334155'
    return { id: e.id, x1, y1, x2: basX, y2: basY, tipX, tipY, arrowPts, mx, my, edgeColor, isSel }
  }).filter(Boolean)

  const frameSimNodes = simNodesRef.current.filter(n => (viewNodeProps[n.id]?.shape) === 'frame')
  // Ordered list of frame sim-nodes that are in the slideshow
  const slideSimNodes = slideIds
    .map(id => frameSimNodes.find(n => n.id === id))
    .filter(Boolean)
  const isPresenting = presentingSlideIdx !== null

  const navigateSlide = (delta) => {
    if (!slideSimNodes.length) return
    const next = ((presentingSlideIdx ?? 0) + delta + slideSimNodes.length) % slideSimNodes.length
    setPresentingSlideIdx(next)
    zoomToFrame(slideSimNodes[next])
  }

  const exitPresentation = () => { setPresentingSlideIdx(null) }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Outline sidebar â€” hidden while presenting */}
      {!isPresenting && (<>
      <div onMouseDown={() => { canvasFocused.current = false }}
        style={{ width: sidebarWidth, flexShrink: 0, background: '#0d0d1a', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <OutlinePanel
          selectedNodeId={selected?.type === 'node' ? selected.id : null}
          onSelectNode={id => setSelected({ id, type: 'node' })}
          containerNodeIds={new Set(storeNodes.filter(n => (viewNodeProps[n.id]?.shape) === 'frame').map(n => n.id))}
        />
      </div>
      {/* Sidebar resize handle */}
      <div style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: '#1e1e2e', transition: 'background 0.1s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#2d3a6a'}
        onMouseLeave={e => e.currentTarget.style.background = '#1e1e2e'}
        onMouseDown={e => {
          e.preventDefault()
          const startX = e.clientX, startW = sidebarWidth
          const onMove = me => setSidebarWidth(Math.max(150, Math.min(420, startW + me.clientX - startX)))
          const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
          document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
        }}
      />
      </>)}
      <div onMouseDown={() => { canvasFocused.current = true }} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <svg ref={svgRef}
          style={{ width: '100%', height: '100%', background: bgColor, display: 'block', cursor: isPanning ? 'grabbing' : 'grab' }}
          onClick={() => { setSelected(null); setSelectedImageId(null); setShowBgPicker(false) }}
          onMouseDown={e => { if (!e.target.closest?.('[data-node]')) setIsPanning(true) }}
          onMouseUp={() => setIsPanning(false)}
          onMouseLeave={() => setIsPanning(false)}
        >
          <defs />

          <g transform={`translate(${T.x},${T.y}) scale(${T.k})`}>
            {/* 1. Frame containers */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && getVP(n.id).shape === 'frame').map(n => (
              <FrameNode key={n.id} node={n}
                viewProps={getVP(n.id)}
                isSelected={selected?.id === n.id && selected?.type === 'node'}
                inSlides={slideIds.includes(n.id)}
                isPresenting={isPresenting}
                onMouseDown={handleNodeMouseDown}
                onResizeMouseDown={handleFrameResizeMouseDown}
                onDelete={id => setConfirmDelete(id)}
                onLabelChange={updateLabel}
                onToggleSlide={id => slideIds.includes(id) ? removeSlide(id) : addSlide(id)}
              />
            ))}

            {/* 2. Edges â€” node fill covers the tips cleanly */}
            {edgeData.map(({ id, x1, y1, tipX, tipY, arrowPts, mx, my, edgeColor, isSel }) => (
              <g key={id} onClick={ev => { ev.stopPropagation(); setSelected({ id, type: 'edge' }) }} style={{ cursor:'pointer' }}>
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke="transparent" strokeWidth={12} />
                {/* halo â€” bg-tinted outline that separates line from overlapping elements */}
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={bgColor} strokeWidth={isSel?6:4} strokeOpacity={0.55} />
                <polygon points={arrowPts} fill={bgColor} fillOpacity={0.55} stroke={bgColor} strokeWidth={isSel?6:4} strokeOpacity={0.55} strokeLinejoin="round" />
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={edgeColor} strokeWidth={isSel?2.5:1.5} />
                <polygon points={arrowPts} fill={edgeColor} stroke={edgeColor} strokeWidth={isSel?2.5:1.5} strokeLinejoin="round" />
                {isSel && (
                  <g transform={`translate(${mx},${my})`} onClick={ev => { ev.stopPropagation(); removeEdge(id); setSelected(null) }} style={{ cursor:'pointer' }}>
                    <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
                    <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect:'none' }}>{'\xD7'}</text>
                  </g>
                )}
              </g>
            ))}

            {connecting && <line x1={connecting.x1} y1={connecting.y1} x2={connecting.x2} y2={connecting.y2} stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.7} />}

            {/* 3. Images */}
            {(activeView?.images || []).filter(img => img.visible !== false).map(img => (
              <ImageNode key={img.id} img={img}
                isSelected={selectedImageId === img.id}
                onMouseDown={handleImageMouseDown}
              />
            ))}

            {/* 3b placeholder — 3D viewer is rendered as absolute div outside SVG below */}

            {/* 4. Regular nodes on top */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && getVP(n.id).shape !== 'frame').map(n => (
              <NodeShape key={n.id} node={n}
                modelThumb={storeNodes.find(s => s.id === n.id)?.modelThumb}
                imageUrl={storeNodes.find(s => s.id === n.id)?.imageUrl || ''}
                viewProps={getVP(n.id)}
                isSelected={selected?.id === n.id && selected?.type === 'node'}
                isHovered={hoveredNodeId === n.id}
                isDropTarget={dragHoverNodeId === n.id}
                autoEdit={pendingEditId === n.id}
                onAutoEditDone={() => setPendingEditId(null)}
                keepEdit={keepEditId === n.id}
                onKeepEditDone={() => setKeepEditId(null)}
                onMouseDown={handleNodeMouseDown}
                onConnectorMouseDown={handleConnectorMouseDown}
                onScaleMouseDown={handleScaleMouseDown}
                onDelete={id => setConfirmDelete(id)}
                onLabelChange={updateLabel}
                onTab={handleNodeTab}
                onCreateSister={handleCreateSister}
                onMouseEnter={() => showToolbar(n.id)}
                onMouseLeave={hideToolbar}
              />
            ))}

          </g>
        </svg>

        {/* 3D viewer — absolute div outside SVG, no event interference */}
        {selected?.type === 'node' && (() => {
          const n3d = simNodesRef.current.find(nd => nd.id === selected.id)
          if (!n3d || !visibleNodeIds.has(selected.id)) return null
          const vp3d = getVP(selected.id)
          if (vp3d.shape !== '3d') return null
          const r3d = NODE_R * (vp3d.scale || 1)
          const { halfW: hw3d, halfH: hh3d } = shapeDims('3d', r3d)
          const storeNode3d = storeNodes.find(s => s.id === selected.id)
          const screenX = T.x + (n3d.x || 0) * T.k
          const screenY = T.y + (n3d.y || 0) * T.k
          const screenW = hw3d * 2 * T.k
          const screenH = hh3d * 2 * T.k
          const handleImport3d = async file => {
            const nodeId = selected.id
            const ext = file.name.split('.').pop().toLowerCase()
            // Optimistically load in-memory so the viewer shows immediately
            const reader = new FileReader()
            reader.onload = ev => set3DModel(nodeId, ev.target.result.split(',')[1], ext)
            reader.readAsDataURL(file)
            // Upload to storage in the background; replace in-memory blob with persistent URL
            try {
              const { url, type } = await uploadModel(file, projectId, nodeId)
              set3DModel(nodeId, url, type)
            } catch (e) {
              console.warn('Model storage upload failed, keeping in-memory:', e)
            }
          }
          return (
            <div key={selected.id}
              onMouseDown={e => { e.stopPropagation(); if (e.button === 1) e.preventDefault(); canvasFocused.current = true }}
              style={{ position:'absolute',
                left: screenX - screenW / 2, top: screenY - screenH / 2,
                width: screenW, height: screenH,
                borderRadius: 12, overflow: 'hidden',
                zIndex: 5 }}>
              <Node3DViewer
                modelData={storeNode3d?.modelData}
                modelType={storeNode3d?.modelType}
                camState={vp3d.model3dCam}
                onCamEnd={cam => setNodeViewProp(selected.id, 'model3dCam', cam)}
                onThumbnailCapture={thumb => {
                  uploadThumbnail(thumb, projectId, selected.id)
                    .then(url => { if (url) setModelThumb(selected.id, url) })
                    .catch(() => {})
                }}
                onImport={handleImport3d}
              />
            </div>
          )
        })()}

        {/* Node toolbar â€” shows on hover */}
        {(() => {
          const hn = hoveredNodeId && simNodesRef.current.find(n => n.id === hoveredNodeId)
          const hs = hn && storeNodes.find(n => n.id === hn.id)
          if (!hn || !hs || !visibleNodeIds.has(hn.id)) return null
          const vp = getVP(hn.id)
          return (
            <NodeToolbar
              x={T.x + (hn.x||0) * T.k}
              y={T.y + (hn.y||0) * T.k + shapeDims(vp.shape||'circle', NODE_R*(vp.scale||1), hs.label, Math.max(9, Math.round(12*(vp.scale||1)))).halfH * T.k + 14}
              viewProps={vp}
              notes={hs.notes || ''}
              onSetFill={c => setNodeViewProp(hn.id, 'fillColor', c)}
              onSetTextColor={c => setNodeViewProp(hn.id, 'textColor', c)}
              onSetShape={s => { setNodeViewProp(hn.id, 'shape', s); if (s === 'image') setNodeViewProp(hn.id, 'fillColor', 'transparent') }}
              onDrill={() => { setDrillRoot(hn.id); setHoveredNodeId(null); setTimeout(zoomExtents, 50) }}
              onHide={() => { setNodeViewProp(hn.id, 'visible', false); setHoveredNodeId(null) }}
              onRelease={() => handleRelease(hn.id)}
              onDelete={() => { setConfirmDelete(hn.id); setHoveredNodeId(null) }}
              onNotesChange={notes => updateNotes(hn.id, notes)}
              isAnchored={hn.fx != null}
              imageUrl={hs.imageUrl || ''}
              onSetImageUrl={url => setImageUrl(hn.id, url)}
              onMouseEnter={() => showToolbar(hn.id)}
              onMouseLeave={hideToolbar}
              onWheel={e => svgRef.current?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }))}
            />
          )
        })()}

        {/* Image toolbar */}
        {selectedImageId && (() => {
          const img = (activeView?.images || []).find(i => i.id === selectedImageId)
          if (!img) return null
          const screenX = T.x + img.x * T.k
          const screenY = T.y + img.y * T.k + (img.height / 2) * T.k + 10
          return (
            <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
              style={{ position: 'absolute', left: screenX, top: screenY, transform: 'translateX(-50%)',
                background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '6px 8px',
                display: 'flex', flexDirection: 'column', gap: 6, zIndex: 25, boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
              {/* Action row */}
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <button onClick={() => updateImage(selectedImageId, { visible: img.visible === false ? true : false })}
                  title={img.visible === false ? 'Show' : 'Hide'}
                  style={{ ...tlBtn, color: img.visible === false ? '#f6ad55' : '#aaa' }}>
                  {img.visible === false ? '◌ Show' : '◌ Hide'}
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={() => { setConfirmDeleteImage(selectedImageId) }}
                  style={{ ...tlBtn, color: '#f87171' }}>✕ Delete</button>
              </div>
              {/* BG color row */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', width: 168 }}>
                <div title="No background" onClick={() => updateImage(selectedImageId, { bgColor: null })}
                  style={{ width: 20, height: 20, borderRadius: 3, background: 'transparent', cursor: 'pointer',
                    border: !img.bgColor ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.2)',
                    backgroundImage: 'linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%)',
                    backgroundSize: '6px 6px', backgroundPosition: '0 0, 3px 3px' }} />
                {FILL_COLORS.map(c => (
                  <div key={c} onClick={() => updateImage(selectedImageId, { bgColor: c })}
                    style={{ width: 20, height: 20, borderRadius: 3, background: c, cursor: 'pointer',
                      border: img.bgColor === c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)' }} />
                ))}
              </div>
            </div>
          )
        })()}

        {/* Delete node confirm */}
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

        {/* Delete image confirm */}
        {confirmDeleteImage && (
          <div style={confirmStyle} onClick={() => setConfirmDeleteImage(null)}>
            <div style={confirmBox} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
                Delete this image?
              </div>
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button style={confirmCancelBtn} onClick={() => setConfirmDeleteImage(null)}>Cancel</button>
                <button style={confirmOkBtn} onClick={() => { deleteImage(confirmDeleteImage); setSelectedImageId(null); setConfirmDeleteImage(null) }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* Save status */}
        {!isPresenting && <div style={{ position:'absolute', top:10, left:12, pointerEvents:'none' }}>
          <span style={{ fontSize:'0.68rem', color: saveStatus==='error'?'#f87171':saveStatus==='saving'?'#5b6af0':'#2a3a2a' }}>
            {saveStatus==='error'?'● save failed':saveStatus==='saving'?'● saving…':'● saved'}
          </span>
        </div>}


        {/* Canvas buttons */}
        {!isPresenting && <div style={canvasBtnsStyle}>
          {drillRoot && <button style={canvasBtnStyle} onClick={exitDrill}>→ Exit Drill</button>}
          <button style={canvasBtnStyle} onClick={handleReleaseAll}>⊙ Free All</button>
          <button style={canvasBtnStyle} onClick={zoomExtents}>⊡ Fit</button>
          <button style={canvasBtnStyle} onClick={() => setPendingEditId(addNode('New node', selected?.type === 'node' ? selected.id : null))}>+ Node</button>
          <button style={canvasBtnStyle} onClick={() => {
            const [cx, cy] = zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2])
            const id = addNode('Frame', null, cx, cy)
            setNodeViewProp(id, 'shape', 'frame')
            setNodeViewProp(id, 'fillColor', '#1a2a4a')
            addSlide(id)
            setTimeout(() => {
              const sn = simNodesRef.current.find(n => n.id === id)
              if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy }
              scheduleRender()
            }, 0)
          }}>⊞ Frame</button>
          {/* BG color picker */}
          <div style={{ position: 'relative' }}>
            <button style={{ ...canvasBtnStyle, paddingLeft: 6, display: 'flex', alignItems: 'center', gap: 5 }}
              onClick={e => { e.stopPropagation(); setShowBgPicker(v => !v) }} title="Background color">
              <span style={{ width: 12, height: 12, borderRadius: 3, background: bgColor, border: '1.5px solid #5b6af0', display: 'inline-block', flexShrink: 0 }} />
              BG
            </button>
            {showBgPicker && (
              <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: 6, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 8, display: 'flex', flexDirection:'column', gap: 6, zIndex: 30, boxShadow: '0 4px 20px rgba(0,0,0,0.6)' }}
                onClick={e => e.stopPropagation()}>
                <div style={{ display:'flex', flexWrap:'wrap', gap:4, width:136 }}>
                  {BG_COLORS.map(c => (
                    <div key={c} onClick={() => { setViewBgColor(c); setShowBgPicker(false) }} style={{
                      width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer',
                      border: bgColor === c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)',
                    }} />
                  ))}
                </div>
                <div style={{ borderTop:'1px solid #2d3a6a', paddingTop:6, display:'flex', flexWrap:'wrap', gap:4, width:136 }}>
                  {FILL_COLORS.map(c => (
                    <div key={c} onClick={() => { setViewBgColor(c); setShowBgPicker(false) }} style={{
                      width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer',
                      border: bgColor === c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)',
                    }} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>}

        {/* Views floating panel â€” bottom left */}
        {!isPresenting && <div style={{ position:'absolute', bottom:'1.25rem', left:'1rem', zIndex:20 }}>
          <ViewManager />
        </div>}

        {/* Build timestamp â€” bottom right */}
        {!isPresenting && <div style={{ position:'absolute', bottom:'0.5rem', right:'0.75rem', zIndex:20, fontSize:'0.62rem', color:'#333', fontFamily:'monospace', userSelect:'none' }}>
          {new Date(__BUILD_TIME__).toISOString().slice(0,16).replace('T',' ')}
        </div>}


        {/* Frame color picker â€” shows when a frame is selected */}
        {!isPresenting && selected?.type === 'node' && (() => {
          const sn = simNodesRef.current.find(n => n.id === selected.id)
          if (!sn) return null
          const fvp = getVP(selected.id)
          if (fvp.shape !== 'frame') return null
          const { halfH: defHH } = shapeDims('frame', NODE_R * (fvp.scale || 1))
          const halfH = fvp.frameHalfH ?? defHH
          const rawX = T.x + (sn.x || 0) * T.k
          const rawY = T.y + ((sn.y || 0) + halfH) * T.k + 14
          const canvasW = svgRef.current?.clientWidth || 800
          const canvasH = svgRef.current?.clientHeight || 600
          const pickerW = 184, pickerH = 84
          const screenX = Math.max(pickerW / 2 + 4, Math.min(canvasW - pickerW / 2 - 4, rawX))
          const screenY = Math.min(canvasH - pickerH - 4, rawY)
          return (
            <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
              style={{ position:'absolute', left: screenX, top: screenY, transform:'translateX(-50%)',
                background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8, padding:'6px 8px',
                display:'flex', flexDirection:'column', gap:4, zIndex:25, boxShadow:'0 4px 16px rgba(0,0,0,0.6)' }}>
              <div style={{ fontSize:'0.63rem', color:'#556', letterSpacing:'0.06em' }}>FILL</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:4, width:168 }}>
                {FILL_COLORS.map(c => (
                  <div key={c} onClick={() => setNodeViewProp(selected.id, 'fillColor', c)}
                    style={{ width:20, height:20, borderRadius:3, background:c, cursor:'pointer',
                      border: fvp.fillColor===c ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.12)' }} />
                ))}
              </div>
            </div>
          )
        })()}

        {/* Presentation controls overlay */}
        {isPresenting && (
          <div style={{ position:'absolute', inset:0, pointerEvents:'none', zIndex:30 }}>
            {/* Bottom nav bar */}
            <div style={{ position:'absolute', bottom:24, left:'50%', transform:'translateX(-50%)', pointerEvents:'all',
              background:'rgba(10,10,24,0.88)', border:'1px solid #2d3a6a', borderRadius:10,
              padding:'8px 18px', display:'flex', gap:14, alignItems:'center', boxShadow:'0 4px 20px rgba(0,0,0,0.6)' }}>
              <button style={canvasBtnStyle} onClick={() => navigateSlide(-1)}>← Prev</button>
              <span style={{ color:'#88b4e8', fontSize:'0.85rem', minWidth:60, textAlign:'center' }}>
                {(presentingSlideIdx ?? 0) + 1} / {slideSimNodes.length}
              </span>
              <button style={canvasBtnStyle} onClick={() => navigateSlide(1)}>Next →</button>
            </div>
          </div>
        )}
      </div>

      {/* Slides tab â€” flex sibling so it's never clipped, always at same zone as sidebar */}
      {frameSimNodes.length > 0 && !isPresenting && !showSlideSidebar && (
        <div onClick={() => setShowSlideSidebar(true)}
          style={{ width:26, flexShrink:0, borderLeft:'1px solid #1e1e2e', background:'#0d0d1a',
            cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
            writingMode:'vertical-rl', textOrientation:'mixed', letterSpacing:'0.1em',
            color:'#5b6af0', fontSize:'0.72rem', fontWeight:600, userSelect:'none',
            gap:0, paddingTop:6 }}>
          ▸ SLIDES
        </div>
      )}

      {/* Slide sidebar â€” hidden while presenting */}
      {!isPresenting && showSlideSidebar && frameSimNodes.length > 0 && (
        <SlideSidebar
          slideSimNodes={slideSimNodes}
          allSimNodes={simNodesRef.current}
          frameSimNodes={frameSimNodes}
          viewImages={activeView?.images || []}
          slideIds={slideIds}
          slideshows={slideshows}
          activeSlideshowId={activeSlideshowId}
          presentingSlideIdx={presentingSlideIdx}
          getVP={getVP}
          zoomToFrame={zoomToFrame}
          setPresentingSlideIdx={setPresentingSlideIdx}
          removeSlide={removeSlide}
          addSlide={addSlide}
          reorderSlides={reorderSlides}
          addSlideshow={addSlideshow}
          deleteSlideshow={deleteSlideshow}
          renameSlideshow={renameSlideshow}
          setActiveSlideshowId={setActiveSlideshowId}
          onClose={() => setShowSlideSidebar(false)}
          canvasBtnStyle={canvasBtnStyle}
        />
      )}
    </div>
  )
}

// Stops native mousedown/wheel from bubbling to D3's SVG listeners (React synthetic events can't do this)
function ThreeDWrapper({ children, onFocus }) {
  const ref = useRef()
  const onFocusRef = useRef(onFocus)
  useEffect(() => { onFocusRef.current = onFocus })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onMD = e => { e.stopPropagation(); onFocusRef.current?.() }
    const onWH = e => { e.stopPropagation(); e.preventDefault() }
    el.addEventListener('mousedown', onMD)
    el.addEventListener('wheel', onWH, { passive: false })
    return () => {
      el.removeEventListener('mousedown', onMD)
      el.removeEventListener('wheel', onWH)
    }
  }, []) // eslint-disable-line
  return <div ref={ref} data-3d-canvas="true" style={{ width:'100%', height:'100%', borderRadius:12, overflow:'hidden' }}>{children}</div>
}

// â”€â”€â”€ SlideSidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function SlideSidebar({ slideSimNodes, allSimNodes, frameSimNodes, viewImages, slideIds, slideshows, activeSlideshowId, presentingSlideIdx, getVP, zoomToFrame, setPresentingSlideIdx, removeSlide, addSlide, reorderSlides, addSlideshow, deleteSlideshow, renameSlideshow, setActiveSlideshowId, onClose, canvasBtnStyle }) {
  const [dragIdx, setDragIdx] = useState(null)
  const [dropIdx, setDropIdx] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const containerRef = useRef()

  // Whole-card drag with click threshold â€” click zooms, drag reorders
  const handleCardMouseDown = (e, idx) => {
    if (e.button !== 0 || e.target.closest('[data-remove]')) return
    e.preventDefault()
    const startX = e.clientX, startY = e.clientY
    let dragging = false

    const onMove = me => {
      if (!dragging) {
        if (Math.abs(me.clientX - startX) < 5 && Math.abs(me.clientY - startY) < 5) return
        dragging = true
        setDragIdx(idx)
      }
      if (!containerRef.current) return
      const items = containerRef.current.querySelectorAll('[data-slide-idx]')
      let insertBefore = items.length
      items.forEach(el => {
        const rect = el.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        if (me.clientY < mid) {
          const idx = parseInt(el.dataset.slideIdx)
          if (idx < insertBefore) insertBefore = idx
        }
      })
      setDropIdx(insertBefore)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!dragging) {
        zoomToFrame(slideSimNodes[idx])
        setDragIdx(null); setDropIdx(null)
        return
      }
      const fromIdx = idx
      setDragIdx(null)
      setDropIdx(dp => {
        if (dp !== null && dp !== fromIdx) {
          const newOrder = slideSimNodes.map(n => n.id)
          const [moved] = newOrder.splice(fromIdx, 1)
          newOrder.splice(dp, 0, moved)
          reorderSlides(newOrder)
        }
        return null
      })
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const nonSlideFrames = frameSimNodes.filter(n => !slideIds.includes(n.id))

  return (
    <div ref={containerRef} onMouseDown={e => e.stopPropagation()}
      style={{ width: 190, flexShrink: 0, borderLeft: '1px solid #1e1e2e', background: '#0d0d1a',
        overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '8px 8px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6, paddingBottom:6, borderBottom:'1px solid #1e1e2e' }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'#8090b8', cursor:'pointer', fontSize:14, padding:'0 2px', lineHeight:1 }}>‹</button>
          <span style={{ fontSize:'0.68rem', color:'#8090b8', letterSpacing:'0.08em', fontWeight:600 }}>SLIDES</span>
        </div>
        <button style={{ ...canvasBtnStyle, fontSize:'0.7rem', padding:'2px 6px' }}
          onClick={() => { if (slideSimNodes.length) { setPresentingSlideIdx(0); zoomToFrame(slideSimNodes[0]) } }}
          disabled={!slideSimNodes.length}>▶ Present</button>
      </div>

      {/* Slideshow selector */}
      <div style={{ marginBottom:10 }}>
        {slideshows.map(ss => (
          renamingId === ss.id ? (
            <input key={ss.id} autoFocus value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={() => { renameSlideshow(ss.id, renameVal || ss.name); setRenamingId(null) }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { renameSlideshow(ss.id, renameVal || ss.name); setRenamingId(null) } e.stopPropagation() }}
              style={{ width:'100%', fontSize:'0.75rem', background:'#0d1020', border:'1px solid #4a5280', borderRadius:4, color:'#e0e4ff', padding:'3px 7px', outline:'none', marginBottom:2, boxSizing:'border-box' }}
            />
          ) : (
            <div key={ss.id} style={{ display:'flex', alignItems:'center', marginBottom:2 }}>
              <button
                onDoubleClick={() => { setRenamingId(ss.id); setRenameVal(ss.name) }}
                onClick={() => setActiveSlideshowId(ss.id)}
                style={{ flex:1, textAlign:'left', fontSize:'0.75rem', padding:'4px 8px', borderRadius:4, border:'none',
                  background: ss.id === activeSlideshowId ? '#222a5a' : 'transparent',
                  color: ss.id === activeSlideshowId ? '#ffffff' : '#9aa0c8',
                  cursor:'pointer', fontWeight: ss.id === activeSlideshowId ? 600 : 400 }}>
                {ss.name}
              </button>
              {slideshows.length > 1 && (
                <button onClick={() => deleteSlideshow(ss.id)} title="Delete slideshow"
                  style={{ background:'transparent', border:'none', color:'#6070a0', cursor:'pointer', fontSize:14, padding:'0 4px', lineHeight:1, flexShrink:0 }}>×</button>
              )}
            </div>
          )
        ))}
        <button onClick={() => addSlideshow()}
          style={{ fontSize:'0.72rem', padding:'3px 8px', borderRadius:4, border:'1px solid #3a4878', background:'transparent', color:'#9aa0c8', cursor:'pointer', marginTop:2 }}>+ new slideshow</button>
      </div>

      {slideSimNodes.map((fn, i) => {
        const fvp = getVP(fn.id)
        const fr = NODE_R * (fvp.scale || 1)
        const { halfW: defHW, halfH: defHH } = shapeDims('frame', fr)
        const halfW = fvp.frameHalfW ?? defHW, halfH = fvp.frameHalfH ?? defHH
        const TW = 162, TH = Math.max(60, Math.round(TW * halfH / halfW))
        const nodesInFrame = allSimNodes.filter(n => {
          if (n.id === fn.id) return false
          const nvp = getVP(n.id)
          if (nvp.shape === 'frame') return false
          return nvp.containedIn === fn.id ||
            (Math.abs((n.x||0) - (fn.x||0)) < halfW && Math.abs((n.y||0) - (fn.y||0)) < halfH)
        })
        const showLineBefore = dragIdx !== null && dropIdx === i && dragIdx !== i
        return [
          showLineBefore && <div key={`line-${i}`} style={{ height:2, background:'#5b6af0', borderRadius:1, margin:'2px 0 6px' }} />,
          <div key={fn.id} data-slide-idx={i}
            onMouseDown={e => handleCardMouseDown(e, i)}
            style={{ marginBottom: 8, position: 'relative', cursor: 'grab', userSelect: 'none',
              opacity: dragIdx === i ? 0.4 : 1,
              borderRadius: 6 }}>
            <div style={{ borderRadius:6, overflow:'hidden',
              border: presentingSlideIdx === i ? '2px solid #5b6af0' : '1.5px solid #1e2a3a',
              background: '#111827' }}>
              <svg width={TW} height={TH}
                viewBox={`${-halfW} ${-halfH} ${halfW*2} ${halfH*2}`}
                style={{ display:'block', background: fvp.fillColor || '#1a2a4a', opacity:0.92, pointerEvents:'none' }}>
                {viewImages.map(img => {
                  const relX = (img.x || 0) - (fn.x || 0)
                  const relY = (img.y || 0) - (fn.y || 0)
                  if (Math.abs(relX) > halfW + img.width / 2 || Math.abs(relY) > halfH + img.height / 2) return null
                  return (
                    <g key={img.id} transform={`translate(${relX},${relY}) rotate(${img.rotation || 0})`}>
                      {img.bgColor && <rect x={-img.width/2} y={-img.height/2} width={img.width} height={img.height} fill={img.bgColor} rx={2} />}
                      <image href={img.src} x={-img.width/2} y={-img.height/2} width={img.width} height={img.height} />
                    </g>
                  )
                })}
                {nodesInFrame.map(n => {
                  const nvp = getVP(n.id)
                  const nr = NODE_R * (nvp.scale || 1)
                  const nFs = Math.max(9, Math.round(12 * (nvp.scale || 1)))
                  const { halfW: nW, halfH: nH } = shapeDims(nvp.shape || 'circle', nr, n.label || '', nFs)
                  return (
                    <g key={n.id} transform={`translate(${(n.x||0)-(fn.x||0)},${(n.y||0)-(fn.y||0)})`}>
                      <ShapeBody shape={nvp.shape||'circle'} halfW={nW} halfH={nH} r={nr}
                        fill={nvp.fillColor || '#12122a'} stroke="none" strokeWidth={0} />
                    </g>
                  )
                })}
              </svg>
              <div style={{ display:'flex', alignItems:'center', padding:'3px 6px 3px 8px', gap:4 }}>
                <span style={{ flex:1, fontSize:'0.72rem', color:'#88b4e8', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                  {i + 1}. {fn.label || 'Frame'}
                </span>
                <button data-remove="true" title="Remove from slideshow"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); removeSlide(fn.id) }}
                  style={{ background:'transparent', border:'none', color:'#f87171', cursor:'pointer', fontSize:13, padding:'0 2px', lineHeight:1, flexShrink:0 }}>×</button>
              </div>
            </div>
          </div>
        ]
      })}
      {dragIdx !== null && dropIdx === slideSimNodes.length && (
        <div style={{ height:2, background:'#5b6af0', borderRadius:1, margin:'2px 0' }} />
      )}

      {nonSlideFrames.length > 0 && (
        <div style={{ marginTop:8, paddingTop:8, borderTop:'1px solid #1e2a3a' }}>
          <div style={{ fontSize:'0.62rem', color:'#445', marginBottom:6, letterSpacing:'0.06em' }}>NOT IN SLIDESHOW</div>
          {nonSlideFrames.map(fn => (
            <div key={fn.id} style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
              <span style={{ flex:1, fontSize:'0.72rem', color:'#556', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                {fn.label || 'Frame'}
              </span>
              <button onClick={() => addSlide(fn.id)}
                style={{ background:'transparent', border:'1px solid #2d3a6a', color:'#5b6af0', cursor:'pointer', fontSize:'0.68rem', padding:'1px 5px', borderRadius:3, flexShrink:0 }}>+ Add</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// â”€â”€â”€ ImageNode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ImageNode({ img, isSelected, onMouseDown }) {
  const { id, src, x, y, width, height, rotation, bgColor } = img
  const hw = width / 2, hh = height / 2

  return (
    <g transform={`translate(${x},${y}) rotate(${rotation})`}
      data-img="true"
      onClick={e => e.stopPropagation()}
      onMouseDown={e => { if (e.button !== 0) return; e.stopPropagation(); onMouseDown(e, id) }}
      style={{ cursor: 'move' }}
    >
      {bgColor && <rect x={-hw} y={-hh} width={width} height={height} fill={bgColor} rx={2} />}
      {isSelected && (
        <rect x={-hw - 3} y={-hh - 3} width={width + 6} height={height + 6}
          fill="none" stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,3" rx={2} />
      )}
      <image href={src} x={-hw} y={-hh} width={width} height={height} />
      {isSelected && (<>
        {/* Resize â€” bottom-right (ratio-locked from center distance) */}
        <g transform={`translate(${hw},${hh})`}
          onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id, 'resize') }} style={{ cursor: 'nwse-resize' }}>
          <circle r={8} fill="#16162a" stroke="#5b6af0" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={9} fill="#5b6af0" style={{ userSelect: 'none' }}>⤡</text>
        </g>
        {/* Rotate â€” top-center */}
        <line x1={0} y1={-hh} x2={0} y2={-hh - 22} stroke="#a78bfa" strokeWidth={1} opacity={0.6} />
        <g transform={`translate(0,${-hh - 28})`}
          onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id, 'rotate') }} style={{ cursor: 'grab' }}>
          <circle r={8} fill="#16162a" stroke="#a78bfa" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#a78bfa" style={{ userSelect: 'none' }}>↻</text>
        </g>
      </>)}
    </g>
  )
}

// â”€â”€â”€ FrameNode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function FrameNode({ node, viewProps, isSelected, inSlides, isPresenting, onMouseDown, onResizeMouseDown, onDelete, onLabelChange, onToggleSlide }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const inputRef = useRef()

  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])

  const commitEdit = () => { onLabelChange(node.id, draft.trim() || 'Frame'); setEditing(false) }

  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const { halfW: defHW, halfH: defHH } = shapeDims('frame', r)
  const halfW = viewProps.frameHalfW ?? defHW
  const halfH = viewProps.frameHalfH ?? defHH
  const fill = viewProps.fillColor || '#1a2a4a'
  const titleFontSize = Math.max(11, Math.round(13 * scale))
  const x = node.x ?? 0, y = node.y ?? 0

  return (
    <g transform={`translate(${x},${y})`}
      data-frame="true"
      onMouseDown={e => onMouseDown(e, node.id)}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true); requestAnimationFrame(() => inputRef.current?.select()) }}
      style={{ cursor: 'move' }}
    >
      {/* Frame body â€” hidden in presentation mode */}
      {!isPresenting && <rect x={-halfW} y={-halfH} width={halfW * 2} height={halfH * 2} rx={8}
        fill={fill} fillOpacity={viewProps.fillColor && viewProps.fillColor !== '#1a2a4a' ? 0.92 : 0.18}
        stroke={isSelected ? '#5b6af0' : '#4a7abf'}
        strokeWidth={isSelected ? 2.5 : 1.5}
        strokeDasharray="10,6"
      />}

      {/* Title at top-left */}
      {!editing && !isPresenting && (
        <text x={-halfW + 12} y={-halfH + titleFontSize + 6}
          fill={viewProps.textColor || '#88b4e8'}
          fontSize={titleFontSize}
          fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
          fontWeight="600"
          style={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {node.label}
        </text>
      )}

      {/* Title edit input */}
      {editing && (
        <foreignObject x={-halfW + 8} y={-halfH + 4} width={halfW * 2 - 16} height={titleFontSize + 10}
          onMouseDown={e => e.stopPropagation()}>
          <input ref={inputRef} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
            }}
            style={{
              width: '100%', background: 'rgba(10,20,40,0.85)', border: '1.5px solid #5b6af0',
              borderRadius: 4, color: '#88b4e8', fontSize: titleFontSize, fontWeight: 600,
              padding: '2px 6px', outline: 'none', boxSizing: 'border-box',
            }}
          />
        </foreignObject>
      )}

      {/* × delete (top-right) */}
      {isSelected && (
        <g transform={`translate(${halfW - 12},${-halfH + 12})`}
          onClick={e => { e.stopPropagation(); onDelete(node.id) }}
          style={{ cursor: 'pointer' }}>
          <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect: 'none' }}>×</text>
        </g>
      )}

      {/* Slide toggle (top-right, left of delete) */}
      {isSelected && (
        <g transform={`translate(${halfW - 36},${-halfH + 12})`}
          onClick={e => { e.stopPropagation(); onToggleSlide(node.id) }}
          style={{ cursor: 'pointer' }}
          title={inSlides ? 'Remove from slideshow' : 'Add to slideshow'}>
          <circle r={9} fill="#1a1a2e" stroke={inSlides ? '#5b6af0' : '#445'} strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={9} fill={inSlides ? '#5b6af0' : '#667'} style={{ userSelect: 'none' }}>
            {inSlides ? '⊟' : '⊞'}
          </text>
        </g>
      )}

      {/* 4 corner resize handles */}
      {isSelected && [[-1,-1,'nwse-resize'],[ 1,-1,'nesw-resize'],[-1,1,'nesw-resize'],[ 1,1,'nwse-resize']].map(([sx, sy, cur]) => (
        <g key={`${sx}${sy}`} transform={`translate(${sx * halfW},${sy * halfH})`}
          onMouseDown={e => { e.stopPropagation(); onResizeMouseDown(e, node.id) }}
          style={{ cursor: cur }}>
          <circle r={7} fill="#16162a" stroke="#5b6af0" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={9} fill="#5b6af0" style={{ userSelect: 'none' }}>⤡</text>
        </g>
      ))}
    </g>
  )
}

// â”€â”€â”€ NodeShape â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function NodeShape({ node, viewProps, isSelected, isHovered, isDropTarget, autoEdit, onAutoEditDone, keepEdit, onKeepEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onDelete, onLabelChange, onTab, onCreateSister, onMouseEnter, onMouseLeave, modelThumb, imageUrl }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const inputRef = useRef()

  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])

  // Auto-enter edit on creation â€” clears text, selects all
  useEffect(() => {
    if (autoEdit) {
      setDraft('')
      setEditing(true)
      onAutoEditDone?.()
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, []) // eslint-disable-line

  // Enter-key edit â€” keeps text, cursor at end (no select-all)
  useEffect(() => {
    if (keepEdit && !editing) {
      setDraft(node.label)
      setEditing(true)
      onKeepEditDone?.()
      requestAnimationFrame(() => {
        if (inputRef.current) {
          const len = inputRef.current.value.length
          inputRef.current.setSelectionRange(len, len)
        }
      })
    }
  }, [keepEdit]) // eslint-disable-line

  const commitEdit = () => { onLabelChange(node.id, draft.trim() || 'New node'); setEditing(false) }

  const isAnchored = node.fx != null
  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const shape = viewProps.shape || 'circle'
  const baseFontSize = Math.max(9, Math.round(12 * scale))
  const isAutoSized = shape === 'roundrect' || shape === 'rect'
  const { halfW, halfH } = shapeDims(shape, r, node.label, baseFontSize)
  // Auto-shrink font for fixed-size shapes only (auto-sized shapes fit the text)
  const fontSize = isAutoSized ? baseFontSize : (() => {
    const innerW = halfW * 2, innerH = halfH * 2
    const charsPerLine = Math.max(1, Math.floor(innerW / (baseFontSize * 0.55)))
    const linesNeeded = Math.ceil((node.label || ' ').length / charsPerLine)
    const heightNeeded = linesNeeded * baseFontSize * 1.3
    return heightNeeded > innerH ? Math.max(7, Math.round(baseFontSize * innerH / heightNeeded)) : baseFontSize
  })()
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
      style={{ cursor: 'move', pointerEvents: shape === '3d' && isSelected ? 'none' : undefined }}
    >
      {/* Selection ring â€” drawn outside the fill */}
      {isSelected && (shape === 'none'
        ? <rect x={-(halfW+4)} y={-(halfH+4)} width={(halfW+4)*2} height={(halfH+4)*2} rx={4} fill="none" stroke="#5b6af0" strokeWidth={2} strokeDasharray="5,3" />
        : <ShapeBody shape={shape} halfW={halfW + 4} halfH={halfH + 4} r={r + 4} fill="none" stroke="#5b6af0" strokeWidth={2.5} />
      )}
      {isDropTarget && shape !== 'none' && (
        <ShapeBody shape={shape} halfW={halfW + 7} halfH={halfH + 7} r={r + 7} fill="none" stroke="#4ade80" strokeWidth={3} />
      )}
      {isHovered && !isSelected && shape !== 'none' && (
        <ShapeBody shape={shape} halfW={halfW + 2} halfH={halfH + 2} r={r + 2} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={1.5} />
      )}
      <ShapeBody shape={shape} halfW={halfW} halfH={halfH} r={r} fill={fill} stroke="none" strokeWidth={0} imageUrl={imageUrl} nodeId={node.id} />

      {/* 3D thumbnail â€” shown when not live (node not selected) */}
      {shape === '3d' && modelThumb && !isSelected && (
        <>
          <defs>
            <clipPath id={`tc-${node.id}`}>
              <rect x={-halfW+2} y={-halfH+2} width={(halfW-2)*2} height={(halfH-2)*2} rx={8} />
            </clipPath>
          </defs>
          <image href={modelThumb} x={-halfW+2} y={-halfH+2} width={(halfW-2)*2} height={(halfH-2)*2}
            preserveAspectRatio="xMidYMid meet" clipPath={`url(#tc-${node.id})`}
            style={{ pointerEvents:'none' }} />
        </>
      )}

      {/* Label — inside box for normal shapes, below box as caption for 3D/image */}
      {!editing && shape !== '3d' && shape !== 'image' && <NodeLabel label={node.label} halfW={halfW} halfH={halfH} fontSize={fontSize} textColor={viewProps.textColor || '#fff'} />}
      {!editing && (shape === '3d' || shape === 'image') && (
        <text y={halfH + 14} textAnchor={'middle'} fontSize={Math.max(8, Math.round(10 * scale))}
          fill={viewProps.textColor || '#aab'} style={{ pointerEvents:'none', userSelect:'none' }}
          dominantBaseline={'hanging'}>
          {node.label}
        </text>
      )}

      {/* Edit input */}
      {editing && (
        <foreignObject x={-halfW} y={-halfH} width={halfW*2} height={halfH*2}
          onMouseDown={e => e.stopPropagation()}>
          <input ref={inputRef} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault(); e.stopPropagation()
                const inp = inputRef.current
                if (inp && inp.selectionStart !== inp.selectionEnd) {
                  // Text still selected (just opened) â€” deselect, cursor to end
                  inp.setSelectionRange(inp.value.length, inp.value.length)
                } else {
                  commitEdit()
                }
              }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false) }
              if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEdit(); onTab?.(node.id) }
            }}
            style={{ width:'100%', height:'100%', background:'#1e1e3a', border:'none', outline:'1px solid #5b6af0', borderRadius:4, color:'#fff', textAlign:'center', fontSize: fontSize-1, padding:'2px 4px', boxSizing:'border-box' }}
          />
        </foreignObject>
      )}

      {/* Double-click to edit â€” for 3D nodes also cover caption area below */}
      <ellipse rx={halfW} ry={halfH} fill="transparent"
        onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true) }}
        style={{ cursor: 'move' }}
      />
      {shape === '3d' && (
        <rect x={-halfW} y={halfH + 4} width={halfW * 2} height={22} fill="transparent"
          onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true) }}
          style={{ cursor: 'text' }}
        />
      )}

      {/* Notes indicator dot */}
      {hasNotes && !isSelected && (
        <circle cx={halfW * 0.5} cy={halfH + 5} r={3} fill="#5b6af0" opacity={0.7} style={{ pointerEvents:'none' }} />
      )}

      {/* Connector handle â€” hover only. Large transparent circle as hit target to bridge gap from node edge. */}
      {isHovered && (
        <g onMouseDown={e => { e.stopPropagation(); onConnectorMouseDown(e, node.id) }}
          onMouseEnter={onMouseEnter} style={{ cursor: 'crosshair' }}>
          <circle cx={halfW + 7} cy={0} r={14} fill="transparent" />
          <circle cx={halfW + 7} cy={0} r={5} fill="#5b6af0" stroke="#0c0c1a" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
        </g>
      )}

      {/* Scale handle â€” hover only. Large transparent hit area for easier grabbing. */}
      {isHovered && (
        <g transform={`translate(${halfW},${halfH})`}
          onMouseDown={e => { e.stopPropagation(); onScaleMouseDown(e, node.id, scale) }}
          onMouseEnter={onMouseEnter}
          style={{ cursor: 'nwse-resize' }}>
          <circle r={14} fill="transparent" />
          <circle r={6} fill="#0c0c1a" stroke="#5b6af0" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
          <line x1={-3} y1={-3} x2={3} y2={3} stroke="#5b6af0" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
          <line x1={0} y1={-3} x2={3} y2={0} stroke="#5b6af0" strokeWidth={1} style={{ pointerEvents: 'none' }} />
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

// â”€â”€â”€ ColorSubPopup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ColorSubPopup({ colors, current, onPick, label }) {
  return (
    <div style={{
      position:'absolute', bottom:'110%', left:'50%', transform:'translateX(-50%)',
      background:'#16162a', border:'1px solid #2d3a6a', borderRadius:7,
      padding:'6px 7px', zIndex:30, boxShadow:'0 4px 20px rgba(0,0,0,0.7)',
      display:'flex', flexDirection:'column', gap:4,
    }}>
      <div style={{ fontSize:'0.6rem', color:'#555', letterSpacing:'0.06em' }}>{label}</div>
      <div style={{ display:'flex', gap:4, flexWrap:'wrap', width: 176 }}>
        {colors.map(c => (
          <div key={c} onClick={() => onPick(c)} style={{
            width:16, height:16, borderRadius:'50%', background:c, cursor:'pointer', flexShrink:0,
            border: current===c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.1)',
            boxShadow: current===c ? '0 0 0 1.5px #5b6af0' : 'none',
          }} />
        ))}
      </div>
    </div>
  )
}

// â”€â”€â”€ NodeToolbar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetShape, onDrill, onHide, onRelease, onDelete, onNotesChange, isAnchored, onMouseEnter, onMouseLeave, onWheel, imageUrl, onSetImageUrl }) {
  const shape = viewProps.shape || 'circle'
  const [panel, setPanel] = useState(null) // null | 'color' | 'shape' | 'note'
  const [notesDraft, setNotesDraft] = useState(notes)
  const [colorPopup, setColorPopup] = useState(null) // 'fill' | 'text' | null

  useEffect(() => { setNotesDraft(notes) }, [notes])

  const shapeIcons = { circle:'○', ellipse:'⬭', roundrect:'▭', rect:'□', diamond:'◇', none:'╌', '3d':'⬡', image:'🖼' }

  const wrap = {
    position:'absolute', left: x, top: y, transform:'translateX(-50%)',
    background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8,
    padding:'6px 8px',
    boxShadow:'0 4px 20px rgba(0,0,0,0.6)', zIndex:20, pointerEvents:'all',
  }

  const iconBtn = (active) => ({
    background: active ? '#2d3a6a' : 'transparent',
    border: `1px solid ${active ? '#5b6af0' : '#2a3358'}`,
    color: active ? '#c5d0ff' : '#7080a0',
    borderRadius:5, cursor:'pointer', fontSize:'1rem', padding:'4px 7px', lineHeight:1,
  })

  const backBtn = {
    background:'transparent', border:'none', color:'#556', cursor:'pointer',
    fontSize:'0.78rem', padding:'0 4px 0 0', lineHeight:1,
  }

  const divider = <div style={{ width:1, background:'#2a3358', alignSelf:'stretch', margin:'0 2px' }} />

  return (
    <div style={wrap}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
    >
      {/* â”€â”€ Main icon row â”€â”€ */}
      {panel === null && (
        <div style={{ display:'flex', gap:4, alignItems:'center' }}>
          <button style={iconBtn(false)} title="Color" onClick={() => setPanel('color')}>🎨</button>
          <button style={iconBtn(false)} title="Shape" onClick={() => setPanel('shape')}>◯</button>
          {shape === 'image' && <button style={iconBtn(false)} title="Set image URL" onClick={() => setPanel('image')}>🖼</button>}
          {divider}
          <button style={iconBtn(false)} title="Show/hide" onClick={onHide}>👁</button>
          <button style={iconBtn(false)} title="Drill" onClick={onDrill}>⊕</button>
          <button style={iconBtn(false)} title="Note" onClick={() => setPanel('note')}>✎</button>
          {isAnchored && <button style={{ ...iconBtn(false), color:'#f6ad55' }} title="Release anchor" onClick={onRelease}>⊙</button>}
          {divider}
          <button style={{ ...iconBtn(false), color:'#f87171' }} title="Delete" onClick={onDelete}>✕</button>
        </div>
      )}

      {/* â”€â”€ Color panel â”€â”€ */}
      {panel === 'color' && (
        <div style={{ display:'flex', flexDirection:'column', gap:7, minWidth:190 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>COLOR</span>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>FILL</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {FILL_COLORS.map(c => (
                <div key={c} onClick={() => onSetFill(c)} style={{
                  width:18, height:18, borderRadius:4, background:c, cursor:'pointer',
                  border: viewProps.fillColor===c ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.1)',
                }} />
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>OUTLINE</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {FILL_COLORS.map(c => (
                <div key={c} onClick={() => onSetTextColor(c)} style={{
                  width:18, height:18, borderRadius:4, background:'transparent', cursor:'pointer',
                  border: (viewProps.strokeColor||viewProps.textColor)===c ? `3px solid ${c}` : `2px solid ${c}`,
                  boxSizing:'border-box',
                }} />
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>TEXT</div>
            <div style={{ display:'flex', gap:4 }}>
              {TEXT_COLORS.map(c => (
                <div key={c} onClick={() => onSetTextColor(c)} style={{
                  width:18, height:18, borderRadius:'50%', background:c, cursor:'pointer',
                  border: (viewProps.textColor||'#ffffff')===c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)',
                }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ Shape panel â”€â”€ */}
      {panel === 'shape' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:160 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>SHAPE</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:5 }}>
            {[...SHAPES, '3d'].map(s => (
              <button key={s} onClick={() => { onSetShape(s); setPanel(null) }} title={s} style={{
                background: shape===s ? '#2d3a6a' : 'transparent',
                border: `1px solid ${shape===s ? '#5b6af0' : '#2a3358'}`,
                color: shape===s ? '#fff' : '#778',
                borderRadius:5, cursor:'pointer', fontSize:'1.1rem', padding:'5px 4px', lineHeight:1,
                display:'flex', flexDirection:'column', alignItems:'center', gap:2,
              }}>
                <span>{shapeIcons[s]}</span>
                <span style={{ fontSize:'0.58rem', color: shape===s ? '#aac' : '#445' }}>{s}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* â”€â”€ Note panel â”€â”€ */}
      {panel === 'note' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:210 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>NOTE</span>
          </div>
          <textarea
            value={notesDraft}
            onChange={e => setNotesDraft(e.target.value)}
            onBlur={() => onNotesChange(notesDraft)}
            placeholder="Notes…"
            rows={4}
            autoFocus
            style={{
              background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#c7d0f8',
              borderRadius:5, padding:'6px 8px', fontSize:'0.82rem', resize:'vertical',
              outline:'none', fontFamily:'-apple-system, sans-serif', lineHeight:1.5,
              width:'100%', boxSizing:'border-box',
            }}
          />
        </div>
      )}

      {/* — Image URL panel — */}
      {panel === 'image' && (
        <ImageUrlPanel
          imageUrl={imageUrl}
          onSet={url => { onSetImageUrl(url); setPanel(null) }}
          onBack={() => setPanel(null)}
          backBtn={backBtn}
        />
      )}
    </div>
  )
}

function ImageUrlPanel({ imageUrl, onSet, onBack, backBtn }) {
  const [draft, setDraft] = useState(imageUrl || '')
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:240 }}>
      <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
        <button style={backBtn} onClick={onBack}>‹</button>
        <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>IMAGE URL</span>
      </div>
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); onSet(draft.trim()) }
          if (e.key === 'Escape') { e.preventDefault(); onBack() }
        }}
        placeholder="Paste image URL…"
        style={{
          background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#c7d0f8',
          borderRadius:5, padding:'6px 8px', fontSize:'0.82rem',
          outline:'none', width:'100%', boxSizing:'border-box',
        }}
      />
      {draft && (
        <img src={draft} alt="" style={{ width:'100%', maxHeight:120, objectFit:'cover', borderRadius:5, opacity: 0.9 }}
          onError={e => { e.target.style.display='none' }} />
      )}
      <button
        onClick={() => onSet(draft.trim())}
        style={{ padding:'5px', borderRadius:5, border:'1px solid #5b6af0', background:'#1a1f4a', color:'#c5d0ff', cursor:'pointer', fontSize:'0.78rem' }}>
        Set image
      </button>
      {imageUrl && (
        <button onClick={() => onSet('')}
          style={{ padding:'5px', borderRadius:5, border:'1px solid #2d3a6a', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:'0.78rem' }}>
          Clear
        </button>
      )}
    </div>
  )
}

const tlBtn = { background:'transparent', border:'1px solid #2d3a6a', color:'#aaa', cursor:'pointer', fontSize:'0.72rem', padding:'2px 7px', borderRadius:4, whiteSpace:'nowrap' }

// Delete confirm overlay
const confirmStyle = { position:'absolute', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:50 }
const confirmBox = { background:'#16162a', border:'1px solid #2d3a6a', borderRadius:10, padding:'1.25rem 1.5rem', minWidth:260, boxShadow:'0 8px 32px rgba(0,0,0,0.6)' }
const confirmCancelBtn = { padding:'0.35rem 0.9rem', borderRadius:6, border:'1px solid #2d3a6a', background:'transparent', color:'#888', cursor:'pointer', fontSize:'0.82rem' }
const confirmOkBtn = { padding:'0.35rem 0.9rem', borderRadius:6, border:'1px solid #f87171', background:'#2a1a1a', color:'#f87171', cursor:'pointer', fontSize:'0.82rem', fontWeight:600 }
const canvasBtnsStyle = { position:'absolute', bottom:'1.25rem', right:'1.25rem', display:'flex', gap:8 }
const canvasBtnStyle = { padding:'0.45rem 0.85rem', borderRadius:7, border:'1px solid #2d3a6a', background:'#12122a', color:'#5b6af0', cursor:'pointer', fontSize:'0.82rem', fontWeight:600, boxShadow:'0 2px 12px rgba(0,0,0,0.4)' }
const topBtnStyle = { padding:'0.3rem 0.8rem', borderRadius:6, border:'1px solid #2d3a6a', background:'rgba(18,18,42,0.92)', color:'#7b8fcc', cursor:'pointer', fontSize:'0.78rem', fontWeight:600, backdropFilter:'blur(4px)' }
