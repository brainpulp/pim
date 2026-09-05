import { useMemo, useState, useRef, useEffect } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { buildTree, buildTagTree } from '../lib/hierarchy'

// Radial cluster dendrogram (ref: mbostock/4339607). Two sources:
//  • Tree   — the mind-map hierarchy (edges), first-parent-wins.
//  • by <tag> — a synthetic root → option → member-nodes hierarchy (structured tag view).
// Read-only explorer. Scroll to zoom, drag to pan; CLICK a node to spin it to the top and
// zoom in on it. Node fill/stroke mirror the active view. Reads the store, writes nothing.

const mod2pi = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)

const SIZE = 1000
const R = SIZE / 2 - 120   // leave room for outer labels

export default function RadialView() {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const tagDefs = propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect')

  const [groupProp, setGroupProp] = useState(null)   // null = edge tree, else a propId
  const [menuOpen, setMenuOpen] = useState(false)

  const decorOf = useMemo(() => {
    const np = views.find(v => v.id === activeViewId)?.nodeProps || {}
    return id => {
      const p = np[id] || {}
      return { color: p.fillColor && p.fillColor !== 'none' ? p.fillColor : null, stroke: p.strokeColor || null }
    }
  }, [views, activeViewId])

  const laid = useMemo(() => {
    const def = groupProp ? propertyDefs.find(d => d.id === groupProp) : null
    const tree = def ? buildTagTree(nodes, def, { decorOf }) : buildTree(nodes, edges, { decorOf })
    const h = d3.hierarchy(tree)
    d3.cluster().size([2 * Math.PI, R])(h)
    return h
  }, [nodes, edges, groupProp, propertyDefs, decorOf])

  const links = laid.links()
  const descendants = laid.descendants()
  const linkGen = d3.linkRadial().angle(d => d.x).radius(d => d.y)
  const colorFor = d => d.data.color || (d.depth === 0 ? '#5b6af0' : '#7f8fd0')

  // Scroll-zoom / drag-pan via d3.zoom on the svg → transform state.
  const svgRef = useRef(null)
  const zoomRef = useRef(null)
  const [t, setT] = useState(d3.zoomIdentity)
  const [rot, setRot] = useState(0)   // whole-tree rotation (radians), animated via rAF
  useEffect(() => {
    const sel = d3.select(svgRef.current)
    const zoom = d3.zoom().scaleExtent([0.3, 6]).on('zoom', e => setT(e.transform))
    zoomRef.current = zoom
    sel.call(zoom)
    return () => sel.on('.zoom', null)
  }, [])

  // rAF tween of the rotation (SVG-attr transform → robust inside the zoom group).
  const rafRef = useRef(0)
  const rotRef = useRef(0)
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])
  const animateRot = (target) => {
    cancelAnimationFrame(rafRef.current)
    const from = rotRef.current
    const delta = ((target - from + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI  // shortest spin
    const to = from + delta
    const start = performance.now(), dur = 680
    const tick = now => {
      const p = Math.min(1, (now - start) / dur)
      const e = 1 - Math.pow(1 - p, 3)   // easeOutCubic
      const val = from + (to - from) * e
      rotRef.current = val; setRot(val)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // Click a node → spin it to the top (rotate the tree) and zoom in centered on it.
  const focusNode = d => {
    if (d.depth === 0) { animateRot(0); d3.select(svgRef.current).transition().duration(600).call(zoomRef.current.transform, d3.zoomIdentity); return }
    animateRot(-d.x)                               // node's angle → 0 (top)
    const kk = 1.9
    const gx = SIZE / 2, gy = SIZE / 2 - d.y       // post-rotation position (top), in SVG coords
    const T = d3.zoomIdentity.translate(SIZE / 2 - kk * gx, SIZE / 2 - kk * gy).scale(kk)
    d3.select(svgRef.current).transition().duration(680).call(zoomRef.current.transform, T)
  }
  const resetView = () => { animateRot(0); d3.select(svgRef.current).transition().duration(500).call(zoomRef.current.transform, d3.zoomIdentity) }

  const activeLabel = groupProp ? (propertyDefs.find(d => d.id === groupProp)?.name || 'tag') : 'Tree'

  return (
    <div style={styles.wrap}>
      <div style={styles.ctrl}>
        <button style={styles.btn} onClick={() => setMenuOpen(o => !o)}>❃ {groupProp ? `by ${activeLabel}` : 'Tree'} ▾</button>
        {menuOpen && (<>
          <div style={styles.backdrop} onClick={() => setMenuOpen(false)} />
          <div style={styles.menu} onClick={e => e.stopPropagation()}>
            <div style={{ ...styles.item, color: !groupProp ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp(null); setMenuOpen(false) }}>{!groupProp && '✓ '}Hierarchy (edges)</div>
            <div style={styles.label}>Group by tag</div>
            {tagDefs.length ? tagDefs.map(d => (
              <div key={d.id} style={{ ...styles.item, color: groupProp === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { setGroupProp(d.id); setMenuOpen(false) }}>{groupProp === d.id && '✓ '}{d.name}</div>
            )) : <div style={{ ...styles.item, color: '#8090b8', fontSize: '0.74rem' }}>No Select/Tags property</div>}
          </div>
        </>)}
      </div>
      <div style={styles.hint}>scroll = zoom · drag = pan · click a node to spin + focus</div>
      {(rot !== 0 || t.k !== 1) && <button style={styles.reset} onClick={resetView}>⟳ Reset</button>}

      <svg ref={svgRef} viewBox={`0 0 ${SIZE} ${SIZE}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}>
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          <g transform={`translate(${SIZE / 2},${SIZE / 2}) rotate(${rot * 180 / Math.PI})`}>
            <g fill="none" stroke="#2c3566" strokeOpacity={0.7} strokeWidth={1}>
              {links.map((l, i) => <path key={i} d={linkGen(l)} />)}
            </g>
            {descendants.map(d => {
              const deg = d.x * 180 / Math.PI - 90
              const onLeft = mod2pi(d.x + rot) >= Math.PI   // flip based on where it ends up after rotation
              const showLabel = !d.children || d.depth <= 1
              return (
                <g key={d.data.id} transform={`rotate(${deg}) translate(${d.y},0)`}>
                  <circle r={d.children ? 4.2 : 3.4} fill={colorFor(d)}
                    stroke={d.data.stroke || '#0c0c1a'} strokeWidth={d.data.stroke ? 1.4 : 0.8}
                    style={{ cursor: 'pointer' }}
                    onClick={e => { e.stopPropagation(); focusNode(d) }} />
                  {showLabel && d.data.label && (
                    <text
                      transform={onLeft ? 'rotate(180)' : undefined}
                      x={onLeft ? -8 : 8} dy="0.31em"
                      textAnchor={onLeft ? 'end' : 'start'}
                      fontSize={11} fill="#cdd6f5" pointerEvents="none"
                      style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: 2.5 }}>
                      {trim(d.data.label, 22)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </g>
      </svg>
      {descendants.length <= 1 && <div style={styles.empty}>Nothing to show yet — add nodes (or a tag) first.</div>}
    </div>
  )
}

function trim(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || '') }

const styles = {
  wrap: { position: 'relative', height: '100%', width: '100%', background: '#0c0c1a', overflow: 'hidden' },
  svg: { width: '100%', height: '100%', display: 'block', cursor: 'grab' },
  ctrl: { position: 'absolute', top: 12, left: 12, zIndex: 5 },
  btn: { background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: '0.82rem' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 190, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  label: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  hint: { position: 'absolute', top: 14, right: 16, zIndex: 5, color: '#8090b8', fontSize: '0.72rem', userSelect: 'none' },
  reset: { position: 'absolute', bottom: 14, right: 16, zIndex: 5, background: 'rgba(18,18,42,0.9)', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '5px 11px', cursor: 'pointer', fontSize: '0.78rem' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: '0.9rem', pointerEvents: 'none' },
}
