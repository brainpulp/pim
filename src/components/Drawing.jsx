import { useState, useRef } from 'react'

// Shared free-drawing layer — SVG decorations (shapes, lines/arrows, emoji, icons, text) stored per view
// in `view.drawings[]`. Used by the Graph and the Board canvases. World-coordinate; `zoomRef.current.k`
// scales drag deltas so a drag feels 1:1 at any zoom.

export function shapeDrawing(shape, hw, hh, props) {
  const poly = pts => <polygon points={pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')} {...props} />
  switch (shape) {
    case 'ellipse': return <ellipse rx={hw} ry={hh} {...props} />
    case 'circle': return <circle r={Math.min(hw, hh)} {...props} />
    case 'roundrect': return <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} rx={Math.min(hw, hh) * 0.3} {...props} />
    case 'triangle': return poly([[0, -hh], [hw, hh], [-hw, hh]])
    case 'diamond': return poly([[0, -hh], [hw, 0], [0, hh], [-hw, 0]])
    case 'pentagon': { const p = []; for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; p.push([hw * Math.cos(a), hh * Math.sin(a)]) } return poly(p) }
    case 'hexagon': { const p = []; for (let i = 0; i < 6; i++) { const a = i * 2 * Math.PI / 6; p.push([hw * Math.cos(a), hh * Math.sin(a)]) } return poly(p) }
    case 'star': { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const r = i % 2 === 0 ? 1 : 0.42; p.push([hw * r * Math.cos(a), hh * r * Math.sin(a)]) } return poly(p) }
    default: return <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} {...props} />
  }
}

