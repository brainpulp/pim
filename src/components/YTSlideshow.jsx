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
// Format seconds as m:ss, or m:ss.d with `dec` decimal places for frame-ish precision.
export const fmtTime = (sec, dec = 0) => {
  const total = Math.max(0, sec || 0)
  if (dec <= 0) { const s = Math.round(total); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  let whole = Math.floor(total)
  let frac = Math.round((total - whole) * 10 ** dec)
  if (frac >= 10 ** dec) { whole += 1; frac = 0 }
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${String(frac).padStart(dec, '0')}`
}
// Parse "m:ss", "m:ss.d", "ss", or "ss.d" → seconds (float). null if unparseable.
export const parseTime = (str) => {
  const t = String(str || '').trim()
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t)
  const m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (m) return (+m[1]) * 60 + parseFloat(m[2])
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
export function YTPlayer({ clip, autoplay = false, muted = false, captions = false, loop = false, interactive = true, externalControl = false, coverOnPause = false, onReady, onEnded, onStateChange, style }) {
  const coverOnPauseRef = useRef(coverOnPause); coverOnPauseRef.current = coverOnPause
  const holderRef = useRef(null)
  const playerRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [covered, setCovered] = useState(true)   // poster over the player until it actually plays
  const clipRef = useRef(clip); clipRef.current = clip
  const loopRef = useRef(loop); loopRef.current = loop
  const cbRef = useRef({}); cbRef.current = { onReady, onEnded, onStateChange }
  const waitingRef = useRef(false)         // paused at a stop marker, waiting for → / resume
  const consumedRef = useRef(new Set())    // stop-marker ids already released this playthrough
  const lastTRef = useRef(0)

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
            // Paused → re-cover with our poster so YouTube's pause/end overlay (share, watch-later,
            // related-video cards, YouTube logo) can NEVER show. Gated so the trim editor, which needs
            // to see the paused frame, is unaffected.
            if (e.data === 2 && coverOnPauseRef.current) setCovered(true)
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
    play: () => { waitingRef.current = false; try { p.playVideo() } catch { /* */ } },
    pause: () => { try { p.pauseVideo() } catch { /* */ } },
    isWaiting: () => waitingRef.current,                                   // paused at a stop marker?
    resume: () => { waitingRef.current = false; try { p.playVideo() } catch { /* */ } },   // → continue to the next marker/end
    seekBy: (d) => { try { p.seekTo(Math.max(0, (p.getCurrentTime?.() || 0) + d), true) } catch { /* */ } },
    seekTo: (t) => { if (t <= (clipRef.current?.start || 0) + 0.5) consumedRef.current.clear(); try { p.seekTo(Math.max(0, t), true) } catch { /* */ } },
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

  // Marker playback: poll currentTime, skip cut ranges, and pause at stop markers.
  useEffect(() => {
    const iv = setInterval(() => {
      const p = playerRef.current; if (!p?.getCurrentTime) return
      const markers = resolveMarkers(clipRef.current); if (!markers.length) return
      if (waitingRef.current) return   // paused at a stop → wait for resume
      let t; try { t = p.getCurrentTime() } catch { return }
      if (t < lastTRef.current - 1) consumedRef.current.clear()   // rewound/looped → stops fire again
      lastTRef.current = t
      const a = markerAction(t, markers, consumedRef.current)
      if (!a) return
      if (a.type === 'skip') { try { p.seekTo(a.to, true) } catch { /* */ } }
      else if (a.type === 'stop') { consumedRef.current.add(a.id); waitingRef.current = true; try { p.pauseVideo() } catch { /* */ } }
    }, 120)
    return () => clearInterval(iv)
  }, [])

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

// Inverse trim ("snips"): `cuts` = [{s,e}] time ranges to SKIP. During playback, if the playhead lands
// inside a cut, jump to its end. Returns the skip target time, or null if the playhead is not in a cut.
export function cutSkipTarget(t, cuts) {
  if (!cuts || !cuts.length || t == null) return null
  for (const c of cuts) {
    const s = Math.min(c.s, c.e), e = Math.max(c.s, c.e)
    if (e - s < 0.05) continue
    if (t >= s - 0.05 && t < e - 0.1) return e
  }
  return null
}

// ── Markers ─────────────────────────────────────────────────────────────────────────────────
// A marker on a clip is a range [s,e]. Its WIDTH decides whether it's a cut — there is no separate flag:
//   • a LINE (e ≈ s, zero width) is just a point on the timeline.
//   • a WIDE marker (e − s ≥ CUT_MIN) is a CUTOUT — that range is skipped during playback.
// An independent `stop` flag can be set on either: when true, playback PAUSES at `s` until → is pressed.
//   → a line + stop = a plain pause step · a wide marker = a silent cut · a wide marker + stop = pause,
//     then skip · a line without stop is inert (the editor never makes one).
// Legacy `clip.cuts` are read as wide (cut) markers so old shows keep working.
export const CUT_MIN = 0.1   // a marker at least this wide counts as a cutout
export const isCut = (m) => (Math.max(m.s, m.e) - Math.min(m.s, m.e)) >= CUT_MIN
export function resolveMarkers(clip) {
  if (clip?.markers?.length) return clip.markers
  if (clip?.cuts?.length) return clip.cuts.map((c, i) => ({ id: `cut${i}`, s: c.s, e: c.e, stop: false }))
  return []
}

// Decide what should happen at time `t`. `consumed` is a Set of stop-marker ids already released
// this playthrough (so we don't re-pause at the same stop after the user hits →).
// Returns { type:'stop', id } | { type:'skip', to } | null.
export function markerAction(t, markers, consumed) {
  if (t == null || !markers || !markers.length) return null
  const eps = 0.05
  // Stops win over cuts, so a wide-and-stop marker PAUSES before it skips. Earliest pending stop wins.
  let best = null
  for (const m of markers) {
    if (!m.stop || consumed?.has(m.id)) continue
    const s = Math.min(m.s, m.e ?? m.s)
    // A wide stop fires anywhere in its range; a line stop gets a generous 1.5s window so a fast/slow
    // poll can't overshoot it silently (consumed prevents re-firing after resume).
    const hi = isCut(m) ? Math.max(m.s, m.e) : s + 1.5
    if (t >= s - eps && t < hi - 0.05) { if (!best || s < best.s) best = { type: 'stop', id: m.id, s } }
  }
  if (best) return best
  // Then cuts (width) — any stop here is already consumed, so skipping is safe.
  for (const m of markers) {
    if (!isCut(m)) continue
    const s = Math.min(m.s, m.e), e = Math.max(m.s, m.e)
    if (t >= s - eps && t < e - 0.1) return { type: 'skip', to: e }
  }
  return null
}

// ── Native <video>/<audio> file player with a YT-compatible handle ────────────────────────────
function MediaFilePlayer({ clip, kind, autoplay = false, muted = false, interactive = true, onReady, onEnded, style }) {
  const ref = useRef(null)
  const clipRef = useRef(clip); clipRef.current = clip   // markers/cuts read live so editing them doesn't reseek
  const start = clip.start || 0
  const end = (clip.end && clip.end > start) ? clip.end : 0
  useEffect(() => {
    const el = ref.current; if (!el) return
    el.playbackRate = clip.speed || 1
    el.loop = !!clip.loop
    let ended = false, waiting = false, lastT = 0
    const consumed = new Set()
    const seekStart = () => { consumed.clear(); waiting = false; if (start) { try { el.currentTime = start } catch { /* not seekable yet */ } } }
    const onLoaded = () => { seekStart(); el.playbackRate = clip.speed || 1 }
    const onTime = () => {
      if (waiting) return
      const t = el.currentTime
      if (t < lastT - 1) consumed.clear()   // rewound/looped → stops fire again
      lastT = t
      const a = markerAction(t, resolveMarkers(clipRef.current), consumed)
      if (a) {
        if (a.type === 'skip') { try { el.currentTime = a.to } catch { /* */ } return }
        if (a.type === 'stop') { consumed.add(a.id); waiting = true; el.pause(); return }
      }
      if (end && el.currentTime >= end) {
        if (clip.loop) { try { el.currentTime = start } catch { /* */ } consumed.clear(); el.play().catch(() => {}) }
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
      play: () => { waiting = false; el.play().catch(() => {}) }, pause: () => el.pause(),
      isWaiting: () => waiting,                                        // paused at a stop marker?
      resume: () => { waiting = false; el.play().catch(() => {}) },    // → continue to the next marker/end
      seekBy: (d) => { try { el.currentTime = Math.max(start, (el.currentTime || 0) + d) } catch { /* */ } },
      seekTo: (t) => { if (t <= start + 0.5) consumed.clear(); try { el.currentTime = Math.max(0, t) } catch { /* */ } },
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
export function SlidePlayer({ clip, autoplay = false, muted = false, captions = false, interactive = true, coverOnPause = false, onReady, onEnded, style }) {
  const kind = clipKind(clip)
  if (kind === 'image') return <ImageSlide clip={clip} autoplay={autoplay} onReady={onReady} onEnded={onEnded} style={style} />
  if (kind === 'video' || kind === 'audio') return <MediaFilePlayer clip={clip} kind={kind} autoplay={autoplay} muted={muted} interactive={interactive} onReady={onReady} onEnded={onEnded} style={style} />
  return <YTPlayer clip={clip} autoplay={autoplay} muted={muted} captions={captions} loop={clip.loop} interactive={interactive} externalControl={false} coverOnPause={coverOnPause} onReady={onReady} onEnded={onEnded} style={style} />
}

// ── Dual-handle trim slider ───────────────────────────────────────────────────
// onChange(start, end, which) — `which` is 'start' | 'end', so the caller can scrub the preview to
// whichever edge is being moved.
const trimBtn = { background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 5, padding: '1px 7px', cursor: 'pointer', fontSize: 10.5, whiteSpace: 'nowrap' }
// Dual-handle trim slider. A SEPARATE zoom slider narrows the visible window for fine control on a long
// video — but the window is MANUAL: it only re-centers on the selection at the moment you change the zoom
// level. It never follows the selection on its own afterwards (that auto-follow made the view jump around
// while trimming). Live preview via onScrub (drag) / onLoop (release).
function TrimSlider({ start, end, max, playhead, onChange, onScrub, onLoop }) {
  const trackRef = useRef(null)
  const [zoom, setZoom] = useState(1)   // 1 = whole video; higher = narrower window
  const [dragging, setDragging] = useState(false)
  const M = Math.max(max || 1, 1)
  const s = Math.max(0, Math.min(start || 0, M)), e = Math.min(M, (end && end > s) ? end : M)
  const stateRef = useRef({ s, e, M })
  stateRef.current = { s, e, M }
  // The visible window [w0,w1]. Recomputed ONLY when the zoom level (or video length) changes — centered on
  // wherever the selection is at that instant — then left alone. No auto-follow while you trim.
  const [win, setWin] = useState({ w0: 0, w1: M })
  const winRef = useRef(win); winRef.current = win
  useEffect(() => {
    const { s: cs, e: ce, M: m } = stateRef.current
    if (zoom <= 1) { setWin({ w0: 0, w1: m }); return }
    const width = m / zoom
    const mid = (cs + ce) / 2
    const w0 = Math.max(0, Math.min(mid - width / 2, m - width))
    setWin({ w0, w1: w0 + width })
  }, [zoom, M])   // eslint-disable-line — intentionally NOT depending on s/e: the window must not follow the selection
  const { w0, w1 } = win
  const span = Math.max(1, w1 - w0)

  // Snap to 0.1s. All bounds come from the LIVE stateRef (never a stale prop) so start/end can't fight
  // each other or the preview mid-drag — that was the source of the erratic jumps.
  const timeAtClientX = (clientX) => {
    const r = trackRef.current.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const { w0: a, w1: b } = winRef.current
    return Math.round((a + frac * (b - a)) * 10) / 10
  }
  const drag = (which) => (ev0) => {
    ev0.preventDefault(); ev0.stopPropagation()
    setDragging(true)
    const move = (ev) => {
      const t = timeAtClientX(ev.clientX)
      const { s: cs, e: ce, M: m } = stateRef.current
      if (which === 'start') { const nv = Math.max(0, Math.min(t, ce - 0.1)); onChange(nv, ce, 'start'); onScrub?.(nv, 'start') }
      else { const nv = Math.min(m, Math.max(t, cs + 0.1)); onChange(cs, nv, 'end'); onScrub?.(nv, 'end') }
    }
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      setDragging(false)
      const { s: cs, e: ce } = stateRef.current
      onLoop?.(cs, ce)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  // Click anywhere on the track (not a handle) → seek the preview there WITHOUT changing the trim, so you
  // can scrub/preview any point, including outside the trimmed region.
  const seekAt = (ev0) => {
    if (ev0.button !== 0) return
    ev0.stopPropagation()
    onScrub?.(timeAtClientX(ev0.clientX), 'seek')
  }

  const pct = (t) => Math.max(0, Math.min(1, (t - w0) / span)) * 100
  const sPct = pct(s), ePct = pct(e)
  const zoomed = zoom > 1
  // Live playback head — where the preview currently is. Only shown when it's inside the visible window.
  const phInWin = playhead != null && playhead >= w0 - 0.001 && playhead <= w1 + 0.001
  const phPct = phInWin ? pct(playhead) : null
  return (
    <div style={{ margin: '2px 8px' }}>
      <div ref={trackRef} onMouseDown={seekAt} style={{ position: 'relative', height: 24, cursor: 'pointer' }}>
        <div style={{ position: 'absolute', top: 10, left: 0, right: 0, height: 4, borderRadius: 2, background: '#2a2f47' }} />
        {zoomed && w0 > 0 && <div style={{ position: 'absolute', top: 7, left: 0, width: 3, height: 10, borderRadius: 2, background: '#3a4a8a' }} />}
        {zoomed && w1 < M && <div style={{ position: 'absolute', top: 7, right: 0, width: 3, height: 10, borderRadius: 2, background: '#3a4a8a' }} />}
        <div style={{ position: 'absolute', top: 10, left: `${sPct}%`, width: `${Math.max(0, ePct - sPct)}%`, height: 4, borderRadius: 2, background: '#5b6af0' }} />
        {phPct != null && (
          <div style={{ position: 'absolute', top: 3, left: `calc(${phPct}% - 1px)`, width: 2, height: 18, borderRadius: 1, background: '#ffd166', boxShadow: '0 0 5px rgba(255,209,102,0.9)', pointerEvents: 'none', zIndex: 2 }} />
        )}
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

// ── Snip ("inverse trim") editor: red bands over the timeline mark ranges to SKIP during playback. ──
// Full editing surface: drag the red handles on the timeline OR punch exact in/out times in the numeric
// fields; ⇤/⇥ snap a boundary to the current playhead; ▷ previews the snip; the playhead is shown live.
// Markers editor: each marker is a range [s,e] with two independent toggles — Cut (skip it) and Stop
// (pause there until →). Punch exact m:ss.s in/out, drag the handles, ⇤/⇥ snap to the playhead, ▷ preview.
const newMarkerId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'm' + Math.random().toString(36).slice(2))
function MarkersEditor({ markers = [], max, getTime, playhead, onScrub, onChange }) {
  const trackRef = useRef(null)
  const M = Math.max(max || 1, 1)
  const stateRef = useRef({ markers, M }); stateRef.current = { markers, M }
  const pct = t => Math.max(0, Math.min(1, t / M)) * 100
  const snap = t => Math.round(Math.max(0, Math.min(M, t)) * 10) / 10   // 0.1s
  const sorted = (arr) => [...arr].sort((a, b) => Math.min(a.s, a.e) - Math.min(b.s, b.e))
  const commit = (arr) => onChange(sorted(arr))
  const setM = (i, patch) => onChange(markers.map((m, j) => j === i ? { ...m, ...patch } : m))
  const addMarker = () => {
    const at = snap(getTime?.() ?? M / 2)   // a LINE (zero width) — a stop point. Drag its right edge to widen → a cutout.
    commit([...(markers || []), { id: newMarkerId(), s: at, e: at, stop: true }])
  }
  const dragHandle = (i, which) => (ev0) => {
    ev0.preventDefault(); ev0.stopPropagation()
    const move = ev => {
      const r = trackRef.current.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      const t = snap(frac * stateRef.current.M)
      // which='s' moves the start (carrying the whole line), which='e' stretches the end (creates a cutout)
      onChange(stateRef.current.markers.map((m, j) => j !== i ? m : (which === 's' ? { ...m, s: Math.min(t, m.e) } : { ...m, e: Math.max(t, m.s) })))
    }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); commit(stateRef.current.markers) }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  const TimeField = ({ value, onCommit, title }) => (
    <input defaultValue={fmtTime(value, 1)} key={value} title={title}
      onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = fmtTime(value, 1); e.currentTarget.blur() } }}
      onBlur={e => { const v = parseTime(e.target.value); if (v == null) { e.target.value = fmtTime(value, 1); return } onCommit(snap(v)) }}
      style={{ width: 58, background: '#0f0f22', border: '1px solid #2d3a6a', borderRadius: 5, color: '#dbe4ff', fontSize: 11.5, padding: '3px 5px', outline: 'none', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }} />
  )
  const iconBtn = { background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 5, padding: '2px 6px', cursor: 'pointer', fontSize: 11, lineHeight: 1.5, whiteSpace: 'nowrap' }
  const phPct = playhead != null && playhead >= 0 && playhead <= M ? pct(playhead) : null
  return (
    <div style={{ margin: '2px 8px' }}>
      <div style={{ fontSize: 10.5, color: '#7c86ad', marginBottom: 4 }}>A <b style={{ color: '#ffcf8a' }}>line</b> = a stop; drag its right edge to widen it into a <b style={{ color: '#ffb0c0' }}>cutout</b>. Toggle ⏸ to make a cutout also pause.</div>
      <div ref={trackRef} style={{ position: 'relative', height: 26 }}>
        <div style={{ position: 'absolute', top: 11, left: 0, right: 0, height: 4, borderRadius: 2, background: '#233' }} />
        {phPct != null && <div style={{ position: 'absolute', top: 1, left: `calc(${phPct}% - 1px)`, width: 2, height: 22, borderRadius: 1, background: '#ffd166', boxShadow: '0 0 5px rgba(255,209,102,0.9)', pointerEvents: 'none', zIndex: 3 }} />}
        {markers.map((m, i) => {
          const a = pct(Math.min(m.s, m.e)), bb = pct(Math.max(m.s, m.e)); const wide = isCut(m)
          return (
            <div key={m.id || i} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {wide && <div title="Cutout — skipped on playback" style={{ position: 'absolute', top: 10, left: `${a}%`, width: `${Math.max(0, bb - a)}%`, height: 6, borderRadius: 2, background: 'rgba(248,113,113,0.4)', border: '1px solid #f87171' }} />}
              <div title={m.stop ? 'Stop point' : 'Marker'} style={{ position: 'absolute', top: 1, left: `calc(${a}% - 1px)`, width: 2, height: 24, borderRadius: 1, background: m.stop ? '#ffb454' : '#8a94c0', boxShadow: m.stop ? '0 0 4px rgba(255,180,84,0.8)' : 'none' }} />
              <div onMouseDown={dragHandle(i, 's')} title="Drag to move the marker" style={{ position: 'absolute', top: 5, left: `calc(${a}% - 6px)`, width: 5, height: 16, borderRadius: '3px 0 0 3px', background: m.stop ? '#ffb454' : '#8a94c0', cursor: 'ew-resize', pointerEvents: 'auto' }} />
              <div onMouseDown={dragHandle(i, 'e')} title="Drag right to widen into a cutout" style={{ position: 'absolute', top: 5, left: `calc(${bb}% + 1px)`, width: 5, height: 16, borderRadius: '0 3px 3px 0', background: '#f87171', cursor: 'ew-resize', pointerEvents: 'auto' }} />
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        {markers.map((m, i) => {
          const cs = Math.min(m.s, m.e), ce = Math.max(m.s, m.e); const wide = isCut(m)
          return (
            <div key={m.id || i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#8fa0d8', flexWrap: 'wrap', padding: '4px 0', borderTop: i ? '1px solid #1b2036' : 'none' }}>
              <span style={{ minWidth: 66, color: wide ? '#ffb0c0' : '#ffcf8a', fontWeight: 600 }}>{wide ? `✂ cut ${fmtTime(ce - cs, 1)}` : '⏸ stop'}</span>
              <span style={{ color: '#7c86ad' }}>at</span>
              <TimeField value={cs} title="Marker time (m:ss.s)" onCommit={v => setM(i, { s: Math.min(v, ce) })} />
              {getTime && <button style={iconBtn} title="Set to the current playhead" onClick={() => setM(i, { s: Math.min(snap(getTime()), ce) })}>⇤</button>}
              <span style={{ color: '#7c86ad' }}>–</span>
              <TimeField value={ce} title="Cutout end (m:ss.s) — set later than the start to make a cutout" onCommit={v => setM(i, { e: Math.max(v, cs) })} />
              {getTime && <button style={iconBtn} title="Set the cutout end to the current playhead" onClick={() => setM(i, { e: Math.max(snap(getTime()), cs) })}>⇥</button>}
              {onScrub && <button style={iconBtn} title="Preview: jump to just before this marker" onClick={() => onScrub(Math.max(0, cs - 1), 'seek')}>▷</button>}
              <span style={{ flex: 1, minWidth: 4 }} />
              <button title="Pause here until → is pressed" onClick={() => setM(i, { stop: !m.stop })}
                style={{ background: m.stop ? '#3a2c10' : 'transparent', border: `1px solid ${m.stop ? '#8a6a2f' : '#2d3a6a'}`, color: m.stop ? '#ffcf8a' : '#7d84a4', borderRadius: 5, padding: '2px 8px', cursor: 'pointer', fontSize: 11, fontWeight: m.stop ? 700 : 500, whiteSpace: 'nowrap' }}>⏸ Stop</button>
              <button onClick={() => commit(markers.filter((_, j) => j !== i))} style={{ ...trimBtn, color: '#f0a0a0', borderColor: '#5a2a3a' }}>✕</button>
            </div>
          )
        })}
        <button onClick={addMarker} style={{ ...trimBtn, alignSelf: 'flex-start', color: '#aeb8ff', borderColor: '#3a4a8a' }}>＋ Marker at playhead</button>
      </div>
    </div>
  )
}

// A chevron-collapsible section (used for the optional "Cuts" UI).
function Collapsible({ label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: '#9fb0e8', cursor: 'pointer', fontSize: 11.5, padding: '2px 0', width: '100%' }}>
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', display: 'inline-block' }}>▸</span>
        {label}
      </button>
      {open && <div style={{ paddingTop: 2 }}>{children}</div>}
    </div>
  )
}

// ── Inspector: clips column (drag to reorder) + trim + triggers. Preview happens on the NODE. ────
export function YTSlideshowInspector({ clips, anchor, onChange, onClose, onExtract, preview, fullscreen, onToggleFullscreen, sound, onToggleSound, captions, onToggleCaptions, onUpload, onReplaceClipFile }) {
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
  // Live playhead for the trim slider + markers timeline (polls the node preview's current time).
  const [curT, setCurT] = useState(0)
  useEffect(() => { const t = setInterval(() => setCurT(preview?.time?.() || 0), 120); return () => clearInterval(t) }, [preview])

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
      for (let k = 0; k < rows.length; k++) { const r = rows[k].getBoundingClientRect(); if (ev.clientX < r.left + r.width / 2) { to = k; break } }   // horizontal strip
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
  const k = cur ? clipKind(cur) : null, timed = cur ? isTimeMedia(cur) : false
  // FOOTER layout: a full-width bar docked to the bottom so the timeline gets the whole screen width.
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, maxHeight: '52vh', background: '#12122a', boxShadow: '0 -10px 40px rgba(0,0,0,0.55)', borderTop: '1px solid #2d3a6a', zIndex: 500, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: '-apple-system, sans-serif' }}
      onMouseDown={e => e.stopPropagation()}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderBottom: '1px solid #23234a' }}>
        <div style={{ color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>Slideshow editor</div>
        {cur && isTimeMedia(cur) && <IconBtn name={previewPlaying ? 'pause' : 'play'} title={previewPlaying ? 'Pause preview' : 'Play preview'} onClick={togglePreview} size={24} />}
        <span style={{ color: '#6a7290', fontSize: 11 }}>← → preview clips · space play/pause</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#c5d0ff', fontSize: 12, cursor: 'pointer', marginLeft: 6 }}>
          <input type="checkbox" checked={!!fullscreen} onChange={e => onToggleFullscreen?.(e.target.checked)} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Play in fullscreen
        </label>
        <span style={{ flex: 1 }} />
        <IconBtn name="close" title="Close" onClick={onClose} tone="ghost" size={24} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 14px 12px', overflowY: 'auto' }}>
        {/* Top row: horizontal clips strip + the selected clip's quick controls */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div ref={rowsRef} style={{ display: 'flex', gap: 6, overflowX: 'auto', flex: 1, paddingBottom: 4, minHeight: 52 }}>
            {clips.map((c, i) => {
              const ck = clipKind(c)
              const thumbSrc = ck === 'youtube' ? ytThumb(c.youtubeId) : (ck === 'image' ? c.src : null)
              return (
                <div key={c.id} data-cliprow onMouseDown={rowDrag(i)} title={c.title || ck}
                  style={{ position: 'relative', flex: '0 0 auto', width: 108, borderRadius: 7, cursor: 'grab', overflow: 'hidden',
                    opacity: dragIdx === i ? 0.4 : 1, background: i === sel ? '#1c2148' : '#0e0e1c',
                    borderLeft: `2px solid ${dropIdx === i && dragIdx != null ? '#5b6af0' : 'transparent'}`,
                    outline: i === sel ? '1.5px solid #5b6af0' : '1px solid #23234a' }}>
                  {thumbSrc
                    ? <img src={thumbSrc} alt="" width={108} height={40} style={{ objectFit: 'cover', display: 'block', background: '#000' }} />
                    : <div style={{ width: 108, height: 40, background: '#0e0e1c', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7d84a4', fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{ck === 'audio' ? 'Audio' : 'Video'}</div>}
                  <div style={{ padding: '2px 5px' }}>
                    <div style={{ color: '#c5d0ff', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i + 1}. {c.title || (ck === 'youtube' ? c.youtubeId : ck)}</div>
                    <div style={{ display: 'flex', gap: 1, marginTop: 1 }}>
                      <IconBtn name="copy" title="Duplicate" size={18} tone="ghost" onClick={() => dup(i)} />
                      {onExtract && <IconBtn name="extract" title="Pop out onto the canvas" size={18} tone="ghost" onClick={() => { onExtract(c); onChange(clips.filter((_, j) => j !== i)) }} />}
                      <IconBtn name="trash" title="Delete" size={18} tone="danger" onClick={() => del(i)} />
                    </div>
                  </div>
                </div>
              )
            })}
            {/* Add card */}
            <div style={{ flex: '0 0 auto', width: 150, display: 'flex', flexDirection: 'column', gap: 4, padding: 5, borderRadius: 7, border: '1px dashed #3a4a8a' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                <input value={urlInput} onChange={e => setUrlInput(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') addUrl() }}
                  placeholder="YouTube link…" style={{ ...inp, width: 'auto', flex: 1, textAlign: 'left', fontSize: 11, padding: '4px 6px' }} />
                <button onClick={addUrl} style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '0 9px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>+</button>
              </div>
              {onUpload && <button onClick={onUpload} style={{ background: 'transparent', border: '1px dashed #3a4a8a', color: '#aeb8ff', borderRadius: 6, padding: '5px', cursor: 'pointer', fontSize: 11 }}>⤒ Upload file…</button>}
            </div>
          </div>

          {/* Quick controls for the selected clip */}
          {cur && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 210, flex: '0 0 auto', fontSize: 11.5, color: '#8fa0d8' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>Advance</span>
                <select value={cur.trigger || 'click'} onChange={e => patch(sel, { trigger: e.target.value })} style={{ ...inp, width: 'auto', textAlign: 'left', flex: 1 }}>
                  <option value="click">On click / key</option>
                  <option value="auto">Automatically{timed ? ' (when it ends)' : ''}</option>
                  <option value="delay">After a delay</option>
                </select>
                {cur.trigger === 'delay' && <input style={{ ...inp, width: 46 }} defaultValue={String((cur.delayMs || 1500) / 1000)} key={'d' + cur.id}
                  onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) patch(sel, { delayMs: Math.max(0, v * 1000) }) }} title="seconds" />}
              </div>
              {k === 'image' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span>Show for</span>
                  <input style={{ ...inp, width: 48 }} defaultValue={String(cur.duration || 5)} key={'dur' + cur.id}
                    onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) patch(sel, { duration: Math.max(0.5, v) }) }} /> <span>s</span>
                </div>
              )}
              {timed && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 12px' }}>
                  {(k === 'youtube' || k === 'video') && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>Speed
                      <select value={cur.speed || 1} onChange={e => { const r = parseFloat(e.target.value); patch(sel, { speed: r }); preview?.setRate?.(r) }} style={{ ...inp, width: 'auto', textAlign: 'left' }}>
                        {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => <option key={r} value={r}>{r}×</option>)}
                      </select></span>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#c5d0ff' }}><input type="checkbox" checked={!!cur.loop} onChange={e => patch(sel, { loop: e.target.checked })} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Loop</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#c5d0ff' }}><input type="checkbox" checked={cur.muted !== true} onChange={e => { patch(sel, { muted: !e.target.checked }); if (e.target.checked) preview?.unMute?.(); else preview?.mute?.() }} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Sound</label>
                  {(k === 'youtube' || k === 'video') && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#c5d0ff' }}><input type="checkbox" checked={!!cur.captions} onChange={e => patch(sel, { captions: e.target.checked })} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> CC</label>
                  )}
                </div>
              )}
              {k === 'youtube' && onReplaceClipFile && (
                <button onClick={() => onReplaceClipFile(sel)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#183a2a', border: '1px solid #2f6a48', color: '#a7f3d0', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}>⤒ Replace with file — ad-free</button>
              )}
            </div>
          )}
        </div>

        {/* Full-width timelines for the selected clip */}
        {cur && timed && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#8fa0d8', marginTop: 2 }}>
            <span style={{ fontWeight: 600, color: '#aeb8ff', minWidth: 52 }}>Trim</span>
            <span>Start</span>
            <input style={{ ...inp, width: 58 }} defaultValue={fmtTime(cur.start || 0)} key={'s' + cur.id + (cur.start || 0)}
              onBlur={e => { const v = parseTime(e.target.value); if (v != null) { patch(sel, { start: v }); preview?.seek?.(v); preview?.play?.() } }} />
            <span>End</span>
            <input style={{ ...inp, width: 58 }} defaultValue={cur.end ? fmtTime(cur.end) : ''} placeholder={fmtTime(max)} key={'e' + cur.id + (cur.end || 0)}
              onBlur={e => { const v = parseTime(e.target.value); patch(sel, { end: v || 0 }); if (v != null) preview?.seek?.(v) }} />
          </div>
          <TrimSlider start={cur.start || 0} end={cur.end || max} max={max} playhead={curT} onChange={onTrimChange} onScrub={scrubTo} onLoop={loopSel} />
          {(k === 'youtube' || k === 'video') && (() => {
            const mk = resolveMarkers(cur)
            return <>
              <div style={{ fontWeight: 600, color: '#aeb8ff', fontSize: 11, marginTop: 4 }}>◆ Markers{mk.length ? ` (${mk.length})` : ''} <span style={{ color: '#6a7290', fontWeight: 400 }}>— stop points & cutouts</span></div>
              <MarkersEditor markers={mk} max={max} getTime={() => preview?.time?.() || 0} playhead={curT} onScrub={scrubTo} onChange={markers => patch(sel, { markers: markers.length ? markers : undefined, cuts: undefined })} />
            </>
          })()}
        </>}
        {!clips.length && <div style={{ color: '#7080a0', fontSize: 12, padding: 8 }}>No slides yet. Paste a YouTube link or upload media above.</div>}
      </div>
    </div>
  )
}

// ── Options panel for a single YouTube video node (link + trim + autoplay + sound + fullscreen) ──
export function YTVideoOptions({ video, anchor, onPatch, onClose, onPlayFullscreen, onReplaceFile, onUploadPoster, onResetPoster, onScrubTime, onLoopSel, onPreviewPause, getDuration, getTime }) {
  const [dur, setDur] = useState(0)
  const [urlInput, setUrlInput] = useState('')
  const [previewPlaying, setPreviewPlaying] = useState(true)
  const yt = video.youtubeId
  const isFile = !yt && !!video.src           // an uploaded file video (not a YouTube embed)
  const hasVideo = !!(yt || isFile)           // there's a playable clip to trim / configure
  // The preview plays on the NODE itself (via onScrub), not here — so we just poll the node player's
  // reported duration to size the trim slider.
  useEffect(() => {
    setDur(0)
    if (!hasVideo || !getDuration) return
    let n = 0
    const t = setInterval(() => { const d = getDuration() || 0; if (d) { setDur(d); clearInterval(t) } if (++n > 40) clearInterval(t) }, 300)
    return () => clearInterval(t)
  }, [hasVideo, video.src, yt, getDuration])
  // Poll the preview's current time so the trim slider can show a live playback head.
  const [curT, setCurT] = useState(0)
  useEffect(() => {
    if (!hasVideo || !getTime) return
    const t = setInterval(() => setCurT(getTime() || 0), 120)
    return () => clearInterval(t)
  }, [hasVideo, getTime])
  const max = Math.max(dur || 0, video.end || 0, 30)
  const inp = { background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 6, padding: '5px 7px', fontSize: 12, outline: 'none', width: 62, textAlign: 'center' }
  const W = 340
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800
  // Anchor the panel but never let it bleed off-screen: clamp the top so at least ~210px is visible, then
  // cap its height to the remaining space — the body scrolls inside. (The old fixed 440px assumption made
  // the now-taller panel spill off the bottom.)
  const topRaw = anchor ? Math.max(8, Math.min(anchor.y, winH - 210)) : 0
  const pos = anchor
    ? { position: 'fixed', left: Math.max(8, Math.min(anchor.x, winW - W - 8)), top: topRaw, width: W, maxHeight: winH - topRaw - 8 }
    : { position: 'fixed', top: 0, right: 0, height: '100%', width: 380 }
  const row = { display: 'flex', alignItems: 'center', gap: 8, color: '#c5d0ff', fontSize: 12.5 }
  return (
    <div style={{ ...pos, background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.55)', zIndex: 500, fontFamily: '-apple-system, sans-serif', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      onMouseDown={e => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #23234a', flex: '0 0 auto' }}>
        <div style={{ flex: 1, color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>{isFile ? 'Video' : 'YouTube video'}</div>
        <IconBtn name="close" title="Close" onClick={onClose} tone="ghost" size={26} />
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
        {hasVideo && (
          <div style={{ fontSize: 11.5, color: '#8fa0d8', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button title={previewPlaying ? 'Pause preview' : 'Play the trimmed clip on a loop'}
              onClick={() => { if (previewPlaying) { onPreviewPause?.(); setPreviewPlaying(false) } else { onLoopSel?.(video.start || 0, video.end || 0); setPreviewPlaying(true) } }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 8, border: '1px solid #5b6af0', background: '#171c3f', color: '#dbe2ff', cursor: 'pointer', padding: '5px 12px 5px 10px', fontSize: 12, fontWeight: 600, flex: '0 0 auto' }}>
              <Icon name={previewPlaying ? 'pause' : 'play'} size={13} />
              {previewPlaying ? 'Pause' : 'Play'}
            </button>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#c5d0ff' }}>{fmtTime(curT)}</span>
            <span>on the canvas</span>
          </div>
        )}
        {/* Link (YouTube only — a file video has no URL to swap) */}
        {!isFile && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={urlInput} placeholder={yt ? `youtu.be/${yt}` : 'Paste a YouTube link…'} onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { const id = parseYoutubeId(urlInput); if (id) { onPatch({ youtubeId: id }); setUrlInput('') } else alert('Not a YouTube link/ID.') } }}
              style={{ ...inp, width: 'auto', flex: 1, textAlign: 'left' }} />
            <button onClick={() => { const id = parseYoutubeId(urlInput); if (id) { onPatch({ youtubeId: id }); setUrlInput('') } else alert('Not a YouTube link/ID.') }}
              style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '0 12px', cursor: 'pointer', fontSize: 12 }}>Set</button>
          </div>
        )}
        {/* One-click ad-free: replace this YouTube embed with an uploaded video file (native player,
            no ads, no YouTube chrome). Only shown for a YouTube video; a file video is already clean. */}
        {yt && onReplaceFile && (
          <button onClick={onReplaceFile}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#183a2a', border: '1px solid #2f6a48', color: '#a7f3d0', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
            <Icon name="add" size={14} /> Replace with uploaded file <span style={{ color: '#6fae8c', fontWeight: 400 }}>— ad-free</span>
          </button>
        )}
        {/* Trim */}
        {hasVideo && <>
          <TrimSlider start={video.start || 0} end={video.end || max} max={max} playhead={curT} onChange={(s, e) => onPatch({ start: s, end: e >= max ? 0 : e })} onScrub={onScrubTime} onLoop={onLoopSel} />
          <div style={{ ...row, fontSize: 11.5, color: '#8fa0d8' }}>
            <span>Start</span>
            <input style={inp} defaultValue={fmtTime(video.start || 0)} key={'s' + (yt || 'f') + (video.start || 0)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={e => { const v = parseTime(e.target.value); if (v != null) { onPatch({ start: v }); onScrubTime?.(v, 'start') } }} />
            <span style={{ flex: 1 }} />
            <span>End</span>
            <input style={inp} defaultValue={video.end ? fmtTime(video.end) : ''} placeholder={fmtTime(max)} key={'e' + (yt || 'f') + (video.end || 0)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={e => { const v = parseTime(e.target.value); onPatch({ end: v || 0 }); onScrubTime?.(v || (video.start || 0), 'end') }} />
          </div>
          {/* Final duration — after the trim, then after the speed change. */}
          {(() => {
            const st = video.start || 0
            const en = (video.end && video.end > st) ? video.end : (dur || max)
            const speed = video.speed || 1
            const trimLen = Math.max(0, en - st)
            const finalLen = trimLen / (speed || 1)
            return (
              <div style={{ ...row, fontSize: 11.5, color: '#8fa0d8', justifyContent: 'space-between', fontVariantNumeric: 'tabular-nums' }}>
                <span>Final length: <b style={{ color: '#c5d0ff' }}>{fmtTime(trimLen)}</b><span style={{ color: '#7080a0' }}> (trim)</span></span>
                {speed !== 1 && <span>→ <b style={{ color: '#8ecbff' }}>{fmtTime(finalLen)}</b> at {speed}×</span>}
              </div>
            )
          })()}
          {/* Markers — stop points (pause until →) and cutouts (skip a range) inside the clip */}
          {(() => { const mk = resolveMarkers(video); return (
            <Collapsible label={`◆ Markers${mk.length ? ` (${mk.length})` : ''} — stop points & cutouts`} defaultOpen={mk.length > 0}>
              <MarkersEditor markers={mk} max={max} getTime={getTime} playhead={curT} onScrub={onScrubTime} onChange={markers => onPatch({ markers: markers.length ? markers : undefined, cuts: undefined })} />
            </Collapsible>
          ) })()}
        </>}
        {/* Speed */}
        {hasVideo && (
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
        {/* Poster frame for a FILE video — upload-only (we can't sample arbitrary frames here). */}
        {isFile && onUploadPoster && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11.5, color: '#8fa0d8' }}>Poster frame {video.poster ? '(custom)' : '(the first frame)'}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={onUploadPoster} style={{ background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11.5 }}>Upload image…</button>
              {video.poster && <button onClick={onResetPoster} style={{ background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11.5 }}>Remove</button>}
            </div>
          </div>
        )}
        {/* Toggles */}
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.autoplayOnZoom} onChange={e => onPatch({ autoplayOnZoom: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Autoplay on zoom / arrow-nav</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.autoplayOnSlide} onChange={e => onPatch({ autoplayOnSlide: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Autoplay on slide</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={video.muted !== true} onChange={e => onPatch({ muted: !e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Sound on</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.loop} onChange={e => onPatch({ loop: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Loop</label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.keepPlaying} onChange={e => onPatch({ keepPlaying: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Keep playing (ignore focus) <span style={{ color: '#7080a0', fontSize: 11 }}>— don't pause when deselected</span></label>
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.captions} onChange={e => onPatch({ captions: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Captions (CC) <span style={{ color: '#7080a0', fontSize: 11 }}>— if available</span></label>
        {/* When this slide is presented, jump straight to clean, chrome-free fullscreen playback. */}
        <label style={{ ...row, cursor: 'pointer' }}><input type="checkbox" checked={!!video.fullscreenOnSlide} onChange={e => onPatch({ fullscreenOnSlide: e.target.checked })} style={{ accentColor: '#5b6af0', width: 15, height: 15 }} /> Play fullscreen when presented</label>
        {/* Play fullscreen NOW — clean, chrome-free playback (poster covers any YouTube pause/end overlay). */}
        {hasVideo && onPlayFullscreen && (
          <button onClick={onPlayFullscreen} style={{ marginTop: 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
            <Icon name="full" size={15} /> Play fullscreen now
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
        if (handleRef.current?.isWaiting?.()) { handleRef.current.resume(); fsPlaying.current = true; return }   // resume from a stop marker
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
        {cur && <SlidePlayer key={idx + '-' + (cur.captions ? 'cc' : '')} clip={cur} autoplay muted={cur.muted === true} captions={cur.captions === true} interactive coverOnPause onReady={h => { handleRef.current = h }} onEnded={onEnded} />}
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
export function YTSlideshowNode({ node, ytss, currentIdx = 0, active, playing, muted, captions, selected, isDropTarget, ended, editing = false, onHeaderDown, onSelect, onEnter, onEdit, onReady, onEnded, onSetIdx, onFullscreen, onReplay, onRename, onSetScale, zoomK = 1 }) {
  const [editingTitle, setEditingTitle] = useState(false)
  const clips = ytss?.clips || []
  const idx = Math.max(0, Math.min(currentIdx, clips.length - 1))
  const cur = clips[idx] || null
  const W = 480 * (node.__scale || 1), H = 270 * (node.__scale || 1)
  const label = node.label || 'Slideshow'
  // Corner scale handle (bottom-right). Drag out to grow / in to shrink; pins the top-left. While
  // dragging, disable media pointer-events so the embedded YouTube iframe can't swallow the mouseup.
  const startScale = (e) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY, s0 = node.__scale || 1, k = zoomK || 1
    document.body.classList.add('pim-drag-nomedia')
    const move = ev => onSetScale?.(Math.max(0.4, Math.min(4, s0 + ((ev.clientX - sx) + (ev.clientY - sy)) / 2 / (k * 320))))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('pim-drag-nomedia') }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  // Green is ONLY the drop-target affordance (dragging media onto the slideshow). A playing/entered
  // slideshow (incl. during a presentation) gets a quiet neutral border — never the loud green.
  const bd = isDropTarget ? '#4ade80' : (selected ? '#5b6af0' : '#2d3a6a')
  return (
    <g transform={`translate(${node.x || 0},${node.y || 0})`} data-ytss="1" data-cardnode={node.id}
      onMouseDown={e => { if (e.button === 0 && !active) { e.stopPropagation(); onSelect?.(); onHeaderDown?.(e) } }}
      onDoubleClick={e => { e.stopPropagation(); onEnter?.() }}>
      {/* Title above — double-click to rename */}
      {editingTitle ? (
        <foreignObject x={-W / 2} y={-H / 2 - 32} width={W} height={28} style={{ overflow: 'visible' }}>
          <input autoFocus defaultValue={node.label || ''} placeholder="Slideshow name"
            onMouseDown={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = node.label || ''; e.currentTarget.blur() } }}
            onBlur={e => { onRename?.(e.currentTarget.value.trim()); setEditingTitle(false) }}
            style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center', background: '#12122a', border: '1px solid #5b6af0', color: '#eef1ff', borderRadius: 6, fontSize: 15, fontWeight: 600, padding: '3px 8px', outline: 'none', fontFamily: '-apple-system, sans-serif' }} />
        </foreignObject>
      ) : (
        <text x={0} y={-H / 2 - 10} textAnchor="middle" fontSize={15} fill={active ? '#8ecbff' : '#c5d0ff'}
          onDoubleClick={e => { if (!active) { e.stopPropagation(); onSelect?.(); setEditingTitle(true) } }}
          style={{ userSelect: 'none', fontWeight: 600, cursor: active ? 'default' : 'text' }}>
          {label}{clips.length ? `  ·  ${idx + 1}/${clips.length}` : ''}
        </text>
      )}
      {selected && !active && !editingTitle && (
        <text x={W / 2} y={-H / 2 - 10} textAnchor="start" fontSize={11} fill="#7d84a4"
          onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onSelect?.(); setEditingTitle(true) }}
          style={{ cursor: 'pointer', userSelect: 'none' }}>  ✎ rename</text>
      )}
      <foreignObject x={-W / 2} y={-H / 2} width={W} height={H} style={{ overflow: 'visible' }}>
        <div style={{ width: '100%', height: '100%', borderRadius: 10, overflow: 'hidden',
          border: `2px solid ${bd}`, boxShadow: isDropTarget ? '0 0 0 4px rgba(74,222,128,0.35)' : 'none', background: '#000', position: 'relative' }}>
          {cur
            ? <SlidePlayer key={cur.id + (cur.captions ? '-cc' : '')} clip={cur} autoplay={!!playing && !ended} interactive={active} muted={cur.muted === true} captions={cur.captions === true} coverOnPause={!editing} onReady={onReady} onEnded={onEnded} />
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
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, textAlign: 'center', color: '#aab4dd', fontSize: 10.5, pointerEvents: 'none' }}>drag anywhere to move · double-click to play · drag corner to resize</div>
          </div>
        </foreignObject>
      )}
      {/* Corner resize handle (bottom-right) — SVG so it paints on top of the video and stays clickable. */}
      {selected && !active && (
        <g transform={`translate(${W / 2},${H / 2})`} onMouseDown={startScale}
          style={{ cursor: 'nwse-resize' }} title="Drag to resize">
          <circle r={9} fill="#16162a" stroke="#5b6af0" strokeWidth={1.5} />
          <path d="M4 -4 L-4 4 M4 0 L0 4" stroke="#5b6af0" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        </g>
      )}
    </g>
  )
}
