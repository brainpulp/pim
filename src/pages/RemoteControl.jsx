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
  const setupRef = useRef(null)   // lets send() rebuild the channel if it silently dropped
  const seenRef = useRef(false)
  const audioRef = useRef(null)
  const prevPosRef = useRef(null)
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('pim_remote_mute') === '1' } catch { return false } })
  const toggleMute = () => setMuted(m => { const nm = !m; try { localStorage.setItem('pim_remote_mute', nm ? '1' : '0') } catch { /* ignore */ } return nm })
  const mutedRef = useRef(muted); mutedRef.current = muted

  // Notes display mode: 'full' (whole text — for practice) or 'highlights' (only bolded words — for the
  // day-of). Persisted so it survives reloads. Toggled from the phone; never touches the deck.
  const [notesMode, setNotesMode] = useState(() => { try { return localStorage.getItem('pim_remote_notes_mode') === 'highlights' ? 'highlights' : 'full' } catch { return 'full' } })
  const toggleNotesMode = () => setNotesMode(m => { const nm = m === 'full' ? 'highlights' : 'full'; try { localStorage.setItem('pim_remote_notes_mode', nm) } catch { /* ignore */ } return nm })

  // Editing speaker notes from the phone (for practice — never navigates or interrupts the show).
  const [editNotes, setEditNotes] = useState(false)
  const noteRef = useRef(null)          // the contentEditable div
  const noteFocusRef = useRef(false)    // don't re-seed while typing (would jump the caret)
  const noteDebRef = useRef(null)       // debounce timer for outgoing edits
  const stateRef = useRef(state); stateRef.current = state
  const noteIsHtml = s => /<[a-z/][^>]*>/i.test(s || '')
  const seedNote = () => {
    const el = noteRef.current; if (!el) return
    const v = stateRef.current?.note || ''
    el.innerHTML = noteIsHtml(v) ? v : v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
  const sendNote = () => {
    const el = noteRef.current, id = stateRef.current?.noteId
    if (!el || !id || !chanRef.current) return
    const html = el.innerHTML
    clearTimeout(noteDebRef.current)
    noteDebRef.current = setTimeout(() => {
      try { chanRef.current?.send({ type: 'broadcast', event: 'note', payload: { id, html } }) } catch { /* ignore */ }
    }, 350)
  }
  const fmtNote = cmd => { document.execCommand(cmd, false, null); noteRef.current?.focus(); sendNote() }
  // Seed the editor when entering edit mode or when the target slide changes while not actively typing.
  // Also focus it and drop the caret at the end so the cursor is visible immediately (iOS won't show a
  // caret on a contentEditable inside a user-select:none tree unless it's actually focused).
  const focusNoteEnd = () => {
    const el = noteRef.current; if (!el) return
    try {
      el.focus()
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r)
    } catch { /* ignore */ }
  }
  useEffect(() => {
    if (editNotes && !noteFocusRef.current) { seedNote(); requestAnimationFrame(focusNoteEnd) }
  }, [editNotes, state?.noteId, state?.note]) // eslint-disable-line

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
    setupRef.current = setup
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

  const sendNow = (action) => {
    const ch = chanRef.current; if (!ch) return false
    try { ch.send({ type: 'broadcast', event: 'cmd', payload: { action } }); return true } catch { return false }
  }
  const send = (action) => {
    ensureAudio()   // first tap unlocks the phone's audio so the confirmation beep can play
    if (navigator.vibrate) { try { navigator.vibrate(12) } catch { /* ignore */ } }
    // SELF-HEALING: if the channel silently dropped (send fails / no channel), rebuild it and retry once.
    // The retry ONLY fires when the first send definitely failed, so a command can never double-fire.
    if (sendNow(action)) return
    try { if (chanRef.current) supabase.removeChannel(chanRef.current) } catch { /* ignore */ }
    chanRef.current = null
    setupRef.current?.()                       // rebuild immediately
    setTimeout(() => { if (!sendNow(action)) setTimeout(() => sendNow(action), 500) }, 350)   // retry after it subscribes
  }

  const dot = status === 'live' ? '#22e06a' : status === 'offline' ? '#f87171' : '#f6ad55'
  const statusText = status === 'live' ? 'Connected' : status === 'offline' ? 'Presenter offline' : 'Connecting…'

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0a14', color: '#e6ebff', display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation', overflow: 'hidden' }}>

      {/* ── ONE compact status line (≈part of the top 20%): dot · slide N/total · SUB · BUILD · timers · mute.
             Slide number lives here and NOWHERE else. Pulses on advance. */}
      <div key={posSig} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        borderBottom: '1px solid #1e1e2e', animation: presenting ? 'pim-posflash 0.35s ease' : 'none' }}>
        <style>{`@keyframes pim-posflash{0%{background:#22345c}100%{background:transparent}}`}</style>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot, boxShadow: `0 0 8px ${dot}`, flexShrink: 0 }} />
        {presenting ? (
          <>
            <span style={{ fontSize: '1.15rem', fontWeight: 800, color: '#e6ebff', fontVariantNumeric: 'tabular-nums' }}>
              {(state?.idx ?? 0) + 1}<span style={{ fontSize: '0.72rem', color: '#8090b8', fontWeight: 600 }}>/{state?.total ?? '?'}</span>
            </span>
            {(state?.steps ?? 0) > 1 && <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#6ee7a8' }}>·{(state.step ?? 0) + 1}/{state.steps}<span style={{ fontSize: '0.52rem', color: '#8090b8' }}> SUB</span></span>}
            {(state?.stages ?? 0) > 1 && <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#7c8cff' }}>·{(state.stage ?? 0) + 1}/{state.stages}<span style={{ fontSize: '0.52rem', color: '#8090b8' }}> BUILD</span></span>}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: '0.9rem', color: '#c5d0ff', fontVariantNumeric: 'tabular-nums' }}>⏱ {fmtClock(state?.slideMs)}</span>
            <span style={{ fontSize: '0.78rem', color: '#6ee7a8', fontVariantNumeric: 'tabular-nums' }}>{fmtClock(state?.totalMs)}</span>
          </>
        ) : (
          <>
            <span style={{ fontSize: '0.85rem', color: '#a9b6e8' }}>{statusText}{status === 'live' ? ' · not presenting' : ''}</span>
            <div style={{ flex: 1 }} />
          </>
        )}
        <button onClick={toggleMute} title={muted ? 'Unmute beep' : 'Mute beep'}
          style={{ background: muted ? 'transparent' : '#12291d', border: `1px solid ${muted ? '#2a3358' : '#2f7a4a'}`, color: muted ? '#8090b8' : '#6ee7a8',
            borderRadius: 8, padding: '4px 9px', fontSize: '0.82rem', cursor: 'pointer', WebkitTapHighlightColor: 'transparent', flexShrink: 0 }}>{muted ? '🔇' : '🔔'}</button>
      </div>

      {/* ── NOTES (≈40%). The star of the screen. Header (title + edit) is fixed; the body scrolls; slim
             edge strips over the body's far left/right advance the deck eyes-free (hidden while editing). */}
      {presenting && (
        <div style={{ flex: 2, minHeight: 0, margin: '8px 10px 0', borderRadius: 12, background: '#0f1424', border: '1px solid #23283f',
          display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px 5px' }}>
            <span style={{ flex: 1, fontSize: '0.98rem', fontWeight: 700, color: '#c5d0ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{state?.title || 'Slide'}</span>
            {editNotes && [['bold', <b key="b">B</b>], ['italic', <i key="i">I</i>], ['underline', <u key="u">U</u>]].map(([cmd, gl]) => (
              <button key={cmd} onMouseDown={e => { e.preventDefault(); fmtNote(cmd) }} onTouchStart={e => { e.preventDefault(); fmtNote(cmd) }}
                style={{ minWidth: 30, height: 30, borderRadius: 8, border: '1px solid #2a3358', background: '#171d38', color: '#c5d0ff', fontSize: '0.95rem', lineHeight: 1 }}>{gl}</button>
            ))}
            {/* Full ⇄ Highlights toggle. Highlights = only the bolded words (day-of); Full = everything (practice). */}
            {!editNotes && (
              <button onClick={() => { setEditNotes(false); toggleNotesMode() }}
                style={{ height: 30, borderRadius: 8, padding: '0 10px', border: `1px solid ${notesMode === 'highlights' ? '#8a6d2f' : '#2a3358'}`, background: notesMode === 'highlights' ? '#2a220e' : '#171d38', color: notesMode === 'highlights' ? '#f6c453' : '#9aa8d8', fontSize: '0.82rem', fontWeight: 700, lineHeight: 1 }}
                title={notesMode === 'highlights' ? 'Showing highlights (bold only) — tap for full notes' : 'Showing full notes — tap for highlights only'}>
                {notesMode === 'highlights' ? '★ Marks' : '≡ Full'}
              </button>
            )}
            {notesMode === 'full' && (
              <button onClick={() => { const n = !editNotes; setEditNotes(n); if (!n) sendNote() }}
                style={{ minWidth: 34, height: 30, borderRadius: 8, border: `1px solid ${editNotes ? '#3a7d5a' : '#2a3358'}`, background: editNotes ? '#123524' : '#171d38', color: editNotes ? '#6ee7a8' : '#9aa8d8', fontSize: '0.9rem', lineHeight: 1 }}
                title={editNotes ? 'Done editing' : 'Edit notes'}>{editNotes ? '✓' : '✎'}</button>
            )}
          </div>
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 13px 12px' }}>
              {notesMode === 'highlights'
                ? (() => {
                    const hi = rcHighlights(state?.note)
                    return hi
                      ? <div style={{ fontSize: '1.5rem', fontWeight: 800, lineHeight: 1.55, color: '#f6e6b8', wordBreak: 'break-word' }} dangerouslySetInnerHTML={{ __html: hi }} />
                      : <div style={{ fontSize: '0.92rem', color: '#6b7699', fontStyle: 'italic' }}>No highlights — bold words in your notes to see them here.</div>
                  })()
                : editNotes
                ? <div ref={noteRef} contentEditable suppressContentEditableWarning data-richtext="1"
                    inputMode="text" autoCorrect="on" autoCapitalize="sentences"
                    onPaste={e => { e.preventDefault(); const cd = e.clipboardData; const h = cd?.getData?.('text/html'); document.execCommand('insertHTML', false, h ? rcSanitizeHtml(h) : rcSanitizePlain(cd?.getData?.('text/plain') || '')); sendNote() }}
                    onInput={sendNote} onFocus={() => { noteFocusRef.current = true }} onBlur={() => { noteFocusRef.current = false; sendNote() }}
                    style={{ minHeight: '100%', fontSize: '1.12rem', lineHeight: 1.5, color: '#eaf0ff', wordBreak: 'break-word',
                      outline: 'none', border: '1px solid #3a7d5a', borderRadius: 8, padding: '8px 10px', background: '#0b0f1e',
                      userSelect: 'text', WebkitUserSelect: 'text', WebkitUserModify: 'read-write', caretColor: '#6ee7a8', cursor: 'text' }} />
                : (state?.note
                    ? (/[<][a-z/]/i.test(state.note)
                        ? <div data-richtext="1" style={{ fontSize: '1.12rem', lineHeight: 1.5, color: '#dbe4ff', wordBreak: 'break-word' }} dangerouslySetInnerHTML={{ __html: state.note }} />
                        : <div style={{ fontSize: '1.12rem', lineHeight: 1.5, color: '#dbe4ff', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{state.note}</div>)
                    : <div style={{ fontSize: '0.92rem', color: '#6b7699', fontStyle: 'italic' }}>No notes for this slide.</div>)}
            </div>
            {/* eyes-free edge strips — bounded to the notes body, so they never fight the buttons below */}
            {!editNotes && (<>
              <div onPointerDown={() => send('prev')} aria-label="Previous"
                style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'rgba(143,160,216,0.28)', fontSize: '1.7rem', WebkitTapHighlightColor: 'transparent' }}>‹</div>
              <div onPointerDown={() => send('next')} aria-label="Next"
                style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'rgba(143,160,216,0.28)', fontSize: '1.7rem', WebkitTapHighlightColor: 'transparent' }}>›</div>
            </>)}
          </div>
        </div>
      )}

      {/* ── COMING (≈part of the top/bottom 20%): one small thumbnail of what the next press brings. */}
      {presenting && (() => {
        const nClips = thumb?.clipThumbs?.length || 0
        const nextClip = (state?.steps ?? 0) > 1 && nClips ? (state.step ?? 0) + 1 : -1
        const showClip = nextClip >= 0 && nextClip < nClips
        const clipSrc = showClip ? thumb.clipThumbs[nextClip] : null
        if (!showClip && !thumb?.next) return null
        return (
          <div style={{ flexShrink: 0, padding: '6px 14px 2px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <style>{`.pim-rthumb svg{width:100%;height:auto;display:block}`}</style>
            <span style={{ fontSize: '0.58rem', color: '#8090b8', letterSpacing: 0.6, textTransform: 'uppercase', flexShrink: 0 }}>Next</span>
            {showClip ? (
              <div style={{ width: 78, height: 46, flexShrink: 0, borderRadius: 7, overflow: 'hidden', border: '1px solid #2a3358',
                background: clipSrc ? `#000 center/cover no-repeat url("${clipSrc}")` : '#12162c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {!clipSrc && <span style={{ color: '#6b7699', fontSize: 14 }}>▶</span>}
              </div>
            ) : (
              <div className="pim-rthumb" style={{ width: 78, flexShrink: 0, borderRadius: 7, overflow: 'hidden', border: '1px solid #2a3358', background: '#0d0d1a' }}
                dangerouslySetInnerHTML={{ __html: thumb.next }} />
            )}
            <span style={{ fontSize: '0.82rem', color: '#8fa0d8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {showClip ? `clip ${nextClip + 1} / ${state.steps}` : (state?.nextTitle || thumb?.nextLabel || 'Next slide')}
            </span>
          </div>
        )
      })()}

      {/* ── BUTTONS (≈40%). Big Back/Next fill the block; a slim secondary row + End sit beneath. */}
      {presenting ? (
        <div style={{ flex: 2, minHeight: 150, maxHeight: '42vh', display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 12px 14px' }}>
          <div style={{ flex: 1, minHeight: 92, display: 'flex', gap: 12 }}>
            <button onPointerDown={() => send('prev')} aria-label="Previous" style={bigBtn('#161a34')}>
              <span style={{ fontSize: '3.2rem', lineHeight: 1 }}>‹</span>
              <span style={{ fontSize: '0.9rem', color: '#8fa0d8', marginTop: 4 }}>Back</span>
            </button>
            <button onPointerDown={() => send('next')} aria-label="Next" style={bigBtn('linear-gradient(180deg,#2f3a6e,#232a52)')}>
              <span style={{ fontSize: '3.6rem', lineHeight: 1 }}>›</span>
              <span style={{ fontSize: '0.9rem', color: '#c5d0ff', marginTop: 4 }}>Next</span>
            </button>
          </div>
          <div style={{ flexShrink: 0, display: 'flex', gap: 10 }}>
            <button onPointerDown={() => send('prevSlide')} style={smallBtn}>⤒ Prev slide</button>
            <button onPointerDown={() => send('black')} style={smallBtn}>◼ Black</button>
            <button onPointerDown={() => send('nextSlide')} style={smallBtn}>Next slide ⤓</button>
          </div>
          <button onPointerDown={() => send('exit')} style={{ ...smallBtn, flex: '0 0 auto', color: '#f9b4b4', borderColor: '#5a2a2a', background: '#241318', padding: '9px 8px' }}>■ End presentation</button>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 12px 16px' }}>
          <button onPointerDown={() => send('present')} style={{ ...smallBtn, color: '#fff', border: 'none', background: 'linear-gradient(180deg,#5b6af0,#4652d6)', fontWeight: 700, fontSize: '1rem', padding: '16px 22px' }}>▶ Start presentation</button>
        </div>
      )}
    </div>
  )
}

// Clean pasted notes to a tiny allowed set (line breaks, bold, italic, bullet/numbered lists); strip
// tabs, margins/indent styles, fonts and everything else — so pasted text stays clean on the phone too.
function rcBold(el) { const fw = el.style && el.style.fontWeight; if (fw) { if (fw === 'bold' || fw === 'bolder') return true; if (fw === 'normal' || fw === 'lighter') return false; const n = parseInt(fw, 10); if (!isNaN(n)) return n >= 600 } return null }
function rcItalic(el) { const fs = el.style && el.style.fontStyle; if (fs) return fs === 'italic' || fs === 'oblique'; return null }
function rcSanitizeHtml(html) {
  const root = document.createElement('div'); root.innerHTML = html || ''
  const walk = node => {
    let out = ''
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { out += (ch.nodeValue || '').replace(/[\t ]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); return }
      if (ch.nodeType !== 1) return
      const tag = ch.tagName
      if (tag === 'BR') { out += '<br>'; return }
      if (tag === 'UL' || tag === 'OL') { const t = tag.toLowerCase(); out += `<${t}>${walk(ch)}</${t}>`; return }
      if (tag === 'LI') { out += `<li>${walk(ch)}</li>`; return }
      let inner = walk(ch)
      if (inner) {
        let bold = rcBold(ch); if (bold === null) bold = (tag === 'B' || tag === 'STRONG')
        let ital = rcItalic(ch); if (ital === null) ital = (tag === 'I' || tag === 'EM')
        if (bold) inner = `<b>${inner}</b>`
        if (ital) inner = `<i>${inner}</i>`
      }
      if (tag === 'P' || tag === 'DIV' || tag === 'TR' || tag === 'H1' || tag === 'H2' || tag === 'H3') out += inner + '<br>'
      else out += inner
    })
    return out
  }
  return walk(root).replace(/(?:<br>\s*){3,}/g, '<br><br>').replace(/(?:<br>\s*)+$/, '')
}
function rcSanitizePlain(text) {
  return (text || '').replace(/[\t ]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')
}
const rcEsc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Highlights = only the bolded words, one run per line. Drops all non-bold text; keeps line breaks so
// distinct bold phrases stay on separate lines. Returns escaped HTML (<br>-joined) or '' if nothing bold.
function rcHighlights(html) {
  if (!html || !/[<][a-z/]/i.test(html)) return ''   // plain-text legacy notes carry no bold info
  const root = document.createElement('div'); root.innerHTML = html
  const lines = []; let cur = ''
  const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) lines.push(t); cur = '' }
  const walk = (node, bold) => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { if (bold) cur += ch.nodeValue || ''; else if ((ch.nodeValue || '').trim()) flush(); return }
      if (ch.nodeType !== 1) return
      const tag = ch.tagName
      if (tag === 'BR') { flush(); return }
      let b = bold; const sb = rcBold(ch)
      if (sb === true) b = true; else if (sb === false) b = false; else if (tag === 'B' || tag === 'STRONG') b = true
      walk(ch, b)
      if (tag === 'P' || tag === 'DIV' || tag === 'LI' || /^H[1-6]$/.test(tag)) flush()
    })
  }
  walk(root, false); flush()
  return lines.map(rcEsc).join('<br>')
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
