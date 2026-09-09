// YouTube slideshow — a node carrying an ordered list of YouTube clips (node.ytss.clips), each with a
// trim (start/end) and a trigger (auto / after a delay / on click-or-key). Rendered as a CLEAN player
// (no YouTube chrome before/after a clip plays — a poster covers it). The inspector edits clips and
// PREVIEWS on the node itself (no separate mini-screen); trimming scrubs the node live.
//
// Built on the YouTube IFrame Player API so play/pause/seek/duration/ended are all first-class — the
// graph's arrow-key control just calls the same player handle exposed here via `onReady`.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { driveEmbedUrl, driveThumbUrl } from '../lib/gdrive'

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

// ── A slide's kind: youtube | video | audio | image | gdrive (legacy clips with a youtubeId are 'youtube') ──
export const clipKind = (c) => c?.kind || (c?.driveId ? 'gdrive' : (c?.youtubeId ? 'youtube' : (c?.src ? 'video' : 'youtube')))
// gdrive embeds are dumb iframes with no JS player API, so they're NOT time-controllable (no trim/markers).
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
  // Keep the image's canvas look: full blur, contour (edge) blur, colour tint, opacity.
  const b = clip.blur || 0, eb = clip.edgeBlur || 0, op = clip.opacity == null ? 1 : clip.opacity
  const tint = clip.tint && clip.tint.amount > 0 ? clip.tint : null
  const feather = eb > 0 ? {
    WebkitMaskImage: `linear-gradient(to right, transparent, #000 ${eb}px, #000 calc(100% - ${eb}px), transparent), linear-gradient(to bottom, transparent, #000 ${eb}px, #000 calc(100% - ${eb}px), transparent)`,
    maskImage: `linear-gradient(to right, transparent, #000 ${eb}px, #000 calc(100% - ${eb}px), transparent), linear-gradient(to bottom, transparent, #000 ${eb}px, #000 calc(100% - ${eb}px), transparent)`,
    WebkitMaskComposite: 'source-in', maskComposite: 'intersect',
  } : null
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden', ...style }}>
      <div style={{ position: 'absolute', inset: 0, background: `center/contain no-repeat url("${clip.src}")`,
        filter: b ? `blur(${b}px)` : 'none', opacity: op, ...(feather || {}) }} />
      {tint && <div style={{ position: 'absolute', inset: 0, background: tint.color, opacity: tint.amount, mixBlendMode: 'color', pointerEvents: 'none' }} />}
    </div>
  )
}

// ── Text step: a full-frame text card (headline / caption / quote). Timed exactly like an image step. ──
// Text size is in `cqh` (container-height %) so it looks identical inline on the node and fullscreen.
function TextSlide({ clip, autoplay = false, onReady, onEnded, style }) {
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
  }, [clip.text, clip.duration, clip.loop, autoplay]) // eslint-disable-line
  const align = clip.align || 'center'
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: clip.bg || '#0c0c1a', overflow: 'hidden',
      containerType: 'size', display: 'flex', alignItems: 'center', justifyContent: justify, ...style }}>
      <div style={{ maxWidth: '90%', maxHeight: '92%', overflow: 'hidden', color: clip.color || '#e8ecff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontWeight: clip.bold === false ? 400 : 600,
        fontSize: `${clip.fontSize || 9}cqh`, lineHeight: 1.25, textAlign: align, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {clip.text || 'Text'}
      </div>
    </div>
  )
}

// ── Google Drive embed: a dumb <iframe> preview. No JS player API, so no seek/trim/markers and no
// "ended" event — the show advances by click / delay only. Autoplays via the preview URL param. ──
function GDrivePlayer({ clip, autoplay = false, interactive = true, onReady, style }) {
  useEffect(() => {
    onReady?.({
      play: () => {}, pause: () => {}, seekBy: () => {}, seekTo: () => {},
      mute: () => {}, unMute: () => {}, setRate: () => {},
      duration: () => 0, time: () => 0, playing: () => true,
    })
  }, [clip.driveId]) // eslint-disable-line
  return <iframe src={driveEmbedUrl(clip.driveId) + (autoplay ? '?autoplay=1' : '')}
    style={{ width: '100%', height: '100%', border: 0, display: 'block', background: '#000', pointerEvents: interactive ? 'auto' : 'none', ...style }}
    allow="autoplay; encrypted-media" allowFullScreen title={clip.title || 'Drive video'} />
}

// ── Polymorphic slide player: dispatches to the right engine by kind, one uniform handle ──────
export function SlidePlayer({ clip, autoplay = false, muted = false, captions = false, interactive = true, coverOnPause = false, onReady, onEnded, style }) {
  const kind = clipKind(clip)
  if (kind === 'text') return <TextSlide clip={clip} autoplay={autoplay} onReady={onReady} onEnded={onEnded} style={style} />
  if (kind === 'image') return <ImageSlide clip={clip} autoplay={autoplay} onReady={onReady} onEnded={onEnded} style={style} />
  if (kind === 'gdrive') return <GDrivePlayer clip={clip} autoplay={autoplay} interactive={interactive} onReady={onReady} style={style} />
  if (kind === 'video' || kind === 'audio') return <MediaFilePlayer clip={clip} kind={kind} autoplay={autoplay} muted={muted} interactive={interactive} onReady={onReady} onEnded={onEnded} style={style} />
  return <YTPlayer clip={clip} autoplay={autoplay} muted={muted} captions={captions} loop={clip.loop} interactive={interactive} externalControl={false} coverOnPause={coverOnPause} onReady={onReady} onEnded={onEnded} style={style} />
}

