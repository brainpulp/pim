import { useEffect, useRef, useState } from 'react'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'

// Notion-style database grid: rows = nodes, columns = property definitions.
// Property schema is per project (project === one DB). Values live on node.props[propId].

const TYPES = [
  { type: 'text', label: 'Text', icon: 'T' },
  { type: 'number', label: 'Number', icon: '#' },
  { type: 'date', label: 'Date', icon: '📅' },
  { type: 'checkbox', label: 'Checkbox', icon: '☑' },
  { type: 'select', label: 'Select', icon: '◉' },
  { type: 'multiSelect', label: 'Tags', icon: '⛁' },
  { type: 'url', label: 'URL', icon: '🔗' },
]
const OPTION_COLORS = ['#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']

export default function Table({ projectId }) {
  const nodes = useGraphStore(s => s.nodes)
  const propertyDefs = useGraphStore(s => s.propertyDefs)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const addNode = useGraphStore(s => s.addNode)
  const updateLabel = useGraphStore(s => s.updateLabel)
  const deleteNode = useGraphStore(s => s.deleteNode)
  const addPropertyDef = useGraphStore(s => s.addPropertyDef)
  const updatePropertyDef = useGraphStore(s => s.updatePropertyDef)
  const deletePropertyDef = useGraphStore(s => s.deletePropertyDef)
  const addSelectOption = useGraphStore(s => s.addSelectOption)
  const setNodeProp = useGraphStore(s => s.setNodeProp)

  // Own autosave — Graph (which normally owns autosave) is unmounted in the table view.
  // Skip the first run so mounting never writes back unchanged data.
  const saveTimer = useRef(null)
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    if (!projectId) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveProject(projectId, { nodes, edges, views, activeViewId, propertyDefs }).catch(e => console.error('Save:', e))
    }, 1200)
    return () => clearTimeout(saveTimer.current)
  }, [nodes, propertyDefs, edges, views, activeViewId, projectId])

  const [addingCol, setAddingCol] = useState(false)
  const [menuCol, setMenuCol] = useState(null)

  return (
    <div style={styles.wrap}>
      <div style={styles.headerBar}>
        <h2 style={styles.heading}>Database</h2>
        <span style={styles.count}>{nodes.length} item{nodes.length === 1 ? '' : 's'} · {propertyDefs.length} propert{propertyDefs.length === 1 ? 'y' : 'ies'}</span>
      </div>

      <div style={styles.scroll}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, ...styles.nameCol }}>Name</th>
              {propertyDefs.map(def => (
                <th key={def.id} style={styles.th}>
                  <ColumnHeader def={def}
                    onRename={name => updatePropertyDef(def.id, { name })}
                    onRetype={type => updatePropertyDef(def.id, { type, ...(type === 'select' || type === 'multiSelect' ? { options: def.options || [] } : {}) })}
                    onDelete={() => deletePropertyDef(def.id)}
                    open={menuCol === def.id}
                    setOpen={o => setMenuCol(o ? def.id : null)}
                  />
                </th>
              ))}
              <th style={{ ...styles.th, width: 44, textAlign: 'center', position: 'relative' }}>
                <button style={styles.addColBtn} title="Add property" onClick={() => setAddingCol(v => !v)}>+</button>
                {addingCol && (
                  <AddColumnMenu onPick={type => { addPropertyDef(type); setAddingCol(false) }} onClose={() => setAddingCol(false)} />
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {nodes.map(n => (
              <tr key={n.id} style={styles.tr}>
                <td style={{ ...styles.td, ...styles.nameCol }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TextInput value={n.label} placeholder="Untitled" bold onCommit={v => updateLabel(n.id, v)} />
                    <button style={styles.rowDel} title="Delete item" onClick={() => { if (confirm(`Delete "${n.label || 'Untitled'}"?`)) deleteNode(n.id) }}>×</button>
                  </div>
                </td>
                {propertyDefs.map(def => (
                  <td key={def.id} style={styles.td}>
                    <Cell def={def} value={n.props?.[def.id]}
                      onChange={v => setNodeProp(n.id, def.id, v)}
                      onAddOption={(name, color) => addSelectOption(def.id, name, color)} />
                  </td>
                ))}
                <td style={styles.td} />
              </tr>
            ))}
            <tr>
              <td style={{ ...styles.td, ...styles.nameCol }}>
                <button style={styles.addRowBtn} onClick={() => addNode('New item')}>+ New</button>
              </td>
              <td style={styles.td} colSpan={propertyDefs.length + 1} />
            </tr>
          </tbody>
        </table>

        {propertyDefs.length === 0 && (
          <div style={styles.hint}>No properties yet. Click <strong style={{ color: '#a0b4f0' }}>+</strong> in the header to add one (Text, Number, Date, Tags…).</div>
        )}
      </div>
    </div>
  )
}

// ── Column header: name + type, with rename / retype / delete menu ──────────
function ColumnHeader({ def, onRename, onRetype, onDelete, open, setOpen }) {
  const [editing, setEditing] = useState(false)
  const typeIcon = TYPES.find(t => t.type === def.type)?.icon || 'T'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      <span style={{ color: '#5b6af0', fontSize: '0.7rem', width: 14, textAlign: 'center' }}>{typeIcon}</span>
      {editing ? (
        <input autoFocus defaultValue={def.name}
          onBlur={e => { onRename(e.target.value.trim() || def.name); setEditing(false) }}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false) }}
          style={styles.headerInput} />
      ) : (
        <span style={{ flex: 1, cursor: 'pointer', color: '#c5d0ff' }} onDoubleClick={() => setEditing(true)}>{def.name}</span>
      )}
      <button style={styles.colMenuBtn} onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <>
          <div style={styles.backdrop} onClick={() => setOpen(false)} />
          <div style={styles.colMenu} onClick={e => e.stopPropagation()}>
            <div style={styles.menuItem} onClick={() => { setEditing(true); setOpen(false) }}>Rename</div>
            <div style={styles.menuLabel}>Type</div>
            {TYPES.map(t => (
              <div key={t.type} style={{ ...styles.menuItem, color: def.type === t.type ? '#fff' : '#c5d0ff' }}
                onClick={() => { onRetype(t.type); setOpen(false) }}>
                <span style={{ width: 16, display: 'inline-block' }}>{t.icon}</span> {t.label}{def.type === t.type ? '  ✓' : ''}
              </div>
            ))}
            <div style={styles.menuDivider} />
            <div style={{ ...styles.menuItem, color: '#f87171' }} onClick={() => { onDelete(); setOpen(false) }}>Delete property</div>
          </div>
        </>
      )}
    </div>
  )
}

