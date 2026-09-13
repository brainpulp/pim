import { useEffect, useMemo, useRef, useState } from 'react'
import { FONT_CATEGORIES, fontStack, loadFont, loadFontFull, getCatalog, subscribeCatalog, ensureLiveCatalog, isLiveCatalog, weightsFor } from '../lib/fonts'

const WEIGHT_LABEL = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extrabold', 900: 'Black' }

// A Google-Fonts-style picker: search box + category filter chips + a scrolling list where every row
// previews itself in its own font. Fonts load lazily (only when a row scrolls into view) so opening the
// picker doesn't fire hundreds of network requests. `value` = currently chosen family (or null/'' for the
// app default). onPick(family|null) applies; onClose dismisses.
const WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extrabold']]

// Extra searchable tags per font — its Google category plus common synonyms and name-derived traits
// (slab, condensed, mono, script…), so the search box works like Google Fonts' tag filtering.
const CAT_TAGS = {
  'sans-serif': ['sans', 'sans-serif', 'sans serif', 'grotesque', 'grotesk', 'geometric'],
  'serif': ['serif', 'roman', 'slab'],
  'display': ['display', 'decorative', 'poster', 'headline', 'bold'],
  'handwriting': ['handwriting', 'hand', 'script', 'cursive', 'calligraphy', 'brush', 'signature'],
  'monospace': ['mono', 'monospace', 'code', 'typewriter', 'fixed'],
}
function tagsFor(f) {
  const tags = [...(CAT_TAGS[f.category] || [])]
  const n = f.family.toLowerCase()
  if (n.includes('slab')) tags.push('slab')
  if (n.includes('condensed') || n.includes('narrow')) tags.push('condensed', 'narrow')
  if (n.includes('mono')) tags.push('mono')
  if (n.includes('script')) tags.push('script')
  if (n.includes('hand')) tags.push('hand', 'handwriting')
  if (n.includes('display')) tags.push('display')
  return tags
}

export default function FontPicker({ value, onPick, onClose, title = 'Font', weight, onSetWeight }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [catalog, setCatalog] = useState(getCatalog())
  const [live, setLive] = useState(isLiveCatalog())

  // Load the full live Google Fonts catalog (once), and re-render when it arrives.
  useEffect(() => {
    ensureLiveCatalog()
    const unsub = subscribeCatalog(c => { setCatalog(c); setLive(isLiveCatalog()) })
    return unsub
  }, [])

  // Two-step flow: browse the list, then PREVIEW a font's weights before committing. `preview` is the
  // family currently being auditioned (opens on the applied font, if any, so you can tweak its weight).
  const [preview, setPreview] = useState(value || null)

  // Load the auditioned font's FULL weight range so every weight row previews correctly.
  useEffect(() => { if (preview) loadFontFull(preview) }, [preview, catalog])
  useEffect(() => { if (value) loadFont(value, weight) }, [value, weight])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return catalog.filter(f =>
      (cat === 'all' || f.category === cat) &&
      // Match the family name OR its category/tags, so typing "serif", "mono", "script", "hand", "slab"…
      // filters like Google's tag search does.
      (!needle || f.family.toLowerCase().includes(needle) || tagsFor(f).some(t => t.includes(needle)))
    )
  }, [q, cat, catalog])

  // The auditioned font's actual shipped weights (from the live catalog), else a common set.
  const previewWeights = useMemo(() => (preview ? weightsFor(preview) : [300, 400, 500, 600, 700]), [preview, catalog])

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
          {preview && (
            <button onClick={() => setPreview(null)} title="Back to all fonts"
              style={{ background: 'transparent', border: 'none', color: '#8fb4ff', cursor: 'pointer', fontSize: 13, padding: 0 }}>‹ Fonts</button>
          )}
          <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: '#c5d0ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{preview || title}</span>
          <button onClick={() => { onPick?.(null); onClose?.() }} title="Reset to the default font"
            style={{ background: value ? '#171d38' : '#1e2547', border: '1px solid #2a3358', color: '#9aa8d8', borderRadius: 7, padding: '4px 9px', fontSize: 12, cursor: 'pointer' }}>Default</button>
          <button onClick={onClose} title="Close"
            style={{ background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>

        {preview ? (
          /* ── Preview a font's weights, then pick one ── */
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: '1px solid #23283f', padding: '6px 6px 10px' }}>
            <div style={{ fontSize: 10.5, color: '#8090b8', padding: '4px 8px 6px' }}>Pick a weight — tap one to apply:</div>
            {previewWeights.map(w => {
              const on = preview === value && (weight || 400) === w
              return (
                <button key={w} onClick={() => { if (preview !== value) onPick?.(preview); onSetWeight?.(w); onClose?.() }}
                  onMouseEnter={e => { if (!on) e.currentTarget.style.background = '#161a34' }}
                  onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent' }}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                    padding: '10px 12px', borderRadius: 8, background: on ? '#1c2148' : 'transparent', borderLeft: `2px solid ${on ? '#5b6af0' : 'transparent'}` }}>
                  <span style={{ flex: 1, fontFamily: fontStack(preview), fontWeight: w, fontSize: 22, color: '#eaf0ff', lineHeight: 1.1 }}>Ag The quick brown fox</span>
                  <span style={{ fontSize: 11, color: on ? '#8ecbff' : '#8090b8', flexShrink: 0 }}>{WEIGHT_LABEL[w] || w} · {w}</span>
                </button>
              )
            })}
          </div>
        ) : (<>
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

          {/* List — click a font to preview its weights (doesn't commit yet) */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: '1px solid #23283f' }}>
            {list.length === 0 && (
              <div style={{ color: '#8090b8', fontSize: 13, textAlign: 'center', padding: '24px 12px' }}>No fonts match "{q}".</div>
            )}
            {list.slice(0, 300).map(f => (
              <FontRow key={f.family} family={f.family} category={f.category} selected={f.family === value}
                onPick={() => setPreview(f.family)} />
            ))}
            {list.length > 300 && (
              <div style={{ color: '#7080a0', fontSize: 12, textAlign: 'center', padding: '12px' }}>
                +{list.length - 300} more — search or pick a category to narrow.
              </div>
            )}
          </div>

          <div style={{ padding: '6px 12px', borderTop: '1px solid #23283f', fontSize: 11, color: '#7080a0' }}>
            {list.length} font{list.length === 1 ? '' : 's'} · {live ? 'full Google Fonts catalog' : 'loading full catalog…'}
          </div>
        </>)}
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
