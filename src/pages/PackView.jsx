import { useMemo, useState, useRef, useEffect } from 'react'
import * as d3 from 'd3'
import useGraphStore from '../lib/graphStore'
import { buildTree } from '../lib/hierarchy'

// Zoomable circle packing (ref: mbostock/1747543). A structural view of the node tree:
// nested circles sized by leaf count (or a Number property). Click a circle to zoom in,
// click the background (or ← / Esc) to zoom out one level. Read-only explorer — editing
// stays in the mind map / table. Non-destructive: reads the store, writes nothing.

const D = 932                      // world size of the pack square (SVG viewBox)
const DEPTH_FILL = ['#12122a', '#1b2452', '#26346f', '#33459a', '#4557c0', '#6f7fe0']

export default function PackView() {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const numberDefs = propertyDefs.filter(d => d.type === 'number')

  const [sizeBy, setSizeBy] = useState(null)   // null = size by item count, else a Number propId
  const [menuOpen, setMenuOpen] = useState(false)
  const sizeLabel = sizeBy ? (propertyDefs.find(d => d.id === sizeBy)?.name || 'property') : 'items'

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
    const tree = buildTree(nodes, edges, { decorOf, sizeBy })
    const h = d3.hierarchy(tree).sum(d => d.value || 0).sort((a, b) => (b.value || 0) - (a.value || 0))
    return d3.pack().size([D, D]).padding(3)(h)
  }, [nodes, edges, decorOf, sizeBy])

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

  return (
    <div style={styles.wrap}>
      {f !== root && (
        <button style={styles.back} onClick={zoomOut}>← {f.parent && f.parent !== root ? trim(f.parent.data.label, 24) : 'Up'}</button>
      )}
      <div style={{ position: 'absolute', top: 12, left: f !== root ? 150 : 12, zIndex: 5 }}>
        <button style={styles.btn} onClick={() => setMenuOpen(o => !o)}>⬡ size: {trim(sizeLabel, 16)} ▾</button>
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
      <div style={styles.hint}>click to zoom{f !== root ? ' · Esc to go up' : ''}</div>
      <svg viewBox={`0 0 ${D} ${D}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}
        onClick={zoomOut}>
        <g style={{ transform, transformBox: 'view-box', transformOrigin: '0 0', transition: 'transform 680ms cubic-bezier(0.22,0.61,0.36,1)' }}>
          {descendants.map(d => {
            const isLeaf = !d.children
            const dStroke = d.data.stroke
            return (
              <circle key={d.data.id} cx={d.x} cy={d.y} r={d.r}
                fill={colorFor(d)}
                fillOpacity={isLeaf ? 0.92 : 0.45}
                stroke={d === f ? '#8fa0ff' : (dStroke || '#0c0c1a')}
                strokeWidth={d === f ? 2.5 / k : (dStroke ? Math.max(d.data.strokeWidth || 1.5, 1.4) / k : 1 / k)}
                style={{ cursor: d.children ? 'pointer' : 'default' }}
                onClick={e => { e.stopPropagation(); if (d.children && d !== f) setFocus(d); else zoomOut() }}
              />
            )
          })}
          {/* Labels: every node, every level, complete text (fit to circle; may be tiny). */}
          {descendants.filter(d => d.depth > 0 && d.data.label).map(d => {
            const isLeaf = !d.children
            const len = Math.max(3, d.data.label.length)
            if (isLeaf) {
              const fontSize = Math.min(d.r * 0.5, (1.8 * d.r) / (len * 0.6))
              return (
                <text key={'t' + d.data.id} x={d.x} y={d.y} textAnchor="middle" dominantBaseline="middle"
                  fontSize={fontSize} fill="#eef2ff" pointerEvents="none"
                  style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.18, fontWeight: 600 }}>
                  {d.data.label}
                </text>
              )
            }
            // Parent: a small title hugging the top edge so it doesn't cover children.
            const fontSize = Math.min(d.r * 0.16, (1.9 * d.r) / (len * 0.6))
            return (
              <text key={'t' + d.data.id} x={d.x} y={d.y - d.r + fontSize * 1.1} textAnchor="middle" dominantBaseline="hanging"
                fontSize={fontSize} fill="#cdd6f5" pointerEvents="none"
                style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.2, fontWeight: 600 }}>
                {d.data.label}
              </text>
            )
          })}
          {/* Emoji decoration, mounted top-right like on the graph nodes. */}
          {descendants.filter(d => d.data.emoji && d.r > 7).map(d => {
            const em = d.data.emoji, sz = d.r * 0.5
            const ex = d.x + d.r * 0.42, ey = d.y - d.r * 0.42
            return em.type === 'image'
              ? <image key={'e' + d.data.id} href={em.emoji} x={ex - sz / 2} y={ey - sz / 2} width={sz} height={sz} style={{ pointerEvents: 'none' }} />
              : <text key={'e' + d.data.id} x={ex} y={ey} fontSize={sz} textAnchor="middle" dominantBaseline="central" pointerEvents="none">{em.emoji}</text>
          })}
        </g>
      </svg>
      {descendants.length <= 1 && <div style={styles.empty}>Nothing to pack yet — add some nodes in the graph.</div>}
    </div>
  )
}

function trim(s, n) { return s && s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : (s || '') }

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
