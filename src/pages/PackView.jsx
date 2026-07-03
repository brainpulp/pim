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

export default function PackView({ sizeBy = null }) {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)

  const fillColorOf = useMemo(() => {
    const np = views.find(v => v.id === activeViewId)?.nodeProps || {}
    return id => np[id]?.fillColor || null
  }, [views, activeViewId])

  const root = useMemo(() => {
    const tree = buildTree(nodes, edges, { fillColorOf, sizeBy })
    const h = d3.hierarchy(tree).sum(d => d.value || 0).sort((a, b) => (b.value || 0) - (a.value || 0))
    return d3.pack().size([D, D]).padding(3)(h)
  }, [nodes, edges, fillColorOf, sizeBy])

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
      <div style={styles.hint}>{sizeBy ? 'size = property' : 'size = items'} · click to zoom{f !== root ? ' · Esc to go up' : ''}</div>
      <svg viewBox={`0 0 ${D} ${D}`} preserveAspectRatio="xMidYMid meet" style={styles.svg}
        onClick={zoomOut}>
        <g style={{ transform, transformBox: 'view-box', transformOrigin: '0 0', transition: 'transform 680ms cubic-bezier(0.22,0.61,0.36,1)' }}>
          {descendants.map(d => {
            const isLeaf = !d.children
            return (
              <circle key={d.data.id} cx={d.x} cy={d.y} r={d.r}
                fill={colorFor(d)}
                fillOpacity={isLeaf ? 0.92 : 0.5}
                stroke={d === f ? '#8fa0ff' : '#0c0c1a'}
                strokeWidth={d === f ? 2 / k : 1 / k}
                style={{ cursor: d.children ? 'pointer' : 'default' }}
                onClick={e => { e.stopPropagation(); if (d.children && d !== f) setFocus(d); else zoomOut() }}
              />
            )
          })}
          {descendants.filter(d => d.parent === f || (d === f && !d.children)).map(d => {
            const fontSize = Math.min(d.r * 0.42, 26 / k)
            if (d.r * k < 12) return null
            return (
              <text key={'t' + d.data.id} x={d.x} y={d.y} textAnchor="middle" dominantBaseline="middle"
                fontSize={fontSize} fill="#eef2ff" pointerEvents="none"
                style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: fontSize * 0.16, fontWeight: 600 }}>
                {trim(d.data.label, Math.max(6, d.r / (fontSize * 0.34)))}
              </text>
            )
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
}
