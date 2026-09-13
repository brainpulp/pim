import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

// ── One color picker for the whole app ──────────────────────────────────────────────────────────
// The swatch palette the product settled on: readable neutrals + vivids, plus a "custom" rainbow chip
// that opens the native picker, and an optional Transparent/None chip. Two entry points share it:
//   • <SwatchRow>    — just the wrapping row of chips (drop into an already-open dropdown/menu).
//   • <SwatchButton> — a trigger showing the current colour that opens the row in a popover.
// Use SwatchButton anywhere a bare <input type="color"> used to sit, so every colour control matches.

export const SWATCHES = ['#ffffff', '#e8ecff', '#c5d0ff', '#8b93b8', '#0f1420',
  '#e5484d', '#f76b15', '#ffc53d', '#46a758', '#30a46c', '#00a2c7', '#0090ff', '#3e63dd', '#6e56cf', '#8e4ec6', '#d6409f', '#e93d82']

const RAINBOW = 'conic-gradient(from 0deg,#e5484d,#ffc53d,#46a758,#00a2c7,#3e63dd,#8e4ec6,#e5484d)'
const CHECKER = 'linear-gradient(45deg,#3a4570 25%,transparent 25%,transparent 75%,#3a4570 75%),linear-gradient(45deg,#3a4570 25%,#1a1a2e 25%,#1a1a2e 75%,#3a4570 75%)'
const norm = (c) => (c || '').toLowerCase()

// The wrapping row of chips. `value` highlights the active swatch. `onPick(color)` fires for a swatch or
// the custom picker; `onNone()` (when provided) renders a Transparent chip. `keepFocus` preserves the
// contentEditable selection (execCommand callers) by preventing default mousedown.
export function SwatchRow({ value, onPick, onNone, swatches = SWATCHES, size = 18, keepFocus = false }) {
  const keep = keepFocus ? (e => e.preventDefault()) : undefined
  const chip = (extra) => ({ width: size, height: size, borderRadius: 5, cursor: 'pointer', flexShrink: 0, ...extra })
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, padding: '2px' }}>
      {onNone && (
        <div title="Transparent / none" onMouseDown={keep} onClick={() => onNone()}
          style={chip({ background: CHECKER, backgroundSize: '8px 8px', backgroundPosition: '0 0,4px 4px', border: '1px solid #3a4570', position: 'relative' })} />
      )}
      {swatches.map(c => (
        <div key={c} title={c} onMouseDown={keep} onClick={() => onPick(c)}
          style={chip({ background: c,
            border: norm(value) === norm(c) ? '2px solid #6470f5'
              : (norm(c) === '#ffffff' || norm(c) === '#e8ecff' ? '1px solid #3a4570' : '1px solid rgba(255,255,255,0.15)'),
            boxShadow: norm(value) === norm(c) ? '0 0 0 2px rgba(100,112,245,0.35)' : 'none' })} />
      ))}
      <label onMouseDown={keep} title="Custom colour…"
        style={chip({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #3a4570', background: RAINBOW, overflow: 'hidden' })}>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#e8ecff'}
          onInput={e => onPick(e.target.value)} onClick={e => e.stopPropagation()}
          style={{ opacity: 0, width: '100%', height: '100%', cursor: 'pointer', border: 'none', padding: 0 }} />
      </label>
    </div>
  )
}

// A trigger button (shows the current colour) that opens SwatchRow in a popover anchored to it.
// Drop-in replacement for a bare <input type="color">.
export function SwatchButton({ value, onChange, onNone, swatches = SWATCHES, size = 20, title = 'Colour', disabled = false }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = e => { if (btnRef.current && !btnRef.current.contains(e.target) && !e.target.closest?.('[data-swatch-pop]')) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', close, true); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const toggle = (e) => {
    e.preventDefault(); e.stopPropagation()
    if (disabled) return
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - 210), top: r.bottom + 6 })
    setOpen(v => !v)
  }
  const isNone = !value || value === 'none' || value === 'transparent'
  return (
    <>
      <button ref={btnRef} type="button" title={title} onMouseDown={e => e.preventDefault()} onClick={toggle} disabled={disabled}
        style={{ width: size, height: size, borderRadius: 5, cursor: disabled ? 'default' : 'pointer', padding: 0, flexShrink: 0,
          border: '1px solid #3a4570', overflow: 'hidden', opacity: disabled ? 0.5 : 1,
          background: isNone ? CHECKER : value, backgroundSize: isNone ? '8px 8px' : undefined, backgroundPosition: isNone ? '0 0,4px 4px' : undefined }} />
      {open && pos && createPortal(
        <div data-swatch-pop="1" onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 100000, maxWidth: 208,
            background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 10, padding: 6, boxShadow: '0 10px 34px rgba(0,0,0,0.6)' }}>
          <SwatchRow value={value} swatches={swatches} onPick={c => { onChange?.(c); setOpen(false) }}
            onNone={onNone ? () => { onNone(); setOpen(false) } : undefined} />
        </div>, document.body)}
    </>
  )
}

export default SwatchButton
