import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import Auth from './components/Auth'
import Canvas from './pages/Canvas'
import Table from './pages/Table'

const VIEWS = ['canvas', 'table']

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [view, setView] = useState('canvas')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return <div style={loadingStyle}>Loading…</div>
  if (!session) return <Auth />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f0f' }}>
      <nav style={navStyle}>
        <span style={logoStyle}>PIM</span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {VIEWS.map(v => (
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
        {view === 'canvas' && <Canvas />}
        {view === 'table' && <Table />}
      </div>
    </div>
  )
}

const navStyle = {
  display: 'flex', alignItems: 'center', gap: '1rem',
  padding: '0 1.25rem', height: 48, background: '#141414',
  borderBottom: '1px solid #222', flexShrink: 0, zIndex: 100,
}
const logoStyle = { fontWeight: 700, fontSize: '1rem', color: '#5b6af0', marginRight: '0.5rem' }
const navBtnStyle = {
  padding: '0.3rem 0.85rem', borderRadius: 6, border: '1px solid #2a2a2a',
  background: 'transparent', color: '#888', cursor: 'pointer', fontSize: '0.85rem', textTransform: 'capitalize',
}
const navBtnActiveStyle = { background: '#1e1e2e', color: '#fff', borderColor: '#5b6af0' }
const signOutStyle = {
  marginLeft: 'auto', padding: '0.3rem 0.85rem', borderRadius: 6,
  border: '1px solid #2a2a2a', background: 'transparent', color: '#666',
  cursor: 'pointer', fontSize: '0.8rem',
}
const loadingStyle = {
  height: '100vh', display: 'flex', alignItems: 'center',
  justifyContent: 'center', color: '#555', background: '#0f0f0f',
}
