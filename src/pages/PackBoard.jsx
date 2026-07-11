import { useRef, useState, useEffect, useMemo } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'
import { FilterBar, nodeMatchesFilter, defaultDoneFilter } from '../lib/filter'
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

export default function PackBoard({ projectId }) {
  const nodes = useGraphStore(s => s.nodes)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const setNodeProp = useGraphStore(s => s.setNodeProp)
  const addSelectOption = useGraphStore(s => s.addSelectOption)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const setBoardSystems = useGraphStore(s => s.setBoardSystems)
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
  const [editNodeId, setEditNodeId] = useState(null) // node whose properties are being edited (right-click)
  const numberDefs = propertyDefs.filter(d => d.type === 'number')
  const dateDefs = propertyDefs.filter(d => d.type === 'date')

  const activeView = views.find(v => v.id === activeViewId)
  const colorByDef = activeView?.colorBy ? propertyDefs.find(d => d.id === activeView.colorBy) : null

  // Persisted filter for the active view (shared with the pack view); seed "hide done" the first time.
  const filterInitRef = useRef(null), filterSaveRef = useRef()
  useEffect(() => {
    if (filterInitRef.current === activeViewId) return
    filterInitRef.current = activeViewId
    if (activeView?.filter) setFilter(activeView.filter)
    else { const def = defaultDoneFilter(propertyDefs); if (def) { setFilter(def); setViewFilter(def) } else setFilter({ text: '', rules: [] }) }
  }, [activeViewId, activeView, propertyDefs, setViewFilter])
  useEffect(() => {
    if (filterInitRef.current !== activeViewId) return
    setViewFilter(filter)
    clearTimeout(filterSaveRef.current)
    filterSaveRef.current = setTimeout(() => {
      if (!projectId) return
      const s = useGraphStore.getState()
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
      return {
        fill: (p.fillColor && p.fillColor !== 'none' && p.fillColor !== 'transparent') ? p.fillColor : null,
        textColor: p.textColor || null,
        stroke: (p.strokeColor && p.strokeColor !== 'none') ? p.strokeColor : null,
        strokeWidth: p.strokeWidth,
        strokeDash: p.strokeDash,
        shape,
        scale: p.scale || 1,
        emoji: (p.nodeEmojis || [])[0] || null,
      }
    }
  }, [activeView])
  const nodeVisible = (id) => (activeView?.nodeProps?.[id]?.visible !== false)

  // Load layout from the active view; one-time migrate legacy localStorage layout into the view.
  useEffect(() => {
    if (!activeView) return
    if (Array.isArray(activeView.boardSystems)) { setSystems(activeView.boardSystems); return }
    let legacy = null
    try { const raw = localStorage.getItem(`pim:board:${projectId}`); if (raw) legacy = JSON.parse(raw) } catch { /* ignore */ }
    if (legacy && legacy.length) { setSystems(legacy); setBoardSystems(legacy); persist(legacy) }
    else setSystems([])
  }, [activeViewId]) // eslint-disable-line

  // Restore the saved pan/zoom for this view (once per view).
  const tfRestoreRef = useRef(null)
  useEffect(() => {
    if (tfRestoreRef.current === activeViewId) return
    const bt = activeView?.boardTf
    if (!zoomRef.current || !svgRef.current) return
    tfRestoreRef.current = activeViewId
    const t = bt ? d3.zoomIdentity.translate(bt.x, bt.y).scale(bt.k) : d3.zoomIdentity
    d3.select(svgRef.current).call(zoomRef.current.transform, t); setTf(t)
  }, [activeViewId, activeView]) // eslint-disable-line

  const persist = (next) => {
    if (!projectId) return
    const s = useGraphStore.getState()
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
          tfSaveRef.current = setTimeout(() => { const s = useGraphStore.getState(); if (projectId) saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(() => {}) }, 800)
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
  const saveAll = () => { if (!projectId) return; const s = useGraphStore.getState(); saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e)) }
  const switchView = (id) => { setActiveView(id); saveAll() }
  const setBoardColorBy = (propId) => { setViewColorBy(propId); saveAll() }

  // Hide a set of nodes in the active view (used by the parent-hub "Hide items" action).
  const hideNodes = (ids) => {
    ids.forEach(id => setNodeViewProp(id, 'visible', false))
    if (projectId) { const s = useGraphStore.getState(); saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e)) }
  }

  const visibleNodes = useMemo(
    () => nodes.filter(n => nodeVisible(n.id) && nodeMatchesFilter(n, filter, propertyDefs)),
    [nodes, activeView, filterKey, propertyDefs]) // eslint-disable-line

  const selSys = systems.find(s => s.id === selectedSys) || null

  return (
    <div style={styles.wrap} onContextMenu={e => e.preventDefault()}>
      <div style={styles.main}>
        <div style={styles.toolbar}>
          <div style={{ position: 'relative' }}>
            <button style={styles.addBtn} onClick={() => setAdding(o => !o)} disabled={!tagDefs.length}>+ Add</button>
            {adding && (<>
              <div style={styles.backdrop} onClick={() => setAdding(false)} />
              <div style={styles.menu} onClick={e => e.stopPropagation()}>
                {!tagDefs.length && <div style={{ ...styles.item, color: '#8090b8' }}>No Select/Tags property</div>}
                {tagDefs.length > 0 && <>
                  <div style={styles.mlabel}>◎ Circle pack — group by</div>
                  {tagDefs.map(d => (<div key={'p' + d.id} style={styles.item} onClick={() => addSystem(d.id, 'pack')}>{d.name}</div>))}
                  <div style={{ ...styles.mlabel, marginTop: 4 }}>⌥ Property tree — branch by</div>
                  {tagDefs.map(d => (<div key={'t' + d.id} style={styles.item} onClick={() => addSystem(d.id, 'tree')}>{d.name}</div>))}
                </>}
              </div>
            </>)}
          </div>
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
          <span style={{ color: '#8090b8', fontSize: '0.72rem', marginLeft: 'auto' }}>{systems.length} cluster{systems.length === 1 ? '' : 's'} · click a header to inspect · drag to move</span>
        </div>
        {!systems.length && <div style={styles.empty}>Nothing here yet. Click <b style={{ color: '#8ab4ff' }}>+ Add</b> and pick a circle pack or a property tree.</div>}
        <svg ref={svgRef} style={styles.svg}>
          <g ref={gRef} transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
            {systems.map(sys => {
              const def = propertyDefs.find(d => d.id === sys.propId)
              if (!def) return null
              const common = {
                key: sys.id, sys, def, nodes: visibleNodes, decorColor, decorOf, toWorld, zoomK: tf.k,
                filterFn: (n) => nodeMatchesFilter(n, sys.filter || { text: '', rules: [] }, propertyDefs),
                clusterFilterKey: JSON.stringify(sys.filter || {}),
                hasFilter: !!(sys.filter?.text || sys.filter?.rules?.length),
                selected: selectedSys === sys.id, onSelect: () => setSelectedSys(sys.id),
                colorMode: sys.colorBy !== undefined ? sys.colorBy : (activeView?.colorBy || null),
                sizeMode: sys.sizeBy || null, propertyDefs,
                onEditNode: setEditNodeId,
                onRetag: (nid, so, to, add) => retag(sys.propId, nid, so, to, add), onHideNodes: hideNodes,
                onMove: moveSystem, onCommitMove: commitMove, onRemove: () => removeSystem(sys.id),
              }
              return sys.kind === 'tree' ? <TreeCluster {...common} /> : <Cluster {...common} />
            })}
          </g>
        </svg>
        {editNodeId && (
          <NodePropsEditor
            node={nodes.find(n => n.id === editNodeId)}
            propertyDefs={propertyDefs}
            onSet={(propId, value) => { setNodeProp(editNodeId, propId, value); saveAll() }}
            onAddOption={(propId, name) => addSelectOption(propId, name)}
            onClose={() => setEditNodeId(null)}
          />
        )}
      </div>
      {selSys && (
        <ClusterInspector
          sys={selSys} propertyDefs={propertyDefs} tagDefs={tagDefs} numberDefs={numberDefs} dateDefs={dateDefs}
          onConfig={patch => setSystemConfig(selSys.id, patch)}
          onFilter={f => setSystemFilter(selSys.id, f)}
          onRemove={() => { removeSystem(selSys.id); setSelectedSys(null) }}
          onClose={() => setSelectedSys(null)}
        />
      )}
    </div>
  )
}

