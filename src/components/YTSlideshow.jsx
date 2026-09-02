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
    case 'copy':   return <svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
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
export function YTPlayer({ clip, autoplay = false, muted = false, captions = false, loop = false, interactive = true, externalControl = false, onReady, onEnded, onStateChange, style }) {
  const holderRef = useRef(null)
  const playerRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [covered, setCovered] = useState(true)   // poster over the player until it actually plays
  const clipRef = useRef(clip); clipRef.current = clip
  const loopRef = useRef(loop); loopRef.current = loop
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
          ...(c.end ? { end: Math.round(c.end) } : {}),
          ...(captions ? { cc_load_policy: 1, cc_lang_pref: 'en' } : {}),
          origin: window.location.origin,
        },
        events: {
          onReady: (e) => {
            setReady(true)
            if (muted) e.target.mute()
            if (c.speed && c.speed !== 1) { try { e.target.setPlaybackRate(c.speed) } catch { /* */ } }
            if (autoplay) { e.target.playVideo() }
            cbRef.current.onReady?.(makeHandle(e.target))
          },
          onStateChange: (e) => {
            // 1 = playing → drop the poster; 0 = ended → loop or advance; 2 = paused
            if (e.data === 1) setCovered(false)
            if (e.data === 0) {
              if (loopRef.current) { try { e.target.seekTo(Math.round(clipRef.current?.start || 0), true); e.target.playVideo() } catch { /* */ } }
              else { setCovered(true); cbRef.current.onEnded?.() }
            }
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
    setRate: (r) => { try { p.setPlaybackRate(r || 1) } catch { /* */ } },
    duration: () => { try { return p.getDuration?.() || 0 } catch { return 0 } },
    time: () => { try { return p.getCurrentTime?.() || 0 } catch { return 0 } },
    loadClip: (cl, play) => {
      try {
        const opts = { videoId: cl.youtubeId, startSeconds: Math.round(cl.start || 0), ...(cl.end ? { endSeconds: Math.round(cl.end) } : {}) }
        setCovered(true)
        if (play) p.loadVideoById(opts); else p.cueVideoById(opts)
        try { p.setPlaybackRate(cl.speed || 1) } catch { /* */ }
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
      try { p.setPlaybackRate(clip.speed || 1) } catch { /* */ }
    } catch { /* */ }
  }, [clip?.youtubeId, clip?.start, clip?.end, clip?.speed]) // eslint-disable-line

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden', ...style }}>
      <div ref={holderRef} style={{ width: '100%', height: '100%', pointerEvents: interactive ? 'auto' : 'none' }} />
      {/* Poster hides YouTube's own chrome (big play button, title, end-screen) until/after playback. */}
      {covered && clip?.youtubeId && (
        <div onMouseDown={e => { if (interactive) e.stopPropagation() }} onClick={() => { if (interactive) playerRef.current?.playVideo?.() }}
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

// ── A slide's kind: youtube | video | audio | image (legacy clips with a youtubeId are 'youtube') ──
export const clipKind = (c) => c?.kind || (c?.youtubeId ? 'youtube' : (c?.src ? 'video' : 'youtube'))
export const isTimeMedia = (c) => { const k = clipKind(c); return k === 'youtube' || k === 'video' || k === 'audio' }

// ── Native <video>/<audio> file player with a YT-compatible handle ────────────────────────────
function MediaFilePlayer({ clip, kind, autoplay = false, muted = false, interactive = true, onReady, onEnded, style }) {
  const ref = useRef(null)
  const start = clip.start || 0
  const end = (clip.end && clip.end > start) ? clip.end : 0
  useEffect(() => {
    const el = ref.current; if (!el) return
    el.playbackRate = clip.speed || 1
    el.loop = !!clip.loop
    let ended = false
    const seekStart = () => { if (start) { try { el.currentTime = start } catch { /* not seekable yet */ } } }
    const onLoaded = () => { seekStart(); el.playbackRate = clip.speed || 1 }
    const onTime = () => {
      if (end && el.currentTime >= end) {
        if (clip.loop) { try { el.currentTime = start } catch { /* */ } el.play().catch(() => {}) }
        else if (!ended) { ended = true; el.pause(); onEnded?.() }
      }
    }
    const onNativeEnded = () => { if (!clip.loop && !ended) { ended = true; onEnded?.() } }
    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('ended', onNativeEnded)
    if (el.readyState >= 1) onLoaded()
    // Autoplay: try with sound; if the browser blocks it, fall back to muted.
    if (autoplay) { el.muted = !!muted; el.play().catch(() => { el.muted = true; el.play().catch(() => {}) }) }
    else el.muted = !!muted
    onReady?.({
      play: () => el.play().catch(() => {}), pause: () => el.pause(),
      seekBy: (d) => { try { el.currentTime = Math.max(start, (el.currentTime || 0) + d) } catch { /* */ } },
      seekTo: (t) => { try { el.currentTime = Math.max(0, t) } catch { /* */ } },
      mute: () => { el.muted = true }, unMute: () => { el.muted = false },
      setRate: (r) => { el.playbackRate = r || 1 },
      duration: () => el.duration || 0, time: () => el.currentTime || 0,
    })
    return () => { el.removeEventListener('loadedmetadata', onLoaded); el.removeEventListener('timeupdate', onTime); el.removeEventListener('ended', onNativeEnded) }
  }, [clip.src, clip.start, clip.end, clip.speed, clip.loop]) // eslint-disable-line

  if (kind === 'audio') {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%', background: 'linear-gradient(135deg,#1a1f3a,#0e0e1c)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, overflow: 'hidden', ...style }}>
        <div style={{ width: 84, height: 84, borderRadius: '50%', background: 'rgba(91,106,240,0.18)', border: '1px solid #3a4a8a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c5d0ff' }}>
          <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>
        </div>
        <div style={{ color: '#c5d0ff', fontSize: 13, fontFamily: '-apple-system, sans-serif', maxWidth: '80%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clip.title || 'Audio'}</div>
        <audio ref={ref} src={clip.src} preload="metadata" style={{ display: 'none' }} />
      </div>
    )
  }
  return <video ref={ref} src={clip.src} playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', pointerEvents: interactive ? 'auto' : 'none', ...style }} />
}

// ── Image slide: shown for `duration` seconds, then "ends" so the show can advance ────────────
function ImageSlide({ clip, autoplay = false, onReady, onEnded, style }) {
  const timer = useRef(null)
  const remaining = useRef((clip.duration || 5) * 1000)
  const startedAt = useRef(0)
  useEffect(() => {
    const arm = (ms) => { clearTimeout(timer.current); startedAt.current = Date.now(); timer.current = setTimeout(() => onEnded?.(), ms) }
    if (autoplay && !clip.loop) arm((clip.duration || 5) * 1000)
    onReady?.({
      play: () => { if (!clip.loop) arm(remaining.current) },
      pause: () => { clearTimeout(timer.current); remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current)) },
      seekBy: () => {}, seekTo: () => {}, mute: () => {}, unMute: () => {}, setRate: () => {},
      duration: () => clip.duration || 5, time: () => 0,
    })
    return () => clearTimeout(timer.current)
  }, [clip.src, clip.duration, clip.loop, autoplay]) // eslint-disable-line
  return <div style={{ width: '100%', height: '100%', background: `#000 center/contain no-repeat url("${clip.src}")`, ...style }} />
}

// ── Polymorphic slide player: dispatches to the right engine by kind, one uniform handle ──────
export function SlidePlayer({ clip, autoplay = false, muted = false, captions = false, interactive = true, onReady, onEnded, style }) {
  const kind = clipKind(clip)
  if (kind === 'image') return <ImageSlide clip={clip} autoplay={autoplay} onReady={onReady} onEnded={onEnded} style={style} />
  if (kind === 'video' || kind === 'audio') return <MediaFilePlayer clip={clip} kind={kind} autoplay={autoplay} muted={muted} interactive={interactive} onReady={onReady} onEnded={onEnded} style={style} />
  return <YTPlayer clip={clip} autoplay={autoplay} muted={muted} captions={captions} loop={clip.loop} interactive={interactive} externalControl={false} onReady={onReady} onEnded={onEnded} style={style} />
}

// ── Dual-handle trim slider ───────────────────────────────────────────────────
// onChange(start, end, which) — `which` is 'start' | 'end', so the caller can scrub the preview to
// whichever edge is being moved.
const trimBtn = { background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 5, padding: '1px 7px', cursor: 'pointer', fontSize: 10.5, whiteSpace: 'nowrap' }
// Dual-handle trim slider. A SEPARATE zoom slider narrows the visible window (centered on the selection)
// so a short clip is placeable in a long video — but zoom never moves on its own, and the window is frozen
// for the duration of a handle drag so handles can't drift. Live preview via onScrub (drag) / onLoop (release).
function TrimSlider({ start, end, max, onChange, onScrub, onLoop }) {
  const trackRef = useRef(null)
  const [zoom, setZoom] = useState(1)   // 1 = whole video; higher = narrower window
  const [dragging, setDragging] = useState(false)
  const M = Math.max(max || 1, 1)
  const s = Math.max(0, Math.min(start || 0, M)), e = Math.min(M, (end && end > s) ? end : M)
  const stateRef = useRef({ s, e, M })
  stateRef.current = { s, e, M }
  const winRef = useRef({ w0: 0, w1: M })
  // Window follows the selection at the chosen zoom — but only recompute when NOT dragging (frozen mid-drag).
  if (!dragging) {
    if (zoom <= 1) winRef.current = { w0: 0, w1: M }
    else {
      const width = M / zoom
      const mid = (s + e) / 2
      let w0 = Math.max(0, Math.min(mid - width / 2, M - width))
      winRef.current = { w0, w1: w0 + width }
    }
  }
  const { w0, w1 } = winRef.current
  const span = Math.max(1, w1 - w0)

  const drag = (which) => (ev0) => {
    ev0.preventDefault(); ev0.stopPropagation()
    setDragging(true)
    const move = (ev) => {
      const r = trackRef.current.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      const { w0: a, w1: b } = winRef.current
      const t = Math.round(a + frac * (b - a))
      const { s: cs, e: ce, M: m } = stateRef.current
      if (which === 'start') { const nv = Math.max(0, Math.min(t, ce - 1)); onChange(nv, end, 'start'); onScrub?.(nv, 'start') }
      else { const nv = Math.min(m, Math.max(t, cs + 1)); onChange(cs, nv, 'end'); onScrub?.(nv, 'end') }
    }
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      setDragging(false)
      const { s: cs, e: ce } = stateRef.current
      onLoop?.(cs, ce)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }

  const pct = (t) => Math.max(0, Math.min(1, (t - w0) / span)) * 100
  const sPct = pct(s), ePct = pct(e)
  const zoomed = zoom > 1
  return (
    <div style={{ margin: '2px 8px' }}>
      <div ref={trackRef} style={{ position: 'relative', height: 24 }}>
        <div style={{ position: 'absolute', top: 10, left: 0, right: 0, height: 4, borderRadius: 2, background: '#2a2f47' }} />
        {zoomed && w0 > 0 && <div style={{ position: 'absolute', top: 7, left: 0, width: 3, height: 10, borderRadius: 2, background: '#3a4a8a' }} />}
        {zoomed && w1 < M && <div style={{ position: 'absolute', top: 7, right: 0, width: 3, height: 10, borderRadius: 2, background: '#3a4a8a' }} />}
        <div style={{ position: 'absolute', top: 10, left: `${sPct}%`, width: `${Math.max(0, ePct - sPct)}%`, height: 4, borderRadius: 2, background: '#5b6af0' }} />
        {[['start', sPct], ['end', ePct]].map(([w, p]) => (
          <div key={w} onMouseDown={drag(w)} style={{ position: 'absolute', top: 2, left: `calc(${p}% - 7px)`, width: 14, height: 20, borderRadius: 4, background: '#c5d0ff', border: '1px solid #5b6af0', cursor: 'ew-resize' }} />
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10.5, color: '#8fa0d8', marginTop: 3 }}>
        <span>{fmtTime(s)}–{fmtTime(e)}</span>
        {zoomed && <span style={{ color: '#7080a0' }}>· view {fmtTime(w0)}–{fmtTime(w1)}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ color: '#7c86ad' }} title="Zoom the timeline for finer control">🔍</span>
        <input type="range" min={1} max={40} step={1} value={zoom} onMouseDown={e => e.stopPropagation()}
          onChange={e => setZoom(Number(e.target.value))} style={{ width: 84, accentColor: '#5b6af0' }} title="Zoom the timeline for finer control" />
        {zoomed && <button onMouseDown={e => e.stopPropagation()} onClick={() => setZoom(1)} style={trimBtn} title="Zoom out to the whole video">full</button>}
      </div>
    </div>
  )
}

// ── Inspector: clips column (drag to reorder) + trim + triggers. Preview happens on the NODE. ────
export function YTSlideshowInspector({ clips, anchor, onChange, onClose, onExtract, preview, fullscreen, onToggleFullscreen, sound, onToggleSound, captions, onToggleCaptions, onUpload }) {
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
    onChange([...clips, { id: uid(), kind: 'youtube', youtubeId: id, title: '', start: 0, end: 0, trigger: 'click', delayMs: 1500 }])
    setUrlInput(''); setSel(clips.length)
  }
  const del = (i) => { onChange(clips.filter((_, j) => j !== i)); setSel(s => Math.max(0, Math.min(s, clips.length - 2))) }
  // Duplicate a clip (right after it) so you can show a different segment of the SAME video in one slideshow.
  const dup = (i) => { const copy = { ...clips[i], id: uid() }; onChange([...clips.slice(0, i + 1), copy, ...clips.slice(i + 1)]); setSel(i + 1) }

  // Selecting a clip auto-plays it on the node from its trimmed start, and we poll its duration for the slider.
  const [previewPlaying, setPreviewPlaying] = useState(true)
  const endLoopRef = useRef(null)
  const clearEndLoop = () => { if (endLoopRef.current) { clearInterval(endLoopRef.current); endLoopRef.current = null } }
  // While dragging a handle: show a paused frame at that exact time (frame-accurate, precise for long clips).
  const scrubTo = (t) => { clearEndLoop(); preview?.seek?.(t); preview?.pause?.(); setPreviewPlaying(false) }
  // On release: play the trimmed selection on a loop so you keep seeing exactly what you picked.
  const loopSel = (s, e) => {
    clearEndLoop()
    const hi = (e && e > s) ? e : (stateMax())
    preview?.seek?.(s); preview?.play?.(); setPreviewPlaying(true)
    endLoopRef.current = setInterval(() => { const t = preview?.time?.() || 0; if (t >= hi - 0.12 || t < s - 0.4) preview?.seek?.(s) }, 180)
  }
  const stateMax = () => Math.max(dur || 0, cur?.end || 0, 30)

  useEffect(() => {
    setDur(0); clearEndLoop(); setPreviewPlaying(true)
    if (!cur) return
    preview?.select?.(sel, cur)
    let n = 0
    const t = setInterval(() => { const d = preview?.duration?.() || 0; if (d) { setDur(d); clearInterval(t) } if (++n > 30) clearInterval(t) }, 300)
    return () => clearInterval(t)
  }, [cur?.id]) // eslint-disable-line
  useEffect(() => () => clearEndLoop(), [])

  // Trim edits persist immediately (the scrub/loop preview is driven by the slider's onScrub/onLoop).
  const onTrimChange = (s, e) => { patch(sel, { start: s, end: e >= max ? 0 : e }) }
  const togglePreview = () => {
    clearEndLoop()
    if (previewPlaying) { preview?.pause?.(); setPreviewPlaying(false) }
    else { preview?.play?.(); setPreviewPlaying(true) }
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
        <div style={{ flex: 1, color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>Slideshow</div>
        {cur && isTimeMedia(cur) && <IconBtn name={previewPlaying ? 'pause' : 'play'} title={previewPlaying ? 'Pause preview' : 'Play preview'} onClick={togglePreview} size={26} />}
        <IconBtn name="close" title="Close" onClick={onClose} tone="ghost" size={26} />
      </div>

      {/* Slideshow-level playback options (per-slide sound/loop/captions live in each slide's settings) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px', borderBottom: '1px solid #23234a' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#c5d0ff', fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!fullscreen} onChange={e => onToggleFullscreen?.(e.target.checked)} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} />
          Play in fullscreen
          <span style={{ color: '#7080a0', fontSize: 11 }}>— entering opens fullscreen</span>
        </label>
      </div>

      {/* Per-clip settings (preview is the node itself). Trim/speed only for timed media; images get a duration. */}
      {cur && (() => {
        const k = clipKind(cur), timed = isTimeMedia(cur)
        return (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #23234a' }}>
          {timed && <>
            <TrimSlider start={cur.start || 0} end={cur.end || max} max={max} onChange={onTrimChange} onScrub={scrubTo} onLoop={loopSel} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#8fa0d8', marginTop: 2 }}>
              <span>Start</span>
              <input style={inp} defaultValue={fmtTime(cur.start || 0)} key={'s' + cur.id + (cur.start || 0)}
                onBlur={e => { const v = parseTime(e.target.value); if (v != null) { patch(sel, { start: v }); preview?.seek?.(v); preview?.play?.() } }} />
              <span style={{ flex: 1 }} />
              <span>End</span>
              <input style={inp} defaultValue={cur.end ? fmtTime(cur.end) : ''} placeholder={fmtTime(max)} key={'e' + cur.id + (cur.end || 0)}
                onBlur={e => { const v = parseTime(e.target.value); patch(sel, { end: v || 0 }); if (v != null) preview?.seek?.(v) }} />
            </div>
          </>}
          {k === 'image' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#8fa0d8' }}>
              <span>Show for</span>
              <input style={{ ...inp, width: 54 }} defaultValue={String(cur.duration || 5)} key={'dur' + cur.id}
                onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) patch(sel, { duration: Math.max(0.5, v) }) }} /> <span>s</span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#8fa0d8', marginTop: 10 }}>
            <span>Advance</span>
            <select value={cur.trigger || 'click'} onChange={e => patch(sel, { trigger: e.target.value })}
              style={{ ...inp, width: 'auto', textAlign: 'left', flex: 1 }}>
              <option value="click">On click / key</option>
              <option value="auto">Automatically{timed ? ' (when it ends)' : ''}</option>
              <option value="delay">After a delay</option>
            </select>
            {cur.trigger === 'delay' && (
              <input style={{ ...inp, width: 54 }} defaultValue={String((cur.delayMs || 1500) / 1000)} key={'d' + cur.id}
                onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) patch(sel, { delayMs: Math.max(0, v * 1000) }) }} title="seconds" />
            )}
            {cur.trigger === 'delay' && <span>s</span>}
          </div>
          {timed && (
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 14px', fontSize: 11.5, color: '#8fa0d8', marginTop: 8 }}>
              {(k === 'youtube' || k === 'video') && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Speed
                  <select value={cur.speed || 1} onChange={e => { const r = parseFloat(e.target.value); patch(sel, { speed: r }); preview?.setRate?.(r) }} style={{ ...inp, width: 'auto', textAlign: 'left' }}>
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => <option key={r} value={r}>{r}×</option>)}
                  </select>
                </span>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#c5d0ff' }}>
                <input type="checkbox" checked={!!cur.loop} onChange={e => patch(sel, { loop: e.target.checked })} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Loop
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#c5d0ff' }}>
                <input type="checkbox" checked={cur.muted !== true} onChange={e => { patch(sel, { muted: !e.target.checked }); if (e.target.checked) preview?.unMute?.(); else preview?.mute?.() }} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Sound
              </label>
              {(k === 'youtube' || k === 'video') && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#c5d0ff' }}>
                  <input type="checkbox" checked={!!cur.captions} onChange={e => patch(sel, { captions: e.target.checked })} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Captions
                </label>
              )}
            </div>
          )}
        </div>
        )
      })()}

      {/* Clips column — drag a row to reorder */}
      <div ref={rowsRef} style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {clips.map((c, i) => (
          <div key={c.id} data-cliprow onMouseDown={rowDrag(i)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 7, marginBottom: 4, cursor: 'grab',
              opacity: dragIdx === i ? 0.4 : 1,
              background: i === sel ? '#1c2148' : 'transparent',
              borderTop: `2px solid ${dropIdx === i && dragIdx != null ? '#5b6af0' : 'transparent'}`,
              border: `1px solid ${i === sel ? '#3a4a8a' : 'transparent'}` }}>
            <span title="Drag to reorder" style={{ color: '#7d84a4', display: 'flex', flex: '0 0 auto' }}><Icon name="drag" size={16} /></span>
            {(() => {
              const k = clipKind(c)
              const thumbSrc = k === 'youtube' ? ytThumb(c.youtubeId) : (k === 'image' ? c.src : null)
              if (thumbSrc) return <img src={thumbSrc} alt="" width={62} height={35} style={{ borderRadius: 4, objectFit: 'cover', flexShrink: 0, background: '#000' }} />
              return <div style={{ width: 62, height: 35, borderRadius: 4, flexShrink: 0, background: '#0e0e1c', border: '1px solid #23234a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7d84a4', fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{k === 'audio' ? 'Audio' : 'Video'}</div>
            })()}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#c5d0ff', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || (clipKind(c) === 'youtube' ? c.youtubeId : clipKind(c))}</div>
              <div style={{ color: '#7080a0', fontSize: 10.5 }}>{clipKind(c) === 'image' ? `${c.duration || 5}s image` : `${fmtTime(c.start || 0)}–${c.end ? fmtTime(c.end) : 'end'}`} · {c.trigger || 'click'}{c.loop ? ' · loop' : ''}</div>
            </div>
            <IconBtn name="copy" title="Duplicate (to show a different part of the same video)" size={22} tone="ghost" onClick={() => dup(i)} />
            {onExtract && <IconBtn name="extract" title="Pop out onto the canvas" size={22} tone="ghost" onClick={() => { onExtract(c); onChange(clips.filter((_, j) => j !== i)) }} />}
            <IconBtn name="trash" title="Delete" size={22} tone="danger" onClick={() => del(i)} />
          </div>
        ))}
        {!clips.length && <div style={{ color: '#7080a0', fontSize: 12, padding: 8 }}>No slides yet. Paste a YouTube link or upload media below.</div>}
      </div>

      {/* Add */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderTop: '1px solid #23234a' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={urlInput} onChange={e => setUrlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addUrl() }}
            placeholder="Paste a YouTube link…" style={{ ...inp, width: 'auto', flex: 1, textAlign: 'left' }} />
          <button onClick={addUrl} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '0 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}><Icon name="add" size={13} />Add</button>
        </div>
        {onUpload && (
          <button onClick={onUpload} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'transparent', border: '1px dashed #3a4a8a', color: '#aeb8ff', borderRadius: 6, padding: '7px 12px', cursor: 'pointer', fontSize: 12.5 }}>
            <Icon name="add" size={13} /> Upload image, audio, or video…
          </button>
        )}
      </div>
    </div>
  )
}

