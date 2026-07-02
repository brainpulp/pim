import { useEffect, useRef, useState } from 'react'

// Shared Notion-style property editors, used by both the Table grid and the node toolbar.
// PropertyField renders the value editor for one property def; the surrounding layout
// (column cell vs. labelled row) is the caller's responsibility.

export const PROP_TYPES = [
  { type: 'text', label: 'Text', icon: 'T' },
  { type: 'number', label: 'Number', icon: '#' },
  { type: 'date', label: 'Date', icon: '📅' },
  { type: 'checkbox', label: 'Checkbox', icon: '☑' },
  { type: 'select', label: 'Select', icon: '◉' },
  { type: 'multiSelect', label: 'Tags', icon: '⛁' },
  { type: 'url', label: 'URL', icon: '🔗' },
]
export const OPTION_COLORS = ['#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']

export function PropertyField({ def, value, onChange, onAddOption }) {
  if (def.type === 'checkbox')
    return <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#5b6af0', cursor: 'pointer' }} />
  if (def.type === 'number')
    return <TextInput value={value ?? ''} numeric onCommit={v => onChange(v === '' ? null : Number(v))} placeholder="—" />
  if (def.type === 'date')
    return <input type="date" value={value || ''} onChange={e => onChange(e.target.value || null)} style={S.dateInput} />
  if (def.type === 'url')
    return <UrlCell value={value} onChange={onChange} />
  if (def.type === 'select' || def.type === 'multiSelect')
    return <SelectCell def={def} value={value} multi={def.type === 'multiSelect'} onChange={onChange} onAddOption={onAddOption} />
  return <TextInput value={value ?? ''} onCommit={v => onChange(v)} placeholder="—" />
}

// Commits on blur/Enter to avoid store churn on every keystroke.
export function TextInput({ value, onCommit, placeholder, bold, numeric }) {
  const [draft, setDraft] = useState(value ?? '')
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value ?? '') }, [value])
  return (
    <input
      value={draft}
      type={numeric ? 'number' : 'text'}
      placeholder={placeholder}
      onFocus={() => { focused.current = true }}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { focused.current = false; if (draft !== (value ?? '')) onCommit(draft) }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(value ?? ''); e.currentTarget.blur() } }}
      style={{ ...S.cellInput, fontWeight: bold ? 600 : 400, color: bold ? '#e6ebff' : '#c5d0ff' }}
    />
  )
}

function UrlCell({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return value
      ? <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <a href={value} target="_blank" rel="noreferrer" style={S.link} onClick={e => e.stopPropagation()}>{value}</a>
          <button style={S.miniEdit} onClick={() => setEditing(true)}>✎</button>
        </div>
      : <div style={{ ...S.cellInput, color: '#8090b8', cursor: 'text' }} onClick={() => setEditing(true)}>—</div>
  }
  return <TextInput value={value ?? ''} onCommit={v => { onChange(v || null); setEditing(false) }} placeholder="https://…" />
}

function SelectCell({ def, value, multi, onChange, onAddOption }) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const options = def.options || []
  const selected = multi ? (Array.isArray(value) ? value : []) : (value ? [value] : [])
  const chip = optId => {
    const o = options.find(x => x.id === optId)
    if (!o) return null
    return <span key={optId} style={{ ...S.chip, background: (o.color || '#6366f1') + '33', border: `1px solid ${o.color || '#6366f1'}`, color: '#e6ebff' }}>{o.name}</span>
  }
  const toggle = optId => {
    if (multi) {
      const set = new Set(selected)
      set.has(optId) ? set.delete(optId) : set.add(optId)
      onChange([...set])
    } else {
      onChange(selected[0] === optId ? null : optId); setOpen(false)
    }
  }
  const addNew = () => {
    const name = newName.trim(); if (!name) return
    const color = OPTION_COLORS[options.length % OPTION_COLORS.length]
    const id = onAddOption(name, color)
    setNewName('')
    if (multi) onChange([...selected, id]); else { onChange(id); setOpen(false) }
  }
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center', cursor: 'pointer', minHeight: 22 }} onClick={() => setOpen(o => !o)}>
        {selected.length ? selected.map(chip) : <span style={{ color: '#8090b8' }}>—</span>}
      </div>
      {open && (
        <>
          <div style={S.backdrop} onClick={() => setOpen(false)} />
          <div style={S.selectMenu} onClick={e => e.stopPropagation()}>
            {options.map(o => (
              <div key={o.id} style={S.menuItem} onClick={() => toggle(o.id)}>
                <span style={{ ...S.dot, background: o.color || '#6366f1' }} />
                <span style={{ flex: 1, color: '#c5d0ff' }}>{o.name}</span>
                {selected.includes(o.id) && <span style={{ color: '#5b6af0' }}>✓</span>}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4, padding: '6px 8px' }}>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New option…"
                onKeyDown={e => { if (e.key === 'Enter') addNew() }}
                style={{ ...S.cellInput, flex: 1, border: '1px solid #2d3a6a', borderRadius: 4, padding: '3px 6px' }} autoFocus />
              <button style={S.addOptBtn} onClick={addNew}>Add</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const S = {
  cellInput: { width: '100%', boxSizing: 'border-box', background: 'transparent', border: 'none', outline: 'none', color: '#c5d0ff', fontSize: '0.82rem', padding: '3px 2px', fontFamily: 'inherit' },
  dateInput: { background: 'transparent', border: 'none', outline: 'none', color: '#c5d0ff', fontSize: '0.8rem', colorScheme: 'dark', fontFamily: 'inherit' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 60 },
  selectMenu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 61, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '4px 0', minWidth: 180, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  menuItem: { display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  chip: { fontSize: '0.72rem', padding: '1px 7px', borderRadius: 10, whiteSpace: 'nowrap' },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  link: { color: '#88b4e8', fontSize: '0.82rem', textDecoration: 'underline', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200, display: 'inline-block' },
  miniEdit: { background: 'transparent', border: 'none', color: '#7080a0', cursor: 'pointer', fontSize: '0.7rem' },
  addOptBtn: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 4, cursor: 'pointer', fontSize: '0.72rem', padding: '2px 8px' },
}