// ── Dual-handle trim slider ───────────────────────────────────────────────────
// onChange(start, end, which) — `which` is 'start' | 'end', so the caller can scrub the preview to
// whichever edge is being moved.
const trimBtn = { background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 5, padding: '1px 7px', cursor: 'pointer', fontSize: 10.5, whiteSpace: 'nowrap' }
// Dual-handle trim slider over the WHOLE video (no zoom window — that made the timeline jump around and
// was more trouble than it was worth). Big, grippy handles with a wide invisible hit area so they're easy
// to grab. Live preview via onScrub (drag) / onLoop (release).
function TrimSlider({ start, end, max, playhead, onChange, onScrub, onLoop }) {
  const trackRef = useRef(null)
  const [dragging, setDragging] = useState(null)   // 'start' | 'end' | null (which handle is held)
  const M = Math.max(max || 1, 1)
  const s = Math.max(0, Math.min(start || 0, M)), e = Math.min(M, (end && end > s) ? end : M)
  const stateRef = useRef({ s, e, M })
  stateRef.current = { s, e, M }

  // Snap to 0.1s. Bounds come from the LIVE stateRef (never a stale prop) so start/end can't fight each
  // other or the preview mid-drag. The track always spans the whole video [0, M].
  const timeAtClientX = (clientX) => {
    const r = trackRef.current.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return Math.round(frac * stateRef.current.M * 10) / 10
  }
  const drag = (which) => (ev0) => {
    ev0.preventDefault(); ev0.stopPropagation()
    setDragging(which)
    const move = (ev) => {
      const t = timeAtClientX(ev.clientX)
      const { s: cs, e: ce, M: m } = stateRef.current
      if (which === 'start') { const nv = Math.max(0, Math.min(t, ce - 0.1)); onChange(nv, ce, 'start'); onScrub?.(nv, 'start') }
      else { const nv = Math.min(m, Math.max(t, cs + 0.1)); onChange(cs, nv, 'end'); onScrub?.(nv, 'end') }
    }
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      setDragging(null)
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

  const pct = (t) => Math.max(0, Math.min(1, t / M)) * 100
  const sPct = pct(s), ePct = pct(e)
  const phPct = (playhead != null && playhead >= -0.001 && playhead <= M + 0.001) ? pct(playhead) : null
  const HIT = 22   // half-width of the invisible grab area around each handle (px) — easy to catch
  return (
    <div style={{ margin: '4px 8px 2px' }}>
      <div ref={trackRef} onMouseDown={seekAt} style={{ position: 'relative', height: 34, cursor: 'pointer' }}>
        <div style={{ position: 'absolute', top: 15, left: 0, right: 0, height: 4, borderRadius: 2, background: '#2a2f47' }} />
        <div style={{ position: 'absolute', top: 15, left: `${sPct}%`, width: `${Math.max(0, ePct - sPct)}%`, height: 4, borderRadius: 2, background: '#5b6af0' }} />
        {phPct != null && (
          <div style={{ position: 'absolute', top: 6, left: `calc(${phPct}% - 1px)`, width: 2, height: 22, borderRadius: 1, background: '#ffd166', boxShadow: '0 0 5px rgba(255,209,102,0.9)', pointerEvents: 'none', zIndex: 2 }} />
        )}
        {[['start', sPct], ['end', ePct]].map(([w, p]) => (
          // Wide, tall, invisible hit area (easy to grab) wrapping a bigger visible knob with a grip.
          <div key={w} onMouseDown={drag(w)} title={w === 'start' ? 'Drag to set the start' : 'Drag to set the end'}
            style={{ position: 'absolute', top: 0, left: `calc(${p}% - ${HIT}px)`, width: HIT * 2, height: 34,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'ew-resize', zIndex: 3 }}>
            <div style={{ width: 16, height: 26, borderRadius: 5, background: dragging === w ? '#eef1ff' : '#c5d0ff',
              border: '1.5px solid #5b6af0', boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2.5 }}>
              <span style={{ width: 1.5, height: 12, background: '#5b6af0', borderRadius: 1, opacity: 0.75 }} />
              <span style={{ width: 1.5, height: 12, background: '#5b6af0', borderRadius: 1, opacity: 0.75 }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10.5, color: '#8fa0d8', marginTop: 3 }}>
        <span>{fmtTime(s)}–{fmtTime(e)}</span>
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
// A downward-pointing triangle grip that sits above the track and points at the marker position.
const TriGrip = ({ left, color, onMouseDown, title, dim }) => (
  <div onMouseDown={onMouseDown} title={title}
    style={{ position: 'absolute', top: -1, left: `calc(${left}% - 6px)`, width: 0, height: 0,
      borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: `9px solid ${color}`,
      cursor: 'ew-resize', pointerEvents: 'auto', zIndex: 4, opacity: dim ? 0.85 : 1,
      filter: dim ? 'none' : 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }} />
)
function MarkersEditor({ markers = [], max, getTime, playhead, onScrub, onChange, start, end, onTrim }) {
  const trackRef = useRef(null)
  const [sel, setSel] = useState(null)   // index of the marker whose numeric fields are shown
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
    setSel((markers || []).length)   // select the new one so its fields show immediately
  }
  // Trim (start/end) is drawn on this SAME track when onTrim is provided — one timeline, not two.
  const hasTrim = typeof onTrim === 'function'
  const ts = Math.max(0, Math.min(start || 0, M)), te = Math.min(M, (end && end > ts) ? end : M)
  const trimRef = useRef({ ts, te }); trimRef.current = { ts, te }
  const dragTrim = (which) => (ev0) => {
    ev0.preventDefault(); ev0.stopPropagation(); setSel(null)
    const move = ev => {
      const r = trackRef.current.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      const t = snap(frac * M)
      const { ts: cs, te: ce } = trimRef.current
      if (which === 'start') { const nv = Math.max(0, Math.min(t, ce - 0.1)); onTrim(nv, ce >= M ? 0 : ce); onScrub?.(nv, 'start') }
      else { const nv = Math.min(M, Math.max(t, cs + 0.1)); onTrim(cs, nv >= M ? 0 : nv); onScrub?.(nv, 'end') }
    }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  // which: 's' = move start edge, 'e' = move end edge, 'move' = slide the whole cut (keeps its width).
  const dragHandle = (i, which) => (ev0) => {
    ev0.preventDefault(); ev0.stopPropagation(); setSel(i)
    const r0 = trackRef.current.getBoundingClientRect()
    const startX = ev0.clientX
    const orig = stateRef.current.markers[i]
    const width = Math.abs((orig.e ?? orig.s) - orig.s)
    let moved = false
    const move = ev => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true
      const r = trackRef.current?.getBoundingClientRect() || r0
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      const t = snap(frac * stateRef.current.M)
      onChange(stateRef.current.markers.map((m, j) => {
        if (j !== i) return m
        if (which === 's') return { ...m, s: Math.min(t, m.e) }
        if (which === 'e') return { ...m, e: Math.max(t, m.s) }
        // 'move' — slide the whole cut, keeping its width, clamped to [0, M]
        let s = Math.max(0, Math.min(stateRef.current.M - width, snap(t - width / 2)))
        return { ...m, s, e: snap(s + width) }
      }))
    }
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      if (moved) commit(stateRef.current.markers)   // a plain click just selects (handled by setSel above)
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  // Click empty track → scrub the preview there (and deselect any marker).
  const onTrackDown = (ev) => { setSel(null); if (ev.button === 0) onScrub?.(snap((Math.max(0, Math.min(1, (ev.clientX - trackRef.current.getBoundingClientRect().left) / trackRef.current.getBoundingClientRect().width))) * M), 'seek') }
  const TimeField = ({ value, onCommit, title }) => (
    <input defaultValue={fmtTime(value, 1)} key={value} title={title}
      onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = fmtTime(value, 1); e.currentTarget.blur() } }}
      onBlur={e => { const v = parseTime(e.target.value); if (v == null) { e.target.value = fmtTime(value, 1); return } onCommit(snap(v)) }}
      style={{ width: 54, background: '#0f0f22', border: '1px solid #2d3a6a', borderRadius: 5, color: '#dbe4ff', fontSize: 11.5, padding: '2px 4px', outline: 'none', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }} />
  )
  const iconBtn = { background: 'transparent', border: '1px solid #2d3a6a', color: '#aeb8ff', borderRadius: 5, padding: '2px 6px', cursor: 'pointer', fontSize: 11, lineHeight: 1.5, whiteSpace: 'nowrap' }
  const phPct = playhead != null && playhead >= 0 && playhead <= M ? pct(playhead) : null
  const selM = sel != null ? markers[sel] : null
  const H = 26   // full marker height — the middle of a cut is this tall, same as the edges
  const tsPct = pct(ts), tePct = pct(te)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {/* One timeline: trim region + markers + playhead. Drag triangle grips to move marker edges, drag a
          cut's body to slide it, drag the blue brackets to trim. Click empty track to scrub. */}
      <div ref={trackRef} onMouseDown={onTrackDown}
        style={{ position: 'relative', height: H + 12, flex: 1, minWidth: 240, cursor: 'pointer' }}>
        <div style={{ position: 'absolute', top: 9 + H / 2 - 2, left: 0, right: 0, height: 4, borderRadius: 2, background: '#2a3050' }} />
        {/* Trim: shade the parts OUTSIDE [start,end], and paint the kept span blue. */}
        {hasTrim && <>
          {tsPct > 0 && <div style={{ position: 'absolute', top: 9, left: 0, width: `${tsPct}%`, height: H, background: 'rgba(6,6,18,0.6)', borderRadius: '3px 0 0 3px', pointerEvents: 'none' }} />}
          {tePct < 100 && <div style={{ position: 'absolute', top: 9, left: `${tePct}%`, right: 0, height: H, background: 'rgba(6,6,18,0.6)', borderRadius: '0 3px 3px 0', pointerEvents: 'none' }} />}
          <div style={{ position: 'absolute', top: 9 + H / 2 - 2, left: `${tsPct}%`, width: `${Math.max(0, tePct - tsPct)}%`, height: 4, borderRadius: 2, background: '#5b6af0', pointerEvents: 'none' }} />
        </>}
        {phPct != null && <div style={{ position: 'absolute', top: 9, left: `calc(${phPct}% - 1px)`, width: 2, height: H, borderRadius: 1, background: '#ffd166', boxShadow: '0 0 5px rgba(255,209,102,0.9)', pointerEvents: 'none', zIndex: 4 }} />}
        {markers.map((m, i) => {
          const a = pct(Math.min(m.s, m.e)), bb = pct(Math.max(m.s, m.e)); const wide = isCut(m)
          const on = i === sel
          const stopCol = m.stop ? '#ffb454' : '#8a94c0'
          return (
            <div key={m.id || i} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {wide
                // Cut: a full-height band. Its body is the MOVE grip (same height as the edges).
                ? <div onMouseDown={dragHandle(i, 'move')} title={m.stop ? 'Cut + pause — drag to slide' : 'Drag to slide this cutout'}
                    style={{ position: 'absolute', top: 9, left: `${a}%`, width: `${Math.max(0.4, bb - a)}%`, height: H, borderRadius: 3,
                      background: m.stop ? 'rgba(255,180,84,0.28)' : 'rgba(248,113,113,0.34)',
                      border: `1px solid ${m.stop ? '#ffb454' : '#f87171'}`, boxShadow: on ? '0 0 0 1.5px #c5d0ff' : 'none',
                      cursor: 'grab', pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    {m.stop && <span style={{ fontSize: 13, lineHeight: 1, color: '#ffcf8a', pointerEvents: 'none' }}>⏸</span>}
                  </div>
                // Stop line: a thin vertical bar (always a pause — no icon needed).
                : <div onMouseDown={dragHandle(i, 'move')} title="Drag to move this stop"
                    style={{ position: 'absolute', top: 9, left: `calc(${a}% - 2px)`, width: 4, height: H, borderRadius: 2,
                      background: stopCol, boxShadow: on ? '0 0 0 1.5px #c5d0ff' : '0 0 4px rgba(255,180,84,0.7)',
                      cursor: 'grab', pointerEvents: 'auto' }} />}
              {/* Triangle grips pointing down at the track */}
              <TriGrip left={a} color={wide ? (m.stop ? '#ffb454' : '#f87171') : stopCol} onMouseDown={dragHandle(i, 's')} title="Drag the start" dim={!on} />
              {wide && <TriGrip left={bb} color="#f87171" onMouseDown={dragHandle(i, 'e')} title="Drag the end" dim={!on} />}
            </div>
          )
        })}
        {/* Trim brackets — blue, at the BOTTOM edge so they read apart from the marker triangles up top. */}
        {hasTrim && [['start', tsPct], ['end', tePct]].map(([w, p]) => (
          <div key={w} onMouseDown={dragTrim(w)} title={w === 'start' ? 'Trim start' : 'Trim end'}
            style={{ position: 'absolute', bottom: 0, left: `calc(${p}% - 5px)`, width: 10, height: 13, background: '#5b6af0', border: '1px solid #8090ff',
              borderRadius: w === 'start' ? '0 0 0 4px' : '0 0 4px 0', cursor: 'ew-resize', pointerEvents: 'auto', zIndex: 5 }} />
        ))}
      </div>
      {/* Selected-marker inline editor (when one is selected) + an always-visible, evident Add button. */}
      {selM && (() => {
        const cs = Math.min(selM.s, selM.e), ce = Math.max(selM.s, selM.e); const wide = isCut(selM)
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#8fa0d8' }}>
            <span style={{ color: wide ? '#ffb0c0' : '#ffcf8a', fontWeight: 600, whiteSpace: 'nowrap' }}>{wide ? `${selM.stop ? '⏸✂' : '✂'} ${fmtTime(ce - cs, 1)}` : '⏸ stop'}</span>
            <TimeField value={cs} title="Start (m:ss.s)" onCommit={v => setM(sel, { s: Math.min(v, ce) })} />
            {getTime && <button style={iconBtn} title="Set start to the playhead" onClick={() => setM(sel, { s: Math.min(snap(getTime()), ce) })}>⇤</button>}
            <span style={{ color: '#7c86ad' }}>–</span>
            <TimeField value={ce} title="End (m:ss.s) — later than start = a cutout" onCommit={v => setM(sel, { e: Math.max(v, cs) })} />
            {getTime && <button style={iconBtn} title="Set end to the playhead" onClick={() => setM(sel, { e: Math.max(snap(getTime()), cs) })}>⇥</button>}
            {onScrub && <button style={iconBtn} title="Preview from just before this marker" onClick={() => onScrub(Math.max(0, cs - 1), 'seek')}>▷</button>}
            <button title={wide ? 'Also pause here until → is pressed' : 'Stop point'} onClick={() => setM(sel, { stop: !selM.stop })}
              style={{ background: selM.stop ? '#3a2c10' : 'transparent', border: `1px solid ${selM.stop ? '#8a6a2f' : '#2d3a6a'}`, color: selM.stop ? '#ffcf8a' : '#7d84a4', borderRadius: 5, padding: '2px 8px', cursor: 'pointer', fontSize: 11, fontWeight: selM.stop ? 700 : 500, whiteSpace: 'nowrap' }}>⏸</button>
            <button onClick={() => { commit(markers.filter((_, j) => j !== sel)); setSel(null) }} style={{ ...trimBtn, color: '#f0a0a0', borderColor: '#5a2a3a', padding: '2px 7px' }}>✕</button>
          </div>
        )
      })()}
      <button onClick={addMarker} title="Drop a stop marker at the playhead — drag its right edge to widen it into a cut"
        style={{ background: '#232a5c', border: '1px solid #4a5bb8', color: '#dbe4ff', borderRadius: 6, padding: '5px 11px', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>＋ Add marker</button>
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
export function YTSlideshowInspector({ clips, anchor, onChange, onClose, onExtract, preview, fullscreen, onToggleFullscreen, transition = 'fade', fadeMs = 1000, onSetTransition, onSetFadeMs, sound, onToggleSound, captions, onToggleCaptions, onUpload, onPickDrive, onReplaceClipFile }) {
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
  const addText = () => {
    onChange([...clips, { id: uid(), kind: 'text', text: 'New text', title: 'Text', trigger: 'click', duration: 5,
      bg: '#0c0c1a', color: '#e8ecff', fontSize: 9, align: 'center' }])
    setSel(clips.length)
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
  useEffect(() => {
    const t = setInterval(() => {
      setCurT(preview?.time?.() || 0)
      // Keep the duration fresh: YouTube often reports it late, and the one-shot poll can miss it — a stale
      // 0 duration is what made the timeline scale to the 30s floor and the playhead stop halfway.
      const d = preview?.duration?.() || 0
      if (d) setDur(prev => (Math.abs(d - prev) > 0.4 ? d : prev))
    }, 120)
    return () => clearInterval(t)
  }, [preview])

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
  // Once we know the real duration, the timeline scales to IT (so the playhead reaches the true end).
  // Only before duration is known do we fall back to a 30s working width.
  const max = dur > 0 ? Math.max(dur, cur?.end || 0) : Math.max(cur?.end || 0, curT || 0, 30)
  const k = cur ? clipKind(cur) : null, timed = cur ? isTimeMedia(cur) : false
  // FOOTER layout: a full-width bar docked to the bottom so the timeline gets the whole screen width.
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, maxHeight: '46vh', background: '#12122a', boxShadow: '0 -10px 40px rgba(0,0,0,0.55)', borderTop: '1px solid #2d3a6a', zIndex: 500, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: '-apple-system, sans-serif' }}
      onMouseDown={e => e.stopPropagation()}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderBottom: '1px solid #23234a' }}>
        <div style={{ color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>Slideshow editor</div>
        {cur && isTimeMedia(cur) && <IconBtn name={previewPlaying ? 'pause' : 'play'} title={previewPlaying ? 'Pause preview' : 'Play preview'} onClick={togglePreview} size={24} />}
        <span style={{ color: '#6a7290', fontSize: 11 }}>← → preview clips · space play/pause</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#c5d0ff', fontSize: 12, cursor: 'pointer', marginLeft: 6 }}>
          <input type="checkbox" checked={!!fullscreen} onChange={e => onToggleFullscreen?.(e.target.checked)} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Play in fullscreen
        </label>
        {/* Global audio master: off → the whole slideshow is muted (overrides each step's own Sound). */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#c5d0ff', fontSize: 12, cursor: 'pointer', marginLeft: 6 }} title="Master audio for the whole slideshow (off mutes every step)">
          <input type="checkbox" checked={sound !== false} onChange={e => onToggleSound?.(e.target.checked)} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Sound
        </label>
        {/* Transition between clips: fade (with a global duration) or a hard cut. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#c5d0ff', fontSize: 12, marginLeft: 6 }}>
          Transition
          <select value={transition} onChange={e => onSetTransition?.(e.target.value)} style={{ background: '#0f0f22', border: '1px solid #2d3a6a', color: '#dbe4ff', borderRadius: 5, fontSize: 12, padding: '2px 5px', outline: 'none' }}>
            <option value="fade">Fade</option>
            <option value="cut">Cut</option>
          </select>
        </label>
        {transition !== 'cut' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#8fa0d8', fontSize: 12 }}>
            <input type="number" min="0" step="0.1" value={((fadeMs ?? 1000) / 1000)}
              onChange={e => { const s = parseFloat(e.target.value); if (!isNaN(s)) onSetFadeMs?.(Math.max(0, Math.round(s * 1000))) }}
              style={{ width: 46, background: '#0f0f22', border: '1px solid #2d3a6a', color: '#dbe4ff', borderRadius: 5, fontSize: 12, padding: '2px 5px', outline: 'none', textAlign: 'center' }} /> s
          </label>
        )}
        <span style={{ flex: 1 }} />
        <IconBtn name="close" title="Close" onClick={onClose} tone="ghost" size={24} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '7px 14px 10px', overflowY: 'auto' }}>
        {/* Top row: horizontal clips strip + the selected clip's quick controls */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div ref={rowsRef} style={{ display: 'flex', gap: 6, overflowX: 'auto', flex: 1, paddingBottom: 4, minHeight: 52 }}>
            {clips.map((c, i) => {
              const ck = clipKind(c)
              const thumbSrc = ck === 'youtube' ? ytThumb(c.youtubeId) : (ck === 'gdrive' ? driveThumbUrl(c.driveId) : (ck === 'image' ? c.src : null))
              return (
                <div key={c.id} data-cliprow onMouseDown={rowDrag(i)} title={c.title || ck}
                  style={{ position: 'relative', flex: '0 0 auto', width: 108, borderRadius: 7, cursor: 'grab', overflow: 'hidden',
                    opacity: dragIdx === i ? 0.4 : 1, background: i === sel ? '#1c2148' : '#0e0e1c',
                    borderLeft: `2px solid ${dropIdx === i && dragIdx != null ? '#5b6af0' : 'transparent'}`,
                    outline: i === sel ? '1.5px solid #5b6af0' : '1px solid #23234a' }}>
                  {thumbSrc
                    ? <img src={thumbSrc} alt="" width={108} height={40} style={{ objectFit: 'cover', display: 'block', background: '#000' }} />
                    : ck === 'text'
                    ? <div style={{ width: 108, height: 40, background: c.bg || '#0c0c1a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.color || '#e8ecff', fontSize: 10, fontWeight: 600, padding: '0 5px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{(c.text || 'Text').split('\n')[0].slice(0, 22) || 'Text'}</div>
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
              {onPickDrive && <button onClick={onPickDrive} title="Search your Google Drive for a video" style={{ background: 'transparent', border: '1px dashed #3a4a8a', color: '#aeb8ff', borderRadius: 6, padding: '5px', cursor: 'pointer', fontSize: 11 }}>🔍 Google Drive…</button>}
              <button onClick={addText} title="Add a text step" style={{ background: 'transparent', border: '1px dashed #3a4a8a', color: '#aeb8ff', borderRadius: 6, padding: '5px', cursor: 'pointer', fontSize: 11 }}>T Add text…</button>
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
              {(k === 'image' || k === 'text') && (
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

        {/* One full-width timeline for the selected clip: blue = kept span (trim), amber line = pause,
            wide band = cut (⏸ inside = a cut that also pauses). Numeric trim fields sit alongside. */}
        {cur && timed && (k === 'youtube' || k === 'video') && (() => {
          const mk = resolveMarkers(cur)
          return (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 2, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: '#aeb8ff', fontSize: 11, whiteSpace: 'nowrap', paddingTop: 8 }}
                title="Blue bar = the kept range (trim). Amber line = pause until →. Wide band = a cut (skipped); a ⏸ inside means it also pauses.">◆ Timeline</span>
              <div style={{ flex: 1, minWidth: 260 }}>
                <MarkersEditor markers={mk} max={max} start={cur.start || 0} end={cur.end || 0} onTrim={onTrimChange}
                  getTime={() => preview?.time?.() || 0} playhead={curT} onScrub={scrubTo}
                  onChange={markers => patch(sel, { markers: markers.length ? markers : undefined, cuts: undefined })} />
              </div>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#8fa0d8', paddingTop: 6 }}>
                <span style={{ color: '#7c86ad' }}>trim</span>
                <input style={{ ...inp, width: 54 }} defaultValue={fmtTime(cur.start || 0)} key={'s' + cur.id + (cur.start || 0)}
                  onBlur={e => { const v = parseTime(e.target.value); if (v != null) { patch(sel, { start: v }); preview?.seek?.(v); preview?.play?.() } }} />
                <span>–</span>
                <input style={{ ...inp, width: 54 }} defaultValue={cur.end ? fmtTime(cur.end) : ''} placeholder={fmtTime(max)} key={'e' + cur.id + (cur.end || 0)}
                  onBlur={e => { const v = parseTime(e.target.value); patch(sel, { end: v || 0 }); if (v != null) preview?.seek?.(v) }} />
              </span>
            </div>
          )
        })()}
        {/* Audio: just a trim slider (no visual frame / markers). */}
        {cur && timed && k === 'audio' && <>
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
        </>}
        {/* Text step editor: the text itself + look (colour, background, size, alignment). */}
        {cur && k === 'text' && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 4, flexWrap: 'wrap' }}>
            <textarea value={cur.text || ''} onChange={e => patch(sel, { text: e.target.value })}
              onMouseDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} placeholder="Type the text…" rows={3}
              style={{ flex: 1, minWidth: 300, background: '#0f0f22', border: '1px solid #2d3a6a', color: '#e8ecff', borderRadius: 6, fontSize: 14, padding: '8px 10px', outline: 'none', resize: 'vertical', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11.5, color: '#8fa0d8', minWidth: 210 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>Text
                  <input type="color" value={cur.color || '#e8ecff'} onChange={e => patch(sel, { color: e.target.value })} style={{ width: 26, height: 20, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} /></label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>Background
                  <input type="color" value={cur.bg || '#0c0c1a'} onChange={e => patch(sel, { bg: e.target.value })} style={{ width: 26, height: 20, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} /></label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>Size</span>
                <button onClick={() => patch(sel, { fontSize: Math.max(3, (cur.fontSize || 9) - 1) })} style={trimBtn}>−</button>
                <span style={{ minWidth: 28, textAlign: 'center', color: '#c5d0ff' }}>{cur.fontSize || 9}</span>
                <button onClick={() => patch(sel, { fontSize: Math.min(40, (cur.fontSize || 9) + 1) })} style={trimBtn}>+</button>
                <span style={{ marginLeft: 8 }}>Align</span>
                {['left', 'center', 'right'].map(a => (
                  <button key={a} onClick={() => patch(sel, { align: a })}
                    style={{ ...trimBtn, width: 28, background: (cur.align || 'center') === a ? '#2a3358' : 'transparent', color: (cur.align || 'center') === a ? '#eef1ff' : '#aeb8ff' }}>
                    {a === 'left' ? '⯇' : a === 'right' ? '⯈' : '≡'}</button>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#c5d0ff' }}>
                <input type="checkbox" checked={cur.bold !== false} onChange={e => patch(sel, { bold: e.target.checked })} style={{ accentColor: '#5b6af0', width: 14, height: 14 }} /> Bold</label>
            </div>
          </div>
        )}
        {!clips.length && <div style={{ color: '#7080a0', fontSize: 12, padding: 8 }}>No steps yet. Paste a YouTube link, upload media, or add text above.</div>}
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
    const t = setInterval(() => {
      setCurT(getTime() || 0)
      const d = getDuration?.() || 0
      if (d) setDur(prev => (Math.abs(d - prev) > 0.4 ? d : prev))
    }, 120)
    return () => clearInterval(t)
  }, [hasVideo, getTime, getDuration])
  const max = dur > 0 ? Math.max(dur, video.end || 0) : Math.max(video.end || 0, curT || 0, 30)
  const inp = { background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 6, padding: '5px 7px', fontSize: 12, outline: 'none', width: 62, textAlign: 'center' }
  const row = { display: 'flex', alignItems: 'center', gap: 8, color: '#c5d0ff', fontSize: 12.5 }
  // Bottom full-width footer, matching the slideshow editor.
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, maxHeight: '46vh', background: '#12122a', boxShadow: '0 -10px 40px rgba(0,0,0,0.55)', borderTop: '1px solid #2d3a6a', zIndex: 500, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: '-apple-system, sans-serif' }}
      onMouseDown={e => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '7px 14px', borderBottom: '1px solid #23234a', flex: '0 0 auto' }}>
        <div style={{ flex: 1, color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>{isFile ? 'Video' : 'YouTube video'}</div>
        <IconBtn name="close" title="Close" onClick={onClose} tone="ghost" size={26} />
      </div>
      <div style={{ padding: '8px 14px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '10px 22px', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
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
        {/* Trim + markers on ONE timeline (blue = kept span; amber line = pause; wide = cut; ⏸ = cut that pauses) */}
        {hasVideo && <>
          {(() => { const mk = resolveMarkers(video); return (
            <div style={{ flexBasis: '100%', width: '100%', minWidth: 0 }}>
              <MarkersEditor markers={mk} max={max} start={video.start || 0} end={video.end || 0} onTrim={(s, e) => onPatch({ start: s, end: e >= max ? 0 : e })}
                getTime={getTime} playhead={curT} onScrub={onScrubTime} onChange={markers => onPatch({ markers: markers.length ? markers : undefined, cuts: undefined })} />
            </div>
          ) })()}
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
export function YTFullscreenPlayer({ clips = [], startIndex = 0, muted = false, sound = true, captions = false, transition = 'fade', fadeMs = 1000, presenting = false, onExit, onReplayDone }) {
  const wrapRef = useRef(null)
  const handleRef = useRef(null)
  const [idx, setIdx] = useState(startIndex)
  const [ended, setEnded] = useState(false)
  const idxRef = useRef(startIndex); idxRef.current = idx
  const endedRef = useRef(false); endedRef.current = ended
  const advTimer = useRef(null)
  const cur = clips[idx] || null
  // Image→image crossfade underlay (mirrors the on-canvas node).
  const doFade = transition !== 'cut'
  const prevClipRef = useRef(cur)
  const [underlay, setUnderlay] = useState(null)
  useLayoutEffect(() => {   // set the underlay BEFORE paint so no black frame flashes between clips
    const before = prevClipRef.current
    prevClipRef.current = cur
    if (doFade && before && cur && before.id !== cur.id && clipKind(before) === 'image') {
      setUnderlay(before)
      const t = setTimeout(() => setUnderlay(null), fadeMs)
      return () => clearTimeout(t)
    }
    setUnderlay(null)
  }, [cur?.id]) // eslint-disable-line

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
      <div style={{ position: 'relative', width: '100%', height: '100%', maxWidth: '177.78vh', maxHeight: '100vh', aspectRatio: '16 / 9', margin: 'auto' }}>
        {underlay && <div style={{ position: 'absolute', inset: 0 }}><ImageSlide clip={underlay} /></div>}
        {cur && <div key={'fade' + idx} style={{ position: 'absolute', inset: 0, animation: doFade ? `ytssFadeIn ${fadeMs}ms ease both` : 'none' }}>
          <SlidePlayer key={idx + '-' + (cur.captions ? 'cc' : '')} clip={cur} autoplay muted={cur.muted === true || sound === false} captions={cur.captions === true} interactive coverOnPause onReady={h => { handleRef.current = h }} onEnded={onEnded} />
        </div>}
      </div>
      {ended && !presenting && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: 'rgba(6,6,16,0.55)', fontFamily: '-apple-system, sans-serif' }}>
          <button onClick={() => goto(0, true)} title="Replay" style={{ width: 76, height: 76, borderRadius: '50%', background: 'rgba(18,18,42,0.85)', border: '2px solid #5b6af0', color: '#dbe2ff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="replay" size={34} /></button>
          <div style={{ color: '#aab4dd', fontSize: 13 }}>End of slideshow — replay, or press → to return</div>
        </div>
      )}
      {/* Controls: prev / next / exit (hidden during a presentation — smooth, no chrome; Esc still exits) */}
      {!presenting && (<>
        <div style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 12, alignItems: 'center' }}>
          <IconBtn name="prev" title="Previous" size={40} onClick={() => { const i = idxRef.current; if (i > 0) goto(i - 1, true) }} />
          <div style={{ color: '#c5d0ff', fontSize: 13, minWidth: 54, textAlign: 'center', fontFamily: '-apple-system, sans-serif' }}>{idx + 1} / {clips.length}</div>
          <IconBtn name="next" title="Next" size={40} onClick={() => { const i = idxRef.current; if (i < clips.length - 1) goto(i + 1, true); else if (!endedRef.current) { setEnded(true); handleRef.current?.pause?.() } else onExit?.() }} />
        </div>
        <div style={{ position: 'absolute', top: 18, right: 18 }}>
          <IconBtn name="close" title="Exit fullscreen (Esc)" size={40} onClick={() => onExit?.()} />
        </div>
      </>)}
    </div>
  )
}

// ── On-canvas node: a clean player showing the current clip ───────────────────
// `active` = the ytss has been "entered" (arrows drive it). `currentIdx` is controlled by the parent so
// arrow-nav can drive it; onReady exposes the live player handle for seek/play. Drag via the whole card.
export function YTSlideshowNode({ node, ytss, currentIdx = 0, active, playing, muted, captions, selected, isDropTarget, ended, editing = false, presenting = false, onHeaderDown, onSelect, onEnter, onEdit, onReady, onEnded, onSetIdx, onFullscreen, onReplay, onRename, onSetScale, zoomK = 1 }) {
  const [editingTitle, setEditingTitle] = useState(false)
  const clips = ytss?.clips || []
  const idx = Math.max(0, Math.min(currentIdx, clips.length - 1))
  const cur = clips[idx] || null
  // Image→image crossfade: hold the PREVIOUS clip as a static underlay while the new clip fades in on top,
  // so one image dissolves into the next (not through black). Only images can be held statically; a
  // video/gdrive we're leaving can't, so those fall back to fade-through-black.
  const fadeMs = ytss?.fadeMs ?? 1000
  const doFade = (ytss?.transition || 'fade') !== 'cut'
  const prevClipRef = useRef(cur)
  const [underlay, setUnderlay] = useState(null)
  useLayoutEffect(() => {   // set the underlay BEFORE paint so no black frame flashes between clips
    const before = prevClipRef.current
    prevClipRef.current = cur
    if (doFade && before && cur && before.id !== cur.id && clipKind(before) === 'image') {
      setUnderlay(before)
      const t = setTimeout(() => setUnderlay(null), fadeMs)
      return () => clearTimeout(t)
    }
    setUnderlay(null)
  }, [cur?.id]) // eslint-disable-line
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
      {/* Title above — double-click to rename. Hidden entirely while PRESENTING (no chrome/advisories). */}
      {presenting ? null : editingTitle ? (
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
        <div style={{ width: '100%', height: '100%', borderRadius: 2, overflow: 'hidden',
          // Match the free-image selection: a thin, sharp-cornered frame (dashed blue when selected).
          border: isDropTarget ? '2px solid #4ade80' : (selected ? '1.5px dashed #5b6af0' : '1px solid #2d3a6a'),
          boxShadow: isDropTarget ? '0 0 0 4px rgba(74,222,128,0.35)' : 'none', background: '#000', position: 'relative' }}>
          {cur
            ? <>
                {underlay && <div style={{ position: 'absolute', inset: 0 }}><ImageSlide clip={underlay} /></div>}
                <div key={'fade' + cur.id} style={{ position: 'absolute', inset: 0, animation: doFade ? `ytssFadeIn ${fadeMs}ms ease both` : 'none' }}>
                  <SlidePlayer key={cur.id + (cur.captions ? '-cc' : '')} clip={cur} autoplay={!!playing && !ended} interactive={active} muted={cur.muted === true || ytss?.sound === false} captions={cur.captions === true} coverOnPause={!editing} onReady={onReady} onEnded={onEnded} />
                </div>
              </>
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
          {/* End-of-slideshow: last frame + replay. Hidden while PRESENTING — there we just freeze the
              last frame (no replay chrome); going back to the slide replays it. */}
          {ended && active && !presenting && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(6,6,16,0.5)', fontFamily: '-apple-system, sans-serif' }}>
              <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onReplay?.() }} title="Replay"
                style={{ width: 54, height: 54, borderRadius: '50%', background: 'rgba(18,18,42,0.85)', border: '2px solid #5b6af0', color: '#dbe2ff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="replay" size={26} /></button>
              <div style={{ color: '#aab4dd', fontSize: 11 }}>End — replay, or → to return</div>
            </div>
          )}
          {/* Hint bar while active (never during a presentation) */}
          {active && !ended && !presenting && (
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
          {/* Square handle, matching the free-image selection handles. */}
          <rect x={-5} y={-5} width={10} height={10} fill="#fff" stroke="#5b6af0" strokeWidth={1.5} />
        </g>
      )}
    </g>
  )
}
