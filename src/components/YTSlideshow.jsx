// YouTube slideshow — a node carrying an ordered list of YouTube clips (node.ytss.clips), each with a
// trim (start/end) and a trigger (auto / after a delay / on click-or-key). Rendered as a CLEAN player
// (no YouTube chrome before/after a clip plays — a poster covers it). The inspector edits clips and
// PREVIEWS on the node itself (no separate mini-screen); trimming scrubs the node live.
//
// Built on the YouTube IFrame Player API so play/pause/seek/duration/ended are all first-class — the
// graph's arrow-key control just calls the same player handle exposed here via `onReady`.
import { useEffect, useRef, useState } from 'react'

// ── helpers ──────────────────────────────────────────────────────────────────
export const parseYoutubeId = (str) => {
  const s = String(str || '').trim()
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/)
  if (m) return m[1]
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  return null
}
export const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
export const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec || 0))
  const m = Math.floor(s / 60), r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}
export const parseTime = (str) => {
  const t = String(str || '').trim()
  if (/^\d+$/.test(t)) return +t
  const m = t.match(/^(\d+):(\d{1,2})$/)
  if (m) return (+m[1]) * 60 + (+m[2])
  return null
}

// ── Crisp inline-SVG icons (centered reliably inside a flex button, unlike emoji glyphs) ──────
function Icon({ name, size = 15 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block' } }
  switch (name) {
    case 'play':   return <svg {...p} fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z" /></svg>
    case 'pause':  return <svg {...p} fill="currentColor" stroke="none"><rect x="6.5" y="5.5" width="3.5" height="13" rx="1" /><rect x="14" y="5.5" width="3.5" height="13" rx="1" /></svg>
    case 'prev':   return <svg {...p}><path d="M14.5 6l-6 6 6 6" /></svg>
    case 'next':   return <svg {...p}><path d="M9.5 6l6 6-6 6" /></svg>
    case 'edit':   return <svg {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></svg>
    case 'full':   return <svg {...p}><path d="M4 9V5a1 1 0 0 1 1-1h4" /><path d="M20 9V5a1 1 0 0 0-1-1h-4" /><path d="M4 15v4a1 1 0 0 0 1 1h4" /><path d="M20 15v4a1 1 0 0 1-1 1h-4" /></svg>
    case 'replay': return <svg {...p}><path d="M4 12a8 8 0 1 0 3-6.2" /><path d="M4 4v4h4" /></svg>
    case 'close':  return <svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
    case 'add':    return <svg {...p}><path d="M12 5v14M5 12h14" /></svg>
    case 'trash':  return <svg {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
    case 'extract':return <svg {...p}><path d="M7 17L17 7" /><path d="M8 7h9v9" /></svg>
    case 'drag':   return <svg {...p} fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
    default:       return null
  }
}
// A round icon button — the SVG sits dead-center because it's a flex child with equal box on all sides.
function IconBtn({ name, title, onClick, size = 26, tone = 'default' }) {
  const bg = tone === 'ghost' ? 'transparent' : '#12122aee'
  const bd = tone === 'ghost' ? 'transparent' : '#5b6af0'
  const col = tone === 'danger' ? '#f87171' : '#c5d0ff'
  return (
    <button title={title} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onClick?.(e) }}
      style={{ pointerEvents: 'auto', width: size, height: size, padding: 0, borderRadius: '50%', background: bg, border: `1px solid ${bd}`, color: col, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
      <Icon name={name} size={Math.round(size * 0.56)} />
    </button>
  )
}

// ── YouTube IFrame API loader (shared, once) ─────────────────────────────────
let ytApiPromise = null
function loadYTApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (ytApiPromise) return ytApiPromise
  ytApiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT) }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  })
  return ytApiPromise
}

