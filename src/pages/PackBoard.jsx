import { useRef, useState, useEffect, useMemo } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'
import { FilterBar, nodeMatchesFilter, defaultDoneFilter } from '../lib/filter'
import { buildNestedTagTree } from '../lib/hierarchy'
import NodePropsEditor from '../components/NodePropsEditor'

// Multi-pack / multi-tree CANVAS (feature #1). One shared pannable canvas hosts several independent
// clusters. Two kinds:
//   • "Circle pack" — groups nodes by a tag property into nested, non-overlapping bubbles.
//   • "Property tree" — a force-directed tree: property name = root, its values = 1st generation,
//     the items holding each value = 2nd generation (leaves). Drag a leaf onto another value to retag.
// Add with "+ Add" → pick a kind + property. Drag a cluster's header to move it. Retag by dragging an
// item between groups within a cluster. Layout is saved on the active view (syncs across devices).

const NODE_COLORS = ['#7c8cff', '#4fd1c5', '#f6ad55', '#fc8181', '#b794f4', '#68d391', '#f6e05e', '#63b3ed', '#f687b3', '#a0aec0']
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const radiusFor = (label) => { const len = String(label || '').replace(/\s+/g, ' ').trim().length; return Math.max(28, Math.min(60, 22 + Math.sqrt(Math.max(len, 4)) * 6.2)) }
const hexLum = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0.35; const n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255; const f = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let cur = ''
  const pushLong = w => { while (w.length > maxChars) { lines.push(w.slice(0, maxChars)); w = w.slice(maxChars) } return w }
  for (let w of words) { if (w.length > maxChars) { if (cur) { lines.push(cur); cur = '' } w = pushLong(w) } if (!cur) cur = w; else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w; else { lines.push(cur); cur = w } }
  if (cur) lines.push(cur); return lines.length ? lines : ['']
}
const EMPTY = []
// Bounding radius of a free node from its decorations (mirrors FreeNode's body sizing) — used for
// edge hit-testing and endpoint clipping.
const freeNodeRadius = (dec = {}) => {
  const scl = Math.min(2, Math.max(0.6, dec.scale || 1))
  const baseR = 34 * scl
  const shape = dec.shape || 'circle'
  return (shape === 'ellipse' || shape === 'rect' || shape === 'roundrect') ? baseR * 1.34 : shape === 'diamond' ? baseR * 1.16 : baseR
}
// World font that stays between [minPx,maxPx] on screen despite the zoom scale(k) group.
const zfont = (basePx, k, minPx, maxPx) => Math.max(minPx, Math.min(maxPx, basePx * (k || 1))) / (k || 1)
// Colour a node by a chosen "colour by" property's value colour (grey if it has no value there).
const colorByValue = (def, node) => {
  if (!def) return null
  const raw = node?.props?.[def.id]
  const optId = Array.isArray(raw) ? raw[0] : raw
  if (optId == null || optId === '') return '#6b7394'
  return (def.options || []).find(o => o.id === optId)?.color || '#6b7394'
}
// Resolve a bubble's colour from the cluster's colour mode: 'style' = node's own fill, a propId =
// that property's value colour, else (null) = the group/value colour passed in.
const resolveColor = (colorMode, node, dec, groupColor, propertyDefs) => {
  if (colorMode === 'style') return dec?.fill || '#6b7394'
  if (colorMode) return colorByValue(propertyDefs.find(d => d.id === colorMode), node) || '#6b7394'
  return groupColor   // by group value
}
// Size multiplier from the cluster's size mode: 'style' = node's own scale, a number propId = scale
// by that value across [domainMin,domainMax], else 1 (uniform).
const sizeScaleFor = (sizeMode, node, dec, domain) => {
  if (sizeMode === 'style') return Math.min(2, Math.max(0.6, dec?.scale || 1))
  if (sizeMode && domain) { const v = Number(node?.props?.[sizeMode]); if (Number.isFinite(v)) { const [mn, mx] = domain; const t = mx > mn ? (v - mn) / (mx - mn) : 0.5; return 0.7 + t * 1.3 } return 0.85 }
  return 1
}
const domainOf = (nodes, propId) => { let mn = Infinity, mx = -Infinity; nodes.forEach(n => { const v = Number(n?.props?.[propId]); if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v) } }); return mn <= mx ? [mn, mx] : null }

// ── Due-date buckets ─────────────────────────────────────────────────────────
// A date property can be grouped into relative buckets (Today / Tomorrow / …) instead of raw dates.
// dueDefFor() wraps a raw date def as a pseudo tag-def whose "options" are the buckets; the cluster
// then reads the node's real date via def.realId and maps it to a bucket. Overdue/empty → untagged.
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const DUE_BUCKETS = [
  { id: 'today', name: 'Today', color: '#fc8181' },
  { id: 'tomorrow', name: 'Tomorrow', color: '#f6ad55' },
  { id: 'week', name: 'Next 7 days', color: '#f6e05e' },
  { id: 'month', name: 'Next 30 days', color: '#68d391' },
  { id: 'later', name: 'Later', color: '#63b3ed' },
]
const dueBucketOf = (dateStr, now) => {
  if (!dateStr) return null
  const d = startOfDay(dateStr); if (isNaN(d.getTime())) return null
  const days = Math.round((d.getTime() - now.getTime()) / 86400000)
  if (days < 0) return null            // overdue / past → unpacked
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days <= 7) return 'week'
  if (days <= 30) return 'month'
  return 'later'
}
const dueRepDate = (bucketId, now) => {
  const add = { today: 0, tomorrow: 1, week: 7, month: 30, later: 60 }[bucketId]
  if (add == null) return null
  const d = new Date(now); d.setDate(d.getDate() + add)
  return d.toISOString().slice(0, 10)
}
const dueDefFor = (rawDef) => ({ id: rawDef.id, realId: rawDef.id, name: rawDef.name + ' (due)', type: 'dateBucket', options: DUE_BUCKETS })
// A cluster's group options + the group ids a node falls into — unified over tag props and date buckets.
const groupOptionsOf = (def) => def.type === 'dateBucket' ? DUE_BUCKETS : (def.options || [])
const nodeGroupIds = (def, node, now) => {
  if (def.type === 'dateBucket') { const b = dueBucketOf(node?.props?.[def.realId], now); return b ? [b] : [] }
  const v = node?.props?.[def.id]
  return Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
}
// Circular fisheye (Bostock's d3.fisheye.circular): maps a point near `focus` outward (magnified)
// within `radius`; z is the local magnification. Points outside the radius are returned unchanged.
const makeFisheye = (focus, radius, distortion) => {
  let k0 = Math.exp(distortion); k0 = k0 / (k0 - 1) * radius; const k1 = distortion / radius
  return (x, y) => {
    const dx = x - focus[0], dy = y - focus[1], dd = Math.hypot(dx, dy)
    if (!dd || dd >= radius) return { x, y, z: 1 }
    const k = k0 * (1 - Math.exp(-dd * k1)) / dd * 0.75 + 0.25
    return { x: focus[0] + dx * k, y: focus[1] + dy * k, z: Math.min(k, 4) }
  }
}

