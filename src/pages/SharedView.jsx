import { useEffect, useState } from 'react'
import { getSharedProject, redeemShareLink } from '../lib/db'
import Graph from './Graph'

// Public landing for a `#/share/<token>` link.
// - viewer link (or not signed in): render the Graph read-only with data from a public RPC.
// - editor link + signed in: redeem (become a member) and hand off to the normal editing flow.
export default function SharedView({ token, session, onOpenOwned }) {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    getSharedProject(token)
      .then(async data => {
        if (cancelled) return
        if (!data) { setState({ status: 'invalid' }); return }
        if (data.role === 'editor' && session) {
          try {
            const r = await redeemShareLink(token)
            if (!cancelled && r) { onOpenOwned(r.id, r.name); return }
          } catch (e) { console.warn('redeem failed', e) }
        }
        if (!cancelled) setState({ status: 'ok', data })
      })
      .catch(() => { if (!cancelled) setState({ status: 'invalid' }) })
    return () => { cancelled = true }
  }, [token, session]) // eslint-disable-line

  if (state.status === 'loading') return <div style={center}>Loading shared project…</div>
  if (state.status === 'invalid') return (
    <div style={center}>
      <div>
        <div style={{ marginBottom: 8 }}>This share link is invalid, expired, or was revoked.</div>
        <a href={import.meta.env.BASE_URL} style={openLink}>Go to PIM</a>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f0f' }}>
      <div style={banner}>
        <span style={{ color: '#c5d0ff', fontSize: '0.85rem', fontWeight: 600 }}>{state.data.name}</span>
        <span style={{ color: '#7080a0', fontSize: '0.72rem' }}>· shared, view only</span>
        <a href={import.meta.env.BASE_URL} style={{ marginLeft: 'auto', ...openLink }}>Open PIM</a>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Graph projectId={state.data.id} projectName={state.data.name} readOnly sharedData={state.data} />
      </div>
    </div>
  )
}

const center = { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9aa8d8', background: '#0c0c1a', fontSize: '0.9rem', textAlign: 'center', padding: 20 }
const banner = { display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem', height: 40, background: '#111118', borderBottom: '1px solid #1e1e2e', flexShrink: 0 }
const openLink = { padding: '0.25rem 0.7rem', borderRadius: 6, border: '1px solid #2a2a3e', background: 'transparent', color: '#5b6af0', textDecoration: 'none', fontSize: '0.78rem', fontWeight: 600 }
