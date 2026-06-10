import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import Auth from './components/Auth'
import Projects from './pages/Projects'
import Graph from './pages/Graph'
import Table from './pages/Table'

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  // Initialize project synchronously from localStorage — avoids race with onAuthStateChange
  const [project, setProject] = useState(() => {
    try {
      const saved = localStorage.getItem('pim_last_project')
      return saved ? JSON.parse(saved) : null
    } catch { return null }
  })
  const [view, setView] = useState('graph')

  const openProject = (id, name) => {
    localStorage.setItem('pim_last_project', JSON.stringify({ id, name }))
    setProject({ id, name })
  }
  const closeProject = () => {
    localStorage.removeItem('pim_last_project')
    setProject(null)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) { setProject(null); localStorage.removeItem('pim_last_project') }
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return <div style={loadingStyle}>Loading…</div>
  if (!session) return <Auth />
  if (!project) return (
    <Projects
      onOpen={openProject}
      onSignOut={() => supabase.auth.signOut()}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f0f' }}>
      <nav style={navStyle}>
        <button style={backBtnStyle} onClick={closeProject} title="All projects">← Projects</button>
        <span style={projectNameStyle}>{project.name}</span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {['graph', 'table'].map(v => (
            <button
              key={v}
              style={{ ...navBtnStyle, ...(view === v ? navBtnActiveStyle : {}) }}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <button style={signOutStyle} onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </nav>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {view === 'graph' && (
          <Graph
            projectId={project.id}
            projectName={project.name}
            onBack={() => setProject(null)}
          />
        )}
        {view === 'table' && <Table />}
      </div>
    </div>
  )
}

const navStyle = {
  display: 'flex', alignItems: 'center', gap: '0.75rem',
  padding: '0 1rem', height: 44, background: '#111118',
  borderBottom: '1px solid #1e1e2e', flexShrink: 0, zIndex: 100,
}
const backBtnStyle = {
  padding: '0.25rem 0.7rem', borderRadius: 6, border: '1px solid #2a2a3e',
  background: 'transparent', color: '#5b6af0', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
}
const projectNameStyle = {
  fontSize: '0.85rem', color: '#888', fontWeight: 500,
  maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const navBtnStyle = {
  padding: '0.25rem 0.75rem', borderRadius: 6, border: '1px solid #2a2a3e',
  background: 'transparent', color: '#666', cursor: 'pointer', fontSize: '0.82rem', textTransform: 'capitalize',
}
const navBtnActiveStyle = { background: '#1e1e2e', color: '#fff', borderColor: '#5b6af0' }
const signOutStyle = {
  marginLeft: 'auto', padding: '0.25rem 0.75rem', borderRadius: 6,
  border: '1px solid #2a2a3e', background: 'transparent', color: '#555',
  cursor: 'pointer', fontSize: '0.78rem',
}
const loadingStyle = {
  height: '100vh', display: 'flex', alignItems: 'center',
  justifyContent: 'center', color: '#555', background: '#0f0f0f',
}
