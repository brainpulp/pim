// YouTube slideshow — a node carrying an ordered list of YouTube clips (node.ytss.clips), each with a
// trim (start/end) and a trigger (auto / after a delay / on click-or-key). Rendered as a CLEAN player
// (no YouTube chrome before/after a clip plays — a poster covers it), plus an "inspector" editor with a
// preview player, a dual-handle trim slider, min:sec punch-in, delete and reorder.
//
// Built on the YouTube IFrame Player API so play/pause/seek/duration/ended are all first-class — the
// graph's arrow-key control (Stage 2) just calls the same player handle exposed here via `onReady`.
import { useEffect, useRef, useState, useCallback } from 'react'

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
          <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'rgba(12,12,26,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.35)' }}>
            <div style={{ width: 0, height: 0, borderTop: '10px solid transparent', borderBottom: '10px solid transparent', borderLeft: '16px solid #fff', marginLeft: 4 }} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Dual-handle trim slider ───────────────────────────────────────────────────
function TrimSlider({ start, end, max, onChange }) {
  const trackRef = useRef(null)
  const drag = (which) => (e) => {
    e.preventDefault(); e.stopPropagation()
    const move = (ev) => {
      const r = trackRef.current.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      const t = Math.round(frac * max)
      if (which === 'start') onChange(Math.min(t, (end || max) - 1), end)
      else onChange(start, Math.max(t, (start || 0) + 1))
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

// ── Inspector: the clips column + preview player + trim + triggers ────────────
export function YTSlideshowInspector({ clips, anchor, onChange, onClose, onExtract }) {
  const [sel, setSel] = useState(0)
  const [urlInput, setUrlInput] = useState('')
  const [dur, setDur] = useState(0)
  const handleRef = useRef(null)
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
  const move = (i, d) => {
    const j = i + d; if (j < 0 || j >= clips.length) return
    const next = clips.slice(); const [x] = next.splice(i, 1); next.splice(j, 0, x); onChange(next); setSel(j)
  }
  // Poll the preview player's duration so the slider knows the clip length.
  useEffect(() => {
    setDur(0)
    const t = setInterval(() => { const d = handleRef.current?.duration?.() || 0; if (d) { setDur(d); clearInterval(t) } }, 400)
    return () => clearInterval(t)
  }, [cur?.youtubeId])

  const inp = { background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 6, padding: '5px 7px', fontSize: 12, outline: 'none', width: 62, textAlign: 'center' }
  const max = Math.max(dur || 0, cur?.end || 0, 30)
  // Unfold from the node when an anchor is given (clamped on-screen); else fall back to a right-side panel.
  const W = 380
  const pos = anchor
    ? { position: 'fixed', left: Math.max(8, Math.min(anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8)), top: Math.max(8, Math.min(anchor.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 480)), width: W, maxHeight: '82vh', borderRadius: 12, border: '1px solid #2d3a6a' }
    : { position: 'fixed', top: 0, right: 0, height: '100%', width: 420, maxWidth: '96vw', borderLeft: '1px solid #2d3a6a' }
  return (
    <div style={{ ...pos, background: '#12122a', boxShadow: '0 12px 40px rgba(0,0,0,0.55)', zIndex: 500, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: '-apple-system, sans-serif' }}
      onMouseDown={e => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #23234a' }}>
        <div style={{ flex: 1, color: '#c5d0ff', fontWeight: 700, fontSize: '0.9rem' }}>▶ YouTube slideshow</div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>

      {/* Preview player for the selected clip */}
      <div style={{ padding: 12 }}>
        <div style={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 8, overflow: 'hidden', border: '1px solid #23234a' }}>
          {cur ? <YTPlayer key={cur.id} clip={cur} onReady={(h) => { handleRef.current = h }} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7080a0', fontSize: 13 }}>Add a clip to preview</div>}
        </div>
        {cur && (<>
          <TrimSlider start={cur.start || 0} end={cur.end || max} max={max}
            onChange={(s, e) => patch(sel, { start: s, end: e >= max ? 0 : e })} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#8fa0d8', marginTop: 2 }}>
            <span>Start</span>
            <input style={inp} defaultValue={fmtTime(cur.start || 0)} key={'s' + cur.id + (cur.start || 0)}
              onBlur={e => { const v = parseTime(e.target.value); if (v != null) patch(sel, { start: v }) }} />
            <span style={{ flex: 1 }} />
            <span>End</span>
            <input style={inp} defaultValue={cur.end ? fmtTime(cur.end) : ''} placeholder={fmtTime(max)} key={'e' + cur.id + (cur.end || 0)}
              onBlur={e => { const v = parseTime(e.target.value); patch(sel, { end: v || 0 }) }} />
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
        </>)}
      </div>

      {/* Clips column */}
      <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #23234a', padding: 8 }}>
        {clips.map((c, i) => (
          <div key={c.id} onClick={() => setSel(i)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 7, marginBottom: 4, cursor: 'pointer',
              background: i === sel ? '#1c2148' : 'transparent', border: `1px solid ${i === sel ? '#3a4a8a' : 'transparent'}` }}>
            <img src={ytThumb(c.youtubeId)} alt="" width={64} height={36} style={{ borderRadius: 4, objectFit: 'cover', flexShrink: 0, background: '#000' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#c5d0ff', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || c.youtubeId}</div>
              <div style={{ color: '#7080a0', fontSize: 10.5 }}>{fmtTime(c.start || 0)}–{c.end ? fmtTime(c.end) : 'end'} · {c.trigger || 'click'}</div>
            </div>
            <button onClick={e => { e.stopPropagation(); move(i, -1) }} style={miniBtn} title="Move up">▲</button>
            <button onClick={e => { e.stopPropagation(); move(i, 1) }} style={miniBtn} title="Move down">▼</button>
            {onExtract && <button onClick={e => { e.stopPropagation(); onExtract(c); onChange(clips.filter((_, j) => j !== i)) }} style={miniBtn} title="Pop out onto the canvas">↗</button>}
            <button onClick={e => { e.stopPropagation(); del(i) }} style={{ ...miniBtn, color: '#f87171' }} title="Delete">×</button>
          </div>
        ))}
        {!clips.length && <div style={{ color: '#7080a0', fontSize: 12, padding: 8 }}>No clips yet. Paste a YouTube link below.</div>}
      </div>

      {/* Add */}
      <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid #23234a' }}>
        <input value={urlInput} onChange={e => setUrlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addUrl() }}
          placeholder="Paste a YouTube link…" style={{ ...inp, width: 'auto', flex: 1, textAlign: 'left' }} />
        <button onClick={addUrl} style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '0 14px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>＋ Add</button>
      </div>
    </div>
  )
}
const miniBtn = { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: 12, padding: '2px 3px', lineHeight: 1 }

// ── On-canvas node: a clean player showing the current clip ───────────────────
// `active` = the ytss has been "entered" (arrows drive it). `currentIdx` is controlled by the parent so
// arrow-nav can drive it; onReady exposes the live player handle for seek/play. Drag via the header.
export function YTSlideshowNode({ node, ytss, currentIdx = 0, active, externalControl, selected, onHeaderDown, onSelect, onEnter, onEdit, onReady, onEnded, onSetIdx }) {
  const clips = ytss?.clips || []
  const idx = Math.max(0, Math.min(currentIdx, clips.length - 1))
  const cur = clips[idx] || null
  const W = 480 * (node.__scale || 1), H = 270 * (node.__scale || 1)
  const label = node.label || 'YouTube slideshow'
  return (
    <g transform={`translate(${node.x || 0},${node.y || 0})`} data-ytss="1" data-cardnode={node.id}
      onMouseDown={e => { if (e.button === 0 && !active) { e.stopPropagation(); onSelect?.() } }}
      onDoubleClick={e => { e.stopPropagation(); onEnter?.() }}>
      {/* Title above */}
      <text x={0} y={-H / 2 - 10} textAnchor="middle" fontSize={15} fill={active ? '#8ecbff' : '#c5d0ff'}
        style={{ userSelect: 'none', fontWeight: 600 }}>{label}{clips.length ? `  ·  ${idx + 1}/${clips.length}` : ''}</text>
      <foreignObject x={-W / 2} y={-H / 2} width={W} height={H} style={{ overflow: 'visible' }}>
        <div style={{ width: '100%', height: '100%', borderRadius: 10, overflow: 'hidden',
          border: `2px solid ${active ? '#4ade80' : (selected ? '#5b6af0' : '#2d3a6a')}`, background: '#000', position: 'relative' }}>
          {cur
            ? <YTPlayer key={node.id} clip={cur} interactive={active} externalControl={externalControl} onReady={onReady} onEnded={onEnded} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8fa0d8', fontFamily: '-apple-system, sans-serif' }}>
                <div style={{ fontSize: 30 }}>▶</div>
                <div style={{ fontSize: 13 }}>Empty slideshow</div>
                <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit?.() }}
                  style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>Add clips…</button>
              </div>}
          {/* Hint bar while active */}
          {active && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '4px 8px', background: 'rgba(10,10,24,0.82)', color: '#aab4dd', fontSize: 10.5, textAlign: 'center', fontFamily: '-apple-system, sans-serif', pointerEvents: 'none' }}>
              ← → clips · space play/pause · shift+←/→ ∓10s · esc exit
            </div>
          )}
        </div>
      </foreignObject>
      {/* Selected (not yet entered): a header drag-bar + Enter/Edit affordances */}
      {selected && !active && (
        <g>
          <g onMouseDown={e => { e.stopPropagation(); onHeaderDown?.(e) }} style={{ cursor: 'move' }}>
            <rect x={-W / 2} y={-H / 2 - 3} width={W} height={16} rx={2} fill="#5b6af0" opacity={0.85} />
            <text x={0} y={-H / 2 + 8} textAnchor="middle" fontSize={9} fill="#fff" style={{ userSelect: 'none', pointerEvents: 'none' }}>⠿ drag · double-click to play · ⚙ edit</text>
          </g>
          <g transform={`translate(${W / 2 - 16},${-H / 2 + 16})`} style={{ cursor: 'pointer' }}
            onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit?.() }}>
            <circle r={11} fill="#12122aee" stroke="#5b6af0" strokeWidth={1.2} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={12} fill="#c5d0ff" style={{ userSelect: 'none' }}>⚙</text>
          </g>
          {clips.length > 1 && (<>
            <g transform={`translate(${-W / 2 + 18},0)`} style={{ cursor: 'pointer' }} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onSetIdx?.((idx - 1 + clips.length) % clips.length) }}>
              <circle r={13} fill="#12122acc" stroke="#5b6af0" strokeWidth={1} /><text textAnchor="middle" dominantBaseline="central" fontSize={13} fill="#c5d0ff">‹</text>
            </g>
            <g transform={`translate(${W / 2 - 18},0)`} style={{ cursor: 'pointer' }} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onSetIdx?.((idx + 1) % clips.length) }}>
              <circle r={13} fill="#12122acc" stroke="#5b6af0" strokeWidth={1} /><text textAnchor="middle" dominantBaseline="central" fontSize={13} fill="#c5d0ff">›</text>
            </g>
          </>)}
        </g>
      )}
    </g>
  )
}

