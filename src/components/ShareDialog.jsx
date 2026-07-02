import { useEffect, useState } from 'react'
import { createShareLink, listShareLinks, revokeShareLink } from '../lib/db'

// Owner-facing dialog: generate / copy / revoke share links for a project.
export default function ShareDialog({ projectId, projectName, onClose }) {
  const [links, setLinks] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(null)

  const refresh = () => listShareLinks(projectId).then(setLinks).catch(() => setLinks([]))
  useEffect(() => { refresh() }, [projectId]) // eslint-disable-line

  const urlFor = t => `${window.location.origin}${import.meta.env.BASE_URL}#/share/${t}`
  const active = (links || []).filter(l => !l.revoked && (!l.expires_at || new Date(l.expires_at) > new Date()))

  const make = async role => {
    setBusy(true)
    try { await createShareLink(projectId, role); await refresh() }
    catch (e) { console.error('create share link', e) }
    finally { setBusy(false) }
  }
  const copy = async t => {
    try { await navigator.clipboard.writeText(urlFor(t)); setCopied(t); setTimeout(() => setCopied(c => c === t ? null : c), 1500) }
    catch { /* clipboard blocked — user can still select the text */ }
  }
  const revoke = async t => { await revokeShareLink(t); refresh() }

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={box} onMouseDown={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color: '#c5d0ff', fontSize: '0.95rem', fontWeight: 600 }}>Share “{projectName}”</span>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>
        <p style={{ color: '#8090b8', fontSize: '0.76rem', margin: '0 0 12px', lineHeight: 1.5 }}>
          Anyone with a link can open this project until you revoke it. <b style={{ color: '#a0b4f0' }}>View</b> links
          are public (no sign-in). <b style={{ color: '#a0b4f0' }}>Edit</b> links require the recipient to sign in.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button style={makeBtn} disabled={busy} onClick={() => make('viewer')}>+ View link</button>
          <button style={makeBtn} disabled={busy} onClick={() => make('editor')}>+ Edit link</button>
        </div>

        {links === null && <div style={{ color: '#7080a0', fontSize: '0.78rem' }}>Loading…</div>}
        {links !== null && active.length === 0 && (
          <div style={{ color: '#7080a0', fontSize: '0.78rem' }}>No active links yet.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto' }}>
          {active.map(l => (
            <div key={l.token} style={row}>
              <span style={{ ...pill, color: l.role === 'editor' ? '#f6ad55' : '#7bd88f',
                borderColor: l.role === 'editor' ? '#5a4520' : '#244a32' }}>
                {l.role === 'editor' ? 'Edit' : 'View'}
              </span>
              <input readOnly value={urlFor(l.token)} onFocus={e => e.target.select()} style={urlInput} />
              <button style={smallBtn} onClick={() => copy(l.token)}>{copied === l.token ? 'Copied' : 'Copy'}</button>
              <button style={{ ...smallBtn, color: '#f87171', borderColor: '#5a2630' }} onClick={() => revoke(l.token)}>Revoke</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500 }
const box = { background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 12, padding: '1.1rem 1.25rem', width: 480, maxWidth: '92vw', boxShadow: '0 12px 48px rgba(0,0,0,0.7)' }
const xBtn = { marginLeft: 'auto', background: 'transparent', border: 'none', color: '#7080a0', cursor: 'pointer', fontSize: '0.9rem' }
const makeBtn = { flex: 1, padding: '0.5rem', borderRadius: 7, border: '1px solid #3a4a8a', background: '#1a1f4a', color: '#c5d0ff', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 }
const row = { display: 'flex', alignItems: 'center', gap: 6 }
const pill = { fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 5, border: '1px solid', flexShrink: 0 }
const urlInput = { flex: 1, minWidth: 0, background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#9aa8d8', borderRadius: 5, padding: '4px 7px', fontSize: '0.72rem', outline: 'none' }
const smallBtn = { padding: '4px 9px', borderRadius: 5, border: '1px solid #2d3a6a', background: 'transparent', color: '#a0b4f0', cursor: 'pointer', fontSize: '0.74rem', flexShrink: 0 }
