import { useState, useEffect, useRef } from 'react'
import { listProjects, createProject, renameProject, deleteProject } from '../lib/db'

export default function Projects({ onOpen, onSignOut }) {
  const [projects, setProjects] = useState(null) // null = loading
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)

  const load = async () => {
    try {
      setProjects(await listProjects())
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const p = await createProject('Untitled')
      onOpen(p.id, p.name)
    } catch (e) {
      setError(e.message)
      setCreating(false)
    }
  }

  const handleRename = async (id, name) => {
    try {
      await renameProject(id, name)
      setProjects(ps => ps.map(p => p.id === id ? { ...p, name } : p))
    } catch (e) {
      setError(e.message)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this project? This cannot be undone.')) return
    try {
      await deleteProject(id)
      setProjects(ps => ps.filter(p => p.id !== id))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={styles.bg}>
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.logo}>PIM</span>
          <button style={styles.signOut} onClick={onSignOut}>Sign out</button>
        </div>

        <h2 style={styles.title}>Your projects</h2>

        {error && <div style={styles.error}>{error}</div>}

        {projects === null ? (
          <div style={styles.loading}>Loading…</div>
        ) : (
          <div style={styles.list}>
            {projects.length === 0 && (
              <div style={styles.empty}>No projects yet. Create one below.</div>
            )}
            {projects.map(p => (
              <ProjectRow
                key={p.id}
                project={p}
                onOpen={() => onOpen(p.id, p.name)}
                onRename={name => handleRename(p.id, name)}
                onDelete={() => handleDelete(p.id)}
              />
            ))}
          </div>
        )}

        <button style={styles.createBtn} onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating…' : '+ New project'}
        </button>
      </div>
    </div>
  )
}

function ProjectRow({ project, onOpen, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const inputRef = useRef()

  // Sync draft when project name changes externally (fixes stale rename)
  useEffect(() => { if (!editing) setDraft(project.name) }, [project.name, editing])
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])

  const commit = () => {
    const name = draft.trim() || project.name
    setDraft(name)
    onRename(name)
    setEditing(false)
  }

  const age = formatAge(project.updated_at)

  return (
    <div style={styles.row} className="project-row" onClick={!editing ? onOpen : undefined}>
      <div style={styles.rowIcon}>⬡</div>
      <div style={styles.rowBody}>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            style={styles.rowInput}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(project.name); setEditing(false) } }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span style={styles.rowName}>{project.name}</span>
        )}
        <span style={styles.rowAge}>{age}</span>
      </div>
      <div style={styles.rowActions} className="project-row-actions">
        <button style={styles.iconBtn} title="Rename"
          onClick={e => { e.stopPropagation(); setEditing(true) }}>✎</button>
        <button style={{ ...styles.iconBtn, color: '#f87171' }} title="Delete"
          onClick={e => { e.stopPropagation(); onDelete() }}>×</button>
      </div>
    </div>
  )
}

function formatAge(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })
}

const styles = {
  bg: {
    height: '100vh', background: '#0a0a14',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  card: {
    width: 480, background: '#111118', border: '1px solid #1e1e2e',
    borderRadius: 12, padding: '1.75rem', boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column', gap: '1.2rem',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logo: { fontWeight: 800, fontSize: '1.1rem', color: '#5b6af0', letterSpacing: '0.05em' },
  signOut: {
    background: 'transparent', border: '1px solid #2a2a3e', color: '#555',
    borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: '0.78rem',
  },
  title: { fontSize: '1.1rem', fontWeight: 600, color: '#c7d0f8', margin: 0 },
  error: { background: '#2a1a1a', border: '1px solid #f87171', borderRadius: 6, padding: '0.6rem 0.85rem', color: '#f87171', fontSize: '0.82rem' },
  loading: { color: '#444', textAlign: 'center', padding: '1.5rem 0', fontSize: '0.85rem' },
  empty: { color: '#444', textAlign: 'center', padding: '1.5rem 0', fontSize: '0.85rem' },
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  row: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '0.65rem 0.75rem', borderRadius: 8,
    border: '1px solid #1e1e2e', cursor: 'pointer',
    transition: 'background 0.1s',
    position: 'relative',
  },
  rowIcon: { fontSize: '1.1rem', color: '#5b6af0', flexShrink: 0 },
  rowBody: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  rowName: { fontSize: '0.9rem', color: '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowAge: { fontSize: '0.72rem', color: '#444' },
  rowInput: {
    background: '#1a1a2e', border: '1px solid #5b6af0', color: '#fff',
    borderRadius: 4, padding: '2px 6px', fontSize: '0.88rem', outline: 'none', width: '100%',
  },
  rowActions: { display: 'flex', gap: 3, opacity: 0, transition: 'opacity 0.1s' },
  iconBtn: {
    background: 'transparent', border: 'none', color: '#5b6af0',
    cursor: 'pointer', fontSize: '1rem', padding: '2px 4px', lineHeight: 1,
  },
  createBtn: {
    padding: '0.6rem', borderRadius: 8, border: '1px dashed #2d3a6a',
    background: 'transparent', color: '#5b6af0', cursor: 'pointer',
    fontSize: '0.88rem', fontWeight: 600, transition: 'background 0.1s',
  },
}