export default function PackBoard({ projectId, projectList = [], onNavigateProject }) {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const addEdge = useGraphStore(s => s.addEdge)
  const removeEdge = useGraphStore(s => s.removeEdge)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const setNodeProp = useGraphStore(s => s.setNodeProp)
  const addNode = useGraphStore(s => s.addNode)
  const addSelectOption = useGraphStore(s => s.addSelectOption)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const setNodeLink = useGraphStore(s => s.setNodeLink)
  const setBoardSystems = useGraphStore(s => s.setBoardSystems)
  const setViewBoardHidden = useGraphStore(s => s.setViewBoardHidden)
  const setViewBoardNode = useGraphStore(s => s.setViewBoardNode)
  const removeViewBoardNode = useGraphStore(s => s.removeViewBoardNode)
  const setViewFilter = useGraphStore(s => s.setViewFilter)
  const setViewColorBy = useGraphStore(s => s.setViewColorBy)
  const setActiveView = useGraphStore(s => s.setActiveView)
  const addView = useGraphStore(s => s.addView)
  const renameView = useGraphStore(s => s.renameView)
  const deleteView = useGraphStore(s => s.deleteView)
  const duplicateView = useGraphStore(s => s.duplicateView)
  const tagDefs = propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect')

  const svgRef = useRef(null), gRef = useRef(null), zoomRef = useRef(null)
  const [tf, setTf] = useState(d3.zoomIdentity)
  const [systems, setSystems] = useState([])   // working copy: [{ id, propId, x, y, kind }]
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState({ text: '', rules: [] })
  const filterKey = JSON.stringify(filter)
  const [selectedSys, setSelectedSys] = useState(null)   // cluster shown in the right-docked inspector
  const [edit, setEdit] = useState(null) // { nodeId, sysId } — node being edited + the cluster it opened from
  const [fisheye, setFisheye] = useState(false)      // hover magnifier lens toggle
  const [, setLensTick] = useState(0)                // forces re-render as the lens focus follows the cursor
  const focusRef = useRef(null)                      // lens focus in world coords, or null
  const numberDefs = propertyDefs.filter(d => d.type === 'number')
  const dateDefs = propertyDefs.filter(d => d.type === 'date')

  const activeView = views.find(v => v.id === activeViewId)
  const colorByDef = activeView?.colorBy ? propertyDefs.find(d => d.id === activeView.colorBy) : null
  // Per-view effects must key on project+view, NOT view id alone: view ids are only unique WITHIN a
  // project (many projects share "view-default"), so switching between two such projects left this
  // key unchanged and the board kept the previous project's clusters/pan/filter. (bug)
  const viewKey = (projectId || '') + '::' + (activeViewId || '')

  // Persisted filter for the active view (shared with the pack view); seed "hide done" the first time.
  const filterInitRef = useRef(null), filterSaveRef = useRef()
  useEffect(() => {
    if (filterInitRef.current === viewKey) return
    filterInitRef.current = viewKey
    if (activeView?.filter) setFilter(activeView.filter)
    else { const def = defaultDoneFilter(propertyDefs); if (def) { setFilter(def); setViewFilter(def) } else setFilter({ text: '', rules: [] }) }
  }, [viewKey, activeView, propertyDefs, setViewFilter])
  useEffect(() => {
    if (filterInitRef.current !== viewKey) return
    setViewFilter(filter)
    clearTimeout(filterSaveRef.current)
    filterSaveRef.current = setTimeout(() => {
      if (!projectId) return
      const s = useGraphStore.getState()
      if (s.loadedProjectId !== projectId) return
      saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e))
    }, 700)
    return () => clearTimeout(filterSaveRef.current)
  }, [filterKey]) // eslint-disable-line

  const decorColor = useMemo(() => {
    const np = activeView?.nodeProps || {}
    return id => { const p = np[id] || {}; return (p.fillColor && p.fillColor !== 'none' && p.fillColor !== 'transparent') ? p.fillColor : null }
  }, [activeView])
  // Full graph-view cosmetics for a node (so tree leaves mirror the graph): fill, stroke, dash, shape,
  // scale, emoji, text color — read from the active view's nodeProps.
  const decorOf = useMemo(() => {
    const np = activeView?.nodeProps || {}
    return id => {
      const p = np[id] || {}
      const shape = p.shape && !['frame', '3d', 'image', 'none'].includes(p.shape) ? p.shape : null
      // nodeEmojis entries are objects { id, type, angle, emoji } in the graph — extract the glyph
      // string (skip image emojis, which LeafNode can't render as text).
      const e0 = (p.nodeEmojis || [])[0]
      const emoji = !e0 ? null : (typeof e0 === 'string' ? e0 : (e0.type === 'image' ? null : e0.emoji || null))
      return {
        fill: (p.fillColor && p.fillColor !== 'none' && p.fillColor !== 'transparent') ? p.fillColor : null,
        textColor: p.textColor || null,
        stroke: (p.strokeColor && p.strokeColor !== 'none') ? p.strokeColor : null,
        strokeWidth: p.strokeWidth,
        strokeDash: p.strokeDash,
        shape,
        scale: p.scale || 1,
        emoji: typeof emoji === 'string' ? emoji : null,
      }
    }
  }, [activeView])
  const nodeVisible = (id) => (activeView?.nodeProps?.[id]?.visible !== false)

  // Load layout from the active view; one-time migrate legacy localStorage layout into the view.
  useEffect(() => {
    if (!activeView) { setSystems([]); setSelectedSys(null); return }   // no view resolved (e.g. mid project-switch) → don't keep stale clusters
    setSelectedSys(null)   // a different project/view → drop any open config bar
    if (Array.isArray(activeView.boardSystems)) { setSystems(activeView.boardSystems); return }
    let legacy = null
    try { const raw = localStorage.getItem(`pim:board:${projectId}`); if (raw) legacy = JSON.parse(raw) } catch { /* ignore */ }
    if (legacy && legacy.length) { setSystems(legacy); setBoardSystems(legacy); persist(legacy) }
    else setSystems([])
  }, [viewKey]) // eslint-disable-line

  // Restore the saved pan/zoom for this view (once per project+view).
  const tfRestoreRef = useRef(null)
  useEffect(() => {
    if (tfRestoreRef.current === viewKey) return
    const bt = activeView?.boardTf
    if (!zoomRef.current || !svgRef.current) return
    tfRestoreRef.current = viewKey
    const t = bt ? d3.zoomIdentity.translate(bt.x, bt.y).scale(bt.k) : d3.zoomIdentity
    d3.select(svgRef.current).call(zoomRef.current.transform, t); setTf(t)
  }, [viewKey, activeView]) // eslint-disable-line

  const persist = (next) => {
    if (!projectId) return
    const s = useGraphStore.getState()
    if (s.loadedProjectId !== projectId) return   // don't write if the store holds a different project (mid-switch)
    const views2 = s.views.map(v => v.id === s.activeViewId ? { ...v, boardSystems: next } : v)
    saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: views2, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e))
  }
  // Commit to store + DB (add / remove / move-end). Move-drag itself stays local for smoothness.
  const commit = (next) => { setSystems(next); setBoardSystems(next); persist(next) }
  const systemsRef = useRef(systems); systemsRef.current = systems   // live copy for handlers (avoid stale closures)

  const setViewBoardTf = useGraphStore(s => s.setViewBoardTf)
  const tfSaveRef = useRef()
  useEffect(() => {
    if (!svgRef.current) return
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.06, 4])
      .filter(e => { if (e.type === 'mousedown' && e.target?.closest?.('[data-bubble],[data-syshead]')) return false; return !e.ctrlKey && !e.button })
      .on('zoom', e => {
        setTf(e.transform)
        if (e.sourceEvent) {   // only persist real user pans/zooms (not our programmatic restore)
          setViewBoardTf({ x: e.transform.x, y: e.transform.y, k: e.transform.k })
          clearTimeout(tfSaveRef.current)
          tfSaveRef.current = setTimeout(() => { const s = useGraphStore.getState(); if (projectId && s.loadedProjectId === projectId) saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(() => {}) }, 800)
        }
      })
    zoomRef.current = zoom; sel.call(zoom)
    return () => sel.on('.zoom', null)
  }, [])

  const toWorld = (ev) => { const g = gRef.current, svg = svgRef.current; const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const l = pt.matrixTransform(g.getScreenCTM().inverse()); return { x: l.x, y: l.y } }

  const addSystem = (propId, kind) => {
    const cur = systemsRef.current                     // live list — not the stale render closure
    const n = cur.length
    const x = 300 + (n % 3) * 640, y = 300 + Math.floor(n / 3) * 580
    commit([...cur, { id: crypto.randomUUID(), propId, x, y, kind }])
    // Leave the menu open so several packs/trees can be added in a row; click away to dismiss.
  }
  const removeSystem = (id) => commit(systemsRef.current.filter(s => s.id !== id))
  const moveSystem = (id, x, y) => setSystems(prev => prev.map(s => s.id === id ? { ...s, x, y } : s))
  const commitMove = () => commit(systemsRef.current)   // latest moved positions
  const setSystemConfig = (id, patch) => commit(systemsRef.current.map(s => s.id === id ? { ...s, ...patch } : s))
  // Per-cluster filter: update local immediately, persist to the view (debounced).
  const clFilterSaveRef = useRef()
  const setSystemFilter = (id, filter) => {
    const next = systemsRef.current.map(s => s.id === id ? { ...s, filter } : s)
    setSystems(next); setBoardSystems(next)
    clearTimeout(clFilterSaveRef.current)
    clFilterSaveRef.current = setTimeout(() => persist(systemsRef.current), 700)
  }

  const retag = (propId, nodeId, sourceOpt, targetOpt, additive) => {
    const def = propertyDefs.find(d => d.id === propId); if (!def) return
    const node = useGraphStore.getState().nodes.find(n => n.id === nodeId)
    const raw = node?.props?.[propId]
    let value
    if (def.type === 'multiSelect') {
      let tags = Array.isArray(raw) ? [...raw] : (raw ? [raw] : [])
      if (!additive && sourceOpt && sourceOpt !== '__untagged__') tags = tags.filter(x => x !== sourceOpt)
      if (targetOpt !== '__untagged__' && !tags.includes(targetOpt)) tags.push(targetOpt)
      value = tags
    } else value = targetOpt === '__untagged__' ? null : targetOpt
    setNodeProp(nodeId, propId, value)
    if (projectId) { const s = useGraphStore.getState(); saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e)) }
  }
  // View management (shared views; persist to DB on change so switches survive reload).
  const saveAll = () => { if (!projectId) return; const s = useGraphStore.getState(); if (s.loadedProjectId !== projectId) return; saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e)) }
  const switchView = (id) => { setActiveView(id); saveAll() }
  const setBoardColorBy = (propId) => { setViewColorBy(propId); saveAll() }

  // Set several properties on a node at once (deterministic pack drop → sets group value(s)).
  // `from` = the source option the leaf was dragged out of: for multiSelect we remove only that
  // membership and add the target, so a node's OTHER tags are preserved (moving one, not replacing
  // all). For a date group the value is a bucket id → written as a representative date.
  const retagMulti = (nodeId, assignments) => {
    const now = startOfDay(new Date())
    const node = useGraphStore.getState().nodes.find(n => n.id === nodeId)
    assignments.forEach(({ propId, value, from }) => {
      const def = propertyDefs.find(d => d.id === propId); if (!def) return
      if (def.type === 'date') { setNodeProp(nodeId, propId, value ? dueRepDate(value, now) : null); return }
      if (def.type === 'multiSelect') {
        const raw = node?.props?.[propId]
        let next = Array.isArray(raw) ? [...raw] : (raw ? [raw] : [])
        if (from && from !== '__untagged__') next = next.filter(x => x !== from)
        if (value && value !== '__untagged__' && !next.includes(value)) next.push(value)
        setNodeProp(nodeId, propId, next)
        return
      }
      setNodeProp(nodeId, propId, value && value !== '__untagged__' ? value : null)
    })
    saveAll()
  }
  // Group ids a node falls into for a cluster's grouping def (tag values or date buckets), validated.
  const groupValsOf = (n, def) => {
    const ids = nodeGroupIds(def, n, startOfDay(new Date())).filter(id => def.type === 'dateBucket' ? true : (def.options || []).some(o => o.id === id))
    return ids.length ? ids : ['__untagged__']
  }
  // Per-outer-group "group children by" override on a cluster. undefined value = clear (inherit).
  const setGroupOverride = (sysId, opt, val) => {
    const s = systemsRef.current.find(x => x.id === sysId)
    const cur = { ...(s?.groupOverrides || {}) }
    if (val === undefined) delete cur[opt]; else cur[opt] = val
    setSystemConfig(sysId, { groupOverrides: cur })
  }
  // Create a new node from the board and apply group assignments (so it lands in the right group).
  const addNodeWith = (assignments) => {
    const label = prompt('New item name'); if (label == null) return
    const id = addNode(label.trim() || 'New item')
    const now = startOfDay(new Date())
    assignments.forEach(({ propId, value }) => {
      const def = propertyDefs.find(d => d.id === propId); if (!def || value === '__untagged__' || value == null) return
      if (def.type === 'date') setNodeProp(id, propId, dueRepDate(value, now))
      else setNodeProp(id, propId, def.type === 'multiSelect' ? [value] : value)
    })
    saveAll()
  }
  // Board-only hidden set (per view). Independent of the graph's `visible` flag so board hides don't
  // touch the graph and vice-versa.
  const boardHiddenSet = useMemo(() => new Set(activeView?.boardHidden || []), [activeView])
  const hideNodes = (ids) => {
    const cur = new Set(activeView?.boardHidden || [])
    ids.forEach(id => cur.add(id))
    setViewBoardHidden([...cur]); saveAll()
  }

  // Free nodes: standalone items placed directly on the board canvas (per view), NOT part of any
  // cluster. A node is EITHER free OR clustered, so clusters exclude these ids.
  const boardFreeMap = useMemo(() => activeView?.boardNodes || {}, [activeView])
  const freeIds = useMemo(() => new Set(Object.keys(boardFreeMap)), [boardFreeMap])
  const freeNodes = useMemo(
    () => nodes.filter(n => freeIds.has(n.id) && !boardHiddenSet.has(n.id)),
    [nodes, freeIds, boardHiddenSet])

  const visibleNodes = useMemo(
    () => nodes.filter(n => !boardHiddenSet.has(n.id) && !freeIds.has(n.id) && nodeMatchesFilter(n, filter, propertyDefs)),
    [nodes, boardHiddenSet, freeIds, filterKey, propertyDefs]) // eslint-disable-line

  // Create a node and drop it onto the board as a free item at the current viewport center.
  const addFreeNode = () => {
    const label = prompt('New item name'); if (label == null) return
    const id = addNode(label.trim() || 'New item')
    const rect = svgRef.current?.getBoundingClientRect()
    const cx = rect ? rect.width / 2 : 400, cy = rect ? rect.height / 2 : 300
    const k = tf.k || 1
    setViewBoardNode(id, { x: (cx - tf.x) / k, y: (cy - tf.y) / k })
    saveAll()
  }
  const moveFreeNode = (id, x, y) => { setViewBoardNode(id, { x, y }); saveAll() }
  const unFreeNode = (id) => { removeViewBoardNode(id); saveAll() }
  const followLink = (lt) => { if (lt?.projectId && onNavigateProject) onNavigateProject(lt.projectId, lt.projectName) }

  // Edges between free nodes turn the board's free canvas into a mind-map. Draw only edges whose
  // BOTH endpoints are visible free nodes; the shared `edges` topology is view-independent.
  const freeVisibleIds = useMemo(() => new Set(freeNodes.map(n => n.id)), [freeNodes])
  const freeEdges = useMemo(
    () => edges.filter(e => freeVisibleIds.has(e.source) && freeVisibleIds.has(e.target)),
    [edges, freeVisibleIds])

  // Drag a free node's connector handle → another free node = new edge; → empty = new connected node.
  const [linking, setLinking] = useState(null)   // { fromId, x, y } world coords while linking
  const startConnect = (fromId, e) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); setLinking({ fromId, x: p0.x, y: p0.y })
    const move = ev => { const p = toWorld(ev); setLinking({ fromId, x: p.x, y: p.y }) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = toWorld(ev)
      let hit = null
      for (const n of freeNodes) {
        if (n.id === fromId) continue
        const pos = boardFreeMap[n.id]; if (!pos) continue
        if (Math.hypot(p.x - pos.x, p.y - pos.y) <= freeNodeRadius(decorOf(n.id))) { hit = n; break }
      }
      if (hit) { addEdge(fromId, hit.id); saveAll() }
      else {
        const label = prompt('New connected item name')
        if (label != null) { const id = addNode(label.trim() || 'New item'); addEdge(fromId, id); setViewBoardNode(id, { x: p.x, y: p.y }); saveAll() }
      }
      setLinking(null)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const deleteEdge = (id) => { if (confirm('Remove this connection?')) { removeEdge(id); saveAll() } }

  // Zoom-to-fit a cluster's world bounding box (drill-down: double-click a cluster header).
  const zoomToFit = (bbox) => {
    const svg = svgRef.current; if (!svg || !zoomRef.current || !bbox) return
    const rect = svg.getBoundingClientRect(), w = rect.width, h = rect.height
    const bw = Math.max(1, bbox.x1 - bbox.x0), bh = Math.max(1, bbox.y1 - bbox.y0)
    const pad = 70
    const k = Math.max(0.06, Math.min(2.2, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)))
    const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2
    const t = d3.zoomIdentity.translate(w / 2 - k * cx, h / 2 - k * cy).scale(k)
    d3.select(svg).transition().duration(450).call(zoomRef.current.transform, t)
  }
  // Active fisheye lens (world coords). Radius is held ~constant on screen by dividing by the zoom.
  const lens = (fisheye && focusRef.current) ? makeFisheye(focusRef.current, 320 / (tf.k || 1), 3) : null
  const onCanvasMove = (e) => { if (!fisheye) return; focusRef.current = toWorld(e); setLensTick(t => t + 1) }
  const onCanvasLeave = () => { if (focusRef.current) { focusRef.current = null; setLensTick(t => t + 1) } }

  return (
    <div style={styles.wrap} onContextMenu={e => e.preventDefault()}>
      <div style={styles.main}>
        <div style={styles.toolbar}>
          <div style={{ position: 'relative' }}>
            <button style={styles.addBtn} onClick={() => setAdding(o => !o)} disabled={!tagDefs.length && !dateDefs.length}>+ Add</button>
            {adding && (<>
              <div style={styles.backdrop} onClick={() => setAdding(false)} />
              <div style={styles.menu} onClick={e => e.stopPropagation()}>
                {!tagDefs.length && !dateDefs.length && <div style={{ ...styles.item, color: '#8090b8' }}>No Select/Tags/Date property</div>}
                {tagDefs.length > 0 && <>
                  <div style={styles.mlabel}>◎ Circle pack — group by</div>
                  {tagDefs.map(d => (<div key={'p' + d.id} style={styles.item} onClick={() => addSystem(d.id, 'pack')}>{d.name}</div>))}
                  <div style={{ ...styles.mlabel, marginTop: 4 }}>⌥ Property tree — branch by</div>
                  {tagDefs.map(d => (<div key={'t' + d.id} style={styles.item} onClick={() => addSystem(d.id, 'tree')}>{d.name}</div>))}
                </>}
                {dateDefs.length > 0 && <>
                  <div style={{ ...styles.mlabel, marginTop: 4 }}>◷ Due-date buckets — by</div>
                  {dateDefs.map(d => (<div key={'d' + d.id} style={styles.item} onClick={() => addSystem(d.id, 'pack')}>{d.name}</div>))}
                </>}
              </div>
            </>)}
          </div>
          <button style={styles.addBtn} onClick={addFreeNode} title="Create a free item on the board">+ Node</button>
          <span style={{ fontSize: '0.6rem', letterSpacing: '0.08em', color: '#7080a0' }}>VIEWS</span>
          {views.map(v => (
            <div key={v.id} title="Click to switch · double-click to rename"
              style={{ ...styles.viewPill, ...(v.id === activeViewId ? styles.viewPillActive : {}) }}
              onClick={() => switchView(v.id)}
              onDoubleClick={() => { const nm = prompt('Rename view', v.name); if (nm && nm.trim()) { renameView(v.id, nm.trim()); saveAll() } }}>
              <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
              {views.length > 1 && <span style={styles.viewX} onClick={e => { e.stopPropagation(); if (confirm(`Delete view “${v.name}”?`)) { deleteView(v.id); saveAll() } }}>×</span>}
            </div>
          ))}
          <button style={styles.viewAdd} onClick={() => { duplicateView(activeViewId); saveAll() }} title="Duplicate view">⧉</button>
          <button style={styles.viewAdd} onClick={() => { addView(); saveAll() }} title="New view">+</button>
          {boardHiddenSet.size > 0 && (
            <button style={{ ...styles.lensBtn, marginLeft: 'auto', color: '#f0b090', borderColor: '#5a4030' }}
              title="Hidden on the board only (the graph is unaffected). Click to show them again."
              onClick={() => { setViewBoardHidden([]); saveAll() }}>🙈 {boardHiddenSet.size} hidden · Show all</button>
          )}
          <button style={{ ...styles.lensBtn, ...(fisheye ? styles.lensBtnOn : {}), ...(boardHiddenSet.size > 0 ? {} : { marginLeft: 'auto' }) }}
            onClick={() => setFisheye(o => { if (o) focusRef.current = null; return !o })} title="Hover magnifier lens">🔍 Lens {fisheye ? 'on' : 'off'}</button>
          <span style={{ color: '#8090b8', fontSize: '0.72rem' }}>{systems.length} cluster{systems.length === 1 ? '' : 's'} · click a header for controls · double-click to zoom · drag to move</span>
        </div>
        {!systems.length && !freeNodes.length && <div style={styles.empty}>Nothing here yet. Click <b style={{ color: '#8ab4ff' }}>+ Add</b> for a circle pack or tree, or <b style={{ color: '#8ab4ff' }}>+ Node</b> for a free item.</div>}
        <svg ref={svgRef} style={styles.svg} onMouseMove={onCanvasMove} onMouseLeave={onCanvasLeave}>
          <g ref={gRef} transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
            {systems.map(sys => {
              const groupBy = (sys.groupBy && sys.groupBy.length) ? sys.groupBy : [sys.propId]
              const rawDef = propertyDefs.find(d => d.id === groupBy[0])
              if (!rawDef) return null
              // A date property is grouped into relative due buckets (Today / Tomorrow / …).
              const isDate = rawDef.type === 'date'
              const def = isDate ? dueDefFor(rawDef) : rawDef
              const common = {
                key: sys.id, sys, def, nodes: visibleNodes, decorColor, decorOf, toWorld, zoomK: tf.k, lens,
                filterFn: (n) => !(sys.hiddenIds || []).includes(n.id) && nodeMatchesFilter(n, sys.filter || { text: '', rules: [] }, propertyDefs),
                clusterFilterKey: JSON.stringify({ f: sys.filter || {}, h: sys.hiddenIds || [] }),
                hasFilter: !!(sys.filter?.text || sys.filter?.rules?.length),
                selected: selectedSys === sys.id, onSelect: () => setSelectedSys(sys.id),
                colorMode: sys.colorBy !== undefined ? sys.colorBy : (activeView?.colorBy || null),
                sizeMode: sys.sizeBy || null, propertyDefs,
                onEditNode: (nodeId, sysId) => setEdit({ nodeId, sysId: sysId || sys.id }), onDrill: zoomToFit,
                onMove: moveSystem, onCommitMove: commitMove, onRemove: () => removeSystem(sys.id),
                // Proximal config bar (shown when the cluster is selected).
                cfgBar: {
                  tagDefs, numberDefs, dateDefs,
                  onConfig: (patch) => setSystemConfig(sys.id, patch),
                  onFilter: (f) => setSystemFilter(sys.id, f),
                  onRemove: () => { removeSystem(sys.id); setSelectedSys(null) },
                  onClose: () => setSelectedSys(null),
                },
              }
              if (sys.kind === 'tree') {
                return <TreeCluster {...common} groupValsOf={groupValsOf} onRetagMulti={retagMulti} onHideNodes={hideNodes} arrange={!!sys.arrange} onAddNode={addNodeWith}
                  onSetGroupOverride={(opt, val) => setGroupOverride(sys.id, opt, val)}
                  onSaveHubs={(map) => setSystemConfig(sys.id, { hubPos: map })}
                  onSaveLeaves={(map) => setSystemConfig(sys.id, { leafPos: map })} />
              }
              // Circle pack — deterministic d3.pack (no overlap, minimal size), 1 or 2 grouping levels.
              // Date packs are always single-level (bucketed).
              const packDefs = isDate ? [def] : groupBy.map(id => propertyDefs.find(d => d.id === id)).filter(Boolean).slice(0, 2)
              return <NestedPackCluster {...common} groupDefs={packDefs.length ? packDefs : [def]} groupValsOf={groupValsOf} onRetagMulti={retagMulti}
                onSetGroupOverride={(opt, val) => setGroupOverride(sys.id, opt, val)} onAddNode={addNodeWith} />
            })}
            {/* Connections between free nodes (behind the nodes) + the live rubber line while linking. */}
            <g>
              {freeEdges.map(e => {
                const a = boardFreeMap[e.source], b = boardFreeMap[e.target]
                if (!a || !b) return null
                return (
                  <g key={'fe:' + e.id}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#5b6af0" strokeOpacity={0.55} strokeWidth={2} />
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={14}
                      style={{ cursor: 'pointer' }} onDoubleClick={ev => { ev.stopPropagation(); deleteEdge(e.id) }}>
                      <title>Double-click to remove</title>
                    </line>
                  </g>
                )
              })}
              {linking && boardFreeMap[linking.fromId] && (
                <line x1={boardFreeMap[linking.fromId].x} y1={boardFreeMap[linking.fromId].y} x2={linking.x} y2={linking.y}
                  stroke="#8ab4ff" strokeWidth={2} strokeDasharray="5 4" pointerEvents="none" />
              )}
            </g>
            {/* Free nodes — standalone items placed directly on the canvas (paint on top of clusters). */}
            {freeNodes.map(n => (
              <FreeNode key={'free:' + n.id} node={n} pos={boardFreeMap[n.id]} decor={decorOf(n.id)}
                lens={lens} toWorld={toWorld} onDragEnd={moveFreeNode}
                onEdit={(id) => setEdit({ nodeId: id, free: true })}
                onNavigate={() => followLink(n.linkTo)}
                onConnect={(e) => startConnect(n.id, e)} />
            ))}
          </g>
        </svg>
        {edit && (() => {
          const editNode = nodes.find(n => n.id === edit.nodeId)
          return <NodePropsEditor
            node={editNode}
            propertyDefs={propertyDefs}
            onSet={(propId, value) => { setNodeProp(edit.nodeId, propId, value); saveAll() }}
            onAddOption={(propId, name) => addSelectOption(propId, name)}
            onClose={() => setEdit(null)}
            projectLink={{ projects: projectList, value: editNode?.linkTo, currentProjectId: projectId,
              onSet: (lt) => { setNodeLink(edit.nodeId, lt); saveAll() } }}
            actions={[
              ...(editNode?.linkTo?.projectId ? [{ label: `↗ Open ${editNode.linkTo.projectName || 'linked project'}`, onClick: () => { setEdit(null); followLink(editNode.linkTo) } }] : []),
              ...(edit.free ? [{ label: '↩ Remove from board (return to clusters)', onClick: () => { unFreeNode(edit.nodeId); setEdit(null) } }] : []),
              ...(edit.sysId ? [{ label: '⊘ Hide in this cluster', onClick: () => { const s = systemsRef.current.find(x => x.id === edit.sysId); setSystemConfig(edit.sysId, { hiddenIds: [...new Set([...(s?.hiddenIds || []), edit.nodeId])] }); setEdit(null) } }] : []),
              { label: '🙈 Hide on the board', danger: true, onClick: () => { hideNodes([edit.nodeId]); setEdit(null) } },
            ]}
          />
        })()}
      </div>
    </div>
  )
}

