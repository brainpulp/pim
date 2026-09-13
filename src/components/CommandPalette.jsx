import { useEffect, useMemo, useRef, useState } from 'react'

// ⌘K / Ctrl-K command palette — quick-jump to any node and run actions. The Figma/Linear-style
// launcher: quiet until summoned, keyboard-driven, closes on Esc / click-away.
export default function CommandPalette({ open, onClose, nodes, onJump, actions = [] }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => { if (open) { setQ(''); setSel(0); requestAnimationFrame(() => inputRef.current?.focus()) } }, [open])

  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    const acts = actions
      .filter(a => !s || a.label.toLowerCase().includes(s))
      .map(a => ({ kind: 'action', label: a.label, hint: a.hint, run: a.run }))
    let nodeHits = []
    if (s) {
      nodeHits = nodes
        .map(n => {
          const label = (n.label || '').trim()
          const lc = label.toLowerCase()
          const idx = lc.indexOf(s)
          const tagHit = (n.meta?.tags || []).some(t => t.toLowerCase().includes(s))
          if (idx < 0 && !tagHit) return null
          return { kind: 'node', id: n.id, label: label || '(untitled)', meta: n.meta || {}, score: idx < 0 ? 500 : idx }
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score || a.label.length - b.label.length)
        .slice(0, 40)
    }
    return [...acts, ...nodeHits]
  }, [q, nodes, actions])

  useEffect(() => { if (sel >= results.length) setSel(Math.max(0, results.length - 1)) }, [results, sel])
  useEffect(() => { const el = listRef.current?.querySelector(`[data-i="${sel}"]`); el?.scrollIntoView({ block: 'nearest' }) }, [sel])

  if (!open) return null
  const choose = (r) => { if (!r) return; if (r.kind === 'node') onJump(r.id); else r.run?.(); onClose() }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => Math.min(results.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[sel]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const TYPE_ICON = { task: '☑', note: '📝', idea: '💡', question: '❓', event: '📅' }
  return (
    <div onMouseDown={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(6,6,14,0.55)', backdropFilter: 'blur(2px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '13vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ width: 560, maxWidth: '92vw', background: '#141726', border: '1px solid #2b3050', borderRadius: 14, boxShadow: '0 24px 70px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid #23273f' }}>
          <span style={{ color: '#7c8cff', fontSize: 16 }}>⌘</span>
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0) }} onKeyDown={onKey}
            placeholder="Jump to anything, or run a command…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e8ecff', fontSize: 16 }} />
          <span style={{ fontSize: 11, color: '#7080a0', border: '1px solid #2b3050', borderRadius: 5, padding: '2px 6px' }}>esc</span>
        </div>
        <div ref={listRef} style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {results.length === 0 && <div style={{ padding: '18px 14px', color: '#7080a0', fontSize: 14 }}>{q ? 'No matches.' : 'Type to search nodes, or pick a command below.'}</div>}
          {results.map((r, i) => (
            <div key={r.kind + (r.id || r.label) + i} data-i={i}
              onMouseEnter={() => setSel(i)} onMouseDown={e => { e.preventDefault(); choose(r) }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9, cursor: 'pointer', background: i === sel ? '#222a52' : 'transparent' }}>
              <span style={{ width: 18, textAlign: 'center', fontSize: 14, flexShrink: 0 }}>
                {r.kind === 'action' ? '⚡' : (TYPE_ICON[r.meta?.itemType] || '•')}
              </span>
              <span style={{ flex: 1, color: r.kind === 'action' ? '#c5d0ff' : '#e8ecff', fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: r.meta?.done ? 'line-through' : 'none' }}>{r.label}</span>
              {r.kind === 'node' && (r.meta?.tags || []).slice(0, 3).map(t => <span key={t} style={{ fontSize: 11, color: '#8ab4ff', background: '#1a2242', borderRadius: 6, padding: '1px 6px', flexShrink: 0 }}>#{t}</span>)}
              <span style={{ fontSize: 11, color: '#66708f', flexShrink: 0 }}>{r.kind === 'action' ? (r.hint || 'command') : 'jump'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