// One independent pack cluster, positioned at (sys.x, sys.y) on the shared canvas, running its own
// force layout in LOCAL coordinates (centered on 0,0). Mirrors the proven single-pack mechanics.
function Cluster({ sys, def, colorMode, sizeMode, propertyDefs, decorOf, nodes, toWorld, zoomK, filterFn, clusterFilterKey, hasFilter, selected, onSelect, onEditNode, onRetag, onMove, onCommitMove, onRemove }) {
  const simRef = useRef(null), packSimRef = useRef(null)
  const bubblesRef = useRef([]), packsRef = useRef([]), groupsRef = useRef([])
  const heldRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [held, setHeld] = useState(() => new Set())
  const [hover, setHover] = useState(null)

  const build = () => {
    const opts = def.options || []
    const groups = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(groups.map((g, i) => [g.opt, i]))
    const numDomain = (sizeMode && sizeMode !== 'style') ? domainOf(nodes, sizeMode) : null
    const raw = []
    nodes.forEach(n => {
      if (filterFn && !filterFn(n)) return   // per-cluster filter
      const v = n.props?.[def.id]
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
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
      // dropped in place, no retag → leave it where dropped, NO sim restart (this was the child-move storm)
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

  return (
    <g transform={`translate(${sys.x},${sys.y})`}>
      <ClusterHeader def={def} kind="pack" cx={(bounds.minX + bounds.maxX) / 2} y={headY} zoomK={zoomK} hasFilter={hasFilter} selected={selected} onHead={startHeadDrag} onRemove={onRemove} />
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
      {bubbles.map(b => <Bubble key={b.key} b={b} held={held.has(b.key)} onDown={e => startDrag(e, b)}
        onContext={e => { e.preventDefault(); e.stopPropagation(); onEditNode && onEditNode(b.nodeId) }}
        onDbl={e => { e.stopPropagation(); onEditNode && onEditNode(b.nodeId) }} />)}
    </g>
  )
}

// Property tree: root (property) → value nodes (1st gen) → item leaves (2nd gen). Force-directed in
// LOCAL coordinates with the root pinned at 0,0; values held on a ring; leaves pulled to their value.
// Drag a leaf onto another value node to retag (same semantics as the pack cluster).
function TreeCluster({ sys, def, colorMode, sizeMode, propertyDefs, nodes, decorOf, toWorld, zoomK, filterFn, clusterFilterKey, hasFilter, selected, onSelect, onEditNode, onRetag, onHideNodes, onMove, onCommitMove, onRemove }) {
  const simRef = useRef(null)
  const fnodesRef = useRef([]), valuesRef = useRef([])
  const heldRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [held, setHeld] = useState(() => new Set())
  const [hover, setHover] = useState(null)
  const [vmenu, setVmenu] = useState(null)   // right-click menu on a value hub: { opt }
  useEffect(() => {
    if (!vmenu) return
    const close = () => setVmenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [vmenu])

  const build = () => {
    const opts = def.options || []
    const values = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(values.map((v, i) => [v.opt, i]))
    const leaves = []
    let hasUntagged = false
    const colorForOpt = (opt) => (values.find(v => v.opt === opt)?.color) || '#6b7394'
    const numDomain = (sizeMode && sizeMode !== 'style') ? domainOf(nodes, sizeMode) : null
    nodes.forEach(n => {
      if (filterFn && !filterFn(n)) return   // per-cluster filter
      const v = n.props?.[def.id]
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
      const valid = ids.filter(id => idx.has(id))
      const dec = decorOf?.(n.id) || {}
      const label = n.label || '(untitled)'
      // Size honours the cluster's size mode (default = the node's own scale, mirroring the graph).
      const scl = sizeMode ? sizeScaleFor(sizeMode, n, dec, numDomain) : Math.min(1.8, Math.max(0.65, dec.scale || 1))
      const baseR = radiusFor(label) * 0.7 * scl
      const shape = dec.shape || 'circle'
      const bound = (shape === 'ellipse' || shape === 'rect' || shape === 'roundrect') ? baseR * 1.34 : shape === 'diamond' ? baseR * 1.16 : baseR
      const mk = (opt) => ({ nodeId: n.id, opt, label, color: resolveColor(colorMode, n, dec, colorForOpt(opt), propertyDefs), decor: dec, shape, baseR, r: bound })
      if (!valid.length) { hasUntagged = true; leaves.push(mk('__untagged__')) }
      else valid.forEach(id => leaves.push(mk(id)))
    })
    if (hasUntagged) values.push({ opt: '__untagged__', name: '(untagged)', color: '#6b7394' })
    return { values, leaves }
  }
  const structureKey = useMemo(() => {
    const opt = (def.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows
  }, [nodes, def])

  const ringRef = useRef(280)   // radius the value hubs sit on (grows with the number of values)
  useEffect(() => {
    const sim = d3.forceSimulation([])
      // Strong hub-hub repulsion + tight leaf→hub links → each value + its leaves forms a SEPARATED cluster.
      .force('charge', d3.forceManyBody().strength(d => d.kind === 'leaf' ? -24 : -1400))
      .force('link', d3.forceLink([]).id(d => d.id).distance(l => l.kind === 'rv' ? ringRef.current : 52).strength(l => l.kind === 'rv' ? 0.03 : 0.8))
      .force('collide', d3.forceCollide(d => d.r + (d.kind === 'value' ? 10 : 4)).strength(0.9).iterations(2))
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
    const { values, leaves } = build()
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
      return base
    })
    const vById = new Map(vnodes.map(v => [v.opt, v]))
    const lnodes = leaves.map(d => {
      const id = 'l:' + d.nodeId + '@' + d.opt; const ex = prev.get(id)
      const parent = vById.get(d.opt) || root
      const j = (hashStr(id) % 40) - 20
      const base = ex || { id, kind: 'leaf', x: parent.x + j, y: parent.y + j, vx: 0, vy: 0 }
      base.opt = d.opt; base.nodeId = d.nodeId; base.label = d.label; base.color = d.color
      base.decor = d.decor; base.shape = d.shape; base.baseR = d.baseR; base.r = d.r
      return base
    })
    const fns = [root, ...vnodes, ...lnodes]
    fnodesRef.current = fns; valuesRef.current = vnodes
    const links = [
      ...vnodes.map(v => ({ source: root.id, target: v.id, kind: 'rv' })),
      ...lnodes.map(l => ({ source: 'v:' + l.opt, target: l.id, kind: 'vl' })),
    ]
    const sm = simRef.current; if (!sm) return
    sm.nodes(fns)
    sm.force('link').links(links)
    sm.alpha(0.8).restart(); setTick(t => t + 1)
  }, [structureKey, colorMode, sizeMode, clusterFilterKey]) // eslint-disable-line

  const setHeldKeys = (s) => { heldRef.current = s; setHeld(s) }
  const local = (ev) => { const p = toWorld(ev); return { x: p.x - sys.x, y: p.y - sys.y } }
  const dropTarget = (p) => { let best = null, bd = Infinity; valuesRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } }); const c = valuesRef.current[best]; if (best == null || !c) return -1; return Math.hypot(p.x - c.x, p.y - c.y) > c.r + 40 ? -1 : best }

  const startDrag = (e, b) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current; const start = local(e)
    b.fx = b.x; b.fy = b.y; setHeldKeys(new Set([b.id]))   // no global reheat while dragging (avoids motion storm)
    const move = ev => { const p = local(ev); b.fx = p.x; b.fy = p.y; b.x = p.x; b.y = p.y; setHover(dropTarget(p)); setTick(t => t + 1) }
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      const p = local(ev); const tg = dropTarget(p); b.fx = null; b.fy = null; setHeldKeys(new Set()); setHover(null); sim.alphaTarget(0)
      const vals = valuesRef.current; const targetOpt = tg < 0 ? '__untagged__' : vals[tg].opt
      if (Math.hypot(p.x - start.x, p.y - start.y) > 4 && targetOpt !== b.opt) onRetag(b.nodeId, b.opt, targetOpt, false)
      // dropped in place, no retag → leave it where dropped, NO sim restart (this was the child-move storm)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  // Drag a value hub (parent) → it stays pinned where dropped; its leaves follow via the link force.
  const startValueDrag = (e, v) => {
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current
    v.fx = v.x; v.fy = v.y; sim.alphaTarget(0.15).restart()
    const move = ev => { const p = local(ev); v.fx = p.x; v.fy = p.y; v.x = p.x; v.y = p.y; setTick(t => t + 1) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); sim.alphaTarget(0) }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const startHeadDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = sys.x - p0.x, oy = sys.y - p0.y; let moved = false
    const move = ev => { const p = toWorld(ev); if (Math.hypot(p.x - p0.x, p.y - p0.y) > 3) moved = true; onMove(sys.id, p.x + ox, p.y + oy) }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (moved) onCommitMove(); else onSelect && onSelect() }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const fns = fnodesRef.current, values = valuesRef.current
  const root = fns.find(f => f.kind === 'root')
  const leaves = fns.filter(f => f.kind === 'leaf')
  const dragging = held.size > 0
  const minY = fns.reduce((m, f) => Math.min(m, f.y - f.r), 0)
  const headY = minY - 44
  const countByOpt = {}; leaves.forEach(l => { countByOpt[l.opt] = (countByOpt[l.opt] || 0) + 1 })

  return (
    <g transform={`translate(${sys.x},${sys.y})`}>
      <ClusterHeader def={def} kind="tree" cx={0} y={headY} zoomK={zoomK} hasFilter={hasFilter} selected={selected} onHead={startHeadDrag} onRemove={onRemove} />
      {/* links: root→value then value→leaf */}
      <g pointerEvents="none">
        {root && values.map(v => (
          <line key={'e' + v.id} x1={root.x} y1={root.y} x2={v.x} y2={v.y} stroke={v.color} strokeOpacity={0.5} strokeWidth={2} />
        ))}
        {leaves.map(l => { const v = values.find(x => x.opt === l.opt); if (!v) return null
          return <line key={'e' + l.id} x1={v.x} y1={v.y} x2={l.x} y2={l.y} stroke={l.color} strokeOpacity={0.28} strokeWidth={1.4} /> })}
      </g>
      {/* root */}
      {root && (
        <g pointerEvents="none" transform={`translate(${root.x},${root.y})`}>
          <circle r={root.r} fill="#141428" stroke="#7c8cff" strokeWidth={2.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight={800} fill="#c5d0ff"
            style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 4, strokeLinejoin: 'round' }}>
            {wrapText(root.name, 9).slice(0, 3).map((ln, i, a) => <tspan key={i} x={0} y={(i - (a.length - 1) / 2) * 14}>{ln}</tspan>)}
          </text>
        </g>
      )}
      {/* value nodes (1st generation) */}
      {values.map(v => {
        const isT = dragging && hover != null && values[hover] === v
        const vf = Math.max(12, Math.min(20, v.r * 0.26))
        return (
          <g key={v.id} data-bubble="1" transform={`translate(${v.x},${v.y})`} style={{ cursor: 'grab' }}
            onMouseDown={e => startValueDrag(e, v)}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setVmenu({ opt: v.opt }) }}>
            <circle r={v.r} fill={v.color + '2a'} stroke={isT ? '#7fd8a8' : v.color} strokeWidth={isT ? 4 : 3} />
            <text textAnchor="middle" dominantBaseline="middle" fontSize={vf} fontWeight={800} fill={isT ? '#7fd8a8' : '#e8eeff'} pointerEvents="none"
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: 4, strokeLinejoin: 'round' }}>
              {wrapText(v.name, 11).slice(0, 3).map((ln, i, a) => <tspan key={i} x={0} y={(i - (a.length - 1) / 2) * (vf * 1.05) - vf * 0.5}>{ln}</tspan>)}
              <tspan x={0} y={vf * 1.4} fontSize={vf * 0.75} fillOpacity={0.85}>· {countByOpt[v.opt] || 0}</tspan>
            </text>
          </g>
        )
      })}
      {/* item leaves (2nd generation) — real graph nodes with their cosmetics; draggable to retag */}
      {leaves.map(l => <LeafNode key={l.id} b={l} held={held.has(l.id)} onDown={e => startDrag(e, l)}
        onContext={e => { e.preventDefault(); e.stopPropagation(); onEditNode && onEditNode(l.nodeId) }}
        onDbl={e => { e.stopPropagation(); onEditNode && onEditNode(l.nodeId) }} />)}
      {/* value-hub context menu — rendered LAST so it paints on top of every node */}
      {vmenu && (() => {
        const v = valuesRef.current.find(x => x.opt === vmenu.opt); if (!v) return null
        return (
          <foreignObject x={v.x + v.r + 6} y={v.y - 40} width={210} height={150} style={{ overflow: 'visible' }}>
            <div style={{ transform: `scale(${1 / (zoomK || 1)})`, transformOrigin: 'top left' }}>
              <div style={vmStyles.menu} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
                <div style={vmStyles.head}>{v.name}</div>
                <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); const ids = fnodesRef.current.filter(f => f.kind === 'leaf' && f.opt === v.opt).map(f => f.nodeId); setVmenu(null); if (ids.length && onHideNodes) onHideNodes([...new Set(ids)]) }}>Hide these items in this view</div>
                {v.fx != null && <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); v.fx = null; v.fy = null; setVmenu(null); simRef.current.alpha(0.3).restart() }}>Unpin (let it float)</div>}
                <div style={vmStyles.item} onMouseDown={e => { e.stopPropagation(); setVmenu(null) }}>Close</div>
              </div>
            </div>
          </foreignObject>
        )
      })()}
    </g>
  )
}