// One independent pack cluster, positioned at (sys.x, sys.y) on the shared canvas, running its own
// force layout in LOCAL coordinates (centered on 0,0). Mirrors the proven single-pack mechanics.
function Cluster({ sys, def, colorMode, sizeMode, propertyDefs, decorOf, nodes, toWorld, zoomK, lens, filterFn, clusterFilterKey, hasFilter, selected, onSelect, onEditNode, onDrill, onRetag, onMove, onCommitMove, onRemove }) {
  const simRef = useRef(null), packSimRef = useRef(null)
  const bubblesRef = useRef([]), packsRef = useRef([]), groupsRef = useRef([])
  const heldRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [held, setHeld] = useState(() => new Set())
  const [hover, setHover] = useState(null)

  const build = () => {
    const now = startOfDay(new Date())
    const opts = groupOptionsOf(def)
    const groups = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(groups.map((g, i) => [g.opt, i]))
    const numDomain = (sizeMode && sizeMode !== 'style') ? domainOf(nodes, sizeMode) : null
    const raw = []
    nodes.forEach(n => {
      if (filterFn && !filterFn(n)) return   // per-cluster filter
      const ids = nodeGroupIds(def, n, now)
      const valid = ids.filter(id => idx.has(id))
      const dec = decorOf?.(n.id) || {}
      const scl = sizeScaleFor(sizeMode, n, dec, numDomain)   // per-cluster size mapping
      const label = n.label || '(untitled)'
      if (!valid.length) raw.push({ nodeId: n.id, opt: '__untagged__', group: -1, label, scl, color: resolveColor(colorMode, n, dec, '#6b7394', propertyDefs) })
      else valid.forEach(id => { const gi = idx.get(id); raw.push({ nodeId: n.id, opt: id, group: gi, label, scl, color: resolveColor(colorMode, n, dec, groups[gi].color, propertyDefs) }) })
    })
    raw.forEach(b => { b.key = b.nodeId + '@' + b.opt; b.r = radiusFor(b.label) * (b.scl || 1) })
    return { groups, bubbles: raw }
  }
  const structureKey = useMemo(() => {
    const opt = (def.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows
  }, [nodes, def])

  useEffect(() => {
    const packSim = d3.forceSimulation([])
      .force('x', d3.forceX(0).strength(0.05)).force('y', d3.forceY(0).strength(0.05))
      .force('collide', d3.forceCollide(p => p.r + 6).strength(1).iterations(3))
      .alphaDecay(0.03).velocityDecay(0.62).on('tick', () => {
        const ps = packsRef.current
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j]; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 6
          if (d < min) { const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d; a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
        }
        setTick(t => t + 1)
      })
    packSimRef.current = packSim
    const sim = d3.forceSimulation([]).force('charge', d3.forceManyBody().strength(-5))
      .force('collide', d3.forceCollide(b => b.r + 2).strength(0.9)).alphaDecay(0.02).velocityDecay(0.55)
      .on('tick', () => {
        const packs = packsRef.current, h = heldRef.current, bs = bubblesRef.current
        for (let pass = 0; pass < 3; pass++) {
          for (const b of bs) {
            if (b.fx != null || h.has(b.key)) continue
            const own = b.group >= 0 ? packs[b.group] : null
            for (const c of packs) { if (c === own) continue; const dx = b.x - c.x, dy = b.y - c.y, d = Math.hypot(dx, dy), min = c.r + b.r + 2; if (d < min) { const dd = d || 1; b.x = c.x + dx / dd * min; b.y = c.y + dy / dd * min; b.vx *= 0.4; b.vy *= 0.4 } }
            if (own) { const dx = b.x - own.x, dy = b.y - own.y, d = Math.hypot(dx, dy) || 1, max = Math.max(0, own.r - b.r - 2); if (d > max) { b.x = own.x + dx / d * max; b.y = own.y + dy / d * max; b.vx *= 0.4; b.vy *= 0.4 } }
          }
          for (let i = 0; i < bs.length; i++) { const a = bs[i]; for (let j = i + 1; j < bs.length; j++) { const b = bs[j]; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 1.5; if (d < min) { const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d; const af = a.fx != null || h.has(a.key), bf = b.fx != null || h.has(b.key); if (af && !bf) { b.x += ux * push; b.y += uy * push } else if (bf && !af) { a.x -= ux * push; a.y -= uy * push } else if (!af && !bf) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 } } } }
        }
        for (const p of packs) {
          // Exclude the bubble being dragged so the pack doesn't grow to chase it out of the circle
          // (that would stop a drag-out from ever reading as "outside" → no untag).
          let cx = 0, cy = 0, n = 0
          for (const b of bs) if (b.group === p.gi && !h.has(b.key)) { cx += b.x; cy += b.y; n++ }
          if (n) { cx /= n; cy /= n; p.x += (cx - p.x) * 0.2; p.y += (cy - p.y) * 0.2; let md = 0; for (const b of bs) if (b.group === p.gi && !h.has(b.key)) { const d = Math.hypot(b.x - p.x, b.y - p.y) + b.r; if (d > md) md = d } p.r += ((md + 6) - p.r) * 0.25 } else p.r += (42 - p.r) * 0.25
        }
        setTick(t => t + 1)
      })
    simRef.current = sim
    return () => { packSim.stop(); sim.stop() }
  }, [])

  useEffect(() => {
    const { groups, bubbles } = build()
    groupsRef.current = groups
    const gc = groups.map(() => ({ r: 60 }))
    d3.packSiblings(gc); const enc = d3.packEnclose(gc) || { x: 0, y: 0 }
    const prev = new Map((packsRef.current || []).map(p => [p.opt, p]))
    const packs = groups.map((g, gi) => {
      const ex = prev.get(g.opt); if (ex) { ex.gi = gi; ex.name = g.name; ex.color = g.color; return ex }
      return { gi, opt: g.opt, name: g.name, color: g.color, r: 60, x: gc[gi].x - enc.x, y: gc[gi].y - enc.y }
    })
    packsRef.current = packs
    const prevB = bubblesRef.current || [], byKey = new Map(prevB.map(b => [b.key, b])), byNode = new Map()
    prevB.forEach(b => { if (!byNode.has(b.nodeId)) byNode.set(b.nodeId, b) })
    const next = bubbles.map(d => {
      const ex = byKey.get(d.key); if (ex) { ex.group = d.group; ex.r = d.r; ex.color = d.color; ex.label = d.label; return ex }
      const seed = byNode.get(d.nodeId); const c = d.group >= 0 ? packs[d.group] : { x: 0, y: 0 }; const j = (hashStr(d.key) % 22) - 11
      return { ...d, x: seed?.x ?? c.x + j, y: seed?.y ?? c.y + j, vx: 0, vy: 0 }
    })
    bubblesRef.current = next
    const ps = packSimRef.current, sm = simRef.current; if (!ps || !sm) return
    ps.nodes(packs); ps.alpha(0.5).restart()
    sm.nodes(next)
    sm.force('x', d3.forceX(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].x : 0).strength(b => b.group >= 0 ? 0.5 : 0.05))
    sm.force('y', d3.forceY(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].y : 0).strength(b => b.group >= 0 ? 0.5 : 0.05))
    sm.alpha(0.7).restart(); setTick(t => t + 1)
  }, [structureKey, colorMode, sizeMode, clusterFilterKey]) // eslint-disable-line

  const setHeldKeys = (s) => { heldRef.current = s; setHeld(s) }
  const local = (ev) => { const p = toWorld(ev); return { x: p.x - sys.x, y: p.y - sys.y } }   // canvas world → cluster-local
  const dropTarget = (p) => { let best = null, bd = Infinity; packsRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } }); const c = packsRef.current[best]; if (best == null || !c) return -1; return Math.hypot(p.x - c.x, p.y - c.y) > c.r + 30 ? -1 : best }

  const startDrag = (e, b) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current; const start = local(e)
    b.fx = b.x; b.fy = b.y; setHeldKeys(new Set([b.key]))   // no global reheat while dragging (avoids motion storm)
    const move = ev => { const p = local(ev); b.fx = p.x; b.fy = p.y; b.x = p.x; b.y = p.y; setHover(dropTarget(p)); setTick(t => t + 1) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = local(ev); const tg = dropTarget(p); setHeldKeys(new Set()); setHover(null); sim.alphaTarget(0)
      b.fx = null; b.fy = null
      const groups = groupsRef.current; const targetOpt = tg < 0 ? '__untagged__' : groups[tg].opt
      if (Math.hypot(p.x - start.x, p.y - start.y) > 4 && (tg < 0 ? b.opt !== '__untagged__' : targetOpt !== b.opt)) onRetag(b.nodeId, b.opt, targetOpt, false)
      else sim.alphaTarget(0.03).restart(), setTimeout(() => sim.alphaTarget(0), 600)   // gentle, brief reintegration (no storm, no stuck-anchor)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const startHeadDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = sys.x - p0.x, oy = sys.y - p0.y; let moved = false
    const move = ev => { const p = toWorld(ev); if (Math.hypot(p.x - p0.x, p.y - p0.y) > 3) moved = true; onMove(sys.id, p.x + ox, p.y + oy) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (moved) onCommitMove(); else onSelect && onSelect() }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const bubbles = bubblesRef.current, packs = packsRef.current
  const dragging = held.size > 0
  const bounds = packs.reduce((a, p) => ({ minY: Math.min(a.minY, p.y - p.r), minX: Math.min(a.minX, p.x - p.r), maxX: Math.max(a.maxX, p.x + p.r) }), { minY: 0, minX: 0, maxX: 0 })
  const headY = (packs.length ? bounds.minY : 0) - 46
  const clusterBBox = () => {
    if (!packs.length) return { x0: sys.x - 120, y0: sys.y - 120, x1: sys.x + 120, y1: sys.y + 120 }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    packs.forEach(p => { x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r); x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r) })
    return { x0: sys.x + x0, y0: sys.y + y0 - 46, x1: sys.x + x1, y1: sys.y + y1 }
  }

  return (
    <g transform={`translate(${sys.x},${sys.y})`}>
      <ClusterHeader def={def} kind="pack" cx={(bounds.minX + bounds.maxX) / 2} y={headY} zoomK={zoomK} hasFilter={hasFilter} selected={selected} onHead={startHeadDrag} onDrill={() => onDrill && onDrill(clusterBBox())} onRemove={onRemove} />
      {packs.map(p => {
        const count = bubbles.filter(b => b.group === p.gi).length
        const isT = dragging && hover === p.gi
        const zf = zfont(17, zoomK, 12, 30)
        return (
          <g key={'o' + p.gi} pointerEvents="none">
            <circle cx={p.x} cy={p.y} r={p.r} fill={p.color + '1e'} stroke={isT ? '#7fd8a8' : p.color} strokeWidth={isT ? 3.5 : 2} />
            <text x={p.x} y={p.y - p.r - zf * 0.4} textAnchor="middle" fontSize={zf} fontWeight={800} fill={isT ? '#7fd8a8' : p.color}
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: zf * 0.29, strokeLinejoin: 'round' }}>{p.name} · {count}</text>
          </g>
        )
      })}
      {bubbles.map(b => <Bubble key={b.key} b={b} held={held.has(b.key)} lens={lens} ox={sys.x} oy={sys.y} onDown={e => startDrag(e, b)}
        onContext={e => { e.preventDefault(); e.stopPropagation(); onEditNode && onEditNode(b.nodeId) }}
        onDbl={e => { e.stopPropagation(); onEditNode && onEditNode(b.nodeId) }} />)}
    </g>
  )
}

