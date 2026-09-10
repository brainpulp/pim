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

  const send = (action) => {
    if (navigator.vibrate) { try { navigator.vibrate(12) } catch { /* ignore */ } }
    // Single send only — a command like Next must never fire twice (that would skip two). If the channel is
    // gone, rebuild it (the visibility/keep-alive paths also do this) and drop this press rather than double it.
    if (!chanRef.current) return
    try { chanRef.current.send({ type: 'broadcast', event: 'cmd', payload: { action } }) } catch { /* ignore */ }
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

      {/* Live timers: time on current slide + total elapsed */}
      {presenting && (
        <div style={{ flexShrink: 0, padding: '8px 18px 0', display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'center' }}>
          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ fontSize: '1.35rem', fontWeight: 700, color: '#c5d0ff', fontVariantNumeric: 'tabular-nums' }}>{fmtClock(state?.slideMs)}</span>
            <span style={{ fontSize: '0.62rem', color: '#8090b8', letterSpacing: 0.5, textTransform: 'uppercase' }}>this slide</span>
          </span>
          <span style={{ width: 1, height: 30, background: '#232a4a' }} />
          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ fontSize: '1.35rem', fontWeight: 700, color: '#6ee7a8', fontVariantNumeric: 'tabular-nums' }}>{fmtClock(state?.totalMs)}</span>
            <span style={{ fontSize: '0.62rem', color: '#8090b8', letterSpacing: 0.5, textTransform: 'uppercase' }}>total</span>
          </span>
        </div>
      )}

      {/* Current slide title (+ next slide name) + build indicator */}
      <div style={{ flexShrink: 0, padding: '10px 18px', minHeight: 44, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '1.05rem', fontWeight: 700, color: '#e6ebff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {presenting ? (state?.title || 'Slide') : 'Ready'}
          </span>
          {presenting && state?.nextTitle && (
            <span style={{ fontSize: '0.72rem', color: '#8fa0d8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Next: {state.nextTitle}
            </span>
          )}
        </span>
        {presenting && (state?.steps ?? 0) > 1 && (
          <span style={{ fontSize: '0.72rem', color: '#6ee7a8', background: '#12291d', borderRadius: 10, padding: '2px 9px' }}>
            step {(state.step ?? 0) + 1} / {state.steps}
          </span>
        )}
        {presenting && (state?.stages ?? 0) > 1 && (
          <span style={{ fontSize: '0.72rem', color: '#7c8cff', background: '#171d38', borderRadius: 10, padding: '2px 9px' }}>
            build {(state.stage ?? 0) + 1} / {state.stages}
          </span>
        )}
      </div>

      {/* Canvas preview — current + next slide thumbnails, for pacing while you practice. */}
      {presenting && thumb && (thumb.cur || thumb.next) && (
        <div style={{ flexShrink: 0, padding: '0 12px 6px', display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <style>{`.pim-rthumb svg{width:100%;height:auto;display:block;border-radius:8px}`}</style>
          <div style={{ flex: 2, minWidth: 0 }}>
            <div style={{ fontSize: '0.58rem', color: '#8090b8', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 3 }}>On screen</div>
            <div className="pim-rthumb" style={{ position: 'relative', border: '1px solid #2a3358', borderRadius: 9, overflow: 'hidden', background: '#0d0d1a' }}>
              {thumb.cur ? <div dangerouslySetInnerHTML={{ __html: thumb.cur }} /> : <div style={{ padding: 18, textAlign: 'center', color: '#6b7699' }}>—</div>}
              {thumb.clip && (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'linear-gradient(transparent,rgba(6,6,16,0.9))', color: '#e6ebff', fontSize: '0.66rem', padding: '10px 7px 4px', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  <span style={{ color: '#6ee7a8' }}>▶</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{thumb.clip.label}</span>
                  {thumb.clip.of > 1 && <span style={{ color: '#8090b8', flexShrink: 0 }}>{thumb.clip.n}/{thumb.clip.of}</span>}
                </div>
              )}
            </div>
          </div>
          {thumb.next && (
            <div style={{ flex: 1, minWidth: 0, opacity: 0.72 }}>
              <div style={{ fontSize: '0.58rem', color: '#8090b8', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 3 }}>Next</div>
              <div className="pim-rthumb" style={{ border: '1px solid #23283f', borderRadius: 9, overflow: 'hidden', background: '#0d0d1a' }}
                dangerouslySetInnerHTML={{ __html: thumb.next }} />
              {thumb.nextLabel && <div style={{ fontSize: '0.62rem', color: '#8fa0d8', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{thumb.nextLabel}</div>}
            </div>
          )}
        </div>
      )}

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
