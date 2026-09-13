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

  async function handleGoogle() {
    setError(null)
    // Return to the app after Google's consent screen. supabase-js picks up the session from the URL.
    const redirectTo = window.location.origin + import.meta.env.BASE_URL
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
    if (error) setError(error.message)
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
        <div style={styles.divider}><span style={styles.dline} /><span style={styles.dividerText}>or</span><span style={styles.dline} /></div>
        <button type="button" style={styles.googleBtn} onClick={handleGoogle}>
          <svg width="17" height="17" viewBox="0 0 48 48" style={{ flexShrink: 0 }}><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5c-2 1.5-4.7 2.5-7.6 2.5-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.5l6.5 5.5C41 38 44 31.7 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg>
          Continue with Google
        </button>
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
  divider: { display: 'flex', alignItems: 'center', margin: '1rem 0 0.85rem', color: '#555', fontSize: '0.75rem', gap: 10 },
  dividerText: { flexShrink: 0 },
  dline: { flex: 1, height: 1, background: '#2a2a2a' },
  googleBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, width: '100%', padding: '0.7rem', borderRadius: 8, border: '1px solid #333', background: '#fff', color: '#1f1f1f', fontSize: '0.92rem', fontWeight: 600, cursor: 'pointer' },
  error: { color: '#f87171', marginTop: '0.75rem', fontSize: '0.85rem' },
  toggle: { marginTop: '1rem', color: '#666', fontSize: '0.85rem' },
  link: { color: '#5b6af0', cursor: 'pointer' },
}
