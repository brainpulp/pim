import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

// Phone-facing remote control. Opened via `#/remote/<code>` — connects to the presenter's Supabase
// Realtime channel and broadcasts navigation commands. No sign-in needed (broadcast only). The presenter
// broadcasts its state back so the phone shows the live slide position and whether the show is running.
export default function RemoteControl({ code }) {
  const [status, setStatus] = useState('connecting')   // connecting | live | offline
  const [state, setState] = useState(null)             // { presenting, idx, total, stage, stages, title }
  const chanRef = useRef(null)
  const seenRef = useRef(false)

  useEffect(() => {
    if (!code) return
    const chan = supabase.channel(`pim-remote-${code}`, { config: { broadcast: { self: false } } })
    chanRef.current = chan
    chan.on('broadcast', { event: 'state' }, ({ payload }) => { seenRef.current = true; setStatus('live'); setState(payload) })
    chan.subscribe(s => {
      if (s === 'SUBSCRIBED') {
        chan.send({ type: 'broadcast', event: 'hello', payload: {} })   // ask the presenter for current state
        setStatus(prev => (seenRef.current ? 'live' : 'connecting'))
      }
    })
    // If the presenter never answers, show "waiting" but stay usable (commands still fire).
    const t = setTimeout(() => setStatus(prev => (seenRef.current ? 'live' : 'offline')), 3500)
    return () => { clearTimeout(t); supabase.removeChannel(chan); chanRef.current = null }
  }, [code])

  const send = (action) => {
    if (navigator.vibrate) { try { navigator.vibrate(12) } catch { /* ignore */ } }
    chanRef.current?.send({ type: 'broadcast', event: 'cmd', payload: { action } })
  }

  const presenting = !!state?.presenting
  const dot = status === 'live' ? '#22e06a' : status === 'offline' ? '#f87171' : '#f6ad55'
  const statusText = status === 'live' ? 'Connected' : status === 'offline' ? 'Presenter offline' : 'Connecting…'

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0a14', color: '#e6ebff', display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation', overflow: 'hidden' }}>
      {/* Status / position header */}
      <div style={{ flexShrink: 0, padding: '14px 18px', borderBottom: '1px solid #1e1e2e', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot, boxShadow: `0 0 8px ${dot}` }} />
        <span style={{ fontSize: '0.82rem', color: '#a9b6e8' }}>{statusText}</span>
        <div style={{ flex: 1 }} />
        {state && (
          <span style={{ fontSize: '0.82rem', color: '#c5d0ff', fontWeight: 600 }}>
            {presenting ? `Slide ${(state.idx ?? 0) + 1} / ${state.total ?? '?'}` : 'Not presenting'}
          </span>
        )}
      </div>

      {/* Current slide title + build indicator */}
      <div style={{ flexShrink: 0, padding: '10px 18px', minHeight: 44, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1, fontSize: '1.0rem', fontWeight: 600, color: '#e6ebff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {presenting ? (state?.title || 'Slide') : 'Ready'}
        </span>
        {presenting && (state?.stages ?? 0) > 1 && (
          <span style={{ fontSize: '0.72rem', color: '#7c8cff', background: '#171d38', borderRadius: 10, padding: '2px 9px' }}>
            build {(state.stage ?? 0) + 1} / {state.stages}
          </span>
        )}
      </div>

      {/* Big Prev / Next — the primary controls, split for thumb reach */}
      <div style={{ flex: 1, display: 'flex', gap: 12, padding: 12, minHeight: 0 }}>
        <button onPointerDown={() => send('prev')} aria-label="Previous"
          style={bigBtn('#161a34')}>
          <span style={{ fontSize: '3.2rem', lineHeight: 1 }}>‹</span>
          <span style={{ fontSize: '0.9rem', color: '#8fa0d8', marginTop: 6 }}>Back</span>
        </button>
        <button onPointerDown={() => send('next')} aria-label="Next"
          style={bigBtn('linear-gradient(180deg,#2f3a6e,#232a52)')}>
          <span style={{ fontSize: '3.6rem', lineHeight: 1 }}>›</span>
          <span style={{ fontSize: '0.9rem', color: '#c5d0ff', marginTop: 6 }}>Next</span>
        </button>
      </div>

      {/* Secondary row: slide jumps (skip whole slides) + black screen */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 10, padding: '0 12px 10px' }}>
        <button onPointerDown={() => send('prevSlide')} style={smallBtn}>⤒ Prev slide</button>
        <button onPointerDown={() => send('black')} style={smallBtn}>◼ Black</button>
        <button onPointerDown={() => send('nextSlide')} style={smallBtn}>Next slide ⤓</button>
      </div>

      {/* Present / End */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 10, padding: '0 12px 16px' }}>
        {presenting ? (
          <button onPointerDown={() => send('exit')} style={{ ...smallBtn, flex: 1, color: '#f9b4b4', borderColor: '#5a2a2a', background: '#241318' }}>■ End presentation</button>
        ) : (
          <button onPointerDown={() => send('present')} style={{ ...smallBtn, flex: 1, color: '#fff', border: 'none', background: 'linear-gradient(180deg,#5b6af0,#4652d6)', fontWeight: 700, fontSize: '1rem', padding: '14px' }}>▶ Start presentation</button>
        )}
      </div>
    </div>
  )
}

const bigBtn = (bg) => ({
  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  background: bg, border: '1px solid #2a3358', borderRadius: 18, color: '#e6ebff', cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation', fontWeight: 700,
})

const smallBtn = {
  flex: 1, background: '#12162c', border: '1px solid #2a3358', borderRadius: 12, color: '#c5d0ff',
  padding: '12px 8px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
}