// A single reusable YT player. Exposes an imperative handle via onReady(api). `clip` = {youtubeId,start,end}.
// While not playing, a poster (thumbnail) covers the iframe so no YouTube UI shows. On end, calls onEnded.
export function YTPlayer({ clip, autoplay = false, muted = false, interactive = true, externalControl = false, onReady, onEnded, onStateChange, style }) {
  const holderRef = useRef(null)
  const playerRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [covered, setCovered] = useState(true)   // poster over the player until it actually plays
  const clipRef = useRef(clip); clipRef.current = clip
  const cbRef = useRef({}); cbRef.current = { onReady, onEnded, onStateChange }

  useEffect(() => {
    let dead = false
    loadYTApi().then((YT) => {
      if (dead || !holderRef.current) return
      const c = clipRef.current || {}
      playerRef.current = new YT.Player(holderRef.current, {
        videoId: c.youtubeId || undefined,
        playerVars: {
          controls: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3,
          fs: 0, playsinline: 1, start: Math.round(c.start || 0),
          ...(c.end ? { end: Math.round(c.end) } : {}), origin: window.location.origin,
        },
        events: {
          onReady: (e) => {
            setReady(true)
            if (muted) e.target.mute()
            if (autoplay) { e.target.playVideo() }
            cbRef.current.onReady?.(makeHandle(e.target))
          },
          onStateChange: (e) => {
            // 1 = playing → drop the poster; 0 = ended → advance; 2 = paused
            if (e.data === 1) setCovered(false)
            if (e.data === 0) { setCovered(true); cbRef.current.onEnded?.() }
            cbRef.current.onStateChange?.(e.data)
          },
        },
      })
    })
    return () => { dead = true; try { playerRef.current?.destroy?.() } catch { /* ignore */ } playerRef.current = null }
  }, []) // eslint-disable-line -- create once; clip changes handled below

  // Build the imperative handle the graph/inspector drives.
  const makeHandle = (p) => ({
    play: () => { try { p.playVideo() } catch { /* */ } },
    pause: () => { try { p.pauseVideo() } catch { /* */ } },
    seekBy: (d) => { try { p.seekTo(Math.max(0, (p.getCurrentTime?.() || 0) + d), true) } catch { /* */ } },
    seekTo: (t) => { try { p.seekTo(Math.max(0, t), true) } catch { /* */ } },
    mute: () => { try { p.mute() } catch { /* */ } },
    unMute: () => { try { p.unMute() } catch { /* */ } },
    duration: () => { try { return p.getDuration?.() || 0 } catch { return 0 } },
    time: () => { try { return p.getCurrentTime?.() || 0 } catch { return 0 } },
    loadClip: (cl, play) => {
      try {
        const opts = { videoId: cl.youtubeId, startSeconds: Math.round(cl.start || 0), ...(cl.end ? { endSeconds: Math.round(cl.end) } : {}) }
        setCovered(true)
        if (play) p.loadVideoById(opts); else p.cueVideoById(opts)
      } catch { /* */ }
    },
  })

  // When the clip changes (id/trim), reload it in the existing player. Skipped when the parent drives
  // clip switching through the handle (externalControl) — avoids a double-load.
  useEffect(() => {
    if (externalControl) return
    if (!ready || !playerRef.current || !clip?.youtubeId) return
    const p = playerRef.current
    try {
      const opts = { videoId: clip.youtubeId, startSeconds: Math.round(clip.start || 0), ...(clip.end ? { endSeconds: Math.round(clip.end) } : {}) }
      setCovered(true)
      if (autoplay) p.loadVideoById(opts); else p.cueVideoById(opts)
    } catch { /* */ }
  }, [clip?.youtubeId, clip?.start, clip?.end]) // eslint-disable-line

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden', ...style }}>
      <div ref={holderRef} style={{ width: '100%', height: '100%', pointerEvents: interactive ? 'auto' : 'none' }} />
      {/* Poster hides YouTube's own chrome (big play button, title, end-screen) until/after playback. */}
      {covered && clip?.youtubeId && (
        <div onMouseDown={e => e.stopPropagation()} onClick={() => { if (interactive) playerRef.current?.playVideo?.() }}
          style={{ position: 'absolute', inset: 0, background: `#000 center/cover no-repeat url("${ytThumb(clip.youtubeId)}")`,
            cursor: interactive ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'rgba(12,12,26,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.35)', color: '#fff' }}>
            <Icon name="play" size={26} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Dual-handle trim slider ───────────────────────────────────────────────────
// onChange(start, end, which) — `which` is 'start' | 'end', so the caller can scrub the preview to
// whichever edge is being moved.
function TrimSlider({ start, end, max, onChange }) {
  const trackRef = useRef(null)
  const drag = (which) => (e) => {
    e.preventDefault(); e.stopPropagation()
    const move = (ev) => {
      const r = trackRef.current.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      const t = Math.round(frac * max)
      if (which === 'start') onChange(Math.min(t, (end || max) - 1), end, 'start')
      else onChange(start, Math.max(t, (start || 0) + 1), 'end')
    }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const sPct = max ? (start / max) * 100 : 0
  const ePct = max ? ((end || max) / max) * 100 : 100
  return (
    <div ref={trackRef} style={{ position: 'relative', height: 26, margin: '4px 8px' }}>
      <div style={{ position: 'absolute', top: 11, left: 0, right: 0, height: 4, borderRadius: 2, background: '#2a2f47' }} />
      <div style={{ position: 'absolute', top: 11, left: `${sPct}%`, width: `${ePct - sPct}%`, height: 4, borderRadius: 2, background: '#5b6af0' }} />
      {[['start', sPct], ['end', ePct]].map(([w, pct]) => (
        <div key={w} onMouseDown={drag(w)} style={{ position: 'absolute', top: 3, left: `calc(${pct}% - 7px)`, width: 14, height: 20, borderRadius: 4, background: '#c5d0ff', border: '1px solid #5b6af0', cursor: 'ew-resize' }} />
      ))}
    </div>
  )
}

// ── Inspector: clips column (drag to reorder) + trim + triggers. Preview happens on the NODE. ────
export function YTSlideshowInspector({ clips, anchor, onChange, onClose, onExtract, preview }) {
  const [sel, setSel] = useState(0)
  const [urlInput, setUrlInput] = useState('')
  const [dur, setDur] = useState(0)
  const [dragIdx, setDragIdx] = useState(null)
  const [dropIdx, setDropIdx] = useState(null)
  const rowsRef = useRef(null)
  const cur = clips[sel] || null
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))
  const patch = (i, p) => onChange(clips.map((c, j) => j === i ? { ...c, ...p } : c))

  const addUrl = () => {
    const id = parseYoutubeId(urlInput)
    if (!id) { alert('Not a YouTube link/ID.'); return }
    onChange([...clips, { id: uid(), youtubeId: id, title: '', start: 0, end: 0, trigger: 'click', delayMs: 1500 }])
    setUrlInput(''); setSel(clips.length)
  }
  const del = (i) => { onChange(clips.filter((_, j) => j !== i)); setSel(s => Math.max(0, Math.min(s, clips.length - 2))) }

  // Selecting a clip auto-plays it on the node from its trimmed start, and we poll its duration for the slider.
  useEffect(() => {
    setDur(0)
    if (!cur) return
    preview?.select?.(sel, cur)
    let n = 0
    const t = setInterval(() => { const d = preview?.duration?.() || 0; if (d) { setDur(d); clearInterval(t) } if (++n > 30) clearInterval(t) }, 300)
    return () => clearInterval(t)
  }, [cur?.id]) // eslint-disable-line

  // Trim edits scrub the preview: moving START restarts play from there; moving END seeks to it.
  const onTrim = (s, e, which) => {
    patch(sel, { start: s, end: e >= max ? 0 : e })
    if (which === 'start') { preview?.seek?.(s); preview?.play?.() }
    else preview?.seek?.(Math.min(e, max))
  }

  // Mouse-drag reorder of the clips column (no up/down buttons).
  const rowDrag = (i) => (e) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    setSel(i); setDragIdx(i)
    let to = i
    const move = (ev) => {
      const c = rowsRef.current; if (!c) return
      const rows = [...c.querySelectorAll('[data-cliprow]')]
      to = rows.length
      for (let k = 0; k < rows.length; k++) { const r = rows[k].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { to = k; break } }
      setDropIdx(to)
    }
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      setDragIdx(null); setDropIdx(null)
      if (to != null && to !== i && to !== i + 1) {
        const arr = clips.slice(); const [x] = arr.splice(i, 1)
        const dest = to > i ? to - 1 : to
        arr.splice(dest, 0, x); onChange(arr); setSel(dest)
      }
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const inp = { background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 6, padding: '5px 7px', fontSize: 12, outline: 'none', width: 62, textAlign: 'center' }
  const max = Math.max(dur || 0, cur?.end || 0, 30)
  const W = 380
  const pos = anchor
    ? { position: 'fixed', left: Math.max(8, Math.min(anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8)), top: Math.max(8, Math.min(anchor.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 420)), width: W, maxHeight: '86vh', borderRadius: 12, border: '1px solid #2d3a6a' }
    : { position: 'fixed', top: 0, right: 0, height: '100%', width: 420, maxWidth: '96vw', borderLeft: '1px solid #2d3a6a' }
  return (
    <div style={{ ...pos, background: '#12122a', boxShadow: '0 12px 40px rgba(0,0,0,0.55)', zIndex: 500, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: '-apple-system, sans-serif' }}
      onMouseDown={e => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid #23234a' }}>
        <div style={{ flex: 1, color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>YouTube slideshow</div>
        <span style={{ color: '#7080a0', fontSize: 11 }}>previewing on the node →</span>
        <IconBtn name="close" title="Close" onClick={onClose} tone="ghost" size={26} />
      </div>

      {/* Trim + trigger for the selected clip (preview is the node itself) */}
      {cur && (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #23234a' }}>
          <TrimSlider start={cur.start || 0} end={cur.end || max} max={max} onChange={onTrim} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#8fa0d8', marginTop: 2 }}>
            <span>Start</span>
            <input style={inp} defaultValue={fmtTime(cur.start || 0)} key={'s' + cur.id + (cur.start || 0)}
              onBlur={e => { const v = parseTime(e.target.value); if (v != null) { patch(sel, { start: v }); preview?.seek?.(v); preview?.play?.() } }} />
            <span style={{ flex: 1 }} />
            <span>End</span>
            <input style={inp} defaultValue={cur.end ? fmtTime(cur.end) : ''} placeholder={fmtTime(max)} key={'e' + cur.id + (cur.end || 0)}
              onBlur={e => { const v = parseTime(e.target.value); patch(sel, { end: v || 0 }); if (v != null) preview?.seek?.(v) }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#8fa0d8', marginTop: 10 }}>
            <span>Advance</span>
            <select value={cur.trigger || 'click'} onChange={e => patch(sel, { trigger: e.target.value })}
              style={{ ...inp, width: 'auto', textAlign: 'left', flex: 1 }}>
              <option value="click">On click / key</option>
              <option value="auto">Automatically (when it ends)</option>
              <option value="delay">After a delay</option>
            </select>
            {cur.trigger === 'delay' && (
              <input style={{ ...inp, width: 54 }} defaultValue={String((cur.delayMs || 1500) / 1000)} key={'d' + cur.id}
                onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) patch(sel, { delayMs: Math.max(0, v * 1000) }) }} title="seconds" />
            )}
            {cur.trigger === 'delay' && <span>s</span>}
          </div>
        </div>
      )}

      {/* Clips column — drag a row to reorder */}
      <div ref={rowsRef} style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {clips.map((c, i) => (
          <div key={c.id} data-cliprow onClick={() => setSel(i)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 7, marginBottom: 4, cursor: 'pointer',
              opacity: dragIdx === i ? 0.4 : 1,
              background: i === sel ? '#1c2148' : 'transparent',
              borderTop: `2px solid ${dropIdx === i && dragIdx != null ? '#5b6af0' : 'transparent'}`,
              border: `1px solid ${i === sel ? '#3a4a8a' : 'transparent'}` }}>
            <span onMouseDown={rowDrag(i)} title="Drag to reorder" style={{ color: '#7d84a4', cursor: 'grab', display: 'flex', flex: '0 0 auto' }}><Icon name="drag" size={16} /></span>
            <img src={ytThumb(c.youtubeId)} alt="" width={62} height={35} style={{ borderRadius: 4, objectFit: 'cover', flexShrink: 0, background: '#000' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#c5d0ff', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || c.youtubeId}</div>
              <div style={{ color: '#7080a0', fontSize: 10.5 }}>{fmtTime(c.start || 0)}–{c.end ? fmtTime(c.end) : 'end'} · {c.trigger || 'click'}</div>
            </div>
            {onExtract && <IconBtn name="extract" title="Pop out onto the canvas" size={22} tone="ghost" onClick={() => { onExtract(c); onChange(clips.filter((_, j) => j !== i)) }} />}
            <IconBtn name="trash" title="Delete" size={22} tone="danger" onClick={() => del(i)} />
          </div>
        ))}
        {!clips.length && <div style={{ color: '#7080a0', fontSize: 12, padding: 8 }}>No clips yet. Paste a YouTube link below.</div>}
      </div>

      {/* Add */}
      <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid #23234a' }}>
        <input value={urlInput} onChange={e => setUrlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addUrl() }}
          placeholder="Paste a YouTube link…" style={{ ...inp, width: 'auto', flex: 1, textAlign: 'left' }} />
        <button onClick={addUrl} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '0 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}><Icon name="add" size={13} />Add</button>
      </div>
    </div>
  )
}

// ── Fullscreen player: plays the whole slideshow in real browser fullscreen ──────────────────
// Ladder at the end: last clip ends → last frame + replay (stays); → exits to the node on canvas.
export function YTFullscreenPlayer({ clips = [], startIndex = 0, onExit, onReplayDone }) {
  const wrapRef = useRef(null)
  const handleRef = useRef(null)
  const [idx, setIdx] = useState(startIndex)
  const [ended, setEnded] = useState(false)
  const idxRef = useRef(startIndex); idxRef.current = idx
  const endedRef = useRef(false); endedRef.current = ended
  const advTimer = useRef(null)
  const cur = clips[idx] || null

  // Enter real fullscreen on mount; exit on unmount. If the user leaves fullscreen (Esc via browser),
  // treat it as exit.
  useEffect(() => {
    const el = wrapRef.current
    el?.requestFullscreen?.().catch(() => {})
    const onFsChange = () => { if (!document.fullscreenElement) onExit?.() }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      if (advTimer.current) clearTimeout(advTimer.current)
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    }
  }, []) // eslint-disable-line

  const goto = (i, play = true) => { setEnded(false); setIdx(i); handleRef.current?.loadClip?.(clips[i], play) }
  const advance = () => {
    const i = idxRef.current
    if (i < clips.length - 1) goto(i + 1, true)
    else { setEnded(true); handleRef.current?.pause?.() }
  }
  const onEnded = () => {
    const clip = clips[idxRef.current]; if (!clip) return
    if (clip.trigger === 'auto') advance()
    else if (clip.trigger === 'delay') { advTimer.current = setTimeout(advance, clip.delayMs || 1500) }
    else setEnded(idxRef.current === clips.length - 1)   // 'click' on last clip → show replay/finish state
  }

  // Keyboard: ←/→ clips, Space play/pause, Shift+←/→ ∓10s, Esc/→-past-end → exit ladder.
  useEffect(() => {
    const onKey = (e) => {
      // Capture-phase + stopPropagation so these arrows drive ONLY the fullscreen player, never the graph nav.
      const keys = ['Escape', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ']
      if (keys.includes(e.key)) e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); onExit?.(); return }
      if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); handleRef.current?.seekBy?.(10); return }
      if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); handleRef.current?.seekBy?.(-10); return }
      if (e.key === ' ') { e.preventDefault(); handleRef.current?.play?.(); return }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const i = idxRef.current
        if (i < clips.length - 1) goto(i + 1, true)
        else if (!endedRef.current) { setEnded(true); handleRef.current?.pause?.() }   // to last frame + replay
        else onExit?.()   // already at the end → leave fullscreen, back to the node
        return
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); const i = idxRef.current; if (i > 0) goto(i - 1, true); return }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [clips.length]) // eslint-disable-line

  return (
    <div ref={wrapRef} style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', height: '100%', maxWidth: '177.78vh', maxHeight: '100vh', aspectRatio: '16 / 9', margin: 'auto' }}>
        {cur && <YTPlayer key="fs" clip={cur} autoplay muted={false} interactive externalControl onReady={h => { handleRef.current = h; h.loadClip?.(cur, true) }} onEnded={onEnded} />}
      </div>
      {ended && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: 'rgba(6,6,16,0.55)', fontFamily: '-apple-system, sans-serif' }}>
          <button onClick={() => goto(0, true)} title="Replay" style={{ width: 76, height: 76, borderRadius: '50%', background: 'rgba(18,18,42,0.85)', border: '2px solid #5b6af0', color: '#dbe2ff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="replay" size={34} /></button>
          <div style={{ color: '#aab4dd', fontSize: 13 }}>End of slideshow — replay, or press → to return</div>
        </div>
      )}
      {/* Controls: prev / next / exit */}
      <div style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 12, alignItems: 'center' }}>
        <IconBtn name="prev" title="Previous" size={40} onClick={() => { const i = idxRef.current; if (i > 0) goto(i - 1, true) }} />
        <div style={{ color: '#c5d0ff', fontSize: 13, minWidth: 54, textAlign: 'center', fontFamily: '-apple-system, sans-serif' }}>{idx + 1} / {clips.length}</div>
        <IconBtn name="next" title="Next" size={40} onClick={() => { const i = idxRef.current; if (i < clips.length - 1) goto(i + 1, true); else if (!endedRef.current) { setEnded(true); handleRef.current?.pause?.() } else onExit?.() }} />
      </div>
      <div style={{ position: 'absolute', top: 18, right: 18 }}>
        <IconBtn name="close" title="Exit fullscreen (Esc)" size={40} onClick={() => onExit?.()} />
      </div>
    </div>
  )
}