// Property tree: root (property) → value nodes (1st gen) → item leaves (2nd gen). Force-directed in
// LOCAL coordinates with the root pinned at 0,0; values held on a ring; leaves pulled to their value.
// Drag a leaf onto another value node to retag (same semantics as the pack cluster).
function TreeCluster({ sys, def, colorMode, sizeMode, propertyDefs, nodes, decorOf, toWorld, zoomK, lens, filterFn, clusterFilterKey, hasFilter, arrange, groupValsOf, selected, cfgBar, onSelect, onEditNode, onDrill, onRetagMulti, onHideNodes, onSaveHubs, onSaveLeaves, onAddNode, onSetGroupOverride, onMove, onCommitMove, onRemove }) {
  const simRef = useRef(null)
  const fnodesRef = useRef([]), valuesRef = useRef([]), subsRef = useRef([])
  const overrides = sys.groupOverrides || {}
  // Per-hub "group children by" override: a propId sub-groups that hub's items into sub-hubs.
  const resolveDef = (id) => { const d = propertyDefs.find(x => x.id === id); return d ? (d.type === 'date' ? dueDefFor(d) : d) : null }
  const subDefOf = (opt) => { const ov = overrides[opt]; return ov ? resolveDef(ov) : null }
  const heldRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [held, setHeld] = useState(() => new Set())
  const [hover, setHover] = useState(null)
  const [vmenu, setVmenu] = useState(null)   // right-click menu on a value hub: { opt }
  const vmenuElRef = useRef(null)
  useEffect(() => {
    if (!vmenu) return
    // Capture phase: node mousedown handlers stopPropagation, so a bubble-phase
    // listener never fires on a node click and the menu gets stuck open. Capture
    // sees every mousedown; the containment check keeps clicks inside the menu alive.
    const close = (e) => { if (vmenuElRef.current && vmenuElRef.current.contains(e.target)) return; setVmenu(null) }
    document.addEventListener('mousedown', close, true)
    return () => document.removeEventListener('mousedown', close, true)
  }, [vmenu])

  const build = () => {
    const now = startOfDay(new Date())
    const opts = groupOptionsOf(def)
    const values = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(values.map((v, i) => [v.opt, i]))
    const leaves = []
    const subMap = new Map()   // subId → { id, opt, subVal, name, color, subProp }
    let hasUntagged = false
    const colorForOpt = (opt) => (values.find(v => v.opt === opt)?.color) || '#6b7394'
    const subName = (sd, sv) => sv === '__untagged__' ? '(untagged)' : ((sd.options || []).find(o => o.id === sv)?.name || sv)
    const subColor = (sd, sv) => sv === '__untagged__' ? '#3a4358' : ((sd.options || []).find(o => o.id === sv)?.color || '#6b7394')
    const numDomain = (sizeMode && sizeMode !== 'style') ? domainOf(nodes, sizeMode) : null
    const vals = groupValsOf || ((n, d) => { const ids = nodeGroupIds(d, n, now); return ids.length ? ids : ['__untagged__'] })
    nodes.forEach(n => {
      if (filterFn && !filterFn(n)) return   // per-cluster filter
      const ids = nodeGroupIds(def, n, now)
      const valid = ids.filter(id => idx.has(id))
      const dec = decorOf?.(n.id) || {}
      const label = n.label || '(untitled)'
      // Uniform = identical radius for every item (NOT scaled by label length or the node's own
      // scale — that was the bug). Style = node's own scale; a number property = scale by value.
      const scl = sizeScaleFor(sizeMode, n, dec, numDomain)   // 1 when Uniform
      const baseR = 34 * scl
      const shape = dec.shape || 'circle'
      const bound = (shape === 'ellipse' || shape === 'rect' || shape === 'roundrect') ? baseR * 1.34 : shape === 'diamond' ? baseR * 1.16 : baseR
      const opl = valid.length ? valid : ['__untagged__']
      if (!valid.length) hasUntagged = true
      opl.forEach(opt => {
        const sd = subDefOf(opt)   // this hub's "group children by" override (or null = flat)
        if (sd) {
          vals(n, sd).forEach(sv => {
            const subId = 'sub:' + opt + '|' + sv
            if (!subMap.has(subId)) subMap.set(subId, { id: subId, opt, subVal: sv, name: subName(sd, sv), color: subColor(sd, sv), subProp: sd.id })
            leaves.push({ nodeId: n.id, opt, sub: sv, subId, subProp: sd.id, label, color: resolveColor(colorMode, n, dec, subMap.get(subId).color, propertyDefs), decor: dec, shape, baseR, r: bound })
          })
        } else {
          leaves.push({ nodeId: n.id, opt, sub: null, subId: null, label, color: resolveColor(colorMode, n, dec, colorForOpt(opt), propertyDefs), decor: dec, shape, baseR, r: bound })
        }
      })
    })
    if (hasUntagged) values.push({ opt: '__untagged__', name: '(untagged)', color: '#6b7394' })
    return { values, subs: [...subMap.values()], leaves }
  }
  const structureKey = useMemo(() => {
    const opt = (def.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows + '#' + JSON.stringify(overrides) + '#' + (colorMode || '') + '#' + (sizeMode || '')
  }, [nodes, def, JSON.stringify(overrides), colorMode, sizeMode]) // eslint-disable-line

  const ringRef = useRef(280)   // radius the value hubs sit on (grows with the number of values)
  useEffect(() => {
    const sim = d3.forceSimulation([])
      // Strong hub-hub repulsion + tight leaf→hub links → each value + its leaves forms a SEPARATED cluster.
      // Sub-hubs repel moderately and orbit their parent hub; leaves link to their sub-hub (or hub).
      .force('charge', d3.forceManyBody().strength(d => d.kind === 'leaf' ? -24 : d.kind === 'sub' ? -320 : -1400))
      .force('link', d3.forceLink([]).id(d => d.id).distance(l => l.kind === 'rv' ? ringRef.current : l.kind === 'vs' ? 130 : 52).strength(l => l.kind === 'rv' ? 0.03 : l.kind === 'vs' ? 0.35 : 0.8))
      .force('collide', d3.forceCollide(d => d.r + (d.kind === 'value' ? 10 : d.kind === 'sub' ? 7 : 4)).strength(0.9).iterations(2))
      .force('radial', d3.forceRadial(d => d.kind === 'value' ? ringRef.current : 0, 0, 0).strength(d => d.kind === 'value' ? 0.28 : 0))
      .alphaDecay(0.03).velocityDecay(0.6)
      .on('tick', () => {
        const fns = fnodesRef.current, h = heldRef.current
        const root = fns.find(f => f.kind === 'root'); if (root) { root.x = 0; root.y = 0; root.fx = 0; root.fy = 0 }
        // Hard node separation so leaves never overlap (force alone leaves slow residual overlap).
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < fns.length; i++) { const a = fns[i]; if (a.kind === 'root') continue; for (let j = i + 1; j < fns.length; j++) { const b = fns[j]; if (b.kind === 'root') continue; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 2; if (d < min) { const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d; const af = a.fx != null || h.has(a.id), bf = b.fx != null || h.has(b.id); if (af && !bf) { b.x += ux * push; b.y += uy * push } else if (bf && !af) { a.x -= ux * push; a.y -= uy * push } else if (!af && !bf) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 } } } }
        }
        setTick(t => t + 1)
      })
    simRef.current = sim
    return () => sim.stop()
  }, [])

  useEffect(() => {
    const { values, subs, leaves } = build()
    const prev = new Map((fnodesRef.current || []).map(f => [f.id, f]))
    const root = prev.get('__root__') || { id: '__root__', kind: 'root', x: 0, y: 0, fx: 0, fy: 0 }
    root.r = Math.max(34, Math.min(52, 24 + Math.sqrt(def.name.length) * 5)); root.name = def.name
    // Ring grows with how many value clusters there are, so hubs get room to sit apart.
    ringRef.current = Math.max(300, values.length * 95)
    const vnodes = values.map((v, i) => {
      const id = 'v:' + v.opt; const ex = prev.get(id)
      const ang = (i / Math.max(1, values.length)) * Math.PI * 2
      const base = ex || { id, kind: 'value', x: Math.cos(ang) * ringRef.current, y: Math.sin(ang) * ringRef.current, vx: 0, vy: 0 }
      base.opt = v.opt; base.name = v.name; base.color = v.color; base.r = Math.max(52, Math.min(84, 44 + Math.sqrt(v.name.length) * 4.5))   // ~2x a leaf
      // Restore a hub the user dragged + pinned in a previous session (persisted on the cluster).
      const pin = sys.hubPos?.[v.opt]
      if (pin && base.fx == null) { base.x = pin.x; base.y = pin.y; base.fx = pin.x; base.fy = pin.y }
      return base
    })
    const vById = new Map(vnodes.map(v => [v.opt, v]))
    // Sub-hubs (2nd-level grouping within a hub that has a "group children by" override).
    const snodes = subs.map(s => {
      const ex = prev.get(s.id); const parent = vById.get(s.opt) || root
      const j = (hashStr(s.id) % 80) - 40
      const base = ex || { id: s.id, kind: 'sub', x: parent.x + j, y: parent.y + j, vx: 0, vy: 0 }
      base.opt = s.opt; base.subVal = s.subVal; base.subProp = s.subProp; base.name = s.name; base.color = s.color
      base.r = Math.max(30, Math.min(58, 26 + Math.sqrt((s.name || '').length) * 3.4))
      return base
    })
    const sById = new Map(snodes.map(s => [s.id, s]))
    const lnodes = leaves.map(d => {
      const id = 'l:' + d.nodeId + '@' + d.opt + (d.sub ? '|' + d.sub : ''); const ex = prev.get(id)
      const parent = d.subId ? (sById.get(d.subId) || vById.get(d.opt) || root) : (vById.get(d.opt) || root)
      const j = (hashStr(id) % 40) - 20
      const base = ex || { id, kind: 'leaf', x: parent.x + j, y: parent.y + j, vx: 0, vy: 0 }
      base.opt = d.opt; base.sub = d.sub; base.subId = d.subId; base.subProp = d.subProp; base.nodeId = d.nodeId; base.label = d.label; base.color = d.color
      base.decor = d.decor; base.shape = d.shape; base.baseR = d.baseR; base.r = d.r
      // Restore an item the user free-positioned in Arrange mode (persisted on the cluster).
      const pin = sys.leafPos?.[id]
      if (pin && base.fx == null) { base.x = pin.x; base.y = pin.y; base.fx = pin.x; base.fy = pin.y }
      return base
    })
    const fns = [root, ...vnodes, ...snodes, ...lnodes]
    fnodesRef.current = fns; valuesRef.current = vnodes; subsRef.current = snodes
    const links = [
      ...vnodes.map(v => ({ source: root.id, target: v.id, kind: 'rv' })),
      ...snodes.map(s => ({ source: 'v:' + s.opt, target: s.id, kind: 'vs' })),
      ...lnodes.map(l => ({ source: l.subId || ('v:' + l.opt), target: l.id, kind: 'vl' })),
    ]
    const sm = simRef.current; if (!sm) return
    sm.nodes(fns)
    sm.force('link').links(links)
    sm.alpha(0.8).restart(); setTick(t => t + 1)
  }, [structureKey, colorMode, sizeMode, clusterFilterKey]) // eslint-disable-line

  const setHeldKeys = (s) => { heldRef.current = s; setHeld(s) }
  const local = (ev) => { const p = toWorld(ev); return { x: p.x - sys.x, y: p.y - sys.y } }
  // Which target is the point over? A sub-hub (deeper) wins over its parent hub. Returns a descriptor
  // { kind:'sub', opt, subVal, subProp } | { kind:'value', opt } | null.
  const dropTarget = (p) => {
    let sub = null, sd = Infinity
    subsRef.current.forEach(s => { const d = Math.hypot(p.x - s.x, p.y - s.y); if (d <= s.r + 26 && d < sd) { sd = d; sub = s } })
    if (sub) return { kind: 'sub', opt: sub.opt, subVal: sub.subVal, subProp: sub.subProp }
    let best = null, bd = Infinity
    valuesRef.current.forEach(c => { const d = Math.hypot(p.x - c.x, p.y - c.y); if (d < bd) { bd = d; best = c } })
    if (best && bd <= best.r + 40) return { kind: 'value', opt: best.opt }
    return null
  }

  const startDrag = (e, b) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current; const start = local(e)
    b.fx = b.x; b.fy = b.y; setHeldKeys(new Set([b.id]))   // no global reheat while dragging (avoids motion storm)
    const move = ev => { const p = local(ev); b.fx = p.x; b.fy = p.y; b.x = p.x; b.y = p.y; if (!arrange) setHover(dropTarget(p)); setTick(t => t + 1) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = local(ev); setHeldKeys(new Set()); setHover(null); sim.alphaTarget(0)
      // Arrange mode: pin the item where dropped (persist) instead of retagging.
      if (arrange) { b.fx = p.x; b.fy = p.y; b.x = p.x; b.y = p.y; setTick(t => t + 1); saveLeaves(); return }
      const t = dropTarget(p); b.fx = null; b.fy = null
      const reheat = () => { sim.alphaTarget(0.03).restart(); setTimeout(() => sim.alphaTarget(0), 600) }
      if (Math.hypot(p.x - start.x, p.y - start.y) <= 4) { reheat(); return }
      if (!t) { onRetagMulti(b.nodeId, [{ propId: def.id, value: null, from: b.opt }]); return }
      if (t.kind === 'sub') {
        const assigns = [{ propId: def.id, value: t.opt, from: b.opt }]
        // Set the sub-property; only pass `from` when the source item sub-grouped by the SAME prop.
        assigns.push({ propId: t.subProp, value: t.subVal, from: (b.subProp && b.subProp === t.subProp) ? b.sub : undefined })
        onRetagMulti(b.nodeId, assigns)
      } else if (t.opt !== b.opt) onRetagMulti(b.nodeId, [{ propId: def.id, value: t.opt, from: b.opt }])
      else reheat()
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  // Collect + persist every free-positioned item so an arranged layout survives view-switch/reload.
  const saveLeaves = () => {
    if (!onSaveLeaves) return
    const map = {}; fnodesRef.current.forEach(f => { if (f.kind === 'leaf' && f.fx != null) map[f.id] = { x: f.fx, y: f.fy } })
    onSaveLeaves(map)
  }
  // React to an external "Reset arrangement" (Inspector clears sys.leafPos): unpin all items.
  useEffect(() => {
    if (sys.leafPos && Object.keys(sys.leafPos).length === 0) {
      let changed = false
      fnodesRef.current.forEach(f => { if (f.kind === 'leaf' && f.fx != null) { f.fx = null; f.fy = null; changed = true } })
      if (changed) { simRef.current?.alpha(0.5).restart(); setTick(t => t + 1) }
    }
  }, [JSON.stringify(sys.leafPos || {})]) // eslint-disable-line
  // Collect + persist every pinned hub's position so a dragged layout survives view-switch/reload.
  const saveHubs = () => {
    if (!onSaveHubs) return
    const map = {}; valuesRef.current.forEach(h => { if (h.fx != null) map[h.opt] = { x: h.fx, y: h.fy } })
    onSaveHubs(map)
  }
  // Drag a value hub (parent) → it stays pinned where dropped; its leaves follow via the link force.
  const startValueDrag = (e, v) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current
    v.fx = v.x; v.fy = v.y; sim.alphaTarget(0.15).restart()
    const move = ev => { const p = local(ev); v.fx = p.x; v.fy = p.y; v.x = p.x; v.y = p.y; setTick(t => t + 1) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); sim.alphaTarget(0); saveHubs() }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const startHeadDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = sys.x - p0.x, oy = sys.y - p0.y; let moved = false
    const move = ev => { const p = toWorld(ev); if (Math.hypot(p.x - p0.x, p.y - p0.y) > 3) moved = true; onMove(sys.id, p.x + ox, p.y + oy) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (moved) onCommitMove(); else onSelect && onSelect() }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const fns = fnodesRef.current, values = valuesRef.current, subs = subsRef.current
  const root = fns.find(f => f.kind === 'root')
  const leaves = fns.filter(f => f.kind === 'leaf')
  const dragging = held.size > 0
  const minY = fns.reduce((m, f) => Math.min(m, f.y - f.r), 0)
  const headY = minY - 44
  const countByOpt = {}; leaves.forEach(l => { countByOpt[l.opt] = (countByOpt[l.opt] || 0) + 1 })
  const countBySub = {}; leaves.forEach(l => { if (l.subId) countBySub[l.subId] = (countBySub[l.subId] || 0) + 1 })
  const clusterBBox = () => {
    if (!fns.length) return { x0: sys.x - 200, y0: sys.y - 200, x1: sys.x + 200, y1: sys.y + 200 }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    fns.forEach(f => { x0 = Math.min(x0, f.x - f.r); y0 = Math.min(y0, f.y - f.r); x1 = Math.max(x1, f.x + f.r); y1 = Math.max(y1, f.y + f.r) })
    return { x0: sys.x + x0, y0: sys.y + y0 - 44, x1: sys.x + x1, y1: sys.y + y1 }
  }

  return (
    <g transform={`translate(${sys.x},${sys.y})`}>
      <ClusterHeader def={def} kind="tree" cx={0} y={headY} zoomK={zoomK} hasFilter={hasFilter} selected={selected} onHead={startHeadDrag} onDrill={() => onDrill && onDrill(clusterBBox())} onRemove={onRemove} />
      {/* links: root→value, value→sub-hub, then sub-hub|value→leaf */}
      <g pointerEvents="none">
        {root && values.map(v => (
          <line key={'e' + v.id} x1={root.x} y1={root.y} x2={v.x} y2={v.y} stroke={v.color} strokeOpacity={0.5} strokeWidth={2} />
        ))}
        {subs.map(s => { const v = values.find(x => x.opt === s.opt); if (!v) return null
          return <line key={'es' + s.id} x1={v.x} y1={v.y} x2={s.x} y2={s.y} stroke={s.color} strokeOpacity={0.45} strokeWidth={1.8} strokeDasharray="4 3" /> })}
        {leaves.map(l => { const parent = l.subId ? subs.find(s => s.id === l.subId) : values.find(x => x.opt === l.opt); if (!parent) return null
          return <line key={'e' + l.id} x1={parent.x} y1={parent.y} x2={l.x} y2={l.y} stroke={l.color} strokeOpacity={0.28} strokeWidth={1.4} /> })}
      </g>
      {/* root */}
      {root && (() => {
        const rf = zfont(14, zoomK, 11, 22)   // clamp to screen px
        return <g pointerEvents="none" transform={`translate(${root.x},${root.y})`}>
          <circle r={root.r} fill="#141428" stroke="#7c8cff" strokeWidth={2.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={rf} fontWeight={800} fill="#c5d0ff"
            style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 4, strokeLinejoin: 'round' }}>
            {wrapText(root.name, 9).slice(0, 3).map((ln, i, a) => <tspan key={i} x={0} y={(i - (a.length - 1) / 2) * (rf * 1.08)}>{ln}</tspan>)}
          </text>
        </g>
      })()}
      {/* value nodes (1st generation) */}
      {values.map(v => {
        const isT = dragging && hover?.kind === 'value' && hover.opt === v.opt
        const vf = zfont(16, zoomK, 12, 24)   // clamp to screen px so it stays legible when zoomed out
        const overridden = overrides[v.opt] !== undefined && overrides[v.opt] !== ''
        return (
          <g key={v.id} data-bubble="1" transform={`translate(${v.x},${v.y})`} style={{ cursor: 'grab' }}
            onMouseDown={e => startValueDrag(e, v)}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setVmenu({ opt: v.opt }) }}>
            <circle r={v.r} fill={v.color + '2a'} stroke={isT ? '#7fd8a8' : v.color} strokeWidth={isT ? 4 : 3} strokeDasharray={overridden ? '7 5' : undefined} />
            <text textAnchor="middle" dominantBaseline="middle" fontSize={vf} fontWeight={800} fill={isT ? '#7fd8a8' : '#e8eeff'} pointerEvents="none"
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 4, strokeLinejoin: 'round' }}>
              {wrapText(v.name, 11).slice(0, 3).map((ln, i, a) => <tspan key={i} x={0} y={(i - (a.length - 1) / 2) * (vf * 1.05) - vf * 0.5}>{ln}</tspan>)}
              <tspan x={0} y={vf * 1.4} fontSize={vf * 0.75} fillOpacity={0.85}>· {countByOpt[v.opt] || 0}</tspan>
            </text>
          </g>
        )
      })}
      {/* sub-hubs (per-hub "group children by" override) */}
      {subs.map(s => {
        const isT = dragging && hover?.kind === 'sub' && hover.opt === s.opt && hover.subVal === s.subVal
        const sf = zfont(13, zoomK, 10, 20)   // clamp to screen px
        return (
          <g key={s.id} pointerEvents="none" transform={`translate(${s.x},${s.y})`}>
            <circle r={s.r} fill={(s.color || '#5b6af0') + '22'} stroke={isT ? '#7fd8a8' : (s.color || '#5b6af0')} strokeWidth={isT ? 3.5 : 2} strokeDasharray="4 3" />
            <text textAnchor="middle" dominantBaseline="middle" fontSize={sf} fontWeight={800} fill={isT ? '#7fd8a8' : '#dbe4ff'} pointerEvents="none"
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 3.5, strokeLinejoin: 'round' }}>
              {wrapText(s.name, 10).slice(0, 2).map((ln, i, a) => <tspan key={i} x={0} y={(i - (a.length - 1) / 2) * (sf * 1.05) - sf * 0.4}>{ln}</tspan>)}
              <tspan x={0} y={sf * 1.3} fontSize={sf * 0.72} fillOpacity={0.85}>· {countBySub[s.id] || 0}</tspan>
            </text>
          </g>
        )
      })}
      {/* item leaves (2nd generation) — real graph nodes with their cosmetics; draggable to retag */}
      {leaves.map(l => <LeafNode key={l.id} b={l} held={held.has(l.id)} lens={lens} ox={sys.x} oy={sys.y} onDown={e => startDrag(e, l)}
        onContext={e => { e.preventDefault(); e.stopPropagation(); onEditNode && onEditNode(l.nodeId) }}
        onDbl={e => { e.stopPropagation(); onEditNode && onEditNode(l.nodeId) }} />)}
      {/* value-hub context menu — rendered LAST so it paints on top of every node */}
      {vmenu && (() => {
        const v = valuesRef.current.find(x => x.opt === vmenu.opt); if (!v) return null
        const curOv = overrides[v.opt]
        const subOpts = propertyDefs.filter(d => (d.type === 'select' || d.type === 'multiSelect' || d.type === 'date') && d.id !== def.id)
        return (
          <foreignObject x={v.x + v.r + 6} y={v.y - 40} width={230} height={400} style={{ overflow: 'visible' }}>
            <div style={{ transform: `scale(${1 / (zoomK || 1)})`, transformOrigin: 'top left' }}>
              <div ref={vmenuElRef} style={vmStyles.menu} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
                <div style={vmStyles.head}>{v.name}</div>
                <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); setVmenu(null); onAddNode && onAddNode([{ propId: def.id, value: v.opt }]) }}>+ New item in this value</div>
                <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); const ids = fnodesRef.current.filter(f => f.kind === 'leaf' && f.opt === v.opt).map(f => f.nodeId); setVmenu(null); if (ids.length && onHideNodes) onHideNodes([...new Set(ids)]) }}>Hide these items on the board</div>
                {v.fx != null && <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); v.fx = null; v.fy = null; setVmenu(null); simRef.current.alpha(0.3).restart(); saveHubs() }}>Unpin (let it float)</div>}
                <div style={{ borderTop: '1px solid #23233e', margin: '4px 6px' }} />
                <div style={{ ...vmStyles.head, borderBottom: 'none', paddingBottom: 2 }}>Group children by</div>
                <div style={{ ...vmStyles.item, color: !curOv ? '#8ecbff' : '#c5d0ff' }} onMouseDown={e => { e.stopPropagation(); setVmenu(null); onSetGroupOverride && onSetGroupOverride(v.opt, undefined) }}>None (flat)</div>
                {subOpts.map(d => (
                  <div key={d.id} style={{ ...vmStyles.item, color: curOv === d.id ? '#8ecbff' : '#c5d0ff' }}
                    onMouseDown={e => { e.stopPropagation(); setVmenu(null); onSetGroupOverride && onSetGroupOverride(v.opt, d.id) }}>{d.name}{d.type === 'date' ? ' (due)' : ''}</div>
                ))}
                <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); setVmenu(null) }}>Close</div>
              </div>
            </div>
          </foreignObject>
        )
      })()}
      {selected && cfgBar && <ClusterConfigBar sys={sys} x={-150} y={headY + 22} zoomK={zoomK} propertyDefs={propertyDefs} {...cfgBar} />}
    </g>
  )
}