function AddColumnMenu({ onPick, onClose }) {
  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div style={{ ...styles.colMenu, right: 0, left: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={styles.menuLabel}>New property</div>
        {TYPES.map(t => (
          <div key={t.type} style={styles.menuItem} onClick={() => onPick(t.type)}>
            <span style={{ width: 16, display: 'inline-block' }}>{t.icon}</span> {t.label}
          </div>
        ))}
      </div>
    </>
  )
}

// ── Per-type cell ───────────────────────────────────────────────────────────
function Cell({ def, value, onChange, onAddOption }) {
  if (def.type === 'checkbox')
    return <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#5b6af0', cursor: 'pointer' }} />
  if (def.type === 'number')
    return <TextInput value={value ?? ''} numeric onCommit={v => onChange(v === '' ? null : Number(v))} placeholder="—" />
  if (def.type === 'date')
    return <input type="date" value={value || ''} onChange={e => onChange(e.target.value || null)} style={styles.dateInput} />
  if (def.type === 'url')
    return <UrlCell value={value} onChange={onChange} />
  if (def.type === 'select' || def.type === 'multiSelect')
    return <SelectCell def={def} value={value} multi={def.type === 'multiSelect'} onChange={onChange} onAddOption={onAddOption} />
  return <TextInput value={value ?? ''} onCommit={v => onChange(v)} placeholder="—" />
}

// Text/number input that commits on blur/Enter (avoids store churn per keystroke)
function TextInput({ value, onCommit, placeholder, bold, numeric }) {
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
      style={{ ...styles.cellInput, fontWeight: bold ? 600 : 400, color: bold ? '#e6ebff' : '#c5d0ff' }}
    />
  )
}

function UrlCell({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return value
      ? <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <a href={value} target="_blank" rel="noreferrer" style={styles.link} onClick={e => e.stopPropagation()}>{value}</a>
          <button style={styles.miniEdit} onClick={() => setEditing(true)}>✎</button>
        </div>
      : <div style={{ ...styles.cellInput, color: '#8090b8', cursor: 'text' }} onClick={() => setEditing(true)}>—</div>
  }
  return <TextInput value={value ?? ''} onCommit={v => { onChange(v || null); setEditing(false) }} placeholder="https://…" />
}