// ── On-canvas node: a clean player showing the current clip ───────────────────
// `active` = the ytss has been "entered" (arrows drive it). `currentIdx` is controlled by the parent so
// arrow-nav can drive it; onReady exposes the live player handle for seek/play. Drag via the whole card.
export function YTSlideshowNode({ node, ytss, currentIdx = 0, active, externalControl, selected, isDropTarget, ended, onHeaderDown, onSelect, onEnter, onEdit, onReady, onEnded, onSetIdx, onFullscreen, onReplay }) {
  const clips = ytss?.clips || []
  const idx = Math.max(0, Math.min(currentIdx, clips.length - 1))
  const cur = clips[idx] || null
  const W = 480 * (node.__scale || 1), H = 270 * (node.__scale || 1)
  const label = node.label || 'YouTube slideshow'
  const bd = active ? '#4ade80' : (isDropTarget ? '#4ade80' : (selected ? '#5b6af0' : '#2d3a6a'))
  return (
    <g transform={`translate(${node.x || 0},${node.y || 0})`} data-ytss="1" data-cardnode={node.id}
      onMouseDown={e => { if (e.button === 0 && !active) { e.stopPropagation(); onSelect?.(); onHeaderDown?.(e) } }}
      onDoubleClick={e => { e.stopPropagation(); onEnter?.() }}>
      {/* Title above */}
      <text x={0} y={-H / 2 - 10} textAnchor="middle" fontSize={15} fill={active ? '#8ecbff' : '#c5d0ff'}
        style={{ userSelect: 'none', fontWeight: 600 }}>{label}{clips.length ? `  ·  ${idx + 1}/${clips.length}` : ''}</text>
      <foreignObject x={-W / 2} y={-H / 2} width={W} height={H} style={{ overflow: 'visible' }}>
        <div style={{ width: '100%', height: '100%', borderRadius: 10, overflow: 'hidden',
          border: `2px solid ${bd}`, boxShadow: isDropTarget ? '0 0 0 4px rgba(74,222,128,0.35)' : 'none', background: '#000', position: 'relative' }}>
          {cur
            ? <YTPlayer key={node.id} clip={cur} interactive={active} externalControl={externalControl} onReady={onReady} onEnded={onEnded} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8fa0d8', fontFamily: '-apple-system, sans-serif' }}>
                <Icon name="play" size={30} />
                <div style={{ fontSize: 13 }}>Empty slideshow</div>
                <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit?.() }}
                  style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>Add clips…</button>
              </div>}
          {isDropTarget && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'rgba(74,222,128,0.14)', color: '#dcfce7', fontSize: 15, fontWeight: 700, fontFamily: '-apple-system, sans-serif', pointerEvents: 'none' }}>
              <Icon name="add" size={16} /> Add to slideshow
            </div>
          )}
          {/* End-of-slideshow: last frame + replay (arrow-nav ladder handles what → does next) */}
          {ended && active && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(6,6,16,0.5)', fontFamily: '-apple-system, sans-serif' }}>
              <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onReplay?.() }} title="Replay"
                style={{ width: 54, height: 54, borderRadius: '50%', background: 'rgba(18,18,42,0.85)', border: '2px solid #5b6af0', color: '#dbe2ff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="replay" size={26} /></button>
              <div style={{ color: '#aab4dd', fontSize: 11 }}>End — replay, or → to return</div>
            </div>
          )}
          {/* Hint bar while active */}
          {active && !ended && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '4px 8px', background: 'rgba(10,10,24,0.82)', color: '#aab4dd', fontSize: 10.5, textAlign: 'center', fontFamily: '-apple-system, sans-serif', pointerEvents: 'none' }}>
              ← → clips · space play/pause · shift+←/→ ∓10s · esc exit
            </div>
          )}
        </div>
      </foreignObject>
      {/* Selected controls — own foreignObject placed AFTER the video so they paint on top and stay clickable. */}
      {selected && !active && (
        <foreignObject x={-W / 2} y={-H / 2 - 6} width={W} height={H + 12} style={{ overflow: 'visible', pointerEvents: 'none' }}>
          <div style={{ position: 'relative', width: '100%', height: '100%', fontFamily: '-apple-system, sans-serif' }}>
            <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 6 }}>
              <IconBtn name="edit" title="Edit slideshow" size={26} onClick={onEdit} />
              <IconBtn name="full" title="Play fullscreen" size={26} onClick={onFullscreen} />
              <IconBtn name="play" title="Play (or double-click)" size={26} onClick={onEnter} />
            </div>
            {clips.length > 1 && (<>
              <div style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)' }}>
                <IconBtn name="prev" title="Previous clip" size={30} onClick={() => onSetIdx?.((idx - 1 + clips.length) % clips.length)} />
              </div>
              <div style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)' }}>
                <IconBtn name="next" title="Next clip" size={30} onClick={() => onSetIdx?.((idx + 1) % clips.length)} />
              </div>
            </>)}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, textAlign: 'center', color: '#aab4dd', fontSize: 10.5, pointerEvents: 'none' }}>drag anywhere to move · double-click to play</div>
          </div>
        </foreignObject>
      )}
    </g>
  )
}