// Shared draggable header chip for a cluster.
function ClusterHeader({ def, kind, cx, y, zoomK, hasFilter, selected, onHead, onRemove }) {
  const glyph = kind === 'tree' ? '⌥' : '◎'
  // Counter-scale the whole chip so it stays ~constant on screen, clamped to a min/max, at any zoom.
  const s = zfont(15, zoomK, 11, 26) / 15
  return (
    <g data-syshead="1" transform={`translate(${cx},${y}) scale(${s})`} style={{ cursor: 'grab' }} onMouseDown={onHead}>
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

// A tree leaf = a real graph node rendered with its graph-view cosmetics (fill/shape/stroke/dash/emoji).
function LeafNode({ b, held, onDown, onContext, onDbl }) {
  const dec = b.decor || {}
  const shape = b.shape || 'circle'
  const s = b.baseR || b.r
  const fill = b.color
  const light = hexLum(fill) > 0.55
  const stroke = held ? '#fff' : (dec.stroke || 'rgba(232,238,255,0.4)')
  const sw = held ? 3 : (dec.strokeWidth || 1.2)
  const dash = held ? undefined : dashArrayB(dec.strokeDash, sw)
  const tf = dec.textColor || (light ? '#0c0c1a' : '#f2f5ff')
  const emoji = dec.emoji
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
    <g data-bubble="1" transform={`translate(${b.x || 0},${b.y || 0})`} style={{ cursor: 'grab' }} onMouseDown={onDown} onContextMenu={onContext} onDoubleClick={onDbl}>
      {body}
      {emoji && <text textAnchor="middle" dominantBaseline="middle" fontSize={s * 0.7} y={-s * 0.42} pointerEvents="none">{emoji}</text>}
      <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={tf} pointerEvents="none"
        style={{ fontWeight: 400, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
        {lines.map((ln, i) => <tspan key={i} x={0} y={yStart + i * lh}>{ln}</tspan>)}
      </text>
    </g>
  )
}

// A draggable item bubble (used by both pack and tree clusters).
function Bubble({ b, held, onDown, onContext, onDbl }) {
  const light = hexLum(b.color) > 0.55, tf = light ? '#0c0c1a' : '#f2f5ff'
  const fs = Math.max(8, b.r * 0.3), maxChars = Math.max(5, Math.floor((1.7 * b.r) / (fs * 0.56)))
  const lines = wrapText(b.label, maxChars).slice(0, 5), lh = fs * 1.05, y0 = -(lines.length - 1) / 2 * lh
  return (
    <g data-bubble="1" transform={`translate(${b.x || 0},${b.y || 0})`} style={{ cursor: 'grab' }} onMouseDown={onDown} onContextMenu={onContext} onDoubleClick={onDbl}>
      <circle r={b.r} fill={b.color} fillOpacity={0.96} stroke={held ? '#fff' : 'rgba(232,238,255,0.4)'} strokeWidth={held ? 3.5 : 1.2} />
      <text textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill={tf} pointerEvents="none"
        style={{ fontWeight: 400, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fs * 0.13 }}>
        {lines.map((ln, i) => <tspan key={i} x={0} y={y0 + i * lh}>{ln}</tspan>)}
      </text>
    </g>
  )
}

// Right-docked settings panel for the selected cluster — the single home for its grouping, colour,
// size, and filter. Replaces the old floating margin panels.
function ClusterInspector({ sys, propertyDefs, tagDefs, numberDefs, dateDefs, onConfig, onFilter, onRemove, onClose }) {
  const def = propertyDefs.find(d => d.id === sys.propId)
  const filter = sys.filter || { text: '', rules: [] }
  return (
    <div style={insp.panel}>
      <div style={insp.head}>
        <span style={insp.title}>{sys.kind === 'tree' ? '⌥' : '◎'} {def?.name || 'Cluster'}</span>
        <button style={insp.close} onClick={onClose} title="Close">×</button>
      </div>

      <div style={insp.section}>
        <div style={insp.label}>Layout</div>
        <select value={sys.kind} onChange={e => onConfig({ kind: e.target.value })} style={insp.sel}>
          <option value="pack">◎ Circle pack</option>
          <option value="tree">⌥ Property tree</option>
        </select>
      </div>

      <div style={insp.section}>
        <div style={insp.label}>Group by</div>
        <select value={sys.propId} onChange={e => onConfig({ propId: e.target.value })} style={insp.sel}>
          {tagDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      <div style={insp.section}>
        <div style={insp.label}>Colour by</div>
        <select value={sys.colorBy ?? ''} onChange={e => onConfig({ colorBy: e.target.value || null })} style={insp.sel}>
          <option value="">Group value</option>
          <option value="style">Style (node's own)</option>
          {tagDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      <div style={insp.section}>
        <div style={insp.label}>Size by</div>
        <select value={sys.sizeBy || ''} onChange={e => onConfig({ sizeBy: e.target.value || null })} style={insp.sel}>
          <option value="">Uniform</option>
          <option value="style">Style (node's own)</option>
          {numberDefs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      <div style={insp.section}>
        <div style={insp.label}>Filter this cluster</div>
        <FilterBar filter={filter} setFilter={upd => onFilter(typeof upd === 'function' ? upd(filter) : upd)} propertyDefs={propertyDefs} />
      </div>

      <div style={{ flex: 1 }} />
      <button style={insp.remove} onClick={() => { if (confirm(`Remove the “${def?.name}” cluster?`)) onRemove() }}>Remove cluster</button>
    </div>
  )
}

const insp = {
  panel: { width: 288, flexShrink: 0, height: '100%', overflowY: 'auto', background: '#0f0f1e', borderLeft: '1px solid #23233e', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#e8eeff', fontSize: '0.95rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  close: { background: 'transparent', border: 'none', color: '#8090b8', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 },
  section: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: '0.68rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8090b8' },
  sel: { width: '100%', background: '#12122a', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 6, padding: '6px 8px', fontSize: '0.82rem', cursor: 'pointer' },
  remove: { background: 'transparent', border: '1px solid #5a2a2a', color: '#f87171', borderRadius: 7, padding: '7px 10px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 },
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
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 210, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  mlabel: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
}
