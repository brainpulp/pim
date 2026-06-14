import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = mode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h2 style={styles.title}>PIM</h2>
        <p style={styles.sub}>Personal Information Manager</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input style={styles.input} type="email" placeholder="email" value={email}
            onChange={e => setEmail(e.target.value)} required autoFocus />
          <input style={styles.input} type="password" placeholder="password" value={password}
            onChange={e => setPassword(e.target.value)} required />
          <button style={styles.btn} disabled={loading}>
            {loading ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        {error && <p style={styles.error}>{error}</p>}
        <p style={styles.toggle}>
          {mode === 'signin' ? "No account? " : "Already have one? "}
          <span style={styles.link} onClick={() => { setMode(m => m === 'signin' ? 'signup' : 'signin'); setError(null) }}>
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </span>
        </p>
      </div>
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#0f0f0f' },
  card: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 12, padding: '2.5rem', width: 360, textAlign: 'center' },
  title: { margin: '0 0 0.25rem', fontSize: '1.8rem', color: '#fff', fontWeight: 700 },
  sub: { margin: '0 0 1.5rem', color: '#888', fontSize: '0.9rem' },
  form: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  input: { padding: '0.75rem 1rem', borderRadius: 8, border: '1px solid #333', background: '#111', color: '#fff', fontSize: '1rem', outline: 'none' },
  btn: { padding: '0.75rem', borderRadius: 8, border: 'none', background: '#5b6af0', color: '#fff', fontSize: '1rem', cursor: 'pointer', fontWeight: 600 },
  error: { color: '#f87171', marginTop: '0.75rem', fontSize: '0.85rem' },
  toggle: { marginTop: '1rem', color: '#666', fontSize: '0.85rem' },
  link: { color: '#5b6af0', cursor: 'pointer' },
}