// Select / multi-select with an inline options popover
function SelectCell({ def, value, multi, onChange, onAddOption }) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const options = def.options || []
  const selected = multi ? (Array.isArray(value) ? value : []) : (value ? [value] : [])
  const chip = optId => {
    const o = options.find(x => x.id === optId)
    if (!o) return null
    return <span key={optId} style={{ ...styles.chip, background: (o.color || '#6366f1') + '33', border: `1px solid ${o.color || '#6366f1'}`, color: '#e6ebff' }}>{o.name}</span>
  }
  const toggle = optId => {
    if (multi) {
      const set = new Set(selected)
      set.has(optId) ? set.delete(optId) : set.add(optId)
      onChange([...set])
    } else {
      onChange(selected[0] === optId ? null : optId)
      setOpen(false)
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
          <div style={styles.backdrop} onClick={() => setOpen(false)} />
          <div style={styles.selectMenu} onClick={e => e.stopPropagation()}>
            {options.map(o => (
              <div key={o.id} style={styles.menuItem} onClick={() => toggle(o.id)}>
                <span style={{ ...styles.dot, background: o.color || '#6366f1' }} />
                <span style={{ flex: 1, color: '#c5d0ff' }}>{o.name}</span>
                {selected.includes(o.id) && <span style={{ color: '#5b6af0' }}>✓</span>}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4, padding: '6px 8px' }}>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New option…"
                onKeyDown={e => { if (e.key === 'Enter') addNew() }}
                style={{ ...styles.cellInput, flex: 1, border: '1px solid #2d3a6a', borderRadius: 4, padding: '3px 6px' }} autoFocus />
              <button style={styles.addOptBtn} onClick={addNew}>Add</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const styles = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', background: '#0c0c1a', color: '#c5d0ff', overflow: 'hidden' },
  headerBar: { display: 'flex', alignItems: 'baseline', gap: 12, padding: '1rem 1.5rem 0.75rem' },
  heading: { margin: 0, fontSize: '1.2rem', fontWeight: 600, color: '#e6ebff' },
  count: { fontSize: '0.78rem', color: '#8090b8' },
  scroll: { flex: 1, overflow: 'auto', padding: '0 1.5rem 2rem' },
  table: { borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.85rem' },
  th: { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #2a3358', borderRight: '1px solid #1a2036',
    color: '#8090b8', fontWeight: 500, position: 'sticky', top: 0, background: '#12122a', minWidth: 120, verticalAlign: 'middle' },
  nameCol: { minWidth: 220, position: 'sticky', left: 0, background: '#12122a', zIndex: 1 },
  tr: {},
  td: { padding: '3px 10px', borderBottom: '1px solid #1a2036', borderRight: '1px solid #1a2036', verticalAlign: 'middle', background: '#0e0e1c' },
  cellInput: { width: '100%', boxSizing: 'border-box', background: 'transparent', border: 'none', outline: 'none',
    color: '#c5d0ff', fontSize: '0.85rem', padding: '3px 2px', fontFamily: 'inherit' },
  dateInput: { background: 'transparent', border: 'none', outline: 'none', color: '#c5d0ff', fontSize: '0.82rem', colorScheme: 'dark', fontFamily: 'inherit' },
  headerInput: { flex: 1, background: '#0e0e1c', border: '1px solid #5b6af0', borderRadius: 4, color: '#fff', fontSize: '0.82rem', padding: '2px 5px', outline: 'none' },
  addColBtn: { background: 'transparent', border: '1px solid #2d3a6a', borderRadius: 5, color: '#a0b4f0', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '2px 7px' },
  addRowBtn: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '0.82rem', padding: '4px 2px' },
  rowDel: { background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '0.95rem', lineHeight: 1, opacity: 0.7, flexShrink: 0 },
  colMenuBtn: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, padding: '0 2px' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 40 },
  colMenu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 41, background: '#16162a', border: '1px solid #2d3a6a',
    borderRadius: 8, padding: '5px 0', minWidth: 170, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  selectMenu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 41, background: '#16162a', border: '1px solid #2d3a6a',
    borderRadius: 8, padding: '4px 0', minWidth: 180, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  menuItem: { display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  menuLabel: { padding: '4px 12px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  menuDivider: { borderTop: '1px solid #2a3358', margin: '4px 0' },
  chip: { fontSize: '0.72rem', padding: '1px 7px', borderRadius: 10, whiteSpace: 'nowrap' },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  link: { color: '#88b4e8', fontSize: '0.82rem', textDecoration: 'underline', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200, display: 'inline-block' },
  miniEdit: { background: 'transparent', border: 'none', color: '#7080a0', cursor: 'pointer', fontSize: '0.7rem' },
  addOptBtn: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 4, cursor: 'pointer', fontSize: '0.72rem', padding: '2px 8px' },
  hint: { color: '#8090b8', fontSize: '0.85rem', padding: '1.5rem 0.5rem', textAlign: 'center' },
}
