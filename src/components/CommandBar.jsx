import { useEffect, useRef, useState } from 'react'
import { runAssistant } from '../lib/ai'

// The in-app AI assistant (Phase 1): a spotlight-style command bar. Cmd/Ctrl+J (or the ✦ button)
// opens it; type a request in plain language and it edits the graph by calling store actions.
export default function CommandBar({ getSelection = () => ({}) }) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState(null)   // null | 'running' | {error}
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault(); e.stopPropagation()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30) }, [open])

  const run = async () => {
    const q = prompt.trim()
    if (!q || busy) return
    setBusy(true); setResult(''); setStatus('running')
    try {
      const text = await runAssistant(q, getSelection(), ev => {
        if (ev.type === 'tool') setStatus(ev.name.replace(/_/g, ' ') + '…')
        else if (ev.type === 'thinking') setStatus('thinking…')
      })
      setResult(text); setStatus(null); setPrompt('')
    } catch (e) {
      setStatus(null); setResult('')
      setStatus({ error: e?.message || 'Something went wrong.' })
    } finally { setBusy(false) }
  }

  return (<>
    {/* Floating opener */}
    {!open && (
      <button onClick={() => setOpen(true)} title="Ask the assistant (Cmd/Ctrl+J)"
        style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 60, width: 46, height: 46, borderRadius: '50%',
          background: 'linear-gradient(135deg,#5b6af0,#8b5cf6)', color: '#fff', border: 'none', cursor: 'pointer',
          fontSize: 20, boxShadow: '0 6px 20px rgba(91,106,240,0.5)' }}>✦</button>
    )}
    {open && (
      <div onMouseDown={() => setOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 61, background: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '16vh' }}>
        <div onMouseDown={e => e.stopPropagation()}
          style={{ width: 'min(560px, 92vw)', background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 12, boxShadow: '0 16px 50px rgba(0,0,0,0.6)', overflow: 'hidden', fontFamily: '-apple-system, sans-serif' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #20233f' }}>
            <span style={{ fontSize: 16 }}>✦</span>
            <input ref={inputRef} value={prompt} disabled={busy}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); run() } if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } }}
              placeholder="Tell the assistant what to do…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e6ebff', fontSize: 15 }} />
            <button onClick={run} disabled={busy || !prompt.trim()}
              style={{ background: prompt.trim() && !busy ? '#5b6af0' : '#2a3358', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: prompt.trim() && !busy ? 'pointer' : 'default', fontSize: 13 }}>
              {busy ? '…' : 'Run'}
            </button>
          </div>
          <div style={{ padding: '10px 14px', minHeight: 22, fontSize: 13 }}>
            {status === 'running' && <span style={{ color: '#8fa0d8' }}>Working…</span>}
            {typeof status === 'string' && status !== 'running' && <span style={{ color: '#8fa0d8' }}>{status}</span>}
            {status && status.error && <span style={{ color: '#ff9a9a' }}>{status.error}</span>}
            {!status && result && <span style={{ color: '#c5d0ff' }}>{result}</span>}
            {!status && !result && (
              <span style={{ color: '#7080a0' }}>Try: “add 5 tasks under Launch and make it a kanban board”, “tag the selected node urgent”, “connect Idea to Prototype”.</span>
            )}
          </div>
        </div>
      </div>
    )}
  </>)
}