export function DrawingItem({ d, selected, zoomRef, palette, onSelect, onUpdate, onDelete }) {
  const stop = e => e.stopPropagation()
  const kz = () => zoomRef?.current?.k || 1
  const x = d.x || 0, y = d.y || 0
  const isLine = d.kind === 'line' || d.kind === 'arrow'
  const [editing, setEditing] = useState(false)
  const rootRef = useRef(null)

  const startMove = (e) => {
    if (e.button !== 0) return
    stop(e); e.preventDefault(); onSelect()
    const sx = e.clientX, sy = e.clientY, o = { x, y, x2: d.x2, y2: d.y2 }
    const move = ev => {
      const dx = (ev.clientX - sx) / kz(), dy = (ev.clientY - sy) / kz()
      const patch = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) }
      if (o.x2 != null) { patch.x2 = Math.round(o.x2 + dx); patch.y2 = Math.round(o.y2 + dy) }
      onUpdate(patch)
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const startResize = (e) => {
    stop(e); e.preventDefault()
    const sx = e.clientX, sy = e.clientY
    let move
    if (isLine) { const o = { x2: d.x2, y2: d.y2 }; move = ev => onUpdate({ x2: Math.round(o.x2 + (ev.clientX - sx) / kz()), y2: Math.round(o.y2 + (ev.clientY - sy) / kz()) }) }
    else if (d.kind === 'emoji' || d.kind === 'text') { const o = d.size || 40; move = ev => onUpdate({ size: Math.max(10, Math.round(o + (ev.clientX - sx) / kz())) }) }
    else { const ow = d.w || 80, oh = d.h || 60; move = ev => onUpdate({ w: Math.max(12, Math.round(ow + (ev.clientX - sx) / kz())), h: Math.max(12, Math.round(oh + (ev.clientY - sy) / kz())) }) }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  const stroke = d.stroke || '#c5d0ff', sw = d.strokeWidth || 3
  let body = null, bbox = null
  if (d.kind === 'shape') {
    const w = d.w || 80, h = d.h || 60, hw = w / 2, hh = h / 2
    body = shapeDrawing(d.shape || 'rect', hw, hh, { fill: d.fill || '#5b6af0', stroke: d.stroke || 'none', strokeWidth: d.stroke ? sw : 0 })
    bbox = { x: -hw, y: -hh, w, h }
  } else if (isLine) {
    const x2 = (d.x2 ?? x + 120) - x, y2 = (d.y2 ?? y) - y
    body = (<>
      {d.kind === 'arrow' && <defs><marker id={`dah-${d.id}`} markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill={stroke} /></marker></defs>}
      <line x1={0} y1={0} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} strokeDasharray={d.dash || undefined} markerEnd={d.kind === 'arrow' ? `url(#dah-${d.id})` : undefined} strokeLinecap="round" />
    </>)
  } else if (d.kind === 'emoji') {
    const s = (d.size || 44) / 2
    body = <text textAnchor="middle" dominantBaseline="central" fontSize={d.size || 44} style={{ userSelect: 'none' }}>{d.emoji}</text>
    bbox = { x: -s, y: -s, w: s * 2, h: s * 2 }
  } else if (d.kind === 'text') {
    const fs = d.size || 22, w = Math.max(40, (d.text || 'Text').length * fs * 0.6), h = fs * 1.4
    body = <text textAnchor="middle" dominantBaseline="central" fontSize={fs} fill={d.fill || '#fff'} fontWeight={600} style={{ userSelect: 'none' }}>{d.text || 'Text'}</text>
    bbox = { x: -w / 2, y: -h / 2, w, h }
  }

  const hx = bbox ? bbox.x + bbox.w : ((d.x2 ?? x + 120) - x), hy = bbox ? bbox.y + bbox.h : ((d.y2 ?? y) - y)
  const CHECKER = 'repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 50% / 7px 7px'
  // A labelled palette row: transparent chip first, then the colours. `onPick('none')` = transparent.
  const swatchRow = (onPick, label) => (
    <div onMouseDown={stop} style={{ display: 'flex', alignItems: 'center', gap: 3, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 6, padding: '3px 5px', width: 'fit-content' }}>
      {label && <span style={{ fontSize: 8, color: '#8090b8', width: 10, textAlign: 'center', flexShrink: 0 }}>{label}</span>}
      <div title="Transparent" onClick={ev => { stop(ev); onPick('none') }} style={{ width: 13, height: 13, borderRadius: 3, cursor: 'pointer', border: '1px solid #5b6af0', background: CHECKER }} />
      {palette.slice(0, 12).map(c => <div key={c} onClick={ev => { stop(ev); onPick(c) }} style={{ width: 13, height: 13, borderRadius: 3, background: c, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.15)' }} />)}
    </div>
  )
  const pickFill = c => onUpdate({ fill: c === 'none' ? 'none' : c })
  const pickStroke = c => onUpdate({ stroke: c === 'none' ? null : c })
  const rot = d.rotation || 0
  const canRotate = d.kind === 'shape' || d.kind === 'text' || d.kind === 'emoji'
  // Rotate by dragging the top handle — angle measured from the item's centre (via the group's screen CTM).
  const startRotate = (e) => {
    stop(e); e.preventDefault()
    const g = rootRef.current; if (!g) return
    const r0 = rot
    const centre = () => { const m = g.getScreenCTM(); return new DOMPoint(0, 0).matrixTransform(m) }
    const c0 = centre(); const a0 = Math.atan2(e.clientY - c0.y, e.clientX - c0.x)
    const move = ev => { const c = centre(); const a = Math.atan2(ev.clientY - c.y, ev.clientX - c.x); let deg = Math.round(r0 + (a - a0) * 180 / Math.PI); if (ev.shiftKey) deg = Math.round(deg / 15) * 15; onUpdate({ rotation: ((deg % 360) + 360) % 360 }) }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  return (
    <g ref={rootRef} data-drawing="1" transform={`translate(${x},${y}) rotate(${rot})`} onClick={e => { stop(e); onSelect() }}
      onDoubleClick={e => { if (d.kind === 'text') { stop(e); setEditing(true) } }}
      onMouseDown={startMove} style={{ cursor: 'move' }}>
      {isLine && <line x1={0} y1={0} x2={(d.x2 ?? x + 120) - x} y2={(d.y2 ?? y) - y} stroke="transparent" strokeWidth={14} />}
      {!(editing && d.kind === 'text') && body}
      {editing && d.kind === 'text' && (
        <foreignObject x={-90} y={-16} width={180} height={32} style={{ overflow: 'visible' }}>
          <input autoFocus defaultValue={d.text || ''} onMouseDown={stop} onClick={stop}
            onBlur={e => { onUpdate({ text: e.target.value || 'Text' }); setEditing(false) }}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { onUpdate({ text: e.target.value || 'Text' }); setEditing(false) } if (e.key === 'Escape') setEditing(false) }}
            style={{ width: '100%', textAlign: 'center', background: '#0d0d1e', border: '1px solid #5b6af0', color: '#fff', borderRadius: 4, fontSize: 14, outline: 'none' }} />
        </foreignObject>
      )}
      {selected && bbox && <rect x={bbox.x} y={bbox.y} width={bbox.w} height={bbox.h} fill="none" stroke="#5b6af0" strokeWidth={1.2} strokeDasharray="4,3" pointerEvents="none" />}
      {selected && (
        isLine
          ? <circle cx={hx} cy={hy} r={6} fill="#fff" stroke="#5b6af0" strokeWidth={1.5} style={{ cursor: 'nwse-resize' }} onMouseDown={startResize} />
          : <rect x={hx - 5} y={hy - 5} width={10} height={10} fill="#fff" stroke="#5b6af0" strokeWidth={1.5} style={{ cursor: 'nwse-resize' }} onMouseDown={startResize} />
      )}
      {selected && canRotate && bbox && (<>
        <line x1={0} y1={bbox.y} x2={0} y2={bbox.y - 20} stroke="#5b6af0" strokeWidth={1} pointerEvents="none" />
        <circle cx={0} cy={bbox.y - 24} r={6} fill="#fff" stroke="#5b6af0" strokeWidth={1.5} style={{ cursor: 'grab' }} onMouseDown={startRotate} />
      </>)}
      {selected && (d.kind === 'shape' || d.kind === 'text' || isLine) && (
        <foreignObject x={bbox ? bbox.x : 0} y={(bbox ? bbox.y + bbox.h : Math.max(0, hy)) + 8} width={230} height={d.kind === 'shape' ? 58 : 28} style={{ overflow: 'visible' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {d.kind === 'shape' && swatchRow(pickFill, 'F')}
            {(d.kind === 'shape' || isLine) && swatchRow(pickStroke, 'O')}
            {d.kind === 'text' && swatchRow(pickFill, 'F')}
          </div>
        </foreignObject>
      )}
    </g>
  )
}

// Complete emoji set — generated from the main Unicode emoji blocks (not a curated subset).
const EMOJI_RANGES = [[0x1F300, 0x1F5FF], [0x1F600, 0x1F64F], [0x1F680, 0x1F6FC], [0x1F900, 0x1F9FF], [0x1FA70, 0x1FAF8], [0x2600, 0x26FF], [0x2700, 0x27BF]]
const EMOJIS = []
for (const [a, b] of EMOJI_RANGES) { for (let c = a; c <= b; c++) EMOJIS.push(String.fromCodePoint(c)) }

export function DrawPalette({ palette, onStartDrag, onClose }) {
  const swatch = { display:'flex', flexWrap:'wrap', gap:5 }
  const btn = { width:33, height:33, display:'flex', alignItems:'center', justifyContent:'center', background:'#14142a', border:'1px solid #2a3358', borderRadius:6, cursor:'grab', color:'#c5d0ff', fontSize:17, userSelect:'none' }
  const label = { fontSize:'0.62rem', color:'#7080a0', letterSpacing:'0.08em', margin:'11px 0 5px' }
  return (
    <div style={{ width:212, flexShrink:0, background:'#0d0d1a', borderLeft:'1px solid #1e1e2e', display:'flex', flexDirection:'column', overflow:'hidden' }}
      onMouseDown={e => e.stopPropagation()}>
      <div style={{ display:'flex', alignItems:'center', borderBottom:'1px solid #1e1e2e' }}>
        <div style={{ flex:1, textAlign:'center', padding:'8px 0', fontSize:'0.78rem', fontWeight:700, color:'#c5d0ff', background:'#14142a' }}>✏️ Draw</div>
        <button onClick={onClose} style={{ background:'transparent', border:'none', color:'#8090b8', cursor:'pointer', fontSize:16, padding:'0 8px' }}>×</button>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'4px 10px 24px' }}>
        <div style={{ fontSize:'0.62rem', color:'#8090b8', lineHeight:1.4, margin:'4px 0' }}>Drag an item onto the canvas.</div>
        <div style={label}>TEXT</div>
        <div style={swatch}><div style={{ ...btn, width:'auto', padding:'0 14px', fontSize:14, fontWeight:700 }} onMouseDown={e => onStartDrag('text',{ text:'Text', size:26, fill:'#ffffff' }, e)}>Text</div></div>
        <div style={label}>EMOJI · {EMOJIS.length}</div>
        <div style={swatch}>{EMOJIS.map((g,i) => <div key={i} style={{ ...btn, fontSize:19 }} onMouseDown={e => onStartDrag('emoji',{ emoji:g, size:46 }, e)}>{g}</div>)}</div>
      </div>
    </div>
  )
}