// Deterministic circle pack (d3.pack — guarantees NO overlap and minimal enclosing size, unlike a
// force sim). One grouping level: packs = groupDefs[0] values → item leaves. Two levels: outer packs
// = groupDefs[0], inner sub-packs = groupDefs[1] → leaves. Drag-to-retag: dropping a leaf on a
// sub-pack sets both (a,b); on an outer pack sets a; on empty space clears the outer value.
const NP_D = 1000
function NestedPackCluster({ sys, groupDefs, colorMode, sizeMode, propertyDefs, decorOf, nodes, toWorld, zoomK, lens, filterFn, clusterFilterKey, hasFilter, groupValsOf, selected, cfgBar, onSelect, onEditNode, onDrill, onRetagMulti, onSetGroupOverride, onAddNode, onMove, onCommitMove, onRemove }) {
  const [, setTick] = useState(0)
  const [drag, setDrag] = useState(null)   // { id, x, y } in pack-local coords while dragging a leaf
  const [pmenu, setPmenu] = useState(null)  // "group children by" menu on an outer pack: { opt, x, y }
  const pmenuElRef = useRef(null)
  const leafSimRef = useRef(null)   // force sim that scatters leaves organically inside their group circle
  useEffect(() => {
    if (!pmenu) return
    const close = (e) => { if (pmenuElRef.current && pmenuElRef.current.contains(e.target)) return; setPmenu(null) }
    document.addEventListener('mousedown', close, true)
    return () => document.removeEventListener('mousedown', close, true)
  }, [pmenu])
  const [defA, defB] = groupDefs
  const overrides = sys.groupOverrides || {}
  // Resolve the inner (sub-group) def for an outer value: '' = none, a propId = that property
  // (date-wrapped), absent = inherit the cluster default (defB). null tells the builder "no sub-group".
  const resolveDef = (id) => { const d = propertyDefs.find(x => x.id === id); return d ? (d.type === 'date' ? dueDefFor(d) : d) : null }
  const innerDefOf = (a) => { const ov = overrides[a]; if (ov === undefined) return undefined; if (ov === '' || ov == null) return null; return resolveDef(ov) }
  const structureKey = useMemo(() =>
    nodes.map(n => n.id + JSON.stringify([n.props?.[defA.id], defB ? n.props?.[defB.id] : null]) + ':' + (n.label || '')).join(';')
    + '#' + groupDefs.map(d => d.id + ':' + (d.options || []).length).join('|') + '#' + clusterFilterKey + '#' + (colorMode || '') + '#' + (sizeMode || '') + '#' + JSON.stringify(overrides),
    [nodes, defA, defB, clusterFilterKey, colorMode, sizeMode, JSON.stringify(overrides)]) // eslint-disable-line
  const root = useMemo(() => {
    const fnodes = nodes.filter(n => !filterFn || filterFn(n))
    const numDomain = (sizeMode && sizeMode !== 'style') ? domainOf(fnodes, sizeMode) : null
    // Any per-group override means heterogeneous inner grouping → pass the resolver.
    const anyOverride = Object.keys(overrides).length > 0
    const tree = buildNestedTagTree(fnodes, defA, defB, { decorOf, sizeBy: (sizeMode && sizeMode !== 'style') ? sizeMode : undefined, valsOf: groupValsOf, innerDefOf: anyOverride ? innerDefOf : undefined })
    const h = d3.hierarchy(tree).sum(d => d.value || 1).sort((a, b) => (b.value || 0) - (a.value || 0))
    const nested = !!(defB || Object.keys(overrides).length)
    // Big gaps BETWEEN groups (so each reads as a distinct cluster), tighter inside. Uniform packs stay compact.
    d3.pack().size([NP_D, NP_D]).padding(d => nested ? (d.depth === 0 ? 46 : d.depth === 1 ? 12 : 5) : 6)(h)
    void numDomain
    return h
  }, [structureKey]) // eslint-disable-line

  // Organic leaf layout: d3.pack gives non-overlapping GROUP circles + each leaf a target position;
  // this force sim then scatters the leaves inside their group (collide + pull-to-target + containment)
  // so they read as an organic cluster, not a grid — while the groups themselves never overlap.
  useEffect(() => {
    const sim = d3.forceSimulation([]).alphaDecay(0.04).velocityDecay(0.62)
      .on('tick', () => {
        const ls = leafSimRef.current?.nodes() || []
        for (const l of ls) {   // keep each leaf inside its parent group circle
          const par = l.parent; if (!par) continue
          const dx = l.x - par.x, dy = l.y - par.y, d = Math.hypot(dx, dy)
          const max = Math.max(0, par.r - (l.r || 6) - 1)
          if (d > max) { const dd = d || 1; l.x = par.x + dx / dd * max; l.y = par.y + dy / dd * max; l.vx *= 0.5; l.vy *= 0.5 }
        }
        setTick(t => t + 1)
      })
    leafSimRef.current = sim
    return () => sim.stop()
  }, [])
  // Which groups are collapsed to a summary bubble at the current zoom (same rule as the render).
  // A stable string so the leaf sim only re-seeds when a group actually crosses the threshold, not on
  // every zoom tick.
  const collapsedKey = useMemo(() => {
    const ids = []
    root.descendants().forEach(d => {
      if (d.children && d.children.length > 12 && d.children.every(c => !c.children) && (d.children[0].r * (zoomK || 1)) < 15) ids.push(d.data.id)
    })
    return ids.sort().join(',')
  }, [root, zoomK])
  useEffect(() => {
    const sim = leafSimRef.current; if (!sim) return
    // Only scatter the leaves actually SHOWN (their group isn't collapsed). This is what lets a
    // 1000-item cluster be organic when you zoom into a group, without simulating all 1000 at once.
    const coll = new Set(collapsedKey ? collapsedKey.split(',') : [])
    const leaves = root.leaves().filter(l => l.data.id.includes('@') && !coll.has(l.parent?.data.id))
    if (!leaves.length || leaves.length > 400) { sim.nodes([]); sim.stop(); return }
    leaves.forEach(l => { if (l.tx == null) { l.tx = l.x; l.ty = l.y } })   // remember pack target
    sim.nodes(leaves)
    sim.force('x', d3.forceX(d => d.tx).strength(0.09))
    sim.force('y', d3.forceY(d => d.ty).strength(0.09))
    sim.force('collide', d3.forceCollide(d => (d.r || 6) + 1).strength(0.9).iterations(2))
    sim.alpha(0.9).restart()
  }, [root, collapsedKey])

  const off = NP_D / 2
  const local = (ev) => { const p = toWorld(ev); return { x: p.x - (sys.x - off), y: p.y - (sys.y - off) } }
  const startHeadDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = sys.x - p0.x, oy = sys.y - p0.y; let moved = false
    const move = ev => { const p = toWorld(ev); if (Math.hypot(p.x - p0.x, p.y - p0.y) > 3) moved = true; onMove(sys.id, p.x + ox, p.y + oy) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (moved) onCommitMove(); else onSelect && onSelect() }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const dropTargetAt = (p) => {   // deepest group circle the point is inside (sub-pack beats pack)
    let bHit = null, aHit = null
    root.descendants().forEach(d => {
      if (d.depth === 2 && d.children && Math.hypot(p.x - d.x, p.y - d.y) <= d.r) bHit = d
      else if (d.depth === 1 && Math.hypot(p.x - d.x, p.y - d.y) <= d.r) aHit = d
    })
    return bHit || aHit || null
  }
  const startLeafDrag = (e, leaf) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = leafSimRef.current
    const start = local(e); setDrag({ id: leaf.data.id, x: leaf.x, y: leaf.y })
    if (sim) { leaf.fx = leaf.x; leaf.fy = leaf.y; sim.alphaTarget(0.25).restart() }   // pin it; let neighbors give way
    const move = ev => { const p = local(ev); if (sim) { leaf.fx = p.x; leaf.fy = p.y } setDrag({ id: leaf.data.id, x: p.x, y: p.y }) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = local(ev); setDrag(null)
      if (sim) { leaf.fx = null; leaf.fy = null; sim.alphaTarget(0) }
      if (Math.hypot(p.x - start.x, p.y - start.y) < 4) return
      const nodeId = leaf.data.id.split('@')[0]
      // Source group values the leaf was dragged out of (from its ancestor circles) — so a multiSelect
      // move removes only that membership, not the node's other tags.
      const anc = leaf.ancestors()
      const srcA = (/^a:([^|]*)/.exec(anc.find(x => x.depth === 1)?.data.id || '') || [])[1]
      const srcInner = innerDefOf(srcA); const srcInnerDef = srcInner === undefined ? defB : srcInner
      const srcB = srcInnerDef ? (/\|b:(.*)$/.exec(anc.find(x => x.depth === 2)?.data.id || '') || [])[1] : undefined
      const tgt = dropTargetAt(p)
      if (!tgt) { onRetagMulti(nodeId, [{ propId: defA.id, value: null, from: srcA }]); return }
      if (tgt.depth === 2) {
        const m = /^a:(.*)\|b:(.*)$/.exec(tgt.data.id) || []
        const tgtInner = innerDefOf(m[1]); const tgtInnerDef = tgtInner === undefined ? defB : tgtInner
        const assigns = [{ propId: defA.id, value: m[1], from: srcA }]
        // Only pass `from` for the inner prop when source & target sub-group by the SAME property.
        if (tgtInnerDef) assigns.push({ propId: tgtInnerDef.id, value: m[2], from: (srcInnerDef && srcInnerDef.id === tgtInnerDef.id) ? srcB : undefined })
        onRetagMulti(nodeId, assigns)
      } else { const m = /^a:(.*)$/.exec(tgt.data.id) || []; onRetagMulti(nodeId, [{ propId: defA.id, value: m[1], from: srcA }]) }
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const nodes_ = root.descendants()
  const aNodes = nodes_.filter(d => d.depth === 1)
  const bNodes = nodes_.filter(d => d.depth === 2 && d.children)   // sub-packs (depth-2 groups)
  // Aggregate: a big group whose items would be tiny on screen renders as ONE summary bubble (count in
  // its label) instead of hundreds of dots. Items reveal as you zoom in (rep item ≥ ~10px). This is
  // what makes a 500-item group legible instead of a blob of dots.
  const collapsed = new Set()
  nodes_.forEach(d => {
    if (d.children && d.children.length > 12 && d.children.every(c => !c.children)) {
      if ((d.children[0].r * (zoomK || 1)) < 15) collapsed.add(d)
    }
  })
  const leaves = nodes_.filter(d => !d.children && d.data.id.includes('@') && !collapsed.has(d.parent))
  const dropHit = drag ? dropTargetAt(drag) : null
  // Glide circles to their new packed spots after a retag instead of snapping. Off during a drag
  // (dragged item must track the cursor) and while the lens is active (it must follow instantly).
  const smooth = !drag && !lens
  const trans = smooth ? { transition: 'transform 0.35s ease' } : undefined
  const circTrans = smooth ? { transition: 'r 0.35s ease' } : undefined
  const headY = -20
  const oxN = sys.x - off, oyN = sys.y - off
  const clusterBBox = () => {
    if (!aNodes.length) return { x0: sys.x - off, y0: sys.y - off, x1: sys.x + off, y1: sys.y + off }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    aNodes.forEach(a => { x0 = Math.min(x0, a.x - a.r); y0 = Math.min(y0, a.y - a.r); x1 = Math.max(x1, a.x + a.r); y1 = Math.max(y1, a.y + a.r) })
    return { x0: oxN + x0, y0: oyN + y0 - 24, x1: oxN + x1, y1: oyN + y1 }
  }

  return (
    <g transform={`translate(${oxN},${oyN})`}>
      <ClusterHeader def={{ name: groupDefs.map(d => d.name).join(' › ') }} kind="pack" cx={off} y={headY} zoomK={zoomK} hasFilter={hasFilter} selected={selected} onHead={startHeadDrag} onDrill={() => onDrill && onDrill(clusterBBox())} onRemove={onRemove} />
      {aNodes.map(a => {
        // A group with sub-packs (its children are groups) is a dashed CONTAINER; a group whose
        // children are leaves is a filled PACK. The "⋯" opens its "group children by" menu.
        const hasSub = !!(a.children && a.children.some(c => c.children))
        const isT = dropHit === a
        const zf = zfont(16, zoomK, 12, 30), count = a.leaves().length
        const col = a.data.color || '#5b6af0'
        const gearFs = zfont(15, zoomK, 12, 26)
        const overridden = overrides[a.data.id.slice(2)] !== undefined
        return (
          <g key={a.data.id} transform={`translate(${a.x},${a.y})`} style={trans}>
            {hasSub
              ? <circle r={a.r} fill="none" stroke={col + '99'} strokeWidth={2} strokeDasharray="6 5" pointerEvents="none" style={circTrans} />
              : <circle r={a.r} fill={col + (collapsed.has(a) ? '4d' : '1e')} stroke={isT ? '#7fd8a8' : col} strokeWidth={isT ? 3.5 : 2} pointerEvents="none" style={circTrans} />}
            <text x={0} y={-a.r - zf * 0.4} textAnchor="middle" fontSize={zf} fontWeight={800} fill={isT ? '#7fd8a8' : (a.data.color || '#c5d0ff')} pointerEvents="none"
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: zf * 0.29, strokeLinejoin: 'round' }}>{a.data.label} · {count}</text>
            {/* ⋯ button: choose how THIS group sub-groups its children (overrides the cluster). */}
            <text x={a.r - gearFs * 0.7} y={-a.r + gearFs} textAnchor="middle" fontSize={gearFs} fill={overridden ? '#8ecbff' : '#7080a0'}
              style={{ cursor: 'pointer', paintOrder: 'stroke', stroke: '#05060f', strokeWidth: gearFs * 0.28, strokeLinejoin: 'round' }}
              onMouseDown={e => { e.stopPropagation(); setPmenu({ opt: a.data.id.slice(2), x: a.x, y: a.y - a.r }) }}>⋯</text>
          </g>
        )
      })}
      {bNodes.map(b => {
        const isT = dropHit === b
        const bCol = b.data.color || '#5b6af0', bColl = collapsed.has(b)
        return (
          <g key={b.data.id} pointerEvents="none" transform={`translate(${b.x},${b.y})`} style={trans}>
            <circle r={b.r} fill={bCol + (bColl ? '4d' : '1e')} stroke={isT ? '#7fd8a8' : bCol} strokeWidth={isT ? 3.5 : 1.8} style={circTrans} />
            {b.r * zoomK > 16 && (
              <text x={0} y={-b.r - 3} textAnchor="middle" fontSize={zfont(12, zoomK, 10, 22)} fontWeight={700} fill={isT ? '#7fd8a8' : '#c5d0ff'}
                style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 4, strokeLinejoin: 'round' }}>{b.data.label} · {b.leaves().length}</text>
            )}
          </g>
        )
      })}
      {leaves.map(l => {
        const nodeId = l.data.id.split('@')[0]
        const node = nodes.find(n => n.id === nodeId)
        const dec = l.data
        const bColor = l.parent?.data?.color || '#6b7394'
        const isDrag = drag?.id === l.data.id
        const lx = isDrag ? drag.x : l.x, ly = isDrag ? drag.y : l.y
        // Fisheye magnifier: displace + scale near the lens focus (no lens while dragging → identity).
        const world = (lens && !isDrag) ? lens(oxN + lx, oyN + ly) : null
        const x = world ? world.x - oxN : lx, y = world ? world.y - oyN : ly, z = world ? world.z : 1
        const shape = dec.shape || 'circle'
        const baseR = Math.max(6, l.r - 2) * z
        const color = resolveColor(colorMode, node, dec, bColor, propertyDefs)
        const handlers = {
          onMouseDown: e => startLeafDrag(e, l),
          onContextMenu: e => { e.preventDefault(); e.stopPropagation(); onEditNode && onEditNode(nodeId) },
          onDoubleClick: e => { e.stopPropagation(); onEditNode && onEditNode(nodeId) },
        }
        // Label whenever an item is actually shown (dense groups already collapsed to a summary bubble
        // above, so there's no mush risk) — this matches the tree, where every visible leaf is labeled.
        // Only the smallest slivers stay as bare dots.
        if (baseR * zoomK < 13) {
          return <g key={l.data.id} transform={`translate(${x},${y})`} style={{ cursor: 'grab', ...(smooth && !isDrag ? { transition: 'transform 0.35s ease' } : {}) }} {...handlers}>
            <circle r={baseR} fill={color} fillOpacity={0.96} stroke={isDrag ? '#fff' : 'rgba(232,238,255,0.35)'} strokeWidth={isDrag ? 3 : 1} />
          </g>
        }
        const b = { x, y, label: dec.label, color, decor: dec, shape, baseR, r: baseR }
        return <LeafNode key={l.data.id} b={b} held={isDrag} smooth={smooth && !isDrag} onDown={handlers.onMouseDown} onContext={handlers.onContextMenu} onDbl={handlers.onDoubleClick} />
      })}
      {/* per-group menu: add an item into this group + choose how it sub-groups its children */}
      {pmenu && (() => {
        const a = aNodes.find(x => x.data.id.slice(2) === pmenu.opt)
        const cur = overrides[pmenu.opt]
        const subOpts = propertyDefs.filter(d => (d.type === 'select' || d.type === 'multiSelect' || d.type === 'date') && d.id !== defA.id)
        return (
          <foreignObject x={pmenu.x} y={pmenu.y} width={260} height={380} style={{ overflow: 'visible' }}>
            <div style={{ transform: `scale(${1 / (zoomK || 1)})`, transformOrigin: 'top left' }}>
              <div ref={pmenuElRef} style={vmStyles.menu} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
                <div style={vmStyles.head}>{a?.data.label || 'Group'}</div>
                <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); setPmenu(null); onAddNode && onAddNode([{ propId: defA.id, value: pmenu.opt }]) }}>+ New item in this group</div>
                <div style={{ borderTop: '1px solid #23233e', margin: '4px 6px' }} />
                <div style={{ ...vmStyles.head, borderBottom: 'none', paddingBottom: 2 }}>Group children by</div>
                <div style={{ ...vmStyles.item, color: cur === undefined ? '#8ecbff' : '#c5d0ff' }} onMouseDown={e => { e.stopPropagation(); setPmenu(null); onSetGroupOverride && onSetGroupOverride(pmenu.opt, undefined) }}>Inherit from cluster{defB ? ` · ${defB.name}` : ' · none'}</div>
                <div style={{ ...vmStyles.item, color: cur === '' ? '#8ecbff' : '#c5d0ff' }} onMouseDown={e => { e.stopPropagation(); setPmenu(null); onSetGroupOverride && onSetGroupOverride(pmenu.opt, '') }}>None (flat)</div>
                {subOpts.map(d => (
                  <div key={d.id} style={{ ...vmStyles.item, color: cur === d.id ? '#8ecbff' : '#c5d0ff' }}
                    onMouseDown={e => { e.stopPropagation(); setPmenu(null); onSetGroupOverride && onSetGroupOverride(pmenu.opt, d.id) }}>{d.name}{d.type === 'date' ? ' (due)' : ''}</div>
                ))}
                <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); setPmenu(null) }}>Close</div>
              </div>
            </div>
          </foreignObject>
        )
      })()}
      {selected && cfgBar && <ClusterConfigBar sys={sys} x={off - 150} y={headY + 22} zoomK={zoomK} propertyDefs={propertyDefs} {...cfgBar} />}
    </g>
  )
}

