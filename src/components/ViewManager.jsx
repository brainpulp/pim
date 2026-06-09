import { useState, useEffect, useRef } from 'react'
import useGraphStore from '../lib/graphStore'

export default function ViewManager() {
  const views        = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const setActiveView  = useGraphStore(s => s.setActiveView)
  const addView        = useGraphStore(s => s.addView)
  const duplicateView  = useGraphStore(s => s.duplicateView)
  const renameView     = useGraphStore(s => s.renameView)
  const deleteView     = useGraphStore(s => s.deleteView)
  const exitDrill      = useGraphStore(s => s.exitDrill)
  const activeView     = views.find(v => v.id === activeViewId) || views[0]

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerLabel}>VIEWS</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {activeView?.drillRoot && (
            <button style={styles.drillBadge} onClick={exitDrill} title="Exit drill mode">⊙ drill</button>
          )}
          <button style={styles.addBtn} onClick={() => addView()} title="New view">+</button>
        </div>
      </div>
      <div style={styles.list}>
        {views.map(v => (
          <ViewRow
            key={v.id}
            view={v}
            isActive={v.id === activeViewId}
            onActivate={() => setActiveView(v.id)}
            onRename={name => renameView(v.id, name)}
            onDuplicate={() => duplicateView(v.id)}
            onDelete={() => deleteView(v.id)}
            canDelete={views.length > 1}
          />
        ))}
      </div>
    </div>
  )
}

function ViewRow({ view, isActive, onActivate, onRename, onDuplicate, onDelete, canDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(view.name)
  const inputRef = useRef()

  useEffect(() => { if (!editing) setDraft(view.name) }, [view.name, editing])
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])

  const commit = () => { onRename(draft.trim() || view.name); setEditing(false) }

  return (
    <div
      className={`view-row${isActive ? ' view-row-active' : ''}`}
      onClick={onActivate}
    >
      <span style={styles.viewDot(isActive)} />

      {editing ? (
        <input
          ref={inputRef}
          style={styles.input}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span
          style={styles.viewName(isActive)}
          onDoubleClick={e => { e.stopPropagation(); setEditing(true) }}
          title="Double-click to rename"
        >
          {view.name}
          {view.drillRoot && <span style={styles.drillTag}>⊳</span>}
        </span>
      )}

      <div className="view-actions">
        <button style={styles.iconBtn} onClick={e => { e.stopPropagation(); onDuplicate() }} title="Duplicate">⧉</button>
        {canDelete && (
          <button style={{ ...styles.iconBtn, color: '#f87171' }} onClick={e => { e.stopPropagation(); onDelete() }} title="Delete">×</button>
        )}
      </div>
    </div>
  )
}

const styles = {
  panel: {
    borderTop: '1px solid #1e1e2e', flexShrink: 0,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.5rem 0.75rem', borderBottom: '1px solid #1e1e2e',
  },
  headerLabel: { fontSize: '0.65rem', fontWeight: 700, color: '#555', letterSpacing: '0.08em' },
  addBtn: {
    fontSize: '0.85rem', padding: '1px 6px', borderRadius: 4,
    border: '1px solid #2a2a3e', background: 'transparent', color: '#5b6af0', cursor: 'pointer',
  },
  drillBadge: {
    fontSize: '0.6rem', padding: '1px 5px', borderRadius: 4,
    border: '1px solid #5b6af0', background: 'transparent', color: '#5b6af0', cursor: 'pointer',
  },
  list: { padding: '0.25rem 0', maxHeight: 180, overflowY: 'auto' },
  viewDot: (active) => ({
    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
    background: active ? '#5b6af0' : '#2d3a6a', marginRight: 2,
  }),
  viewName: (active) => ({
    flex: 1, fontSize: '0.8rem', cursor: 'default',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: active ? '#c7d0f8' : '#777', userSelect: 'none',
  }),
  input: {
    flex: 1, background: '#1a1a2e', border: '1px solid #5b6af0',
    color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: '0.8rem', outline: 'none', minWidth: 0,
  },
  iconBtn: {
    background: 'transparent', border: 'none', color: '#5b6af0',
    cursor: 'pointer', fontSize: '0.85rem', padding: '0 2px', lineHeight: 1,
  },
  drillTag: { marginLeft: 4, fontSize: 9, color: '#5b6af0' },
}
