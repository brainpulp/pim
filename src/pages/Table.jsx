import { useEffect, useRef, useState } from 'react'
import useGraphStore from '../lib/graphStore'
import { saveProject } from '../lib/db'
import { PropertyField, TextInput, PROP_TYPES } from '../components/PropertyField'

// Notion-style database grid: rows = nodes, columns = property definitions.
// Property schema is per project (project === one DB). Values live on node.props[propId].

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
                {addingCol && <AddColumnMenu onPick={type => { addPropertyDef(type); setAddingCol(false) }} onClose={() => setAddingCol(false)} />}
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
                    <PropertyField def={def} value={n.props?.[def.id]}
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

function ColumnHeader({ def, onRename, onRetype, onDelete, open, setOpen }) {
  const [editing, setEditing] = useState(false)
  const typeIcon = PROP_TYPES.find(t => t.type === def.type)?.icon || 'T'
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
            {PROP_TYPES.map(t => (
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
        {PROP_TYPES.map(t => (
          <div key={t.type} style={styles.menuItem} onClick={() => onPick(t.type)}>
            <span style={{ width: 16, display: 'inline-block' }}>{t.icon}</span> {t.label}
          </div>
        ))}
      </div>
    </>
  )
}

const styles = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', background: '#0c0c1a', color: '#c5d0ff', overflow: 'hidden' },
  headerBar: { display: 'flex', alignItems: 'baseline', gap: 12, padding: '1rem 1.5rem 0.75rem' },
  heading: { margin: 0, fontSize: '1.2rem', fontWeight: 600, color: '#e6ebff' },
  count: { fontSize: '0.78rem', color: '#8090b8' },
  scroll: { flex: 1, overflow: 'auto', padding: '0 1.5rem 2rem' },
  table: { borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.85rem' },
  th: { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #2a3358', borderRight: '1px solid #1a2036', color: '#8090b8', fontWeight: 500, position: 'sticky', top: 0, background: '#12122a', minWidth: 120, verticalAlign: 'middle' },
  nameCol: { minWidth: 220, position: 'sticky', left: 0, background: '#12122a', zIndex: 1 },
  tr: {},
  td: { padding: '3px 10px', borderBottom: '1px solid #1a2036', borderRight: '1px solid #1a2036', verticalAlign: 'middle', background: '#0e0e1c' },
  headerInput: { flex: 1, background: '#0e0e1c', border: '1px solid #5b6af0', borderRadius: 4, color: '#fff', fontSize: '0.82rem', padding: '2px 5px', outline: 'none' },
  addColBtn: { background: 'transparent', border: '1px solid #2d3a6a', borderRadius: 5, color: '#a0b4f0', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '2px 7px' },
  addRowBtn: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '0.82rem', padding: '4px 2px' },
  rowDel: { background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '0.95rem', lineHeight: 1, opacity: 0.7, flexShrink: 0 },
  colMenuBtn: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, padding: '0 2px' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 40 },
  colMenu: { position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 41, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 170, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  menuItem: { display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  menuLabel: { padding: '4px 12px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  menuDivider: { borderTop: '1px solid #2a3358', margin: '4px 0' },
  hint: { color: '#8090b8', fontSize: '0.85rem', padding: '1.5rem 0.5rem', textAlign: 'center' },
}