// Shared draggable header chip for a cluster.
function ClusterHeader({ def, kind, cx, y, zoomK, hasFilter, selected, onHead, onDrill, onRemove }) {
  const glyph = kind === 'tree' ? '⌥' : '◎'
  // Counter-scale the whole chip so it stays ~constant on screen, clamped to a min/max, at any zoom.
  const s = zfont(15, zoomK, 11, 26) / 15
  return (
    <g data-syshead="1" transform={`translate(${cx},${y}) scale(${s})`} style={{ cursor: 'grab' }} onMouseDown={onHead}
      onDoubleClick={e => { e.stopPropagation(); onDrill && onDrill() }} title="Double-click to zoom in">
      <rect x={-118} y={-16} width={236} height={30} rx={7} fill={selected ? '#1b2350' : '#141428'} stroke={selected ? '#5b6af0' : '#2d3a6a'} strokeWidth={selected ? 2 : 1} />
      <text x={-104} y={4} fontSize={13} fill="#8ab4ff">{glyph}</text>
      <text x={-86} y={4} fontSize={15} fontWeight={700} fill="#c5d0ff">{def.name}</text>
      {hasFilter && <circle cx={82} cy={0} r={3.4} fill="#8ecbff" />}
      <text x={100} y={5} fontSize={16} fill="#f87171" textAnchor="middle" style={{ cursor: 'pointer' }}
        onMouseDown={e => { e.stopPropagation(); if (confirm(`Remove the “${def.name}” ${kind === 'tree' ? 'tree' : 'circle pack'}?`)) onRemove() }}>×</text>
    </g>
  )
}

