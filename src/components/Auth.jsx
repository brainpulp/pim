import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Auth() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    })
    if (error) setError(error.message)
    else setSent(true)
    setLoading(false)
  }

  if (sent) return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h2 style={styles.title}>Check your email</h2>
        <p style={styles.sub}>We sent a magic link to <strong>{email}</strong></p>
      </div>
    </div>
  )

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h2 style={styles.title}>PIM</h2>
        <p style={styles.sub}>Personal Information Manager</p>
        <form onSubmit={handleLogin} style={styles.form}>
          <input
            style={styles.input}
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <button style={styles.btn} disabled={loading}>
            {loading ? 'Sending…' : 'Send magic link'}
          </button>
        </form>
        {error && <p style={styles.error}>{error}</p>}
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
  error: { color: '#f87171', marginTop: '0.75rem', fontSize: '0.85rem' }
}
