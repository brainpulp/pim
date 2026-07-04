import { useMemo, useState, useRef, useEffect } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'
import { buildTree, buildTagTree } from '../lib/hierarchy'

// Zoomable circle packing (ref: mbostock/1747543). Click a circle to zoom in, background
// (or ← / Esc) to zoom out. In group-by-tag mode, DRAG a leaf item from one tag-pack onto
// another to retag it (writes node.props[tagProp] and persists). Hierarchy mode is read-only.

const D = 932                      // world size of the pack square (SVG viewBox)
const DEPTH_FILL = ['#12122a', '#1b2452', '#26346f', '#33459a', '#4557c0', '#6f7fe0']
const parseBucket = (id) => id ? String(id).replace(/^opt:/, '') : null   // 'opt:o1' → 'o1'

export default function PackView({ projectId }) {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const numberDefs = propertyDefs.filter(d => d.type === 'number')
  const tagDefs = propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect')

  const setNodeProp = useGraphStore(s => s.setNodeProp)
  const [sizeBy, setSizeBy] = useState(null)   // null = size by item count, else a Number propId
  const [groupProp, setGroupProp] = useState(null)   // null = edge hierarchy, else group-by-tag propId
  const [menuOpen, setMenuOpen] = useState(false)
  const [srcMenu, setSrcMenu] = useState(false)
  const [drag, setDrag] = useState(null)         // { nodeId, sourceOpt, label, x, y, add }
  const [hoverBucket, setHoverBucket] = useState(null)
  const [hoverId, setHoverId] = useState(null)   // leaf under cursor → magnified (Bostock hover-zoom)
  const dragRef = useRef(null)
  const sizeLabel = sizeBy ? (propertyDefs.find(d => d.id === sizeBy)?.name || 'property') : 'items'
  const srcLabel = groupProp ? (propertyDefs.find(d => d.id === groupProp)?.name || 'tag') : 'Hierarchy'

  const decorOf = useMemo(() => {
    const np = views.find(v => v.id === activeViewId)?.nodeProps || {}
    return id => {
      const p = np[id] || {}
      const em = (p.nodeEmojis || [])[0] || null
      return { color: p.fillColor && p.fillColor !== 'none' ? p.fillColor : null,
        stroke: p.strokeColor || null, strokeWidth: p.strokeWidth || null, emoji: em }
    }
  }, [views, activeViewId])

  const root = useMemo(() => {
    const def = groupProp ? propertyDefs.find(d => d.id === groupProp) : null
    const tree = def ? buildTagTree(nodes, def, { decorOf, sizeBy }) : buildTree(nodes, edges, { decorOf, sizeBy })
    const h = d3.hierarchy(tree).sum(d => d.value || 0).sort((a, b) => (b.value || 0) - (a.value || 0))
    return d3.pack().size([D, D]).padding(3)(h)
  }, [nodes, edges, decorOf, sizeBy, groupProp, propertyDefs])

  const [focus, setFocus] = useState(root)
  // Re-seat focus on data change: keep the same node id if it still exists, else root.
  useEffect(() => {
    const match = root.descendants().find(d => d.data.id === focus?.data?.id)
    setFocus(match || root)
  }, [root]) // eslint-disable-line

  const f = focus || root
  const k = D / (f.r * 2 * 1.05)
  const transform = `translate(${D / 2}px, ${D / 2}px) scale(${k}) translate(${-f.x}px, ${-f.y}px)`

  const zoomOut = () => setFocus(f.parent || root)
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') zoomOut() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line

  const descendants = root.descendants()
  const colorFor = (d) => d.data.color || DEPTH_FILL[Math.min(d.depth, DEPTH_FILL.length - 1)]

  // Retag a node by moving it from one tag-pack to another (targets/source are option ids,
  // or '__untagged__'). Multi-select moves that one membership; single-select replaces.
  const retag = (nodeId, sourceOpt, targetOpt, additive) => {
    const def = propertyDefs.find(d => d.id === groupProp); if (!def) return
    const node = useGraphStore.getState().nodes.find(n => n.id === nodeId)
    const raw = node?.props?.[groupProp]
    let value
    if (def.type === 'multiSelect') {
      let tags = Array.isArray(raw) ? [...raw] : (raw ? [raw] : [])
      // additive (Alt-drag) keeps the source tag; plain drag moves the membership.
      if (!additive && sourceOpt && sourceOpt !== '__untagged__') tags = tags.filter(t => t !== sourceOpt)
      if (targetOpt !== '__untagged__' && !tags.includes(targetOpt)) tags.push(targetOpt)
      value = tags
    } else {
      value = targetOpt === '__untagged__' ? null : targetOpt   // single-select: Alt has no meaning
    }
    setNodeProp(nodeId, groupProp, value)
    if (projectId) {
      const s = useGraphStore.getState()
      saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs })
        .catch(e => console.error('Save:', e))
    }
  }

  const bucketUnder = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY)
    return el?.getAttribute?.('data-bucket') || el?.closest?.('[data-bucket]')?.getAttribute('data-bucket') || null
  }
  // Drag a leaf item between tag-packs. Only active in group-by-tag mode.
  const startLeafDrag = (e, d) => {
    if (!groupProp || d.children) return
    e.stopPropagation(); e.preventDefault()
    const nodeId = String(d.data.id).split('@')[0]
    const sourceOpt = parseBucket(d.parent?.data?.id)
    const multi = propertyDefs.find(x => x.id === groupProp)?.type === 'multiSelect'
    const info = { nodeId, sourceOpt, label: d.data.label, x: e.clientX, y: e.clientY, moved: false, add: multi && e.altKey }
    dragRef.current = info; setDrag({ ...info }); setHoverId(null)
    const onMove = ev => {
      const cur = dragRef.current; if (!cur) return
      cur.x = ev.clientX; cur.y = ev.clientY; cur.add = multi && ev.altKey
      if (!cur.moved && (Math.abs(ev.movementX) || Math.abs(ev.movementY))) cur.moved = true
      setDrag({ ...cur })
      setHoverBucket(bucketUnder(ev.clientX, ev.clientY))
    }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const cur = dragRef.current; dragRef.current = null
      const target = bucketUnder(ev.clientX, ev.clientY)
      const additive = multi && ev.altKey
      setDrag(null); setHoverBucket(null)
      if (cur && cur.moved && target && (target !== cur.sourceOpt || additive)) retag(cur.nodeId, cur.sourceOpt, target, additive)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const dragging = !!drag

  return (
    <div style={styles.wrap}>
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', gap: 8, alignItems: 'center' }}>
        {f !== root && <button style={styles.back} onClick={zoomOut}>← {f.parent && f.parent !== root ? trim(f.parent.data.label, 20) : 'Up'}</button>}
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
            </div>
          </>)}
        </div>
        <div style={{ position: 'relative' }}>
          <button style={styles.btn} onClick={() => setMenuOpen(o => !o)}>size: {trim(sizeLabel, 14)} ▾</button>
          {menuOpen && (<>
            <div style={styles.backdrop} onClick={() => setMenuOpen(false)} />
            <div style={styles.menu} onClick={e => e.stopPropagation()}>
              <div style={{ ...styles.item, color: !sizeBy ? '#fff' : '#c5d0ff' }} onClick={() => { setSizeBy(null); setMenuOpen(false) }}>{!sizeBy && '✓ '}Item count</div>
              <div style={styles.mlabel}>By Number property</div>
              {numberDefs.length ? numberDefs.map(d => (
                <div key={d.id} style={{ ...styles.item, color: sizeBy === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { setSizeBy(d.id); setMenuOpen(false) }}>{sizeBy === d.id && '✓ '}{d.name}</div>
              )) : <div style={{ ...styles.item, color: '#8090b8', fontSize: '0.74rem' }}>No Number property</div>}
            </div>
          </>)}
        </div>
      </div>
      <div style={styles.hint}>{groupProp ? 'drag item between packs to retag · Alt-drag to add tag · ' : ''}click to zoom{f !== root ? ' · Esc to go up' : ''}</div>
      <svg viewBox={`0 0 ${D} ${D}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}
        onClick={zoomOut} onMouseLeave={() => { if (!dragging) setHoverId(null) }}>
        <g style={{ transform, transformBox: 'view-box', transformOrigin: '0 0', transition: dragging ? 'none' : 'transform 680ms cubic-bezier(0.22,0.61,0.36,1)' }}>
          {descendants.map(d => {
            const isLeaf = !d.children
            const dStroke = d.data.stroke
            const isBucket = groupProp && d.depth === 1
            const isTagLeaf = groupProp && isLeaf && d.depth >= 2
            const isDropTarget = isBucket && hoverBucket === parseBucket(d.data.id)
            // While dragging, let non-bucket circles fall through so elementFromPoint hits buckets.
            const pe = dragging ? (isBucket ? 'auto' : 'none') : 'auto'
            return (
              <circle key={d.data.id} cx={d.x} cy={d.y} r={d.r}
                data-bucket={isBucket ? parseBucket(d.data.id) : undefined}
                fill={colorFor(d)}
                fillOpacity={isDropTarget ? 0.75 : (isLeaf ? 0.92 : 0.45)}
                stroke={isDropTarget ? '#7fd8a8' : (d === f ? '#8fa0ff' : (dStroke || '#0c0c1a'))}
                strokeWidth={isDropTarget ? 3 / k : (d === f ? 2.5 / k : (dStroke ? Math.max(d.data.strokeWidth || 1.5, 1.4) / k : 1 / k))}
                style={{ cursor: isTagLeaf ? 'grab' : (d.children ? 'pointer' : 'default'), pointerEvents: pe }}
                onMouseEnter={isLeaf ? () => { if (!dragging) setHoverId(d.data.id) } : undefined}
                onMouseDown={isTagLeaf ? e => startLeafDrag(e, d) : undefined}
                onClick={e => { e.stopPropagation(); if (d.children && d !== f) setFocus(d) }}
              />
            )
          })}
          {/* Labels: every node, every level, complete text — wrapped to fit the circle. */}
          {descendants.filter(d => d.depth > 0 && d.data.label).map(d => {
            const isLeaf = !d.children
            const fontSize = isLeaf ? d.r * 0.34 : Math.min(d.r * 0.15, 16)
            const maxChars = Math.max(4, Math.floor((1.75 * d.r) / (fontSize * 0.56)))
            const lines = wrapText(d.data.label, maxChars).slice(0, isLeaf ? 8 : 2)
            const lh = fontSize * 1.08
            if (isLeaf) {
              const y0 = d.y - (lines.length - 1) / 2 * lh
              return (
                <text key={'t' + d.data.id} textAnchor="middle" dominantBaseline="middle"
                  fontSize={fontSize} fill="#eef2ff" pointerEvents="none"
                  style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.18, fontWeight: 600 }}>
                  {lines.map((ln, i) => <tspan key={i} x={d.x} y={y0 + i * lh}>{ln}</tspan>)}
                </text>
              )
            }
            // Parent: a small title hugging the top edge so it doesn't cover children.
            const y0 = d.y - d.r + fontSize * 1.1
            return (
              <text key={'t' + d.data.id} textAnchor="middle" dominantBaseline="hanging"
                fontSize={fontSize} fill="#cdd6f5" pointerEvents="none"
                style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.2, fontWeight: 600 }}>
                {lines.map((ln, i) => <tspan key={i} x={d.x} y={y0 + i * lh}>{ln}</tspan>)}
              </text>
            )
          })}
          {/* Emoji decoration, a small badge mounted top-right like on the graph nodes. */}
          {descendants.filter(d => d.data.emoji && d.r > 14).map(d => {
            const em = d.data.emoji, sz = Math.min(d.r * 0.28, 30)
            const ex = d.x + d.r * 0.5, ey = d.y - d.r * 0.5
            return em.type === 'image'
              ? <image key={'e' + d.data.id} href={em.emoji} x={ex - sz / 2} y={ey - sz / 2} width={sz} height={sz} style={{ pointerEvents: 'none' }} />
              : <text key={'e' + d.data.id} x={ex} y={ey} fontSize={sz} textAnchor="middle" dominantBaseline="central" pointerEvents="none">{em.emoji}</text>
          })}
          {/* Hover-zoom: magnify the leaf under the cursor so small items are readable/grabbable. */}
          {hoverId && !dragging && (() => {
            const hd = descendants.find(x => x.data.id === hoverId)
            if (!hd || hd.children) return null
            const er = Math.min(Math.max(hd.r * 1.7, 44), 130)
            const isTagLeaf = groupProp && hd.depth >= 2
            const fontSize = er * 0.3
            const maxChars = Math.max(5, Math.floor((1.75 * er) / (fontSize * 0.56)))
            const lines = wrapText(hd.data.label, maxChars).slice(0, 6)
            const lh = fontSize * 1.08
            const y0 = hd.y - (lines.length - 1) / 2 * lh
            const em = hd.data.emoji, esz = Math.min(er * 0.28, 30)
            return (
              <g style={{ cursor: isTagLeaf ? 'grab' : 'default' }}
                onMouseLeave={() => setHoverId(null)}
                onMouseDown={isTagLeaf ? e => startLeafDrag(e, hd) : undefined}
                onClick={e => e.stopPropagation()}>
                <circle cx={hd.x} cy={hd.y} r={er} fill={colorFor(hd)} fillOpacity={0.98} stroke="#8fa0ff" strokeWidth={2 / k} />
                <text textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fill="#eef2ff" pointerEvents="none"
                  style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.18, fontWeight: 600 }}>
                  {lines.map((ln, i) => <tspan key={i} x={hd.x} y={y0 + i * lh}>{ln}</tspan>)}
                </text>
                {em && (em.type === 'image'
                  ? <image href={em.emoji} x={hd.x + er * 0.5 - esz / 2} y={hd.y - er * 0.5 - esz / 2} width={esz} height={esz} pointerEvents="none" />
                  : <text x={hd.x + er * 0.5} y={hd.y - er * 0.5} fontSize={esz} textAnchor="middle" dominantBaseline="central" pointerEvents="none">{em.emoji}</text>)}
              </g>
            )
          })()}
        </g>
      </svg>
      {drag && (
        <div style={{ position: 'fixed', left: drag.x + 12, top: drag.y + 6, zIndex: 50, pointerEvents: 'none', background: drag.add ? '#173a2a' : '#1a1f4a', border: `1px solid ${drag.add ? '#2f7a55' : '#5b6af0'}`, color: '#e6ebff', borderRadius: 6, padding: '3px 9px', fontSize: '0.8rem', boxShadow: '0 4px 16px rgba(0,0,0,0.6)', whiteSpace: 'nowrap' }}>
          {trim(drag.label || 'item', 28)} →{hoverBucket && (hoverBucket !== drag.sourceOpt || drag.add) ? (drag.add ? ' drop to ADD tag' : ' drop to retag') : '…'}
        </div>
      )}
      {descendants.length <= 1 && <div style={styles.empty}>Nothing to pack yet — add some nodes in the graph.</div>}
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
  svg: { width: '100%', height: '100%', display: 'block' },
  back: { position: 'absolute', top: 12, left: 12, zIndex: 5, background: 'rgba(18,18,42,0.9)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.85rem' },
  hint: { position: 'absolute', top: 14, right: 16, zIndex: 5, color: '#8090b8', fontSize: '0.72rem', userSelect: 'none' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
  btn: { background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 190, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  mlabel: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
}