// ── Options panel for a single YouTube video node (link + trim + autoplay + sound + fullscreen) ──
export function YTVideoOptions({ video, anchor, onPatch, onClose, onPlayFullscreen, onUploadPoster, onResetPoster, onScrubTime, onLoopSel, onPreviewPause, getDuration }) {
  const [dur, setDur] = useState(0)
  const [urlInput, setUrlInput] = useState('')
  const [previewPlaying, setPreviewPlaying] = useState(true)
  const yt = video.youtubeId
  // The preview plays on the NODE itself (via onScrub), not here — so we just poll the node player's
  // reported duration to size the trim slider.
  useEffect(() => {
    setDur(0)
    if (!yt || !getDuration) return
    let n = 0
    const t = setInterval(() => { const d = getDuration() || 0; if (d) { setDur(d); clearInterval(t) } if (++n > 40) clearInterval(t) }, 300)
    return () => clearInterval(t)
  }, [yt, getDuration])
  const max = Math.max(dur || 0, video.end || 0, 30)
  const inp = { background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 6, padding: '5px 7px', fontSize: 12, outline: 'none', width: 62, textAlign: 'center' }
  const W = 340
  const pos = anchor
    ? { position: 'fixed', left: Math.max(8, Math.min(anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8)), top: Math.max(8, Math.min(anchor.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 440)), width: W }
    : { position: 'fixed', top: 0, right: 0, height: '100%', width: 380 }
  const row = { display: 'flex', alignItems: 'center', gap: 8, color: '#c5d0ff', fontSize: 12.5 }
  return (
    <div style={{ ...pos, background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.55)', zIndex: 500, fontFamily: '-apple-system, sans-serif', overflow: 'hidden' }}
      onMouseDown={e => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #23234a' }}>
        <div style={{ flex: 1, color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>YouTube video</div>
        <IconBtn name="close" title="Close" onClick={onClose} tone="ghost" size={26} />
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {yt && (
          <div style={{ fontSize: 11, color: '#8fa0d8', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button title={previewPlaying ? 'Pause preview' : 'Play the trimmed clip on a loop'}
              onClick={() => { if (previewPlaying) { onPreviewPause?.(); setPreviewPlaying(false) } else { onLoopSel?.(video.start || 0, video.end || 0); setPreviewPlaying(true) } }}
              style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid #5b6af0', background: '#171c3f', color: '#c5d0ff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
              <Icon name={previewPlaying ? 'pause' : 'play'} size={13} />
            </button>
            <span>Previews on the video itself, on the canvas.</span>
          </div>
        )}
        {/* Link */}
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={urlInput} placeholder={yt ? `youtu.be/${yt}` : 'Paste a YouTube link…'} onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { const id = parseYoutubeId(urlInput); if (id) { onPatch({ youtubeId: id }); setUrlInput('') } else alert('Not a YouTube link/ID.') } }}
            style={{ ...inp, width: 'auto', flex: 1, textAlign: 'left' }} />
          <button onClick={() => { const id = parseYoutubeId(urlInput); if (id) { onPatch({ youtubeId: id }); setUrlInput('') } else alert('Not a YouTube link/ID.') }}
            style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '0 12px', cursor: 'pointer', fontSize: 12 }}>Set</button>
        </div>
        {/* Trim */}
        {yt && <>
          <TrimSlider start={video.start || 0} end={video.end || max} max={max} onChange={(s, e) => onPatch({ start: s, end: e >= max ? 0 : e })} onScrub={onScrubTime} onLoop={onLoopSel} />
          <div style={{ ...row, fontSize: 11.5, color: '#8fa0d8' }}>
            <span>Start</span>
            <input style={inp} defaultValue={fmtTime(video.start || 0)} key={'s' + yt + (video.start || 0)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={e => { const v = parseTime(e.target.value); if (v != null) { onPatch({ start: v }); onScrubTime?.(v, 'start') } }} />
            <span style={{ flex: 1 }} />
            <span>End</span>
            <input style={inp} defaultValue={video.end ? fmtTime(video.end) : ''} placeholder={fmtTime(max)} key={'e' + yt + (video.end || 0)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={e => { const v = parseTime(e.target.value); onPatch({ end: v || 0 }); onScrubTime?.(v || (video.start || 0), 'end') }} />
          </div>
        </>}
        {/* Speed */}
        {yt && (
          <div style={{ ...row, fontSize: 11.5, color: '#8fa0d8' }}>
            <span>Speed</span>
            <select value={video.speed || 1} onChange={e => { const r = parseFloat(e.target.value); onPatch({ speed: r }) }} style={{ ...inp, width: 'auto', textAlign: 'left' }}>
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => <option key={r} value={r}>{r}×</option>)}
            </select>
          </div>
        )}
        {/* Poster frame — the still shown on the canvas before playing (clean, no YouTube chrome).
            YouTube auto-generates real frames of the video: a cover frame plus three stills sampled
            across it (~25/50/75%). Pick one, or upload your own. (An embed is cross-origin, so an
            arbitrary frame at an exact time can't be captured — these are the frames YouTube exposes.) */}
        {yt && onUploadPoster && (() => {
          const frames = [
            { url: `https://img.youtube.com/vi/${yt}/hqdefault.jpg`, label: 'Cover' },
            { url: `https://img.youtube.com/vi/${yt}/1.jpg`, label: '¼' },
            { url: `https://img.youtube.com/vi/${yt}/2.jpg`, label: '½' },
            { url: `https://img.youtube.com/vi/${yt}/3.jpg`, label: '¾' },
          ]
          const current = video.poster || `https://img.youtube.com/vi/${yt}/hqdefault.jpg`
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11.5, color: '#8fa0d8' }}>Poster frame {video.poster ? '(custom)' : '(from the video)'}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {frames.map(f => {
                  const sel = current === f.url
                  return (
                    <button key={f.url} onClick={() => onResetPoster ? (f.label === 'Cover' ? onResetPoster() : onPatch({ poster: f.url })) : onPatch({ poster: f.url })}
                      title={`Use the ${f.label} frame`}
                      style={{ position: 'relative', flex: 1, aspectRatio: '16 / 9', borderRadius: 5, overflow: 'hidden', cursor: 'pointer', padding: 0,
                        border: sel ? '2px solid #5b6af0' : '1px solid #23234a',
                        background: `#0e0e1c center/cover no-repeat url("${f.url}")` }}>
                      <span style={{ position: 'absolute', left: 3, bottom: 2, fontSize: 9.5, color: '#eef1ff', background: 'rgba(8,8,20,0.6)', borderRadius: 3, padding: '0 3px' }}>{f.label}</span>
                    </button>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={onUploadPoster} style={{ background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11.5 }}>Upload image…</button>
                {video.poster && <button onClick={onResetPoster} style={{ background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11.5 }}>Reset to cover</button>}
              </div>
            </div>
          )
        })()}
        {/* Toggles */}
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.autoplayOnZoom} onChange={e => onPatch({ autoplayOnZoom: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Autoplay on zoom / arrow-nav</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.autoplayOnSlide} onChange={e => onPatch({ autoplayOnSlide: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Autoplay on slide</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={video.muted !== true} onChange={e => onPatch({ muted: !e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Sound on</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.loop} onChange={e => onPatch({ loop: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Loop</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.captions} onChange={e => onPatch({ captions: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Captions (CC) <span style={{ color: '#7080a0', fontSize: 11 }}>— if available</span></label>
        {/* Fullscreen */}
        {yt && (
          <button onClick={onPlayFullscreen} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
            <Icon name="full" size={15} /> Play fullscreen
          </button>
        )}
      </div>
    </div>
  )
}

// ── Fullscreen player: plays the whole slideshow in real browser fullscreen ──────────────────
// Ladder at the end: last clip ends → last frame + replay (stays); → exits to the node on canvas.
export function YTFullscreenPlayer({ clips = [], startIndex = 0, muted = false, captions = false, onExit, onReplayDone }) {
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

  const fsPlaying = useRef(true)
  const goto = (i) => { setEnded(false); fsPlaying.current = true; setIdx(i) }   // remount → autoplay the new slide
  const advance = () => {
    const i = idxRef.current
    if (i < clips.length - 1) goto(i + 1)
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
      if (e.key === ' ') { e.preventDefault(); if (fsPlaying.current) { handleRef.current?.pause?.(); fsPlaying.current = false } else { handleRef.current?.play?.(); fsPlaying.current = true } return }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const i = idxRef.current
        if (i < clips.length - 1) goto(i + 1)
        else if (!endedRef.current) { setEnded(true); handleRef.current?.pause?.() }   // to last frame + replay
        else onExit?.()   // already at the end → leave fullscreen, back to the node
        return
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); const i = idxRef.current; if (i > 0) goto(i - 1); return }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [clips.length]) // eslint-disable-line

  return (
    <div ref={wrapRef} style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', height: '100%', maxWidth: '177.78vh', maxHeight: '100vh', aspectRatio: '16 / 9', margin: 'auto' }}>
        {cur && <SlidePlayer key={idx + '-' + (cur.captions ? 'cc' : '')} clip={cur} autoplay muted={cur.muted === true} captions={cur.captions === true} interactive onReady={h => { handleRef.current = h }} onEnded={onEnded} />}
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
export function YTSlideshowNode({ node, ytss, currentIdx = 0, active, playing, muted, captions, selected, isDropTarget, ended, onHeaderDown, onSelect, onEnter, onEdit, onReady, onEnded, onSetIdx, onFullscreen, onReplay }) {
  const clips = ytss?.clips || []
  const idx = Math.max(0, Math.min(currentIdx, clips.length - 1))
  const cur = clips[idx] || null
  const W = 480 * (node.__scale || 1), H = 270 * (node.__scale || 1)
  const label = node.label || 'Slideshow'
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
            ? <SlidePlayer key={cur.id + (cur.captions ? '-cc' : '')} clip={cur} autoplay={!!playing && !ended} interactive={active} muted={cur.muted === true} captions={cur.captions === true} onReady={onReady} onEnded={onEnded} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8fa0d8', fontFamily: '-apple-system, sans-serif' }}>
                <Icon name="play" size={30} />
                <div style={{ fontSize: 13 }}>Empty slideshow</div>
                <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit?.() }}
                  style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>Add media…</button>
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