// strokeDash → SVG dasharray (mirrors the graph's dashArray).
function dashArrayB(dash, sw = 1.4) {
  if (dash === 'dashed') return `${Math.max(3, sw * 2.6)},${Math.max(2, sw * 1.8)}`
  if (dash === 'dotted') return `${Math.max(0.4, sw * 0.55)},${Math.max(2, sw * 1.9)}`
  return undefined
}

// A free node — a real graph node placed directly on the board canvas (not in any cluster). Drag to
// reposition (persisted per view); right-click / double-click to edit. Renders with the node's own
// graph-view cosmetics via LeafNode. `pos` is world coords; drag stays local until drop.
function FreeNode({ node, pos, decor, lens, toWorld, onDragEnd, onEdit, onNavigate, onConnect }) {
  const [drag, setDrag] = useState(null)
  const x = drag ? drag.x : (pos?.x || 0), y = drag ? drag.y : (pos?.y || 0)
  const dec = decor || {}
  const label = node.label || '(untitled)'
  const scl = Math.min(2, Math.max(0.6, dec.scale || 1))
  const baseR = 34 * scl
  const shape = dec.shape || 'circle'
  const bound = freeNodeRadius(dec)
  const color = dec.fill || '#6b7394'
  const startDrag = (e) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = x - p0.x, oy = y - p0.y; let moved = false
    const move = ev => { const p = toWorld(ev); if (Math.hypot(p.x - p0.x, p.y - p0.y) > 3) moved = true; setDrag({ x: p.x + ox, y: p.y + oy }) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = toWorld(ev)
      if (moved) onDragEnd(node.id, p.x + ox, p.y + oy)
      setDrag(null)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const b = { x, y, label, color, decor: dec, shape, baseR, r: bound }
  const linked = !!node.linkTo?.projectId
  return <LeafNode b={b} held={!!drag} lens={lens} smooth={false} onDown={startDrag}
    onContext={e => { e.preventDefault(); e.stopPropagation(); onEdit(node.id) }}
    onDbl={e => { e.stopPropagation(); onEdit(node.id) }}
    onBadge={linked ? onNavigate : null} onConnect={onConnect} />
}

// A tree leaf = a real graph node rendered with its graph-view cosmetics (fill/shape/stroke/dash/emoji).
function LeafNode({ b, held, lens, ox = 0, oy = 0, smooth, onDown, onContext, onDbl, onBadge, onConnect }) {
  const dec = b.decor || {}
  const shape = b.shape || 'circle'
  const disp = lens ? lens(ox + (b.x || 0), oy + (b.y || 0)) : null
  const dx = disp ? disp.x - ox : (b.x || 0), dy = disp ? disp.y - oy : (b.y || 0), z = disp ? disp.z : 1
  const s = (b.baseR || b.r) * z
  const fill = b.color
  const light = hexLum(fill) > 0.55
  const stroke = held ? '#fff' : (dec.stroke || 'rgba(232,238,255,0.4)')
  const sw = held ? 3 : (dec.strokeWidth || 1.2)
  const dash = held ? undefined : dashArrayB(dec.strokeDash, sw)
  const tf = dec.textColor || (light ? '#0c0c1a' : '#f2f5ff')
  const emoji = typeof dec.emoji === 'string' ? dec.emoji : null
  const fs = Math.max(8, s * 0.32), maxChars = Math.max(5, Math.floor((1.7 * s) / (fs * 0.56)))
  const lines = wrapText(b.label, maxChars).slice(0, 4), lh = fs * 1.05
  const yStart = (emoji ? fs * 0.5 : 0) - (lines.length - 1) / 2 * lh
  let body
  if (shape === 'ellipse') body = <ellipse rx={s * 1.35} ry={s * 0.82} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
  else if (shape === 'roundrect') { const hw = s * 1.3, hh = s * 0.82; body = <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} rx={hh * 0.45} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} /> }
  else if (shape === 'rect') { const hw = s * 1.3, hh = s * 0.82; body = <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} /> }
  else if (shape === 'diamond') body = <polygon points={`0,${-s * 1.15} ${s * 1.15},0 0,${s * 1.15} ${-s * 1.15},0`} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
  else body = <circle r={s} fill={fill} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
  return (
    <g data-bubble="1" transform={`translate(${dx},${dy})`} style={{ cursor: 'grab', ...(smooth ? { transition: 'transform 0.35s ease' } : {}) }} onMouseDown={onDown} onContextMenu={onContext} onDoubleClick={onDbl}>
      {body}
      {emoji && <text textAnchor="middle" dominantBaseline="middle" fontSize={s * 0.7} y={-s * 0.42} pointerEvents="none">{emoji}</text>}
      <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={tf} pointerEvents="none"
        style={{ fontWeight: 400, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
        {lines.map((ln, i) => <tspan key={i} x={0} y={yStart + i * lh}>{ln}</tspan>)}
      </text>
      {onBadge && (() => { const br = Math.max(8, s * 0.3)
        return (
          <g transform={`translate(${s * 0.72},${-s * 0.72})`} style={{ cursor: 'pointer' }}
            onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onBadge() }}>
            <title>Open linked project</title>
            <circle r={br} fill="#1a1f4a" stroke="#7c8cff" strokeWidth={1.4} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={br * 1.25} fill="#a9b4ff" pointerEvents="none">↗</text>
          </g>
        )
      })()}
      {onConnect && (() => { const cr = Math.max(5, s * 0.2)
        return (
          <g transform={`translate(${s + cr * 0.6},0)`} style={{ cursor: 'crosshair' }}
            onMouseDown={e => { e.stopPropagation(); onConnect(e) }}>
            <title>Drag to another node to connect</title>
            <circle r={cr} fill="#5b6af0" stroke="#0c0c1a" strokeWidth={1.2} />
          </g>
        )
      })()}
    </g>
  )
}

