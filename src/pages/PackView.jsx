import { useMemo, useState, useRef, useEffect } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { saveProject, saveProjectToNotion } from '../lib/db'
import { buildTree, buildNestedTagTree } from '../lib/hierarchy'
import { defaultDoneFilter } from '../lib/filter'

// Two packing modes share one shell:
//  • Hierarchy (edges) → deterministic zoomable circle-pack (ref: mbostock/1747543).
//  • Group-by-tag      → CLUSTERED FORCE layout (see TagPackForce). Packs self-organise and
//    bunch tightly (d3.packSiblings); DRAG an item onto another pack to retag it — it glides
//    into place instead of the whole diagram re-laying-out. Alt-drag adds a second tag.

const D = 932                      // world size of the hierarchy pack square (SVG viewBox)
const DEPTH_FILL = ['#12122a', '#1b2452', '#26346f', '#33459a', '#4557c0', '#6f7fe0']

export default function PackView({ projectId }) {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const setNodeProp = useGraphStore(s => s.setNodeProp)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const addNode = useGraphStore(s => s.addNode)
  const addSelectOption = useGraphStore(s => s.addSelectOption)
  const numberDefs = propertyDefs.filter(d => d.type === 'number')
  const tagDefs = propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect')
  const dateDefs = propertyDefs.filter(d => d.type === 'date')

  const [sizeBy, setSizeBy] = useState(null)         // null = size by item count, else Number propId
  const [groupProp, setGroupProp] = useState(null)   // null = edge hierarchy, else group-by-tag propId
  const [groupProp2, setGroupProp2] = useState(null) // optional 2nd-level grouping → nested deterministic pack
  const [menuOpen, setMenuOpen] = useState(false)
  const [srcMenu, setSrcMenu] = useState(false)
  const [srcMenu2, setSrcMenu2] = useState(false)
  const [notionSave, setNotionSave] = useState(null)   // null | 'saving' | result string
  const setViewFilter = useGraphStore(s => s.setViewFilter)
  const [filter, setFilter] = useState({ text: '', rules: [] })
  const filterKey = JSON.stringify(filter)
  const [editNodeId, setEditNodeId] = useState(null)   // node whose properties are being edited
  // Load the persisted filter for the active view (or seed a "hide done" default the first time).
  const filterInitRef = useRef(null)
  useEffect(() => {
    if (filterInitRef.current === activeViewId) return
    filterInitRef.current = activeViewId
    const v = views.find(x => x.id === activeViewId)
    if (v?.filter) setFilter(v.filter)
    else { const def = defaultDoneFilter(propertyDefs); if (def) { setFilter(def); setViewFilter(def) } else setFilter({ text: '', rules: [] }) }
  }, [activeViewId, views, propertyDefs, setViewFilter])
  // Persist filter edits to the view (store now, DB debounced) so they survive reloads + sync.
  const filterSaveRef = useRef()
  useEffect(() => {
    if (filterInitRef.current !== activeViewId) return   // don't persist during the load above
    setViewFilter(filter)
    clearTimeout(filterSaveRef.current)
    filterSaveRef.current = setTimeout(() => {
      if (!projectId) return
      const s = useGraphStore.getState()
      saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs }).catch(e => console.error('Save:', e))
    }, 700)
    return () => clearTimeout(filterSaveRef.current)
  }, [filterKey]) // eslint-disable-line
  const notionLinked = views.some(v => v.notionDatabaseId)

  const handleSaveNotion = async () => {
    if (notionSave === 'saving') return
    const s = useGraphStore.getState()
    if (!confirm(`Push tag/field values of all ${s.nodes.length} items back to Notion? This overwrites those properties in Notion.`)) return
    setNotionSave('saving')
    try {
      const { updated, errors } = await saveProjectToNotion(s.nodes, s.propertyDefs)
      setNotionSave(`✓ ${updated} updated${errors?.length ? ` · ${errors.length} failed` : ''}`)
    } catch (e) {
      setNotionSave('✗ ' + e.message)
    }
    setTimeout(() => setNotionSave(null), 6000)
  }
  const sizeLabel = sizeBy ? (propertyDefs.find(d => d.id === sizeBy)?.name || 'property') : 'items'
  const srcLabel = groupProp ? (propertyDefs.find(d => d.id === groupProp)?.name || 'tag') : 'Hierarchy'
  const rawGroupDef = groupProp ? propertyDefs.find(d => d.id === groupProp) : null
  const groupDef = rawGroupDef?.type === 'date' ? dueDefFor(rawGroupDef) : rawGroupDef

  const decorOf = useMemo(() => {
    const np = views.find(v => v.id === activeViewId)?.nodeProps || {}
    return id => {
      const p = np[id] || {}
      const em = (p.nodeEmojis || [])[0] || null
      return { color: p.fillColor && p.fillColor !== 'none' ? p.fillColor : null,
        stroke: p.strokeColor || null, strokeWidth: p.strokeWidth || null, emoji: em }
    }
  }, [views, activeViewId])

  // ── Retag one or many items in a single batch (writes node.props + one save) ─
  // list = [{ nodeId, sourceOpt }]. targetOpt '__untagged__' clears the tag (drop outside packs).
  const retagMany = (list, targetOpt, additive) => {
    const def = propertyDefs.find(d => d.id === groupProp); if (!def || !list.length) return
    // Due-date grouping: dropping on a bucket sets a representative date; outside → clear.
    if (def.type === 'date') {
      const now = startOfDay(new Date())
      list.forEach(({ nodeId }) => setNodeProp(nodeId, groupProp, targetOpt === '__untagged__' ? null : dueRepDate(targetOpt, now)))
      persist()
      return
    }
    list.forEach(({ nodeId, sourceOpt }) => {
      const node = useGraphStore.getState().nodes.find(n => n.id === nodeId)
      const raw = node?.props?.[groupProp]
      let value
      if (def.type === 'multiSelect') {
        let tags = Array.isArray(raw) ? [...raw] : (raw ? [raw] : [])
        if (!additive && sourceOpt && sourceOpt !== '__untagged__') tags = tags.filter(x => x !== sourceOpt)
        if (targetOpt !== '__untagged__' && !tags.includes(targetOpt)) tags.push(targetOpt)
        value = tags
      } else {
        value = targetOpt === '__untagged__' ? null : targetOpt
      }
      setNodeProp(nodeId, groupProp, value)
    })
    if (projectId) {
      const s = useGraphStore.getState()
      saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs })
        .catch(e => console.error('Save:', e))
    }
  }
  const persist = () => {
    if (!projectId) return
    const s = useGraphStore.getState()
    saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs })
      .catch(e => console.error('Save:', e))
  }
  // Create a new item in pack mode; tag it with `opt` (the pack it was dropped near), or leave untagged.
  const handleCreateNode = (label, opt) => {
    const def = propertyDefs.find(d => d.id === groupProp)
    const id = addNode((label || '').trim() || 'New item')
    if (def && opt && opt !== '__untagged__') {
      if (def.type === 'date') setNodeProp(id, groupProp, dueRepDate(opt, startOfDay(new Date())))
      else setNodeProp(id, groupProp, def.type === 'multiSelect' ? [opt] : opt)
    }
    persist()
    return id
  }
  // Add a new value (option) to the grouping property → a new empty pack.
  const handleAddValue = (name) => {
    if (!groupProp || !(name || '').trim()) return
    addSelectOption(groupProp, name.trim())
    persist()
  }
  // Hide a node in the active view (it disappears from this view's pack/graph until unhidden).
  const handleHideNode = (nodeId) => { setNodeViewProp(nodeId, 'visible', false); persist() }
  const nodeVisible = (id) => (views.find(v => v.id === activeViewId)?.nodeProps?.[id]?.visible !== false)

  // Nested grouping (project › status): two tag properties → deterministic nested circle pack.
  const nested = !!(groupProp && groupProp2 && groupProp !== groupProp2 &&
    rawGroupDef?.type !== 'date' && propertyDefs.find(d => d.id === groupProp2)?.type !== 'date')
  // ── Hierarchy (edges) mode / nested-tags mode: deterministic zoomable pack ───
  const root = useMemo(() => {
    const fnodes = nodes.filter(n => nodeVisible(n.id) && nodeMatchesFilter(n, filter, propertyDefs))
    if (nested) {
      const defA = propertyDefs.find(d => d.id === groupProp), defB = propertyDefs.find(d => d.id === groupProp2)
      const tree = buildNestedTagTree(fnodes, defA, defB, { decorOf, sizeBy })
      const h = d3.hierarchy(tree).sum(d => d.value || 0).sort((a, b) => (b.value || 0) - (a.value || 0))
      return d3.pack().size([D, D]).padding(6)(h)
    }
    if (groupProp) return null
    const tree = buildTree(fnodes, edges, { decorOf, sizeBy })
    const h = d3.hierarchy(tree).sum(d => d.value || 0).sort((a, b) => (b.value || 0) - (a.value || 0))
    return d3.pack().size([D, D]).padding(3)(h)
  }, [nodes, edges, decorOf, sizeBy, groupProp, groupProp2, nested, filterKey, propertyDefs]) // eslint-disable-line
  const descendants = root ? root.descendants() : []
  const colorFor = (d) => d.data.color || DEPTH_FILL[Math.min(d.depth, DEPTH_FILL.length - 1)]

  const svgRef = useRef(null)
  const hgRef = useRef(null)              // hierarchy inner <g> (for drag coordinate mapping)
  const zoomRef = useRef(null)
  const hPacksRef = useRef([])            // hierarchy top-level branch force-packs [{id,r,x0,y0,x,y,fx,fy,anchored}]
  const hPackByIdRef = useRef({})
  const branchOfRef = useRef({})          // descendant id → its top-level branch id
  const hPackSimRef = useRef(null)
  const didHDragRef = useRef(false)
  const [t, setT] = useState(d3.zoomIdentity)
  const [, setDragTick] = useState(0)
  useEffect(() => {
    if (groupProp || !svgRef.current) return
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.5, 48])
      .filter(e => {
        if (e.type === 'dblclick') return false
        if (e.type === 'mousedown' && e.target?.closest?.('[data-hcirc]')) return false  // circle drag, not pan
        return !e.ctrlKey && !e.button
      })
      .on('zoom', e => setT(e.transform))
    zoomRef.current = zoom
    sel.call(zoom)
    return () => sel.on('.zoom', null)
  }, [groupProp])
  // Drag a hierarchy circle → offset it (and its whole subtree). Click (no drag) still zooms to fit.
  const toWorldH = (ev) => {
    const g = hgRef.current, svg = svgRef.current
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY
    const loc = pt.matrixTransform(g.getScreenCTM().inverse())
    return { x: loc.x, y: loc.y }
  }
  // Option B: each root-child branch is a force-pack; its nested circles keep the deterministic
  // d3.pack layout and ride along by the pack's (x-x0, y-y0) offset.
  const hOffsetFor = (descId) => {
    const p = hPackByIdRef.current[branchOfRef.current[descId]]
    return p ? { dx: p.x - p.x0, dy: p.y - p.y0 } : { dx: 0, dy: 0 }
  }
  // Create the top-level pack sim once (self-bunching + hard no-overlap between branches).
  useEffect(() => {
    const sim = d3.forceSimulation([])
      .force('x', d3.forceX(D / 2).strength(0.025))
      .force('y', d3.forceY(D / 2).strength(0.025))
      .force('collide', d3.forceCollide(p => p.r + 8).strength(1).iterations(2))
      .alphaDecay(0.03).velocityDecay(0.6)
      .on('tick', () => {
        const ps = hPacksRef.current, GAP = 6
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j]
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + GAP
          if (d < min) {
            const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d
            const af = a.fx != null, bf = b.fx != null
            if (af && !bf) { b.x += ux * push; b.y += uy * push }
            else if (bf && !af) { a.x -= ux * push; a.y -= uy * push }
            else if (!af && !bf) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
          }
        }
        setDragTick(v => v + 1)
      })
    hPackSimRef.current = sim
    return () => sim.stop()
  }, [])
  // Rebuild branch packs when the (filtered) hierarchy changes; preserve positions/anchors by id.
  useEffect(() => {
    if (groupProp || !root) return
    const tops = root.children || []
    const branchOf = {}
    const prev = new Map((hPacksRef.current || []).map(p => [p.id, p]))
    const packs = tops.map(tl => {
      tl.descendants().forEach(desc => { branchOf[desc.data.id] = tl.data.id })
      const ex = prev.get(tl.data.id)
      if (ex) { ex.r = tl.r; ex.x0 = tl.x; ex.y0 = tl.y; return ex }
      return { id: tl.data.id, r: tl.r, x0: tl.x, y0: tl.y, x: tl.x, y: tl.y, fx: null, fy: null, anchored: false }
    })
    branchOfRef.current = branchOf
    hPacksRef.current = packs
    hPackByIdRef.current = Object.fromEntries(packs.map(p => [p.id, p]))
    const sim = hPackSimRef.current; if (!sim) return
    sim.nodes(packs); sim.alpha(0.6).restart()
    setDragTick(v => v + 1)
  }, [root, groupProp])
  // Drag anywhere in a branch → move that branch's pack; drop anchors it. Click (no drag) = zoom to fit.
  const startHDrag = (e, d) => {
    e.stopPropagation()
    const pack = hPackByIdRef.current[branchOfRef.current[d.data.id]]; if (!pack) return
    const p0 = toWorldH(e); const ox = pack.x - p0.x, oy = pack.y - p0.y
    hPackSimRef.current.alphaTarget(0.3).restart()
    let moved = false
    const onMove = ev => {
      const p = toWorldH(ev)
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) > 3) { moved = true; didHDragRef.current = true }
      if (moved) {
        let x = p.x + ox, y = p.y + oy
        for (const c of hPacksRef.current) {
          if (c === pack) continue
          const dx = x - c.x, dy = y - c.y, dd = Math.hypot(dx, dy), min = pack.r + c.r + 6
          if (dd < min) { const q = dd || 1; x = c.x + dx / q * min; y = c.y + dy / q * min }
        }
        pack.fx = x; pack.fy = y; pack.x = x; pack.y = y; setDragTick(v => v + 1)
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp)
      if (moved) pack.anchored = true
      hPackSimRef.current.alphaTarget(0)
      setTimeout(() => { didHDragRef.current = false }, 0)
      setDragTick(v => v + 1)
    }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }
  const releaseHPack = (id) => { const p = hPackByIdRef.current[id]; if (!p) return; p.fx = null; p.fy = null; p.anchored = false; hPackSimRef.current?.alpha(0.5).restart(); setDragTick(v => v + 1) }
  const releaseAllHPacks = () => { hPacksRef.current.forEach(p => { p.fx = null; p.fy = null; p.anchored = false }); hPackSimRef.current?.alpha(0.6).restart(); setDragTick(v => v + 1) }
  const fitTo = (cx, cy, r, dur = 640) => {
    if (!zoomRef.current || !svgRef.current) return
    const kk = Math.max(0.5, Math.min(48, D / (2 * r * 1.06)))
    const T = d3.zoomIdentity.translate(D / 2 - kk * cx, D / 2 - kk * cy).scale(kk)
    d3.select(svgRef.current).transition().duration(dur).call(zoomRef.current.transform, T)
  }
  const fitAll = () => { fitTo(D / 2, D / 2, D / 2, 480) }
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !groupProp) fitAll() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line
  const zoomed = t.k !== 1 || t.x !== 0 || t.y !== 0

  return (
    <div style={styles.wrap} onContextMenu={groupProp ? (e => e.preventDefault()) : undefined}>
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative' }}>
          <button style={styles.btn} onClick={() => setSrcMenu(o => !o)}>{groupProp ? '❃' : '⬡'} {trim(srcLabel, 16)} ▾</button>
          {srcMenu && (<>
            <div style={styles.backdrop} onClick={() => setSrcMenu(false)} />
            <div style={styles.menu} onClick={e => e.stopPropagation()}>
              <div style={{ ...styles.item, color: !groupProp ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp(null); setSrcMenu(false) }}>{!groupProp && '✓ '}Hierarchy (edges)</div>
              <div style={styles.mlabel}>Group by tag</div>
              {tagDefs.length ? tagDefs.map(d => (
                <div key={d.id} style={{ ...styles.item, color: groupProp === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp(d.id); setSrcMenu(false) }}>{groupProp === d.id && '✓ '}{d.name}</div>
              )) : <div style={{ ...styles.item, color: '#8090b8', fontSize: '0.74rem' }}>No Select/Tags property</div>}
              {dateDefs.length > 0 && <div style={styles.mlabel}>Group by due date</div>}
              {dateDefs.map(d => (
                <div key={d.id} style={{ ...styles.item, color: groupProp === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp(d.id); setSrcMenu(false) }}>{groupProp === d.id && '✓ '}{d.name} · buckets</div>
              ))}
            </div>
          </>)}
        </div>
        {/* Secondary "then by" grouping → nested circle pack (only for a tag primary, not date/hierarchy). */}
        {groupProp && rawGroupDef?.type !== 'date' && tagDefs.length > 1 && (
          <div style={{ position: 'relative' }}>
            <button style={styles.btn} onClick={() => setSrcMenu2(o => !o)}>then ▸ {trim(groupProp2 ? (propertyDefs.find(d => d.id === groupProp2)?.name || 'tag') : 'none', 12)} ▾</button>
            {srcMenu2 && (<>
              <div style={styles.backdrop} onClick={() => setSrcMenu2(false)} />
              <div style={styles.menu} onClick={e => e.stopPropagation()}>
                <div style={{ ...styles.item, color: !groupProp2 ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp2(null); setSrcMenu2(false) }}>{!groupProp2 && '✓ '}None</div>
                <div style={styles.mlabel}>Then group by</div>
                {tagDefs.filter(d => d.id !== groupProp).map(d => (
                  <div key={d.id} style={{ ...styles.item, color: groupProp2 === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp2(d.id); setSrcMenu2(false) }}>{groupProp2 === d.id && '✓ '}{d.name}</div>
                ))}
              </div>
            </>)}
          </div>
        )}
        {notionLinked && (
          <button style={styles.notionSaveBtn} onClick={handleSaveNotion} disabled={notionSave === 'saving'}
            title="Push all tag/field values back to the linked Notion database">
            {notionSave === 'saving' ? 'Saving…' : (notionSave || '⇧ Save → Notion')}
          </button>
        )}
      </div>
      <div style={styles.hint}>{nested ? 'nested packs (explore view) · click a circle to zoom · scroll = zoom · drag = pan' : groupProp ? 'drag an item onto another pack to retag · Alt-drag to add a 2nd tag · scroll = zoom · drag empty = pan' : 'scroll = zoom · drag = pan · click a circle to zoom'}</div>

      <FilterBar filter={filter} setFilter={setFilter} propertyDefs={propertyDefs} />
      {groupProp && !nested ? (
        <TagPackForce key={groupProp} def={groupDef} nodes={nodes} decorOf={decorOf} onRetagMany={retagMany}
          onCreateNode={handleCreateNode} onAddValue={handleAddValue} onHideNode={handleHideNode} onEditNode={setEditNodeId}
          filterFn={n => nodeVisible(n.id) && nodeMatchesFilter(n, filter, propertyDefs)}
          filterKey={filterKey + '|' + Object.keys(views.find(v => v.id === activeViewId)?.nodeProps || {}).filter(id => (views.find(v => v.id === activeViewId).nodeProps[id]?.visible === false)).length} />
      ) : (<>
        {hPacksRef.current.some(p => p.anchored) && <button style={{ ...styles.reset, bottom: 48 }} onClick={releaseAllHPacks}>⊙ Release packs</button>}
        {zoomed && <button style={styles.reset} onClick={fitAll}>⟳ Fit</button>}
        <svg ref={svgRef} viewBox={`0 0 ${D} ${D}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}>
          <g ref={hgRef} transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
            {descendants.map(d => {
              const isLeaf = !d.children
              const dStroke = d.data.stroke
              const { dx, dy } = hOffsetFor(d.data.id)
              const pk = d.depth === 1 ? hPackByIdRef.current[d.data.id] : null
              return (
                <circle key={d.data.id} data-hcirc="1" cx={d.x + dx} cy={d.y + dy} r={d.r}
                  fill={colorFor(d)} fillOpacity={isLeaf ? 0.92 : 0.45}
                  stroke={pk?.anchored ? '#7fd8a8' : (dStroke || '#0c0c1a')}
                  strokeWidth={pk?.anchored ? 2.5 / t.k : (dStroke ? Math.max(d.data.strokeWidth || 1.5, 1.4) / t.k : 1 / t.k)}
                  strokeDasharray={pk?.anchored ? `${6 / t.k} ${5 / t.k}` : undefined}
                  style={{ cursor: 'grab' }}
                  onMouseDown={e => startHDrag(e, d)}
                  onDoubleClick={e => { e.stopPropagation(); if (pk?.anchored) releaseHPack(d.data.id) }}
                  onClick={e => { e.stopPropagation(); if (didHDragRef.current) return; if (d.children) fitTo(d.x + dx, d.y + dy, d.r) }}
                />
              )
            })}
            {descendants.filter(d => d.depth > 0 && d.data.label).map(d => {
              const isLeaf = !d.children
              const { dx, dy } = hOffsetFor(d.data.id)
              const cx = d.x + dx, cy = d.y + dy
              const fontSize = isLeaf ? d.r * 0.34 : Math.min(d.r * 0.15, 16)
              const maxChars = Math.max(4, Math.floor((1.75 * d.r) / (fontSize * 0.56)))
              const lines = wrapText(d.data.label, maxChars).slice(0, isLeaf ? 8 : 2)
              const lh = fontSize * 1.08
              if (isLeaf) {
                const y0 = cy - (lines.length - 1) / 2 * lh
                return (
                  <text key={'t' + d.data.id} textAnchor="middle" dominantBaseline="middle" pointerEvents="none"
                    fontSize={fontSize} fill="#eef2ff"
                    style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.18, fontWeight: 600 }}>
                    {lines.map((ln, i) => <tspan key={i} x={cx} y={y0 + i * lh}>{ln}</tspan>)}
                  </text>
                )
              }
              const y0 = cy - d.r + fontSize * 1.1
              return (
                <text key={'t' + d.data.id} textAnchor="middle" dominantBaseline="hanging" pointerEvents="none"
                  fontSize={fontSize} fill="#cdd6f5"
                  style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.2, fontWeight: 600 }}>
                  {lines.map((ln, i) => <tspan key={i} x={cx} y={y0 + i * lh}>{ln}</tspan>)}
                </text>
              )
            })}
            {descendants.filter(d => d.data.emoji && d.r * t.k > 12).map(d => {
              const em = d.data.emoji, sz = Math.min(d.r * 0.28, 30)
              const { dx, dy } = hOffsetFor(d.data.id)
              const ex = d.x + dx + d.r * 0.5, ey = d.y + dy - d.r * 0.5
              return em.type === 'image'
                ? <image key={'e' + d.data.id} href={em.emoji} x={ex - sz / 2} y={ey - sz / 2} width={sz} height={sz} style={{ pointerEvents: 'none' }} />
                : <text key={'e' + d.data.id} x={ex} y={ey} fontSize={sz} textAnchor="middle" dominantBaseline="central" pointerEvents="none">{em.emoji}</text>
            })}
          </g>
        </svg>
        {descendants.length <= 1 && <div style={styles.empty}>Nothing to pack yet — add some nodes in the graph.</div>}
      </>)}
      {editNodeId && (
        <NodePropsEditor
          node={nodes.find(n => n.id === editNodeId)}
          propertyDefs={propertyDefs}
          onSet={(propId, value) => { setNodeProp(editNodeId, propId, value); persist() }}
          onAddOption={(propId, name) => addSelectOption(propId, name)}
          onClose={() => setEditNodeId(null)}
        />
      )}
    </div>
  )
}

// Modal: edit every property of a node (all types). Writes via onSet → store + persist.
function NodePropsEditor({ node, propertyDefs, onSet, onAddOption, onClose }) {
  if (!node) return null
  const props = node.props || {}
  return (
    <div style={npe.backdrop} onMouseDown={onClose}>
      <div style={npe.panel} onMouseDown={e => e.stopPropagation()}>
        <div style={npe.head}>
          <span style={npe.title}>{node.label || '(untitled)'}</span>
          <button style={npe.close} onClick={onClose}>×</button>
        </div>
        {!propertyDefs.length && <div style={{ color: '#8090b8', fontSize: '0.82rem', padding: '8px 2px' }}>This project has no properties yet.</div>}
        <div style={npe.rows}>
          {propertyDefs.map(def => (
            <div key={def.id} style={npe.row}>
              <div style={npe.key}>{def.name}</div>
              <div style={npe.val}><PropInput def={def} value={props[def.id]} onSet={v => onSet(def.id, v)} onAddOption={name => onAddOption(def.id, name)} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function PropInput({ def, value, onSet, onAddOption }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  if (def.type === 'checkbox') return <input type="checkbox" checked={!!value} onChange={e => onSet(e.target.checked)} />
  if (def.type === 'number') return <input type="number" value={value ?? ''} onChange={e => onSet(e.target.value === '' ? null : Number(e.target.value))} style={npe.input} />
  if (def.type === 'date') return <input type="date" value={value ? String(value).slice(0, 10) : ''} onChange={e => onSet(e.target.value || null)} style={npe.input} />
  if (def.type === 'url' || def.type === 'text') return <input type="text" value={value ?? ''} onChange={e => onSet(e.target.value)} style={npe.input} placeholder="—" />
  if (def.type === 'select' || def.type === 'multiSelect') {
    const opts = def.options || []
    const selected = def.type === 'multiSelect' ? (Array.isArray(value) ? value : (value ? [value] : [])) : (value ? [value] : [])
    const toggle = (id) => {
      if (def.type === 'multiSelect') { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); onSet([...s]) }
      else onSet(selected[0] === id ? null : id)
    }
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
        {opts.map(o => {
          const on = selected.includes(o.id)
          return <button key={o.id} onClick={() => toggle(o.id)}
            style={{ ...npe.chip, background: on ? (o.color || '#5b6af0') : 'transparent', borderColor: o.color || '#5b6af0', color: on ? '#0c0c1a' : '#c5d0ff', fontWeight: on ? 700 : 400 }}>{o.name}</button>
        })}
        {adding
          ? <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) { onAddOption(draft.trim()); setDraft(''); setAdding(false) } if (e.key === 'Escape') { setDraft(''); setAdding(false) } }}
              onBlur={() => { if (draft.trim()) onAddOption(draft.trim()); setDraft(''); setAdding(false) }}
              placeholder="new value…" style={{ ...npe.input, width: 90 }} />
          : <button style={npe.addChip} onClick={() => setAdding(true)}>+ value</button>}
      </div>
    )
  }
  return <span style={{ color: '#8090b8' }}>—</span>
}

const npe = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,5,14,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  panel: { width: 'min(460px, 92vw)', maxHeight: '82vh', overflow: 'auto', background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 12, padding: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: '#e8eeff', fontSize: '1rem', fontWeight: 700 },
  close: { background: 'transparent', border: 'none', color: '#8090b8', fontSize: '1.3rem', cursor: 'pointer', lineHeight: 1 },
  rows: { display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, alignItems: 'start' },
  key: { color: '#8ab4ff', fontSize: '0.8rem', paddingTop: 5 },
  val: { minWidth: 0 },
  input: { width: '100%', background: '#0f0f22', border: '1px solid #2d3a6a', color: '#e8eeff', borderRadius: 6, padding: '5px 8px', fontSize: '0.82rem', outline: 'none' },
  chip: { border: '1px solid', borderRadius: 100, padding: '3px 10px', fontSize: '0.76rem', cursor: 'pointer' },
  addChip: { border: '1px dashed #3a4a8a', background: 'transparent', color: '#8ab4ff', borderRadius: 100, padding: '3px 10px', fontSize: '0.76rem', cursor: 'pointer' },
}

// ─────────────────────────────────────────────────────────────────────────────
// Clustered force packing for group-by-tag. One d3 force sim; packs are laid out with
// packSiblings so they bunch tightly and never overlap. Each item is a bubble that carries
// its full label. Drag a bubble onto another pack → onRetag → it glides into the new pack.
// (Proven engine ported from the PackLab prototype.)
// ─────────────────────────────────────────────────────────────────────────────
const FW = 1100, FH = 760
const NODE_COLORS = ['#7c8cff', '#4fd1c5', '#f6ad55', '#fc8181', '#b794f4', '#68d391', '#f6e05e', '#63b3ed', '#f687b3', '#a0aec0']
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const radiusFor = (label) => {
  // Tight band so bubbles read as one uniform size (long labels get only a little more room → wrap).
  const len = String(label || '').replace(/\s+/g, ' ').trim().length
  return Math.max(34, Math.min(50, 30 + Math.sqrt(Math.max(len, 4)) * 3.0))
}
// World font size that keeps a label between [minPx, maxPx] on SCREEN regardless of zoom k
// (content lives inside a scale(k) group, so we counter-scale by 1/k, clamped).
const zfont = (basePx, k, minPx, maxPx) => Math.max(minPx, Math.min(maxPx, basePx * (k || 1))) / (k || 1)

// ── Due-date bucketing: group a date property into relative windows. Past/empty → unpacked. ──
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
  if (days < 0) return null            // overdue / past → unpacked (per spec)
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
const dueDefFor = (rawDef) => ({ id: rawDef.id, realId: rawDef.id, name: rawDef.name, type: 'dateBucket', options: DUE_BUCKETS })
// Circular fisheye distortion (Bostock's d3.fisheye.circular). Returns a fn mapping a point near
// `focus` outward (magnified) within `radius`; z is the local magnification factor.
const makeFisheye = (focus, radius, distortion) => {
  let k0 = Math.exp(distortion); k0 = k0 / (k0 - 1) * radius; const k1 = distortion / radius
  return (x, y) => {
    const dx = x - focus[0], dy = y - focus[1], dd = Math.hypot(dx, dy)
    if (!dd || dd >= radius) return { x, y, z: 1 }
    const k = k0 * (1 - Math.exp(-dd * k1)) / dd * 0.75 + 0.25
    return { x: focus[0] + dx * k, y: focus[1] + dy * k, z: Math.min(k, 4) }
  }
}
// Relative luminance of a #rrggbb colour → pick legible text (dark on light fills, light on dark).
const hexLum = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0.35
  const n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
  const f = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function TagPackForce({ def, nodes, decorOf, onRetagMany, onCreateNode, onAddValue, onHideNode, onEditNode, filterFn, filterKey }) {
  const svgRef = useRef(null)
  const gRef = useRef(null)
  const simRef = useRef(null)          // member bubbles sim
  const packSimRef = useRef(null)      // pack-circles sim (self-bunching, non-overlapping, draggable)
  const bubblesRef = useRef([])
  const packsRef = useRef([])          // [{gi,opt,name,color,r,x,y,fx,fy,anchored}]
  const groupsRef = useRef([])
  const zoomRef = useRef(null)
  const selectedRef = useRef(new Set())
  const heldKeysRef = useRef(new Set())
  const [, setTick] = useState(0)
  const [tf, setTf] = useState(d3.zoomIdentity)
  const [heldKeys, setHeldKeysState] = useState(() => new Set())
  const [hoverGroup, setHoverGroup] = useState(null)   // >=0 pack index, -1 = untag (outside all packs)
  const [selected, setSelected] = useState(() => new Set())
  const [anchoredTick, setAnchoredTick] = useState(0)  // re-render when a pack is (un)anchored
  const [ctx, setCtx] = useState(null)   // right-click menu { sx, sy, opt, packName }
  const [fisheye, setFisheye] = useState(false)   // hover magnifier lens toggle
  const focusRef = useRef(null)          // current lens focus in world coords, or null
  const setHeldKeys = (s) => { heldKeysRef.current = s; setHeldKeysState(s) }

  // Desired bubbles + real packs from the store. One bubble per (node, tag value); multi-tag nodes
  // are mirrored. UNTAGGED nodes get group -1 → no pack, just a weak pull to the centroid.
  const build = () => {
    const opts = def?.options || []
    const groups = opts.map(o => ({ opt: o.id, name: o.name, color: o.color || '#5b6af0' }))
    const idx = new Map(groups.map((g, i) => [g.opt, i]))
    const isDate = def?.type === 'dateBucket'
    const now = isDate ? startOfDay(new Date()) : null
    const raw = []
    nodes.forEach(n => {
      if (filterFn && !filterFn(n)) return   // filtered-out items are removed → packs re-pack around the rest
      if (isDate) {
        const bid = dueBucketOf(n.props?.[def.realId], now)   // null = past/empty → unpacked
        const gi = bid != null ? idx.get(bid) : undefined
        const explicit = decorOf?.(n.id)?.color || null
        const label = n.label || '(untitled)'
        if (gi == null) raw.push({ nodeId: n.id, opt: '__untagged__', group: -1, label, color: explicit || '#6b7394' })
        else raw.push({ nodeId: n.id, opt: bid, group: gi, label, color: explicit || groups[gi].color })
        return
      }
      const v = n.props?.[def.id]
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v != null && v !== '' ? [v] : [])
      const valid = ids.filter(id => idx.has(id))
      // Colour is intentional, not random: a node's own graph fill wins; otherwise the bubble takes
      // its PACK's value colour (so every item in a pack shares a colour). Untagged → neutral grey.
      const explicit = decorOf?.(n.id)?.color || null
      const label = n.label || '(untitled)'
      if (!valid.length) raw.push({ nodeId: n.id, opt: '__untagged__', group: -1, label, color: explicit || '#6b7394' })
      else valid.forEach(id => { const gi = idx.get(id); raw.push({ nodeId: n.id, opt: id, group: gi, label, color: explicit || groups[gi].color }) })
    })
    raw.forEach(b => { b.key = b.nodeId + '@' + b.opt; b.r = radiusFor(b.label) })
    return { groups, bubbles: raw }
  }

  // Pack radius = the MINIMUM circle that holds its members (tight-pack them with packSiblings,
  // take the enclosing radius). Recomputed on every membership change → packs shrink/grow to fit.
  const rFit = (gi, bubbles) => {
    const circles = []
    bubbles.forEach(b => { if (b.group === gi) circles.push({ r: b.r + 3 }) })
    if (!circles.length) return 46
    d3.packSiblings(circles)
    const enc = d3.packEnclose(circles) || { r: 46 }
    // Seed radius only — the sim then eases each pack down to hug its actual member cloud (tight).
    return Math.max(46, (enc.r || 46) * 1.05) + 6
  }

  // Create both sims once. Packs: collide (never overlap) + gentle centre gravity → self-bunching.
  // Members: pull to their pack centre, collide, and are HARD-CONTAINED inside the pack circle each
  // tick (so belonging is unambiguous and packs can't visually overrun each other).
  useEffect(() => {
    const packSim = d3.forceSimulation([])
      .force('x', d3.forceX(FW / 2).strength(0.09))
      .force('y', d3.forceY(FH / 2).strength(0.09))
      .force('collide', d3.forceCollide(p => p.r + 3).strength(1).iterations(3))
      .alphaDecay(0.03).velocityDecay(0.72)
      .on('tick', () => {
        // Hard no-overlap: separate any pair of packs that still overlaps (collide can lag under
        // drag/anchor). Anchored packs (fx set) stay put; the other one yields.
        const packs = packsRef.current, GAP = 3
        for (let i = 0; i < packs.length; i++) for (let j = i + 1; j < packs.length; j++) {
          const a = packs[i], b = packs[j]
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + GAP
          if (d < min) {
            const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d
            const aFix = a.fx != null, bFix = b.fx != null
            if (aFix && !bFix) { b.x += ux * push; b.y += uy * push }
            else if (bFix && !aFix) { a.x -= ux * push; a.y -= uy * push }
            else if (!aFix && !bFix) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
          }
        }
        setTick(t => t + 1)
      })
    packSimRef.current = packSim

    const sim = d3.forceSimulation([])
      .force('charge', d3.forceManyBody().strength(-5))
      .force('collide', d3.forceCollide(b => b.r + 2).strength(0.9))
      .alphaDecay(0.05).velocityDecay(0.72)   // cool fast + damp hard → short, calm settles (no long storm)
      .on('tick', () => {
        const packs = packsRef.current, held = heldKeysRef.current
        const bs = bubblesRef.current
        // Iterate the constraints so they actually CONVERGE within a tick. Order per pass:
        //   1) push out of packs you don't belong to, 2) keep inside your own pack,
        //   3) member–member separation LAST → node-node non-overlap is the constraint that wins.
        for (let pass = 0; pass < 3; pass++) {
          for (const b of bs) {
            if (b.fx != null || held.has(b.key)) continue
            const own = b.group >= 0 ? packs[b.group] : null
            for (const c of packs) {
              if (c === own) continue
              const dx = b.x - c.x, dy = b.y - c.y, d = Math.hypot(dx, dy), min = c.r + b.r + 2
              if (d < min) { const dd = d || 1; b.x = c.x + dx / dd * min; b.y = c.y + dy / dd * min; b.vx *= 0.4; b.vy *= 0.4 }
            }
            if (own) {
              const dx = b.x - own.x, dy = b.y - own.y, d = Math.hypot(dx, dy) || 1
              const max = Math.max(0, own.r - b.r - 2)
              if (d > max) { b.x = own.x + dx / d * max; b.y = own.y + dy / d * max; b.vx *= 0.4; b.vy *= 0.4 }
            }
          }
          for (let i = 0; i < bs.length; i++) {
            const a = bs[i]
            for (let j = i + 1; j < bs.length; j++) {
              const b = bs[j]
              const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 1.5
              if (d < min) {
                const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d
                const aFix = a.fx != null || held.has(a.key), bFix = b.fx != null || held.has(b.key)
                if (aFix && !bFix) { b.x += ux * push; b.y += uy * push }
                else if (bFix && !aFix) { a.x -= ux * push; a.y -= uy * push }
                else if (!aFix && !bFix) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
              }
            }
          }
        }
        // Re-center each pack on its members' CENTROID, and ease its radius toward a STABLE target
        // (rTarget = the tight packSiblings enclosure of its members, computed only on membership
        // change). Sizing to the *live* member spread inflated the radius when neighbouring packs
        // shoved members outward — a feedback loop that let packs overlap. A fixed target breaks it,
        // so the pack-pack separation below converges to genuinely non-overlapping circles.
        for (const p of packs) {
          let cx = 0, cy = 0, n = 0
          for (const b of bs) { if (b.group === p.gi) { cx += b.x; cy += b.y; n++ } }
          if (n && p.fx == null) { cx /= n; cy /= n; p.x += (cx - p.x) * 0.15; p.y += (cy - p.y) * 0.15 }
          const target = n ? (p.rTarget || 46) : 44
          p.r += (target - p.r) * 0.2
        }
        // Keep packs apart here too — the member sim outlives the pack sim, and centroid tracking
        // above can nudge a pack toward a neighbour after that sim has cooled. Anchored packs win.
        for (let i = 0; i < packs.length; i++) for (let j = i + 1; j < packs.length; j++) {
          const a = packs[i], b = packs[j]
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r + 3
          if (d < min) {
            const dd = d || 1, ux = dx / dd, uy = dy / dd, push = min - d
            const aFix = a.fx != null, bFix = b.fx != null
            if (aFix && !bFix) { b.x += ux * push; b.y += uy * push }
            else if (bFix && !aFix) { a.x -= ux * push; a.y -= uy * push }
            else if (!aFix && !bFix) { a.x -= ux * push / 2; a.y -= uy * push / 2; b.x += ux * push / 2; b.y += uy * push / 2 }
          }
        }
        setTick(t => t + 1)
      })
    simRef.current = sim
    return () => { packSim.stop(); sim.stop() }
  }, [])

  const structureKey = useMemo(() => {
    const opt = (def?.options || []).map(o => o.id + ':' + o.name).join('|')
    const rows = nodes.map(n => n.id + '=' + JSON.stringify(n.props?.[def.id] ?? null) + ':' + (n.label || '')).join(';')
    return opt + '#' + rows
  }, [nodes, def])

  // Reconcile packs + bubbles whenever tags/filter change. Packs keep their position + anchor across
  // retags (matched by opt); only their radius adapts, and the pack sim eases neighbours apart — so
  // moving one item never makes the whole board fly.
  useEffect(() => {
    const { groups, bubbles } = build()
    groupsRef.current = groups
    // seed positions for brand-new packs via packSiblings (nice initial bunch)
    const gc = groups.map((g, gi) => ({ r: rFit(gi, bubbles) }))
    d3.packSiblings(gc); const enc = d3.packEnclose(gc) || { x: 0, y: 0 }
    const prevPacks = new Map((packsRef.current || []).map(p => [p.opt, p]))
    const packs = groups.map((g, gi) => {
      const ex = prevPacks.get(g.opt)
      if (ex) { ex.gi = gi; ex.name = g.name; ex.color = g.color; return ex }   // keep measured radius
      return { gi, opt: g.opt, name: g.name, color: g.color, r: gc[gi].r,
        x: FW / 2 + (gc[gi].x - enc.x), y: FH / 2 + (gc[gi].y - enc.y), anchored: false }
    })
    // Stable per-pack target radius (tight enclosure of its current members). The tick eases the
    // live radius toward this instead of chasing transient member scatter → no inflation, no overlap.
    packs.forEach(p => { p.rTarget = rFit(p.gi, bubbles) })
    packsRef.current = packs

    const prev = bubblesRef.current || []
    const prevByKey = new Map(prev.map(b => [b.key, b]))
    const prevByNode = new Map(); prev.forEach(b => { if (!prevByNode.has(b.nodeId)) prevByNode.set(b.nodeId, b) })
    const next = bubbles.map(d => {
      const ex = prevByKey.get(d.key)
      if (ex) { ex.group = d.group; ex.r = d.r; ex.color = d.color; ex.label = d.label; return ex }
      const seed = prevByNode.get(d.nodeId)
      const c = d.group >= 0 ? packs[d.group] : { x: FW / 2, y: FH / 2 }
      const j = (hashStr(d.key) % 24) - 12
      return { ...d, x: seed?.x ?? c.x + j, y: seed?.y ?? c.y + j, vx: 0, vy: 0 }
    })
    bubblesRef.current = next
    const live = new Set(next.map(b => b.key))
    const sel = new Set([...selectedRef.current].filter(k => live.has(k)))
    if (sel.size !== selectedRef.current.size) { selectedRef.current = sel; setSelected(sel) }

    const packSim = packSimRef.current, sim = simRef.current; if (!packSim || !sim) return
    packSim.nodes(packs); packSim.alpha(0.35).restart()
    sim.nodes(next)
    sim.force('x', d3.forceX(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].x : FW / 2).strength(b => b.group >= 0 ? 0.5 : 0.04))
    sim.force('y', d3.forceY(b => (b.group >= 0 && packsRef.current[b.group]) ? packsRef.current[b.group].y : FH / 2).strength(b => b.group >= 0 ? 0.5 : 0.04))
    sim.alpha(0.45).restart()
    setTick(t => t + 1)
  }, [structureKey, filterKey]) // eslint-disable-line

  // Pan / zoom (bubble + pack drags fall through the filter; empty-canvas drag pans).
  useEffect(() => {
    if (!svgRef.current) return
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.06, 8])
      .filter(e => {
        if (e.type === 'mousedown' && e.target?.closest?.('[data-bubble],[data-pack]')) return false
        return !e.ctrlKey && !e.button
      })
      .on('zoom', e => setTf(e.transform))
    zoomRef.current = zoom
    sel.call(zoom)
    return () => sel.on('.zoom', null)
  }, [])
  const fitAll = () => {
    if (!zoomRef.current || !svgRef.current) return
    const bs = bubblesRef.current || [], ps = packsRef.current || []
    const all = [...ps.map(p => ({ x: p.x, y: p.y, r: p.r })), ...bs.map(b => ({ x: b.x || 0, y: b.y || 0, r: b.r }))]
    if (!all.length) { d3.select(svgRef.current).transition().duration(420).call(zoomRef.current.transform, d3.zoomIdentity); return }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    all.forEach(o => { minX = Math.min(minX, o.x - o.r); minY = Math.min(minY, o.y - o.r); maxX = Math.max(maxX, o.x + o.r); maxY = Math.max(maxY, o.y + o.r) })
    const pad = 60, w = (maxX - minX) + pad * 2, h = (maxY - minY) + pad * 2
    const k = Math.min(4, Math.max(0.06, Math.min(FW / w, FH / h)))
    const tx = FW / 2 - k * (minX + maxX) / 2, ty = FH / 2 - k * (minY + maxY) / 2
    d3.select(svgRef.current).transition().duration(420).call(zoomRef.current.transform, d3.zoomIdentity.translate(tx, ty).scale(k))
  }
  // Open with everything in view: fit once the layout has settled, and again when the grouping changes.
  useEffect(() => {
    const t = setTimeout(fitAll, 700)
    return () => clearTimeout(t)
  }, [def?.id]) // eslint-disable-line

  const toWorld = (ev) => {
    const g = gRef.current, svg = svgRef.current
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY
    const loc = pt.matrixTransform(g.getScreenCTM().inverse())
    return { x: loc.x, y: loc.y }
  }
  const dropTarget = (p) => {
    let best = null, bd = Infinity
    packsRef.current.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (d < bd) { bd = d; best = i } })
    const c = packsRef.current[best]
    if (best == null || !c) return -1
    return Math.hypot(p.x - c.x, p.y - c.y) > c.r + 30 ? -1 : best   // outside every pack → untag
  }

  const setSel = (next) => { selectedRef.current = next; setSelected(next) }
  const toggleSelect = (key, additive) => {
    const prev = selectedRef.current
    const next = new Set(additive ? prev : [])
    if (additive && prev.has(key)) next.delete(key); else next.add(key)
    setSel(next)
  }

  // ── Drag a pack → it anchors where you drop it; members follow. Double-click / badge releases it.
  const startPackDrag = (e, pack) => {
    if (e.button === 2) return   // let right-click open the context menu, not drag
    e.preventDefault(); e.stopPropagation()
    const p0 = toWorld(e); const ox = pack.x - p0.x, oy = pack.y - p0.y
    packSimRef.current.alphaTarget(0.2).restart()
    simRef.current.alphaTarget(0.15).restart()   // keep members warm so they follow + get shoved aside (gentle)
    const move = ev => {
      const p = toWorld(ev); let x = p.x + ox, y = p.y + oy
      // clamp the dragged pack out of every other pack so packs never overlap
      for (const c of packsRef.current) {
        if (c === pack) continue
        const dx = x - c.x, dy = y - c.y, d = Math.hypot(dx, dy), min = pack.r + c.r + 7
        if (d < min) { const dd = d || 1; x = c.x + dx / dd * min; y = c.y + dy / dd * min }
      }
      pack.fx = x; pack.fy = y; pack.x = x; pack.y = y; setTick(t => t + 1)
    }
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      pack.anchored = true            // fx/fy retained → stays put under the force layout
      packSimRef.current.alphaTarget(0); simRef.current.alphaTarget(0)
      setAnchoredTick(t => t + 1)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const releasePack = (pack) => { pack.fx = null; pack.fy = null; pack.anchored = false; packSimRef.current.alpha(0.5).restart(); setAnchoredTick(t => t + 1) }
  const releaseAllPacks = () => { packsRef.current.forEach(p => { p.fx = null; p.fy = null; p.anchored = false }); packSimRef.current.alpha(0.6).restart(); setAnchoredTick(t => t + 1) }

  // ── Press a bubble → click selects; drag moves it (or the whole selection) and retags on drop.
  const startPress = (e, b) => {
    if (e.button === 2) return   // right-click → context menu, not drag/select
    e.preventDefault(); e.stopPropagation()
    const sim = simRef.current
    const start = toWorld(e)
    const groupMove = selectedRef.current.has(b.key) && selectedRef.current.size > 1
    const keys = groupMove ? [...selectedRef.current] : [b.key]
    const moving = bubblesRef.current.filter(x => keys.includes(x.key))
    const offs = moving.map(x => ({ b: x, dx: x.x - start.x, dy: x.y - start.y }))
    let moved = false
    const onMove = ev => {
      const p = toWorld(ev)
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > 9) {
        moved = true; setHeldKeys(new Set(keys))   // bigger threshold so a click doesn't become a drag; no reheat while dragging
      }
      if (moved) {
        offs.forEach(o => { o.b.fx = p.x + o.dx; o.b.fy = p.y + o.dy; o.b.x = o.b.fx; o.b.y = o.b.fy })
        setHoverGroup(dropTarget(p)); setTick(t => t + 1)
      }
    }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!moved) { toggleSelect(b.key, ev.shiftKey || ev.metaKey || ev.ctrlKey); return }
      const p = toWorld(ev)
      offs.forEach(o => { o.b.fx = null; o.b.fy = null })
      setHeldKeys(new Set()); setHoverGroup(null); sim.alphaTarget(0)
      const tg = dropTarget(p)
      const groups = groupsRef.current
      const targetOpt = tg < 0 ? '__untagged__' : groups[tg].opt
      const additive = def.type === 'multiSelect' && ev.altKey
      const list = offs
        .map(o => ({ nodeId: o.b.nodeId, sourceOpt: o.b.opt }))
        .filter(it => tg < 0 ? it.sourceOpt !== '__untagged__' : (targetOpt !== it.sourceOpt || additive))
      if (list.length) { onRetagMany(list, targetOpt, additive) }
      // else: dropped back in the same pack → leave it exactly where placed, no restart (no storm)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const bubbles = bubblesRef.current
  const packs = packsRef.current
  const dragging = heldKeys.size > 0
  const zoomed = tf.k !== 1 || tf.x !== 0 || tf.y !== 0
  const untaggedCount = bubbles.filter(b => b.group === -1).length
  const anchoredAny = packs.some(p => p.anchored)
  const clearSelection = () => { if (selectedRef.current.size) setSel(new Set()) }
  // Right-click → context menu. Proximity to a pack decides which value a new item gets tagged with.
  const onBgContext = (e) => {
    e.preventDefault()
    const p = toWorld(e); const tg = dropTarget(p)
    const g = tg >= 0 ? groupsRef.current[tg] : null
    let hit = null
    for (const b of bubblesRef.current) { if (Math.hypot(p.x - (b.x || 0), p.y - (b.y || 0)) <= b.r) hit = b }  // topmost bubble under cursor
    setCtx({ sx: e.clientX, sy: e.clientY, opt: g ? g.opt : '__untagged__', packName: g ? g.name : null, nodeId: hit?.nodeId, label: hit?.label })
  }
  void anchoredTick
  // Active fisheye lens (only while toggled on and the cursor is over the canvas).
  const fe = (fisheye && focusRef.current) ? makeFisheye(focusRef.current, 300, 3) : null
  const onCanvasMove = (e) => {
    if (!fisheye) return
    focusRef.current = toWorld(e); setTick(t => t + 1)
  }
  const onCanvasLeave = () => { if (focusRef.current) { focusRef.current = null; setTick(t => t + 1) } }

  return (<>
    {selected.size > 0 && <div style={styles.selBadge}>{selected.size} selected</div>}
    <button style={{ ...styles.reset, bottom: anchoredAny ? 82 : 48, background: fisheye ? '#1a2f4a' : 'rgba(18,18,42,0.9)', color: fisheye ? '#8ecbff' : '#c5d0ff' }}
      onClick={() => { setFisheye(o => { if (o) focusRef.current = null; return !o }) }} title="Hover magnifier lens">🔍 Lens {fisheye ? 'on' : 'off'}</button>
    {anchoredAny && <button style={{ ...styles.reset, bottom: 48 }} onClick={releaseAllPacks}>⊙ Release packs</button>}
    {zoomed && <button style={styles.reset} onClick={fitAll}>⟳ Fit</button>}
    {!bubbles.length && <div style={styles.empty}>No items — tag some nodes with “{def?.name}” in the graph or table.</div>}
    {ctx && (<>
      <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onMouseDown={() => setCtx(null)} onContextMenu={e => { e.preventDefault(); setCtx(null) }} />
      <div style={{ position: 'fixed', left: ctx.sx, top: ctx.sy, zIndex: 41, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 200, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' }} onMouseDown={e => e.stopPropagation()}>
        {ctx.nodeId && (
          <div style={styles.item} onClick={() => { const c = ctx; setCtx(null); onEditNode && onEditNode(c.nodeId) }}>
            ✎ Edit properties of “{trim(ctx.label, 16)}”
          </div>
        )}
        {ctx.nodeId && (
          <div style={styles.item} onClick={() => { const c = ctx; setCtx(null); onHideNode && onHideNode(c.nodeId) }}>
            Hide “{trim(ctx.label, 18)}” in this view
          </div>
        )}
        {ctx.nodeId && <div style={{ borderTop: '1px solid #2a3358', margin: '3px 6px' }} />}
        <div style={styles.item} onClick={() => { const c = ctx; setCtx(null); const nm = prompt(c.packName ? `New item in “${c.packName}”` : 'New item (untagged)'); if (nm != null) onCreateNode && onCreateNode(nm, c.opt) }}>
          + New item{ctx.packName ? ` in “${trim(ctx.packName, 16)}”` : ' (untagged)'}
        </div>
        {def?.type !== 'dateBucket' && (
          <div style={styles.item} onClick={() => { setCtx(null); const nm = prompt(`New “${def?.name}” value`); if (nm) onAddValue && onAddValue(nm) }}>
            + Add “{trim(def?.name, 16)}” value…
          </div>
        )}
      </div>
    </>)}
    <svg ref={svgRef} viewBox={`0 0 ${FW} ${FH}`} preserveAspectRatio="xMidYMid meet" style={styles.svg} onContextMenu={onBgContext}
      onMouseMove={onCanvasMove} onMouseLeave={onCanvasLeave}>
      <rect x={0} y={0} width={FW} height={FH} fill="transparent" onMouseDown={clearSelection} />
      <g ref={gRef} transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
        {untaggedCount > 0 && (
          <text x={FW / 2} y={26} textAnchor="middle" fontSize={15} fill="#8090b8" pointerEvents="none">
            untagged: {untaggedCount} — drag one onto a pack to tag it · drag a tagged item to open space to untag
          </text>
        )}
        {/* Pack circles: fixed boundary, members contained inside. Drag to anchor, double-click to release. */}
        {packs.map(p => {
          const isTarget = dragging && hoverGroup === p.gi
          const count = bubbles.filter(b => b.group === p.gi).length
          return (
            <g key={'o' + p.gi} data-pack="1" style={{ cursor: 'grab' }}
              onMouseDown={e => startPackDrag(e, p)} onDoubleClick={e => { e.stopPropagation(); if (p.anchored) releasePack(p) }}>
              <circle cx={p.x} cy={p.y} r={p.r} fill={p.color + '1e'}
                stroke={isTarget ? '#7fd8a8' : p.color} strokeWidth={isTarget ? 4 : 2.5}
                strokeDasharray={p.anchored ? '2 7' : undefined} />
              {p.anchored && (
                <text x={p.x} y={p.y - p.r + 14} textAnchor="middle" fontSize={18} fill={p.color}
                  style={{ cursor: 'pointer' }} onMouseDown={e => { e.stopPropagation(); releasePack(p) }}>⊙</text>
              )}
            </g>
          )
        })}
        {bubbles.map(b => {
          const held = heldKeys.has(b.key)
          const isSel = selected.has(b.key)
          const light = hexLum(b.color) > 0.55
          const textFill = light ? '#0c0c1a' : '#f2f5ff'
          // Fisheye: displace + magnify near the lens focus. No lens → identity.
          const disp = fe ? fe(b.x || 0, b.y || 0) : { x: b.x || 0, y: b.y || 0, z: 1 }
          const er = b.r * disp.z
          const fsc = Math.max(11, Math.min(13.5 * disp.z, er * 0.28))   // grows with magnified radius
          const maxChars = Math.max(5, Math.floor((1.7 * er) / (fsc * 0.56)))
          const lines = wrapText(b.label, maxChars).slice(0, 6)
          const lh = fsc * 1.05
          const y0 = -(lines.length - 1) / 2 * lh
          const stroke = held ? '#ffffff' : isSel ? '#ffd34d' : 'rgba(232,238,255,0.4)'
          const sw = held ? 4 : isSel ? 3.5 : 1.25
          return (
            <g key={b.key} data-bubble="1" transform={`translate(${disp.x},${disp.y})`}
              style={{ cursor: 'grab' }} onMouseDown={e => startPress(e, b)}>
              <circle r={er} fill={b.color} fillOpacity={0.96} stroke={stroke} strokeWidth={sw} />
              <text textAnchor="middle" dominantBaseline="middle" fontSize={fsc} fill={textFill} pointerEvents="none"
                style={{ fontWeight: 700, paintOrder: 'stroke', stroke: light ? 'rgba(255,255,255,0.45)' : 'rgba(12,12,26,0.55)', strokeWidth: fsc * 0.13 }}>
                {lines.map((ln, i) => <tspan key={i} x={0} y={y0 + i * lh}>{ln}</tspan>)}
              </text>
            </g>
          )
        })}
        {/* Pack titles LAST so they sit on top of every bubble, with a heavy outline for legibility. */}
        {packs.map(p => {
          const count = bubbles.filter(b => b.group === p.gi).length
          const isTarget = dragging && hoverGroup === p.gi
          const zf = zfont(25, tf.k, 15, 40)   // clamp title to 15–40px on screen
          return (
            <text key={'t' + p.gi} x={p.x} y={p.y - p.r - zf * 0.45} textAnchor="middle" fontSize={zf} fontWeight={800}
              fill={isTarget ? '#7fd8a8' : p.color} pointerEvents="none"
              style={{ paintOrder: 'stroke', stroke: '#05060f', strokeWidth: zf * 0.24, strokeLinejoin: 'round' }}>
              {p.name} · {count}
            </text>
          )
        })}
      </g>
    </svg>
  </>)
}

// ── Notion-style filter (text + property rules, ANDed) ───────────────────────
const OPS = {
  select: ['is', 'is not', 'is empty', 'not empty'],
  multiSelect: ['contains', 'not contains', 'is empty', 'not empty'],
  number: ['=', '≠', '>', '<', '≥', '≤', 'is empty', 'not empty'],
  date: ['before', 'after', 'on', 'is empty', 'not empty'],
  text: ['contains', 'not contains', 'is empty', 'not empty'],
  url: ['contains', 'is empty', 'not empty'],
  checkbox: ['checked', 'unchecked'],
}
const needsValue = (op) => !['is empty', 'not empty', 'checked', 'unchecked'].includes(op)

function ruleMatches(node, rule, def) {
  const v = node.props?.[rule.propId]
  const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0)
  switch (rule.op) {
    case 'is empty': return empty
    case 'not empty': return !empty
    case 'is': return v === rule.value
    case 'is not': return v !== rule.value
    case 'contains': return def.type === 'multiSelect' ? (Array.isArray(v) && v.includes(rule.value)) : String(v || '').toLowerCase().includes(String(rule.value || '').toLowerCase())
    case 'not contains': return def.type === 'multiSelect' ? !(Array.isArray(v) && v.includes(rule.value)) : !String(v || '').toLowerCase().includes(String(rule.value || '').toLowerCase())
    case '=': return Number(v) === Number(rule.value)
    case '≠': return Number(v) !== Number(rule.value)
    case '>': return Number(v) > Number(rule.value)
    case '<': return Number(v) < Number(rule.value)
    case '≥': return Number(v) >= Number(rule.value)
    case '≤': return Number(v) <= Number(rule.value)
    case 'before': return !!v && !!rule.value && String(v) < String(rule.value)
    case 'after': return !!v && !!rule.value && String(v) > String(rule.value)
    case 'on': return !!v && !!rule.value && String(v).slice(0, 10) === String(rule.value).slice(0, 10)
    case 'checked': return !!v
    case 'unchecked': return !v
    default: return true
  }
}
function nodeMatchesFilter(node, filter, propertyDefs) {
  const t = (filter.text || '').trim().toLowerCase()
  if (t && !String(node.label || '').toLowerCase().includes(t)) return false
  for (const rule of filter.rules || []) {
    if (!rule.propId || !rule.op) continue
    const def = propertyDefs.find(d => d.id === rule.propId)
    if (!def) continue
    if (needsValue(rule.op) && (rule.value == null || rule.value === '')) continue // incomplete rule → ignore
    if (!ruleMatches(node, rule, def)) return false
  }
  return true
}

function FilterBar({ filter, setFilter, propertyDefs }) {
  const [open, setOpen] = useState(false)
  const filterable = propertyDefs.filter(d => OPS[d.type])
  const rules = filter.rules || []
  const setRule = (i, patch) => setFilter(f => ({ ...f, rules: f.rules.map((r, j) => j === i ? { ...r, ...patch } : r) }))
  const addRule = () => { const d = filterable[0]; if (!d) return; setFilter(f => ({ ...f, rules: [...(f.rules || []), { propId: d.id, op: OPS[d.type][0], value: '' }] })); setOpen(true) }
  const delRule = (i) => setFilter(f => ({ ...f, rules: f.rules.filter((_, j) => j !== i) }))
  const active = rules.length + (filter.text ? 1 : 0)
  return (
    <div style={styles.filterBox}>
      <input value={filter.text || ''} onChange={e => setFilter(f => ({ ...f, text: e.target.value }))}
        placeholder="Filter items…" style={styles.filterInput} onMouseDown={e => e.stopPropagation()} />
      {filter.text && <button style={styles.filterClear} onClick={() => setFilter(f => ({ ...f, text: '' }))}>×</button>}
      <button style={{ ...styles.filterClear, fontSize: '0.76rem', color: active ? '#8ab4ff' : '#8090b8', width: 'auto', padding: '0 6px' }}
        onClick={() => setOpen(o => !o)} title="Filter by property">⛃ {rules.length ? `${rules.length}` : 'Filter'} ▾</button>
      {open && (<>
        <div style={styles.backdrop} onClick={() => setOpen(false)} />
        <div style={{ ...styles.menu, top: '110%', left: 'auto', right: 0, minWidth: 320, padding: 8 }} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
          {!filterable.length && <div style={{ color: '#8090b8', fontSize: '0.76rem', padding: 4 }}>No filterable properties.</div>}
          {rules.map((r, i) => {
            const def = propertyDefs.find(d => d.id === r.propId) || filterable[0]
            const ops = OPS[def?.type] || ['contains']
            return (
              <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
                <select value={r.propId} onChange={e => { const nd = propertyDefs.find(d => d.id === e.target.value); setRule(i, { propId: e.target.value, op: OPS[nd.type][0], value: '' }) }} style={styles.fSelect}>
                  {filterable.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <select value={r.op} onChange={e => setRule(i, { op: e.target.value })} style={styles.fSelect}>
                  {ops.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {needsValue(r.op) && (
                  (def?.type === 'select' || def?.type === 'multiSelect')
                    ? <select value={r.value || ''} onChange={e => setRule(i, { value: e.target.value })} style={styles.fSelect}>
                        <option value="">—</option>
                        {(def.options || []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    : <input type={def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text'}
                        value={r.value || ''} onChange={e => setRule(i, { value: e.target.value })}
                        style={{ ...styles.fSelect, width: 90 }} />
                )}
                <button style={styles.filterClear} onClick={() => delRule(i)}>×</button>
              </div>
            )
          })}
          {!!filterable.length && <button style={{ ...styles.btn, fontSize: '0.76rem', padding: '4px 8px' }} onClick={addRule}>+ Add filter</button>}
          {rules.length > 0 && <button style={{ ...styles.filterClear, fontSize: '0.74rem', width: 'auto', marginLeft: 8 }} onClick={() => setFilter(f => ({ ...f, rules: [] }))}>clear all</button>}
        </div>
      </>)}
    </div>
  )
}

function trim(s, n) { return s && s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : (s || '') }

// Greedy word-wrap into lines of at most `maxChars`; very long words are hard-broken.
function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  const pushLong = w => { while (w.length > maxChars) { lines.push(w.slice(0, maxChars)); w = w.slice(maxChars) } return w }
  for (let w of words) {
    if (w.length > maxChars) { if (cur) { lines.push(cur); cur = '' } w = pushLong(w) }
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

const styles = {
  wrap: { position: 'relative', height: '100%', width: '100%', background: '#0c0c1a', overflow: 'hidden' },
  svg: { width: '100%', height: '100%', display: 'block', cursor: 'grab' },
  hint: { position: 'absolute', top: 14, right: 16, zIndex: 5, color: '#8090b8', fontSize: '0.72rem', userSelect: 'none' },
  reset: { position: 'absolute', bottom: 14, right: 16, zIndex: 5, background: 'rgba(18,18,42,0.9)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '5px 11px', cursor: 'pointer', fontSize: '0.78rem' },
  btn: { background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem' },
  notionSaveBtn: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#8ab4ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 190, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  mlabel: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
  filterBox: { position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 5, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', borderRadius: 8, padding: '3px 6px' },
  filterInput: { background: 'transparent', border: 'none', outline: 'none', color: '#e6ebff', fontSize: '0.82rem', width: 180, padding: '3px 4px' },
  filterClear: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 4px' },
  selCount: { color: '#ffd34d', fontSize: '0.74rem', paddingRight: 4, whiteSpace: 'nowrap' },
  fSelect: { background: '#0f1428', border: '1px solid #2d3a6a', color: '#e6ebff', borderRadius: 5, padding: '3px 5px', fontSize: '0.76rem', maxWidth: 120 },
  selBadge: { position: 'absolute', bottom: 14, left: 16, zIndex: 5, background: 'rgba(18,18,42,0.92)', border: '1px solid #6b5a2a', color: '#ffd34d', borderRadius: 7, padding: '4px 10px', fontSize: '0.74rem' },
}
