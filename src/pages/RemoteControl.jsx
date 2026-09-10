import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

// Phone-facing remote control. Opened via `#/remote/<code>` — connects to the presenter's Supabase
// Realtime channel and broadcasts navigation commands. No sign-in needed (broadcast only). The presenter
// broadcasts its state back so the phone shows the live slide position and whether the show is running.
export default function RemoteControl({ code }) {
  const [status, setStatus] = useState('connecting')   // connecting | live | offline
  const [state, setState] = useState(null)             // { presenting, idx, total, stage, stages, title }
  const [thumb, setThumb] = useState(null)             // { cur, next (SVG strings), curLabel, nextLabel, clip }
  const chanRef = useRef(null)
  const seenRef = useRef(false)
  const audioRef = useRef(null)
  const prevPosRef = useRef(null)
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('pim_remote_mute') === '1' } catch { return false } })
  const toggleMute = () => setMuted(m => { const nm = !m; try { localStorage.setItem('pim_remote_mute', nm ? '1' : '0') } catch { /* ignore */ } return nm })
  const mutedRef = useRef(muted); mutedRef.current = muted

  // Short confirmation beep so you can HEAR that a press registered and the deck actually advanced (a ghost
  // click that doesn't advance makes no sound). Web Audio needs a user gesture to start — unlocked on tap.
  const ensureAudio = () => { try { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; if (!audioRef.current) audioRef.current = new AC(); if (audioRef.current.state === 'suspended') audioRef.current.resume() } catch { /* ignore */ } }
  const beep = (freq = 880) => {
    const ac = audioRef.current; if (!ac) return
    try {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime
      o.type = 'sine'; o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.14)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!code) return
    let closed = false
    let retry = null
    const hello = () => { try { chanRef.current?.send({ type: 'broadcast', event: 'hello', payload: {} }) } catch { /* ignore */ } }
    const setup = () => {
      if (closed) return
      const chan = supabase.channel(`pim-remote-${code}`, { config: { broadcast: { self: false } } })
      chanRef.current = chan
      chan.on('broadcast', { event: 'state' }, ({ payload }) => { seenRef.current = true; setStatus('live'); setState(payload) })
      chan.on('broadcast', { event: 'thumb' }, ({ payload }) => setThumb(payload))
      chan.subscribe(s => {
        if (s === 'SUBSCRIBED') { hello(); setStatus(prev => (seenRef.current ? 'live' : 'connecting')) }
        else if ((s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') && !closed) {
          setStatus('offline')
          try { supabase.removeChannel(chan) } catch { /* ignore */ }
          if (chanRef.current === chan) chanRef.current = null
          clearTimeout(retry); retry = setTimeout(setup, 1500)   // rebuild the channel
        }
      })
    }
    setup()
    // Phone woke from lock / tab refocused → re-say hello (and rebuild if the channel is gone).
    const onVis = () => { if (document.visibilityState === 'visible') { if (!chanRef.current) setup(); else hello() } }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    // Keep-alive: periodically ping so a silently-dropped channel is noticed and state stays fresh.
    const ka = setInterval(hello, 8000)
    return () => { closed = true; clearTimeout(retry); clearInterval(ka); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); try { supabase.removeChannel(chanRef.current) } catch { /* ignore */ } chanRef.current = null }
  }, [code])

  const presenting = !!state?.presenting
  // Position signature: slide + sub-slide (slideshow clip) + build stage. Beep + pulse whenever it changes.
  const posSig = presenting ? `${state?.idx ?? 0}|${state?.step ?? 0}|${state?.stage ?? 0}` : null
  useEffect(() => {
    if (!presenting) { prevPosRef.current = null; return }
    if (prevPosRef.current == null) { prevPosRef.current = posSig; return }   // don't beep on the first state
    if (posSig !== prevPosRef.current) { prevPosRef.current = posSig; if (!mutedRef.current) beep() }
  }, [posSig, presenting]) // eslint-disable-line

  const send = (action) => {
    ensureAudio()   // first tap unlocks the phone's audio so the confirmation beep can play
    if (navigator.vibrate) { try { navigator.vibrate(12) } catch { /* ignore */ } }
    // Single send only — a command like Next must never fire twice (that would skip two). If the channel is
    // gone, rebuild it (the visibility/keep-alive paths also do this) and drop this press rather than double it.
    if (!chanRef.current) return
    try { chanRef.current.send({ type: 'broadcast', event: 'cmd', payload: { action } }) } catch { /* ignore */ }
  }

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
        <button onClick={toggleMute} title={muted ? 'Unmute beep' : 'Mute beep'}
          style={{ background: muted ? 'transparent' : '#12291d', border: `1px solid ${muted ? '#2a3358' : '#2f7a4a'}`, color: muted ? '#8090b8' : '#6ee7a8',
            borderRadius: 8, padding: '4px 10px', fontSize: '0.82rem', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>{muted ? '🔇' : '🔔'}</button>
        {state && (
          <span style={{ fontSize: '0.82rem', color: '#c5d0ff', fontWeight: 600 }}>
            {presenting ? `Slide ${(state.idx ?? 0) + 1} / ${state.total ?? '?'}` : 'Not presenting'}
          </span>
        )}
      </div>

      {/* Compact status line: slide / sub-slide / build (pulses on advance) + timers, all in one row. */}
      {presenting && (
        <div key={posSig} style={{ flexShrink: 0, margin: '8px 12px 0', padding: '7px 11px', borderRadius: 12, background: '#12162c', border: '1px solid #2a3358',
          display: 'flex', alignItems: 'baseline', gap: 8, animation: 'pim-posflash 0.35s ease' }}>
          <style>{`@keyframes pim-posflash{0%{background:#22345c}100%{background:#12162c}}`}</style>
          <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#e6ebff', fontVariantNumeric: 'tabular-nums' }}>
            {(state?.idx ?? 0) + 1}<span style={{ fontSize: '0.78rem', color: '#8090b8', fontWeight: 600 }}>/{state?.total ?? '?'}</span>
          </span>
          {(state?.steps ?? 0) > 1 && <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#6ee7a8' }}>· {(state.step ?? 0) + 1}/{state.steps} <span style={{ fontSize: '0.56rem', color: '#8090b8' }}>SUB</span></span>}
          {(state?.stages ?? 0) > 1 && <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#7c8cff' }}>· {(state.stage ?? 0) + 1}/{state.stages} <span style={{ fontSize: '0.56rem', color: '#8090b8' }}>BUILD</span></span>}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: '0.92rem', color: '#c5d0ff', fontVariantNumeric: 'tabular-nums' }}>⏱ {fmtClock(state?.slideMs)}</span>
          <span style={{ fontSize: '0.8rem', color: '#6ee7a8', fontVariantNumeric: 'tabular-nums' }}>{fmtClock(state?.totalMs)}</span>
        </div>
      )}

      {/* Speaker notes — the reading area. Fills the space above the buttons and scrolls. zIndex over the
          edge tap-zones so you can scroll/read the centre without triggering navigation. */}
      {presenting && (
        <div style={{ flex: 1, minHeight: 0, margin: '8px 12px 0', padding: '10px 13px', borderRadius: 12, background: '#0f1424', border: '1px solid #23283f',
          overflowY: 'auto', WebkitOverflowScrolling: 'touch', position: 'relative', zIndex: 6 }}>
          <div style={{ fontSize: '1.0rem', fontWeight: 700, color: '#c5d0ff', marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{state?.title || 'Slide'}</div>
          {state?.note
            ? (/[<][a-z/]/i.test(state.note)
                ? <div style={{ fontSize: '1.08rem', lineHeight: 1.5, color: '#dbe4ff', wordBreak: 'break-word' }} dangerouslySetInnerHTML={{ __html: state.note }} />
                : <div style={{ fontSize: '1.08rem', lineHeight: 1.5, color: '#dbe4ff', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{state.note}</div>)
            : <div style={{ fontSize: '0.92rem', color: '#6b7699', fontStyle: 'italic' }}>No notes for this slide.</div>}
        </div>
      )}

      {/* Coming up — ONE small thumbnail of what the next press brings (next slideshow clip, else next slide). */}
      {presenting && (() => {
        const nClips = thumb?.clipThumbs?.length || 0
        const nextClip = (state?.steps ?? 0) > 1 && nClips ? (state.step ?? 0) + 1 : -1
        const showClip = nextClip >= 0 && nextClip < nClips
        const clipSrc = showClip ? thumb.clipThumbs[nextClip] : null
        if (!showClip && !thumb?.next) return null
        return (
          <div style={{ flexShrink: 0, padding: '2px 14px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <style>{`.pim-rthumb svg{width:100%;height:auto;display:block}`}</style>
            <span style={{ fontSize: '0.6rem', color: '#8090b8', letterSpacing: 0.6, textTransform: 'uppercase', flexShrink: 0 }}>Coming</span>
            {showClip ? (
              <div style={{ width: 92, height: 56, flexShrink: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid #2a3358',
                background: clipSrc ? `#000 center/cover no-repeat url("${clipSrc}")` : '#12162c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {!clipSrc && <span style={{ color: '#6b7699', fontSize: 15 }}>▶</span>}
              </div>
            ) : (
              <div className="pim-rthumb" style={{ width: 92, flexShrink: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid #2a3358', background: '#0d0d1a' }}
                dangerouslySetInnerHTML={{ __html: thumb.next }} />
            )}
            <span style={{ fontSize: '0.8rem', color: '#8fa0d8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {showClip ? `clip ${nextClip + 1} / ${state.steps}` : (state?.nextTitle || thumb?.nextLabel || 'Next slide')}
            </span>
          </div>
        )
      })()}

      {/* Eyes-free EDGE tap-zones: slim strips down the far left/right advance the deck, so you can drive
          without looking — while the notes centre (higher zIndex) stays readable/scrollable. */}
      {presenting && (<>
        <div onPointerDown={() => send('prev')} aria-label="Previous"
          style={{ position: 'fixed', left: 0, top: 54, bottom: 190, width: 40, zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'rgba(143,160,216,0.3)', fontSize: '2rem', WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}>‹</div>
        <div onPointerDown={() => send('next')} aria-label="Next"
          style={{ position: 'fixed', right: 0, top: 54, bottom: 190, width: 40, zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'rgba(143,160,216,0.3)', fontSize: '2rem', WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}>›</div>
      </>)}

      {/* Big Prev / Next — the primary controls, split for thumb reach (fixed height so notes get the space) */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 12, padding: 12, height: 116 }}>
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

// mm:ss (or h:mm:ss past an hour) for the live presentation timers.
function fmtClock(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const pad = n => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
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