// A draggable item bubble (used by both pack and tree clusters). `lens` (world coords, offset by
// ox/oy) applies the fisheye magnifier: displaces the bubble outward and scales its radius by z.
function Bubble({ b, held, lens, ox = 0, oy = 0, onDown, onContext, onDbl }) {
  const light = hexLum(b.color) > 0.55, tf = light ? '#0c0c1a' : '#f2f5ff'
  const disp = lens ? lens(ox + (b.x || 0), oy + (b.y || 0)) : null
  const dx = disp ? disp.x - ox : (b.x || 0), dy = disp ? disp.y - oy : (b.y || 0), z = disp ? disp.z : 1
  const r = b.r * z
  const fs = Math.max(8, r * 0.3), maxChars = Math.max(5, Math.floor((1.7 * r) / (fs * 0.56)))
  const lines = wrapText(b.label, maxChars).slice(0, 5), lh = fs * 1.05, y0 = -(lines.length - 1) / 2 * lh
  return (
    <g data-bubble="1" transform={`translate(${dx},${dy})`} style={{ cursor: 'grab' }} onMouseDown={onDown} onContextMenu={onContext} onDoubleClick={onDbl}>
      <circle r={r} fill={b.color} fillOpacity={0.96} stroke={held ? '#fff' : 'rgba(232,238,255,0.4)'} strokeWidth={held ? 3.5 : 1.2} />
      <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={tf} pointerEvents="none"
        style={{ fontWeight: 400, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
        {lines.map((ln, i) => <tspan key={i} x={0} y={y0 + i * lh}>{ln}</tspan>)}
      </text>
    </g>
  )
}

// Drag-to-reorder list of grouping properties (nesting order). Up to 2 levels for now.
function GroupByList({ groupBy, tagDefs, onChange }) {
  const [dragIdx, setDragIdx] = useState(null)
  const list = groupBy.length ? groupBy : []
  const available = tagDefs.filter(d => !list.includes(d.id))
  const move = (from, to) => { const a = [...list]; const [x] = a.splice(from, 1); a.splice(to, 0, x); onChange(a) }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {list.map((pid, i) => {
        const d = tagDefs.find(x => x.id === pid)
        return (
          <div key={pid} draggable
            onDragStart={() => setDragIdx(i)} onDragEnd={() => setDragIdx(null)}
            onDragOver={e => e.preventDefault()} onDrop={() => { if (dragIdx != null && dragIdx !== i) move(dragIdx, i); setDragIdx(null) }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: dragIdx === i ? '#1b2350' : '#12122a', border: '1px solid #2d3a6a', borderRadius: 6, padding: '5px 8px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'grab' }}>
            <span style={{ color: '#7080a0' }}>⠿</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i === 0 ? '' : '↳ '}{d?.name || pid}</span>
            {list.length > 1 && <span onClick={() => onChange(list.filter((_, j) => j !== i))} style={{ cursor: 'pointer', color: '#f87171' }}>×</span>}
          </div>
        )
      })}
      {available.length > 0 && list.length < 2 && (
        <select value="" onChange={e => { if (e.target.value) onChange([...list, e.target.value]) }} style={{ ...insp.sel, borderStyle: 'dashed' }}>
          <option value="">+ nest by another property…</option>
          {available.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      )}
    </div>
  )
}

const trimStr = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s)

// PROXIMAL cluster config — a pill row anchored under the selected cluster's header (not a docked
// sidebar). Each pill opens a small popover below it. Config actions mutate the cluster on the view.
function ClusterConfigBar({ sys, x, y, zoomK, propertyDefs, tagDefs, numberDefs, dateDefs, onConfig, onFilter, onRemove, onClose }) {
  const [open, setOpen] = useState(null)
  const def = propertyDefs.find(d => d.id === sys.propId)
  const isDate = def?.type === 'date'
  const filter = sys.filter || { text: '', rules: [] }
  const hasFilter = !!(filter.text || (filter.rules && filter.rules.length))
  const groupName = (sys.groupBy && sys.groupBy.length ? sys.groupBy : [sys.propId]).map(id => propertyDefs.find(d => d.id === id)?.name || '?').join(' › ')
  const colourName = (sys.colorBy == null) ? 'Group' : sys.colorBy === 'style' ? 'Style' : (propertyDefs.find(d => d.id === sys.colorBy)?.name || 'Group')
  const sizeName = !sys.sizeBy ? 'Uniform' : sys.sizeBy === 'style' ? 'Style' : (numberDefs.find(d => d.id === sys.sizeBy)?.name || 'Uniform')
  const toggle = (k) => setOpen(o => o === k ? null : k)
  const pill = (k, label, active) => (
    <button style={{ ...cbar.pill, ...(open === k ? cbar.pillOpen : {}), ...(active ? cbar.pillActive : {}) }}
      onMouseDown={e => { e.stopPropagation(); toggle(k) }}>{label} ▾</button>
  )
  return (
    <foreignObject x={x} y={y} width={680} height={480} style={{ overflow: 'visible' }}>
      <div style={{ transform: `scale(${1 / (zoomK || 1)})`, transformOrigin: 'top left' }}>
        <div style={cbar.bar} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
          <button style={cbar.pill} title="Toggle layout" onMouseDown={e => { e.stopPropagation(); onConfig({ kind: sys.kind === 'tree' ? 'pack' : 'tree' }) }}>{sys.kind === 'tree' ? '⌥ Tree' : '◎ Pack'}</button>
          {pill('group', `Group: ${trimStr(groupName, 16)}`)}
          {pill('colour', `Colour: ${trimStr(colourName, 10)}`)}
          {pill('size', `Size: ${trimStr(sizeName, 10)}`)}
          {sys.kind === 'tree' && <button style={{ ...cbar.pill, ...(sys.arrange ? cbar.pillActive : {}) }} title="Free-position items (drag to pin) instead of retag" onMouseDown={e => { e.stopPropagation(); onConfig({ arrange: !sys.arrange }) }}>{sys.arrange ? '✓ ' : ''}Arrange</button>}
          {pill('filter', 'Filter', hasFilter)}
          <button style={cbar.pillX} title="Remove cluster" onMouseDown={e => { e.stopPropagation(); if (confirm(`Remove the “${def?.name}” cluster?`)) onRemove() }}>Remove</button>
          <button style={cbar.pillX} title="Done" onMouseDown={e => { e.stopPropagation(); onClose && onClose() }}>Done</button>
        </div>
        {open && (
          <div style={cbar.pop} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
            {open === 'group' && ((sys.kind === 'tree' || isDate)
              ? <select value={sys.propId} onChange={e => onConfig({ propId: e.target.value, groupBy: [e.target.value] })} style={insp.sel} autoFocus>
                  {tagDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  {dateDefs.map(d => <option key={d.id} value={d.id}>{d.name} (due)</option>)}
                </select>
              : <><div style={cbar.hint}>Drag to nest (up to 2 levels).</div>
                  <GroupByList groupBy={(sys.groupBy && sys.groupBy.length) ? sys.groupBy : [sys.propId]} tagDefs={tagDefs} onChange={list => onConfig({ groupBy: list, propId: list[0] })} /></>)}
            {open === 'colour' && <select value={sys.colorBy ?? ''} onChange={e => onConfig({ colorBy: e.target.value || null })} style={insp.sel} autoFocus>
              <option value="">Group value</option><option value="style">Style (node's own)</option>
              {tagDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>}
            {open === 'size' && <select value={sys.sizeBy || ''} onChange={e => onConfig({ sizeBy: e.target.value || null })} style={insp.sel} autoFocus>
              <option value="">Uniform</option><option value="style">Style (node's own)</option>
              {numberDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>}
            {open === 'filter' && <FilterBar filter={filter} setFilter={upd => onFilter(typeof upd === 'function' ? upd(filter) : upd)} propertyDefs={propertyDefs} />}
          </div>
        )}
        {sys.kind === 'tree' && sys.leafPos && Object.keys(sys.leafPos).length > 0 && (
          <div style={cbar.miniRow} onMouseDown={e => e.stopPropagation()}>
            <span style={{ color: '#8090b8' }}>{Object.keys(sys.leafPos).length} arranged</span>
            <button style={cbar.mini} onMouseDown={e => { e.stopPropagation(); onConfig({ leafPos: {} }) }}>Reset</button>
          </div>
        )}
        {sys.hiddenIds && sys.hiddenIds.length > 0 && (
          <div style={cbar.miniRow} onMouseDown={e => e.stopPropagation()}>
            <span style={{ color: '#8090b8' }}>{sys.hiddenIds.length} hidden</span>
            <button style={cbar.mini} onMouseDown={e => { e.stopPropagation(); onConfig({ hiddenIds: [] }) }}>Show all</button>
          </div>
        )}
      </div>
    </foreignObject>
  )
}

const insp = { sel: { width: '100%', background: '#12122a', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 6, padding: '6px 8px', fontSize: '0.82rem', cursor: 'pointer' } }
const cbar = {
  bar: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', background: 'rgba(16,16,32,0.96)', border: '1px solid #2d3a6a', borderRadius: 10, padding: '6px 8px', boxShadow: '0 10px 30px rgba(0,0,0,0.55)', width: 'max-content', maxWidth: 560, fontFamily: '-apple-system, sans-serif' },
  pill: { background: '#1a1f3a', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 100, padding: '4px 10px', fontSize: '0.76rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  pillOpen: { background: '#26306a', borderColor: '#5b6af0', color: '#fff' },
  pillActive: { borderColor: '#3a5a8a', color: '#8ecbff' },
  pillX: { background: 'transparent', border: '1px solid #3a3050', color: '#c5b0d0', borderRadius: 100, padding: '4px 10px', fontSize: '0.76rem', cursor: 'pointer' },
  pop: { marginTop: 6, background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 9, padding: 10, width: 280, boxShadow: '0 10px 30px rgba(0,0,0,0.55)' },
  hint: { fontSize: '0.68rem', color: '#8090b8', marginBottom: 6 },
  miniRow: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(16,16,32,0.96)', border: '1px solid #2d3a6a', borderRadius: 8, padding: '4px 8px', width: 'max-content', fontSize: '0.74rem' },
  mini: { background: '#12122a', border: '1px solid #2d3a6a', color: '#8ecbff', borderRadius: 6, padding: '2px 8px', fontSize: '0.72rem', cursor: 'pointer' },
}

const vmStyles = {
  menu: { background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 180, boxShadow: '0 8px 26px rgba(0,0,0,0.6)', fontFamily: '-apple-system, sans-serif' },
  head: { padding: '4px 12px 5px', fontSize: '0.72rem', color: '#8ab4ff', fontWeight: 700, borderBottom: '1px solid #23233e', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
}
const styles = {
  viewBar: { position: 'absolute', top: 48, left: 12, zIndex: 5, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', maxWidth: 'calc(100% - 24px)', background: 'rgba(12,12,26,0.6)', padding: '3px 6px', borderRadius: 8 },
  viewPill: { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 100, border: '1px solid #2a2a3e', background: 'transparent', color: '#8090b8', cursor: 'pointer', fontSize: '0.76rem', userSelect: 'none' },
  viewPillActive: { background: '#1e1e2e', color: '#fff', borderColor: '#5b6af0' },
  viewX: { color: '#f87171', fontSize: '0.9rem', lineHeight: 1, marginLeft: 1 },
  viewAdd: { padding: '3px 8px', borderRadius: 6, border: '1px solid #2a2a3e', background: 'transparent', color: '#5b6af0', cursor: 'pointer', fontSize: '0.82rem' },
  clusterFilterBar: { position: 'absolute', top: 84, left: 12, zIndex: 6, display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(20,20,40,0.96)', border: '1px solid #2d3a6a', borderRadius: 8, padding: '6px 10px', boxShadow: '0 8px 26px rgba(0,0,0,0.5)' },
  configPanel: { position: 'absolute', top: 84, left: 12, zIndex: 6, display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(20,20,40,0.97)', border: '1px solid #2d3a6a', borderRadius: 8, padding: '10px 12px', boxShadow: '0 8px 26px rgba(0,0,0,0.5)', minWidth: 240 },
  cfgRow: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  cfgKey: { fontSize: '0.78rem', color: '#c5d0ff' },
  cfgSel: { background: '#12122a', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 6, padding: '4px 6px', fontSize: '0.78rem', maxWidth: 150 },
  wrap: { display: 'flex', height: '100%', width: '100%', background: '#0c0c1a', overflow: 'hidden' },
  main: { position: 'relative', flex: 1, minWidth: 0, height: '100%' },
  svg: { width: '100%', height: '100%', display: 'block', cursor: 'grab' },
  toolbar: { position: 'absolute', top: 10, left: 12, right: 12, zIndex: 5, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  addBtn: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 },
  lensBtn: { background: 'rgba(18,18,42,0.9)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', fontSize: '0.76rem' },
  lensBtnOn: { background: '#1a2f4a', borderColor: '#3a5a8a', color: '#8ecbff' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 210, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  mlabel: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
}
