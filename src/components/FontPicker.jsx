import { useEffect, useMemo, useRef, useState } from 'react'
import { GOOGLE_FONTS, FONT_CATEGORIES, fontStack, loadFont } from '../lib/fonts'

// A Google-Fonts-style picker: search box + category filter chips + a scrolling list where every row
// previews itself in its own font. Fonts load lazily (only when a row scrolls into view) so opening the
// picker doesn't fire hundreds of network requests. `value` = currently chosen family (or null/'' for the
// app default). onPick(family|null) applies; onClose dismisses.
export default function FontPicker({ value, onPick, onClose, title = 'Font' }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')

  // Preload the currently-selected font so its row (and the "Current:" line) render correctly right away.
  useEffect(() => { if (value) loadFont(value) }, [value])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return GOOGLE_FONTS.filter(f =>
      (cat === 'all' || f.category === cat) &&
      (!needle || f.family.toLowerCase().includes(needle))
    )
  }, [q, cat])

  return (
    <div onMouseDown={onClose} onContextMenu={e => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, zIndex: 8000, background: 'rgba(6,6,16,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ width: 'min(420px, 94vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.6)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 6px' }}>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: '#c5d0ff' }}>{title}</span>
          <button onClick={() => { onPick?.(null); onClose?.() }} title="Reset to the default font"
            style={{ background: value ? '#171d38' : '#1e2547', border: '1px solid #2a3358', color: '#9aa8d8', borderRadius: 7, padding: '4px 9px', fontSize: 12, cursor: 'pointer' }}>Default</button>
          <button onClick={onClose} title="Close"
            style={{ background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>

        {/* Search */}
        <div style={{ padding: '0 12px 6px' }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search fonts…"
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onClose?.() }}
            style={{ width: '100%', boxSizing: 'border-box', background: '#0d0d1e', border: '1px solid #2a3358', borderRadius: 8, color: '#e6ebff', fontSize: 13, padding: '7px 10px', outline: 'none' }} />
        </div>

        {/* Category chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '0 12px 8px' }}>
          {FONT_CATEGORIES.map(c => (
            <button key={c.id} onClick={() => setCat(c.id)}
              style={{ borderRadius: 999, padding: '3px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${cat === c.id ? '#5b6af0' : '#2a3358'}`,
                background: cat === c.id ? '#1e2547' : 'transparent',
                color: cat === c.id ? '#dbe4ff' : '#9aa8d8' }}>{c.label}</button>
          ))}
        </div>

        {/* List */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: '1px solid #23283f' }}>
          {list.length === 0 && (
            <div style={{ color: '#8090b8', fontSize: 13, textAlign: 'center', padding: '24px 12px' }}>No fonts match "{q}".</div>
          )}
          {list.map(f => (
            <FontRow key={f.family} family={f.family} category={f.category} selected={f.family === value}
              onPick={() => { onPick?.(f.family); onClose?.() }} />
          ))}
        </div>

        <div style={{ padding: '6px 12px', borderTop: '1px solid #23283f', fontSize: 11, color: '#7080a0' }}>
          {list.length} font{list.length === 1 ? '' : 's'} · from Google Fonts
        </div>
      </div>
    </div>
  )
}

// One row: previews the family name in its own font, loading the font only when it scrolls into view.
function FontRow({ family, category, selected, onPick }) {
  const ref = useRef(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current; if (!el) return
    if (!('IntersectionObserver' in window)) { loadFont(family); setShown(true); return }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { loadFont(family); setShown(true); io.disconnect() }
    }, { root: el.closest('[data-fontlist]') || null, rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
  }, [family])

  return (
    <div ref={ref} onClick={onPick}
      style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 14px', cursor: 'pointer',
        background: selected ? '#1c2148' : 'transparent', borderLeft: `2px solid ${selected ? '#5b6af0' : 'transparent'}` }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = '#161a34' }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent' }}>
      <span style={{ flex: 1, fontSize: 20, lineHeight: 1.15, color: '#eaf0ff',
        fontFamily: shown ? fontStack(family) : 'inherit' }}>{family}</span>
      <span style={{ fontSize: 10.5, color: '#7080a0', flexShrink: 0, textTransform: 'capitalize' }}>{category.replace('-', ' ')}</span>
      {selected && <span style={{ color: '#8ecbff', fontSize: 13, flexShrink: 0 }}>✓</span>}
    </div>
  )
}
