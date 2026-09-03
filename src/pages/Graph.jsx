import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { Rnd } from 'react-rnd'
import Node3DViewer from '../components/Node3DViewer'
import * as d3 from 'd3'
import useGraphStore, { DEFAULT_NODE_PROPS, NODE_R, COLOR_PALETTE, FILL_COLORS, TEXT_COLORS, SHAPES, BG_COLORS, SLIDE_BG_COLORS, LAST_STYLE_PROPS, NEW_NODE_STYLE_PROPS } from '../lib/graphStore'
import { generateWords, assessRisk, checkUSPTO, hasWordgenKey, getWordgenKey, setWordgenKey } from '../lib/wordgen'
import { generateContent } from '../lib/ai'
import ViewManager from '../components/ViewManager'
import CommandBar from '../components/CommandBar'
import { saveProject, uploadModel, uploadThumbnail, uploadImageDataUrl, uploadMediaFile, unfurlLink } from '../lib/db'
import { PropertyField, PROP_TYPES } from '../components/PropertyField'
import { tagColor } from '../lib/tags'
import { arrangeSubtree, arrangeNodes, SUBTREE_LAYOUTS, FLAT_LAYOUTS } from '../lib/arrange'
import { outlineHTML, svgToPng, buildDocumentHTML, downloadDoc, printPDF } from '../lib/exportDoc'
import { graphToMermaid, parseMermaid, layeredLayout } from '../lib/flowchart'
import { EMOJIS } from '../components/Drawing'
import { YTSlideshowNode, YTSlideshowInspector, YTFullscreenPlayer, YTVideoOptions, cutSkipTarget } from '../components/YTSlideshow'
import { playDrop } from '../lib/sound'

// ── Auto-styling: derive a visual channel from a property value ──────────────────
// Channels the parent can map a property to (label + the view prop each writes).
const STYLE_CHANNELS = [
  { key: 'color', label: 'Color', prop: 'fillColor' },
  { key: 'size', label: 'Size', prop: 'scale' },
  { key: 'shape', label: 'Shape', prop: 'shape' },
  { key: 'blur', label: 'Blurriness', prop: 'borderBlur' },
  { key: 'motion', label: 'Motion', prop: 'nodeMotion' },
  { key: 'outlineWidth', label: 'Outline thickness', prop: 'strokeWidth' },
  { key: 'outlineColor', label: 'Outline color', prop: 'strokeColor' },
]
const AUTOSTYLE_SHAPES = ['circle', 'roundrect', 'rect', 'ellipse', 'diamond']
const AUTOSTYLE_MOTIONS = ['shake', 'circle', 'jerk', 'updown', 'sideways', 'scale']
const valKey = (v) => Array.isArray(v) ? v.join('|') : String(v)
// A node's value for a property def (Select→optionId, multiSelect→array, number→number, else raw).
function nodeValueForProp(node, def) {
  if (!def) return null
  const raw = node?.props?.[def.id]
  if (def.type === 'number') { const n = Number(raw); return (raw == null || raw === '' || isNaN(n)) ? null : n }
  if (Array.isArray(raw)) return raw.length ? raw : null
  return raw ?? null
}
function autoStyleColor(value, idx, def) {
  if (def && (def.type === 'select' || def.type === 'multiSelect')) {
    const v = Array.isArray(value) ? value[0] : value
    const opt = (def.options || []).find(o => o.id === v)
    if (opt?.color) return opt.color
  }
  return FILL_COLORS[(idx < 0 ? 0 : idx) % FILL_COLORS.length]
}
// value → {viewProp: value} for one channel. ctx = { distinct, min, max, def }.
function deriveChannel(channel, value, ctx) {
  const { distinct, min, max, def } = ctx
  const idx = distinct.findIndex(d => valKey(d) === valKey(value))
  const frac = distinct.length > 1 && idx >= 0 ? idx / (distinct.length - 1) : 0
  const numFrac = (typeof value === 'number' && max > min) ? (value - min) / (max - min) : frac
  switch (channel) {
    case 'color': return { fillColor: autoStyleColor(value, idx, def) }
    case 'outlineColor': return { strokeColor: autoStyleColor(value, idx, def), strokeWidth: 2.5 }
    case 'shape': return { shape: AUTOSTYLE_SHAPES[(idx < 0 ? 0 : idx) % AUTOSTYLE_SHAPES.length] }
    case 'size': return { scale: +(0.7 + numFrac * 1.8).toFixed(2) }
    case 'blur': return { borderBlur: Math.round(numFrac * 24) }
    case 'outlineWidth': return { strokeWidth: +(1 + numFrac * 5).toFixed(1) }
    case 'motion': return { nodeMotion: { type: AUTOSTYLE_MOTIONS[(idx < 0 ? 0 : idx) % AUTOSTYLE_MOTIONS.length], speed: 1, intensity: 1 } }
    default: return {}
  }
}

// Central "gesture cursor": while a drag/pan/connect is in progress we set the cursor on <body>, which
// overrides whatever element is under the pointer, then clear it on gesture end. One source of truth
// so cursor states never fight (idle cursor lives on the <svg>; active gestures live here).
const setGestureCursor = (c) => { document.body.style.cursor = c }
const clearGestureCursor = () => { document.body.style.cursor = '' }

// Drag shield: a full-viewport transparent overlay mounted on <body> during a drag. Cross-origin
// iframes (YouTube embeds) swallow mousemove/mouseup so a drag started elsewhere "sticks" — the
// document-level mouseup never fires once the pointer crosses the iframe. The shield sits above all
// iframes and receives those events itself (they still bubble to document), so drags release cleanly.
let _dragShield = null
const showDragShield = (cursor = 'grabbing') => {
  // Disable pointer capture on ALL media (esp. cross-origin YouTube iframes, which swallow the mouseup
  // and glue the drag) for the whole drag — independent of whether the overlay covers them.
  document.body.classList.add('pim-dragging')
  if (_dragShield) { _dragShield.style.cursor = cursor; return }
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;inset:0;z-index:2147483000;cursor:${cursor};background:transparent`
  document.body.appendChild(el)
  _dragShield = el
}
const hideDragShield = () => { document.body.classList.remove('pim-dragging'); if (_dragShield) { _dragShield.remove(); _dragShield = null } }

// Extract an 11-char YouTube video id from a URL or bare id, else null.
const parseYoutubeId = (str) => {
  const s = String(str || '').trim()
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/)
  if (m) return m[1]
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  return null
}

// Build a YouTube embed URL honoring per-video options. Uses youtube-nocookie.com for privacy.
// Note: pre-roll ADS cannot be removed by embed params — only related videos / annotations / branding
// can be suppressed (hideRelated → rel=0 + iv_load_policy=3 + modestbranding=1). Autoplay in-browser
// only works when muted, so autoplay implies mute unless the user turned sound on explicitly.
const youtubeEmbedUrl = (img) => {
  const p = new URLSearchParams()
  if (img.autoplay) p.set('autoplay', '1')
  if (img.muted) p.set('mute', '1')
  if (img.loop) { p.set('loop', '1'); p.set('playlist', img.youtubeId) }
  p.set('controls', img.controls === false ? '0' : '1')
  if (img.hideRelated) { p.set('rel', '0'); p.set('modestbranding', '1'); p.set('iv_load_policy', '3') }
  if (img.captions) { p.set('cc_load_policy', '1'); p.set('cc_lang_pref', 'en') }
  if (img.start) p.set('start', String(Math.max(0, Math.round(img.start))))
  if (img.end && img.end > (img.start || 0)) p.set('end', String(Math.round(img.end)))
  p.set('enablejsapi', '1')   // lets us drive play/pause/speed via postMessage
  p.set('playsinline', '1')
  try { p.set('origin', window.location.origin) } catch { /* SSR / no window */ }
  return `https://www.youtube-nocookie.com/embed/${img.youtubeId}?${p.toString()}`
}

// Convert a canvas media element (a node's `media`, or a free `view.images` entry) into a slideshow
// slide. Media nodes carry `kind`; free images carry `type`. Returns null if it isn't playable media.
function elementToSlide(o, label) {
  if (!o) return null
  const title = label || o.title || ''
  const t = o.type || o.kind   // free images use `type`, media nodes use `kind`
  if (o.videoKind === 'youtube' && o.youtubeId) return { kind: 'youtube', youtubeId: o.youtubeId, title, start: o.start || 0, end: o.end || 0, speed: o.speed || 1, cuts: o.cuts, trigger: 'click' }
  if (t === 'audio') return { kind: 'audio', src: o.src, title, start: o.start || 0, end: o.end || 0, cuts: o.cuts, trigger: 'click' }
  if (t === 'video' || o.videoKind === 'file') return { kind: 'video', src: o.src, title, start: o.start || 0, end: o.end || 0, speed: o.speed || 1, loop: !!o.loop, cuts: o.cuts, trigger: 'click' }
  if (o.src) return { kind: 'image', src: o.src, title, trigger: 'auto', duration: 5 }
  return null
}

// ── Clipboard table parsing (Google Sheets / Google Docs / Markdown) ─────────────────────────────
// Turns clipboard content into a { title?, columns:[{name,type,options?}], rows:[{cells:{[colIdx]:v}}] }
// grid, or null if it isn't tabular. Priority: HTML <table> (richest) → Markdown table → TSV.
const CHECKBOX_TRUE = new Set(['true', 'yes', 'y', '✓', '✔', '☑', 'x', '☒', 'done', '✅', '1'])
const CHECKBOX_ALL = new Set([...CHECKBOX_TRUE, 'false', 'no', 'n', '✗', '✘', '☐', '—', '-', '0', ''])

function inferColumnType(values) {
  const nonEmpty = values.filter(v => v != null && String(v).trim() !== '')
  if (!nonEmpty.length) return { type: 'text' }
  const low = nonEmpty.map(v => String(v).trim().toLowerCase())
  if (low.every(v => CHECKBOX_ALL.has(v)) && low.some(v => CHECKBOX_TRUE.has(v) || v === 'false' || v === 'no')) {
    return { type: 'checkbox' }
  }
  if (nonEmpty.every(v => /^-?\d+(\.\d+)?$/.test(String(v).trim()))) return { type: 'number' }
  const distinct = [...new Set(nonEmpty.map(v => String(v).trim()))]
  if (distinct.length >= 2 && distinct.length <= 12 && nonEmpty.length >= 3 && distinct.length <= nonEmpty.length * 0.7) {
    return { type: 'select', options: distinct }
  }
  return { type: 'text' }
}

// Assemble a grid from a 2D string matrix: first row = header, the rest = data, with per-column types.
function gridFromMatrix(matrix) {
  const rowsRaw = matrix.filter(r => r.length && r.some(c => String(c).trim() !== ''))
  if (rowsRaw.length < 1) return null
  const nCols = Math.max(...rowsRaw.map(r => r.length))
  if (nCols < 1) return null
  const header = rowsRaw[0]
  const dataRows = rowsRaw.slice(1)
  const columns = []
  for (let ci = 0; ci < nCols; ci++) {
    const name = (header[ci] || '').trim() || `Column ${ci + 1}`
    const colVals = dataRows.map(r => r[ci] ?? '')
    const inf = inferColumnType(colVals)
    columns.push({ name, ...inf })
  }
  const rows = dataRows.map(r => {
    const cells = {}
    columns.forEach((col, ci) => {
      let v = (r[ci] ?? '').toString()
      if (col.type === 'checkbox') v = CHECKBOX_TRUE.has(v.trim().toLowerCase())
      cells[ci] = v
    })
    return { cells }
  })
  // Require at least 2 columns OR 2 rows so a single cell/line doesn't become a table.
  if (nCols < 2 && rows.length < 1) return null
  return { columns, rows }
}

function parseClipboardTable(html, text) {
  // 1) HTML <table> — Google Sheets & Docs both emit one.
  if (html && /<table[\s>]/i.test(html)) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const table = doc.querySelector('table')
      if (table) {
        const trs = [...table.querySelectorAll('tr')]
        const matrix = trs.map(tr => [...tr.querySelectorAll('th,td')].map(td => (td.textContent || '').replace(/\s+/g, ' ').trim()))
        const grid = gridFromMatrix(matrix)
        if (grid && grid.columns.length >= 2) return grid
        if (grid && grid.rows.length >= 1) return grid
      }
    } catch { /* fall through to text parsing */ }
  }
  const t = (text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  if (!t) return null
  const lines = t.split('\n')
  // 2) Markdown table — header row, a |---|---| separator, then rows.
  if (lines.length >= 2 && /\|/.test(lines[0]) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[1]) && /-/.test(lines[1])) {
    const cut = (ln) => ln.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
    const matrix = [cut(lines[0]), ...lines.slice(2).map(cut)]
    const grid = gridFromMatrix(matrix)
    if (grid) return grid
  }
  // 3) TSV — Google Sheets' plain-text form. Need at least one tab (≥2 columns).
  if (lines.some(l => l.includes('\t'))) {
    const matrix = lines.map(l => l.split('\t'))
    const grid = gridFromMatrix(matrix)
    if (grid && grid.columns.length >= 2) return grid
  }
  return null
}

// Centered inline-SVG icon for SVG-space circular badges. Authored in a 24×24 box; a nested <svg> with
// x/y = -size/2 puts the glyph's centre (12,12) exactly at (0,0), so it sits dead-center in a <circle> —
// unlike emoji/text glyphs, whose optical centre drifts under dominantBaseline. Stroke stays ~constant
// px via non-scaling-stroke. Use inside a `<g transform="translate(cx,cy)">` alongside the circle.
function IconGlyph({ name, size = 12, color = '#fff', fill }) {
  const s = { fill: 'none', stroke: color, strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }
  const solid = { fill: fill || color, stroke: 'none' }
  const paths = {
    close:    <path d="M7 7l10 10M17 7L7 17" {...s} />,
    plus:     <path d="M12 5v14M5 12h14" {...s} />,
    check:    <path d="M5 12.5l4.5 4.5L19 7" {...s} />,
    link:     <g {...s}><path d="M10 14l4-4" /><path d="M13.5 6.5l1-1a3.9 3.9 0 0 1 5.5 5.5l-2.5 2.5" /><path d="M10.5 17.5l-1 1a3.9 3.9 0 0 1-5.5-5.5l2.5-2.5" /></g>,
    play:     <path d="M8 5.5v13l11-6.5z" {...solid} />,
    refresh:  <g {...s}><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" /></g>,
    resize:   <g {...s}><path d="M20 10V4h-6" /><path d="M4 14v6h6" /><path d="M20 4L4 20" /></g>,
    chevronR: <path d="M9.5 6l6 6-6 6" {...s} />,
    chevronD: <path d="M6 9.5l6 6 6-6" {...s} />,
    edit:     <path d="M4 20h4L18.5 9.5l-4-4L4 16z" {...s} />,
  }
  return (
    <svg x={-size / 2} y={-size / 2} width={size} height={size} viewBox="0 0 24 24" style={{ overflow: 'visible', pointerEvents: 'none' }}>
      {paths[name] || null}
    </svg>
  )
}

// Gentle gravity toward the cloud's OWN centroid (not a fixed point) — counteracts the charge
// repulsion so the layout stays compact instead of scattering disconnected nodes/branches outward
// every time the simulation restarts. Skips pinned nodes. Robust to pan/zoom (uses live positions).
function centeringForce(strength = 0.07) {
  let nodes
  const f = (alpha) => {
    if (!nodes || !nodes.length) return
    let sx = 0, sy = 0, c = 0
    for (const n of nodes) { if (n.x == null) continue; sx += n.x; sy += n.y; c++ }
    if (!c) return
    const gx = sx / c, gy = sy / c, k = strength * alpha
    for (const n of nodes) { if (n.fx == null && n.x != null) { n.vx += (gx - n.x) * k; n.vy += (gy - n.y) * k } }
  }
  f.initialize = (n) => { nodes = n }
  return f
}

// â"€â"€ Text measurement â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
let _measureCanvas = null
function measureTextWidth(text, fontSize) {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas')
  const ctx = _measureCanvas.getContext('2d')
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`
  return ctx.measureText(text || ' ').width
}

// For rect/roundrect: box is sized to snugly fit the text content.
// widthOverride (half-width, sim units) lets the user manually pin the paragraph
// width via the drag handle in edit mode — line breaks then wrap to that width instead.
function getAutoSizeDims(label, fontSize, widthOverride) {
  const PAD_X = 14, PAD_Y = 10, MAX_HALF_W = 180, MIN_HALF_W = 36
  const rawW = measureTextWidth(label, fontSize)
  const halfW = widthOverride
    ? Math.max(MIN_HALF_W, widthOverride)
    : Math.max(MIN_HALF_W, Math.min(MAX_HALF_W, rawW / 2 + PAD_X))
  const lineWidth = halfW * 2 - PAD_X * 2
  const linesCount = Math.max(1, Math.ceil(rawW / lineWidth))
  const halfH = (linesCount * fontSize * 1.35) / 2 + PAD_Y
  return { halfW, halfH }
}

// Largest font size (clamped to [7, maxFont]) at which `label` word-wraps to fit a box
// of boxW × boxH. Respects explicit newlines. Used to shrink text into round/fixed shapes.
function fitFontToBox(label, maxFont, boxW, boxH) {
  if (boxW <= 0 || boxH <= 0) return Math.max(7, maxFont)
  const paras = String(label ?? ' ').split('\n')
  for (let fs = maxFont; fs >= 7; fs--) {
    let lines = 0
    for (const para of paras) {
      const words = para.split(/\s+/).filter(Boolean)
      if (!words.length) { lines += 1; continue }
      let cur = ''
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w
        if (!cur || measureTextWidth(test, fs) <= boxW) cur = test
        else { lines += 1; cur = w }
      }
      lines += 1
    }
    if (lines * fs * 1.3 <= boxH) return fs
  }
  return 7
}

// ── Full emoji catalog, grouped by category ─────────────────────────
const EMOJI_CATALOG = [
  ['Smileys', ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾']],
  ['People', ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦵','🦿','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','🫦','👶','🧒','👦','👧','🧑','👨','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇','🤦','🤷','👮','🕵️','💂','👷','🤴','👸','👳','👲','🧕','🤵','👰','🤰','🤱','👼','🎅','🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','👯','🧖','🧗','🤺','🏇','⛷️','🏂','🏌️','🏄','🚣','🏊','⛹️','🏋️','🚴','🚵','🤸','🤼','🤽','🤾','🤹','🧘','🛀','🛌','👭','👫','👬','💏','💑','👪']],
  ['Animals', ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🕸️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🦣','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔']],
  ['Food', ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾','🧊']],
  ['Activities', ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🎰','🧩']],
  ['Travel', ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🦯','🦽','🦼','🛴','🚲','🛵','🏍️','🛺','🚨','🚔','🚍','🚘','🚖','🚡','🚠','🚟','🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️','🛫','🛬','🛩️','💺','🛰️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','⚓','🪝','⛽','🚧','🚦','🚥','🚏','🗺️','🗿','🗽','🗼','🏰','🏯','🏟️','🎡','🎢','🎠','⛲','⛱️','🏖️','🏝️','🏜️','🌋','⛰️','🏔️','🗻','🏕️','⛺','🏠','🏡','🏘️','🏚️','🏗️','🏭','🏢','🏬','🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏩','💒','🏛️','⛪','🕌','🕍','🛕','🕋','⛩️']],
  ['Objects', ['⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🪔','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🪜','🧰','🪛','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🪤','🧱','⛓️','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪥','🪒','🧽','🪣','🧴','🛎️','🔑','🗝️','🚪','🪑','🛋️','🛏️','🛌','🧸','🪆','🖼️','🪞','🪟','🛍️','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🪩','🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷️','🪧','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉','📋','📅','📆','🗒️','🗓️','📇','🗃️','🗳️','🗄️','📋','📁','📂','🗂️','🗞️','📰','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','🧷','🔗','📎','🖇️','📐','📏','🧮','📌','📍','✂️','🖊️','🖋️','✒️','🖌️','🖍️','📝','✏️','🔍','🔎','🔏','🔐','🔒','🔓']],
  ['Symbols', ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🛗','🈳','🈂️','🛂','🛃','🛄','🛅','🚹','🚺','🚼','🚻','🚮','🎦','📶','🈁','🔣','ℹ️','🔤','🔡','🔠','🆖','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣','⏏️','▶️','⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','⏫','⏬','◀️','🔼','🔽','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','↕️','↔️','↪️','↩️','⤴️','⤵️','🔀','🔁','🔂','🔄','🔃','🎵','🎶','➕','➖','➗','✖️','♾️','💲','💱','™️','©️','®️','〰️','➰','➿','🔚','🔙','🔛','🔝','🔜','✔️','☑️','🔘','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥','🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','◼️','◻️','◾','◽','▪️','▫️','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔲','🔳']],
  ['Flags', ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇦🇷','🇧🇷','🇨🇦','🇨🇱','🇨🇳','🇨🇴','🇩🇪','🇪🇸','🇫🇷','🇬🇧','🇮🇳','🇮🇹','🇯🇵','🇲🇽','🇳🇱','🇵🇪','🇵🇹','🇷🇺','🇰🇷','🇸🇪','🇨🇭','🇺🇸','🇺🇾','🇺🇳']],
]

// Keyword lookup for emoji search — maps emoji → space-separated search terms
const EMOJI_KEYWORDS = {
  // Smileys
  '😀':'smile grin happy','😃':'smile big happy','😄':'laugh happy','😁':'grin happy','😆':'laugh lol','😅':'sweat laugh','🤣':'rofl lol laugh','😂':'cry laugh joy','🙂':'slight smile','😉':'wink','😊':'blush happy smile','😇':'angel halo','🥰':'love hearts','😍':'love eyes heart','😘':'kiss love','😗':'kiss','😚':'kiss','😙':'kiss','😋':'yum food tongue','😛':'tongue out','😜':'wink tongue','😝':'tongue squint','🤑':'money rich dollar','🤗':'hug','🤔':'think hmm','😐':'neutral','😑':'expressionless','😶':'silent no mouth','😏':'smirk','😒':'unamused','🙄':'eye roll','😬':'grimace','😌':'relieved','😔':'pensive sad','😪':'sleepy','😴':'sleep zzz','😷':'sick mask','🤒':'sick ill','🤕':'hurt injured','🤢':'nausea sick','🤮':'vomit sick','🤧':'sneeze cold','🥵':'hot fire','🥶':'cold freeze','🥴':'dizzy drunk','😵':'dizzy','🤯':'mind blown','🤠':'cowboy hat','🥳':'party celebrate','😎':'cool sunglasses','🤓':'nerd glasses','🧐':'monocle curious','😕':'confused','😟':'worried','😮':'surprised open mouth','😲':'astonished shocked','😳':'flushed embarrassed','🥺':'puppy eyes please','😦':'frowning open','😧':'anguished','😨':'fearful scared','😰':'anxious sweat','😥':'sad tear','😢':'cry sad tear','😭':'cry sob','😱':'scream fear','😖':'confounded','😣':'persevere','😞':'disappointed','😓':'sweat sad','😩':'weary','😫':'tired','🥱':'yawn bored','😤':'steam mad','😡':'angry mad red','😠':'angry mad','🤬':'cursing swear angry','😈':'devil evil','👿':'angry devil','💀':'skull death','☠️':'skull crossbones death','💩':'poop shit','🤡':'clown','👻':'ghost','👽':'alien','🤖':'robot','😺':'cat smile','😸':'cat laugh','😹':'cat cry laugh','😻':'cat heart love',
  // People & hands
  '👋':'wave hello hi bye','🤚':'raise hand','✋':'stop hand high five','🖐️':'hand five','👌':'ok','✌️':'peace victory','🤞':'fingers crossed luck','🤟':'love you','🤘':'rock horns','👈':'left point','👉':'right point','👆':'up point','👇':'down point','☝️':'up one','👍':'thumbs up like good','👎':'thumbs down dislike bad','✊':'fist punch','👊':'punch fist','👏':'clap applause','🙌':'celebrate hands up','🤝':'handshake deal','🙏':'pray please thank hands','💅':'nails manicure','💪':'muscle strong arm','👀':'eyes look','👄':'lips mouth','👶':'baby','🧒':'child','👦':'boy','👧':'girl','🧑':'person','👨':'man','👩':'woman','🧓':'older','👴':'old man','👵':'old woman',
  // Emotions & hearts
  '❤️':'heart love red','🧡':'orange heart','💛':'yellow heart','💚':'green heart','💙':'blue heart','💜':'purple heart','🖤':'black heart','🤍':'white heart','🤎':'brown heart','💔':'broken heart','💕':'two hearts love','💞':'revolving hearts','💓':'beating heart','💗':'growing heart','💖':'sparkling heart','💘':'heart arrow cupid','💝':'heart ribbon','💯':'100 perfect score',
  // Animals
  '🐶':'dog puppy','🐱':'cat kitten','🐭':'mouse','🐹':'hamster','🐰':'rabbit bunny','🦊':'fox','🐻':'bear','🐼':'panda','🐨':'koala','🐯':'tiger','🦁':'lion','🐮':'cow','🐷':'pig','🐸':'frog','🐵':'monkey','🐒':'monkey','🐔':'chicken hen','🐧':'penguin','🦆':'duck','🦅':'eagle','🦉':'owl','🦇':'bat','🐺':'wolf','🐴':'horse','🦄':'unicorn','🐝':'bee','🦋':'butterfly','🐌':'snail','🐞':'ladybug beetle','🐜':'ant','🐢':'turtle','🐍':'snake','🦎':'lizard','🐙':'octopus','🐠':'fish tropical','🐟':'fish','🐬':'dolphin','🐳':'whale','🦈':'shark','🐊':'crocodile alligator','🐘':'elephant','🦋':'butterfly','🐕':'dog','🐈':'cat','🐓':'rooster chicken','🦃':'turkey','🦚':'peacock','🦜':'parrot','🦢':'swan','🕊️':'dove peace','🐇':'rabbit','🐁':'mouse','🐀':'rat','🦔':'hedgehog',
  // Food
  '🍎':'apple red','🍊':'orange','🍋':'lemon yellow','🍌':'banana','🍉':'watermelon','🍇':'grapes','🍓':'strawberry','🍒':'cherry','🍑':'peach','🥭':'mango','🍍':'pineapple','🥥':'coconut','🥝':'kiwi','🍅':'tomato','🍆':'eggplant aubergine','🥑':'avocado','🥦':'broccoli','🥕':'carrot','🌽':'corn','🧄':'garlic','🧅':'onion','🥔':'potato','🍞':'bread','🥐':'croissant','🧀':'cheese','🥚':'egg','🍳':'egg fry cook','🥞':'pancake','🧇':'waffle','🥓':'bacon','🍗':'chicken drumstick','🍔':'burger hamburger','🍟':'fries','🍕':'pizza','🌭':'hotdog','🍜':'noodles ramen','🍣':'sushi','🥗':'salad','🍰':'cake slice','🎂':'birthday cake','🍩':'donut','🍪':'cookie','🍫':'chocolate','🍿':'popcorn','☕':'coffee','🍵':'tea','🍺':'beer','🍷':'wine','🍸':'cocktail','🥤':'drink cup',
  // Activities & sports
  '⚽':'soccer football','🏀':'basketball','🏈':'football american','⚾':'baseball','🎾':'tennis','🏐':'volleyball','🏉':'rugby','🎱':'billiard pool','🏆':'trophy win champion','🥇':'gold medal first','🥈':'silver medal second','🥉':'bronze medal third','🎮':'video game controller','🎯':'target dart','🎲':'dice game','🎨':'art paint palette','🎭':'theater drama','🎬':'movie film clapper','🎤':'microphone sing','🎧':'headphones music','🎼':'music score','🎹':'piano keyboard','🎷':'saxophone','🎺':'trumpet','🎸':'guitar','🎻':'violin','🥁':'drums','🎵':'music note','🎶':'music notes',
  // Travel & places
  '🚗':'car vehicle','🚕':'taxi','🚙':'suv car','🚌':'bus','🏎️':'racing car fast','🚑':'ambulance','🚒':'fire truck','✈️':'airplane flight','🚀':'rocket space','🛸':'ufo spaceship','🚁':'helicopter','🚢':'ship boat','⚓':'anchor boat','🏠':'house home','🏡':'home garden','🏢':'office building','🏥':'hospital','🏦':'bank','🏨':'hotel','🌍':'earth world','🌎':'earth americas','🌏':'earth asia','⛰️':'mountain','🌋':'volcano','🏔️':'snow mountain','🏖️':'beach','🏝️':'island','🌅':'sunrise sunset','🌃':'night city','🌆':'city sunset','🌇':'city sunrise','🌉':'bridge night',
  // Objects
  '📱':'phone mobile','💻':'laptop computer','⌨️':'keyboard','🖥️':'desktop computer','🖨️':'printer','🖱️':'mouse computer','💡':'idea light bulb','🔋':'battery','🔌':'plug power','📷':'camera photo','📹':'video camera','🎥':'movie camera','📺':'tv television','📻':'radio','📚':'books library','📖':'book read','📝':'write note memo','✏️':'pencil write','🖊️':'pen write','📌':'pin location','📍':'pin map','✂️':'scissors cut','🔍':'search magnify','🔎':'search magnify','🔑':'key','🗝️':'key old','🚪':'door','💰':'money bag cash','💵':'dollar money','💳':'credit card','💎':'diamond gem','⚖️':'scale balance','🔧':'wrench tool','🔨':'hammer tool','⚒️':'tools','🛠️':'tools repair','🔬':'microscope science','🔭':'telescope space','💊':'pill medicine','💉':'syringe needle','🏺':'vase','🎁':'gift present','🎈':'balloon party','🎉':'party celebrate confetti','🧩':'puzzle piece',
  // Symbols & misc
  '⭐':'star','🌟':'glowing star shine','✨':'sparkle shine','⚡':'lightning bolt energy','🔥':'fire hot flame','💧':'water drop','🌊':'wave ocean water','❄️':'snowflake cold ice','🌈':'rainbow','☀️':'sun sunny','🌙':'moon night','⛅':'cloud partly sunny','🌧️':'rain cloud','⛈️':'thunder storm','🌪️':'tornado wind','🌸':'cherry blossom flower','🌺':'hibiscus flower','🌻':'sunflower','🌹':'rose flower','🍀':'clover lucky','🌿':'herb plant leaf','🌱':'seedling sprout plant','🌲':'tree','🌴':'palm tree','🍁':'maple leaf fall','🍂':'fallen leaf autumn','💐':'bouquet flowers','🎄':'christmas tree','🌵':'cactus','❌':'x cross no wrong','✅':'check ok yes correct','⚠️':'warning caution','🔴':'red circle','🟢':'green circle','🔵':'blue circle','⚪':'white circle','⚫':'black circle','🔶':'orange diamond','🔷':'blue diamond','▶️':'play','⏸️':'pause','⏹️':'stop','🔁':'repeat loop','🔀':'shuffle random','🔊':'sound loud volume','🔇':'mute silent','🔔':'bell notification','🔕':'no bell mute',
}

// ── Shape geometry â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Returns { halfW, halfH } â€" the bounding half-dimensions of a shape at scale r
// For rect/roundrect, pass label+fontSize to get text-fitted dimensions.
function shapeDims(shape, r, label, fontSize, widthOverride) {
  if ((shape === 'roundrect' || shape === 'rect') && label != null) {
    return getAutoSizeDims(label, fontSize || Math.max(9, Math.round(12 * (r / NODE_R))), widthOverride)
  }
  switch (shape) {
    case '3d':        return { halfW: r * 2.5, halfH: r * 2.5 }
    case 'image':     return { halfW: r * 2.2, halfH: r * 1.6 }
    case 'frame':     return { halfW: r * 4.5, halfH: r * 3.5 }
    case 'container': return { halfW: r * 2.4, halfH: r * 2.4 }
    case 'ellipse':   return { halfW: r * 1.45, halfH: r * 0.9 }
    case 'roundrect': return { halfW: r * 1.5,  halfH: r * 0.85 }
    case 'rect':      return { halfW: r * 1.5,  halfH: r * 0.85 }
    case 'diamond':   return { halfW: r * 1.15, halfH: r * 1.15 }
    case 'none': {
      // No visible body → hug the label text tightly so the hit / drop / selection area sits close to
      // the words instead of a big invisible box. Falls back to the old box when no label is available.
      if (label != null) {
        const fs = fontSize || Math.max(9, Math.round(12 * (r / NODE_R)))
        const parts = String(label || '').split('\n')
        const w = Math.max(0, ...parts.map(p => measureTextWidth(p, fs)))
        return { halfW: Math.max(16, w / 2 + 7), halfH: Math.max(fs * 0.7 + 3, (Math.max(1, parts.length) * fs * 1.3) / 2 + 4) }
      }
      return { halfW: r * 1.2, halfH: r * 0.55 }
    }
    default:          return { halfW: r,         halfH: r }
  }
}

// â"€â"€ Direction-aware clip distance (how far from center to node edge along dir) â"€
function clipDist(shape, halfW, halfH, ux, uy) {
  if (shape === 'none') return 0   // no visible body â€" point straight to center
  if (shape === 'circle') return halfW
  if (shape === 'none') {
    // Text is much smaller than the container box â€" use tighter clip dimensions
    // so arrows terminate near the actual text rather than the invisible bounding box
    const cW = halfW * 0.5   // ~r*0.6: reasonable text half-width
    const cH = halfH * 0.25  // ~r*0.14: approximate single-line text half-height
    const denom = Math.sqrt((ux / cW) ** 2 + (uy / cH) ** 2)
    return denom > 0 ? 1 / denom : cW
  }
  // Ellipse formula works well as approximation for all shapes
  const denom = Math.sqrt((ux / halfW) ** 2 + (uy / halfH) ** 2)
  return denom > 0 ? 1 / denom : halfW
}

// â”€â”€ Shape SVG body â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// strokeDash: 'solid' | 'dashed' | 'dotted' → SVG dasharray (scaled to stroke width)
function dashArray(dash, sw = 1.5) {
  if (dash === 'dashed') return `${Math.max(3, sw * 2.6)},${Math.max(2, sw * 1.8)}`
  if (dash === 'dotted') return `${Math.max(0.4, sw * 0.55)},${Math.max(2, sw * 1.9)}`
  return undefined
}

// A decorated node perimeter (border "treatment") as a closed SVG path, sized to an ellipse (hw×hh).
// Radial radius r(θ) is modulated per style; the fill/stroke of the node are applied to the path.
// Types: jagged · zigzag · wave · petal · scallop · gear · bloom.
function borderFxPath(fx, hw, hh, count, amp) {
  const C = Math.max(3, Math.round(count || 8))
  const A = Math.max(0, Math.min(0.6, amp ?? 0.15))
  const pts = []
  const push = (th, r) => pts.push((hw * r * Math.cos(th)).toFixed(1) + ',' + (hh * r * Math.sin(th)).toFixed(1))
  // Sharp, exact-vertex families (crisp corners):
  if (fx === 'zigzag') {                       // symmetric saw: alternate out/in with straight lines
    const V = C * 2
    for (let i = 0; i < V; i++) push((i / V) * 2 * Math.PI, i % 2 === 0 ? 1 + A : 1 - A)
  } else if (fx === 'star') {                  // pointed star: shallow-count points with deep notches
    const V = C * 2, inner = Math.max(0.15, 1 - A * 1.7)
    for (let i = 0; i < V; i++) push((i / V) * 2 * Math.PI - Math.PI / 2, i % 2 === 0 ? 1 + A : inner)
  } else if (fx === 'jagged') {                // irregular spikes
    const V = C * 2
    for (let i = 0; i < V; i++) { const h = Math.abs(Math.sin(i * 91.7 + C * 7.13) * 43758.5453) % 1; push((i / V) * 2 * Math.PI, 1 + A * h) }
  } else if (fx === 'gear') {                  // square teeth (exact rise/fall so edges are vertical)
    const per = 2 * Math.PI / C
    for (let i = 0; i < C; i++) { const b = i * per; push(b, 1 + A); push(b + per * 0.5 - 1e-4, 1 + A); push(b + per * 0.5, 1); push(b + per - 1e-4, 1) }
  } else {                                     // smooth, densely-sampled families
    const M = Math.max(220, C * 22)
    for (let i = 0; i < M; i++) {
      const th = (i / M) * 2 * Math.PI, s = Math.sin(C * th)
      let r = 1
      if (fx === 'wave') r = 1 + A * s                                   // symmetric crest/trough
      else if (fx === 'petal' || fx === 'scallop') r = 1 + A * Math.abs(s)  // rounded outward bumps
      else if (fx === 'bloom') r = 1 + A * Math.pow(Math.abs(Math.cos(C * th / 2)), 3)
      push(th, r)
    }
  }
  return 'M' + pts.join('L') + 'Z'
}

function ShapeBody({ shape, halfW, halfH, r, fill, stroke, strokeWidth, strokeDash, filter, imageUrl, nodeId }) {
  const dash = dashArray(strokeDash, strokeWidth)
  const cap = strokeDash === 'dotted' ? 'round' : undefined
  if (shape === 'none') return null
  if (shape === 'image') {
    const rx = 8
    return (
      <g filter={filter}>
        {imageUrl ? (
          <>
            <defs>
              <clipPath id={`img-clip-${nodeId}`}>
                <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={rx} />
              </clipPath>
            </defs>
            <image href={imageUrl} x={-halfW} y={-halfH} width={halfW*2} height={halfH*2}
              preserveAspectRatio="xMidYMid slice" clipPath={`url(#img-clip-${nodeId})`}
              style={{ pointerEvents:'none' }} />
            <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={rx}
              fill="none" stroke={stroke || 'rgba(255,255,255,0.15)'} strokeWidth={strokeWidth || 1} />
          </>
        ) : (
          <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={rx}
            fill={fill} stroke={stroke || 'rgba(255,255,255,0.15)'} strokeWidth={strokeWidth || 1}
            strokeDasharray="4,3" />
        )}
      </g>
    )
  }
  if (shape === '3d') {
    // Cube wireframe icon centered, scaled to ~30% of the box
    const s = halfH * 0.3
    return (
      <>
        <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={10} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        <g stroke={stroke || '#3d5a8a'} strokeWidth={1.2} fill="none" opacity={0.6}>
          <rect x={-s} y={-s} width={s*2} height={s*2} rx={2} />
          <rect x={-s+s*0.5} y={-s-s*0.5} width={s*2} height={s*2} rx={2} />
          <line x1={-s} y1={-s} x2={-s+s*0.5} y2={-s-s*0.5} />
          <line x1={s} y1={-s} x2={s+s*0.5} y2={-s-s*0.5} />
          <line x1={s} y1={s} x2={s+s*0.5} y2={s-s*0.5} />
        </g>
      </>
    )
  }
  if (shape === 'roundrect')
    return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={halfH * 0.45} ry={halfH * 0.45} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinecap={cap} />
  if (shape === 'rect')
    return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={0} ry={0} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinecap={cap} />
  if (shape === 'ellipse')
    return <ellipse rx={halfW} ry={halfH} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinecap={cap} filter={filter} />
  if (shape === 'diamond')
    return <polygon points={`0,${-halfH} ${halfW},0 0,${halfH} ${-halfW},0`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinecap={cap} filter={filter} />
  // default: circle
  return <circle r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinecap={cap} filter={filter} />
}

// True if a hex color reads as "light" (so we know whether to contrast with black or white).
function isLightColor(hex) {
  if (typeof hex !== 'string') return false
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (h.length !== 6) return false
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5
}

// Clip shape matching a node's body, for clipping a background image into it.
function shapeClipShape(shape, halfW, halfH, r) {
  switch (shape) {
    case 'ellipse':   return <ellipse rx={halfW} ry={halfH} />
    case 'rect':      return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} />
    case 'roundrect': return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={halfH*0.45} ry={halfH*0.45} />
    case 'image':     return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={8} />
    case 'diamond':   return <polygon points={`0,${-halfH} ${halfW},0 0,${halfH} ${-halfW},0`} />
    case 'none':      return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} />
    default:          return <circle r={r} />   // circle
  }
}

// â"€â"€ Label rendering (foreignObject for word-wrap) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Best practice: use HTML foreignObject inside SVG for text wrapping.
// It scales correctly with SVG zoom transforms in all modern browsers.
function NodeLabel({ label, halfW, halfH, fontSize, textColor }) {
  return (
    <foreignObject x={-halfW} y={-halfH} width={halfW * 2} height={halfH * 2}
      style={{ pointerEvents: 'none', overflow: 'visible' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%',
        color: textColor || '#fff', fontSize, fontFamily: '-apple-system, sans-serif',
        wordBreak: 'break-word', textAlign: 'center', lineHeight: 1.25,
        overflow: 'hidden', userSelect: 'none', whiteSpace: 'pre-wrap',
        textShadow: '0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
      }}>
        {label}
      </div>
    </foreignObject>
  )
}

// ─── Encoding resolvers (shared by render + sim) ──────────────────────────────
// Map a node's property value to a visual channel. Pure; encoded value overrides the
// manual one at the render boundary only (never persisted).
function encodedScaleFor(props, sizeBy, domain) {
  if (!sizeBy || !domain || !props) return null
  const v = Number(props[sizeBy])
  if (!Number.isFinite(v)) return null
  const [mn, mx] = domain
  const t = mx > mn ? (v - mn) / (mx - mn) : 0.5
  return 0.6 + t * 1.8   // scale 0.6 → 2.4
}
function encodedColorFor(props, colorBy, defs) {
  if (!colorBy || !props) return null
  const def = defs.find(d => d.id === colorBy)
  if (!def) return null
  const raw = props[colorBy]
  const optId = Array.isArray(raw) ? raw[0] : raw
  return def.options?.find(o => o.id === optId)?.color || null
}

function alignImages(images, selectedIds, anchor) {
  const sel = images.filter(i => selectedIds.has(i.id))
  if (sel.length === 0) return []
  const x1 = Math.min(...sel.map(i => i.x - i.width / 2))
  const y1 = Math.min(...sel.map(i => i.y - i.height / 2))
  const x2 = Math.max(...sel.map(i => i.x + i.width / 2))
  const y2 = Math.max(...sel.map(i => i.y + i.height / 2))
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
  return sel.map(img => {
    let x = img.x, y = img.y
    if (anchor === 'left')    x = x1 + img.width / 2
    if (anchor === 'centerH') x = cx
    if (anchor === 'right')   x = x2 - img.width / 2
    if (anchor === 'top')     y = y1 + img.height / 2
    if (anchor === 'middleV') y = cy
    if (anchor === 'bottom')  y = y2 - img.height / 2
    return { id: img.id, x, y }
  })
}

function distributeImages(images, selectedIds, axis) {
  const sel = [...images.filter(i => selectedIds.has(i.id))]
    .sort((a, b) => axis === 'H' ? a.x - b.x : a.y - b.y)
  if (sel.length < 3) return []
  const first = axis === 'H' ? sel[0].x : sel[0].y
  const last  = axis === 'H' ? sel[sel.length-1].x : sel[sel.length-1].y
  const step = (last - first) / (sel.length - 1)
  return sel.map((img, i) => ({
    id: img.id,
    ...(axis === 'H' ? { x: first + i * step } : { y: first + i * step }),
  }))
}

// Copy a canvas photo to the OS clipboard. Browsers only reliably accept image/png on the
// clipboard, so anything else is re-encoded via a canvas (loaded through a same-origin blob URL to
// avoid tainting). Returns true on success.
async function copyImageToClipboard(src) {
  if (!src || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false
  try {
    const resp = await fetch(src)
    let blob = await resp.blob()
    if (blob.type !== 'image/png') {
      const url = URL.createObjectURL(blob)
      try {
        blob = await new Promise((resolve, reject) => {
          const im = new Image()
          im.onload = () => {
            const c = document.createElement('canvas')
            c.width = im.naturalWidth || 1; c.height = im.naturalHeight || 1
            c.getContext('2d').drawImage(im, 0, 0)
            c.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/png')
          }
          im.onerror = () => reject(new Error('image load failed'))
          im.src = url
        })
      } finally { URL.revokeObjectURL(url) }
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch (err) {
    console.warn('Copy image failed', err)
    return false
  }
}

function ImageToolbar({ images, selectedImageIds, anchor,
    onGroup, onUngroup, onReorderImage, onAlign, onDistribute, onSetBlur, onSetEdgeBlur, onSetVideoOpt, onCrop, onCopyImage, onSetEffect, onResetEffects, onDuplicate, onDelete }) {
  const [sub, setSub] = useState(null) // null | 'align' | 'video' | 'effects'

  if (selectedImageIds.size === 0 || !anchor) return null
  const sel = images.filter(i => selectedImageIds.has(i.id))
  const count = sel.length
  if (count === 0) return null
  const hasGroupId = sel.some(i => i.groupId)
  const isSingle = count === 1
  const blur = sel[0]?.blur || 0
  const edgeBlur = sel[0]?.edgeBlur || 0
  const vid = isSingle && sel[0]?.type === 'video' ? sel[0] : null
  const isYT = vid?.videoKind === 'youtube'
  const isPhoto = isSingle && !['text', 'video', 'audio', 'link'].includes(sel[0]?.type)

  // Text menu row — matches the canvas right-click menu styling.
  const row = (label, onClick, opts = {}) => (
    <div onClick={onClick}
      onMouseEnter={e => e.currentTarget.style.background = '#23234a'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      style={{ padding: '6px 12px', fontSize: '0.82rem', color: opts.color || '#c5d0ff', cursor: 'pointer',
        whiteSpace: 'nowrap', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span>{label}</span>{opts.right && <span style={{ color: '#8090b8' }}>{opts.right}</span>}
    </div>
  )
  const stepBtn = (label, onClick, color) => (
    <button onClick={onClick} style={{ padding: '0 6px', borderRadius: 4, border: '1px solid #2a3358', background: 'transparent', color: color || '#7b8fcc', cursor: 'pointer', fontSize: 13, lineHeight: 1.6 }}>{label}</button>
  )
  const stepperRow = (label, value, set, max) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px' }}>
      <span style={{ fontSize: '0.82rem', color: '#c5d0ff', flex: 1 }}>{label}</span>
      {stepBtn('–', () => set(Math.max(0, value - 1)))}
      <span style={{ fontSize: '0.75rem', color: value > 0 ? '#88b4e8' : '#7080a0', width: 16, textAlign: 'center' }}>{value}</span>
      {stepBtn('+', () => set(Math.min(max, value + 1)))}
      {value > 0 && stepBtn('×', () => set(0), '#f87171')}
    </div>
  )
  // A number-input row (used for start/end trim seconds). Commits on blur/Enter; blank → 0.
  const numRow = (label, value, onCommit, placeholder) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px' }}>
      <span style={{ fontSize: '0.82rem', color: '#c5d0ff', flex: 1 }}>{label}</span>
      <input type="number" min="0" step="1" defaultValue={value || ''} placeholder={placeholder || '0'}
        onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur() }}
        onBlur={e => { const n = parseFloat(e.target.value); onCommit(Number.isFinite(n) && n > 0 ? n : 0) }}
        style={{ width: 58, background: '#0f0f22', border: '1px solid #2d3a6a', borderRadius: 5, color: '#dbe4ff', fontSize: 12, padding: '3px 6px', outline: 'none' }} />
    </div>
  )
  // A row of preset playback-speed buttons.
  const speedRow = (value, onSet) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px' }}>
      <span style={{ fontSize: '0.82rem', color: '#c5d0ff', flex: 1 }}>Speed</span>
      {[0.5, 1, 1.5, 2].map(sp => (
        <button key={sp} onClick={() => onSet(sp)}
          style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid #2a3358', cursor: 'pointer', fontSize: 11.5,
            background: (value || 1) === sp ? '#3b4db0' : 'transparent', color: (value || 1) === sp ? '#fff' : '#8fa0d8' }}>{sp}×</button>
      ))}
    </div>
  )
  // A checkbox-style toggle row for on/off video options.
  const toggleRow = (label, on, onToggle, hint) => (
    <div onClick={() => onToggle(!on)}
      onMouseEnter={e => e.currentTarget.style.background = '#23234a'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      title={hint || ''}
      style={{ padding: '6px 12px', fontSize: '0.82rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span>{label}</span>
      <span style={{ color: on ? '#6ee7a8' : '#5a6683', fontWeight: 700 }}>{on ? '✓' : '○'}</span>
    </div>
  )
  // A labelled range-slider row (used for image effects). `fmt` renders the live value.
  const sliderRow = (label, value, min, max, step, onSet, fmt) => (
    <div style={{ padding: '5px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#c5d0ff', marginBottom: 3 }}>
        <span>{label}</span><span style={{ color: '#8fa0d8' }}>{fmt ? fmt(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
        onChange={e => onSet(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#5b6af0', cursor: 'pointer' }} />
    </div>
  )

  return (
    <div
      ref={el => clampMenuEl(el, anchor.px, anchor.py, false)}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: anchor.px, top: anchor.py,
        background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8,
        padding: 4, display: 'flex', flexDirection: 'column', minWidth: 168,
        zIndex: 25, boxShadow: '0 6px 20px rgba(0,0,0,0.7)',
      }}
    >
      {sub === 'align' ? (<>
        {row('‹ Align & distribute', () => setSub(null), { color: '#8090b8' })}
        {row('Align left', () => onAlign('left'))}
        {row('Align center', () => onAlign('centerH'))}
        {row('Align right', () => onAlign('right'))}
        {row('Align top', () => onAlign('top'))}
        {row('Align middle', () => onAlign('middleV'))}
        {row('Align bottom', () => onAlign('bottom'))}
        {count >= 3 && row('Distribute horizontally', () => onDistribute('H'))}
        {count >= 3 && row('Distribute vertically', () => onDistribute('V'))}
      </>) : sub === 'video' && vid ? (<>
        {row('‹ Video options', () => setSub(null), { color: '#8090b8' })}
        {toggleRow('Autoplay', !!vid.autoplay, v => onSetVideoOpt(vid.id, { autoplay: v, ...(v && vid.muted === undefined ? { muted: true } : {}) }), 'Plays on its own — great for slides. Browsers only autoplay muted video.')}
        {toggleRow('Loop', !!vid.loop, v => onSetVideoOpt(vid.id, { loop: v }))}
        {toggleRow('Muted', !!vid.muted, v => onSetVideoOpt(vid.id, { muted: v }), 'Turn off to allow sound (autoplay may not fire with sound on).')}
        {toggleRow('Show controls', vid.controls !== false, v => onSetVideoOpt(vid.id, { controls: v }))}
        {isYT && toggleRow('Hide related & branding', !!vid.hideRelated, v => onSetVideoOpt(vid.id, { hideRelated: v }), 'Suppresses end-screen related videos, annotations, and the YouTube logo. (Pre-roll ads can’t be removed via embedding.)')}
        <div style={{ borderTop: '1px solid #23234a', margin: '4px 8px' }} />
        {numRow('Start (s)', vid.start, v => onSetVideoOpt(vid.id, { start: v }), '0')}
        {numRow('End (s)', vid.end, v => onSetVideoOpt(vid.id, { end: v }), 'end')}
        {speedRow(vid.speed, sp => onSetVideoOpt(vid.id, { speed: sp }))}
      </>) : sub === 'effects' && isPhoto ? (() => {
        const ph = sel[0]
        const op = ph.opacity == null ? 1 : ph.opacity
        const tint = ph.tint || {}
        const tintOn = tint.amount > 0
        return (<>
          {row('‹ Effects', () => setSub(null), { color: '#8090b8' })}
          {sliderRow('Transparency', op, 0, 1, 0.01, v => onSetEffect({ opacity: v }), v => `${Math.round(v * 100)}%`)}
          <div style={{ borderTop: '1px solid #23234a', margin: '4px 8px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px' }}>
            <span style={{ fontSize: '0.8rem', color: '#c5d0ff', flex: 1 }}>Colorize</span>
            <input type="color" value={tint.color || '#5b6af0'}
              onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
              onChange={e => onSetEffect({ tint: { color: e.target.value, amount: tint.amount > 0 ? tint.amount : 0.6 } })}
              style={{ width: 26, height: 22, padding: 0, border: '1px solid #2d3a6a', borderRadius: 4, background: 'transparent', cursor: 'pointer' }} />
            {tintOn && <button onClick={() => onSetEffect({ tint: null })}
              style={{ padding: '0 6px', borderRadius: 4, border: '1px solid #2a3358', background: 'transparent', color: '#f87171', cursor: 'pointer', fontSize: 13 }}>×</button>}
          </div>
          {sliderRow('Strength', tint.amount || 0, 0, 1, 0.01,
            v => onSetEffect({ tint: v > 0 ? { color: tint.color || '#5b6af0', amount: v } : null }),
            v => `${Math.round(v * 100)}%`)}
          <div style={{ borderTop: '1px solid #23234a', margin: '4px 8px' }} />
          {row('Reset effects', () => onResetEffects?.(), { color: '#8fa0d8' })}
        </>)
      })() : (<>
        {isSingle && row('Bring forward', () => onReorderImage(sel[0].id, 'up'))}
        {isSingle && row('Send backward', () => onReorderImage(sel[0].id, 'down'))}
        {count >= 2 && row('Group', onGroup, { right: 'Ctrl+G' })}
        {hasGroupId && row('Ungroup', onUngroup, { right: '⇧Ctrl+G' })}
        {count >= 2 && row('Align & distribute', () => setSub('align'), { right: '›' })}
        {vid && row('Video options', () => setSub('video'), { right: '›' })}
        {isPhoto && row('Effects', () => setSub('effects'), { right: '›' })}
        {isPhoto && row('Copy image', () => onCopyImage?.(sel[0]))}
        {isSingle && !vid && row('Crop', onCrop)}
        {isSingle && !vid && stepperRow('Blur', blur, onSetBlur, 40)}
        {isSingle && !vid && stepperRow('Edge blur', edgeBlur, onSetEdgeBlur, 40)}
        {row(count >= 2 ? '⧉ Duplicate all' : '⧉ Duplicate', () => onDuplicate?.())}
        {row('Delete', onDelete, { color: '#f87171' })}
      </>)}
    </div>
  )
}

// Frame "stages" (build steps) panel — appears when a frame is selected. Capture the current
// arrangement as a stage, list/rename/reorder/delete stages, and step through them (preview overlay).
function FrameStagesPanel({ stages, activeIdx, previewing, onCapture, onDelete, onRename, onReorder, onPreview, onStep, onExit }) {
  const sBtn = { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: '4px 9px', whiteSpace: 'nowrap' }
  const sMini = { background: 'transparent', border: 'none', color: '#8fa0d8', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '1px 3px' }
  return (
    <div onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
      style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 40, width: 230, background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 10, boxShadow: '0 10px 34px rgba(0,0,0,0.55)', fontFamily: '-apple-system, sans-serif', color: '#c5d0ff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #20233f' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>🎬 Frame stages</span>
        <span style={{ flex: 1 }} />
        {previewing && <button onClick={onExit} style={sBtn} title="Stop previewing, restore the frame">Exit</button>}
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto', padding: '4px 0' }}>
        {stages.length === 0 && <div style={{ padding: '8px 12px', fontSize: 12, color: '#8090b8', lineHeight: 1.4 }}>No stages yet. Arrange the frame (hide/move/collapse elements), then <b>Capture</b>.</div>}
        {stages.map((s, i) => {
          const count = Object.keys(s.snap || {}).length
          return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '3px 8px', background: activeIdx === i ? '#1e2547' : 'transparent' }}>
            <span style={{ width: 16, textAlign: 'right', color: '#7c8cff', fontSize: 11, flexShrink: 0 }}>{i + 1}</span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <EditableText value={s.name} onCommit={n => onRename(i, n)} style={{ fontSize: 12.5, color: '#dbe4ff', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title="Double-click to rename" />
              <span style={{ fontSize: 10.5, color: count ? '#8090b8' : '#f0a05a', flexShrink: 0 }} title={count ? `${count} elements captured` : 'Empty — nothing was inside the frame when captured'}>{count || '∅'}</span>
            </span>
            <button title="Preview this stage" onClick={() => onPreview(i)} style={sMini}>▶</button>
            <button title="Move up" onClick={() => onReorder(i, -1)} style={sMini}>▲</button>
            <button title="Move down" onClick={() => onReorder(i, 1)} style={sMini}>▼</button>
            <button title="Delete stage" onClick={() => onDelete(i)} style={{ ...sMini, color: '#f87171' }}>×</button>
          </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderTop: '1px solid #20233f' }}>
        <button onClick={onCapture} style={sBtn} title="Snapshot the current arrangement as a new stage">＋ Capture</button>
        <span style={{ flex: 1 }} />
        {stages.length > 0 && (<>
          <button onClick={() => onStep(-1)} style={sMini} title="Previous (←)">◀</button>
          <span style={{ fontSize: 12, minWidth: 30, textAlign: 'center' }}>{previewing ? activeIdx + 1 : '–'}/{stages.length}</span>
          <button onClick={() => onStep(1)} style={sMini} title="Next (→)">▶</button>
        </>)}
      </div>
    </div>
  )
}

// On-frame "builds" timeline — a screen-space strip pinned under the frame (clamped to the viewport so
// it's always usable at any zoom). Markers = stages: click to edit, drag to reorder, double-click to
// rename, × to delete; the badge sets each stage's advance trigger (click vs timed). Editing the frame's
// contents auto-records into the current stage (parent wires that up), so there's no Capture button.
function FrameTimeline({ rect, frameName, stages, currentIdx, playing, recordPulse,
  onGoto, onAdd, onDelete, onRename, onReorder, onSetAdvance, onSetSpeed, onPlay, onStop, onNext, onExit, onRefit,
  onSetCam, onFrameSelectionCam, onGotoCam, onClearCam, onSetFade }) {
  const [editingIdx, setEditingIdx] = useState(null)
  const [advOpen, setAdvOpen] = useState(null)
  const [camOpen, setCamOpen] = useState(null)
  const [drag, setDrag] = useState(null)   // { from, x } while dragging a marker
  const [pulse, setPulse] = useState(false)
  const stripRef = useRef(null)
  useEffect(() => { if (!recordPulse) return; setPulse(true); const t = setTimeout(() => setPulse(false), 700); return () => clearTimeout(t) }, [recordPulse])

  const H = 46
  const padL = 14, padR = 128   // left inset for the first marker; right room for the controls
  const pitch = 38               // fixed spacing — markers grow LEFT→RIGHT like typing a word
  const n = stages.length
  const markerX = (i) => padL + i * pitch

  const startDrag = (e, i) => {
    e.stopPropagation(); e.preventDefault()
    const startX = e.clientX
    const onMove = (ev) => setDrag({ from: i, x: ev.clientX - rect.left })
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
      const dropX = ev.clientX - rect.left
      const to = Math.max(0, Math.min(n - 1, Math.round((dropX - padL) / pitch)))
      const moved = Math.abs(ev.clientX - startX) > 6
      setDrag(null)
      if (moved && to !== i) onReorder(i, to)
      else onGoto(i)   // treat as a click
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }

  const dot = '#5b6af0', dotOn = '#8ea2ff'
  return (
    <div ref={stripRef} title={frameName ? `Stages · ${frameName}` : 'Stages'} onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
      style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: H, zIndex: 60,
        background: '#12122aee', border: '1px solid #2d3a6a', borderRadius: 10, backdropFilter: 'blur(6px)',
        boxShadow: '0 8px 26px rgba(0,0,0,0.55)', fontFamily: '-apple-system, sans-serif', color: '#c5d0ff',
        overflow: 'visible', userSelect: 'none' }}>
      {/* Track line — from the first marker to the last (left-aligned run) */}
      {n > 1 && <div style={{ position: 'absolute', left: markerX(0), width: markerX(n - 1) - markerX(0), top: H / 2 - 1, height: 2, background: '#2f3a68', borderRadius: 2 }} />}

      {/* Markers */}
      {stages.map((s, i) => {
        const cx = drag && drag.from === i ? drag.x : markerX(i)
        const on = i === currentIdx
        const timed = s.advance && typeof s.advance === 'object' && s.advance.after > 0
        return (
          <div key={s.id} style={{ position: 'absolute', left: cx, top: 0, height: H, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, zIndex: drag && drag.from === i ? 3 : 1 }}>
            {editingIdx === i ? (
              <input autoFocus defaultValue={s.name}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { onRename(i, e.currentTarget.value); setEditingIdx(null) } else if (e.key === 'Escape') setEditingIdx(null) }}
                onBlur={e => { onRename(i, e.currentTarget.value); setEditingIdx(null) }}
                style={{ width: 78, fontSize: 11, textAlign: 'center', background: '#0c0c1a', color: '#dbe4ff', border: '1px solid #3a4a8a', borderRadius: 5, padding: '2px 4px' }} />
            ) : (<>
              <div onMouseDown={e => startDrag(e, i)} onDoubleClick={e => { e.stopPropagation(); setEditingIdx(i) }}
                title={`${s.name} — click to edit · double-click to rename · drag to reorder`}
                style={{ cursor: 'grab', width: on ? 20 : 15, height: on ? 20 : 15, borderRadius: '50%', background: on ? dotOn : '#12122a', border: `2px solid ${on ? dotOn : dot}`, boxShadow: on ? `0 0 0 3px ${dot}44` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all .12s' }}>
                {on && pulse ? <span style={{ fontSize: 10, color: '#0c0c1a' }}>●</span> : <span style={{ fontSize: 9, color: on ? '#0c0c1a' : '#9aa8d8', fontWeight: 700 }}>{i + 1}</span>}
              </div>
              {/* Advance-trigger badge below the dot (skip stage 1 — the start pose) */}
              {i > 0 && (
                <button onClick={e => { e.stopPropagation(); setAdvOpen(advOpen === i ? null : i) }}
                  title="How this stage begins — click to change"
                  style={{ background: timed ? '#2a2036' : '#171c3f', border: `1px solid ${advOpen === i ? '#8ea2ff' : (timed ? '#6b4a1a' : '#2d3a6a')}`, borderRadius: 8, padding: '1px 7px', fontSize: 9.5, lineHeight: 1.5, color: timed ? '#f6ad55' : '#9fb0e8', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {timed ? `⏱ ${s.advance.after}s` : '▸ click'}
                </button>
              )}
              {/* Camera badge (every stage) — set a focus shot for this build step */}
              <button onClick={e => { e.stopPropagation(); setCamOpen(camOpen === i ? null : i) }}
                title={s.cam ? 'Camera set for this stage — click to edit' : 'Set a camera focus for this stage'}
                style={{ background: s.cam ? '#171c3f' : 'transparent', border: `1px solid ${camOpen === i ? '#8ea2ff' : (s.cam ? '#5b6af0' : '#2d3a6a')}`, borderRadius: 8, padding: '1px 6px', fontSize: 9.5, lineHeight: 1.5, color: s.cam ? '#8ea2ff' : '#7c86ad', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                📷{s.cam ? '' : '+'}
              </button>
              {/* Delete — small × above the dot */}
              {n > 1 && (
                <button onClick={e => { e.stopPropagation(); onDelete(i) }} title="Delete stage"
                  style={{ position: 'absolute', top: 1, right: -7, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 10, color: '#f87171', padding: 0, opacity: 0.7 }}>×</button>
              )}
            </>)}
            {/* Advance popover — with a click-away backdrop so it always dismisses */}
            {advOpen === i && (<>
              <div onMouseDown={e => { e.stopPropagation(); setAdvOpen(null) }} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
              <div onMouseDown={e => e.stopPropagation()} style={{ position: 'absolute', bottom: H + 2, left: '50%', transform: 'translateX(-50%)', zIndex: 71, background: '#0c0c1a', border: '1px solid #3a4a8a', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, width: 214, boxShadow: '0 12px 30px rgba(0,0,0,.65)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: '#9fb0e8' }}>Stage {i + 1} begins</span>
                  <button onClick={() => setAdvOpen(null)} title="Close" style={{ background: 'transparent', border: 'none', color: '#8ea2ff', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
                </div>
                <button onClick={() => { onSetAdvance(i, 'click'); setAdvOpen(null) }}
                  style={{ textAlign: 'left', fontSize: 12, color: !timed ? '#dbe4ff' : '#9fb0e8', background: !timed ? '#1e2547' : '#12122a', border: `1px solid ${!timed ? '#5b6af0' : '#2d3a6a'}`, borderRadius: 7, padding: '8px 10px', cursor: 'pointer' }}>▸ On click / key</button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: timed ? '#1e2547' : '#12122a', border: `1px solid ${timed ? '#5b6af0' : '#2d3a6a'}`, borderRadius: 7, padding: '6px 8px' }}>
                  <span style={{ fontSize: 12, color: timed ? '#f6ad55' : '#9fb0e8', flex: 1 }}>⏱ After {timed ? s.advance.after : 1}s</span>
                  <button onClick={() => onSetAdvance(i, { after: Math.max(0.5, (timed ? s.advance.after : 1) - 0.5) })} style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid #2d3a6a', background: '#171c3f', color: '#c5d0ff', cursor: 'pointer', fontSize: 15 }}>−</button>
                  <button onClick={() => onSetAdvance(i, { after: (timed ? s.advance.after : 1) + 0.5 })} style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid #2d3a6a', background: '#171c3f', color: '#c5d0ff', cursor: 'pointer', fontSize: 15 }}>+</button>
                </div>
                {/* Transition speed — how fast the move/morph INTO this stage plays */}
                <div style={{ borderTop: '1px solid #20233f', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 11, color: '#9fb0e8' }}>Transition speed</span>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {[['Instant', 0], ['Fast', 180], ['Normal', 340], ['Slow', 700], ['Slower', 1200]].map(([label, ms]) => {
                      const cur = s.dur != null ? s.dur : 340
                      const on = cur === ms
                      return (
                        <button key={label} onClick={() => onSetSpeed(i, ms === 340 ? undefined : ms)}
                          style={{ fontSize: 10.5, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', color: on ? '#dbe4ff' : '#9fb0e8', background: on ? '#1e2547' : '#12122a', border: `1px solid ${on ? '#5b6af0' : '#2d3a6a'}` }}>{label}</button>
                      )
                    })}
                  </div>
                </div>
                {/* Show/hide style — cut (instant) vs fade */}
                <div style={{ borderTop: '1px solid #20233f', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 11, color: '#9fb0e8' }}>Show / hide</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[['Cut', false], ['Fade', true]].map(([label, val]) => {
                      const on = !!s.fade === val
                      return (
                        <button key={label} onClick={() => onSetFade?.(i, val)}
                          style={{ fontSize: 10.5, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', color: on ? '#dbe4ff' : '#9fb0e8', background: on ? '#1e2547' : '#12122a', border: `1px solid ${on ? '#5b6af0' : '#2d3a6a'}` }}>{label}</button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </>)}
            {/* Camera popover */}
            {camOpen === i && (<>
              <div onMouseDown={e => { e.stopPropagation(); setCamOpen(null) }} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
              <div onMouseDown={e => e.stopPropagation()} style={{ position: 'absolute', bottom: H + 2, left: '50%', transform: 'translateX(-50%)', zIndex: 71, background: '#0c0c1a', border: '1px solid #3a4a8a', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 7, width: 218, boxShadow: '0 12px 30px rgba(0,0,0,.65)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: '#9fb0e8' }}>📷 Stage {i + 1} camera</span>
                  <button onClick={() => setCamOpen(null)} title="Close" style={{ background: 'transparent', border: 'none', color: '#8ea2ff', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
                </div>
                <div style={{ fontSize: 10.5, color: '#7c86ad', lineHeight: 1.4 }}>
                  {s.cam ? 'A custom shot is set — the view moves here on this step.' : (i > 0 ? 'Inherits the previous camera. Set one to move the shot here.' : 'No camera — fits the whole frame. Set one for the opening shot.')}
                </div>
                <button onClick={() => onSetCam(i)} style={camBtn}>📷 Set to current view</button>
                <button onClick={() => onFrameSelectionCam(i)} style={camBtn}>▢ Frame selected elements</button>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => onGotoCam(i)} style={{ ...camBtn, flex: 1 }}>⤢ Go to</button>
                  {s.cam && <button onClick={() => { onClearCam(i); setCamOpen(null) }} style={{ ...camBtn, flex: 1, color: '#f0a0a0', borderColor: '#5a2a3a' }}>Clear</button>}
                </div>
              </div>
            </>)}
          </div>
        )
      })}

      {/* + add stage, just past the last marker */}
      <button onClick={e => { e.stopPropagation(); onAdd() }} title="Add a stage (clones the current pose)"
        style={{ position: 'absolute', left: markerX(n - 1) + 30, top: H / 2 - 13, width: 26, height: 26, borderRadius: '50%', border: '1.5px dashed #3a4a8a', background: '#12122a', color: '#8ea2ff', cursor: 'pointer', fontSize: 15, lineHeight: '22px' }}>+</button>

      {/* Right controls */}
      <div style={{ position: 'absolute', right: 10, top: 0, height: H, display: 'flex', alignItems: 'center', gap: 6 }}>
        {!playing ? (
          <button onClick={e => { e.stopPropagation(); onPlay() }} title="Play the builds" style={ctrlBtn}>▶</button>
        ) : (<>
          <button onClick={e => { e.stopPropagation(); onNext() }} title="Next (→ / space)" style={ctrlBtn}>⏭</button>
          <button onClick={e => { e.stopPropagation(); onStop() }} title="Stop playing" style={ctrlBtn}>⏹</button>
        </>)}
        <button onClick={e => { e.stopPropagation(); onRefit() }} title="Re-fit the frame" style={ctrlBtn}>⛶</button>
        <button onClick={e => { e.stopPropagation(); onExit() }} title="Done (Esc)" style={{ ...ctrlBtn, color: '#f0a0a0' }}>✕</button>
      </div>
    </div>
  )
}
const ctrlBtn = { width: 28, height: 28, borderRadius: 7, border: '1px solid #2d3a6a', background: '#1a1f4a', color: '#c5d0ff', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }
const camBtn = { textAlign: 'left', fontSize: 11.5, color: '#c5d0ff', background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 7, padding: '6px 9px', cursor: 'pointer' }

// A cascading submenu row: hovering it opens the child panel to the side; leaving the row+panel closes
// it after a short delay (standard cascading-menu behavior). The panel flips to the left near the screen edge.
function MenuFlyout({ icon, label, children, minWidth = 168 }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)   // { left, top } in viewport (fixed) coords
  const rowRef = useRef(null)
  const flyRef = useRef(null)
  const timer = useRef(null)
  const enter = () => { clearTimeout(timer.current); setOpen(true) }
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 260) }
  // Position the submenu with `position: fixed` off the row's rect so it escapes any
  // ancestor with `overflow` clipping (e.g. a scrollable menu) instead of being cut off.
  useLayoutEffect(() => {
    if (!open || !rowRef.current) { setPos(null); return }
    const rr = rowRef.current.getBoundingClientRect()
    const fr = flyRef.current?.getBoundingClientRect()
    const fw = fr?.width || minWidth
    const fh = fr?.height || 0
    const flip = rr.right + fw + 6 > window.innerWidth - 8
    const left = flip ? Math.max(8, rr.left - fw - 3) : rr.right + 3
    let top = rr.top - 5
    if (fh && top + fh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - fh)
    setPos({ left, top })
  }, [open]) // eslint-disable-line
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <div ref={rowRef} style={{ position: 'relative' }} onMouseEnter={enter} onMouseLeave={leave}>
      <div style={{ padding: '6px 12px', fontSize: '0.82rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 16, background: open ? '#23234a' : 'transparent' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {icon && <span style={{ width: 16, textAlign: 'center', fontSize: '0.88rem', opacity: 0.9, flexShrink: 0 }}>{icon}</span>}
          <span>{label}</span>
        </span>
        <span style={{ color: '#8090b8' }}>›</span>
      </div>
      {open && (
        <div ref={flyRef} onMouseEnter={enter} onMouseLeave={leave}
          style={{ position: 'fixed', left: pos ? pos.left : -9999, top: pos ? pos.top : -9999,
            visibility: pos ? 'visible' : 'hidden', zIndex: 60,
            background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 4, boxShadow: '0 6px 20px rgba(0,0,0,0.7)', minWidth, maxHeight: '80vh', overflowY: 'auto', overflowX: 'hidden' }}>
          {children}
        </div>
      )}
    </div>
  )
}

export default function Graph({ projectId, projectName, readOnly = false, sharedData = null }) {
  const svgRef = useRef()
  const simRef = useRef(null)
  const zoomBehaviorRef = useRef(null)
  const zoomFilterRef = useRef(null)
  const simNodesRef = useRef([])
  const simEdgesRef = useRef([])
  const zoomTransformRef = useRef(d3.zoomIdentity)
  const frameRef = useRef(null)
  const [tick, setTick] = useState(0)
  const [connecting, setConnecting] = useState(null)
  const [selected, setSelected] = useState(null)
  const selectedRef = useRef(null)
  useEffect(() => { selectedRef.current = selected }, [selected])
  // Publish node selection to the shared channel so the docked outliner can follow along.
  // NB: `setSelectedNodeId` (a stable zustand action) is intentionally NOT in the deps array — it's
  // declared later in this component, and referencing it here would be a TDZ crash on mount.
  useEffect(() => { if (selected?.type === 'node') { useGraphStore.getState().setSelectedNodeId(selected.id); useGraphStore.getState().setNavFocusNodeId(null) } }, [selected])
  const [hoveredNodeId, setHoveredNodeId] = useState(null)
  const [isPanning, setIsPanning] = useState(false)
  const [depthExpand, setDepthExpand] = useState(null) // null = off, { nodeId, radius } = expand from node
  const [showBgPicker, setShowBgPicker] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [keepEditId, setKeepEditId] = useState(null)
  const canvasFocused = useRef(true)
  const hideTimerRef = useRef(null)
  const showTimerRef = useRef(null)
  const hoveredNodeIdRef = useRef(null)
  const panSaveTimerRef = useRef(null)
  const [notePopupId, setNotePopupId] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null) // nodeId or null
  const [confirmDeleteImage, setConfirmDeleteImage] = useState(null) // imageId or null
  const [confirmDeleteImages, setConfirmDeleteImages] = useState(null) // string[] | null
  const [confirmDeleteNodes, setConfirmDeleteNodes] = useState(null)   // string[] | null (multi-node)
  const [propFilter, setPropFilter] = useState(null)    // { propId, value } — non-destructive graph filter
  const [organize, setOrganize] = useState(null)        // { groupBy } — force-cluster ("pack") by a property
  const [organizeGroups, setOrganizeGroups] = useState([]) // computed group bubbles for rendering
  const organizeTargetsRef = useRef({})                 // { nodeId: {x,y} } target centroid per node
  const organizeActiveRef = useRef(false)
  const organizeRef = useRef(null)                      // mirrors `organize` for drag handler (no stale closure)
  organizeRef.current = organize
  const organizeGroupsRef = useRef([])                  // mirrors `organizeGroups` for drop-to-reassign
  organizeGroupsRef.current = organizeGroups
  const organizeSessionRef = useRef(null)               // anchored world centre, per session
  const organizeAnimRef = useRef(0)                     // rAF id for the glide-to-packed-layout tween
  const [searchOpen, setSearchOpen] = useState(false)   // Cmd/Ctrl+K node spotlight
  const [searchQuery, setSearchQuery] = useState('')
  const [outlineSearch, setOutlineSearch] = useState('')   // real-time filter: greys out non-matches (outline + canvas)
  const [searchIdx, setSearchIdx] = useState(0)          // highlighted result index
  const searchInputRef = useRef(null)
  // autoFocus can be missed (the global key handler that opened the spotlight still holds focus, or the
  // overlay mounts a tick later), so grab focus explicitly whenever the spotlight opens.
  useEffect(() => { if (searchOpen) { const t = setTimeout(() => searchInputRef.current?.focus(), 20); return () => clearTimeout(t) } }, [searchOpen])
  const [pendingEditId, setPendingEditId] = useState(null)
  const [selectedImageIds, setSelectedImageIds] = useState(new Set())
  const [drilledImageId, setDrilledImageId] = useState(null)
  const [selectedNodeIds, setSelectedNodeIds] = useState(new Set())   // multi-node selection (rubber-band)
  const selectedNodeIdsRef = useRef(selectedNodeIds)
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds }, [selectedNodeIds])
  const selectedImageIdsRef = useRef(selectedImageIds)   // live mirror for drag handlers
  useEffect(() => { selectedImageIdsRef.current = selectedImageIds }, [selectedImageIds])
  const [cropImageId, setCropImageId] = useState(null)   // free-floating image in crop mode (single)
  const [newNodeAt, setNewNodeAt] = useState(null)       // { px, py, sx, sy } floating new-node name input
  const [contextMenu, setContextMenu] = useState(null)   // { px, py, sx, sy } right-click menu (only on click, not drag)
  const [ctxColors, setCtxColors] = useState(false)      // context-menu background-color submenu open
  const [ctxPanel, setCtxPanel] = useState(null)         // context-menu submenu: null | 'insert' | 'video' | 'audio'
  const [bulkMenu, setBulkMenu] = useState(null)         // { px, py, ids } right-click menu for a multi-selection
  const [bulkPanel, setBulkPanel] = useState(null)       // 'color' | 'shape' submenu open in the bulk menu
  const [showExport, setShowExport] = useState(false)    // export-to-PDF/Word dialog
  const [showFlowchart, setShowFlowchart] = useState(false)  // flowchart text⇄graph panel
  const [nodeMenu, setNodeMenu] = useState(null)         // { nodeId, px, py } right-click node menu
  const [dupGhost, setDupGhost] = useState(null)         // alt-drag duplicate: translucent preview { x, y, label, fill, shape, scale }
  const [dupChildrenPrompt, setDupChildrenPrompt] = useState(null) // { srcId, newId, cx, cy } after alt-drop when source has children
  const [floatDock, setFloatDock] = useState(() => { try { return localStorage.getItem('pim_style_undock') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('pim_style_undock', floatDock ? '1' : '0') } catch { /* ignore */ } }, [floatDock])
  const [floatRect, setFloatRect] = useState(() => { try { return JSON.parse(localStorage.getItem('pim_style_floatpos') || 'null') || { x: 80, y: 90 } } catch { return { x: 80, y: 90 } } })
  useEffect(() => { try { localStorage.setItem('pim_style_floatpos', JSON.stringify(floatRect)) } catch { /* ignore */ } }, [floatRect])
  // Keyboard-navigation camera: how close the arrow-key nav zooms when a single node is framed.
  // No settings page yet, so it's a persisted pref (tunable live with [ and ] while navigating).
  const [navZoom, setNavZoom] = useState(() => { try { return Math.max(1.2, Math.min(10, +localStorage.getItem('pim_nav_zoom') || 2.2)) } catch { return 2.2 } })
  useEffect(() => { try { localStorage.setItem('pim_nav_zoom', String(navZoom)) } catch { /* ignore */ } }, [navZoom])
  const navZoomRef = useRef(navZoom); useEffect(() => { navZoomRef.current = navZoom }, [navZoom])
  const navDepthRef = useRef(0)     // generations below the focused node to keep in frame (Shift+↓/↑ changes it)
  const navFocusRef = useRef(null)  // current node for keyboard nav — decoupled from selection (nav only pans/zooms)
  const navOutRef = useRef(0)       // zoom-out ladder level once you press ↑ past a root (0 = not laddering)
  const zoomNavRef = useRef(null)   // holds zoomToNodeDepth (defined later) so the key handler avoids a TDZ dep
  const zoomForestRef = useRef(null) // holds zoomToForest (defined later) for the ↑-past-root zoom-out ladder
  const [navHud, setNavHud] = useState(null)   // { depth, zoom } transient indicator during keyboard nav
  const navHudTimer = useRef(null)
  const showNavHud = useCallback((depth) => {
    setNavHud({ depth, zoom: navZoomRef.current })
    clearTimeout(navHudTimer.current)
    navHudTimer.current = setTimeout(() => setNavHud(null), 1900)
  }, [])
  // Clicking/selecting a node seeds the nav focus there; arrow-nav then moves the focus (pan/zoom only)
  // WITHOUT changing the selection, so navigating doesn't pop the node toolbar on every hop.
  useEffect(() => { if (selected?.type === 'node') { navFocusRef.current = selected.id; navOutRef.current = 0 } }, [selected])
  // While the style panel is undocked, keep it targeted on the currently selected node (so a plain
  // left-click retargets the floating window, not just a right-click).
  useEffect(() => {
    if (!floatDock) return
    if (selected?.type === 'node') setNodeMenu(m => (m?.nodeId === selected.id ? m : { nodeId: selected.id, px: 0, py: 0 }))
  }, [floatDock, selected])
  const [photoMenu, setPhotoMenu] = useState(null)       // { px, py } right-click photo menu (acts on current selection)
  const [rubberBand, setRubberBand] = useState(null) // { sx, sy, ex, ey } in canvas coords | null
  const rubberBandRef = useRef(null)
  const didRubberBandRef = useRef(false)   // set after a rubber-band drag so the trailing click doesn't clear it
  const [zoomTick, setZoomTick] = useState(0) // eslint-disable-line no-unused-vars

  // Expand a plain click to select the image's whole group (unless that image is drilled)
  const expandGroup = useCallback((imageId, images, drilled) => {
    if (imageId === drilled) return [imageId]
    const img = images.find(i => i.id === imageId)
    if (!img?.groupId) return [imageId]
    return images.filter(i => i.groupId === img.groupId).map(i => i.id)
  }, [])

  const [dragHoverNodeId, setDragHoverNodeId] = useState(null)
  const dragHoverNodeIdRef = useRef(null)
  const [movingIds, setMovingIds] = useState(null)   // nodes being dragged as a group (highlighted while moving)
  // Draw / Slides / Views toggles live in the store so the nav "View" menu (App.jsx) can drive them too.
  const showSlideSidebar = useGraphStore(s => s.showSlideSidebar)
  const setShowSlideSidebar = useGraphStore(s => s.setShowSlideSidebar)
  const showDraw = useGraphStore(s => s.showDraw)               // drawing palette (right panel, tabbed w/ slides)
  const setShowDraw = useGraphStore(s => s.setShowDraw)
  const showViews = useGraphStore(s => s.showViews)
  const setShowViews = useGraphStore(s => s.setShowViews)
  const [selectedDrawingId, setSelectedDrawingId] = useState(null)
  const [dragDraw, setDragDraw] = useState(null)                // { kind, defaults, ghost:{x,y} } while dragging from palette
  const [hideFrameOutlines, setHideFrameOutlines] = useState(false)
  // Auto-hide frame outlines after zooming to a frame (thumbnail click), until the next real pan/zoom.
  const [autoHideFrames, setAutoHideFrames] = useState(false)
  const prevFrameCountRef = useRef(0)
  const [presentingSlideIdx, setPresentingSlideIdx] = useState(null)
  const presentingSlideIdxRef = useRef(null)
  const slideNavFocusRef = useRef(false)   // true when the slide sidebar was the last thing clicked → arrows scrub slides
  const slideCursorRef = useRef(0)         // which slide the arrow-scrub cursor is on (edit mode, not presenting)
  const presentStageIdxRef = useRef(0)     // which build/stage of the current slide is showing while presenting
  const [presentStageIdx, setPresentStageIdx] = useState(0)   // reactive mirror for the footer counter
  const setPresentStage = (i) => { presentStageIdxRef.current = i; setPresentStageIdx(i) }
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const liveThumbsRef = useRef({}) // nodeId → latest PNG data URL; updated immediately on capture
  const [fullscreen3dId, setFullscreen3dId] = useState(null)

  useEffect(() => { hoveredNodeIdRef.current = hoveredNodeId }, [hoveredNodeId])

  const showToolbar = useCallback((nodeId) => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null }
    if (hoveredNodeIdRef.current === nodeId) return // already showing — avoid remount/flicker
    // Debounce switching to a different node so briefly passing over a neighbor
    // (e.g. on the way to a toolbar's sub-menu) doesn't steal the popup.
    showTimerRef.current = setTimeout(() => setHoveredNodeId(nodeId), 110)
  }, [])
  const hideToolbar = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null }
    hideTimerRef.current = setTimeout(() => setHoveredNodeId(null), 550)
  }, [])

  const loadProjectData   = useGraphStore(s => s.loadProjectData)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState('saved')
  // Frame stages ("build steps"): preview overlay is view-only (never touches the store). stagePreview
  // = { frameId, idx } while stepping; stageOverlay = { vis:{[id]:bool}, collapse:{[id]:bool} } applied
  // to visibleNodeIds; stageBasePosRef remembers member positions to restore on exit.
  const [stagePreview, setStagePreview] = useState(null)
  const [stageOverlay, setStageOverlay] = useState(null)
  const stageOverlayRef = useRef(null)
  useEffect(() => { stageOverlayRef.current = stageOverlay }, [stageOverlay])
  const stageBasePosRef = useRef(null)
  // Image stage overlay: view-only per-image {x,y,width,height,opacity,tint} applied during stage
  // play/preview/presentation so photos animate (move/scale/fade/colorize) without touching the doc.
  const [imageStageOverlay, setImageStageOverlay] = useState(null)
  const imageStageOverlayRef = useRef(null)
  useEffect(() => { imageStageOverlayRef.current = imageStageOverlay }, [imageStageOverlay])
  const imgAnimRunRef = useRef(0)
  // On-frame timeline ("builds") editor: keyframe model — the canvas shows the current stage and edits
  // auto-record into it. timelineFrameId = the frame being authored; timelineStageIdx = current stage;
  // timelinePlaying = running the builds (non-destructive overlay). Decoupled from node selection so the
  // strip stays up while you drag members around.
  const [timelineFrameId, setTimelineFrameId] = useState(null)
  const [timelineStageIdx, setTimelineStageIdx] = useState(0)
  const [timelinePlaying, setTimelinePlaying] = useState(false)
  const [timelineRecordPulse, setTimelineRecordPulse] = useState(0)   // bump → "●recorded" flash on marker
  const timelinePlayTimerRef = useRef(null)
  const timelineFrameIdRef = useRef(null)
  useEffect(() => { timelineFrameIdRef.current = timelineFrameId }, [timelineFrameId])
  // Shape-morph pops: SVG can't tween element types, so when a stage changes a member's shape we bump a
  // per-node nonce → NodeShape replays a scale-pop. lastShownShapeRef tracks the on-screen shape so we
  // only pop on an actual change between consecutive stages (not every apply).
  const [shapeMorph, setShapeMorph] = useState({})
  const morphCounterRef = useRef(0)
  const lastShownShapeRef = useRef({})
  const saveTimer = useRef(null)
  const loadOkRef = useRef(false)   // true only after a successful project load — gates autosave

  // Shared read-only view: data is fetched up-front (public RPC) and passed in, so we load it
  // straight into the store. The owner path is loaded by App (so all tabs share one load); this
  // component just reflects that load status below.
  const storeLoadedProjectId = useGraphStore(s => s.loadedProjectId)
  useEffect(() => {
    if (!sharedData) return
    loadProjectData({ nodes: sharedData.nodes, edges: sharedData.edges, views: sharedData.views, activeViewId: sharedData.active_view_id, propertyDefs: sharedData.property_defs, loadedProjectId: projectId })
    loadOkRef.current = true
    setLoading(false)
  }, [projectId, sharedData]) // eslint-disable-line
  useEffect(() => {
    if (sharedData) return
    const ok = storeLoadedProjectId === projectId
    loadOkRef.current = ok        // gate autosave: only once THIS project's snapshot is in the store
    setLoading(!ok)
  }, [storeLoadedProjectId, projectId, sharedData])

  const storeNodes      = useGraphStore(s => s.nodes)
  const storeEdges      = useGraphStore(s => s.edges)
  const storePropertyDefs = useGraphStore(s => s.propertyDefs)
  const storePropertyDefsRef = useRef(storePropertyDefs)
  storePropertyDefsRef.current = storePropertyDefs
  const storeStyles     = useGraphStore(s => s.styles)
  const saveStyleFromNode = useGraphStore(s => s.saveStyleFromNode)
  const updateStyleFromNode = useGraphStore(s => s.updateStyleFromNode)
  const renameStyle     = useGraphStore(s => s.renameStyle)
  const deleteStyle     = useGraphStore(s => s.deleteStyle)
  const applyStyleAction = useGraphStore(s => s.applyStyle)
  const setNodeProp     = useGraphStore(s => s.setNodeProp)
  const addPropertyDef  = useGraphStore(s => s.addPropertyDef)
  const addSelectOption = useGraphStore(s => s.addSelectOption)
  const updatePropertyDef = useGraphStore(s => s.updatePropertyDef)
  const activeViewId    = useGraphStore(s => s.activeViewId)
  const views           = useGraphStore(s => s.views)
  const addNode         = useGraphStore(s => s.addNode)
  const addEdge         = useGraphStore(s => s.addEdge)
  const removeEdge      = useGraphStore(s => s.removeEdge)
  const deleteNode      = useGraphStore(s => s.deleteNode)
  const setAnchor       = useGraphStore(s => s.setAnchor)
  const releaseAnchor   = useGraphStore(s => s.releaseAnchor)
  const releaseAllAnchors = useGraphStore(s => s.releaseAllAnchors)
  const updateLabel     = useGraphStore(s => s.updateLabel)
  const updateNotes     = useGraphStore(s => s.updateNotes)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const setContainedIn  = useGraphStore(s => s.setContainedIn)
  const reparentNode    = useGraphStore(s => s.reparentNode)
  const addImage        = useGraphStore(s => s.addImage)
  const addTextBox      = useGraphStore(s => s.addTextBox)
  const addVideo        = useGraphStore(s => s.addVideo)
  const addAudio        = useGraphStore(s => s.addAudio)
  const addYtssNode     = useGraphStore(s => s.addYtssNode)
  const setYtssClips    = useGraphStore(s => s.setYtssClips)
  const setYtssProp     = useGraphStore(s => s.setYtssProp)
  const addLink         = useGraphStore(s => s.addLink)
  const duplicateNodeAt = useGraphStore(s => s.duplicateNodeAt)
  const copyChildrenInto = useGraphStore(s => s.copyChildrenInto)
  const updateImage     = useGraphStore(s => s.updateImage)
  const convertImageToNode = useGraphStore(s => s.convertImageToNode)
  const updateNodeMedia = useGraphStore(s => s.updateNodeMedia)
  const deleteImage     = useGraphStore(s => s.deleteImage)
  const groupImages     = useGraphStore(s => s.groupImages)
  const ungroupImages   = useGraphStore(s => s.ungroupImages)
  const reorderImage    = useGraphStore(s => s.reorderImage)
  const duplicateImage  = useGraphStore(s => s.duplicateImage)
  const deleteImages    = useGraphStore(s => s.deleteImages)
  const addCustomEmoji  = useGraphStore(s => s.addCustomEmoji)
  const removeCustomEmoji = useGraphStore(s => s.removeCustomEmoji)
  const addSlide            = useGraphStore(s => s.addSlide)
  const removeSlide         = useGraphStore(s => s.removeSlide)
  const reorderSlides       = useGraphStore(s => s.reorderSlides)
  const addSlideshow        = useGraphStore(s => s.addSlideshow)
  const deleteSlideshow     = useGraphStore(s => s.deleteSlideshow)
  const renameSlideshow     = useGraphStore(s => s.renameSlideshow)
  const setActiveSlideshowId = useGraphStore(s => s.setActiveSlideshowId)
  const setDrillRoot    = useGraphStore(s => s.setDrillRoot)
  const exitDrill       = useGraphStore(s => s.exitDrill)
  const setNodeMeta     = useGraphStore(s => s.setNodeMeta)
  const addNodeTag      = useGraphStore(s => s.addNodeTag)
  const removeNodeTag   = useGraphStore(s => s.removeNodeTag)
  const toggleCollapseNode = useGraphStore(s => s.toggleCollapseNode)
  const rerouteContainerLinks = useGraphStore(s => s.rerouteContainerLinks)
  const applyStagePose  = useGraphStore(s => s.applyStagePose)
  const setViewBgColor  = useGraphStore(s => s.setViewBgColor)
  const setViewPan      = useGraphStore(s => s.setViewPan)
  const setSlideBgColor = useGraphStore(s => s.setSlideBgColor)
  const addView         = useGraphStore(s => s.addView)
  const set3DModel      = useGraphStore(s => s.set3DModel)
  const setModelThumb   = useGraphStore(s => s.setModelThumb)
  const setImageUrl     = useGraphStore(s => s.setImageUrl)
  const pushUndo        = useGraphStore(s => s.pushUndo)
  const undo            = useGraphStore(s => s.undo)

  const addFrameToCenter = useCallback(() => {
    if (!svgRef.current) return
    const { views, activeViewId } = useGraphStore.getState()
    const vp = views.find(v => v.id === activeViewId)?.nodeProps || {}
    const currentFrameCount = Object.values(vp).filter(p => p.shape === 'frame').length
    const [cx, cy] = zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2])
    const gs = useGraphStore.getState()
    const dr = gs.views.find(v => v.id === gs.activeViewId)?.drillRoot
    const id = addNode('Frame', dr || null, cx, cy)
    setNodeViewProp(id, 'shape', 'frame')
    setNodeViewProp(id, 'fillColor', 'none')
    setNodeViewProp(id, 'strokeColor', null)
    addSlide(id)
    if (currentFrameCount === 0) setTimeout(() => setShowSlideSidebar(true), 50)
    setTimeout(() => {
      const sn = simNodesRef.current.find(n => n.id === id)
      if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy }
      scheduleRender()
    }, 0)
  }, [addNode, setNodeViewProp, addSlide]) // eslint-disable-line

  // Blank container at viewport center — toss nodes into it afterwards.
  const addContainerToCenter = useCallback(() => {
    if (!svgRef.current) return
    const [cx, cy] = zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2])
    const gs = useGraphStore.getState()
    const dr = gs.views.find(v => v.id === gs.activeViewId)?.drillRoot
    const id = addNode('Container', dr || null, cx, cy)
    setNodeViewProp(id, 'shape', 'container')
    setNodeViewProp(id, 'containerShape', 'rect')
    setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy } scheduleRender() }, 0)
  }, [addNode, setNodeViewProp]) // eslint-disable-line

  // Turn an existing node into a container: its direct children become its contents (floating inside),
  // the node is sized to wrap them, and it's anchored so the group holds together. Links from the
  // children stay as they are (drawn to the outside, hidden inside) — reroute-to-grandmother comes later.
  const makeContainer = useCallback((nodeId) => {
    const gs = useGraphStore.getState()
    const kids = gs.edges.filter(e => e.source === nodeId).map(e => e.target)
    const cn = simNodesRef.current.find(n => n.id === nodeId)
    const cx = cn?.x || 0, cy = cn?.y || 0
    // Box sized to comfortably hold the kids in a grid inside.
    const cols = Math.max(1, Math.ceil(Math.sqrt(kids.length)))
    const rows = Math.max(1, Math.ceil(kids.length / cols))
    const cell = NODE_R * 2.6
    const hw = Math.max(NODE_R * 2.4, (cols * cell) / 2 + NODE_R)
    const hh = Math.max(NODE_R * 2.4, (rows * cell) / 2 + NODE_R * 1.4)
    pushUndo()
    setNodeViewProp(nodeId, 'shape', 'container')
    setNodeViewProp(nodeId, 'containerShape', 'rect')
    setNodeViewProp(nodeId, 'frameHalfW', hw)
    setNodeViewProp(nodeId, 'frameHalfH', hh)
    setNodeViewProp(nodeId, 'containerLinks', 'grandmother')   // links go to the grandmother by default
    setNodeViewProp(nodeId, 'containerDragOut', 'springback')  // pulling a node out springs it back in
    setAnchor(nodeId, cx, cy)
    // Place every kid INSIDE the box (grid), mark contained, and let them float from there.
    kids.forEach((kid, i) => {
      setContainedIn(kid, nodeId)
      const col = i % cols, row = Math.floor(i / cols)
      const px = cx - (cols - 1) * cell / 2 + col * cell
      const py = cy - (rows - 1) * cell / 2 + row * cell + NODE_R * 0.4
      const sn = simNodesRef.current.find(n => n.id === kid)
      if (sn) { sn.x = px; sn.y = py; sn.fx = null; sn.fy = null }
      releaseAnchor(kid)
    })
    rerouteContainerLinks(nodeId, 'grandmother')
    simRef.current?.alpha(0.5).restart()
    scheduleRender()
  }, [pushUndo, setNodeViewProp, setAnchor, setContainedIn, releaseAnchor, rerouteContainerLinks]) // eslint-disable-line -- scheduleRender declared later (TDZ)

  // Turn a container back into a normal node (like "show as list/board" toggling off): restore its
  // members as its own children, release them, and clear the container props/shape.
  const revertContainer = useCallback((nodeId) => {
    const st = useGraphStore.getState()
    const v = st.views.find(vv => vv.id === st.activeViewId)
    const members = st.nodes.filter(n => v?.nodeProps?.[n.id]?.containedIn === nodeId).map(n => n.id)
    pushUndo()
    rerouteContainerLinks(nodeId, 'container')   // point the members' links back at this node
    members.forEach(id => setContainedIn(id, null))
    setNodeViewProp(nodeId, 'shape', 'circle')
    setNodeViewProp(nodeId, 'containerShape', null)
    setNodeViewProp(nodeId, 'frameHalfW', null)
    setNodeViewProp(nodeId, 'frameHalfH', null)
    setNodeViewProp(nodeId, 'containerLinks', null)
    setNodeViewProp(nodeId, 'containerDragOut', null)
    if (simRef.current) simRef.current.alpha(0.5).restart()
  }, [pushUndo, rerouteContainerLinks, setContainedIn, setNodeViewProp])

  // Create a table node at the current viewport center (sidebar "+" menu path — no right-click needed).
  const addTableToCenter = useCallback(() => {
    if (!svgRef.current) return
    const [cx, cy] = zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2])
    pushUndo()
    const id = addTableNode(cx, cy)
    // If we're drilled into a subtree, attach the new table to the drilled node so it's visible here
    // (an orphan would fall outside visibleNodeIds and silently not render).
    const st = useGraphStore.getState()
    const dr = st.views.find(v => v.id === st.activeViewId)?.drillRoot
    if (dr) addEdge(dr, id)
    setSelected({ id, type: 'node' })
    setTimeout(() => {
      const sn = simNodesRef.current.find(n => n.id === id)
      if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy }
      scheduleRender()
    }, 0)
  }, []) // eslint-disable-line  (addTableNode/scheduleRender declared later; accessed only at call time)

  // "Make current view a slide": create a frame sized to exactly the visible viewport (current
  // pan/zoom) and add it to the current slideshow — a one-click snapshot of what you're looking at.
  const makeCurrentViewAsSlide = useCallback(() => {
    if (!svgRef.current) return
    const W = svgRef.current.clientWidth, H = svgRef.current.clientHeight
    const T = zoomTransformRef.current
    const [cx, cy] = T.invert([W / 2, H / 2])
    const inset = 0.94   // small margin so the frame's edge isn't flush against the content
    const halfW = (W / T.k) / 2 * inset, halfH = (H / T.k) / 2 * inset
    pushUndo()
    const id = addNode('Slide', null, cx, cy)
    setNodeViewProp(id, 'shape', 'frame')
    setNodeViewProp(id, 'fillColor', 'none')
    setNodeViewProp(id, 'strokeColor', null)
    setNodeViewProp(id, 'frameHalfW', halfW)
    setNodeViewProp(id, 'frameHalfH', halfH)
    addSlide(id)
    setShowSlideSidebar(true)
    setTimeout(() => {
      const sn = simNodesRef.current.find(n => n.id === id)
      if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy }
      scheduleRender()
    }, 0)
  }, [addNode, setNodeViewProp, addSlide]) // eslint-disable-line -- pushUndo/scheduleRender are declared later (TDZ)

  // "Update slide": resize/reposition an existing slide's frame to match the current viewport.
  const updateSlideToView = useCallback((frameId) => {
    if (!svgRef.current || !frameId) return
    const W = svgRef.current.clientWidth, H = svgRef.current.clientHeight
    const T = zoomTransformRef.current
    const [cx, cy] = T.invert([W / 2, H / 2])
    const inset = 0.94
    const halfW = (W / T.k) / 2 * inset, halfH = (H / T.k) / 2 * inset
    pushUndo()
    setNodeViewProp(frameId, 'frameHalfW', halfW)
    setNodeViewProp(frameId, 'frameHalfH', halfH)
    const sn = simNodesRef.current.find(n => n.id === frameId)
    if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy }
    scheduleRender()
  }, [setNodeViewProp]) // eslint-disable-line -- pushUndo/scheduleRender are declared later (TDZ)

  const activeView    = views.find(v => v.id === activeViewId) || views[0]
  const viewNodeProps = activeView?.nodeProps || {}
  const drillRoot     = activeView?.drillRoot || null
  const bgColor       = activeView?.bgColor || '#0c0c1a'
  const edgeGlowColor = isLightColor(bgColor) ? '#000000' : '#ffffff'  // contrast halo for edge legibility
  const slideshows    = activeView?.slideshows || [{ id: 'ss-default', name: 'Default', slides: [] }]
  const activeSlideshowId = activeView?.activeSlideshowId || slideshows[0]?.id
  const activeSlideshow   = slideshows.find(ss => ss.id === activeSlideshowId) || slideshows[0]
  const slideIds      = activeSlideshow?.slides || []
  const customEmojis  = activeView?.customEmojis || []
  const collapsedNodeIds = activeView?.collapsedNodeIds || []
  const listNodeIds = activeView?.listNodeIds || []   // nodes shown as a nested list card (subtree hidden)
  const kanbanNodeIds = activeView?.kanbanNodeIds || []   // nodes shown as a kanban board (subtree hidden)
  const strategyNodeIds = activeView?.strategyNodeIds || []   // nodes shown as a strategy card (subtree hidden)
  const presentingSlideBg = (presentingSlideIdx !== null)
    ? (activeSlideshow?.slideBgColors?.[slideIds[presentingSlideIdx]] || bgColor)
    : bgColor
  const effectiveBg = presentingSlideBg

  // Auto-open slide tray when first frame is created in this view
  const frameNodeCount = Object.values(viewNodeProps).filter(p => p.shape === 'frame').length
  useEffect(() => {
    if (frameNodeCount > 0 && prevFrameCountRef.current === 0) setShowSlideSidebar(true)
    prevFrameCountRef.current = frameNodeCount
  }, [frameNodeCount])

  // Mutable ref so D3 forces can always read the latest view props without stale closure
  const viewNodePropsRef = useRef(viewNodeProps)
  viewNodePropsRef.current = viewNodeProps
  // A node inside a CONTAINER is governed by the container's own centre-pull, not by its link to an
  // outside parent — so nearly kill the link strength for any edge touching such a node (used by every
  // forceLink setup below so contents don't get dragged toward the grandmother).
  const containedLinkStrength = (l) => {
    const vp = viewNodePropsRef.current
    const sId = l.source?.id ?? l.source, tId = l.target?.id ?? l.target
    const inC = (id) => { const c = vp[id]?.containedIn; return c && vp[c]?.shape === 'container' }
    return (inC(sId) || inC(tId)) ? 0.01 : 0.4
  }

  const saveDirtyRef = useRef(false)
  useEffect(() => {
    if (loading || readOnly || !loadOkRef.current) return   // never autosave unless the project loaded OK (a failed load must not blank it)
    setSaveStatus('saving')
    saveDirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        await saveProject(projectId, { nodes: storeNodes, edges: storeEdges, views, activeViewId, propertyDefs: storePropertyDefs, styles: storeStyles })
        saveDirtyRef.current = false
        setSaveStatus('saved')
      } catch (e) { console.error('Save:', e); setSaveStatus('error') }
    }, 1500)
    return () => clearTimeout(saveTimer.current)
  }, [storeNodes, storeEdges, storePropertyDefs, storeStyles, views, activeViewId, projectId, loading]) // eslint-disable-line

  // Flush a pending save on unmount (e.g. switching tabs graph↔board) so the last edit isn't dropped
  // when the debounce timer is cleared. Reads fresh store state; guarded so it can't blank a project.
  useEffect(() => {
    return () => {
      if (!saveDirtyRef.current || readOnly) return
      const s = useGraphStore.getState()
      if (s.loadedProjectId !== projectId) return
      saveProject(projectId, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs, styles: s.styles }).catch(() => {})
    }
  }, [projectId, readOnly])

  // ── Live auto-styling ────────────────────────────────────────────────────────
  // A node can carry `meta.autoStyle = { maps:[{propId,channel}], rules:[{tags:[],styleId}] }`.
  // It styles that node's DIRECT CHILDREN, live: property→channel maps set a visual channel from each
  // child's property value; tag rules apply a whole saved style when the child has all the listed tags
  // (rules win over maps). The result is a per-node overlay merged into getVP — non-destructive (stored
  // styles are never touched) and reactive (recomputes when nodes/edges/styles/props change).
  const autoStyleOverlay = useMemo(() => {
    const overlay = {}
    const stylers = storeNodes.filter(n => n.meta?.autoStyle && ((n.meta.autoStyle.maps?.length) || (n.meta.autoStyle.rules?.length)))
    if (!stylers.length) return overlay
    const byId = new Map(storeNodes.map(n => [n.id, n]))
    const childrenOf = {}
    storeEdges.forEach(e => { (childrenOf[e.source] || (childrenOf[e.source] = [])).push(e.target) })
    const styleById = new Map((storeStyles || []).map(s => [s.id, s]))
    const defById = new Map((storePropertyDefs || []).map(d => [d.id, d]))
    for (const parent of stylers) {
      const as = parent.meta.autoStyle
      const kids = (childrenOf[parent.id] || []).map(id => byId.get(id)).filter(Boolean)
      if (!kids.length) continue
      // Precompute, per mapped property, the ordered distinct values + numeric range across these kids.
      const mapCtx = (as.maps || []).map(m => {
        const def = defById.get(m.propId)
        const vals = kids.map(k => nodeValueForProp(k, def))
        const nums = vals.filter(v => typeof v === 'number' && !isNaN(v))
        const distinct = []
        vals.forEach(v => { const key = valKey(v); if (v != null && v !== '' && !distinct.some(d => valKey(d) === key)) distinct.push(v) })
        return { m, def, distinct, min: nums.length ? Math.min(...nums) : 0, max: nums.length ? Math.max(...nums) : 1 }
      })
      for (const kid of kids) {
        let ov = {}
        for (const ctx of mapCtx) {
          const v = nodeValueForProp(kid, ctx.def)
          if (v == null || v === '') continue
          Object.assign(ov, deriveChannel(ctx.m.channel, v, ctx))
        }
        for (const r of (as.rules || [])) {
          const req = r.tags || []
          if (req.length && r.styleId && req.every(t => (kid.meta?.tags || []).includes(t))) {
            const st = styleById.get(r.styleId)
            if (st) { ov = { ...ov, ...st.props }; break }
          }
        }
        if (Object.keys(ov).length) overlay[kid.id] = { ...(overlay[kid.id] || {}), ...ov }
      }
    }
    return overlay
  }, [storeNodes, storeEdges, storeStyles, storePropertyDefs])

  const getVP = useCallback((nodeId) => ({
    ...DEFAULT_NODE_PROPS, ...(viewNodeProps[nodeId] || {}), ...(autoStyleOverlay[nodeId] || {}),
  }), [viewNodeProps, autoStyleOverlay])

  // BFS hop-distance from a focal node (undirected — follows edges both ways)
  const expandHops = useMemo(() => {
    if (!depthExpand) return null
    const { nodeId, radius } = depthExpand
    const dist = { [nodeId]: 0 }
    const q = [nodeId]
    while (q.length) {
      const cur = q.shift()
      if (dist[cur] >= radius) continue
      storeEdges.forEach(e => {
        const neighbor = e.source === cur ? e.target : e.target === cur ? e.source : null
        if (neighbor && dist[neighbor] === undefined) { dist[neighbor] = dist[cur] + 1; q.push(neighbor) }
      })
    }
    return dist
  }, [depthExpand, storeEdges])

  // Max possible hops from focal node (diameter to farthest connected node)
  const maxExpandRadius = useMemo(() => {
    if (!depthExpand) return 0
    const { nodeId } = depthExpand
    const dist = { [nodeId]: 0 }
    const q = [nodeId]
    while (q.length) {
      const cur = q.shift()
      storeEdges.forEach(e => {
        const nb = e.source === cur ? e.target : e.target === cur ? e.source : null
        if (nb && dist[nb] === undefined) { dist[nb] = dist[cur] + 1; q.push(nb) }
      })
    }
    return Math.max(0, ...Object.values(dist))
  }, [depthExpand?.nodeId, storeEdges]) // eslint-disable-line

  const visibleNodeIds = useMemo(() => {
    let base
    if (drillRoot) {
      const desc = new Set([drillRoot])
      const q = [drillRoot]
      while (q.length) {
        const cur = q.shift()
        storeEdges.forEach(e => { if (e.source === cur && !desc.has(e.target)) { desc.add(e.target); q.push(e.target) } })
      }
      base = desc
    } else {
      base = new Set(storeNodes.filter(n => viewNodeProps[n.id]?.visible !== false).map(n => n.id))
    }
    // Frame-stage preview overlay (view-only): a stage can force some member nodes collapsed/expanded
    // and shown/hidden. Fold its collapse overrides into the effective collapsed set here.
    const effCollapsed = new Set(collapsedNodeIds)
    if (stageOverlay?.collapse) {
      for (const id in stageOverlay.collapse) { if (stageOverlay.collapse[id]) effCollapsed.add(id); else effCollapsed.delete(id) }
    }
    // Stage visibility overrides: show/hide specific members (hiding a member hides its subtree).
    // NB: this runs BEFORE the card/collapse subtree-hiding below, so a stage can never re-reveal the
    // children a list/kanban/strategy card is standing in for (that regressed to "nodes + card at once").
    if (stageOverlay?.vis) {
      for (const id in stageOverlay.vis) {
        if (stageOverlay.vis[id]) { base.add(id) }
        else {
          base.delete(id)
          const q = [id]
          while (q.length) { const cur = q.shift(); storeEdges.forEach(e => { if (e.source === cur && base.has(e.target)) { base.delete(e.target); q.push(e.target) } }) }
        }
      }
    }
    // Hide the descendants of any collapsed, list-card, kanban, OR strategy node (the card renders that
    // subtree itself). Runs LAST so these always win over a stage's show overrides.
    if (effCollapsed.size || listNodeIds.length || kanbanNodeIds.length || strategyNodeIds.length) {
      const hidden = new Set()
      const q = [...effCollapsed, ...listNodeIds, ...kanbanNodeIds, ...strategyNodeIds]
      while (q.length) {
        const cur = q.shift()
        storeEdges.forEach(e => {
          if (e.source === cur && !hidden.has(e.target)) { hidden.add(e.target); q.push(e.target) }
        })
      }
      hidden.forEach(id => base.delete(id))
    }
    // A collapsed CONTAINER also hides whatever it physically holds (containment, not just edges) —
    // covers nodes tossed in that keep their link to a parent outside the container.
    if (effCollapsed.size) {
      effCollapsed.forEach(cid => {
        if (viewNodeProps[cid]?.shape !== 'container') return
        storeNodes.forEach(nn => { if (viewNodeProps[nn.id]?.containedIn === cid) base.delete(nn.id) })
      })
    }
    if (expandHops !== null) {
      ;[...base].forEach(id => { if (expandHops[id] === undefined) base.delete(id) })
    }
    // Non-destructive property filter — removes non-matching nodes from the visible set
    // (no data mutation; clearing the filter restores everything).
    if (propFilter) {
      const def = storePropertyDefs.find(d => d.id === propFilter.propId)
      if (def) {
        const pmap = Object.fromEntries(storeNodes.map(n => [n.id, n.props]))
        const matches = id => {
          const val = pmap[id]?.[propFilter.propId]
          if (propFilter.value === '__any__') return val != null && val !== '' && !(Array.isArray(val) && val.length === 0)
          if (def.type === 'multiSelect') return Array.isArray(val) && val.includes(propFilter.value)
          if (def.type === 'checkbox') return !!val === !!propFilter.value
          return val === propFilter.value
        }
        ;[...base].forEach(id => { if (!matches(id)) base.delete(id) })
      }
    }
    return base
  }, [drillRoot, storeNodes, storeEdges, viewNodeProps, expandHops, collapsedNodeIds, listNodeIds, kanbanNodeIds, strategyNodeIds, propFilter, storePropertyDefs, stageOverlay])
  const visibleNodeIdsRef = useRef(visibleNodeIds)
  visibleNodeIdsRef.current = visibleNodeIds

  // Fade nodes in/out when their visibility changes (depth slider, collapse) instead of popping.
  // `mounted` keeps a node in the DOM through its fade-out; opacity animates via a CSS transition.
  const mountedRef = useRef(null)
  if (mountedRef.current === null) mountedRef.current = new Set(visibleNodeIds)
  const nodeOpacityRef = useRef({})
  const fadeTimersRef = useRef({})
  const [, setFadeTick] = useState(0)
  useEffect(() => {
    const vis = visibleNodeIds, mounted = mountedRef.current, op = nodeOpacityRef.current
    let changed = false
    vis.forEach(id => {
      if (!mounted.has(id)) { mounted.add(id); op[id] = 0; changed = true }        // new → mount at 0 (fade in)
      if (fadeTimersRef.current[id]) { clearTimeout(fadeTimersRef.current[id]); delete fadeTimersRef.current[id] }
    })
    mounted.forEach(id => {
      if (!vis.has(id) && !fadeTimersRef.current[id]) {                              // gone → fade to 0, unmount later
        op[id] = 0; changed = true
        fadeTimersRef.current[id] = setTimeout(() => { mounted.delete(id); delete op[id]; delete fadeTimersRef.current[id]; setFadeTick(t => t + 1) }, 400)
      }
    })
    requestAnimationFrame(() => { let ch = false; vis.forEach(id => { if (op[id] !== 1) { op[id] = 1; ch = true } }); if (ch) setFadeTick(t => t + 1) })
    if (changed) setFadeTick(t => t + 1)
  }, [visibleNodeIds])

  // ── List-card ("show children as list") support ──────────────────────────────
  const toggleListNode = useGraphStore(s => s.toggleListNode)
  const toggleKanbanNode = useGraphStore(s => s.toggleKanbanNode)
  const toggleStrategyNode = useGraphStore(s => s.toggleStrategyNode)
  const setStrategyPos = useGraphStore(s => s.setStrategyPos)
  const setStrategyPositions = useGraphStore(s => s.setStrategyPositions)
  const addStrategyEdge = useGraphStore(s => s.addStrategyEdge)
  const setStrategyEdge = useGraphStore(s => s.setStrategyEdge)
  const removeStrategyEdge = useGraphStore(s => s.removeStrategyEdge)
  const toggleStrategyDecision = useGraphStore(s => s.toggleStrategyDecision)
  const addKanbanNode  = useGraphStore(s => s.addKanbanNode)
  const moveCardToColumn = useGraphStore(s => s.moveCardToColumn)
  const addKanbanColumn = useGraphStore(s => s.addKanbanColumn)
  const renameKanbanColumn = useGraphStore(s => s.renameKanbanColumn)
  const deleteKanbanColumn = useGraphStore(s => s.deleteKanbanColumn)
  const renameKanbanBoard = useGraphStore(s => s.renameKanbanBoard)
  const addGroupedBoard = useGraphStore(s => s.addGroupedBoard)
  const setKanbanGroupBy = useGraphStore(s => s.setKanbanGroupBy)
  const renameSelectOption = useGraphStore(s => s.renameSelectOption)
  const deleteSelectOption = useGraphStore(s => s.deleteSelectOption)
  const recolorSelectOption = useGraphStore(s => s.recolorSelectOption)
  const moveChild      = useGraphStore(s => s.moveChild)
  const addTableNode      = useGraphStore(s => s.addTableNode)
  const addTableNodeFrom  = useGraphStore(s => s.addTableNodeFrom)
  const setTableCell      = useGraphStore(s => s.setTableCell)
  const setTableCellBg    = useGraphStore(s => s.setTableCellBg)
  const addTableRow       = useGraphStore(s => s.addTableRow)
  const addTableColumn    = useGraphStore(s => s.addTableColumn)
  const insertTableRow    = useGraphStore(s => s.insertTableRow)
  const insertTableColumn = useGraphStore(s => s.insertTableColumn)
  const deleteTableRow    = useGraphStore(s => s.deleteTableRow)
  const deleteTableColumn = useGraphStore(s => s.deleteTableColumn)
  const updateTableColumn = useGraphStore(s => s.updateTableColumn)
  const moveTableColumn   = useGraphStore(s => s.moveTableColumn)
  const moveTableRow      = useGraphStore(s => s.moveTableRow)
  const setTableRowHeight = useGraphStore(s => s.setTableRowHeight)
  const ensureFlowIds     = useGraphStore(s => s.ensureFlowIds)
  const applyFlowchart    = useGraphStore(s => s.applyFlowchart)
  const addDrawing        = useGraphStore(s => s.addDrawing)
  const updateDrawing     = useGraphStore(s => s.updateDrawing)
  const deleteDrawing     = useGraphStore(s => s.deleteDrawing)
  const listNodeSet    = useMemo(() => new Set(listNodeIds), [listNodeIds])
  const kanbanNodeSet  = useMemo(() => new Set(kanbanNodeIds), [kanbanNodeIds])
  const strategyNodeSet = useMemo(() => new Set(strategyNodeIds), [strategyNodeIds])
  const allProjectTags = useMemo(() => { const set = new Set(); storeNodes.forEach(n => (n.meta?.tags || []).forEach(t => set.add(t))); return [...set].sort() }, [storeNodes])
  const tableNodeSet   = useMemo(() => new Set(storeNodes.filter(n => n.table).map(n => n.id)), [storeNodes])
  const mediaNodeSet   = useMemo(() => new Set(storeNodes.filter(n => n.media).map(n => n.id)), [storeNodes])
  const ytssNodeSet    = useMemo(() => new Set(storeNodes.filter(n => n.ytss).map(n => n.id)), [storeNodes])
  // Migrate previously-"attached" media (image.attachedTo, the old follow model) into real media nodes,
  // once per view, so older projects gain the node behavior (outliner/collapse/edges).
  const migratedViewsRef = useRef(new Set())
  useEffect(() => {
    if (loading || readOnly) return
    const st = useGraphStore.getState()
    const v = st.views.find(vv => vv.id === st.activeViewId)
    if (!v || migratedViewsRef.current.has(v.id)) return
    migratedViewsRef.current.add(v.id)
    const nodeIds = new Set(st.nodes.map(n => n.id))
    const toConvert = (v.images || []).filter(i => i.attachedTo && nodeIds.has(i.attachedTo))
    toConvert.forEach(i => convertImageToNode(i.id, i.attachedTo))
  }, [loading, readOnly, activeViewId, convertImageToNode])
  // Backfill YouTube titles so the outliner shows the real video title instead of a bare "video".
  // oembed is CORS-enabled, so we can fetch it straight from the browser. Tried once per id per session.
  const ytTitleTriedRef = useRef(new Set())
  useEffect(() => {
    if (loading || readOnly) return
    const s = useGraphStore.getState()
    const fetchTitle = (id, ytId, apply) => {
      if (ytTitleTriedRef.current.has(id)) return
      ytTitleTriedRef.current.add(id)
      fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.title) apply(d.title) })
        .catch(() => {})
    }
    s.nodes.forEach(n => {
      if (n.media?.kind === 'video' && n.media?.videoKind === 'youtube' && n.media?.youtubeId) {
        const lbl = (n.label || '').trim().toLowerCase()
        if (lbl === '' || lbl === 'video') fetchTitle('node:' + n.id, n.media.youtubeId, t => updateLabel(n.id, t))
      }
      // Retire the old default slideshow name so it doesn't read "YouTube slideshow" in the outliner.
      if (n.ytss && (n.label || '').trim() === 'YouTube slideshow') updateLabel(n.id, '')
      // YouTube-slideshow clips: backfill each clip's real title (shown in the inspector list).
      if (n.ytss?.clips?.length) {
        n.ytss.clips.forEach(cl => {
          if (cl.youtubeId && !cl.title) fetchTitle('ytss:' + n.id + ':' + cl.id, cl.youtubeId, t => {
            const cur = useGraphStore.getState().nodes.find(x => x.id === n.id)
            if (!cur?.ytss) return
            setYtssClips(n.id, (cur.ytss.clips || []).map(c => c.id === cl.id ? { ...c, title: t } : c))
          })
        })
      }
    })
    const v = s.views.find(vv => vv.id === s.activeViewId)
    ;(v?.images || []).forEach(img => {
      if (img.type === 'video' && img.videoKind === 'youtube' && img.youtubeId && !img.title)
        fetchTitle('img:' + img.id, img.youtubeId, t => updateImage(img.id, { title: t }))
    })
  }, [loading, readOnly, storeNodes, activeViewId, updateLabel, updateImage])
  const storeNodeById  = useMemo(() => Object.fromEntries(storeNodes.map(n => [n.id, n])), [storeNodes])
  const nodeLabelById  = useMemo(() => Object.fromEntries(storeNodes.map(n => [n.id, n.label])), [storeNodes])
  const childrenOrdered = useMemo(() => { const m = {}; storeEdges.forEach(e => { (m[e.source] = m[e.source] || []).push(e.target) }); return m }, [storeEdges])
  // Flatten a node's whole subtree into indented rows (edge order; cycle-safe) for the list card.
  const flattenSubtree = useCallback((rootId) => {
    const rows = []; const seen = new Set([rootId])
    const walk = (id, depth) => {
      (childrenOrdered[id] || []).forEach(cid => {
        if (seen.has(cid)) return; seen.add(cid)
        rows.push({ id: cid, parentId: id, label: nodeLabelById[cid] || '(untitled)', depth })
        walk(cid, depth + 1)
      })
    }
    walk(rootId, 0)
    return rows
  }, [childrenOrdered, nodeLabelById])
  // Move a row up/down among its direct siblings.
  const reorderRow = useCallback((parentId, childId, dir) => {
    const sibs = childrenOrdered[parentId] || []
    const i = sibs.indexOf(childId); if (i < 0) return
    if (dir === 'up' && i > 0) moveChild(parentId, childId, sibs[i - 1])
    else if (dir === 'down' && i < sibs.length - 1) moveChild(parentId, childId, sibs[i + 2] ?? null)
  }, [childrenOrdered, moveChild])

  // Build the list-card rows honoring its `order`: Structure = edge order (nested); Arrangement =
  // a saved custom order of the FIRST-GEN children (nested subtrees follow); Sort = first-gen sorted
  // by a key. Only the first generation is reordered — deeper levels keep their structural order.
  const buildListRows = useCallback((rootId, order, arrangements) => {
    const firstGen = childrenOrdered[rootId] || []
    let top = firstGen
    if (order?.mode === 'arrangement') {
      const arr = (arrangements || []).find(a => a.id === order.arrangementId)
      if (arr) { const set = new Set(firstGen); const inArr = (arr.order || []).filter(id => set.has(id)); const rest = firstGen.filter(id => !inArr.includes(id)); top = [...inArr, ...rest] }
    } else if (order?.mode === 'sort' && order.sortKey) {
      top = [...firstGen].sort((a, b) => cmpListVals(listSortValue(order.sortKey, storeNodeById[a], storePropertyDefs), listSortValue(order.sortKey, storeNodeById[b], storePropertyDefs)))
      if (order.sortDir === 'desc') top.reverse()
    }
    const rows = []; const seen = new Set([rootId])
    const walk = (id, depth, parentId) => {
      if (seen.has(id)) return; seen.add(id)
      rows.push({ id, parentId, label: nodeLabelById[id] || '(untitled)', depth })
      ;(childrenOrdered[id] || []).forEach(c => walk(c, depth + 1, id))
    }
    top.forEach(cid => walk(cid, 0, rootId))
    return rows
  }, [childrenOrdered, nodeLabelById, storeNodeById, storePropertyDefs])

  // Build a clean, self-contained SVG of the CURRENT graph (visible nodes as shapes + labels, edges
  // as lines) for export — no foreignObjects, so it rasterizes/prints reliably.
  const captureGraphSVG = useCallback(() => {
    const vis = simNodesRef.current.filter(n => visibleNodeIdsRef.current.has(n.id) && n.x != null && !isNaN(n.x))
    if (!vis.length) return null
    const pos = Object.fromEntries(vis.map(n => [n.id, n]))
    const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    const pad = 70
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    vis.forEach(n => { const r = NODE_R * ((getVP(n.id).scale) || 1); minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r); minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r) })
    const W = Math.round(maxX - minX + pad * 2), H = Math.round(maxY - minY + pad * 2)
    const ox = -minX + pad, oy = -minY + pad
    const edgesSvg = simEdgesRef.current.filter(e => pos[e.source.id] && pos[e.target.id]).map(e => {
      const s = pos[e.source.id], t = pos[e.target.id]
      return `<line x1="${(s.x + ox).toFixed(1)}" y1="${(s.y + oy).toFixed(1)}" x2="${(t.x + ox).toFixed(1)}" y2="${(t.y + oy).toFixed(1)}" stroke="#5a6488" stroke-width="1.2"/>`
    }).join('')
    const nodesSvg = vis.map(n => {
      const vp = getVP(n.id); const r = NODE_R * (vp.scale || 1)
      const fill = (vp.fillColor && vp.fillColor !== 'none' && vp.fillColor !== 'transparent') ? vp.fillColor : '#12122a'
      const tcol = vp.textColor || '#e8eeff'
      const cx = (n.x + ox), cy = (n.y + oy)
      const fs = Math.max(8, r * 0.32)
      const words = String(n.label || '').split(/\s+/).filter(Boolean)
      const maxCh = Math.max(6, Math.floor((r * 1.7) / (fs * 0.56)))
      const lines = []; let cur = ''
      for (const w of words) { if (!cur) cur = w; else if ((cur + ' ' + w).length <= maxCh) cur += ' ' + w; else { lines.push(cur); cur = w } if (lines.length >= 3) break }
      if (cur && lines.length < 3) lines.push(cur)
      const y0 = cy - (lines.length - 1) / 2 * fs * 1.05
      const text = lines.map((ln, i) => `<tspan x="${cx.toFixed(1)}" y="${(y0 + i * fs * 1.05).toFixed(1)}">${esc(ln.slice(0, maxCh))}</tspan>`).join('')
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}" stroke="rgba(232,238,255,0.25)" stroke-width="1"/>`
        + `<text text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${fs.toFixed(1)}" fill="${tcol}">${text}</text>`
    }).join('')
    const bg = bgColor || '#0c0c1a'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${edgesSvg}${nodesSvg}</svg>`
    return { svg, width: W, height: H, bg }
  }, [getVP, bgColor])

  // ── Depth slider (collapse/expand by level, synced to the outline via collapsedNodeIds) ──────
  const setCollapsedNodes = useGraphStore(s => s.setCollapsedNodes)
  const { depthById, maxDepth } = useMemo(() => {
    const parentCount = {}; storeNodes.forEach(n => { parentCount[n.id] = 0 })
    storeEdges.forEach(e => { if (parentCount[e.target] !== undefined) parentCount[e.target]++ })
    const depth = {}; const q = []
    storeNodes.forEach(n => { if (parentCount[n.id] === 0) { depth[n.id] = 0; q.push(n.id) } })
    for (let h = 0; h < q.length; h++) {
      const id = q[h], d = depth[id]
      ;(childrenOrdered[id] || []).forEach(c => { if (depth[c] === undefined || d + 1 < depth[c]) { depth[c] = d + 1; q.push(c) } })
    }
    storeNodes.forEach(n => { if (depth[n.id] === undefined) depth[n.id] = 0 })
    return { depthById: depth, maxDepth: Math.max(0, ...Object.values(depth)) }
  }, [storeNodes, storeEdges, childrenOrdered])
  const depthCap = Math.min(maxDepth, 12)
  const [depthLevel, setDepthLevel] = useState(depthCap)
  useEffect(() => { setDepthLevel(depthCap) }, [depthCap])   // reset when the graph changes shape
  const applyDepthLevel = useCallback((L) => {
    setDepthLevel(L)
    if (L >= depthCap && depthCap >= maxDepth) { setCollapsedNodes([]); return }   // top = fully expanded
    const ids = storeNodes.filter(n => (childrenOrdered[n.id]?.length) && (depthById[n.id] ?? 0) >= L).map(n => n.id)
    setCollapsedNodes(ids)
  }, [depthCap, maxDepth, storeNodes, childrenOrdered, depthById, setCollapsedNodes])

  // ── Children effects — a per-parent viewProps.childrenEffect drives a coordinated animation over the
  // node's children (chase / colour wave / pulse / twinkle / ripple / orbit). The animation runs in an
  // isolated <EffectsOverlay> (its own RAF), so continuous effects don't re-render the whole graph.
  const effectParentList = useMemo(
    () => storeNodes.filter(n => (viewNodeProps[n.id] || {}).childrenEffect && (childrenOrdered[n.id]?.length))
      .map(n => ({ id: n.id, fx: viewNodeProps[n.id].childrenEffect })),
    [storeNodes, viewNodeProps, childrenOrdered])

  // Real-time search match set (label substring). null = no filter. Non-matches are greyed, not hidden.
  const searchMatchSet = useMemo(() => {
    const q = outlineSearch.trim().toLowerCase()
    if (!q) return null
    return new Set(storeNodes.filter(n => (n.label || '').toLowerCase().includes(q)).map(n => n.id))
  }, [outlineSearch, storeNodes])

  const nodesWithChildren = useMemo(() => new Set(storeEdges.map(e => e.source)), [storeEdges])
  // node.props by id — sim nodes don't carry props, so look them up for on-canvas chips
  const propsById = useMemo(() => Object.fromEntries(storeNodes.map(n => [n.id, n.props || null])), [storeNodes])
  const collapsedSet = useMemo(() => new Set(collapsedNodeIds), [collapsedNodeIds])

  // Domain [min,max] of the size-encoding Number property across all nodes.
  const sizeDomain = useMemo(() => {
    if (!organize?.sizeBy) return null
    let mn = Infinity, mx = -Infinity
    storeNodes.forEach(n => {
      const v = Number(n.props?.[organize.sizeBy])
      if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v }
    })
    return mn <= mx ? [mn, mx] : null
  }, [organize?.sizeBy, storeNodes])
  const sizeDomainRef = useRef(sizeDomain)
  sizeDomainRef.current = sizeDomain

  // View props with encodings applied (color/size from properties) while organizing.
  // Purely visual — the manual fillColor/scale stay underneath and return when Done.
  const resolveVP = useCallback((nodeId) => {
    let base = getVP(nodeId)
    // Frame-stage preview can override a member's scale and style (a stage captures size + look).
    if (stageOverlay?.scale && stageOverlay.scale[nodeId] != null) base = { ...base, scale: stageOverlay.scale[nodeId] }
    if (stageOverlay?.style && stageOverlay.style[nodeId]) {
      const st = stageOverlay.style[nodeId]
      base = { ...base, ...(st.fill !== undefined ? { fillColor: st.fill } : {}), ...(st.stroke !== undefined ? { strokeColor: st.stroke } : {}), ...(st.shape !== undefined ? { shape: st.shape } : {}) }
    }
    if (!organize) return base
    const props = propsById[nodeId]
    if (!props) return base
    let out = base
    const col = encodedColorFor(props, organize.colorBy, storePropertyDefs)
    if (col) out = { ...out, fillColor: col }
    const sc = encodedScaleFor(props, organize.sizeBy, sizeDomain)
    if (sc != null) out = { ...out, scale: sc }
    return out
  }, [getVP, organize, propsById, storePropertyDefs, sizeDomain, stageOverlay])

  const scheduleRender = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; setTick(t => t + 1) })
  }, [])

  // Apply a one-shot arrangement: anchor each node at its computed position (store + live sim).
  const applyArrangement = useCallback((placements) => {
    if (!placements || !placements.length) return
    pushUndo()
    placements.forEach(({ id, x, y }) => {
      setAnchor(id, x, y)
      const sn = simNodesRef.current.find(n => n.id === id)
      if (sn) { sn.x = x; sn.y = y; sn.fx = x; sn.fy = y; sn.vx = 0; sn.vy = 0 }
    })
    if (simRef.current) simRef.current.alpha(0.5).restart()
    scheduleRender()
  }, [pushUndo, setAnchor, scheduleRender])

  // Dispatch an arrange layout from the toolbar for node `rootId`, honoring multi-selection.
  const doArrange = useCallback((rootId, layout) => {
    const posMap = new Map(simNodesRef.current.map(n => [n.id, { x: n.x, y: n.y }]))
    const edges = useGraphStore.getState().edges
    const flat = FLAT_LAYOUTS.some(l => l.key === layout)
    const sel = selectedNodeIdsRef.current
    const targets = sel && sel.size > 1 ? [...sel] : [rootId]
    let placements = []
    if (targets.length > 1 && flat) {
      placements = arrangeNodes(targets, layout, posMap)                    // arrange the selection itself
    } else if (targets.length > 1) {
      targets.forEach(t => { placements.push(...arrangeSubtree(t, layout, edges, posMap)) })  // batch each subtree
    } else if (flat) {
      const kids = edges.filter(e => e.source === rootId).map(e => e.target)
      placements = arrangeNodes(kids.length ? kids : [rootId], layout, posMap)
    } else {
      placements = arrangeSubtree(rootId, layout, edges, posMap)
    }
    applyArrangement(placements)
  }, [applyArrangement])

  // Release anchors on a node's entire subtree (children/descendants), letting them float again.
  const doReleaseSubtree = useCallback((rootId) => {
    const edges = useGraphStore.getState().edges
    const cmap = new Map()
    edges.forEach(e => { if (!cmap.has(e.source)) cmap.set(e.source, []); cmap.get(e.source).push(e.target) })
    const sel = selectedNodeIdsRef.current
    const roots = sel && sel.size > 1 ? [...sel] : [rootId]
    const ids = new Set()
    const walk = (id) => { (cmap.get(id) || []).forEach(k => { if (!ids.has(k)) { ids.add(k); walk(k) } }) }
    roots.forEach(r => walk(r))   // descendants only (not the root itself)
    if (!ids.size) return
    pushUndo()
    ids.forEach(id => {
      releaseAnchor(id)
      const sn = simNodesRef.current.find(n => n.id === id)
      if (sn) { sn.fx = null; sn.fy = null }
    })
    if (simRef.current) simRef.current.alpha(0.6).restart()
    scheduleRender()
  }, [pushUndo, releaseAnchor, scheduleRender])

  // Topology → sim
  useEffect(() => {
    const posById = {}
    simNodesRef.current.forEach(n => { posById[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy } })
    const cx = svgRef.current?.clientWidth / 2 || 500
    const cy = svgRef.current?.clientHeight / 2 || 350
    // Parent of each node (first incoming edge) → a new node spawns NEXT TO its parent, not at center.
    const parentOf = {}
    storeEdges.forEach(e => { if (parentOf[e.target] === undefined) parentOf[e.target] = e.source })
    simNodesRef.current = storeNodes.map(n => {
      const vp = { ...DEFAULT_NODE_PROPS, ...(viewNodeProps[n.id] || {}) }
      const prev = posById[n.id]
      let sx, sy
      if (prev) { sx = prev.x; sy = prev.y }
      else {
        const pPos = posById[parentOf[n.id]]   // parent's existing position, if any
        if (pPos) { sx = pPos.x + (Math.random() - 0.5) * 70; sy = pPos.y + 70 + (Math.random() - 0.5) * 30 }
        else { sx = cx + (Math.random() - 0.5) * 120; sy = cy + (Math.random() - 0.5) * 120 }
      }
      return {
        id: n.id, label: n.label, notes: n.notes || '',
        x: sx, y: sy,
        vx: prev?.vx ?? 0, vy: prev?.vy ?? 0,
        fx: vp.fx ?? null, fy: vp.fy ?? null,
      }
    })
    const nodeById = Object.fromEntries(simNodesRef.current.map(n => [n.id, n]))
    simEdgesRef.current = storeEdges
      .filter(e => nodeById[e.source] && nodeById[e.target])
      .map(e => ({ id: e.id, source: nodeById[e.source], target: nodeById[e.target] }))
    // Bounding force: keeps floating contained nodes inside their frame
    const boundingForce = () => alpha => {
      const vp = viewNodePropsRef.current
      for (const node of simNodesRef.current) {
        if (node.fx != null) continue
        const containerId = (vp[node.id] || {}).containedIn
        if (!containerId) continue
        const frame = simNodesRef.current.find(n => n.id === containerId)
        if (!frame) continue
        const fvp = vp[containerId] || {}
        const fr = NODE_R * (fvp.scale || 1)
        const baseShape = fvp.shape === '3d' ? '3d' : (fvp.shape === 'container' ? 'container' : 'frame')
        const { halfW: defHW, halfH: defHH } = shapeDims(baseShape, fr)
        const halfW = fvp.shape === '3d' ? defHW : (fvp.frameHalfW ?? defHW)
        const halfH = fvp.shape === '3d' ? defHH : (fvp.frameHalfH ?? defHH)
        const cx = frame.x || 0, cy = frame.y || 0
        const pad = 30
        if (fvp.shape === 'container') {
          // Containers have their OWN gravity: contents are pulled toward the container's centre (not
          // toward their outside parent), and hard-clamped inside so a link out can't drag them away.
          node.vx += (cx - node.x) * alpha * 0.35
          node.vy += (cy - node.y) * alpha * 0.35
          // Clamp by each node's OWN half-size (+ small margin) so its EDGE — not just its centre —
          // stays inside the box. If the node is bigger than the box, pin it at centre.
          const nvp = vp[node.id] || {}
          const nr = NODE_R * (nvp.scale || 1)
          const nfs = Math.max(9, Math.round(12 * (nvp.scale || 1)))
          const { halfW: nhw, halfH: nhh } = shapeDims(nvp.shape || 'circle', nr, node.label || '', nfs, nvp.labelWidth)
          const mW = nhw + 6, mH = nhh + 6
          node.x = halfW <= mW ? cx : Math.max(cx - halfW + mW, Math.min(cx + halfW - mW, node.x))
          node.y = halfH <= mH ? cy : Math.max(cy - halfH + mH, Math.min(cy + halfH - mH, node.y))
        } else {
          if (node.x < cx - halfW + pad) node.vx += alpha * 10
          if (node.x > cx + halfW - pad) node.vx -= alpha * 10
          if (node.y < cy - halfH + pad) node.vy += alpha * 10
          if (node.y > cy + halfH - pad) node.vy -= alpha * 10
        }
      }
    }

    if (!simRef.current) {
      simRef.current = d3.forceSimulation(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(120).strength(containedLinkStrength))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('collide', d3.forceCollide(NODE_R + 8))
        .force('center', centeringForce())
        .force('bound', boundingForce())
        .alphaDecay(0.04).velocityDecay(0.5).alphaMin(0.005).on('tick', scheduleRender)
    } else {
      // The sim is created empty on first mount, then populated once the project loads. That first
      // empty→populated transition is a FRESH layout (all floating nodes start stacked at screen
      // center), so it needs a full-strength settle — 0.25 decays before they spread, which looked
      // like "everything is pulled to the middle until you move a node". Incremental edits after that
      // stay gentle (0.25) so ordinary changes don't re-explode the layout.
      const wasEmpty = simRef.current.nodes().length === 0
      simRef.current.nodes(simNodesRef.current)
      // While Organize is active it owns the layout (packed + pinned). Re-adding the link force or
      // restarting here on a retag is exactly what yanked every node back into a force layout — the
      // "explosion". Leave the sim alone; the Organize effect re-packs.
      if (organizeActiveRef.current) return
      simRef.current
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(150).strength(containedLinkStrength))
        .alpha(wasEmpty && simNodesRef.current.length ? 0.9 : 0.25).restart()
    }
  }, [storeNodes, storeEdges, scheduleRender]) // eslint-disable-line

  useEffect(() => {
    const { views, activeViewId } = useGraphStore.getState()
    const vp = views.find(v => v.id === activeViewId)?.nodeProps || {}
    simNodesRef.current.forEach(n => {
      const p = { ...DEFAULT_NODE_PROPS, ...(vp[n.id] || {}) }
      n.fx = p.fx ?? null; n.fy = p.fy ?? null
    })
    // Re-settle floaters for the new view's anchors — but never LOWER an already-hotter run (e.g. the
    // initial load's full-strength settle fires on the same render as the first view id).
    if (simRef.current) simRef.current.alpha(Math.max(simRef.current.alpha(), 0.2)).restart()
  }, [activeViewId])

  // ── Organize (force-cluster "pack" by a property) ─────────────────────────
  // Non-destructive: groups nodes by a property value into computed cells; targets live in
  // a ref that forceX/forceY read. NEVER writes fx/fy to the store — exiting restores the
  // mind-map exactly. Live sim nodes have their fx/fy cleared while organizing so forces can
  // move them; restored from viewNodeProps on exit.
  useEffect(() => {
    if (!simRef.current || !svgRef.current) return
    const sim = simRef.current

    if (organize) {
      // DETERMINISTIC CIRCLE PACKING (like d3's classic pack example). NOT a force layout — that kept
      // exploding. d3.packSiblings packs each group's members into a tight circle; the group circles
      // are packed together (bunched, non-overlapping). Nodes are pinned at their packed slots and
      // GLIDE there via a short rAF tween so it still feels alive. A retag re-packs deterministically.
      const groupBy = organize.groupBy
      const def = storePropertyDefs.find(d => d.id === groupBy)
      const W = svgRef.current.clientWidth, H = svgRef.current.clientHeight
      const isLanes = organize.layout === 'lanes'
      const keyOf = (n) => {
        const v = n.props?.[groupBy]
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return '__empty__'
        return String(Array.isArray(v) ? v[0] : v)
      }
      const nodeById = Object.fromEntries(storeNodes.map(n => [n.id, n]))
      const visible = simNodesRef.current.filter(sn => visibleNodeIdsRef.current.has(sn.id))
      const byKey = {}
      visible.forEach(sn => { const k = keyOf(nodeById[sn.id] || {}); (byKey[k] = byKey[k] || []).push(sn.id) })
      const optionKeys = def?.options ? def.options.map(o => o.id) : (def?.type === 'checkbox' ? ['true', 'false'] : [])
      const keys = [...optionKeys]
      Object.keys(byKey).forEach(k => { if (k !== '__empty__' && !keys.includes(k)) keys.push(k) })
      keys.push('__empty__')
      keys.forEach(k => { if (!byKey[k]) byKey[k] = [] })
      const labelFor = (k) => k === '__empty__' ? '(empty)'
        : def?.options?.find(o => o.id === k)?.name ?? (def?.type === 'checkbox' ? (k === 'true' ? '✓' : '—') : k)
      const colorFor = (k) => k === '__empty__' ? '#5a6683' : (def?.options?.find(o => o.id === k)?.color || '#5b6af0')
      const nodeRadius = (id) => {
        const vp = resolveVP(id)
        const { halfW, halfH } = shapeDims(vp.shape || 'circle', NODE_R * (vp.scale || 1), nodeById[id]?.label || '',
          Math.max(9, Math.round(12 * (vp.scale || 1))), vp.labelWidth)
        return Math.hypot(halfW, halfH)
      }
      // 1. Pack each group's members into a tight circle (relative to that group's own centre).
      const gpack = {}
      keys.forEach(k => {
        const ids = byKey[k].slice().sort()   // stable order → stable packing across retags
        if (!ids.length) { gpack[k] = { r: 48, offs: {} }; return }
        const circles = ids.map(id => ({ id, r: nodeRadius(id) + 3 }))
        d3.packSiblings(circles)
        const enc = d3.packEnclose(circles)
        const offs = {}
        circles.forEach(c => { offs[c.id] = { dx: c.x - enc.x, dy: c.y - enc.y } })
        gpack[k] = { r: enc.r + 8, offs }
      })
      // 2. Pack the group circles together (bunched). Anchor the cluster centre once per session.
      const gc = keys.map(k => ({ key: k, r: gpack[k].r + 8 }))
      if (!isLanes) d3.packSiblings(gc)
      else { let x = 0; gc.forEach(c => { c.x = x + c.r; c.y = 0; x += c.r * 2 }) }
      const genc = d3.packEnclose(gc)
      const fresh = !organizeActiveRef.current
        || organizeSessionRef.current?.groupBy !== groupBy
        || organizeSessionRef.current?.layout !== organize.layout
      if (fresh) {
        const T = zoomTransformRef.current
        organizeSessionRef.current = { groupBy, layout: organize.layout, cx: (-T.x + W / 2) / T.k, cy: (-T.y + H / 2) / T.k }
      }
      const { cx: cxW, cy: cyW } = organizeSessionRef.current
      const centerByKey = {}
      gc.forEach(c => { centerByKey[c.key] = { gx: cxW + (c.x - genc.x), gy: cyW + (c.y - genc.y) } })
      // 3. Absolute target positions + group descriptors.
      const targets = {}
      const groups = keys.map(k => {
        const c = centerByKey[k]
        byKey[k].forEach(id => { const o = gpack[k].offs[id] || { dx: 0, dy: 0 }; targets[id] = { x: c.gx + o.dx, y: c.gy + o.dy } })
        return { key: k, cx: c.gx, cy: c.gy, r: gpack[k].r, label: labelFor(k), color: colorFor(k), count: byKey[k].length }
      })
      organizeTargetsRef.current = targets
      organizeActiveRef.current = true
      setOrganizeGroups(groups)
      // No forces — positions are computed. Glide each node to its target, then pin it.
      sim.force('link', null); sim.force('charge', null); sim.force('collide', null)
      sim.force('cluster-x', null); sim.force('cluster-y', null); sim.force('center', null)
      sim.alphaTarget(0).alpha(0)
      cancelAnimationFrame(organizeAnimRef.current)
      const tween = () => {
        let moving = false
        const tg = organizeTargetsRef.current
        simNodesRef.current.forEach(n => {
          const t = tg[n.id]; if (!t) return
          const x0 = n.x == null ? t.x : n.x, y0 = n.y == null ? t.y : n.y
          const dx = t.x - x0, dy = t.y - y0
          if (Math.abs(dx) + Math.abs(dy) > 1) { n.x = x0 + dx * 0.22; n.y = y0 + dy * 0.22; n.fx = null; n.fy = null; moving = true }
          else { n.x = t.x; n.y = t.y; n.fx = t.x; n.fy = t.y }
        })
        scheduleRender()
        if (moving) organizeAnimRef.current = requestAnimationFrame(tween)
      }
      organizeAnimRef.current = requestAnimationFrame(tween)
    } else if (organizeActiveRef.current) {
      // Exit: restore mind-map forces + the stored anchors.
      organizeActiveRef.current = false
      organizeSessionRef.current = null
      cancelAnimationFrame(organizeAnimRef.current)
      setOrganizeGroups([])
      sim.force('cluster-x', null); sim.force('cluster-y', null)
      sim.force('charge', d3.forceManyBody().strength(-300))
      sim.force('collide', d3.forceCollide(NODE_R + 8))
      sim.force('center', centeringForce())
      sim.force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(120).strength(containedLinkStrength))
      const vp = useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.nodeProps || {}
      simNodesRef.current.forEach(n => { const p = vp[n.id] || {}; n.fx = p.fx ?? null; n.fy = p.fy ?? null })
      sim.alpha(0.5).restart()
    }
  }, [organize, storeNodes, storePropertyDefs]) // eslint-disable-line
  useEffect(() => () => cancelAnimationFrame(organizeAnimRef.current), [])

  const getSiblings = useCallback((nodeId) => {
    const parentEdge = storeEdges.find(e => e.target === nodeId)
    const parentId = parentEdge?.source || null
    const siblings = parentId
      ? storeEdges.filter(e => e.source === parentId).map(e => e.target)
      : storeNodes.filter(n => !new Set(storeEdges.map(e => e.target)).has(n.id)).map(n => n.id)
    return { siblings, parentId }
  }, [storeEdges, storeNodes])

  const handleNodeTab = useCallback((nodeId) => {
    const { siblings } = getSiblings(nodeId)
    const idx = siblings.indexOf(nodeId)
    if (siblings.length < 2) return
    const nextId = siblings[(idx + 1) % siblings.length]
    setSelected({ id: nextId, type: 'node' })
    setPendingEditId(nextId)
  }, [getSiblings])

  const handleCreateSister = useCallback((nodeId) => {
    const { parentId } = getSiblings(nodeId)
    const newId = addNode('New node', parentId)
    // Match the source node's plain look (color/shape) — but NOT decorative border effects, spin,
    // blur, or motion (those made every new sister come out looking like patchwork). Duplicate copies
    // the full style; a sister stays clean.
    const src = viewNodePropsRef.current[nodeId] || {}
    NEW_NODE_STYLE_PROPS.forEach(k => { if (src[k] !== undefined) setNodeViewProp(newId, k, src[k]) })
    setSelected({ id: newId, type: 'node' })
    setPendingEditId(newId)
  }, [getSiblings, addNode, setNodeViewProp])

  // Duplicate a node → an independent copy with ALL its content and settings (label, style, notes, and
  // for card nodes the table / media / video / slideshow data — deep-copied so editing the copy never
  // touches the original). Dropped a little below-right of the source. Plain text nodes also enter edit
  // mode for a quick rename.
  const handleDuplicateNode = useCallback((nodeId) => {
    const src = storeNodes.find(n => n.id === nodeId)
    const sn = simNodesRef.current.find(n => n.id === nodeId)
    const x = (sn?.x ?? 0) + 46, y = (sn?.y ?? 0) + 46
    const newId = duplicateNodeAt(nodeId, x, y)
    if (!newId) return
    setTimeout(() => {
      const s2 = simNodesRef.current.find(n => n.id === newId)
      if (s2) { s2.x = x; s2.y = y; s2.fx = x; s2.fy = y }
      scheduleRender()
    }, 0)
    setSelected({ id: newId, type: 'node' })
    const isCard = !!(src && (src.table || src.media || src.ytss || src.list || src.kanban || src.strategy))
    if (!isCard) setPendingEditId(newId)
  }, [storeNodes, duplicateNodeAt, scheduleRender])

  // ── Word generator ──────────────────────────────────────────────────────────
  // wgDialog = { nodeId, mode:'words'|'variations' } while the generate dialog is open.
  const [wgDialog, setWgDialog] = useState(null)
  const [wgBusy, setWgBusy] = useState(false)
  const [wgErr, setWgErr] = useState(null)
  const runWordgen = useCallback(async (nodeId, mode, { count, modifier, seeds, assess }) => {
    setWgBusy(true); setWgErr(null)
    try {
      const st = useGraphStore.getState()
      const node = st.nodes.find(n => n.id === nodeId)
      if (!node) return
      const byId = new Map(st.nodes.map(n => [n.id, n]))
      const parentOf = {}; st.edges.forEach(e => { parentOf[e.target] = e.source })
      const isGen = n => ['word', 'variation'].includes(n?.meta?.wg)
      // The "master" holds the brief (its Notes) + criteria (its non-generated children). When firing from
      // a generated word/variation, walk up to the nearest non-generated ancestor to inherit that context.
      let master = node
      if (mode === 'variations') {
        let cur = parentOf[nodeId], guard = new Set()
        while (cur && !guard.has(cur)) { guard.add(cur); const m = byId.get(cur); if (m && !isGen(m)) { master = m; break } cur = parentOf[cur] }
      }
      const theme = master.label || ''
      const brief = master.notes || ''
      const criteria = st.edges.filter(e => e.source === master.id).map(e => byId.get(e.target))
        .filter(n => n && !isGen(n)).map(n => n.label).filter(Boolean)
      const seedList = (seeds || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
      const { words } = await generateWords({ mode, theme, brief, criteria, seeds: seedList, seed: node.label, modifier, count })
      if (!words.length) { setWgErr('No words came back — try again or adjust the prompt.'); return }
      pushUndo()
      const parent = simNodesRef.current.find(n => n.id === nodeId)
      const cx = parent?.x || 0, cy = parent?.y || 0
      const ids = words.map((w, i) => {
        const id = addNode(w, nodeId)
        setNodeMeta(id, { wg: mode === 'words' ? 'word' : 'variation' })
        return { id, i, label: w }
      })
      // Fan the fresh nodes out around the parent so they don't pile up at the origin.
      setTimeout(() => {
        ids.forEach(({ id, i }) => {
          const sn = simNodesRef.current.find(n => n.id === id)
          if (sn) { const a = (i / ids.length) * Math.PI * 2; const r = 130 + (i % 3) * 28; sn.x = cx + Math.cos(a) * r; sn.y = cy + Math.sin(a) * r }
        })
        scheduleRender()
      }, 0)
      // Optional trademark / brand-collision screen → ring each name green/amber/red + note the reason.
      let keepOpen = false
      if (assess && hasWordgenKey()) {
        try {
          const results = await assessRisk(words, { theme, brief })
          const RC = { low: '#16a34a', medium: '#f6ad55', high: '#f87171' }
          results.forEach((r, i) => {
            const target = ids.find(x => x.label.toLowerCase() === r.name.toLowerCase()) || ids[i]
            if (!target) return
            const color = RC[r.risk] || RC.medium
            // Colour the TEXT (works for shape:'none', which has no body/border) AND ring shaped nodes.
            setNodeViewProp(target.id, 'textColor', color)
            setNodeViewProp(target.id, 'strokeColor', color)
            setNodeViewProp(target.id, 'strokeWidth', 2.5)
            setNodeMeta(target.id, { risk: r.risk })
            if (r.note) updateNotes(target.id, `⚠ ${r.risk} infringement risk — ${r.note}`)
          })
        } catch (e) { setWgErr('Names generated, but risk assessment failed: ' + (e?.message || 'error')); keepOpen = true }
      }
      if (!keepOpen) setWgDialog(null)
    } catch (e) {
      setWgErr(e?.message || 'Generation failed.')
    } finally {
      setWgBusy(false)
    }
  }, [addNode, setNodeMeta, setNodeViewProp, updateNotes, pushUndo, scheduleRender])

  // ── Direct content generation: type a verbal prompt → Claude writes into the node ──
  // genDialog = { nodeId } while open. The GenerateDialog handles its own prompt/preview;
  // this only applies the confirmed text back into the doc (notes / children / label).
  const [genDialog, setGenDialog] = useState(null)
  const [autoStyleNode, setAutoStyleNode] = useState(null)   // nodeId whose auto-style config is open
  const [ytssInspectorId, setYtssInspectorId] = useState(null)   // which YouTube-slideshow node's editor is open
  const [ytssActiveId, setYtssActiveId] = useState(null)         // which ytss is "entered" (arrows drive it)
  const [ytssIdxMap, setYtssIdxMap] = useState({})              // current clip index per ytss node id
  const [ytssEndedId, setYtssEndedId] = useState(null)         // the entered ytss that has reached its end (shows replay)
  const [ytssFullscreenId, setYtssFullscreenId] = useState(null)   // ytss playing in real browser fullscreen
  const [videoEdit, setVideoEdit] = useState(null)                 // { kind:'image'|'media', id } — a single YouTube video's options panel
  const [videoFullscreen, setVideoFullscreen] = useState(null)     // a single YouTube clip playing fullscreen: {youtubeId,start,end,muted}
  const ytssHandlesRef = useRef({})                            // { [nodeId]: live player handle }
  const videoPreviewHandleRef = useRef(null)                   // live handle of the video being trim-edited (previews on its node)
  const videoEndLoopRef = useRef(null)                         // interval looping the last ~2s while dragging the END handle
  const clearVideoEndLoop = () => { if (videoEndLoopRef.current) { clearInterval(videoEndLoopRef.current); videoEndLoopRef.current = null } }
  const videoEditSelRef = useRef({ start: 0, end: 0 })            // current trim of the video being edited
  // While dragging a trim handle: show a paused frame at that exact time on the node (frame-accurate).
  const videoScrubTo = useCallback((t) => { const h = videoPreviewHandleRef.current; if (!h) return; clearVideoEndLoop(); h.seek?.(t); h.pause?.() }, [])
  // On release (and on open): play the trimmed selection on a loop so the selection stays visible.
  const videoLoopSel = useCallback((s, e) => {
    const h = videoPreviewHandleRef.current; if (!h) return
    clearVideoEndLoop()
    const lo = s || 0, hi = (e && e > lo) ? e : 0
    h.seek?.(lo); h.play?.()
    if (hi) videoEndLoopRef.current = setInterval(() => { const t = h.time?.() || 0; if (t >= hi - 0.12 || t < lo - 0.4) h.seek?.(lo) }, 180)
  }, [])
  const setVideoPreviewHandle = useCallback(h => {
    videoPreviewHandleRef.current = h
    if (h) { const sel = videoEditSelRef.current; setTimeout(() => videoLoopSel(sel.start || 0, sel.end || 0), 350) }
  }, [videoLoopSel])
  useEffect(() => { if (!videoEdit) { clearVideoEndLoop(); videoPreviewHandleRef.current = null } }, [videoEdit])
  const ytssIdxMapRef = useRef(ytssIdxMap); useEffect(() => { ytssIdxMapRef.current = ytssIdxMap }, [ytssIdxMap])
  const ytssPlayingRef = useRef(false)
  const ytssActiveRef = useRef(null); useEffect(() => { ytssActiveRef.current = ytssActiveId }, [ytssActiveId])
  const ytssEndedRef = useRef(null); useEffect(() => { ytssEndedRef.current = ytssEndedId }, [ytssEndedId])
  // Leaving a slideshow (nav away, deselect, Esc, end-ladder) resets it to clip 0, so returning replays
  // from the beginning rather than resuming where it was.
  const prevYtssActiveRef = useRef(null)
  useEffect(() => {
    const prev = prevYtssActiveRef.current
    if (prev && prev !== ytssActiveId) { setYtssIdxMap(m => ({ ...m, [prev]: 0 })); ytssHandlesRef.current[prev]?.pause?.() }
    prevYtssActiveRef.current = ytssActiveId
  }, [ytssActiveId])
  // Enter a slideshow and start playing its current clip (used by double-click, ▶, and arrow-nav arrival).
  // If the slideshow is set to play fullscreen, go straight to the fullscreen player instead of inline.
  const enterYtssAndPlay = useCallback((nodeId) => {
    const yss = useGraphStore.getState().nodes.find(n => n.id === nodeId)?.ytss
    const clips = yss?.clips || []
    if (!clips.length) { setYtssActiveId(nodeId); setYtssEndedId(null); return }
    if (yss.fullscreen) { ytssHandlesRef.current[nodeId]?.pause?.(); setYtssActiveId(null); setYtssEndedId(null); setYtssFullscreenId(nodeId); return }
    // Marking active makes the node autoplay its current slide. The current slide's player is already
    // mounted (cued) while idle, so calling play() here — inside the user gesture — starts it WITH sound.
    ytssPlayingRef.current = true
    setYtssActiveId(nodeId); setYtssEndedId(null)
    ytssHandlesRef.current[nodeId]?.play?.()
  }, [])
  // The slideshow a pasted/dropped YouTube link should land in: the entered one, or a selected ytss node.
  const ytssTargetRef = useRef(null)
  const addClipToYtss = useCallback((nodeId, youtubeId) => {
    const st = useGraphStore.getState(); const node = st.nodes.find(n => n.id === nodeId)
    if (!node?.ytss) return
    const clips = node.ytss.clips || []
    const nc = { id: crypto.randomUUID(), kind: 'youtube', youtubeId, title: '', start: 0, end: 0, trigger: 'click', delayMs: 1500 }
    setYtssClips(nodeId, [...clips, nc])
    setYtssIdxMap(m => ({ ...m, [nodeId]: clips.length }))
  }, [setYtssClips])
  // Append any media slide (image/audio/video/youtube) to a slideshow.
  const addSlideToYtss = useCallback((nodeId, slide) => {
    const st = useGraphStore.getState(); const node = st.nodes.find(n => n.id === nodeId)
    if (!node?.ytss) return
    const clips = node.ytss.clips || []
    const defaults = slide.kind === 'image' ? { trigger: 'auto', duration: 5 } : { trigger: 'click', start: 0, end: 0 }
    setYtssClips(nodeId, [...clips, { id: crypto.randomUUID(), title: '', delayMs: 1500, ...defaults, ...slide }])
    setYtssIdxMap(m => ({ ...m, [nodeId]: clips.length }))
  }, [setYtssClips])
  // Upload an image / audio / video file and append it as a slide (swaps the temp src for the hosted URL).
  const swapClipSrc = useCallback((nodeId, from, to) => {
    const cur = useGraphStore.getState().nodes.find(n => n.id === nodeId)
    if (cur?.ytss && to) setYtssClips(nodeId, (cur.ytss.clips || []).map(c => c.src === from ? { ...c, src: to } : c))
  }, [setYtssClips])
  const uploadSlideToYtss = useCallback((nodeId) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/*,audio/*,video/*'
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return
      const title = file.name.replace(/\.[^/.]+$/, '')
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => { addSlideToYtss(nodeId, { kind: 'image', src: reader.result, title }); uploadImageDataUrl(reader.result, projectId).then(url => swapClipSrc(nodeId, reader.result, url && url !== reader.result ? url : null)) }
        reader.readAsDataURL(file)
      } else {
        const kind = file.type.startsWith('audio/') ? 'audio' : 'video'
        const blobUrl = URL.createObjectURL(file)
        addSlideToYtss(nodeId, { kind, src: blobUrl, title })
        uploadMediaFile(file, projectId).then(url => { if (url) { swapClipSrc(nodeId, blobUrl, url); setTimeout(() => URL.revokeObjectURL(blobUrl), 5000) } })
      }
    }
    input.click()
  }, [addSlideToYtss, swapClipSrc, projectId])
  useEffect(() => { ytssTargetRef.current = ytssActiveId || (selected?.type === 'node' && ytssNodeSet.has(selected.id) ? selected.id : null) }, [ytssActiveId, selected, ytssNodeSet])
  // Selecting something else exits the active slideshow (arrows go back to normal nav) — but not during
  // a presentation, where a slideshow is auto-entered without being "selected".
  // Selecting a DIFFERENT node exits the active slideshow (arrows go back to normal nav). Keyed off
  // `selected` only (not ytssActiveId) so an arrow-nav auto-enter — which sets active WITHOUT selecting —
  // isn't torn down the instant it starts. Not during a presentation (auto-entered without selection).
  useEffect(() => {
    if (presentingSlideIdx !== null) return
    const a = ytssActiveRef.current
    if (a && selected?.id !== a) { ytssHandlesRef.current[a]?.pause?.(); setYtssActiveId(null); setYtssEndedId(null) }
  }, [selected, presentingSlideIdx])
  const applyGenerated = useCallback((nodeId, mode, text, { append = false } = {}) => {
    const st = useGraphStore.getState()
    const node = st.nodes.find(n => n.id === nodeId)
    if (!node || !text) return
    pushUndo()
    if (mode === 'label') {
      updateLabel(nodeId, text.trim().replace(/\s+/g, ' ').slice(0, 200))
    } else if (mode === 'prose') {
      const existing = node.notes || ''
      updateNotes(nodeId, append && existing.trim() ? `${existing.trimEnd()}\n\n${text.trim()}` : text.trim())
    } else if (mode === 'list') {
      const items = text.split('\n').map(s => s.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter(Boolean).slice(0, 40)
      if (items.length) {
        const parent = simNodesRef.current.find(n => n.id === nodeId)
        const cx = parent?.x || 0, cy = parent?.y || 0
        const ids = items.map((label, i) => ({ id: addNode(label, nodeId), i }))
        setTimeout(() => {
          ids.forEach(({ id, i }) => {
            const sn = simNodesRef.current.find(n => n.id === id)
            if (sn) { const a = (i / ids.length) * Math.PI * 2; const r = 130 + (i % 3) * 28; sn.x = cx + Math.cos(a) * r; sn.y = cy + Math.sin(a) * r }
          })
          scheduleRender()
        }, 0)
      }
    }
    setGenDialog(null)
  }, [addNode, updateLabel, updateNotes, pushUndo, scheduleRender])

  // USPTO live-trademark check for a set of node ids → badge each with its live-hit count.
  const [usptoBusy, setUsptoBusy] = useState(false)
  const runUSPTOCheck = useCallback(async (ids) => {
    const st = useGraphStore.getState()
    const targets = ids.map(id => ({ id, label: (st.nodes.find(n => n.id === id)?.label || '').trim() })).filter(t => t.label)
    if (!targets.length) return
    setUsptoBusy(true)
    try {
      const map = await checkUSPTO(targets.map(t => t.label))
      let applied = 0
      targets.forEach(t => {
        const r = map[t.label]
        if (r && r.hits != null) { setNodeMeta(t.id, { usptoHits: r.hits, usptoNote: r.note }); applied++ }
      })
      if (applied === 0) alert('USPTO returned no usable counts — the trademark endpoint needs fixing (nothing was changed on your nodes).')
    } catch (e) {
      alert('USPTO check failed: ' + (e?.message || 'error'))
    } finally {
      setUsptoBusy(false)
    }
  }, [setNodeMeta])

  // Zoom â€" pan on background only (not on nodes)
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    // Pan is RIGHT-button drag (or wheel/touch); LEFT-drag is reserved for
    // rubber-band selection, so the two no longer conflict.
    const zoomFilter = e => {
      if (e.type === 'wheel') return true
      if (e.type.startsWith('touch')) return true
      return e.button === 2   // right-button drag pans (anywhere)
    }
    zoomFilterRef.current = zoomFilter
    zoomBehaviorRef.current = d3.zoom()
      .scaleExtent([0.04, 10])
      .filter(zoomFilter)
      .on('zoom', e => {
        zoomTransformRef.current = e.transform
        // A real user pan/zoom (has sourceEvent) reveals frame outlines again; the programmatic
        // zoomToFrame transition has no sourceEvent, so it doesn't clear the auto-hide.
        if (e.sourceEvent) setAutoHideFrames(false)
        scheduleRender()
        // Persist the viewport to localStorage *instantly* so a reload restores it even if
        // the debounced DB save (below) hasn't fired yet. The DB save is the cross-device backup.
        // ONLY on real user gestures — a programmatic transition (arrow-nav / zoom-to-frame) fires a
        // zoom event every animation frame, and a synchronous setItem per frame janks the animation.
        if (e.sourceEvent && projectId && presentingSlideIdxRef.current === null) {
          try {
            localStorage.setItem(`pim:pan:${projectId}:${useGraphStore.getState().activeViewId}`,
              JSON.stringify({ x: e.transform.x, y: e.transform.y, k: e.transform.k }))
          } catch (_) { /* quota / private mode — ignore */ }
        }
        if (panSaveTimerRef.current) clearTimeout(panSaveTimerRef.current)
        panSaveTimerRef.current = setTimeout(() => {
          if (presentingSlideIdxRef.current === null) {
            setViewPan(e.transform.x, e.transform.y, e.transform.k)
            // Final localStorage write once the (user or programmatic) gesture settles.
            if (projectId) { try { localStorage.setItem(`pim:pan:${projectId}:${useGraphStore.getState().activeViewId}`, JSON.stringify({ x: e.transform.x, y: e.transform.y, k: e.transform.k })) } catch (_) { /* ignore */ } }
          }
        }, 600)
      })
    // Pan cursor: a drag-pan (mousedown, not wheel) shows the grabbing hand for its duration.
    zoomBehaviorRef.current
      .on('start', e => { if (e.sourceEvent && e.sourceEvent.type !== 'wheel') setGestureCursor('grabbing') })
      .on('end', () => clearGestureCursor())
    zoomBehaviorRef.current.on('zoom.toolbar', () => setZoomTick(t => t + 1))
    svg.call(zoomBehaviorRef.current)
    svg.on('dblclick.zoom', null)

    // Context menu — opened on the native `contextmenu` event, which fires for EVERY secondary-click
    // gesture on every device (right mouse, Mac Ctrl+click, trackpad two-finger tap / "secondary click").
    // The old approach opened on right-button MOUSEUP, so trackpad/ctrl secondary-clicks (which don't
    // send button 2) never produced a menu. Chrome suppresses `contextmenu` after a right-drag pan, so
    // opening here doesn't pop the menu while panning.
    const el = svgRef.current
    const OVERLAY_SEL = '[data-nodetoolbar],[data-menu],[data-slide-sidebar],input,textarea,select,a,button'
    // Open the right menu at a screen point. isCtrl = a Ctrl+click (background menu only; nodes keep multi-select).
    const openMenuAt = (clientX, clientY, target, isCtrl, forceBg) => {
      if (!el || readOnly) return
      if (target?.closest?.(OVERLAY_SEL)) return
      const rect = el.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return
      const px = clientX - rect.left, py = clientY - rect.top
      const [sx, sy] = zoomTransformRef.current.invert([px, py])
      // A free image placed OVER a table/card node is the user's overlay — right-clicking it must open the
      // PHOTO menu, not the table/card menu underneath. A background image (rendered below the table in
      // paint order) has the table as its DOM target, so the table-surface / cardnode routing below would
      // otherwise steal it. Resolve the image by coordinate first, preferring the topmost (front, then
      // latest-in-array) one. Only kicks in over a table/card surface, so plain node/background right-clicks
      // are unaffected.
      if (!forceBg && !isCtrl && target?.closest?.('[data-table-surface],[data-cardnode]')) {
        const imgs = useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.images || []
        let hitImg = null
        imgs.forEach(im => {
          if (im.visible === false) return
          if (Math.abs(sx - im.x) <= im.width / 2 && Math.abs(sy - im.y) <= im.height / 2) {
            if (!hitImg || (im.z === 'front' ? 1 : 0) >= (hitImg.z === 'front' ? 1 : 0)) hitImg = im
          }
        })
        if (hitImg) {
          setContextMenu(null); setNodeMenu(null); setBulkMenu(null)
          setSelectedImageIds(prev => prev.has(hitImg.id) ? prev : new Set([hitImg.id]))
          setPhotoMenu({ px, py, imageId: hitImg.id })
          return
        }
      }
      // A table manages its own right-click menu (add/delete rows & columns, collapse, delete). Don't
      // also pop the node/background menu over it — unless Shift forces the background menu.
      if (!forceBg && target?.closest?.('[data-table-surface]')) return
      // Big "card" nodes (YouTube slideshow, table, kanban, list, strategy, media) have small circular
      // hitboxes, so a right-click on the card body would otherwise fall through to the background Insert
      // menu. Route it to THAT node's own menu instead — the menu should pertain to the item clicked.
      if (!forceBg) {
        const cardEl = target?.closest?.('[data-cardnode]')
        const cardId = cardEl?.getAttribute('data-cardnode')
        if (cardId && !isCtrl && simNodesRef.current.some(n => n.id === cardId)) {
          setContextMenu(null); setPhotoMenu(null); setBulkMenu(null)
          setSelected({ id: cardId, type: 'node' }); setSelectedImageIds(new Set()); setSelectedNodeIds(new Set())
          setNodeMenu({ nodeId: cardId, px, py })
          return
        }
      }
      // Right-click resolved straight from the DOM target — robust even when a free image overlaps a node
      // (coordinate hit-testing would pick the node underneath). Media NODES carry data-cardnode and were
      // already routed to their node menu above, so this only catches free canvas images.
      if (!forceBg && !isCtrl) {
        const imgEl = target?.closest?.('[data-imgid]')
        const imgId = imgEl?.getAttribute?.('data-imgid')
        if (imgId && (useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.images || []).some(im => im.id === imgId)) {
          setContextMenu(null); setNodeMenu(null); setBulkMenu(null)
          setSelectedImageIds(prev => prev.has(imgId) ? prev : new Set([imgId]))
          setPhotoMenu({ px, py, imageId: imgId })
          return
        }
      }
      // Shift+right-click forces the background menu open even when the cursor is over a node — a reliable
      // escape hatch when the canvas is dense and there's no empty space to click.
      if (forceBg) { setNodeMenu(null); setPhotoMenu(null); setBulkMenu(null); setContextMenu({ px, py, sx, sy }); return }
      // With a multi-selection active, ANY right-click opens the bulk menu — no need to land precisely on a
      // (possibly tiny) selected node. Shift+right-click above is the escape hatch to the background menu.
      const curSel0 = selectedNodeIdsRef.current
      if (!isCtrl && curSel0.size > 1) { setContextMenu(null); setNodeMenu(null); setPhotoMenu(null); setBulkPanel(null); setBulkMenu({ px, py, ids: [...curSel0] }); return }
      let hitNode = null
      for (const n of simNodesRef.current) {
        if (!visibleNodeIdsRef.current.has(n.id) || n.x == null) continue
        const nvp = viewNodePropsRef.current[n.id] || {}
        if (nvp.shape === 'frame') continue
        const nr = NODE_R * (nvp.scale || 1)
        const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, n.label || '',
          Math.max(9, Math.round(12 * (nvp.scale || 1))), nvp.labelWidth)
        if (Math.abs(sx - n.x) <= halfW && Math.abs(sy - n.y) <= halfH) hitNode = n
      }
      if (hitNode && !isCtrl) {
        setContextMenu(null); setPhotoMenu(null)
        const curSel = selectedNodeIdsRef.current
        if (curSel.size > 1 && curSel.has(hitNode.id)) { setNodeMenu(null); setBulkPanel(null); setBulkMenu({ px, py, ids: [...curSel] }); return }
        setSelected({ id: hitNode.id, type: 'node' })
        setSelectedImageIds(new Set()); setSelectedNodeIds(new Set())
        setNodeMenu({ nodeId: hitNode.id, px, py })
        return
      }
      const imgs = useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.images || []
      let hitImg = null
      imgs.forEach(im => { if (im.visible !== false && Math.abs(sx - im.x) <= im.width / 2 && Math.abs(sy - im.y) <= im.height / 2) hitImg = im })
      if (hitImg && !isCtrl) {
        setContextMenu(null); setNodeMenu(null)
        setSelectedImageIds(prev => prev.has(hitImg.id) ? prev : new Set([hitImg.id]))
        setPhotoMenu({ px, py, imageId: hitImg.id })
        return
      }
      if (isCtrl && (hitNode || hitImg)) return   // ctrl-click on a node/image → leave it to multi-select
      setNodeMenu(null); setPhotoMenu(null)
      setContextMenu({ px, py, sx, sy })
    }
    // Menu triggers, split by gesture so a right-DRAG (pan) never opens the menu:
    //  • A tracked press (right mouse button, or Ctrl+left) opens the menu on MOUSEUP, and only if the
    //    pointer didn't move — so right-drag panning is clean.
    //  • The native `contextmenu` event opens it only when there was NO tracked press (e.g. a trackpad
    //    two-finger / secondary tap that sends no button-2 mousedown), so those devices still get a menu.
    let press = null           // { x, y, t, moved, ctrl }
    let suppressContext = false // a right-DRAG just ended → swallow the trailing `contextmenu` (Linux/Win fire it AFTER mouseup)
    const onDown = ev => {
      suppressContext = false  // new gesture — clear any stale suppression
      if (ev.button === 2) press = { x: ev.clientX, y: ev.clientY, t: ev.target, moved: false, ctrl: false, shift: ev.shiftKey }
      else if (ev.button === 0 && ev.ctrlKey && !ev.metaKey) press = { x: ev.clientX, y: ev.clientY, t: ev.target, moved: false, ctrl: true, shift: ev.shiftKey }
      else press = null
    }
    const onMove = ev => { if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) >= 5) press.moved = true }
    const onUp = ev => {
      if (press && press.moved) suppressContext = true   // dragged → the contextmenu that fires right after must NOT open the menu
      else if (press && (ev.button === 2 || (ev.button === 0 && press.ctrl))) openMenuAt(press.x, press.y, press.t, press.ctrl, press.shift)
      press = null
    }
    const onContext = ev => {
      const t = ev.target
      // A right-DRAG (pan) just ended → always swallow the trailing contextmenu, even over an input or
      // contentEditable table cell (Linux/Win fire it AFTER mouseup). Checked BEFORE the form-field
      // exception so right-drag-panning over a table never leaks the browser menu.
      if (suppressContext) { suppressContext = false; ev.preventDefault(); return }
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return   // plain right-click on a form field → keep native menu
      ev.preventDefault()
      if (press) return   // a real button/ctrl press → handled on mouseup (so drags don't open the menu)
      openMenuAt(ev.clientX, ev.clientY, t, ev.ctrlKey && !ev.metaKey, ev.shiftKey)   // untracked gesture (trackpad tap) → open now
    }
    // Slide-scrub focus: arrow keys page through slides ONLY when the slide sidebar was the last thing
    // clicked. Clicking anywhere else (canvas, a node, another panel) disables it, so arrows go back to
    // navigating the tree. Capture-phase so it still sees the sidebar's own stopPropagation'd mousedown.
    const onDownFocus = ev => {
      const inSidebar = ev.target?.closest?.('[data-slide-sidebar]')
      slideNavFocusRef.current = !!inSidebar
      if (inSidebar) {
        const row = ev.target.closest?.('[data-slide-idx]')
        if (row) slideCursorRef.current = parseInt(row.dataset.slideIdx) || 0
      }
    }
    window.addEventListener('contextmenu', onContext, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mousedown', onDownFocus, true)
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    return () => {
      svg.on('.zoom', null)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mousedown', onDownFocus, true)
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('contextmenu', onContext, true)
    }
  }, [scheduleRender, loading])

  // While a delete-confirm modal is open: Enter confirms, Escape cancels. Capture phase +
  // stopImmediatePropagation so the canvas keydown handler (Enter = create sister) doesn't also fire.
  useEffect(() => {
    if (!confirmDelete && !confirmDeleteNodes && !confirmDeleteImage && !confirmDeleteImages) return
    const onKey = e => {
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopImmediatePropagation()
        if (confirmDelete) { pushUndo(); (useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.images || []).forEach(i => { if (i.attachedTo === confirmDelete) updateImage(i.id, { attachedTo: null }) }); deleteNode(confirmDelete); setSelected(null); setConfirmDelete(null) }
        else if (confirmDeleteNodes) { pushUndo(); confirmDeleteNodes.forEach(id => deleteNode(id)); setSelectedNodeIds(new Set()); setSelected(null); setConfirmDeleteNodes(null) }
        else if (confirmDeleteImage) { deleteImage(confirmDeleteImage); setSelectedImageIds(new Set()); setConfirmDeleteImage(null) }
        else if (confirmDeleteImages) { deleteImages(confirmDeleteImages); setSelectedImageIds(new Set()); setDrilledImageId(null); setConfirmDeleteImages(null) }
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation()
        setConfirmDelete(null); setConfirmDeleteNodes(null); setConfirmDeleteImage(null); setConfirmDeleteImages(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirmDelete, confirmDeleteNodes, confirmDeleteImage, confirmDeleteImages, pushUndo, deleteNode, deleteImage, deleteImages, updateImage])

  // Read a saved viewport: localStorage first (instant, survives quick reloads), then the
  // DB-persisted pan on the view (cross-device backup).
  const readSavedPan = useCallback((viewId) => {
    if (projectId) {
      try { const s = localStorage.getItem(`pim:pan:${projectId}:${viewId}`); if (s) return JSON.parse(s) } catch (_) { /* ignore */ }
    }
    return views.find(v => v.id === viewId)?.pan || null
  }, [projectId, views])

  const applyPan = useCallback((pan) => {
    if (!pan || !svgRef.current || !zoomBehaviorRef.current) return false
    const t = d3.zoomIdentity.translate(pan.x, pan.y).scale(pan.k)
    d3.select(svgRef.current).call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
    return true
  }, [scheduleRender])

  // Open/switch-back intro: snap to the maximum zoom-out, then animate IN to the saved pan/zoom —
  // keeping the target's focal point centered so it reads as zooming into the saved viewport.
  const introToPan = useCallback((pan) => {
    const svg = svgRef.current, zb = zoomBehaviorRef.current
    if (!pan || !svg || !zb) return false
    const rect = svg.getBoundingClientRect(), w = rect.width, h = rect.height
    if (!w || !h) return false
    const target = d3.zoomIdentity.translate(pan.x, pan.y).scale(pan.k)
    const wx = (w / 2 - target.x) / target.k, wy = (h / 2 - target.y) / target.k   // world point target centers on
    const startK = zb.scaleExtent()[0]   // maximum zoom-out (min scale)
    const start = d3.zoomIdentity.translate(w / 2 - startK * wx, h / 2 - startK * wy).scale(startK)
    const sel = d3.select(svg)
    sel.call(zb.transform, start)                       // jump to fully zoomed out
    sel.transition().duration(800).ease(d3.easeCubicInOut).call(zb.transform, target)   // …then zoom in
    return true
  }, [])

  // Restore pan/zoom when switching views (instant — the intro is only for opening the graph).
  useEffect(() => {
    applyPan(readSavedPan(activeViewId))
  }, [activeViewId]) // eslint-disable-line

  // Restore pan/zoom once on initial load. The view-switch effect above keys on
  // activeViewId, which doesn't change when the saved view is the default id, so the
  // viewport would never get applied after the async project load. This runs once the
  // project has loaded and the zoom behavior is ready. (drillRoot + active view already
  // restore via the saved view data in loadProjectData.)
  const didRestoreViewRef = useRef(false)
  useEffect(() => {
    if (loading || didRestoreViewRef.current) return
    if (!svgRef.current || !zoomBehaviorRef.current) return
    const pan = readSavedPan(activeViewId)
    // Opening the graph (fresh mount, incl. switching back to the tab): start fully zoomed out and
    // animate in to the saved viewport. Nothing saved → leave the default view.
    if (pan) introToPan(pan)
    didRestoreViewRef.current = true
  }, [loading, views, activeViewId, applyPan, readSavedPan, introToPan])

  // Safety net: any mousedown/right-click outside an open graph menu closes it. The per-menu
  // backdrops already do this, but this document-level capture guarantees a stuck menu can't
  // survive an outside interaction (defends against z-index / event-order regressions).
  useEffect(() => {
    if (!contextMenu && !bulkMenu) return
    const onDown = e => {
      if (e.target?.closest?.('[data-graphmenu]')) return
      setContextMenu(null); setCtxColors(false); setCtxPanel(null)
      setBulkMenu(null); setBulkPanel(null)
    }
    // Defer binding a tick so the same click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('contextmenu', onDown, true)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('contextmenu', onDown, true)
    }
  }, [contextMenu, bulkMenu])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = e => {
      if (readOnly) return   // shared read-only view: no keyboard mutations
      if (!canvasFocused.current) return
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return

      // ── YouTube slideshow "entered": it owns the arrows until Esc. ──
      //   ←/→ prev/next clip · Space play/pause · Shift+←/→ ∓10s · Esc exit
      if (ytssActiveRef.current && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const nid = ytssActiveRef.current
        const yn = useGraphStore.getState().nodes.find(n => n.id === nid)
        const clips = yn?.ytss?.clips || []
        const h = ytssHandlesRef.current[nid]
        const cur = Math.max(0, Math.min(ytssIdxMapRef.current[nid] || 0, clips.length - 1))
        const presenting = presentingSlideIdxRef.current !== null
        const atEnd = ytssEndedRef.current === nid
        const goClip = (ni) => { setYtssEndedId(null); setYtssIdxMap(m => ({ ...m, [nid]: ni })); ytssPlayingRef.current = true }   // idx change → node remounts+autoplays the slide
        // ↑/↓ (outside a presentation) ABANDON the slideshow and resume normal arrow-nav (↑ parent, ↓ child).
        // We exit here but do NOT return, so the event falls through to the nav handler below.
        if (!presenting && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          h?.pause?.(); ytssPlayingRef.current = false
          setYtssActiveId(null); setYtssEndedId(null); setYtssIdxMap(m => ({ ...m, [nid]: 0 }))
          ytssActiveRef.current = null   // treat as not-active for the rest of this keypress
        } else {
          if (e.key === 'Escape') { e.preventDefault(); h?.pause?.(); ytssPlayingRef.current = false; setYtssActiveId(null); setYtssEndedId(null); return }
          if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); h?.seekBy?.(10); return }
          if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); h?.seekBy?.(-10); return }
          if (e.key === ' ') { e.preventDefault(); if (ytssPlayingRef.current) { h?.pause?.(); ytssPlayingRef.current = false } else { h?.play?.(); ytssPlayingRef.current = true } return }
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            if (cur < clips.length - 1) goClip(cur + 1)
            else if (presenting) advanceBuild(1)
            else if (!atEnd) { h?.pause?.(); ytssPlayingRef.current = false; setYtssEndedId(nid) }   // last frame + replay
            else { h?.pause?.(); ytssPlayingRef.current = false; setYtssActiveId(null); setYtssEndedId(null) }   // → show the node on canvas
            return
          }
          if (e.key === 'ArrowLeft') { e.preventDefault(); if (atEnd) { setYtssEndedId(null); h?.play?.(); ytssPlayingRef.current = true } else if (cur > 0) goClip(cur - 1); else if (presenting) advanceBuild(-1); return }
          if (e.key === 'ArrowUp') { e.preventDefault(); jumpSlide(-1); return }
          if (e.key === 'ArrowDown') { e.preventDefault(); jumpSlide(1); return }
          return
        }
      }

      if (e.key === 'Escape') {
        if (nodeMenu) { setNodeMenu(null); return }
        if (photoMenu) { setPhotoMenu(null); return }
        if (bulkMenu) { setBulkMenu(null); setBulkPanel(null); return }
        if (contextMenu) { setContextMenu(null); return }
        if (confirmDeleteImages) { setConfirmDeleteImages(null); return }
        if (cropImageId) { setCropImageId(null); return }
        if (selectedImageIds.size > 0) {
          setSelectedImageIds(new Set()); setDrilledImageId(null)
          // don't return — let existing Escape handling continue for other state
        }
        if (fullscreen3dId) { setFullscreen3dId(null); return }
        if (selectedNodeIds.size > 0) { setSelectedNodeIds(new Set()); return }
        if (presentingSlideIdx !== null) { exitPresentation(); return }
        setSelected(null); setSelectedImageIds(new Set()); setConfirmDelete(null); setConfirmDeleteNodes(null); return
      }

      // Presentation mode — TWO key sets:
      //   BUILDS (stages):  → / Space / Enter = next build, ← = previous build (crossing slides at the ends)
      //   SLIDES (jump):    ↓ / PageDown = next slide, ↑ / PageUp = previous slide (skips remaining builds)
      if (presentingSlideIdx !== null) {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advanceBuild(1); return }
        if (e.key === 'ArrowLeft') { e.preventDefault(); advanceBuild(-1); return }
        if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); jumpSlide(1); return }
        if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); jumpSlide(-1); return }
        return
      }

      // Slide-scrub in EDIT mode: when the slide sidebar was last clicked, arrows zoom to the next/prev
      // slide without entering presentation. Clicking elsewhere clears the focus (handled on mousedown).
      if (slideNavFocusRef.current && slideSimNodes.length > 0 &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1
        slideCursorRef.current = Math.max(0, Math.min(slideSimNodes.length - 1, slideCursorRef.current + dir))
        zoomToFrame(slideSimNodes[slideCursorRef.current])
        return
      }

      // Enter → create child if root node, sister if non-root. Ignore auto-repeat (holding Enter)
      // so a held key can't spit out a run of duplicate nodes.
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && selected?.type === 'node') {
        e.preventDefault()
        if (e.repeat) return
        if (ytssNodeSet.has(selected.id)) { enterYtssAndPlay(selected.id); return }   // Enter a YT slideshow (and play)
        const isRoot = !storeEdges.some(se => se.target === selected.id)
        if (isRoot) {
          pushUndo()
          const newId = addNode('New node', selected.id)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        } else {
          pushUndo()
          handleCreateSister(selected.id)
        }
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        undo()
        return
      }

      // Delete / Backspace — selected drawing (shape/line/emoji/text)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawingId) {
        e.preventDefault()
        deleteDrawing(selectedDrawingId); setSelectedDrawingId(null)
        return
      }

      // Delete / Backspace — canvas images
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImageIds.size > 0) {
        e.preventDefault()
        setConfirmDeleteImages([...selectedImageIds])
        return
      }

      // Delete / Backspace — multiple selected nodes (rubber-band)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeIds.size > 0) {
        e.preventDefault()
        setConfirmDeleteNodes([...selectedNodeIds])
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected?.type === 'edge') { pushUndo(); removeEdge(selected.id); setSelected(null) }
        if (selected?.type === 'node') { setConfirmDelete(selected.id) }
        return
      }

      // Ctrl+A — select all images when canvas focused and no node selected
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !selected && canvasFocused.current) {
        e.preventDefault()
        const images = useGraphStore.getState().views
          .find(v => v.id === useGraphStore.getState().activeViewId)?.images || []
        setSelectedImageIds(new Set(images.map(i => i.id)))
        return
      }

      // Ctrl+G — group selected images
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'g' && selectedImageIds.size >= 2) {
        e.preventDefault()
        groupImages([...selectedImageIds])
        return
      }

      // Ctrl+Shift+G — ungroup selected images
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'G' || e.key === 'g') && selectedImageIds.size > 0) {
        e.preventDefault()
        ungroupImages([...selectedImageIds])
        return
      }

      // Ctrl/Cmd+Shift+Enter → create sister node
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        if (selected?.type === 'node') {
          const { parentId } = getSiblings(selected.id)
          pushUndo()
          const newId = addNode('New node', parentId)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        }
        return
      }

      // Ctrl/Cmd+Enter → create child node (with a node selected), or a floating node (on empty bg)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (selected?.type === 'node') {
          pushUndo()
          const newId = addNode('New node', selected.id)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        } else if (svgRef.current) {
          // nothing selected → drop a floating node, anchored at the viewport center
          pushUndo()
          const [cx, cy] = zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2])
          const gs = useGraphStore.getState()
          const dr = gs.views.find(v => v.id === gs.activeViewId)?.drillRoot
          const newId = addNode('New node', dr || null, cx, cy)   // attach to drilled subtree so it renders there
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
          setTimeout(() => { const sn = simNodesRef.current.find(m => m.id === newId); if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy } scheduleRender() }, 0)
        }
        return
      }

      // Tab → cycle to next sibling (enter edit mode)
      if (e.key === 'Tab' && selected?.type === 'node') {
        e.preventDefault()
        if (e.repeat) return   // holding Tab shouldn't spawn a run of child nodes
        handleNodeTab(selected.id)
        return
      }

      // ── Keyboard tree navigation — changes ONLY the pan/zoom, never the selection ──
      //   ← / →   siblings (arcs out through the sibling group, then into the target)
      //   ↑ parent · ↓ first child · Ctrl/Cmd+↑ jump to root
      //   Shift+↓/↑ zoom depth · + / − (or [ / ]) closeness
      if (!e.altKey && (
            e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
            e.key === '[' || e.key === ']' || e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
        // Resolve the current nav node: last nav focus, else the current selection, else nearest to centre.
        let cur = (navFocusRef.current && visibleNodeIds.has(navFocusRef.current)) ? navFocusRef.current
          : (selected?.type === 'node' && visibleNodeIds.has(selected.id)) ? selected.id : null
        if (!cur) {
          const t = zoomTransformRef.current
          const [wx, wy] = t.invert([(svgRef.current?.clientWidth || 800) / 2, (svgRef.current?.clientHeight || 600) / 2])
          const cand = simNodesRef.current.filter(n => visibleNodeIds.has(n.id))
          if (cand.length) {
            const roots = cand.filter(n => !storeEdges.some(ed => ed.target === n.id))
            const pool = roots.length ? roots : cand
            cur = pool.reduce((best, n) => { const d = Math.hypot((n.x || 0) - wx, (n.y || 0) - wy); return !best || d < best.d ? { id: n.id, d } : best }, null)?.id || null
          }
          if (cur) { e.preventDefault(); navFocusRef.current = cur; navOutRef.current = 0; useGraphStore.getState().setNavFocusNodeId(cur); zoomNavRef.current?.(cur, navDepthRef.current) }
          return
        }
        const goTo = (id, viaIds) => {
          if (!id) return
          navFocusRef.current = id; navOutRef.current = 0; useGraphStore.getState().setNavFocusNodeId(id); zoomNavRef.current?.(id, navDepthRef.current, viaIds)
          // Landing on a YouTube slideshow auto-enters it and starts playing (arrows then drive the clips).
          if (ytssNodeSet.has(id) && ytssActiveRef.current !== id) enterYtssAndPlay(id)
        }

        const closer = e.key === ']' || e.key === '+' || e.key === '='
        const wider = e.key === '[' || e.key === '-' || e.key === '_'
        if ((closer || wider) && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          const nz = Math.max(1.2, Math.min(10, +(navZoomRef.current + (closer ? 0.4 : -0.4)).toFixed(2)))
          navZoomRef.current = nz; setNavZoom(nz)
          zoomNavRef.current?.(cur, navDepthRef.current); showNavHud(navDepthRef.current)
          return
        }
        if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault()
          navDepthRef.current = Math.max(0, Math.min(8, navDepthRef.current + (e.key === 'ArrowDown' ? 1 : -1)))
          zoomNavRef.current?.(cur, navDepthRef.current); showNavHud(navDepthRef.current)
          return
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp') {
          e.preventDefault()
          let r = cur, guard = new Set()
          while (!guard.has(r)) { guard.add(r); const pe = storeEdges.find(ed => ed.target === r); if (!pe) break; r = pe.source }
          goTo(r); return
        }
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            const pe = storeEdges.find(ed => ed.target === cur)
            if (pe) { goTo(pe.source); return }          // has a parent → climb toward the root
            navOutRef.current = Math.min(12, navOutRef.current + 1)   // at a root → advance the zoom-out ladder
            zoomForestRef.current?.(navOutRef.current - 1)            // level 1 = all roots (depth 0), then +1 gen each press
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            // First TRUE child (a node whose primary parent is `cur`) — not just any outgoing link, which
            // could be a sibling-to-sibling connection the user drew.
            const kids = storeEdges.filter(ed => ed.source === cur).map(ed => ed.target)
              .filter(t => (storeEdges.find(ed => ed.target === t)?.source) === cur)
            if (kids.length) goTo(kids[0])
            return
          }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            const { siblings } = getSiblings(cur)
            const idx = siblings.indexOf(cur)
            const delta = e.key === 'ArrowRight' ? 1 : -1
            const nextId = siblings[(idx + delta + siblings.length) % siblings.length]
            if (nextId && nextId !== cur) goTo(nextId, siblings)   // pass the sibling set → arc out then in
            return
          }
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, removeEdge, addNode, getSiblings, handleNodeTab, handleCreateSister, storeEdges, presentingSlideIdx, undo, pushUndo, selectedImageIds, groupImages, ungroupImages, setDrilledImageId, confirmDeleteImages, cropImageId, selectedNodeIds, nodeMenu, photoMenu, contextMenu, selectedDrawingId, deleteDrawing, showNavHud, visibleNodeIds])

  const clientToSim = useCallback((clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect()
    return zoomTransformRef.current.invert([clientX - rect.left, clientY - rect.top])
  }, [])

  const handleNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    canvasFocused.current = true

    // Alt-drag → duplicate: drag a translucent ghost (original stays put); on drop, create a copy —
    // a sister under the same parent, or a floating node if the source has no parent. If the source
    // has children, ask afterwards whether to also copy them.
    if (e.altKey && !(e.metaKey || e.ctrlKey)) {
      const srcSim = simNodesRef.current.find(n => n.id === nodeId)
      if (!srcSim) return
      const vp = viewNodePropsRef.current[nodeId] || {}
      const label = storeNodes.find(n => n.id === nodeId)?.label || ''
      const hasChildren = storeEdges.some(ed => ed.source === nodeId)
      const start = { x: e.clientX, y: e.clientY }
      let moved = false
      setDupGhost({ x: srcSim.x, y: srcSim.y, label, fill: vp.fillColor, shape: vp.shape || 'circle', scale: vp.scale || 1 })
      setGestureCursor('copy')
      const onMove = me => {
        const [sx, sy] = clientToSim(me.clientX, me.clientY)
        if (!moved && Math.hypot(me.clientX - start.x, me.clientY - start.y) < 3) return
        moved = true
        setDupGhost(g => g ? { ...g, x: sx, y: sy } : g)
      }
      const onUp = me => {
        window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
        setDupGhost(null); setGestureCursor(null)
        const [dx, dy] = clientToSim(me.clientX, me.clientY)
        pushUndo()
        const newId = duplicateNodeAt(nodeId, dx, dy)
        if (!newId) return
        setSelected({ id: newId, type: 'node' }); setSelectedNodeIds(new Set())
        setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === newId); if (sn) { sn.x = dx; sn.y = dy; sn.fx = dx; sn.fy = dy } scheduleRender() }, 0)
        if (hasChildren) setDupChildrenPrompt({ srcId: nodeId, newId, cx: me.clientX, cy: me.clientY })
      }
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
      return
    }

    // Ctrl/Cmd-click toggles a node in/out of the multi-selection (no drag) — build a selection by
    // clicking several nodes, then right-click for bulk changes.
    if (e.metaKey || e.ctrlKey) {
      setSelectedNodeIds(prev => { const s = new Set(prev); if (s.has(nodeId)) s.delete(nodeId); else s.add(nodeId); return s })
      setSelected(null); setSelectedImageIds(new Set())
      return
    }

    // If this node is part of a multi-selection, keep that selection and move all
    // of them together; otherwise it's a normal single selection.
    const curNodeSel = selectedNodeIdsRef.current
    const multiDrag = curNodeSel.has(nodeId) && curNodeSel.size > 1
    if (!multiDrag) {
      setSelected({ id: nodeId, type: 'node' })
      setSelectedNodeIds(new Set())
      setSelectedImageIds(new Set())
      setDrilledImageId(null)
      setCropImageId(null)
    }
    setHoveredNodeId(null) // hide toolbar while dragging
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    simRef.current.alphaTarget(0.3).restart()

    const _dragShape = (viewNodePropsRef.current[nodeId] || {}).shape
    const isFrame = _dragShape === 'frame' || _dragShape === 'container'   // both drag their contained nodes along
    // A YouTube video node can be dropped INTO a YouTube slideshow — enable that hover target while dragging one.
    const _dragMedia = useGraphStore.getState().nodes.find(n => n.id === nodeId)?.media
    // Any media node (youtube/video/audio/image) can be dropped INTO a slideshow.
    const isDragMedia = !!_dragMedia && (!!_dragMedia.youtubeId || !!_dragMedia.src)

    // Collect drag group
    let dragGroup = [simNode]
    if (multiDrag) {
      dragGroup = simNodesRef.current.filter(n => curNodeSel.has(n.id))
    } else if (isFrame) {
      // Frame drag: also move all nodes contained in this frame
      simNodesRef.current.forEach(n => {
        if (n.id !== nodeId && (viewNodePropsRef.current[n.id] || {}).containedIn === nodeId)
          dragGroup.push(n)
      })
    } else if (e.shiftKey) {
      // Shift-drag: collect exclusive descendants (children with only one parent)
      const parentCount = {}
      storeEdges.forEach(ed => { parentCount[ed.target] = (parentCount[ed.target] || 0) + 1 })
      const exclusiveDescendants = (id) => {
        storeEdges.forEach(ed => {
          if (ed.source === id && parentCount[ed.target] === 1) {
            const child = simNodesRef.current.find(n => n.id === ed.target)
            if (child) { dragGroup.push(child); exclusiveDescendants(ed.target) }
          }
        })
      }
      exclusiveDescendants(nodeId)
    }

    const [startSx, startSy] = clientToSim(e.clientX, e.clientY)
    const startPositions = dragGroup.map(n => ({ node: n, ox: n.fx ?? n.x ?? 0, oy: n.fy ?? n.y ?? 0, wasAnchored: n.fx !== null }))
    // Media attached to any node in the drag group follows it (group move).
    const dragIdSet = new Set(dragGroup.map(n => n.id))
    const dragViewImgs = useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.images || []
    const attachedStart = dragViewImgs.filter(im => im.attachedTo && dragIdSet.has(im.attachedTo)).map(im => ({ id: im.id, ox: im.x, oy: im.y }))
    let didDrag = false
    let lastClient = { x: e.clientX, y: e.clientY }
    let panRaf = null

    const onMove = me => {
      lastClient = { x: me.clientX, y: me.clientY }
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const ddx = sx - startSx, ddy = sy - startSy
      if (!didDrag && Math.abs(ddx) < 2 && Math.abs(ddy) < 2) return
      if (!didDrag) {
        setGestureCursor('grabbing')
        if (dragGroup.length > 1) setMovingIds(new Set(dragGroup.map(g => g.id)))   // highlight all nodes moving together
      }
      didDrag = true
      startPositions.forEach(({ node, ox, oy }) => { node.fx = ox + ddx; node.fy = oy + ddy })
      attachedStart.forEach(a => updateImage(a.id, { x: a.ox + ddx, y: a.oy + ddy }))   // attached media follows

      // Hover-detect: highlight the drop target — a node (reparent) OR a container (toss-in). Prefer an
      // inner node over the container it sits in, so you can still reparent onto a node inside a container.
      if (!isFrame && !multiDrag) {
        let foundNode = null, foundContainer = null, foundYtss = null
        for (const n of simNodesRef.current) {
          if (n.id === nodeId) continue
          const nvp = viewNodePropsRef.current[n.id] || {}
          if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.visible === false || !visibleNodeIdsRef.current.has(n.id)) continue
          // A slideshow node is a drop target for any dragged media (youtube/video/audio/image).
          if (isDragMedia && ytssNodeSet.has(n.id)) {
            const scale = nvp.ytssScale || 1
            if (Math.abs((n.x || 0) - sx) < 240 * scale && Math.abs((n.y || 0) - sy) < 135 * scale) { foundYtss = n.id; break }
            continue
          }
          if (ytssNodeSet.has(n.id)) continue
          const nr = NODE_R * (nvp.scale || 1)
          let halfW, halfH
          if (nvp.shape === 'container') {
            const d = shapeDims('container', nr); halfW = nvp.frameHalfW ?? d.halfW; halfH = nvp.frameHalfH ?? d.halfH
          } else {
            const nFontSize = Math.max(9, Math.round(12 * (nvp.scale || 1)))
            ;({ halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, n.label || '', nFontSize, nvp.labelWidth))
          }
          if (Math.abs((n.x || 0) - sx) < halfW && Math.abs((n.y || 0) - sy) < halfH) {
            if (nvp.shape === 'container') { if (!foundContainer) foundContainer = n.id } else { foundNode = n.id; break }
          }
        }
        const found = foundYtss || foundNode || foundContainer
        if (found !== dragHoverNodeIdRef.current) {
          dragHoverNodeIdRef.current = found
          setDragHoverNodeId(found)
        }
      }
    }

    // Auto-pan: while dragging with the cursor inside a canvas-edge margin, pan the view toward that
    // edge and keep the dragged node(s) under the cursor — so you can drag into off-screen space.
    const applyDragPositions = () => {
      const [sx, sy] = clientToSim(lastClient.x, lastClient.y)
      const ddx = sx - startSx, ddy = sy - startSy
      startPositions.forEach(({ node, ox, oy }) => { node.fx = ox + ddx; node.fy = oy + ddy })
    }
    const EDGE_M = 55, EDGE_V = 16
    const edgePan = () => {
      panRaf = requestAnimationFrame(edgePan)
      if (!didDrag || !svgRef.current || !zoomBehaviorRef.current) return
      const r = svgRef.current.getBoundingClientRect()
      let vx = 0, vy = 0
      if (lastClient.x < r.left + EDGE_M) vx = -(EDGE_M - (lastClient.x - r.left)) / EDGE_M
      else if (lastClient.x > r.right - EDGE_M) vx = (EDGE_M - (r.right - lastClient.x)) / EDGE_M
      if (lastClient.y < r.top + EDGE_M) vy = -(EDGE_M - (lastClient.y - r.top)) / EDGE_M
      else if (lastClient.y > r.bottom - EDGE_M) vy = (EDGE_M - (r.bottom - lastClient.y)) / EDGE_M
      if (!vx && !vy) return
      vx = Math.max(-1, Math.min(1, vx)); vy = Math.max(-1, Math.min(1, vy))
      const k = zoomTransformRef.current.k || 1
      d3.select(svgRef.current).call(zoomBehaviorRef.current.translateBy, -vx * EDGE_V / k, -vy * EDGE_V / k)
      applyDragPositions()
      scheduleRender()
    }
    panRaf = requestAnimationFrame(edgePan)

    const onUp = ue => {
      if (panRaf) cancelAnimationFrame(panRaf)
      clearGestureCursor()
      simRef.current.alphaTarget(0)
      setMovingIds(null)   // clear the group-move highlight

      // Clear hover highlight (remember what was highlighted so the drop can honor it — WYSIWYG).
      const hoveredAtDrop = dragHoverNodeIdRef.current
      dragHoverNodeIdRef.current = null
      setDragHoverNodeId(null)

      if (didDrag) {
        const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
        const ddx = sx - startSx, ddy = sy - startSy

        // Drop a canvas media node onto a slideshow → append it as a slide and remove the standalone
        // node from the canvas. Any media kind qualifies; the target is the hover-highlighted slideshow.
        if (isDragMedia && hoveredAtDrop && ytssNodeSet.has(hoveredAtDrop) && hoveredAtDrop !== nodeId) {
          const dn = useGraphStore.getState().nodes.find(n => n.id === nodeId)
          const slide = elementToSlide(dn?.media, dn?.label)
          if (slide) {
            pushUndo()
            addSlideToYtss(hoveredAtDrop, slide)
            deleteNode(nodeId)
            if (selectedRef.current?.id === nodeId) setSelected(null)
            playDrop()
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            return
          }
        }

        // Organize mode: drops reassign the group property, never touch fx/fy or topology.
        // The nearest group cell → that property value; the "(empty)" cell clears it.
        if (organizeActiveRef.current && organizeRef.current) {
          const groupBy = organizeRef.current.groupBy
          const def = storePropertyDefsRef.current.find(d => d.id === groupBy)
          const groups = organizeGroupsRef.current
          const dragged = multiDrag ? [...selectedNodeIdsRef.current] : [nodeId]
          dragged.forEach(id => {
            const sp = startPositions.find(p => p.node.id === id)
            const dx = sp ? sp.ox + ddx : sx, dy = sp ? sp.oy + ddy : sy
            let best = null, bestD = Infinity
            groups.forEach(g => {
              const d = ((dx - g.cx) ** 2) + ((dy - g.cy) ** 2)
              if (d < bestD) { bestD = d; best = g }
            })
            if (!best) return
            const k = best.key
            let value
            if (k === '__empty__') value = def?.type === 'multiSelect' ? [] : null
            else if (def?.type === 'multiSelect') value = [k]
            else if (def?.type === 'checkbox') value = k === 'true'
            else value = k
            setNodeProp(id, groupBy, value)
          })
          // Release the dragged node(s) so the clustering force can carry them into their new pack.
          // The effect re-run (from setNodeProp) updates the target centre + gently reheats the sim.
          dragGroup.forEach(n => { n.fx = null; n.fy = null })
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          return
        }

        // Reparent: if dropped on another regular node, make it a child.
        if (!isFrame && !multiDrag && dragHoverNodeIdRef.current === null) {
          // re-check at drop position since the hover ref was just cleared
          let dropTarget = null
          for (const n of simNodesRef.current) {
            if (n.id === nodeId) continue
            const nvp = viewNodePropsRef.current[n.id] || {}
            if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.shape === 'container' || nvp.visible === false || !visibleNodeIdsRef.current.has(n.id)) continue
            const nr = NODE_R * (nvp.scale || 1)
            const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, n.label || '', Math.max(9, Math.round(12 * (nvp.scale || 1))), nvp.labelWidth)
            const sp = startPositions.find(p => p.node.id === nodeId)
            const dropX = sp ? sp.ox + ddx : sx, dropY = sp ? sp.oy + ddy : sy
            if (Math.abs((n.x || 0) - dropX) < halfW && Math.abs((n.y || 0) - dropY) < halfH) {
              dropTarget = n.id; break
            }
          }
          if (dropTarget) {
            pushUndo()
            reparentNode(nodeId, dropTarget)
            playDrop()
            // If the new parent's children are collapsed, the reparented node stays hidden under it
            // (consistent with the collapsed branch) — recover it by expanding the parent. The cycle
            // guard in reparentNode already prevents the branch from being orphaned/lost.
            // Release so D3 settles near new parent
            simNode.fx = null; simNode.fy = null
            releaseAnchor(nodeId)
            simRef.current.alpha(0.4).restart()
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            return
          }
        }

        startPositions.forEach(({ node, ox, oy, wasAnchored }) => {
          const newX = ox + ddx, newY = oy + ddy
          if (node.id === nodeId || wasAnchored) {
            node.fx = newX; node.fy = newY
            setAnchor(node.id, newX, newY)
          } else {
            node.x = newX; node.y = newY
            node.fx = null; node.fy = null
          }
        })

        // For regular nodes: check if dropped inside a frame/container → update containedIn.
        if (!isFrame && !multiDrag) {
          const sp = startPositions.find(p => p.node.id === nodeId)
          const dropX = sp ? sp.ox + ddx : sx
          const dropY = sp ? sp.oy + ddy : sy
          let newContainerId = null
          // 1) Whatever the drag highlighted (cursor-based) wins, so what glows green is what you get.
          const hov = hoveredAtDrop
          if (hov && hov !== nodeId && (viewNodePropsRef.current[hov] || {}).shape === 'container') newContainerId = hov
          // 2) Fallback / frames: a box counts as hit if EITHER the cursor OR the node centre is inside it.
          if (!newContainerId) for (const fn of simNodesRef.current) {
            if (fn.id === nodeId) continue
            const fvp = viewNodePropsRef.current[fn.id] || {}
            if ((fvp.shape !== 'frame' && fvp.shape !== '3d' && fvp.shape !== 'container') || fvp.visible === false) continue
            const fr = NODE_R * (fvp.scale || 1)
            const base = fvp.shape === '3d' ? '3d' : (fvp.shape === 'container' ? 'container' : 'frame')
            const { halfW: dHW, halfH: dHH } = shapeDims(base, fr)
            const halfW = fvp.shape === '3d' ? dHW : (fvp.frameHalfW ?? dHW)
            const halfH = fvp.shape === '3d' ? dHH : (fvp.frameHalfH ?? dHH)
            const cxD = fn.x || 0, cyD = fn.y || 0
            const inByCenter = Math.abs(dropX - cxD) < halfW && Math.abs(dropY - cyD) < halfH
            const inByCursor = Math.abs(sx - cxD) < halfW && Math.abs(sy - cyD) < halfH
            if (inByCenter || inByCursor) { newContainerId = fn.id; break }
          }
          // Only record undo when the container actually changes (not on every plain move)
          const curContainer = viewNodePropsRef.current[nodeId]?.containedIn ?? null
          const curCvp = curContainer ? (viewNodePropsRef.current[curContainer] || {}) : null
          // Pulled OUT of a container to empty space: honor the container's drag-out mode.
          if (curContainer && newContainerId === null && curCvp?.shape === 'container') {
            const mode = curCvp.containerDragOut || 'springback'
            if (mode === 'springback') {
              // Snap the node back inside the box — it can't leave except into another container.
              const cn = simNodesRef.current.find(n => n.id === curContainer)
              const fr = NODE_R * (curCvp.scale || 1)
              const { halfW: dHW, halfH: dHH } = shapeDims('container', fr)
              const hw = (curCvp.frameHalfW ?? dHW) - NODE_R, hh = (curCvp.frameHalfH ?? dHH) - NODE_R
              const nx = Math.max((cn?.x || 0) - hw, Math.min((cn?.x || 0) + hw, dropX))
              const ny = Math.max((cn?.y || 0) - hh, Math.min((cn?.y || 0) + hh, dropY))
              simNode.x = nx; simNode.y = ny; simNode.fx = null; simNode.fy = null
              releaseAnchor(nodeId)
              simRef.current?.alpha(0.4).restart()
            } else {
              // Release as standalone: leave the container and cut its incoming links (becomes a root).
              pushUndo()
              setContainedIn(nodeId, null)
              useGraphStore.getState().edges.filter(e => e.target === nodeId).forEach(e => removeEdge(e.id))
            }
          } else {
            if (newContainerId !== curContainer) { pushUndo(); if (newContainerId) playDrop() }
            setContainedIn(nodeId, newContainerId)
            // Dropped INTO a container → release its anchor so the container's centre-gravity drives it
            // (an anchored node is skipped by the bounding force and would just sit where it landed).
            const newCvp = newContainerId ? (viewNodePropsRef.current[newContainerId] || {}) : null
            if (newCvp?.shape === 'container') { releaseAnchor(nodeId); simNode.fx = null; simNode.fy = null }
          }
          // Containment changed → recompute link strengths so d3 actually weakens the parent-pull on the
          // now-contained node (forceLink caches strengths at init; without this it keeps yanking it out).
          // Deferred to the next frame so the store/ref reflect the new containedIn first.
          if (newContainerId !== curContainer) {
            requestAnimationFrame(() => { simRef.current?.force('link')?.strength(containedLinkStrength); simRef.current?.alpha(0.6).restart() })
          }
        }
      }
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setAnchor, setContainedIn, reparentNode, releaseAnchor, storeEdges, setNodeProp, scheduleRender, updateImage, removeEdge, pushUndo, addClipToYtss, addSlideToYtss, deleteNode, ytssNodeSet, setSelected])

  const handleConnectorMouseDown = useCallback((e, sourceId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const src = simNodesRef.current.find(n => n.id === sourceId)
    if (!src) return
    setGestureCursor('crosshair')   // drawing a connection
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      setConnecting({ sourceId, x1: src.x, y1: src.y, x2: sx, y2: sy })
    }
    const onUp = ue => {
      clearGestureCursor()
      const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
      const hit = simNodesRef.current.find(n => {
        if (n.id === sourceId) return false
        const dx = (n.x||0)-sx, dy = (n.y||0)-sy
        return Math.sqrt(dx*dx+dy*dy) < NODE_R + 20
      })
      if (hit) addEdge(sourceId, hit.id)
      else setPendingEditId(addNode('New node', sourceId, sx, sy))
      setConnecting(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, addEdge, addNode])

  const handleScaleMouseDown = useCallback((e, nodeId, currentScale, minScale = 0.3, maxScale = 6) => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const startDist = Math.sqrt((sx0 - simNode.x)**2 + (sy0 - simNode.y)**2)
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const d = Math.sqrt((sx - simNode.x)**2 + (sy - simNode.y)**2)
      if (startDist < 1) return
      setNodeViewProp(nodeId, 'scale', Math.max(minScale, Math.min(maxScale, Math.round(currentScale * d / startDist * 10) / 10)))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  // "Scale shape only" — resize the box while keeping the absolute text size; text reflows.
  // Round/fixed shapes: change scale and compensate fontScale so 12*scale*fontScale is constant.
  // Auto-sized rects: change the wrap width (line length) instead, since their box derives from text.
  const handleBoxScaleMouseDown = useCallback((e, nodeId, isAutoSized) => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    if (isAutoSized) {
      const onMove = me => {
        const [sx] = clientToSim(me.clientX, me.clientY)
        setNodeViewProp(nodeId, 'labelWidth', Math.max(36, Math.min(500, Math.abs(sx - (simNode.x || 0)))))
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
      return
    }
    const { views, activeViewId } = useGraphStore.getState()
    const vp = { ...DEFAULT_NODE_PROPS, ...(views.find(v => v.id === activeViewId)?.nodeProps[nodeId] || {}) }
    const curScale = vp.scale ?? 1, curFontScale = vp.fontScale ?? 1
    const product = curScale * curFontScale            // hold constant → absolute font fixed
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const startDist = Math.hypot(sx0 - simNode.x, sy0 - simNode.y)
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const d = Math.hypot(sx - simNode.x, sy - simNode.y)
      if (startDist < 1) return
      const newScale = Math.max(0.3, Math.min(6, Math.round(curScale * d / startDist * 10) / 10))
      setNodeViewProp(nodeId, 'scale', newScale)
      setNodeViewProp(nodeId, 'fontScale', product / newScale)
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleLabelWidthMouseDown = useCallback((e, nodeId) => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    const onMove = me => {
      const [sx] = clientToSim(me.clientX, me.clientY)
      const newHalfW = Math.max(36, Math.min(500, Math.abs(sx - (simNode.x || 0))))
      setNodeViewProp(nodeId, 'labelWidth', newHalfW)
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  // Resize a frame by dragging a corner; the OPPOSITE corner stays pinned (Miro/Tinkercad style),
  // so the frame grows toward the cursor instead of scaling symmetrically about its center. `corner`
  // is one of tl|tr|bl|br (default br). Because a frame's geometry is center + halfW/halfH, pinning a
  // corner means the center must move — we update the live sim node AND persist the anchor on release.
  const handleFrameResizeMouseDown = useCallback((e, nodeId, corner = 'br') => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    const { views: vs, activeViewId: av } = useGraphStore.getState()
    const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
    const fr = NODE_R * (vp.scale || 1)
    const { halfW: defHW, halfH: defHH } = shapeDims('frame', fr)
    const halfW0 = vp.frameHalfW ?? defHW, halfH0 = vp.frameHalfH ?? defHH
    const sgnX = corner.includes('l') ? -1 : 1   // which corner is being dragged
    const sgnY = corner.includes('t') ? -1 : 1
    // Pivot = the opposite corner, fixed in world coords for the whole drag.
    const pivotX = (simNode.x || 0) - sgnX * halfW0
    const pivotY = (simNode.y || 0) - sgnY * halfH0
    // Containers carry their contents: as the box moves/shrinks, contained nodes shift with the centre
    // and get clamped inside so none are left outside the boundary.
    const isContainer = vp.shape === 'container'
    const contained = isContainer ? simNodesRef.current.filter(n => viewNodePropsRef.current[n.id]?.containedIn === nodeId) : []
    let prevCx = simNode.x || 0, prevCy = simNode.y || 0
    const onMove = me => {
      const [mx, my] = clientToSim(me.clientX, me.clientY)
      const newHW = Math.max(80, Math.abs(mx - pivotX) / 2)
      const newHH = Math.max(60, Math.abs(my - pivotY) / 2)
      const newCx = pivotX + sgnX * newHW, newCy = pivotY + sgnY * newHH
      simNode.x = newCx; simNode.y = newCy; simNode.fx = newCx; simNode.fy = newCy
      if (isContainer) {
        const dx = newCx - prevCx, dy = newCy - prevCy
        const pad = 30
        contained.forEach(cn => {
          cn.x = (cn.x || 0) + dx; cn.y = (cn.y || 0) + dy   // follow the centre shift
          cn.x = Math.max(newCx - newHW + pad, Math.min(newCx + newHW - pad, cn.x))   // clamp inside
          cn.y = Math.max(newCy - newHH + pad, Math.min(newCy + newHH - pad, cn.y))
          if (cn.fx != null) { cn.fx = cn.x; cn.fy = cn.y }
        })
        prevCx = newCx; prevCy = newCy
      }
      setNodeViewProp(nodeId, 'frameHalfW', newHW)
      setNodeViewProp(nodeId, 'frameHalfH', newHH)
      scheduleRender()
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp)
      hideDragShield()
      setAnchor(nodeId, simNode.x, simNode.y)   // persist the new center so the pinned corner sticks
      if (isContainer) { contained.forEach(cn => { if (cn.fx != null) setAnchor(cn.id, cn.fx, cn.fy) }); simRef.current?.alpha(0.4).restart() }
    }
    showDragShield('nwse-resize')
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp, setAnchor, scheduleRender])

  // Media node (a node carrying `node.media`): drag = full node behavior (move/shift-drag/reparent);
  // resize = scale the media keeping aspect, pinning the opposite corner. Rendered via ImageNode.
  const handleMediaNodeMouseDown = useCallback((e, nodeId, mode = 'drag', arg) => {
    if (mode === 'drag') { handleNodeMouseDown(e, nodeId); return }
    if (mode !== 'resize') return
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId); if (!simNode) return
    const media = storeNodes.find(n => n.id === nodeId)?.media; if (!media) return
    const corner = arg || 'br'
    const sgnX = corner.includes('l') ? -1 : 1, sgnY = corner.includes('t') ? -1 : 1
    const w0 = media.width || 200, h0 = media.height || 150, ar = w0 / h0 || 1
    const pivotX = (simNode.x || 0) - sgnX * w0 / 2, pivotY = (simNode.y || 0) - sgnY * h0 / 2
    const onMove = me => {
      const [mx, my] = clientToSim(me.clientX, me.clientY)
      const nw = Math.max(60, Math.abs(mx - pivotX)), nh = nw / ar
      const ncx = pivotX + sgnX * nw / 2, ncy = pivotY + sgnY * nh / 2
      simNode.x = ncx; simNode.y = ncy; simNode.fx = ncx; simNode.fy = ncy
      updateNodeMedia(nodeId, { width: Math.round(nw), height: Math.round(nh) })
      scheduleRender()
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); hideDragShield(); setAnchor(nodeId, simNode.x, simNode.y) }
    showDragShield('nwse-resize')
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }, [handleNodeMouseDown, clientToSim, updateNodeMedia, scheduleRender, setAnchor, storeNodes])

  const handleRelease = useCallback((nodeId) => {
    releaseAnchor(nodeId)
    const s = simNodesRef.current.find(n => n.id === nodeId)
    if (s) { s.fx = null; s.fy = null }
    simRef.current?.alpha(0.3).restart()
  }, [releaseAnchor])

  const handleEmojiDragStart = useCallback((e, nodeId, emojiId) => {
    e.stopPropagation(); e.preventDefault()
    const node = simNodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const angle = Math.atan2(sy - (node.y || 0), sx - (node.x || 0))
      const { views: vs, activeViewId: av } = useGraphStore.getState()
      const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
      setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).map(em => em.id === emojiId ? { ...em, angle } : em))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleRemoveEmoji = useCallback((nodeId, emojiId) => {
    const { views: vs, activeViewId: av } = useGraphStore.getState()
    const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
    setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).filter(em => em.id !== emojiId))
  }, [setNodeViewProp])

  const handleEmojiResizeStart = useCallback((e, nodeId, emojiId) => {
    e.stopPropagation(); e.preventDefault()
    const { views: vs0, activeViewId: av0 } = useGraphStore.getState()
    const vp0 = vs0.find(v => v.id === av0)?.nodeProps?.[nodeId] || {}
    const startScale = (vp0.nodeEmojis || []).find(em => em.id === emojiId)?.scale || 1
    // Pivot from live node center — avoids stale closure coords
    const liveNode = simNodesRef.current.find(n => n.id === nodeId)
    const pivotX = liveNode?.x || 0
    const pivotY = liveNode?.y || 0
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const startDist = Math.max(8, Math.hypot(sx0 - pivotX, sy0 - pivotY))
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const dist = Math.hypot(sx - pivotX, sy - pivotY)
      const scale = Math.min(4, Math.max(0.4, startScale * (dist / startDist)))
      const { views: vs, activeViewId: av } = useGraphStore.getState()
      const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
      setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).map(em => em.id === emojiId ? { ...em, scale } : em))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp, simNodesRef])

  // ── In-node images (above/below/beside/perimeter) ──────────────
  const handleImageDragStart = useCallback((e, nodeId, imageId) => {
    e.stopPropagation(); e.preventDefault()
    const node = simNodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const angle = Math.atan2(sy - (node.y || 0), sx - (node.x || 0))
      const { views: vs, activeViewId: av } = useGraphStore.getState()
      const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
      setNodeViewProp(nodeId, 'nodeImages', (vp.nodeImages || []).map(im => im.id === imageId ? { ...im, angle } : im))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleImageResizeStart = useCallback((e, nodeId, imageId, bx, by) => {
    e.stopPropagation(); e.preventDefault()
    const { views: vs0, activeViewId: av0 } = useGraphStore.getState()
    const vp0 = vs0.find(v => v.id === av0)?.nodeProps?.[nodeId] || {}
    const startScale = (vp0.nodeImages || []).find(im => im.id === imageId)?.scale || 1
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const startDist = Math.max(8, Math.hypot(sx0 - bx, sy0 - by))
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const dist = Math.hypot(sx - bx, sy - by)
      const scale = Math.min(4, Math.max(0.25, startScale * (dist / startDist)))
      const { views: vs, activeViewId: av } = useGraphStore.getState()
      const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
      setNodeViewProp(nodeId, 'nodeImages', (vp.nodeImages || []).map(im => im.id === imageId ? { ...im, scale } : im))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleImageCropDragStart = useCallback((e, nodeId, imageId, edge, imgW, imgH) => {
    e.stopPropagation(); e.preventDefault()
    const { views: vs0, activeViewId: av0 } = useGraphStore.getState()
    const vp0 = vs0.find(v => v.id === av0)?.nodeProps?.[nodeId] || {}
    const img0 = (vp0.nodeImages || []).find(i => i.id === imageId)
    const startCrop = img0?.crop || { x: 0, y: 0, w: 1, h: 1 }
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const ddx = (sx - sx0) / imgW, ddy = (sy - sy0) / imgH
      let { x, y, w, h } = startCrop
      if (edge.includes('l')) { const nx = Math.max(0, Math.min(x + w - 0.05, x + ddx)); w = w - (nx - x); x = nx }
      if (edge.includes('r')) { w = Math.max(0.05, Math.min(1 - x, w + ddx)) }
      if (edge.includes('t')) { const ny = Math.max(0, Math.min(y + h - 0.05, y + ddy)); h = h - (ny - y); y = ny }
      if (edge.includes('b')) { h = Math.max(0.05, Math.min(1 - y, h + ddy)) }
      const { views: vs, activeViewId: av } = useGraphStore.getState()
      const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
      setNodeViewProp(nodeId, 'nodeImages', (vp.nodeImages || []).map(i => i.id === imageId ? { ...i, crop: { x, y, w, h } } : i))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

  const handleRemoveNodeImage = useCallback((nodeId, imageId) => {
    const { views: vs, activeViewId: av } = useGraphStore.getState()
    const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
    setNodeViewProp(nodeId, 'nodeImages', (vp.nodeImages || []).filter(im => im.id !== imageId))
  }, [setNodeViewProp])

  const handleSetNodeImagePosition = useCallback((nodeId, imageId, position) => {
    const { views: vs, activeViewId: av } = useGraphStore.getState()
    const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
    setNodeViewProp(nodeId, 'nodeImages', (vp.nodeImages || []).map(im => im.id === imageId ? { ...im, position } : im))
  }, [setNodeViewProp])

  // ── Collapse/expand — implode descendants toward the parent, explode back to their
  // remembered spots on expand. Pins fx/fy during the tween so D3 doesn't fight it.
  const collapseOriginsRef = useRef({})

  const animateNodesTo = useCallback((nodeIds, targets, duration, onDone) => {
    const startPositions = {}
    nodeIds.forEach(id => {
      const sn = simNodesRef.current.find(n => n.id === id)
      if (sn) startPositions[id] = { x: sn.x || 0, y: sn.y || 0 }
    })
    const t0 = performance.now()
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / duration)
      const ease = 1 - Math.pow(1 - t, 3)
      nodeIds.forEach(id => {
        const sn = simNodesRef.current.find(n => n.id === id)
        const sp = startPositions[id], tp = targets[id]
        if (!sn || !sp || !tp) return
        const nx = sp.x + (tp.x - sp.x) * ease
        const ny = sp.y + (tp.y - sp.y) * ease
        sn.x = nx; sn.y = ny; sn.fx = nx; sn.fy = ny
      })
      scheduleRender()
      if (t < 1) requestAnimationFrame(step)
      else onDone?.()
    }
    requestAnimationFrame(step)
  }, [scheduleRender])

  // Fade nodes in/out by animating a transient `__fadeOp` on the sim node (read by NodeShape). Fade-out
  // nodes are kept rendered by the caller during the fade; onHideDone fires when they should really hide.
  const fadeRunRef = useRef(0)
  const animateFadeOps = useCallback((fadeInIds, fadeOutIds, dur, onHideDone) => {
    const run = ++fadeRunRef.current
    const setOp = (id, v) => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) sn.__fadeOp = v }
    fadeInIds.forEach(id => setOp(id, 0)); fadeOutIds.forEach(id => setOp(id, 1))
    scheduleRender()
    const t0 = performance.now(), D = Math.max(1, dur)
    const step = () => {
      if (run !== fadeRunRef.current) return
      const t = Math.min(1, (performance.now() - t0) / D)
      const e = 1 - Math.pow(1 - t, 3)
      fadeInIds.forEach(id => setOp(id, e)); fadeOutIds.forEach(id => setOp(id, 1 - e))
      scheduleRender()
      if (t < 1) requestAnimationFrame(step)
      else { fadeInIds.forEach(id => setOp(id, undefined)); fadeOutIds.forEach(id => setOp(id, undefined)); onHideDone?.(); scheduleRender() }
    }
    requestAnimationFrame(step)
  }, [scheduleRender])
  const clearFades = useCallback(() => { fadeRunRef.current++; simNodesRef.current.forEach(n => { n.__fadeOp = undefined }) }, [])

  const getDescendantIds = useCallback((nodeId) => {
    const desc = [], seen = new Set(), q = [nodeId]
    while (q.length) {
      const cur = q.shift()
      storeEdges.forEach(e => {
        if (e.source === cur && !seen.has(e.target)) { seen.add(e.target); desc.push(e.target); q.push(e.target) }
      })
    }
    return desc
  }, [storeEdges])

  const handleToggleCollapseAnimated = useCallback((nodeId) => {
    const parentNode = simNodesRef.current.find(n => n.id === nodeId)
    const descIds = getDescendantIds(nodeId)
    if (!parentNode || !descIds.length) { toggleCollapseNode(nodeId); return }

    const { views: vs, activeViewId: av } = useGraphStore.getState()
    const view = vs.find(v => v.id === av)
    const wasCollapsed = (view?.collapsedNodeIds || []).includes(nodeId)
    // Descendants the user (or media-conversion) has ANCHORED must keep their pinned spot through
    // collapse/expand — only unanchored ones get released back to the force layout.
    const npMap = view?.nodeProps || {}
    const anchorOf = (id) => { const p = npMap[id]; return (p && p.fx != null && p.fy != null) ? { x: p.fx, y: p.fy } : null }

    if (!wasCollapsed) {
      // Implode: animate descendants to the parent's position, THEN hide them.
      // Remember each one's offset RELATIVE to the parent (not absolute) so that if the
      // parent gets dragged elsewhere while collapsed, expand still opens them around
      // wherever the parent ended up, not their old absolute spot.
      const parentX0 = parentNode.x || 0, parentY0 = parentNode.y || 0
      descIds.forEach(id => {
        const sn = simNodesRef.current.find(n => n.id === id)
        if (sn) collapseOriginsRef.current[id] = { dx: (sn.x || 0) - parentX0, dy: (sn.y || 0) - parentY0 }
      })
      const target = { x: parentX0, y: parentY0 }
      const targets = {}
      descIds.forEach(id => { targets[id] = target })
      animateNodesTo(descIds, targets, 320, () => {
        // Keep the descendants pinned AT the parent while they fade out. Restoring them to their
        // spread-out (or anchored) spots here makes them briefly reappear during the 0.38s opacity
        // fade — which looks like the node "collapses and reopens on its own". Their true anchor
        // lives in the store (viewProps.fx/fy), so the expand path still restores anchored ones.
        descIds.forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = parentX0; sn.y = parentY0; sn.fx = parentX0; sn.fy = parentY0 } })
        toggleCollapseNode(nodeId)
      })
    } else {
      // Explode: reveal at the parent's CURRENT position, then animate out to each
      // descendant's remembered offset re-applied around that current position. Anchored
      // descendants instead go straight to (and stay at) their pinned spot.
      const px = parentNode.x || 0, py = parentNode.y || 0
      descIds.forEach(id => {
        const sn = simNodesRef.current.find(n => n.id === id); if (!sn) return
        const a = anchorOf(id)
        if (a) { sn.x = a.x; sn.y = a.y; sn.fx = a.x; sn.fy = a.y }
        else { sn.x = px; sn.y = py; sn.fx = px; sn.fy = py }
      })
      toggleCollapseNode(nodeId)
      const freeIds = descIds.filter(id => !anchorOf(id))   // only unanchored ones fly out
      const targets = {}
      freeIds.forEach(id => {
        const off = collapseOriginsRef.current[id]
        targets[id] = off ? { x: px + off.dx, y: py + off.dy } : { x: px, y: py }
      })
      requestAnimationFrame(() => {
        animateNodesTo(freeIds, targets, 320, () => {
          freeIds.forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.fx = null; sn.fy = null } })
          simRef.current?.alpha(0.3).restart()
        })
      })
    }
  }, [getDescendantIds, animateNodesTo, toggleCollapseNode])

  const handleReleaseAll = useCallback(() => {
    releaseAllAnchors()
    simNodesRef.current.forEach(n => { n.fx = null; n.fy = null })
    simRef.current?.alpha(0.5).restart()
  }, [releaseAllAnchors])

  // ── Frame stages (build steps) ──────────────────────────────────────────────
  // Members = nodes contained in the frame + their subtrees. A stage snapshots each member's
  // visibility, position, collapse and scale. Preview is a VIEW-ONLY overlay (never mutates the doc).
  const frameMembers = useCallback((frameId) => {
    const ids = new Set()
    // (a) explicit containment — nodes dragged into the frame get containedIn set.
    storeNodes.forEach(n => { if ((viewNodePropsRef.current[n.id]?.containedIn) === frameId) ids.add(n.id) })
    // (b) geometric containment — anything whose center currently sits inside the frame's box counts,
    // even if containedIn was never set (e.g. nodes created/connected in place rather than dragged in).
    // Without this, a frame the user visually filled but never "dropped into" captures nothing.
    const fvp = { ...DEFAULT_NODE_PROPS, ...(viewNodePropsRef.current[frameId] || {}) }
    const fsn = simNodesRef.current.find(n => n.id === frameId)
    const fx = fsn?.x ?? fvp.fx ?? 0, fy = fsn?.y ?? fvp.fy ?? 0
    const fr = NODE_R * (fvp.scale || 1)
    const { halfW: defHW, halfH: defHH } = shapeDims('frame', fr)
    const hw = fvp.frameHalfW ?? defHW, hh = fvp.frameHalfH ?? defHH
    simNodesRef.current.forEach(n => {
      if (n.id === frameId || typeof n.x !== 'number') return
      const nvp = viewNodePropsRef.current[n.id] || {}
      if (nvp.shape === 'frame') return   // don't swallow other frames
      if (n.x >= fx - hw && n.x <= fx + hw && n.y >= fy - hh && n.y <= fy + hh) ids.add(n.id)
    })
    // NOTE: members are ONLY the nodes physically inside the frame (containment + geometry). We do NOT
    // walk subtrees — a child that lives outside the frame is someone else's business, and pulling it in
    // let a stage move/collapse far-away nodes ("stages messing with other nodes"). In-frame descendants
    // are already caught geometrically; a collapsed in-frame parent hides its subtree via visibleNodeIds.
    return [...ids]
  }, [storeNodes])

  const getFrameStages = useCallback((frameId) => (viewNodePropsRef.current[frameId]?.stages) || [], [])

  // Snapshot the current live arrangement of a frame's members as a stage object.
  const snapshotFrame = useCallback((frameId) => {
    const collapsed = new Set(useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.collapsedNodeIds || [])
    const snap = {}
    frameMembers(frameId).forEach(id => {
      const sn = simNodesRef.current.find(n => n.id === id)
      const vp = getVP(id)
      snap[id] = { v: vp.visible !== false, x: sn?.x ?? vp.fx ?? 0, y: sn?.y ?? vp.fy ?? 0, s: vp.scale || 1, c: collapsed.has(id),
        fill: vp.fillColor, stroke: vp.strokeColor, shp: vp.shape }
    })
    return snap
  }, [frameMembers, getVP])

  // Images whose center currently sits inside the frame's box — captured by stages alongside nodes so
  // photos can animate (position/size/opacity/colorize) across build steps.
  const frameImageIds = useCallback((frameId) => {
    const gs = useGraphStore.getState()
    const imgs = gs.views.find(v => v.id === gs.activeViewId)?.images || []
    const fvp = { ...DEFAULT_NODE_PROPS, ...(viewNodePropsRef.current[frameId] || {}) }
    const fsn = simNodesRef.current.find(n => n.id === frameId)
    const fx = fsn?.x ?? fvp.fx ?? 0, fy = fsn?.y ?? fvp.fy ?? 0
    const fr = NODE_R * (fvp.scale || 1)
    const { halfW: defHW, halfH: defHH } = shapeDims('frame', fr)
    const hw = fvp.frameHalfW ?? defHW, hh = fvp.frameHalfH ?? defHH
    return imgs.filter(im => im.x >= fx - hw && im.x <= fx + hw && im.y >= fy - hh && im.y <= fy + hh).map(im => im.id)
  }, [])

  const snapshotFrameImgs = useCallback((frameId) => {
    const gs = useGraphStore.getState()
    const byId = new Map((gs.views.find(v => v.id === gs.activeViewId)?.images || []).map(im => [im.id, im]))
    const out = {}
    frameImageIds(frameId).forEach(id => {
      const im = byId.get(id); if (!im) return
      out[id] = { x: im.x, y: im.y, w: im.width, h: im.height, v: im.visible !== false,
        o: im.opacity == null ? 1 : im.opacity, tc: im.tint?.color, ta: im.tint?.amount || 0 }
    })
    return out
  }, [frameImageIds])

  // Interpolate two hex colors (#rrggbb) for tint tweening across stages.
  const lerpHexColor = (a, b, t) => {
    const pa = parseInt((a || '#000000').slice(1), 16), pb = parseInt((b || '#000000').slice(1), 16)
    const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255
    const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255
    const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t)
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)
  }
  // Tween the image overlay from a base map to a stage's captured image map. Visibility folds into
  // opacity (hidden → 0) so photos fade rather than pop. `from`/`to` are full-field maps.
  const animateImageOverlay = useCallback((from, to, dur, onDone) => {
    const run = ++imgAnimRunRef.current
    const ids = Object.keys(to)
    if (!ids.length) { setImageStageOverlay(prev => { const n = { ...(prev || {}) }; return n }); onDone?.(); return }
    const t0 = performance.now(), D = Math.max(1, dur)
    const build = (e) => {
      const ov = {}
      ids.forEach(id => {
        const f = from[id] || to[id], tt = to[id]
        const L = (a, b) => a + (b - a) * e
        const tintOn = (f.tintAmount > 0) || (tt.tintAmount > 0)
        ov[id] = {
          x: L(f.x, tt.x), y: L(f.y, tt.y),
          width: Math.max(4, L(f.width, tt.width)), height: Math.max(4, L(f.height, tt.height)),
          opacity: Math.max(0, Math.min(1, L(f.opacity, tt.opacity))),
          tint: tintOn ? { color: lerpHexColor(f.tintColor || tt.tintColor, tt.tintColor || f.tintColor, e), amount: L(f.tintAmount || 0, tt.tintAmount || 0) } : null,
        }
      })
      return ov
    }
    const step = () => {
      if (run !== imgAnimRunRef.current) return
      const t = Math.min(1, (performance.now() - t0) / D)
      const e = 1 - Math.pow(1 - t, 3)
      setImageStageOverlay(prev => ({ ...(prev || {}), ...build(e) }))
      if (t < 1) requestAnimationFrame(step)
      else onDone?.()
    }
    if (dur > 0) requestAnimationFrame(step)
    else setImageStageOverlay(prev => ({ ...(prev || {}), ...build(1) }))
  }, [])

  // The live/current displayed state of an image (overlay if present, else the doc image), as a
  // full-field map entry — used as the tween's starting point.
  const imgFieldsFor = useCallback((im) => {
    const ov = imageStageOverlayRef.current?.[im.id]
    const opacity = ov ? (ov.opacity ?? 1) : (im.opacity == null ? 1 : im.opacity)
    const tint = ov ? ov.tint : im.tint
    return {
      x: ov?.x ?? im.x, y: ov?.y ?? im.y,
      width: ov?.width ?? im.width, height: ov?.height ?? im.height,
      opacity, tintColor: tint?.color, tintAmount: tint?.amount || 0,
    }
  }, [])

  const captureStage = useCallback((frameId) => {
    const stages = getFrameStages(frameId)
    setNodeViewProp(frameId, 'stages', [...stages, { id: crypto.randomUUID(), name: `Stage ${stages.length + 1}`, snap: snapshotFrame(frameId), imgs: snapshotFrameImgs(frameId) }])
  }, [getFrameStages, snapshotFrame, snapshotFrameImgs, setNodeViewProp])

  const updateStage = useCallback((frameId, idx) => {
    const stages = getFrameStages(frameId)
    if (!stages[idx]) return
    setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, snap: snapshotFrame(frameId) } : s))
  }, [getFrameStages, snapshotFrame, setNodeViewProp])

  const setStages = useCallback((frameId, stages) => setNodeViewProp(frameId, 'stages', stages), [setNodeViewProp])

  // Compare a stage's shapes to what's currently shown; bump the morph nonce for any that changed so
  // NodeShape replays a scale-pop. Call this right before applying a stage (edit or play).
  const flagShapeMorphs = useCallback((snap) => {
    const changed = {}
    Object.entries(snap || {}).forEach(([id, s]) => {
      if (s.shp === undefined) return
      const prev = lastShownShapeRef.current[id] ?? getVP(id).shape
      if (s.shp !== prev) changed[id] = ++morphCounterRef.current
      lastShownShapeRef.current[id] = s.shp
    })
    if (Object.keys(changed).length) setShapeMorph(m => ({ ...m, ...changed }))
  }, [getVP])

  // Apply a stage as an overlay: set visibility/collapse overrides + animate member positions. No store writes.
  const applyStage = useCallback((frameId, idx, animate = true) => {
    const stage = getFrameStages(frameId)[idx]; if (!stage) return
    // Act on the UNION of what's currently inside the frame AND everything the stage captured — so a
    // node that a previous stage moved out of the frame box still animates back, and stages captured
    // before the geometric-containment fix still drive whatever they did record.
    const ids = [...new Set([...frameMembers(frameId), ...Object.keys(stage.snap || {})])]
    if (!stageBasePosRef.current) {
      const pos = {}
      ids.forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) pos[id] = { x: sn.x, y: sn.y, fx: sn.fx, fy: sn.fy } })
      stageBasePosRef.current = { frameId, pos }
    }
    // Freeze the force sim while previewing so pinned stage positions actually hold (an unanchored
    // member would otherwise be shoved back to its force-layout spot the instant the tween ends).
    simRef.current?.alphaTarget(0).alpha(0).stop()
    flagShapeMorphs(stage.snap)
    const vis = {}, collapse = {}, scale = {}, style = {}, targets = {}
    ids.forEach(id => {
      const s = stage.snap[id]; if (!s) return
      vis[id] = s.v; collapse[id] = !!s.c; if (s.s != null) scale[id] = s.s
      if (s.fill !== undefined || s.stroke !== undefined || s.shp !== undefined) style[id] = { fill: s.fill, stroke: s.stroke, shape: s.shp }
      targets[id] = { x: s.x, y: s.y }
    })
    const dur = stage.dur != null ? stage.dur : 340
    // Image effects animate alongside nodes (position/size/opacity/colorize; visibility folds into opacity).
    const gsImgs = new Map((useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.images || []).map(im => [im.id, im]))
    const imgTo = {}, imgFrom = {}
    Object.entries(stage.imgs || {}).forEach(([id, s]) => {
      const im = gsImgs.get(id); if (!im) return
      imgTo[id] = { x: s.x, y: s.y, width: s.w, height: s.h, opacity: s.v === false ? 0 : (s.o == null ? 1 : s.o), tintColor: s.tc, tintAmount: s.ta || 0 }
      imgFrom[id] = imgFieldsFor(im)
    })
    const runImgs = () => { if (Object.keys(imgTo).length) animateImageOverlay(imgFrom, imgTo, animate ? dur : 0) }
    // Fade visibility instead of cutting (opt-in per stage). Keep fade-out nodes visible during the fade.
    if (stage.fade && animate && dur > 0) {
      const prevOv = stageOverlayRef.current
      const wasVis = id => prevOv?.vis && id in prevOv.vis ? prevOv.vis[id] : (getVP(id).visible !== false)
      const fadeIn = ids.filter(id => stage.snap[id] && stage.snap[id].v && !wasVis(id))
      const fadeOut = ids.filter(id => stage.snap[id] && !stage.snap[id].v && wasVis(id))
      fadeOut.forEach(id => { vis[id] = true })   // hold visible through the fade
      setStageOverlay({ vis, collapse, scale, style })
      animateNodesTo(Object.keys(targets), targets, dur)
      animateFadeOps(fadeIn, fadeOut, dur, () => setStageOverlay(prev => prev ? { ...prev, vis: { ...prev.vis, ...Object.fromEntries(fadeOut.map(id => [id, false])) } } : prev))
      runImgs()
      scheduleRender()
      return
    }
    setStageOverlay({ vis, collapse, scale, style })
    if (animate && dur > 0) animateNodesTo(Object.keys(targets), targets, dur)
    else Object.keys(targets).forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = targets[id].x; sn.y = targets[id].y; sn.fx = targets[id].x; sn.fy = targets[id].y } })
    runImgs()
    scheduleRender()
  }, [getFrameStages, frameMembers, animateNodesTo, scheduleRender, flagShapeMorphs, animateFadeOps, getVP, imgFieldsFor, animateImageOverlay])

  const enterStagePreview = useCallback((frameId, idx = 0) => {
    if (!getFrameStages(frameId).length) return
    stageBasePosRef.current = null
    setStagePreview({ frameId, idx })
    applyStage(frameId, idx)
  }, [getFrameStages, applyStage])

  const stepStage = useCallback((dir) => {
    setStagePreview(prev => {
      if (!prev) return prev
      const stages = getFrameStages(prev.frameId)
      const idx = Math.max(0, Math.min(stages.length - 1, prev.idx + dir))
      if (idx !== prev.idx) applyStage(prev.frameId, idx)
      return { ...prev, idx }
    })
  }, [getFrameStages, applyStage])

  const exitStagePreview = useCallback(() => {
    const bp = stageBasePosRef.current
    clearFades()
    setStageOverlay(null)
    imgAnimRunRef.current++          // cancel any in-flight image tween
    setImageStageOverlay(null)       // restore photos to their doc state
    if (bp) {
      const ids = Object.keys(bp.pos)
      const targets = {}; ids.forEach(id => targets[id] = { x: bp.pos[id].x, y: bp.pos[id].y })
      animateNodesTo(ids, targets, 280, () => {
        ids.forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.fx = bp.pos[id].fx; sn.fy = bp.pos[id].fy } })
        stageBasePosRef.current = null
        simRef.current?.alpha(0.2).restart()
      })
    }
    setStagePreview(null)
  }, [animateNodesTo, clearFades])

  // Leaving the frame (deselect / select something else) ends the preview and restores the base.
  useEffect(() => {
    if (stagePreview && !(selected?.type === 'node' && selected.id === stagePreview.frameId)) exitStagePreview()
  }, [selected, stagePreview, exitStagePreview])

  // While previewing a frame's stages, ←/→ step through them.
  useEffect(() => {
    if (!stagePreview) return
    const onKey = e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
        e.preventDefault(); e.stopImmediatePropagation(); stepStage(e.key === 'ArrowRight' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stagePreview, stepStage])

  useEffect(() => {
    if (depthExpand !== null) setTimeout(zoomExtents, 30)
  }, [depthExpand]) // eslint-disable-line

  const zoomExtents = useCallback(() => {
    const vis = simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && n.x != null && !isNaN(n.x))
    if (!vis.length || !svgRef.current || !zoomBehaviorRef.current) return
    const xs = vis.map(n => n.x), ys = vis.map(n => n.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const w = svgRef.current.clientWidth, h = svgRef.current.clientHeight, pad = 80
    const k = Math.min((w-pad*2) / Math.max(maxX-minX, NODE_R*6), (h-pad*2) / Math.max(maxY-minY, NODE_R*6), 2.5)
    const t = d3.zoomIdentity.translate(w/2 - k*(minX+maxX)/2, h/2 - k*(minY+maxY)/2).scale(k)
    d3.select(svgRef.current).call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
  }, [visibleNodeIds, scheduleRender])

  const zoomToFrame = useCallback((frameNode, animated = true) => {
    if (!svgRef.current || !zoomBehaviorRef.current) return
    const fvp = { ...DEFAULT_NODE_PROPS, ...(viewNodePropsRef.current[frameNode.id] || {}) }
    const fr = NODE_R * (fvp.scale || 1)
    const { halfW: defHW, halfH: defHH } = shapeDims('frame', fr)
    const halfW = fvp.frameHalfW ?? defHW, halfH = fvp.frameHalfH ?? defHH
    const svgW = svgRef.current.clientWidth, svgH = svgRef.current.clientHeight
    const pad = 40
    const k = Math.min((svgW - pad * 2) / (halfW * 2), (svgH - pad * 2) / (halfH * 2), 3)
    const t = d3.zoomIdentity
      .translate(svgW / 2 - k * (frameNode.x || 0), svgH / 2 - k * (frameNode.y || 0))
      .scale(k)
    const sel = d3.select(svgRef.current)
    if (animated) sel.transition().duration(600).call(zoomBehaviorRef.current.transform, t)
    else sel.call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    setAutoHideFrames(true)   // hide frame outlines while focused on this frame (until next pan/zoom)
    scheduleRender()
  }, [scheduleRender])

  // ── Stage cameras ────────────────────────────────────────────────────────────────
  // A stage camera is a world-space focus rect { cx, cy, w, h }. Fit it to the viewport (same math as
  // zoomToFrame, pointed at a sub-region), so it survives window/viewport resizes. Animate over durMs.
  const applyCamRect = useCallback((cam, animate = true, durMs = 340) => {
    if (!cam || !svgRef.current || !zoomBehaviorRef.current) return
    const svgW = svgRef.current.clientWidth, svgH = svgRef.current.clientHeight
    const pad = 24
    const w = Math.max(1, cam.w), h = Math.max(1, cam.h)
    const k = Math.min((svgW - pad * 2) / w, (svgH - pad * 2) / h, 4)
    const t = d3.zoomIdentity.translate(svgW / 2 - k * cam.cx, svgH / 2 - k * cam.cy).scale(k)
    const sel = d3.select(svgRef.current)
    if (animate && durMs > 0) sel.transition().duration(durMs).call(zoomBehaviorRef.current.transform, t)
    else sel.call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    setAutoHideFrames(true)
    scheduleRender()
  }, [scheduleRender])
  // The world rect currently visible in the viewport — what "Set camera to current view" captures.
  const currentViewRect = useCallback(() => {
    if (!svgRef.current) return null
    const svgW = svgRef.current.clientWidth, svgH = svgRef.current.clientHeight
    const T = zoomTransformRef.current
    const [x0, y0] = T.invert([0, 0]); const [x1, y1] = T.invert([svgW, svgH])
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
  }, [])
  // Bounding rect (world) of the currently-selected nodes, padded — for "Frame selection".
  const selectionCamRect = useCallback(() => {
    const ids = new Set(selectedNodeIdsRef.current)
    if (selectedRef.current?.type === 'node') ids.add(selectedRef.current.id)
    if (!ids.size) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    ids.forEach(id => {
      const sn = simNodesRef.current.find(n => n.id === id); if (!sn) return
      const vp = getVP(id); const nr = NODE_R * (vp.scale || 1)
      const { halfW, halfH } = shapeDims(vp.shape || 'circle', nr, sn.label || '', Math.max(9, Math.round(12 * (vp.scale || 1))), vp.labelWidth)
      x0 = Math.min(x0, sn.x - halfW); x1 = Math.max(x1, sn.x + halfW)
      y0 = Math.min(y0, sn.y - halfH); y1 = Math.max(y1, sn.y + halfH)
    })
    if (!isFinite(x0)) return null
    const padX = (x1 - x0) * 0.18 + 20, padY = (y1 - y0) * 0.18 + 20
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: (x1 - x0) + padX * 2, h: (y1 - y0) + padY * 2 }
  }, [getVP])
  // Effective camera for a stage index: the nearest camera at or before it (inheritance). null = keep
  // the current view (fit-frame was already applied on enter/present).
  const effectiveCam = (stages, idx) => { for (let i = Math.min(idx, stages.length - 1); i >= 0; i--) { if (stages[i]?.cam) return stages[i].cam } return null }
  const moveCamForStage = useCallback((stages, idx, animate, durMs) => { const cam = effectiveCam(stages, idx); if (cam) applyCamRect(cam, animate, durMs) }, [applyCamRect])

  // â"€â"€ Node search / spotlight (Cmd/Ctrl+K or "/") â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  // Pan/zoom the canvas to center a node by id, keeping the current zoom (min 1.2x).
  const focusNode = useCallback((nodeId) => {
    const n = simNodesRef.current.find(x => x.id === nodeId)
    if (!n || !svgRef.current || !zoomBehaviorRef.current) return
    const svgW = svgRef.current.clientWidth, svgH = svgRef.current.clientHeight
    const k = Math.min(Math.max(zoomTransformRef.current.k, 1.2), 3)
    const t = d3.zoomIdentity.translate(svgW / 2 - k * (n.x || 0), svgH / 2 - k * (n.y || 0)).scale(k)
    d3.select(svgRef.current).transition().duration(500).call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
  }, [scheduleRender])

  // Frame a node together with ONE generation of its children (outliner → graph camera sync).
  //  • Normal case (children visible on the canvas): fit the node + its direct children to the screen.
  //  • Node collapsed in the graph (children folded away): no visible children, so we frame the node alone.
  //  • Node not itself rendered (e.g. it's the drill root, folded into a breadcrumb): frame its visible
  //    children instead — this is the "outliner item expanded but graph item collapsed" fallback.
  const focusNodeAndChildren = useCallback((nodeId) => {
    if (!svgRef.current || !zoomBehaviorRef.current) return
    const byId = new Map(simNodesRef.current.map(n => [n.id, n]))
    const childIds = storeEdges.filter(e => e.source === nodeId).map(e => e.target)
    const selfNode = byId.get(nodeId)
    const childNodes = childIds.map(id => byId.get(id)).filter(Boolean)   // only children actually on the canvas
    const targets = [selfNode, ...childNodes].filter(Boolean)
    if (!targets.length) { focusNode(nodeId); return }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const t of targets) {
      const vp = { ...DEFAULT_NODE_PROPS, ...(viewNodePropsRef.current[t.id] || {}) }
      const r = NODE_R * (vp.scale || 1)
      const { halfW: dHW, halfH: dHH } = shapeDims(vp.shape || 'circle', r)
      const hw = vp.shape === 'frame' ? (vp.frameHalfW ?? dHW) : dHW
      const hh = vp.shape === 'frame' ? (vp.frameHalfH ?? dHH) : dHH
      minX = Math.min(minX, (t.x || 0) - hw); maxX = Math.max(maxX, (t.x || 0) + hw)
      minY = Math.min(minY, (t.y || 0) - hh); maxY = Math.max(maxY, (t.y || 0) + hh)
    }
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const svgW = svgRef.current.clientWidth, svgH = svgRef.current.clientHeight
    const pad = 80
    const k = Math.max(0.1, Math.min((svgW - pad * 2) / bw, (svgH - pad * 2) / bh, 2.4))
    const tf = d3.zoomIdentity.translate(svgW / 2 - k * cx, svgH / 2 - k * cy).scale(k)
    d3.select(svgRef.current).transition().duration(500).call(zoomBehaviorRef.current.transform, tf)
    zoomTransformRef.current = tf
    scheduleRender()
  }, [storeEdges, focusNode, scheduleRender])

  // Keyboard-nav camera: frame a node together with `depth` generations of descendants that are on the
  // canvas. depth 0 → the node alone at the configured closeness (navZoom); depth ≥1 → fit the subtree,
  // never zooming in closer than navZoom (so deeper = wider). Used by the arrow-key tree navigation.
  // Fit a set of sim nodes to a transform (box-aware; capped at `capK`).
  const fitNodesTransform = useCallback((nodes, svgW, svgH, pad, capK) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const nd of nodes) {
      const vp = { ...DEFAULT_NODE_PROPS, ...(viewNodePropsRef.current[nd.id] || {}) }
      const r = NODE_R * (vp.scale || 1)
      const { halfW: dHW, halfH: dHH } = shapeDims(vp.shape || 'circle', r)
      const box = (vp.shape === 'frame' || vp.shape === 'container' || vp.shape === '3d')
      const hw = box ? (vp.frameHalfW ?? dHW) : dHW
      const hh = box ? (vp.frameHalfH ?? dHH) : dHH
      minX = Math.min(minX, (nd.x || 0) - hw); maxX = Math.max(maxX, (nd.x || 0) + hw)
      minY = Math.min(minY, (nd.y || 0) - hh); maxY = Math.max(maxY, (nd.y || 0) + hh)
    }
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const k = Math.max(0.06, Math.min((svgW - pad * 2) / bw, (svgH - pad * 2) / bh, capK))
    return d3.zoomIdentity.translate(svgW / 2 - k * cx, svgH / 2 - k * cy).scale(k)
  }, [])

  // Keyboard-nav camera. `viaIds` (e.g. the sibling set) triggers a two-phase move: zoom OUT to frame
  // that set first, then zoom INTO the target — so you glimpse the neighbours in between.
  const zoomToNodeDepth = useCallback((nodeId, depth, viaIds) => {
    if (!svgRef.current || !zoomBehaviorRef.current) return
    const svgEl = svgRef.current
    d3.select(svgEl).interrupt()   // kill any in-flight transition so rapid nav doesn't fight itself
    const byId = new Map(simNodesRef.current.map(n => [n.id, n]))
    const self = byId.get(nodeId); if (!self) return
    const svgW = svgEl.clientWidth, svgH = svgEl.clientHeight
    const zMax = navZoomRef.current || 2.2

    // Target transform: the node alone (at closeness zMax), or the node + `depth` generations, fitted.
    const targets = [self]
    if (depth > 0) {
      let frontier = [nodeId]
      for (let d = 0; d < depth && frontier.length; d++) {
        const next = []
        for (const pid of frontier) {
          for (const ed of storeEdges) {
            if (ed.source !== pid) continue
            const cn = byId.get(ed.target)
            if (cn && !targets.includes(cn)) { targets.push(cn); next.push(ed.target) }
          }
        }
        frontier = next
      }
    }
    const targetT = targets.length === 1
      ? d3.zoomIdentity.translate(svgW / 2 - zMax * (self.x || 0), svgH / 2 - zMax * (self.y || 0)).scale(zMax)
      : fitNodesTransform(targets, svgW, svgH, 70, zMax)

    const via = (viaIds || []).map(id => byId.get(id)).filter(Boolean)
    const sel = d3.select(svgEl)
    if (via.length > 1) {
      // Wide "glimpse" frame of the sibling set, then ease into the target. Don't touch zoomTransformRef
      // up front — the on('zoom') handler updates it each frame, so the camera moves smoothly.
      const wideT = fitNodesTransform(via, svgW, svgH, 130, zMax * 0.9)
      sel.transition().duration(260).ease(d3.easeCubicOut).call(zoomBehaviorRef.current.transform, wideT)
        .transition().duration(360).ease(d3.easeCubicInOut).call(zoomBehaviorRef.current.transform, targetT)
    } else {
      sel.transition().duration(450).ease(d3.easeCubicInOut).call(zoomBehaviorRef.current.transform, targetT)
    }
    scheduleRender()
  }, [storeEdges, scheduleRender, fitNodesTransform])
  useEffect(() => { zoomNavRef.current = zoomToNodeDepth }, [zoomToNodeDepth])

  // ↑-past-root zoom-out ladder: fit ALL roots + `depth` generations of descendants. depth 0 = just the
  // roots; each further press adds a generation; once everything is in frame it's a true fit-to-extents.
  const zoomToForest = useCallback((depth) => {
    if (!svgRef.current || !zoomBehaviorRef.current) return
    const svgEl = svgRef.current
    d3.select(svgEl).interrupt()
    const visSet = visibleNodeIdsRef.current
    const vis = simNodesRef.current.filter(n => visSet.has(n.id))
    if (!vis.length) return
    const byId = new Map(vis.map(n => [n.id, n]))
    const seeds = vis.filter(n => !storeEdges.some(ed => ed.target === n.id)).map(n => n.id)
    const rootIds = seeds.length ? seeds : vis.map(n => n.id)
    const set = new Set(rootIds)
    let frontier = [...rootIds]
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = []
      for (const pid of frontier) for (const ed of storeEdges) if (ed.source === pid && byId.has(ed.target) && !set.has(ed.target)) { set.add(ed.target); next.push(ed.target) }
      frontier = next
    }
    const nodes = [...set].map(id => byId.get(id)).filter(Boolean)
    const svgW = svgEl.clientWidth, svgH = svgEl.clientHeight
    const tf = fitNodesTransform(nodes, svgW, svgH, 90, 1.4)   // capK 1.4 so a small forest doesn't zoom IN
    d3.select(svgEl).transition().duration(450).ease(d3.easeCubicInOut).call(zoomBehaviorRef.current.transform, tf)
    scheduleRender()
  }, [storeEdges, scheduleRender, fitNodesTransform])
  useEffect(() => { zoomForestRef.current = zoomToForest }, [zoomToForest])

  // ── On-frame timeline ("builds") — keyframe editor ──────────────────────────
  // Pose the LIVE document to a stage (keyframe editing): anchors, visibility, scale, collapse are
  // written to the store atomically, and the sim nodes glide to match. This is what makes selecting a
  // stage actually move the frame's contents, so editing = editing that stage.
  const applyStageToDoc = useCallback((frameId, idx, animate = true) => {
    const stages = getFrameStages(frameId); const stage = stages[idx]; if (!stage) return
    const snap = stage.snap || {}
    flagShapeMorphs(snap)
    const dur = stage.dur != null ? stage.dur : 300
    // Fade visibility instead of cutting (opt-in per stage). Keep fade-out nodes visible during the fade,
    // then commit their hidden state when it finishes.
    if (stage.fade && animate && dur > 0) {
      const wasVis = id => getVP(id).visible !== false
      const fadeIn = Object.keys(snap).filter(id => snap[id].v && !wasVis(id))
      const fadeOut = Object.keys(snap).filter(id => !snap[id].v && wasVis(id))
      const held = { ...snap }; fadeOut.forEach(id => { held[id] = { ...snap[id], v: true } })
      applyStagePose(held)
      animateFadeOps(fadeIn, fadeOut, dur, () => fadeOut.forEach(id => setNodeViewProp(id, 'visible', false)))
    } else {
      applyStagePose(snap)
    }
    const targets = {}; Object.entries(snap).forEach(([id, s]) => { targets[id] = { x: s.x, y: s.y } })
    if (animate && dur > 0) animateNodesTo(Object.keys(targets), targets, dur)
    else Object.keys(targets).forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = targets[id].x; sn.y = targets[id].y; sn.fx = targets[id].x; sn.fy = targets[id].y } })
    // Pose the captured images into the doc so this stage's photo positions/effects are what you edit.
    Object.entries(stage.imgs || {}).forEach(([id, s]) => {
      updateImage(id, { x: s.x, y: s.y, width: s.w, height: s.h, visible: s.v !== false,
        opacity: s.o == null ? 1 : s.o, tint: s.ta > 0 ? { color: s.tc, amount: s.ta } : null })
    })
    moveCamForStage(stages, idx, animate, dur > 0 ? dur : 340)
    scheduleRender()
  }, [getFrameStages, applyStagePose, animateNodesTo, scheduleRender, flagShapeMorphs, moveCamForStage, animateFadeOps, getVP, setNodeViewProp, updateImage])

  const writeStageSnap = useCallback((frameId, idx, snap) => {
    const stages = getFrameStages(frameId)
    if (!stages[idx]) return
    setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, snap } : s))
  }, [getFrameStages, setNodeViewProp])

  // Enter timeline mode on a frame: fit it to the viewport, seed a first stage if none, pose stage 0.
  const enterTimeline = useCallback((frameId) => {
    if (stagePreview) exitStagePreview()
    const fnode = simNodesRef.current.find(n => n.id === frameId)
    let stages = getFrameStages(frameId)
    if (!stages.length) {
      const first = { id: crypto.randomUUID(), name: 'Stage 1', snap: snapshotFrame(frameId), imgs: snapshotFrameImgs(frameId), advance: 'click' }
      setNodeViewProp(frameId, 'stages', [first])
      stages = [first]
    }
    setTimelineFrameId(frameId)
    setTimelineStageIdx(0)
    setTimelinePlaying(false)
    if (fnode) zoomToFrame(fnode, true)
  }, [stagePreview, exitStagePreview, getFrameStages, snapshotFrame, snapshotFrameImgs, setNodeViewProp, zoomToFrame])

  const exitTimeline = useCallback(() => {
    if (timelinePlayTimerRef.current) { clearTimeout(timelinePlayTimerRef.current); timelinePlayTimerRef.current = null }
    clearFades()
    setStageOverlay(null)
    imgAnimRunRef.current++
    setImageStageOverlay(null)
    stageBasePosRef.current = null
    setTimelinePlaying(false)
    setTimelineFrameId(null)
  }, [clearFades])

  // Go to (and edit) a stage: pose the doc to it. `record` first flushes the current arrangement into
  // the stage we're leaving, so an un-saved tweak isn't lost when jumping away quickly.
  const gotoTimelineStage = useCallback((idx) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    if (idx < 0 || idx >= stages.length) return
    setTimelineStageIdx(idx)
    applyStageToDoc(frameId, idx, true)
  }, [getFrameStages, applyStageToDoc])

  const addTimelineStage = useCallback(() => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    // New stage clones the CURRENT pose (so you start from where you are, then tweak) — keyframe style.
    const next = { id: crypto.randomUUID(), name: `Stage ${stages.length + 1}`, snap: snapshotFrame(frameId), imgs: snapshotFrameImgs(frameId), advance: 'click' }
    setNodeViewProp(frameId, 'stages', [...stages, next])
    setTimelineStageIdx(stages.length)
  }, [getFrameStages, snapshotFrame, snapshotFrameImgs, setNodeViewProp])

  const deleteTimelineStage = useCallback((idx) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    if (stages.length <= 1) return   // keep at least one
    const next = stages.filter((_, i) => i !== idx)
    setNodeViewProp(frameId, 'stages', next)
    setTimelineStageIdx(i => { const n = Math.max(0, Math.min(next.length - 1, i > idx ? i - 1 : i)); return n })
  }, [getFrameStages, setNodeViewProp])

  const reorderTimelineStage = useCallback((from, to) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    if (to < 0 || to >= stages.length || from === to) return
    const next = [...stages]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved)
    setNodeViewProp(frameId, 'stages', next)
    setTimelineStageIdx(to)
  }, [getFrameStages, setNodeViewProp])

  const renameTimelineStage = useCallback((idx, name) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, name } : s))
  }, [getFrameStages, setNodeViewProp])

  // Per-stage camera (a world focus rect, or undefined to clear/inherit).
  const setTimelineStageCam = useCallback((idx, cam) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId); if (!stages[idx]) return
    setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, cam: cam || undefined } : s))
  }, [getFrameStages, setNodeViewProp])
  const gotoTimelineStageCam = useCallback((idx) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const cam = effectiveCam(getFrameStages(frameId), idx)
    if (cam) applyCamRect(cam, true, 420)
    else { const fn = simNodesRef.current.find(n => n.id === frameId); if (fn) zoomToFrame(fn, true) }
  }, [getFrameStages, applyCamRect, zoomToFrame])
  // Fade (vs cut) the visibility changes when transitioning INTO this stage.
  const setTimelineStageFade = useCallback((idx, fade) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId); if (!stages[idx]) return
    setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, fade: !!fade } : s))
  }, [getFrameStages, setNodeViewProp])

  // Advance trigger: 'click' (wait for Next) or { after: seconds } (auto-play). Only used in Play mode.
  const setTimelineStageAdvance = useCallback((idx, advance) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, advance } : s))
  }, [getFrameStages, setNodeViewProp])

  // Per-stage transition duration (ms) — how fast the move/morph INTO this stage plays. undefined = default.
  const setTimelineStageSpeed = useCallback((idx, dur) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, dur } : s))
  }, [getFrameStages, setNodeViewProp])

  // Auto-record: while editing (not playing), any change to the frame's members is snapshotted into the
  // current stage after a short debounce. Self-correcting: if the live arrangement already equals the
  // stored stage (e.g. right after we posed it), the snapshot matches and we skip the write.
  useEffect(() => {
    if (timelineFrameId == null || timelinePlaying) return
    const frameId = timelineFrameId, idx = timelineStageIdx
    const t = setTimeout(() => {
      const stages = getFrameStages(frameId)
      if (!stages[idx]) return
      const snap = snapshotFrame(frameId)
      const imgs = snapshotFrameImgs(frameId)
      const cur = stages[idx]
      if (JSON.stringify(snap) === JSON.stringify(cur.snap) && JSON.stringify(imgs) === JSON.stringify(cur.imgs || {})) return   // nothing changed
      setNodeViewProp(frameId, 'stages', stages.map((s, i) => i === idx ? { ...s, snap, imgs } : s))
      setTimelineRecordPulse(p => p + 1)
    }, 500)
    return () => clearTimeout(t)
  }, [viewNodeProps, collapsedNodeIds, activeView?.images, timelineFrameId, timelineStageIdx, timelinePlaying, getFrameStages, snapshotFrame, snapshotFrameImgs, setNodeViewProp])

  // Play the builds non-destructively via the overlay, honoring each stage's advance trigger. Timed
  // stages auto-advance; 'click' stages wait for Next (→ / space / the strip's ▶).
  const timelinePlayStep = useCallback((idx) => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    const stages = getFrameStages(frameId)
    if (idx < 0 || idx >= stages.length) { return }
    setTimelineStageIdx(idx)
    applyStage(frameId, idx)   // overlay-based, non-destructive
    if (timelinePlayTimerRef.current) { clearTimeout(timelinePlayTimerRef.current); timelinePlayTimerRef.current = null }
    const nextIdx = idx + 1
    const next = stages[nextIdx]
    if (next && next.advance && typeof next.advance === 'object' && next.advance.after > 0) {
      timelinePlayTimerRef.current = setTimeout(() => timelinePlayStep(nextIdx), next.advance.after * 1000 + 320)
    }
  }, [getFrameStages, applyStage])

  const startTimelinePlay = useCallback(() => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    stageBasePosRef.current = null
    setTimelinePlaying(true)
    timelinePlayStep(0)
  }, [timelinePlayStep])

  const stopTimelinePlay = useCallback(() => {
    if (timelinePlayTimerRef.current) { clearTimeout(timelinePlayTimerRef.current); timelinePlayTimerRef.current = null }
    setTimelinePlaying(false)
    exitStagePreview()   // clears overlay + restores base positions
    // Re-pose the doc to whatever stage we ended on so edit mode resumes cleanly.
    const frameId = timelineFrameIdRef.current
    if (frameId != null) setTimeout(() => applyStageToDoc(frameId, timelineStageIdx, false), 300)
  }, [exitStagePreview, applyStageToDoc, timelineStageIdx])

  const timelinePlayNext = useCallback(() => {
    const frameId = timelineFrameIdRef.current; if (frameId == null) return
    setTimelineStageIdx(i => { const n = Math.min(getFrameStages(frameId).length - 1, i + 1); timelinePlayStep(n); return n })
  }, [getFrameStages, timelinePlayStep])

  // Keyboard: in timeline mode, ←/→ (and space in play mode) walk stages.
  useEffect(() => {
    if (timelineFrameId == null) return
    const onKey = e => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); exitTimeline(); return }
      if (e.key === 'ArrowRight' || ((e.key === ' ' || e.key === 'Enter') && timelinePlaying)) {
        e.preventDefault(); e.stopImmediatePropagation()
        if (timelinePlaying) timelinePlayNext()
        else setTimelineStageIdx(i => { const n = Math.min(getFrameStages(timelineFrameId).length - 1, i + 1); gotoTimelineStage(n); return i })
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); e.stopImmediatePropagation()
        if (!timelinePlaying) setTimelineStageIdx(i => { const n = Math.max(0, i - 1); gotoTimelineStage(n); return i })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [timelineFrameId, timelinePlaying, timelinePlayNext, gotoTimelineStage, getFrameStages, exitTimeline])

  // Read the shared selection (from the docked outliner / command palette) → select that node here and
  // zoom to it (framing one generation of children). Guarded so a selection that ORIGINATED on this
  // canvas doesn't re-zoom. `focusNodeAndChildren` is declared just above, so referencing it is safe.
  const externalSelId = useGraphStore(s => s.selectedNodeId)
  useEffect(() => {
    if (!externalSelId) return
    if (selectedRef.current?.type === 'node' && selectedRef.current.id === externalSelId) return
    if (!simNodesRef.current.some(x => x.id === externalSelId)) return
    setSelected({ id: externalSelId, type: 'node' })
    setTimeout(() => focusNodeAndChildren(externalSelId), 20)   // let the sim settle a frame, then fit
  }, [externalSelId]) // eslint-disable-line

  // Read image-selection requests from the docked outliner's Images section → select that photo here
  // and pan/zoom to it (the nonce lets the same photo be re-jumped repeatedly).
  const imageSelReq = useGraphStore(s => s.selectedImageReq)
  useEffect(() => {
    if (!imageSelReq?.id) return
    const gs = useGraphStore.getState()
    const im = (gs.views.find(v => v.id === gs.activeViewId)?.images || []).find(i => i.id === imageSelReq.id)
    if (!im) return
    setSelected(null); setSelectedNodeIds(new Set())
    setSelectedImageIds(new Set([im.id]))
    const w = (im.width || 120) * 1.8, h = (im.height || 120) * 1.8
    applyCamRect({ cx: im.x, cy: im.y, w, h }, true, 380)
  }, [imageSelReq]) // eslint-disable-line

  // Global drag guard (fixes "glued" media drags): the instant ANY left-button drag moves past a small
  // threshold, disable pointer-events on all media (cross-origin YouTube iframes otherwise swallow the
  // mouseup and glue the drag). Independent of which drag handler runs. Once media is non-interactive
  // the pointer passes through it, so the mouseup reaches the page and the class is removed — self-heals.
  useEffect(() => {
    // ANY left mousedown that reaches the page disables media pointer-events until release. A click on
    // a YouTube iframe's own controls happens INSIDE the (cross-origin) iframe and never reaches this
    // capture listener, so this never blocks the player — but it does kill the iframe's ability to
    // swallow the mouseup during a drag, which was the "glue". No movement threshold = no race.
    const add = () => document.body.classList.add('pim-drag-nomedia')
    const remove = () => document.body.classList.remove('pim-drag-nomedia')
    const onDown = e => { if (e.button === 0 && !e.target?.closest?.('input,textarea,select,[contenteditable="true"]')) add() }
    const onUp = () => remove()
    const onKey = e => { if (e.key === 'Escape') remove() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('blur', onUp)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onUp, true); window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('blur', onUp); window.removeEventListener('keydown', onKey, true)
      document.body.classList.remove('pim-drag-nomedia')
    }
  }, [])

  // Drill zoom memory: entering a drill fits the drilled subtree to the screen; exiting restores the
  // exact pan/zoom you had before you drilled in. Centralised here so every drill entry point (node
  // menu, outline, breadcrumb) behaves the same.
  const preDrillTransformRef = useRef(null)
  const prevDrillRef = useRef(drillRoot)
  useEffect(() => {
    const prev = prevDrillRef.current
    if (prev === drillRoot) return
    prevDrillRef.current = drillRoot
    if (!prev && drillRoot) {
      preDrillTransformRef.current = zoomTransformRef.current           // remember where we were…
      setTimeout(() => zoomExtents(), 60)                               // …then fit the subtree
    } else if (prev && !drillRoot) {
      const t = preDrillTransformRef.current                           // exiting → restore prior view
      if (t && svgRef.current && zoomBehaviorRef.current) {
        d3.select(svgRef.current).transition().duration(500).call(zoomBehaviorRef.current.transform, t)
        zoomTransformRef.current = t
        scheduleRender()
      }
      preDrillTransformRef.current = null
    } else {
      setTimeout(() => zoomExtents(), 60)                               // drilled straight into another subtree
    }
  }, [drillRoot, zoomExtents]) // eslint-disable-line

  // Jump to a node from search. A node can be absent from the canvas for three reasons:
  // it's hidden, the view is drilled into another subtree, or a collapsed ancestor folds
  // it away. Clear all three so the node actually shows, then select and center it.
  const goToNode = useCallback((nodeId) => {
    const st = useGraphStore.getState()
    const view = st.views.find(v => v.id === st.activeViewId)
    // 1) un-hide if hidden (undoable)
    if (view?.nodeProps?.[nodeId]?.visible === false) { pushUndo(); setNodeViewProp(nodeId, 'visible', true) }
    // 2) walk the ancestor chain via edges
    const parentOf = {}
    st.edges.forEach(e => { parentOf[e.target] = e.source })
    const ancestors = []
    let cur = parentOf[nodeId]; const guard = new Set()
    while (cur && !guard.has(cur)) { ancestors.push(cur); guard.add(cur); cur = parentOf[cur] }
    // 3) exit drill if the target isn't inside the drilled subtree
    if (view?.drillRoot && view.drillRoot !== nodeId && !ancestors.includes(view.drillRoot)) exitDrill()
    // 4) expand any collapsed ancestor so the node renders on the canvas
    const collapsed = new Set(view?.collapsedNodeIds || [])
    ancestors.forEach(a => { if (collapsed.has(a)) toggleCollapseNode(a) })
    setSelected({ id: nodeId, type: 'node' })
    setSearchOpen(false); setSearchQuery(''); setSearchIdx(0)
    setTimeout(() => focusNode(nodeId), 140)  // let the un-hide/expand re-render + sim settle
  }, [focusNode, setNodeViewProp, pushUndo, exitDrill, toggleCollapseNode])

  useEffect(() => {
    if (readOnly) return
    const onKey = e => {
      const typing = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setSearchOpen(o => !o) }
      else if (e.key === '/' && !typing && !searchOpen) { e.preventDefault(); setSearchOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly, searchOpen])

  // â"€â"€ Paste images â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  useEffect(() => {
    const onPaste = e => {
      if (readOnly) return
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))
      if (!item) {
        const rect = svgRef.current?.getBoundingClientRect()
        const [cx, cy] = zoomTransformRef.current.invert([(rect?.width ?? 800) / 2, (rect?.height ?? 600) / 2])
        // A copied table (Google Sheets / Docs cells, or a Markdown table) → a Grid node.
        const html = e.clipboardData?.getData('text/html') || ''
        const rawText = e.clipboardData?.getData('text/plain') || ''
        const grid = parseClipboardTable(html, rawText)
        if (grid) {
          e.preventDefault()
          const id = addTableNodeFrom(grid, cx, cy)
          setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = cx; sn.y = cy; sn.fx = cx; sn.fy = cy } scheduleRender() }, 0)
          setSelected({ id, type: 'node' })
          return
        }
        // A YouTube link ANYWHERE in the pasted text → drop a video (or add to a selected slideshow).
        const ytId = parseYoutubeId(rawText)
        if (ytId) {
          e.preventDefault()
          if (ytssTargetRef.current) addClipToYtss(ytssTargetRef.current, ytId)
          else dropYoutube(ytId, cx, cy)
          return
        }
        // A bare (non-YouTube) URL → unfurl it as a link-preview card.
        const text = rawText.trim()
        if (/^https?:\/\/\S+$/i.test(text) && !/\s/.test(text)) {
          e.preventDefault()
          addLinkAt(text, cx, cy)
        }
        return
      }
      const blob = item.getAsFile()
      const reader = new FileReader()
      reader.onload = ev => {
        const src = ev.target.result
        const el = new window.Image()
        el.onload = () => {
          const maxW = 400
          const scale = Math.min(1, maxW / el.width)
          const w = Math.round(el.width * scale), h = Math.round(el.height * scale)
          const rect = svgRef.current?.getBoundingClientRect()
          const [cx, cy] = zoomTransformRef.current.invert([
            (rect?.width ?? 800) / 2, (rect?.height ?? 600) / 2,
          ])
          const imgId = addImage(src, cx, cy, w, h, { z: 'front' })
          uploadImageDataUrl(src, projectId).then(url => { if (url && url !== src) updateImage(imgId, { src: url }) })
        }
        el.src = ev.target.result
      }
      reader.readAsDataURL(blob)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // NOTE: addLinkAt is declared later in this component — do NOT add it to deps (TDZ crash per CLAUDE.md).
    // The effect body's closure resolves it at run time, after render, so referencing it there is safe.
  }, [addImage, readOnly, projectId, updateImage])

  // ── Rubber-band rect select ────────────────────────────────────────────────────
  const handleCanvasMouseDown = useCallback((e) => {
    if (e.button !== 0) return   // left-drag only; right-drag is pan (D3)
    // Clear all selection on canvas background click
    setSelectedImageIds(new Set()); setDrilledImageId(null); setCropImageId(null)
    setSelectedNodeIds(new Set())
    setSelected(null)
    canvasFocused.current = true

    const startClientX = e.clientX, startClientY = e.clientY
    // Convert via clientToSim so the SVG's left/top offset (sidebar + nav) is accounted for.
    const [startSx, startSy] = clientToSim(e.clientX, e.clientY)
    let moved = false

    const onMove = me => {
      const dx = me.clientX - startClientX, dy = me.clientY - startClientY
      if (!moved && Math.hypot(dx, dy) < 4) return
      if (!moved) {
        moved = true
        setGestureCursor('crosshair')   // rubber-band selection
        // Suppress D3 pan for the duration of the rubber-band
        zoomBehaviorRef.current?.filter(() => false)
      }
      const [ex, ey] = clientToSim(me.clientX, me.clientY)
      rubberBandRef.current = { sx: startSx, sy: startSy, ex, ey }
      setRubberBand({ sx: startSx, sy: startSy, ex, ey })
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      clearGestureCursor()
      // Re-enable D3 pan (restore original filter, not a permissive one)
      if (zoomFilterRef.current) zoomBehaviorRef.current?.filter(zoomFilterRef.current)

      if (moved && rubberBandRef.current) {
        didRubberBandRef.current = true   // suppress the trailing canvas click that would clear this
        const rb = rubberBandRef.current
        const x1 = Math.min(rb.sx, rb.ex), y1 = Math.min(rb.sy, rb.ey)
        const x2 = Math.max(rb.sx, rb.ex), y2 = Math.max(rb.sy, rb.ey)
        const images = useGraphStore.getState().views
          .find(v => v.id === useGraphStore.getState().activeViewId)?.images || []
        const drilled = drilledImageId
        const hit = new Set()
        images.forEach(img => {
          const ix1 = img.x - img.width / 2, iy1 = img.y - img.height / 2
          const ix2 = img.x + img.width / 2, iy2 = img.y + img.height / 2
          if (ix1 < x2 && ix2 > x1 && iy1 < y2 && iy2 > y1) {
            // Group expansion — but not for the drilled image
            if (img.groupId && img.id !== drilled) {
              images.filter(i => i.groupId === img.groupId).forEach(i => hit.add(i.id))
            } else {
              hit.add(img.id)
            }
          }
        })
        setSelectedImageIds(hit)
        setDrilledImageId(null)

        // Also rubber-band-select nodes whose body falls in the box
        const nodeHits = new Set()
        simNodesRef.current.forEach(n => {
          if (!visibleNodeIdsRef.current.has(n.id) || n.x == null) return
          const nvp = viewNodePropsRef.current[n.id] || {}
          const nr = NODE_R * (nvp.scale || 1)
          const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, n.label || '',
            Math.max(9, Math.round(12 * (nvp.scale || 1))), nvp.labelWidth)
          if ((n.x - halfW) < x2 && (n.x + halfW) > x1 && (n.y - halfH) < y2 && (n.y + halfH) > y1) {
            nodeHits.add(n.id)
          }
        })
        setSelectedNodeIds(nodeHits)
        // If exactly one node and no images, treat as a normal single selection (shows toolbar)
        if (nodeHits.size === 1 && hit.size === 0) {
          setSelected({ id: [...nodeHits][0], type: 'node' })
        }
      }
      rubberBandRef.current = null
      setRubberBand(null)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [drilledImageId, clientToSim])

  // Paste an image from the clipboard at a given sim position (used by the context menu).
  // Open a file picker and drop the chosen image onto the canvas at (sx, sy).
  // Drag a drawing item from the palette; drop on the canvas → create it at that point (in canvas coords).
  const startDrawDrag = useCallback((kind, defaults, e) => {
    e.preventDefault()
    setDragDraw({ kind, defaults, ghost: { x: e.clientX, y: e.clientY } })
    const move = ev => setDragDraw(d => d ? { ...d, ghost: { x: ev.clientX, y: ev.clientY } } : d)
    const up = ev => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      setDragDraw(null)
      const svg = svgRef.current; if (!svg) return
      const r = svg.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return  // dropped off-canvas
      const [cx, cy] = zoomTransformRef.current.invert([ev.clientX - r.left, ev.clientY - r.top])
      const draw = { kind, x: Math.round(cx), y: Math.round(cy), ...defaults }
      if (kind === 'line' || kind === 'arrow') { draw.x2 = Math.round(cx) + (defaults.dx ?? 120); draw.y2 = Math.round(cy) + (defaults.dy ?? 0) }
      const id = addDrawing(draw)
      setSelectedDrawingId(id); setSelected(null); setSelectedNodeIds(new Set())
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }, [addDrawing])

  const addImageFileAt = useCallback((sx, sy) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/*'
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const el = new window.Image()
        el.onload = () => {
          const MAX = 220
          const ar = el.naturalWidth / el.naturalHeight || 1
          const w = ar >= 1 ? MAX : MAX * ar, h = ar >= 1 ? MAX / ar : MAX
          const imgId = addImage(reader.result, sx, sy, w, h, { z: 'front' })
          uploadImageDataUrl(reader.result, projectId).then(url => { if (url && url !== reader.result) updateImage(imgId, { src: url }) })
        }
        el.src = reader.result
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }, [addImage, updateImage, projectId])

  // Add a video from a local file: read it, size the box to the video's aspect ratio, then offload
  // the file to Storage (same bucket as images) and swap the inline data URL for the public URL.
  const addVideoFileAt = useCallback((sx, sy) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'video/*'
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return
      // Storage bucket caps files at 50 MB; a bigger upload fails silently and leaves a temporary
      // blob URL that dies on reload. Refuse up front so the video never "works then breaks".
      if (file.size > 45 * 1024 * 1024) {
        alert(`That video is ${(file.size / 1024 / 1024).toFixed(0)} MB — over the 45 MB upload limit, so it wouldn’t be saved (it would break on reload). Upload a shorter/smaller clip, or paste a YouTube link instead.`)
        return
      }
      // Preview instantly from a local blob URL (a tiny string — never the whole file in state);
      // upload the file to Storage in the background, then swap to the durable public URL.
      const blobUrl = URL.createObjectURL(file)
      const el = document.createElement('video')
      const finish = (ar, playable) => {
        const MAX = 320
        const w = ar >= 1 ? MAX : MAX * ar, h = ar >= 1 ? MAX / ar : MAX
        const title = file.name.replace(/\.[^/.]+$/, '')   // filename → title (for the outliner when made a child)
        const vid = addVideo({ videoKind: 'file', src: blobUrl, title }, sx, sy, w, h)
        uploadMediaFile(file, projectId).then(url => { if (url) { updateImage(vid, { src: url }); setTimeout(() => URL.revokeObjectURL(blobUrl), 5000) } })
        if (!playable) {
          const ext = (file.name.split('.').pop() || '').toUpperCase()
          alert(`Heads up: browsers can’t play ${ext ? '.' + ext : 'this'} video files (only MP4/H.264, WebM, or Ogg). It uploaded, but it won’t play here — re-export or convert it to MP4 and add that instead.`)
        }
      }
      // The browser actually tries to decode: loadedmetadata = playable; error = unsupported (e.g. AVI/WMV/MKV).
      el.onloadedmetadata = () => finish((el.videoWidth / el.videoHeight) || (16 / 9), true)
      el.onerror = () => finish(16 / 9, false)
      el.preload = 'metadata'
      el.src = blobUrl
    }
    input.click()
  }, [addVideo, updateImage, projectId])

  // Audio card size, and a filename/URL → title helper.
  const AUDIO_W = 260, AUDIO_H = 96
  const audioTitleFrom = (name) => (name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Audio'
  // Add an audio clip from a file (uploaded to Storage) at a world point.
  const addAudioFileAt = useCallback((sx, sy) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'audio/*'
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return
      if (file.size > 45 * 1024 * 1024) { alert(`That audio is ${(file.size / 1024 / 1024).toFixed(0)} MB — over the 45 MB upload limit. Use a smaller file or paste a link instead.`); return }
      const blobUrl = URL.createObjectURL(file)
      const id = addAudio({ src: blobUrl, title: audioTitleFrom(file.name), autoplayOnZoom: false, autoplayOnSlide: false }, sx, sy, AUDIO_W, AUDIO_H)
      uploadMediaFile(file, projectId).then(url => { if (url) { updateImage(id, { src: url }); setTimeout(() => URL.revokeObjectURL(blobUrl), 5000) } })
        .catch(e => console.warn('Audio upload failed:', e?.message || e))
    }
    input.click()
  }, [addAudio, updateImage, projectId])
  // Add an audio clip from a pasted URL at a world point.
  const addAudioUrlAt = useCallback((url, sx, sy) => {
    const clean = (url || '').trim(); if (!clean) return
    let title = 'Audio'; try { title = audioTitleFrom(decodeURIComponent(new URL(clean).pathname.split('/').pop() || '')) } catch { /* keep */ }
    addAudio({ src: clean, title, autoplayOnZoom: false, autoplayOnSlide: false }, sx, sy, AUDIO_W, AUDIO_H)
  }, [addAudio])

  // Parse a YouTube URL/ID and drop a 16:9 YouTube player on the canvas.
  const dropYoutube = useCallback((vidId, sx, sy) => {
    const W = 320
    const id = addVideo({ videoKind: 'youtube', youtubeId: vidId }, sx, sy, W, Math.round(W * 9 / 16))
    // Fetch the real video title (oembed, CORS-enabled) so an outliner child reads "🎬 Title".
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vidId}&format=json`)
      .then(r => r.ok ? r.json() : null).then(d => { if (d?.title) updateImage(id, { title: d.title }) }).catch(() => {})
  }, [addVideo, updateImage])

  // Pop a slideshow slide back onto the canvas as the matching element, KEEPING its settings
  // (trim / speed / loop / muted / captions), so it plays the same as it did in the slideshow.
  const extractSlide = useCallback((clip, sx, sy) => {
    const k = clip.kind || (clip.youtubeId ? 'youtube' : 'video')
    const timed = { start: clip.start || 0, end: clip.end || 0, muted: clip.muted === true, loop: !!clip.loop, cuts: clip.cuts, title: clip.title || '' }
    if (k === 'image') { addImage(clip.src, sx, sy, 360, 240, { z: 'front' }); return }
    if (k === 'audio') { addAudio({ src: clip.src, ...timed, title: clip.title || 'Audio', autoplayOnZoom: false, autoplayOnSlide: false }, sx, sy, AUDIO_W, AUDIO_H); return }
    const W = 320
    if (k === 'youtube') { addVideo({ videoKind: 'youtube', youtubeId: clip.youtubeId, speed: clip.speed || 1, captions: !!clip.captions, ...timed }, sx, sy, W, Math.round(W * 9 / 16)); return }
    addVideo({ videoKind: 'file', src: clip.src, speed: clip.speed || 1, ...timed, title: clip.title || 'Video' }, sx, sy, W, Math.round(W * 9 / 16))
  }, [addAudio, addImage, addVideo])

  const addYoutubeAt = useCallback(async (sx, sy) => {
    // Save a click: if the clipboard already holds a YouTube link, use it directly — no prompt.
    try {
      const clip = await navigator.clipboard.readText()
      const id = parseYoutubeId(clip)
      if (id) { dropYoutube(id, sx, sy); return }
    } catch { /* clipboard blocked — fall through to prompt */ }
    const raw = window.prompt('Paste a YouTube link (or video ID):')
    if (!raw) return
    const vidId = parseYoutubeId(raw)
    if (!vidId) { alert('Could not find a YouTube video ID in that link.'); return }
    dropYoutube(vidId, sx, sy)
  }, [dropYoutube])

  // Drop a link-preview card at (sx,sy) and unfurl it in the background (WhatsApp/Discord style).
  const LINK_W = 300, LINK_H = 108
  const addLinkAt = useCallback((url, sx, sy) => {
    const clean = url.trim()
    let host = clean
    try { host = new URL(clean).hostname.replace(/^www\./, '') } catch { /* keep raw */ }
    const id = addLink({ url: clean, title: clean, siteName: host, description: '', image: '', favicon: '', loading: true }, sx, sy, LINK_W, LINK_H)
    unfurlLink(clean).then(meta => {
      if (meta) updateImage(id, { ...meta, url: meta.url || clean, loading: false, ...(meta.image ? { height: LINK_H + 150 } : {}) })
      else updateImage(id, { loading: false })
    })
    return id
  }, [addLink, updateImage])

  const pasteImageAt = useCallback(async (sx, sy) => {
    try {
      const clip = await navigator.clipboard.read()
      for (const it of clip) {
        const type = it.types.find(t => t.startsWith('image/'))
        if (!type) continue
        const blob = await it.getType(type)
        const reader = new FileReader()
        reader.onload = () => {
          const el = new window.Image()
          el.onload = () => {
            const MAX = 220
            const ar = el.naturalWidth / el.naturalHeight || 1
            const w = ar >= 1 ? MAX : MAX * ar, h = ar >= 1 ? MAX / ar : MAX
            const imgId2 = addImage(reader.result, sx, sy, w, h, { z: 'front' })
            uploadImageDataUrl(reader.result, projectId).then(url => { if (url && url !== reader.result) updateImage(imgId2, { src: url }) })
          }
          el.src = reader.result
        }
        reader.readAsDataURL(blob)
        return
      }
      alert('No image found on the clipboard.')
    } catch {
      alert('Could not read the clipboard. Try copying the image again, or paste with Ctrl/Cmd+V.')
    }
  }, [addImage])

  // General "Paste" (from the canvas menu): route whatever is on the clipboard — a table (Sheets/Docs/
  // Markdown) → Grid, an image → image card, a URL → link/YouTube, plain text → a node.
  const pasteAnyAt = useCallback(async (sx, sy) => {
    let html = '', text = '', imageBlob = null
    try {
      const clip = await navigator.clipboard.read()
      for (const it of clip) {
        const imgType = it.types.find(t => t.startsWith('image/'))
        if (imgType && !imageBlob) imageBlob = await it.getType(imgType)
        if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text()
        if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text()
      }
    } catch {
      try { text = await navigator.clipboard.readText() } catch { /* ignore */ }
    }
    if (!html && !text && !imageBlob) { try { text = await navigator.clipboard.readText() } catch { /* ignore */ } }

    // 1) Table
    const grid = parseClipboardTable(html, text)
    if (grid) {
      pushUndo()
      const id = addTableNodeFrom(grid, sx, sy)
      if (drillRoot) addEdge(drillRoot, id)
      setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy } scheduleRender() }, 0)
      setSelected({ id, type: 'node' })
      return
    }
    // 2) Image
    if (imageBlob) {
      const reader = new FileReader()
      reader.onload = () => {
        const el = new window.Image()
        el.onload = () => {
          const MAX = 220, ar = el.naturalWidth / el.naturalHeight || 1
          const w = ar >= 1 ? MAX : MAX * ar, h = ar >= 1 ? MAX / ar : MAX
          const imgId2 = addImage(reader.result, sx, sy, w, h)
          uploadImageDataUrl(reader.result, projectId).then(url => { if (url && url !== reader.result) updateImage(imgId2, { src: url }) })
        }
        el.src = reader.result
      }
      reader.readAsDataURL(imageBlob)
      return
    }
    const trimmed = (text || '').trim()
    if (!trimmed) { alert('Nothing to paste — the clipboard is empty (or the browser blocked reading it).'); return }
    // 3) YouTube link anywhere in the text → a video
    const ytId = parseYoutubeId(text)
    if (ytId) { dropYoutube(ytId, sx, sy); return }
    // 3b) Other bare URL → link-preview card
    if (/^https?:\/\/\S+$/i.test(trimmed) && !/\s/.test(trimmed)) { addLinkAt(trimmed, sx, sy); return }
    // 4) Plain text → a node (first line = label, rest = notes)
    pushUndo()
    const firstLine = trimmed.split('\n')[0].slice(0, 120)
    const rest = trimmed.split('\n').slice(1).join('\n').trim()
    const id = addNode(firstLine, drillRoot || null, sx, sy)
    if (rest) updateNotes(id, rest)
    setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy } scheduleRender() }, 0)
    setSelected({ id, type: 'node' })
  }, [addImage, addTableNodeFrom, projectId, updateImage, drillRoot])

  // Find the regular node whose box contains a canvas point (for attaching media on drop). Skips
  // frames/3d containers (those use containedIn) and hidden nodes.
  const nodeUnderPoint = useCallback((sx, sy) => {
    for (const n of simNodesRef.current) {
      const nvp = viewNodePropsRef.current[n.id] || {}
      if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.visible === false || !visibleNodeIdsRef.current.has(n.id)) continue
      const nr = NODE_R * (nvp.scale || 1)
      const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, n.label || '', Math.max(9, Math.round(12 * (nvp.scale || 1))), nvp.labelWidth)
      if (Math.abs((n.x || 0) - sx) < halfW && Math.abs((n.y || 0) - sy) < halfH) return n.id
    }
    return null
  }, [])

  // â"€â"€ Image interaction (drag / resize / rotate) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  // The slideshow node (if any) whose card covers a world point — for dropping media into a slideshow.
  const ytssHitAt = useCallback((pt) => {
    if (!pt) return null
    for (const yn of simNodesRef.current) {
      if (!ytssNodeSet.has(yn.id) || !visibleNodeIdsRef.current.has(yn.id)) continue
      const scale = (viewNodePropsRef.current[yn.id]?.ytssScale) || 1
      if (Math.abs((yn.x || 0) - pt.x) < 240 * scale && Math.abs((yn.y || 0) - pt.y) < 135 * scale) return yn.id
    }
    return null
  }, [ytssNodeSet])

  const handleImageMouseDown = useCallback((e, imageId, mode = 'drag', arg) => {
    e.preventDefault(); e.stopPropagation()
    canvasFocused.current = true
    setSelected(null)
    setSelectedNodeIds(new Set())

    const images = useGraphStore.getState().views
      .find(v => v.id === useGraphStore.getState().activeViewId)?.images || []
    const T = zoomTransformRef.current

    if (mode === 'drag') {
      const isShift = e.shiftKey || e.ctrlKey || e.metaKey

      if (isShift) {
        // Shift-click toggles only the individual image — never expands to whole group
        setSelectedImageIds(prev => {
          const next = new Set(prev)
          if (next.has(imageId)) next.delete(imageId)
          else next.add(imageId)
          return next
        })
        return
      }

      // Double-click: enter crop mode for a photo (text boxes just select → become editable).
      if (e.detail === 2) {
        const dImg = images.find(i => i.id === imageId)
        setSelectedImageIds(new Set([imageId]))
        if (dImg?.type !== 'text' && dImg?.type !== 'video' && dImg?.type !== 'audio' && dImg?.type !== 'link') {
          setDrilledImageId(imageId); setCropImageId(imageId)
        }
        return  // always return on double-click — never start a drag
      }

      // Plain click: select image or its whole group (unless drilled)
      // If the clicked photo is already part of a multi-selection, keep that whole
      // selection and drag all of them together — don't collapse to just this one.
      const curSel = selectedImageIdsRef.current
      let dragIds
      if (curSel.has(imageId) && curSel.size > 1) {
        dragIds = [...curSel]            // preserve the existing multi-selection
      } else {
        const ids = expandGroup(imageId, images, drilledImageId)
        setSelectedImageIds(new Set(ids))
        if (imageId !== drilledImageId) setDrilledImageId(null)
        if (imageId !== cropImageId) setCropImageId(null)
        // If the user is dragging the drilled image, move only that one.
        const isDrilledDrag = drilledImageId === imageId
        dragIds = isDrilledDrag ? [imageId] : ids
      }

      const startClientX = e.clientX, startClientY = e.clientY
      const origins = {}
      dragIds.forEach(id => {
        const img = images.find(i => i.id === id)
        if (img) origins[id] = { x: img.x, y: img.y }
      })

      const canAttach = dragIds.length === 1   // attach only a single media item to a node
      let lastCenter = null, lastCursor = null
      let lastClientX = startClientX, lastClientY = startClientY, imgPanRaf = null
      const draggedImg = images.find(i => i.id === imageId)
      // The node this media would attach to: prefer the one under the CURSOR (what the user points at),
      // then the one under the media's center, then any node the media overlaps (nearest to the cursor).
      const attachTargetAt = (cursor, center) => {
        if (cursor) { const c = nodeUnderPoint(cursor.x, cursor.y); if (c) return c }
        if (center) { const c = nodeUnderPoint(center.x, center.y); if (c) return c }
        if (center && draggedImg) {
          const hw = (draggedImg.width || 0) / 2, hh = (draggedImg.height || 0) / 2
          const ref = cursor || center
          let best = null, bestD = Infinity
          for (const n of simNodesRef.current) {
            const nvp = viewNodePropsRef.current[n.id] || {}
            if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.visible === false || !visibleNodeIdsRef.current.has(n.id)) continue
            if (Math.abs((n.x || 0) - center.x) > hw + 40 || Math.abs((n.y || 0) - center.y) > hh + 40) continue
            const d = Math.hypot((n.x || 0) - ref.x, (n.y || 0) - ref.y)
            if (d < bestD) { bestD = d; best = n.id }
          }
          return best
        }
        return null
      }
      // Reposition the dragged image(s) to follow the current cursor at the CURRENT zoom transform (so
      // auto-pan, which changes the transform, keeps the images under the cursor into off-screen space).
      const applyImageDrag = () => {
        const T2 = zoomTransformRef.current
        const startSx = (startClientX - T2.x) / T2.k, startSy = (startClientY - T2.y) / T2.k
        const sx = (lastClientX - T2.x) / T2.k, sy = (lastClientY - T2.y) / T2.k
        const dx = sx - startSx, dy = sy - startSy
        dragIds.forEach(id => { if (origins[id]) updateImage(id, { x: origins[id].x + dx, y: origins[id].y + dy }) })
        // Feedback: highlight the node this media would attach to (drop = becomes its child), OR the
        // slideshow it would be added to (drop = becomes a slide).
        if (canAttach) {
          lastCursor = { x: sx, y: sy }
          lastCenter = { x: origins[imageId].x + dx, y: origins[imageId].y + dy }
          const hit = ytssHitAt(lastCursor) || attachTargetAt(lastCursor, lastCenter)
          if (hit !== dragHoverNodeIdRef.current) { dragHoverNodeIdRef.current = hit; setDragHoverNodeId(hit) }
        }
      }
      const onMove = me => { lastClientX = me.clientX; lastClientY = me.clientY; applyImageDrag() }
      // Auto-pan while dragging into a canvas-edge margin — mirrors the node-drag behavior.
      const EDGE_M = 55, EDGE_V = 16
      const imgEdgePan = () => {
        imgPanRaf = requestAnimationFrame(imgEdgePan)
        if (!svgRef.current || !zoomBehaviorRef.current) return
        const r = svgRef.current.getBoundingClientRect()
        let vx = 0, vy = 0
        if (lastClientX < r.left + EDGE_M) vx = -(EDGE_M - (lastClientX - r.left)) / EDGE_M
        else if (lastClientX > r.right - EDGE_M) vx = (EDGE_M - (r.right - lastClientX)) / EDGE_M
        if (lastClientY < r.top + EDGE_M) vy = -(EDGE_M - (lastClientY - r.top)) / EDGE_M
        else if (lastClientY > r.bottom - EDGE_M) vy = (EDGE_M - (r.bottom - lastClientY)) / EDGE_M
        if (!vx && !vy) return
        vx = Math.max(-1, Math.min(1, vx)); vy = Math.max(-1, Math.min(1, vy))
        const k = zoomTransformRef.current.k || 1
        d3.select(svgRef.current).call(zoomBehaviorRef.current.translateBy, -vx * EDGE_V / k, -vy * EDGE_V / k)
        applyImageDrag()
      }
      imgPanRaf = requestAnimationFrame(imgEdgePan)
      let dragEnded = false
      const onUp = () => {
        if (dragEnded) return          // guard: pointerup/mouseup/blur may all fire — end exactly once
        dragEnded = true
        if (imgPanRaf) cancelAnimationFrame(imgPanRaf)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('blur', onUp)
        window.removeEventListener('keydown', onKeyAbort, true)
        hideDragShield()
        // Dropped onto a slideshow → add this media as a slide and remove the free image from the canvas.
        if (canAttach) {
          const ytssHit = ytssHitAt(lastCursor)
          if (ytssHit) {
            const img = (useGraphStore.getState().views.find(v => v.id === useGraphStore.getState().activeViewId)?.images || []).find(i => i.id === imageId)
            const slide = elementToSlide(img, img?.title)
            if (slide) {
              pushUndo(); addSlideToYtss(ytssHit, slide); deleteImage(imageId)
              setSelectedImageIds(new Set()); playDrop()
              if (dragHoverNodeIdRef.current !== null) { dragHoverNodeIdRef.current = null; setDragHoverNodeId(null) }
              return
            }
          }
        }
        if (canAttach) {
          const target = attachTargetAt(lastCursor, lastCenter)
          if (target) {
            // Promote to a real child NODE of the target (edges/outliner/collapse/shift-drag).
            pushUndo()
            const nid = convertImageToNode(imageId, target)
            const tn = simNodesRef.current.find(n => n.id === target)
            if (tn) { tn.fx = tn.x; tn.fy = tn.y; setAnchor(target, tn.x, tn.y) }   // keep parent put
            setSelectedImageIds(new Set()); setSelected({ id: nid, type: 'node' })
            scheduleRender()
          }
          if (dragHoverNodeIdRef.current !== null) { dragHoverNodeIdRef.current = null; setDragHoverNodeId(null) }
        }
      }
      // Backstops so a missed mouseup can never "glue" the drag (e.g. the release lands over a media
      // player/iframe that swallows it): also end on pointerup (capture phase), window blur, or Escape.
      const onKeyAbort = ev => { if (ev.key === 'Escape') onUp() }
      showDragShield('move')
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('blur', onUp)
      window.addEventListener('keydown', onKeyAbort, true)

    } else if (mode === 'resize') {
      // Proportional corner resize: the OPPOSITE corner of the visible (crop) rect
      // stays pinned while the dragged corner scales the image. `corner` ∈ tl|tr|bl|br.
      const img = images.find(i => i.id === imageId)
      if (!img) return
      const corner = arg || 'br'

      // GROUP SCALE — when 2+ images are selected, dragging any one's corner scales the whole
      // selection uniformly about the opposite corner of the group's bounding box. Hold Ctrl/⌘ to
      // scale just this one image instead.
      const groupCtrl = e.ctrlKey || e.metaKey
      const groupSel = [...selectedImageIdsRef.current]
        .map(gid => images.find(i => i.id === gid)).filter(Boolean)
      if (!groupCtrl && groupSel.length >= 2 && selectedImageIdsRef.current.has(imageId)) {
        const gx1 = Math.min(...groupSel.map(i => i.x - i.width / 2))
        const gy1 = Math.min(...groupSel.map(i => i.y - i.height / 2))
        const gx2 = Math.max(...groupSel.map(i => i.x + i.width / 2))
        const gy2 = Math.max(...groupSel.map(i => i.y + i.height / 2))
        // Pivot = opposite corner of the bbox; dragged corner scales away from it.
        const pivX = corner.includes('l') ? gx2 : gx1
        const pivY = corner.includes('t') ? gy2 : gy1
        const dragX = corner.includes('l') ? gx1 : gx2
        const dragY = corner.includes('t') ? gy1 : gy2
        const gBaseX = dragX - pivX, gBaseY = dragY - pivY
        const gBase2 = gBaseX * gBaseX + gBaseY * gBaseY
        const gStart = {}
        groupSel.forEach(i => { gStart[i.id] = { x: i.x, y: i.y, w: i.width, h: i.height } })
        const onMoveG = me => {
          if (gBase2 < 1) return
          const [wx, wy] = clientToSim(me.clientX, me.clientY)
          let s = ((wx - pivX) * gBaseX + (wy - pivY) * gBaseY) / gBase2
          if (s < 0.1) s = 0.1
          groupSel.forEach(i => {
            const st = gStart[i.id]
            updateImage(i.id, {
              x: pivX + (st.x - pivX) * s,
              y: pivY + (st.y - pivY) * s,
              width: Math.max(20, Math.round(st.w * s)),
              height: Math.max(10, Math.round(st.h * s)),
            })
          })
        }
        const onUpG = () => { document.removeEventListener('mousemove', onMoveG); document.removeEventListener('mouseup', onUpG); hideDragShield() }
        showDragShield('nwse-resize')
        document.addEventListener('mousemove', onMoveG); document.addEventListener('mouseup', onUpG)
        return
      }
      const sx = corner.includes('l') ? -1 : 1   // sign of dragged corner X
      const sy = corner.includes('t') ? -1 : 1   // sign of dragged corner Y
      const th = ((img.rotation || 0) * Math.PI) / 180
      const cos = Math.cos(th), sin = Math.sin(th)
      const crop = img.crop || { x: 0, y: 0, w: 1, h: 1 }
      const w0 = img.width, h0 = img.height
      // Visible (crop) rect, in image-local coords relative to the image centre
      const visHW0 = (w0 * crop.w) / 2, visHH0 = (h0 * crop.h) / 2
      const ox0 = w0 * (crop.x + crop.w / 2) - w0 / 2   // local centre offset of crop rect
      const oy0 = h0 * (crop.y + crop.h / 2) - h0 / 2
      // Pivot = opposite corner of the crop rect (image-local, relative to centre)
      const pivLx = ox0 - sx * visHW0, pivLy = oy0 - sy * visHH0
      // Pivot in world/sim coords (stays fixed for the whole drag)
      const pivWx = img.x + cos * pivLx - sin * pivLy
      const pivWy = img.y + sin * pivLx + cos * pivLy
      // Vector pivot→draggedCorner in local space (its length sets the scale baseline)
      const baseLx = 2 * sx * visHW0, baseLy = 2 * sy * visHH0
      const baseLen2 = baseLx * baseLx + baseLy * baseLy
      const onMove = me => {
        if (baseLen2 < 1) return
        const [wx, wy] = clientToSim(me.clientX, me.clientY)
        const dwx = wx - pivWx, dwy = wy - pivWy
        // Rotate world delta back into the image's local frame
        const curLx = cos * dwx + sin * dwy
        const curLy = -sin * dwx + cos * dwy
        let s = (curLx * baseLx + curLy * baseLy) / baseLen2  // projection → uniform scale
        const minS = Math.max(20 / w0, 10 / h0)
        if (s < minS) s = minS
        // Keep the pivot pinned: new centre = pivot + R(θ)·(s · pivotLocal)
        const npLx = pivLx * s, npLy = pivLy * s
        const ncx = pivWx - (cos * npLx - sin * npLy)
        const ncy = pivWy - (sin * npLx + cos * npLy)
        updateImage(imageId, {
          width: Math.max(20, Math.round(w0 * s)),
          height: Math.max(10, Math.round(h0 * s)),
          x: ncx, y: ncy,
        })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); hideDragShield() }
      showDragShield('nwse-resize')
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)

    } else if (mode === 'textscale' || mode === 'textwidth' || mode === 'textheight') {
      // Text box: bottom-right corner scales box+font uniformly; right/bottom edges reflow one dimension
      // (no font change), so uneven box shapes are possible. The opposite edge/corner stays pinned.
      const img = images.find(i => i.id === imageId); if (!img) return
      const th = ((img.rotation || 0) * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th)
      const w0 = img.width, h0 = img.height, fs0 = img.fontScale || 1
      const pivL = mode === 'textscale' ? { x: -w0 / 2, y: -h0 / 2 } : mode === 'textwidth' ? { x: -w0 / 2, y: 0 } : { x: 0, y: -h0 / 2 }
      const pivW = { x: img.x + cos * pivL.x - sin * pivL.y, y: img.y + sin * pivL.x + cos * pivL.y }
      const onMove = me => {
        const [wx, wy] = clientToSim(me.clientX, me.clientY)
        const dx = wx - pivW.x, dy = wy - pivW.y
        const lx = cos * dx + sin * dy, ly = -sin * dx + cos * dy   // cursor in the box's local frame, from pivot
        if (mode === 'textscale') {
          const base = w0 * w0 + h0 * h0
          let s = (lx * w0 + ly * h0) / base
          const minS = Math.max(40 / w0, 24 / h0, 0.15)
          if (s < minS) s = minS
          const nw = Math.round(w0 * s), nh = Math.round(h0 * s)
          updateImage(imageId, { width: nw, height: nh, fontScale: +(fs0 * s).toFixed(3), x: pivW.x + cos * (nw / 2) - sin * (nh / 2), y: pivW.y + sin * (nw / 2) + cos * (nh / 2) })
        } else if (mode === 'textwidth') {
          const nw = Math.max(40, Math.round(lx))
          updateImage(imageId, { width: nw, x: pivW.x + cos * (nw / 2), y: pivW.y + sin * (nw / 2) })
        } else {
          const nh = Math.max(28, Math.round(ly))
          updateImage(imageId, { height: nh, x: pivW.x - sin * (nh / 2), y: pivW.y + cos * (nh / 2) })
        }
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); hideDragShield() }
      showDragShield(mode === 'textscale' ? 'nwse-resize' : mode === 'textwidth' ? 'ew-resize' : 'ns-resize')
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)

    } else if (mode === 'crop') {
      // Drag a median handle (t|r|b|l) of the crop rect to trim that edge.
      const img = images.find(i => i.id === imageId)
      if (!img) return
      const edge = arg
      const th = ((img.rotation || 0) * Math.PI) / 180
      const cos = Math.cos(th), sin = Math.sin(th)
      const startCrop = img.crop || { x: 0, y: 0, w: 1, h: 1 }
      const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
      const onMove = me => {
        const [mx, my] = clientToSim(me.clientX, me.clientY)
        // World delta → image-local delta → normalised fractions
        const dwx = mx - sx0, dwy = my - sy0
        const ddx = (cos * dwx + sin * dwy) / img.width
        const ddy = (-sin * dwx + cos * dwy) / img.height
        let { x, y, w, h } = startCrop
        if (edge === 'l') { const nx = Math.max(0, Math.min(x + w - 0.05, x + ddx)); w = w - (nx - x); x = nx }
        if (edge === 'r') { w = Math.max(0.05, Math.min(1 - x, w + ddx)) }
        if (edge === 't') { const ny = Math.max(0, Math.min(y + h - 0.05, y + ddy)); h = h - (ny - y); y = ny }
        if (edge === 'b') { h = Math.max(0.05, Math.min(1 - y, h + ddy)) }
        updateImage(imageId, { crop: { x, y, w, h } })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); hideDragShield() }
      showDragShield('crosshair')
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)

    } else if (mode === 'rotate') {
      // Unchanged from original
      const img = images.find(i => i.id === imageId)
      if (!img) return
      const screenCX = T.x + img.x * T.k, screenCY = T.y + img.y * T.k
      const startAngleDeg = Math.atan2(e.clientY - screenCY, e.clientX - screenCX) * 180 / Math.PI
      const startRot = img.rotation || 0
      const onMove = me => {
        const a = Math.atan2(me.clientY - screenCY, me.clientX - screenCX) * 180 / Math.PI
        updateImage(imageId, { rotation: startRot + a - startAngleDeg })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); hideDragShield() }
      showDragShield('grabbing')
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
    }
  }, [drilledImageId, updateImage, expandGroup, clientToSim, cropImageId, nodeUnderPoint, setAnchor, convertImageToNode, pushUndo, scheduleRender, ytssHitAt, addSlideToYtss, deleteImage])

  const T = zoomTransformRef.current
  const selectedNode = selected?.type === 'node' ? simNodesRef.current.find(n => n.id === selected.id) : null
  const selectedStoreNode = selectedNode ? storeNodes.find(n => n.id === selectedNode.id) : null

  // One canvas image/photo/video/text card. Rendered in two passes: default images sit BELOW the nodes
  // (a background layer); images flagged `z:'front'` (e.g. anything freshly pasted) render in a later
  // pass so the newest element lands on top of everything — including tables/nodes.
  const renderImageCard = (img0) => {
    const _ov = imageStageOverlay?.[img0.id]
    const img = _ov ? { ...img0, ..._ov } : img0
    let mediaPlay = false
    if ((img.type === 'audio' || img.type === 'video') && (img.autoplayOnZoom || img.autoplayOnSlide)) {
      const t = zoomTransformRef.current, k = t.k || 1
      const vw = svgRef.current?.clientWidth || 0, vh = svgRef.current?.clientHeight || 0
      if (vw > 0) {
        const cxs = t.x + img.x * k, cys = t.y + img.y * k
        const inView = cxs > 0 && cxs < vw && cys > 0 && cys < vh
        const fill = Math.max((img.width * k) / vw, (img.height * k) / vh)
        if (inView && fill >= 0.4) mediaPlay = true
      }
      if (!mediaPlay && img.autoplayOnSlide && isPresenting && presentingSlideIdx != null) {
        const fr = slideSimNodes[presentingSlideIdx]
        if (fr) {
          const fvp = { ...DEFAULT_NODE_PROPS, ...(getVP(fr.id) || {}) }
          const { halfW: dHW, halfH: dHH } = shapeDims('frame', NODE_R * (fvp.scale || 1))
          const fhw = fvp.frameHalfW ?? dHW, fhh = fvp.frameHalfH ?? dHH
          if (Math.abs(img.x - (fr.x || 0)) <= fhw && Math.abs(img.y - (fr.y || 0)) <= fhh) mediaPlay = true
        }
      }
    }
    return (
      <ImageNode key={img.id} img={img}
        isSelected={selectedImageIds.has(img.id)}
        isCropping={cropImageId === img.id}
        onMouseDown={handleImageMouseDown}
        mediaPlay={mediaPlay}
        onToggleMedia={prop => updateImage(img.id, { [prop]: !img[prop] })}
        onEditVideo={() => setVideoEdit({ kind: 'image', id: img.id })}
        onTextChange={html => updateImage(img.id, { html })}
        zoomK={T.k}
        previewing={videoEdit?.kind === 'image' && videoEdit.id === img.id}
        onPlayerReady={setVideoPreviewHandle}
        onMediaTitle={() => { const next = prompt('Title', img.title || ''); if (next !== null) updateImage(img.id, { title: next.trim() }) }}
        onCaption={() => { const next = prompt('Caption', img.caption || ''); if (next !== null) updateImage(img.id, { caption: next }) }}
      />
    )
  }

  if (loading) return <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'#8090b8', background:'#0c0c1a' }}>Loading project…</div>

  // Pre-compute edge geometry for two-pass rendering (lines behind nodes, arrowheads on top)
  const edgeData = simEdgesRef.current.map(e => {
    const s = e.source, t = e.target
    if (!s || !t || s.x == null) return null
    if (!mountedRef.current.has(s.id) || !mountedRef.current.has(t.id)) return null
    // Hide the link between a container and a node it holds — containment implies it, so drawing the
    // line just clutters the inside of the box. (Links that cross the boundary to the outside stay.)
    const svp0 = viewNodeProps[s.id] || {}, tvp0 = viewNodeProps[t.id] || {}
    if ((svp0.shape === 'container' && tvp0.containedIn === s.id) || (tvp0.shape === 'container' && svp0.containedIn === t.id)) return null
    const edgeOpacity = Math.min(nodeOpacityRef.current[s.id] ?? 1, nodeOpacityRef.current[t.id] ?? 1)   // fade with endpoints
    const isSel = selected?.id === e.id && selected?.type === 'edge'
    const svp = getVP(s.id), tvp = getVP(t.id)
    const sLabel = storeNodes.find(n => n.id === s.id)?.label || ''
    const tLabel = storeNodes.find(n => n.id === t.id)?.label || ''
    const sr = NODE_R * (svp.scale||1), tr = NODE_R * (tvp.scale||1)
    const sFontSize = Math.max(9, Math.round(12 * (svp.scale||1)))
    const tFontSize = Math.max(9, Math.round(12 * (tvp.scale||1)))
    const sMedia = storeNodeById[s.id]?.media, tMedia = storeNodeById[t.id]?.media
    const sShape = sMedia ? 'rect' : (svp.shape || 'circle')
    const tShape = tMedia ? 'rect' : (tvp.shape || 'circle')
    // Frames/containers/3d clip at their actual box (frameHalfW/H) so an arrow lands on the edge, not
    // in the middle of the shape.
    const boxHalf = (vp, rr, lbl, fs, lw) => {
      if (vp.shape === 'frame' || vp.shape === 'container' || vp.shape === '3d') {
        const base = vp.shape === '3d' ? '3d' : (vp.shape === 'container' ? 'container' : 'frame')
        const d = shapeDims(base, rr)
        return { halfW: vp.shape === '3d' ? d.halfW : (vp.frameHalfW ?? d.halfW), halfH: vp.shape === '3d' ? d.halfH : (vp.frameHalfH ?? d.halfH) }
      }
      return shapeDims(vp.shape || 'circle', rr, lbl, fs, lw)
    }
    const { halfW: swW, halfH: swH } = sMedia ? { halfW: sMedia.width / 2, halfH: sMedia.height / 2 } : boxHalf(svp, sr, sLabel, sFontSize, svp.labelWidth)
    const { halfW: twW, halfH: twH } = tMedia ? { halfW: tMedia.width / 2, halfH: tMedia.height / 2 } : boxHalf(tvp, tr, tLabel, tFontSize, tvp.labelWidth)
    const dx = t.x-s.x, dy = t.y-s.y, dist = Math.sqrt(dx*dx+dy*dy)||1
    const ux = dx/dist, uy = dy/dist
    const sd = clipDist(sShape, swW, swH, ux, uy)
    const td = clipDist(tShape, twW, twH, ux, uy)
    const x1 = s.x + ux*(sd - 5), y1 = s.y + uy*(sd - 5)
    const ALEN = 10, AW = 5
    const tipX = t.x - ux*(td - 5), tipY = t.y - uy*(td - 5)
    const basX = tipX - ux*ALEN, basY = tipY - uy*ALEN
    const perpX = -uy, perpY = ux
    const arrowPts = `${tipX},${tipY} ${basX+perpX*AW},${basY+perpY*AW} ${basX-perpX*AW},${basY-perpY*AW}`
    const mx = (x1+basX)/2, my = (y1+basY)/2
    const edgeColor = isSel ? '#5b6af0' : '#5a6a90'   // brighter slate — dark #334155 was too dim on dark/mid bgs
    // Blur fade: if an endpoint node is blurred, the edge dissolves into its halo.
    const sBlur = svp.borderBlur || 0, tBlur = tvp.borderBlur || 0
    const lineLen = Math.hypot(tipX - x1, tipY - y1) || 1
    const label = storeEdges.find(x => x.id === e.id)?.label || ''
    return { id: e.id, x1, y1, x2: basX, y2: basY, tipX, tipY, arrowPts, mx, my, edgeColor, isSel, sBlur, tBlur, lineLen, opacity: edgeOpacity, label }
  }).filter(Boolean)

  const frameSimNodes = simNodesRef.current.filter(n => (viewNodeProps[n.id]?.shape) === 'frame')
  // Ordered list of frame sim-nodes that are in the slideshow
  const slideSimNodes = slideIds
    .map(id => frameSimNodes.find(n => n.id === id))
    .filter(Boolean)
  presentingSlideIdxRef.current = presentingSlideIdx
  const isPresenting = presentingSlideIdx !== null

  const navigateSlide = (delta) => {
    if (!slideSimNodes.length) return
    const next = ((presentingSlideIdx ?? 0) + delta + slideSimNodes.length) % slideSimNodes.length
    setPresentingSlideIdx(next)
    simRef.current?.stop()
    zoomToFrame(slideSimNodes[next])
    setTimeout(() => simRef.current?.restart(), 700)
  }

  // ── Presentation with frame "builds" ────────────────────────────────────────
  // A slide is a frame; its stages are builds played within it. Two key sets: ←/→ (+ space/enter) walk
  // BUILDS (crossing slide boundaries at the ends); ↑/↓ (PageUp/Down) jump SLIDES directly. When you land
  // on a slide going FORWARD it resets to its first build; going BACKWARD it shows its last (fully built).
  const restoreOverlayInstant = () => {
    const bp = stageBasePosRef.current
    if (bp) {
      Object.keys(bp.pos).forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = bp.pos[id].x; sn.y = bp.pos[id].y; sn.fx = bp.pos[id].fx; sn.fy = bp.pos[id].fy } })
      stageBasePosRef.current = null
    }
    setStageOverlay(null)
    imgAnimRunRef.current++
    setImageStageOverlay(null)
  }
  const slideStages = (idx) => { const f = slideSimNodes[idx]; return f ? (getVP(f.id).stages || []) : [] }
  // The YouTube slideshow (if any) whose centre sits inside a frame's box.
  const frameYtss = (frame) => {
    if (!frame) return null
    const fvp = { ...DEFAULT_NODE_PROPS, ...(getVP(frame.id) || {}) }
    const { halfW: dHW, halfH: dHH } = shapeDims('frame', NODE_R * (fvp.scale || 1))
    const fhw = fvp.frameHalfW ?? dHW, fhh = fvp.frameHalfH ?? dHH
    const y = simNodesRef.current.find(n => ytssNodeSet.has(n.id) && visibleNodeIdsRef.current.has(n.id) &&
      Math.abs((n.x || 0) - (frame.x || 0)) <= fhw && Math.abs((n.y || 0) - (frame.y || 0)) <= fhh)
    return y?.id || null
  }
  const presentSlide = (idx, direction) => {
    if (idx < 0 || idx >= slideSimNodes.length) return
    restoreOverlayInstant()   // return the slide we're leaving to its authored arrangement
    setPresentingSlideIdx(idx)
    simRef.current?.stop()
    const stages = slideStages(idx)
    const sIdx = stages.length ? (direction === 'back' ? stages.length - 1 : 0) : 0
    // Open on this slide's camera if it has one, else fit the whole frame.
    const camNow = stages.length ? effectiveCam(stages, sIdx) : null
    if (camNow) applyCamRect(camNow, true, 550); else zoomToFrame(slideSimNodes[idx])
    setPresentStage(sIdx)
    if (stages.length) setTimeout(() => applyStage(slideSimNodes[idx].id, sIdx), 60)

    // Auto-enter a YouTube slideshow living on this slide (and exit the previous slide's, if any).
    const yid = frameYtss(slideSimNodes[idx])
    if (ytssActiveRef.current && ytssActiveRef.current !== yid) { ytssHandlesRef.current[ytssActiveRef.current]?.pause?.(); setYtssActiveId(null) }
    if (yid) {
      const clips = useGraphStore.getState().nodes.find(n => n.id === yid)?.ytss?.clips || []
      const startIdx = direction === 'back' ? Math.max(0, clips.length - 1) : 0
      setYtssActiveId(yid); setYtssIdxMap(m => ({ ...m, [yid]: startIdx })); ytssPlayingRef.current = true
      setTimeout(() => ytssHandlesRef.current[yid]?.loadClip?.(clips[startIdx], true), 120)
    }
  }
  const advanceBuild = (dir) => {
    const cur = presentingSlideIdxRef.current ?? 0
    const frame = slideSimNodes[cur]; if (!frame) return
    const stages = slideStages(cur)
    if (!stages.length) { presentSlide(cur + dir, dir > 0 ? 'fwd' : 'back'); return }
    const next = presentStageIdxRef.current + dir
    if (next >= stages.length) { presentSlide(cur + 1, 'fwd'); return }
    if (next < 0) { presentSlide(cur - 1, 'back'); return }
    setPresentStage(next)
    applyStage(frame.id, next)
    moveCamForStage(stages, next, true, stages[next]?.dur ?? 340)
  }
  const jumpSlide = (dir) => presentSlide((presentingSlideIdxRef.current ?? 0) + dir, dir > 0 ? 'fwd' : 'back')

  const exitPresentation = () => { if (ytssActiveRef.current) { ytssHandlesRef.current[ytssActiveRef.current]?.pause?.(); setYtssActiveId(null) } clearFades(); restoreOverlayInstant(); setPresentingSlideIdx(null); setTimeout(() => simRef.current?.alpha(0.2).restart(), 60) }

  // Group bounding boxes for selected groups
  const selectedGroupIds = new Set()
  ;(activeView?.images || []).forEach(img => {
    if (img.groupId && selectedImageIds.has(img.id)) selectedGroupIds.add(img.groupId)
  })
  const groupBounds = {}
  ;(activeView?.images || []).forEach(img => {
    if (!img.groupId || !selectedGroupIds.has(img.groupId)) return
    const b = groupBounds[img.groupId] || { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
    groupBounds[img.groupId] = {
      x1: Math.min(b.x1, img.x - img.width / 2),
      y1: Math.min(b.y1, img.y - img.height / 2),
      x2: Math.max(b.x2, img.x + img.width / 2),
      y2: Math.max(b.y2, img.y + img.height / 2),
    }
  })

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Outline sidebar â€" hidden while presenting or in shared read-only view */}
      {!isPresenting && !readOnly && (<>
      <div onMouseDown={() => { canvasFocused.current = false }}
        style={{ width: 0, flexShrink: 0, overflow: 'visible', position: 'relative', zIndex: 15 }}>
        {/* No fixed sidebar — Views is a floating, hideable palette over the canvas. */}
        {showViews && <div className="pim-palette" style={{ position:'absolute', left:12, top:150, width:174, background:'rgba(16,18,29,.92)', backdropFilter:'blur(14px)', WebkitBackdropFilter:'blur(14px)', border:'1px solid #2a2f47', borderRadius:8, boxShadow:'0 16px 44px rgba(0,0,0,.55)', overflow:'hidden' }}>
          <div title="Drag palette" onPointerDown={e => {
              if (e.button !== 0) return
              const panel = e.currentTarget.parentElement
              const r = panel.getBoundingClientRect()
              panel.style.position = 'fixed'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'
              const ox = e.clientX - r.left, oy = e.clientY - r.top
              const h = e.currentTarget; h.setPointerCapture(e.pointerId)
              const mv = ev => { panel.style.left = Math.max(4, ev.clientX - ox) + 'px'; panel.style.top = Math.max(4, ev.clientY - oy) + 'px' }
              const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up) }
              h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up)
            }}
            style={{ display:'flex', alignItems:'center', gap:6, height:24, padding:'0 9px', cursor:'grab', userSelect:'none', borderBottom:'1px solid #1e2236', color:'#9aa4cc', fontSize:'0.66rem', fontWeight:700, letterSpacing:'.09em', textTransform:'uppercase' }}>
            <span style={{ color:'#5a6390', letterSpacing:2, fontSize:9 }}>⋮⋮</span> Views
            <span onPointerDown={e => { e.stopPropagation(); setShowViews(false) }} title="Hide Views panel" style={{ marginLeft:'auto', cursor:'pointer', fontSize:13, color:'#8a92b4', padding:'0 2px' }}>×</span>
          </div>
          <div style={{ maxHeight:260, overflowY:'auto' }}><ViewManager /></div>
        </div>}
        {/* Tool dock removed — its actions live in the canvas right-click menu (Fit/Free/Export/Flowchart/Frames/BG/Add). */}
        {false && <div className="pim-tooldock" style={{ position:'absolute', left:12, top:12, zIndex:14, width:152, padding:6, display:'flex', flexDirection:'column', gap:5, background:'rgba(16,18,29,.92)', backdropFilter:'blur(14px)', WebkitBackdropFilter:'blur(14px)', border:'1px solid #2a2f47', borderRadius:8, boxShadow:'0 16px 44px rgba(0,0,0,.55)' }}>
          <div title="Drag dock" onPointerDown={e => {
              if (e.button !== 0) return
              const panel = e.currentTarget.parentElement
              const r = panel.getBoundingClientRect()
              panel.style.position = 'fixed'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; panel.style.right = 'auto'
              const ox = e.clientX - r.left, oy = e.clientY - r.top
              const handle = e.currentTarget; handle.setPointerCapture(e.pointerId)
              const mv = ev => { panel.style.left = Math.max(4, ev.clientX - ox) + 'px'; panel.style.top = Math.max(4, ev.clientY - oy) + 'px' }
              const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up) }
              handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up)
            }}
            style={{ height:18, marginBottom:1, display:'flex', alignItems:'center', justifyContent:'center', cursor:'grab', color:'#5a6390', letterSpacing:2, fontSize:10, userSelect:'none', borderBottom:'1px solid #1e2236' }}>⋮⋮</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
            <button style={gToolBtn} onClick={zoomExtents} title="Fit all nodes in view">⊡ Fit</button>
            <button style={gToolBtn} onClick={handleReleaseAll} title="Release all anchors">⊙ Free</button>
            <button style={gToolBtn} onClick={() => setShowExport(true)} title="Export outline / graph to PDF or Word">⤓ Export</button>
            <button style={{ ...gToolBtn, ...(showFlowchart ? { color:'#8ecbff', borderColor:'#3a5a8a', background:'#152036' } : {}) }} onClick={() => setShowFlowchart(v => !v)} title="Flowchart: edit as text (Mermaid) ⇄ graphics, two-way synced">⤳ Flow</button>
            <button style={{ ...gToolBtn, ...(hideFrameOutlines ? { color:'#f6ad55', borderColor:'#7a5a2a', background:'#241d10' } : {}) }} onClick={() => setHideFrameOutlines(v => !v)} title="Toggle frame outlines">▢ Frames</button>
            {/* BG color */}
            <div style={{ position:'relative' }}>
              <button style={{ ...gToolBtn, width:'100%' }}
                onClick={e => { e.stopPropagation(); setShowBgPicker(v => !v) }} title="Canvas background color">
                <span style={{ width:11, height:11, borderRadius:3, background:bgColor, border:'1px solid #5b6af0', display:'inline-block', flexShrink:0 }} />
                BG
              </button>
              {showBgPicker && (
                <div style={{ position:'absolute', top:'110%', left:0, marginTop:2, background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8, padding:8, display:'flex', flexDirection:'column', gap:6, zIndex:30, boxShadow:'0 4px 20px rgba(0,0,0,0.6)' }}
                  onClick={e => e.stopPropagation()}>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, width:136 }}>
                    {BG_COLORS.map(c => (
                      <div key={c} onClick={() => { setViewBgColor(c); setShowBgPicker(false) }} style={{ width:22, height:22, borderRadius:4, background:c, cursor:'pointer', border: bgColor===c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)' }} />
                    ))}
                  </div>
                  <div style={{ borderTop:'1px solid #2d3a6a', paddingTop:6, display:'flex', flexWrap:'wrap', gap:4, width:160 }}>
                    {COLOR_PALETTE.map(c => (
                      <div key={c} onClick={() => { setViewBgColor(c); setShowBgPicker(false) }} style={{ width:22, height:22, borderRadius:4, background:c, cursor:'pointer', border: bgColor===c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)' }} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* Unified add button */}
          {(() => {
            const hasSelected = selected?.type === 'node'
            return (
              <div style={{ position:'relative' }}>
                <button
                  style={{ ...gToolBtn, height:30, width:'100%', fontSize:'0.9rem', fontWeight:700, color:'#c3ccff', border:'1px solid #3a4a8a', background:'#191d3a' }}
                  onClick={e => { e.stopPropagation(); setShowAddMenu(v => !v) }}
                  title="Add…">
                  ＋ Add
                </button>
                {showAddMenu && (
                  <div style={{ position:'absolute', top:'110%', left:0, background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8, padding:'6px 0', zIndex:40, boxShadow:'0 4px 20px rgba(0,0,0,0.7)', minWidth:160 }}
                    onClick={e => e.stopPropagation()}>
                    {[
                      ['Node' + (hasSelected ? ' (linked)' : ''), () => { pushUndo(); setPendingEditId(addNode('New node', hasSelected ? selected.id : (drillRoot || null))); setShowAddMenu(false) }],
                      ['Root node', () => { pushUndo(); setPendingEditId(addNode('New node', null)); setShowAddMenu(false) }],
                      ['Frame', () => { pushUndo(); addFrameToCenter(); setShowAddMenu(false) }],
                      ['Container', () => { pushUndo(); addContainerToCenter(); setShowAddMenu(false) }],
                      ['Table', () => { addTableToCenter(); setShowAddMenu(false) }],
                      ['View', () => { addView(); setShowAddMenu(false) }],
                    ].map(([label, action]) => (
                      <button key={label} onClick={action}
                        style={{ display:'block', width:'100%', textAlign:'left', background:'transparent', border:'none', color:'#c5d0ff', cursor:'pointer', padding:'7px 14px', fontSize:'0.82rem' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#2d3a6a'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
        </div>}
      </div>
      </>)}
      <div onMouseDown={() => { canvasFocused.current = true }}
        onContextMenu={e => { const t = e.target.tagName; if (t === 'INPUT' || t === 'TEXTAREA') return; e.preventDefault() }}
        style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Depth slider — collapse/expand the whole graph (and outline) by level. Top = all expanded,
            drag down to fold deeper levels away; one notch per level. */}
        {!readOnly && !isPresenting && depthCap > 0 && (
          <DepthSlider level={depthLevel} max={depthCap} onChange={applyDepthLevel} />
        )}
        <svg ref={svgRef}
          style={{ width: '100%', height: '100%', background: effectiveBg, display: 'block', cursor: 'default' }}
          onClick={e => { if (e.target !== e.currentTarget) return; if (didRubberBandRef.current) { didRubberBandRef.current = false; return } setSelected(null); setSelectedImageIds(new Set()); setSelectedNodeIds(new Set()); setSelectedDrawingId(null); setDrilledImageId(null); setShowBgPicker(false); setNotePopupId(null) }}
          onDoubleClick={e => {
            if (readOnly) return
            if (e.target.closest?.('[data-node]') || e.target.closest?.('[data-frame]') || e.target.closest?.('[data-img]') || e.target.closest?.('[data-card]')) return
            const rect = svgRef.current.getBoundingClientRect()
            const [sx, sy] = zoomTransformRef.current.invert([e.clientX - rect.left, e.clientY - rect.top])
            // Conventional: a small "name your node" input at the cursor; create on Enter.
            setNewNodeAt({ px: e.clientX - rect.left, py: e.clientY - rect.top, sx, sy })
          }}
          onMouseDown={e => {
            if (e.button === 2) return   // right-button handled by d3-zoom start/end (pan vs menu)
            if (!e.target.closest?.('[data-node]')) setIsPanning(true)
            // Start the rubber-band marquee on ANY non-interactive surface — bare canvas OR an edge line
            // OR an organize pack — not only the exact <svg> element. (Nodes/frames/images/drawings/tables
            // all stopPropagation on their own mousedown, so they never reach here.) The old
            // `e.target === e.currentTarget` test meant a marquee that began even slightly over an edge
            // silently did nothing, which read as "multi-select is broken".
            if (!readOnly && !e.target.closest?.('[data-node],[data-frame],[data-img]')) handleCanvasMouseDown(e)
          }}
          onMouseUp={() => setIsPanning(false)}
          onMouseLeave={() => setIsPanning(false)}
        >
          <defs>
            <marker id="arr" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,8 L8,4 z" fill="#5a6a90" /></marker>
            <marker id="arr-sel" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,8 L8,4 z" fill="#5b6af0" /></marker>
            {/* Subtle, background-aware legibility halo for edges (not a glow):
                one tight, low-opacity contrast outline — light on dark bg, dark on light bg. */}
            <filter id="edge-shadow" x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB">
              {/* Background-aware legibility halo — wider + stronger so edges stay readable even when the
                  background brightness sits near the line's own tone (mid greys/slates were the worst case). */}
              <feDropShadow dx="0" dy="0" stdDeviation="0.7" floodColor={edgeGlowColor} floodOpacity="0.9" />
            </filter>
            <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#000" floodOpacity="0.5" />
              <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#000" floodOpacity="0.3" />
            </filter>
          </defs>

          <g transform={`translate(${T.x},${T.y}) scale(${T.k})`}
            style={readOnly ? { pointerEvents: 'none' } : undefined}>
            {/* 0. Organize group packs (behind everything; non-interactive). Deterministic circle
                 packing — each pack is a tight circle hugging its members; the packs are bunched and
                 non-overlapping. Empty packs keep a small circle as a drop target. */}
            {organize && organizeGroups.map(g => (
              <g key={g.key} style={{ pointerEvents: 'none' }}>
                <circle cx={g.cx} cy={g.cy} r={g.r} fill={g.color + '5e'} stroke={g.color} strokeWidth={2.5} />
                <text x={g.cx} y={g.cy - g.r - 10} textAnchor="middle" fontSize={20} fontWeight={700} fill={g.color}
                  style={{ paintOrder: 'stroke', stroke: '#0c0c1a', strokeWidth: 4 }}>{g.label} · {g.count}</text>
              </g>
            ))}
            {/* 1. Frame containers (hidden while organizing — packs replace them) */}
            {!organize && simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && getVP(n.id).shape === 'frame').map(n => (
              <FrameNode key={n.id} node={n}
                viewProps={getVP(n.id)}
                isSelected={(selected?.id === n.id && selected?.type === 'node') || selectedNodeIds.has(n.id)}
                inSlides={slideIds.includes(n.id)}
                isPresenting={isPresenting}
                onMouseDown={handleNodeMouseDown}
                onResizeMouseDown={handleFrameResizeMouseDown}
                onDelete={id => setConfirmDelete(id)}
                onLabelChange={updateLabel}
                onToggleSlide={id => slideIds.includes(id) ? removeSlide(id) : addSlide(id)}
                hideOutline={hideFrameOutlines || autoHideFrames}
              />
            ))}

            {/* 1b. Containers — real tree nodes rendered as a big circle/rect holding their contents. */}
            {!organize && simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && getVP(n.id).shape === 'container').map(n => (
              <ContainerNode key={n.id} node={n}
                viewProps={getVP(n.id)}
                isSelected={(selected?.id === n.id && selected?.type === 'node') || selectedNodeIds.has(n.id)}
                isCollapsed={collapsedSet.has(n.id)}
                isDropTarget={dragHoverNodeId === n.id}
                memberCount={simNodesRef.current.filter(m => getVP(m.id).containedIn === n.id).length}
                onMouseDown={handleNodeMouseDown}
                onResizeMouseDown={handleFrameResizeMouseDown}
                onDelete={id => setConfirmDelete(id)}
                onLabelChange={updateLabel}
                onToggleCollapse={() => handleToggleCollapseAnimated(n.id)}
                onSetContainerShape={s => setNodeViewProp(n.id, 'containerShape', s)}
              />
            ))}

            {/* 2. Edges â€" node fill covers the tips cleanly. Hidden in Organize unless "segments" on. */}
            {(!organize || organize.showSegments) && edgeData.map(({ id, x1, y1, tipX, tipY, arrowPts, mx, my, edgeColor, isSel, sBlur, tBlur, lineLen, opacity, label }) => {
              const hasBlur = sBlur > 0 || tBlur > 0
              const gid = `eg-${id}`
              const sFade = Math.min(0.5, (sBlur * 2) / lineLen)
              const tFade = Math.min(0.5, (tBlur * 2) / lineLen)
              const lineStroke = hasBlur ? `url(#${gid})` : edgeColor
              return (
              <g key={id} onClick={ev => { ev.stopPropagation(); setSelected({ id, type: 'edge' }) }} style={{ cursor:'pointer', opacity: opacity ?? 1, transition: 'opacity 0.38s ease' }}>
                {hasBlur && (
                  <defs>
                    <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={tipX} y2={tipY}>
                      <stop offset="0" stopColor={edgeColor} stopOpacity={sBlur > 0 ? 0 : 1} />
                      {sBlur > 0 && <stop offset={sFade} stopColor={edgeColor} stopOpacity={1} />}
                      {tBlur > 0 && <stop offset={Math.max(sFade, 1 - tFade)} stopColor={edgeColor} stopOpacity={1} />}
                      <stop offset="1" stopColor={edgeColor} stopOpacity={tBlur > 0 ? 0 : 1} />
                    </linearGradient>
                  </defs>
                )}
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke="transparent" strokeWidth={12} />
                {/* thin bg-tinted moat that separates the line from overlapping elements (skip for faded edges) */}
                {!hasBlur && <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={bgColor} strokeWidth={isSel?4:2.5} strokeOpacity={0.4} />}
                {!hasBlur && <polygon points={arrowPts} fill={bgColor} fillOpacity={0.4} stroke={bgColor} strokeWidth={isSel?4:2.5} strokeOpacity={0.4} strokeLinejoin="round" />}
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={lineStroke} strokeWidth={isSel?2.5:1.5} filter={hasBlur ? undefined : "url(#edge-shadow)"} />
                <polygon points={arrowPts} fill={lineStroke} stroke={lineStroke} strokeWidth={isSel?2.5:1.5} strokeLinejoin="round" filter={hasBlur ? undefined : "url(#edge-shadow)"} />
                {label && (
                  <g transform={`translate(${(x1 + tipX) / 2},${(y1 + tipY) / 2})`} style={{ pointerEvents: 'none' }}>
                    <rect x={-(String(label).length * 3.4 + 5)} y={-8} width={String(label).length * 6.8 + 10} height={16} rx={4}
                      fill={bgColor} fillOpacity={0.9} stroke="#2a3358" strokeWidth={0.8} />
                    <text textAnchor="middle" dominantBaseline="central" fontSize={10.5} fill="#c5d0ff" style={{ userSelect: 'none' }}>{label}</text>
                  </g>
                )}
                {isSel && (
                  <g transform={`translate(${mx},${my})`} onClick={ev => { ev.stopPropagation(); removeEdge(id); setSelected(null) }} style={{ cursor:'pointer' }}>
                    <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
                    <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect:'none' }}>{'\xD7'}</text>
                  </g>
                )}
              </g>
              )
            })}

            {connecting && <line x1={connecting.x1} y1={connecting.y1} x2={connecting.x2} y2={connecting.y2} stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.7} />}

            {/* Group visual indicators */}
            {Object.entries(groupBounds).map(([gid, b]) => (
              <rect key={gid}
                x={b.x1 - 6} y={b.y1 - 6}
                width={b.x2 - b.x1 + 12} height={b.y2 - b.y1 + 12}
                fill="none" stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="6,4"
                rx={6} opacity={0.7} pointerEvents="none"
              />
            ))}

            {/* Rubber-band selection rect — rendered after nodes (below) so it's on top */}

            {/* Multi-selection bounding box outline. The resize itself is driven by each selected
                image's own corner handles (group-scale by default, Ctrl-drag = that image alone). */}
            {selectedImageIds.size >= 2 && (() => {
              const sel = (activeView?.images || []).filter(i => selectedImageIds.has(i.id))
              if (sel.length === 0) return null
              const bx1 = Math.min(...sel.map(i => i.x - i.width / 2))
              const by1 = Math.min(...sel.map(i => i.y - i.height / 2))
              const bx2 = Math.max(...sel.map(i => i.x + i.width / 2))
              const by2 = Math.max(...sel.map(i => i.y + i.height / 2))
              return (
                <rect x={bx1-3} y={by1-3} width={bx2-bx1+6} height={by2-by1+6}
                  fill="none" stroke="#ffffff" strokeWidth={1} strokeDasharray="4,3"
                  opacity={0.35} pointerEvents="none" />
              )
            })()}

            {/* 3. Images (floating photos are hidden while drilled into a node). Background pass —
                everything except cards flagged `z:'front'`, which paint in a later pass (on top of nodes).
                During stage play/preview/presentation, photos animate via a view-only overlay (position,
                size, opacity, colorize) merged over the doc image — never mutating the doc (in renderImageCard). */}
            {!drillRoot && (activeView?.images || []).filter(img => img.visible !== false && img.z !== 'front').map(renderImageCard)}

            {/* 3a. Drawing layer — floating shapes/lines/arrows/emoji/text (per-view decorations, not nodes). */}
            {(activeView?.drawings || []).map(d => (
              <DrawingItem key={d.id} d={d} selected={selectedDrawingId === d.id} zoomRef={zoomTransformRef} palette={COLOR_PALETTE}
                onSelect={() => { setSelectedDrawingId(d.id); setSelected(null); setSelectedNodeIds(new Set()); setSelectedImageIds(new Set()) }}
                onUpdate={props => updateDrawing(d.id, props)}
                onDelete={() => { deleteDrawing(d.id); setSelectedDrawingId(null) }} />
            ))}

            {/* 3b placeholder — 3D viewer is rendered as absolute div outside SVG below */}

            {/* Children-effects halos — painted BEHIND the nodes so the blurred glow pulses behind the crisp node. */}
            {effectParentList.length > 0 && (
              <EffectsOverlay parents={effectParentList} simNodesRef={simNodesRef} getVP={getVP}
                visibleRef={visibleNodeIdsRef} childrenOrdered={childrenOrdered} scheduleRender={scheduleRender} />
            )}

            {/* 4. Regular nodes on top */}
            {simNodesRef.current.filter(n => mountedRef.current.has(n.id) && getVP(n.id).shape !== 'frame' && getVP(n.id).shape !== 'container' && !listNodeSet.has(n.id) && !kanbanNodeSet.has(n.id) && !strategyNodeSet.has(n.id) && !tableNodeSet.has(n.id) && !mediaNodeSet.has(n.id) && !ytssNodeSet.has(n.id)).map(n => {
              const fo = nodeOpacityRef.current[n.id] ?? 1
              const dim = searchMatchSet && !searchMatchSet.has(n.id) ? 0.16 : 1
              return (
              <g key={n.id} style={{ opacity: fo * dim, transition: 'opacity 0.38s ease', pointerEvents: fo === 0 ? 'none' : undefined }}>
              <NodeShape node={n}
                modelThumb={getVP(n.id).model3dRotate === 'always' ? null : (liveThumbsRef.current[n.id] || storeNodes.find(s => s.id === n.id)?.modelThumb)}
                morphNonce={shapeMorph[n.id] || 0}
                imageUrl={storeNodes.find(s => s.id === n.id)?.imageUrl || ''}
                viewProps={resolveVP(n.id)}
                isSelected={(selected?.id === n.id && selected?.type === 'node') || selectedNodeIds.has(n.id) || !!movingIds?.has(n.id)}
                isHovered={hoveredNodeId === n.id}
                isDropTarget={dragHoverNodeId === n.id}
                autoEdit={pendingEditId === n.id}
                onAutoEditDone={() => setPendingEditId(null)}
                keepEdit={keepEditId === n.id}
                onKeepEditDone={() => setKeepEditId(null)}
                onMouseDown={handleNodeMouseDown}
                onConnectorMouseDown={handleConnectorMouseDown}
                onScaleMouseDown={handleScaleMouseDown}
                onBoxScaleMouseDown={handleBoxScaleMouseDown}
                zoomK={T.k}
                propertyDefs={storePropertyDefs}
                nodeProps={propsById[n.id]}
                onSetLabelWidth={handleLabelWidthMouseDown}
                onResetLabelWidth={id => setNodeViewProp(id, 'labelWidth', null)}
                onDelete={id => setConfirmDelete(id)}
                onLabelChange={updateLabel}
                onTab={handleNodeTab}
                onCreateSister={handleCreateSister}
                onShowNotePopup={id => setNotePopupId(prev => prev === id ? null : id)}
                onEmojiDragStart={handleEmojiDragStart}
                onRemoveEmoji={handleRemoveEmoji}
                onEmojiResizeStart={handleEmojiResizeStart}
                onImageDragStart={handleImageDragStart}
                onImageResizeStart={handleImageResizeStart}
                onImageCropDragStart={handleImageCropDragStart}
                onRemoveNodeImage={handleRemoveNodeImage}
                hasChildren={nodesWithChildren.has(n.id)}
                isCollapsed={collapsedSet.has(n.id)}
                onToggleCollapse={() => handleToggleCollapseAnimated(n.id)}
                onMouseEnter={() => showToolbar(n.id)}
                onMouseLeave={hideToolbar}
              />
              </g>
            )})}

            {/* List cards — a node whose subtree is shown as one nested, editable outline card. */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && listNodeSet.has(n.id)).map(n => {
              const meta = storeNodeById[n.id]?.meta || {}
              const order = meta.listOrder || { mode: 'structure' }
              const arrangements = meta.listArrangements || []
              const rows = buildListRows(n.id, order, arrangements)
              const topOrder = rows.filter(r => r.depth === 0).map(r => r.id)
              return (
              <g key={'lc' + n.id} data-cardnode={n.id}>
              <ListCard node={n} rootLabel={n.label} rows={rows}
                fill={getVP(n.id).fillColor} selectedId={selected?.type === 'node' ? selected.id : null}
                width={meta.listWidth || 248} onSetWidth={w => setNodeMeta(n.id, { listWidth: w })} zoomRef={zoomTransformRef}
                order={order} arrangements={arrangements} topOrder={topOrder} propertyDefs={storePropertyDefs}
                onHeaderDown={e => handleNodeMouseDown(e, n.id)}
                onSelect={id => setSelected({ id, type: 'node' })}
                onRename={(id, label) => updateLabel(id, label)}
                onDelete={id => { pushUndo(); deleteNode(id) }}
                onReorder={reorderRow}
                onMoveRow={(rowId, parentId, beforeId) => { pushUndo(); moveCardToColumn(rowId, parentId, beforeId) }}
                onSetOrder={o => setNodeMeta(n.id, { listOrder: o })}
                onAddArrangement={name => { const id = crypto.randomUUID(); setNodeMeta(n.id, { listArrangements: [...arrangements, { id, name: name || `Arrangement ${arrangements.length + 1}`, order: topOrder }], listOrder: { mode: 'arrangement', arrangementId: id } }) }}
                onRenameArrangement={(id, name) => setNodeMeta(n.id, { listArrangements: arrangements.map(a => a.id === id ? { ...a, name } : a) })}
                onDeleteArrangement={id => setNodeMeta(n.id, { listArrangements: arrangements.filter(a => a.id !== id), ...(order.arrangementId === id ? { listOrder: { mode: 'structure' } } : {}) })}
                onReorderArrangement={newOrder => { const aid = order.arrangementId; setNodeMeta(n.id, { listArrangements: arrangements.map(a => a.id === aid ? { ...a, order: newOrder } : a) }) }}
                onExit={() => toggleListNode(n.id)} />
              </g>
              )
            })}

            {/* Alt-drag duplicate ghost — translucent preview that follows the cursor */}
            {dupGhost && (() => {
              const r = NODE_R * (dupGhost.scale || 1)
              const fill = (dupGhost.fill && dupGhost.fill !== 'none' && dupGhost.fill !== 'transparent') ? dupGhost.fill : '#2a3260'
              return (
                <g transform={`translate(${dupGhost.x},${dupGhost.y})`} opacity={0.55} style={{ pointerEvents: 'none' }}>
                  <circle r={r} fill={fill} stroke="#7c8cff" strokeWidth={2} strokeDasharray="4,3" />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={12} fill="#fff" style={{ userSelect: 'none' }}>{(dupGhost.label || '').slice(0, 14)}</text>
                  <text y={r + 14} textAnchor="middle" fontSize={10} fill="#7c8cff" style={{ userSelect: 'none' }}>＋ copy</text>
                </g>
              )
            })()}

            {/* Kanban boards — structural (columns = child nodes) OR grouped (columns = a property's
                values, cards = the source's flattened descendants bucketed by value). */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && kanbanNodeSet.has(n.id)).map(n => {
              const board = storeNodeById[n.id]
              const kanban = board?.meta?.kanban || null
              const common = {
                key: 'kb' + n.id, node: n, title: board?.label || 'Board',
                propertyDefs: storePropertyDefs, allTags: allProjectTags,
                filters: board?.meta?.boardFilters || null, filterText: board?.meta?.boardFilter || '',
                scale: getVP(n.id).boardScale || 1,
                onSetScale: k => setNodeViewProp(n.id, 'boardScale', k),
                selectedId: selected?.type === 'node' ? selected.id : null,
                zoomRef: zoomTransformRef,
                onHeaderDown: e => handleNodeMouseDown(e, n.id),
                onSelect: id => setSelected({ id, type: 'node' }),
                onSetFilterText: f => setNodeMeta(n.id, { boardFilter: f }),
                onSetFilters: arr => setNodeMeta(n.id, { boardFilters: arr }),
                onRenameCard: (id, label) => updateLabel(id, label),
                onSetCardNotes: (id, notes) => updateNotes(id, notes),
                onExit: () => { if (kanban) { toggleKanbanNode(n.id); deleteNode(n.id) } else toggleKanbanNode(n.id) },
              }

              if (kanban) {
                // ── GROUPED board ──────────────────────────────────────────────
                const gb = kanban.groupBy || { mode: 'property', propId: null }
                const def = gb.mode === 'property' ? storePropertyDefs.find(d => d.id === gb.propId) : null
                const isMulti = def?.type === 'multiSelect'
                const items = flattenSubtree(kanban.sourceId).map(r => storeNodeById[r.id]).filter(Boolean)
                const toCard = it => ({ id: it.id, label: it.label || '', meta: it.meta || {}, notes: it.notes || '', props: it.props || {} })
                let columns = []
                if (gb.mode === 'tag') {
                  const tset = new Set(); items.forEach(it => (it.meta?.tags || []).forEach(t => tset.add(t)))
                  columns = [...tset].sort().map(t => ({ id: 'tag:' + t, label: t, color: tagColor(t), cards: items.filter(it => (it.meta?.tags || []).includes(t)).map(toCard) }))
                  columns.push({ id: '__none__', label: 'No tag', locked: true, cards: items.filter(it => !(it.meta?.tags || []).length).map(toCard) })
                } else {
                  const opts = def?.options || []
                  const val = it => it.props?.[gb.propId]
                  const inOpt = (it, oid) => isMulti ? (Array.isArray(val(it)) && val(it).includes(oid)) : val(it) === oid
                  const unset = it => isMulti ? !(Array.isArray(val(it)) && val(it).length) : (val(it) == null || val(it) === '')
                  columns = opts.map(o => ({ id: 'opt:' + o.id, label: o.name, optId: o.id, color: o.color, cards: items.filter(it => inOpt(it, o.id)).map(toCard) }))
                  columns.push({ id: '__none__', label: 'No value', locked: true, cards: items.filter(unset).map(toCard) })
                }
                const cardVal = cid => storeNodeById[cid]?.props?.[gb.propId]
                const applyMove = (cardId, colId) => {
                  if (gb.mode === 'tag') { if (colId.startsWith('tag:')) addNodeTag(cardId, colId.slice(4)); return }
                  if (colId === '__none__') { setNodeProp(cardId, gb.propId, isMulti ? [] : null); return }
                  if (!colId.startsWith('opt:')) return
                  const oid = colId.slice(4)
                  if (isMulti) { const cur = Array.isArray(cardVal(cardId)) ? cardVal(cardId) : []; if (!cur.includes(oid)) setNodeProp(cardId, gb.propId, [...cur, oid]) }
                  else setNodeProp(cardId, gb.propId, oid)
                }
                const colOptId = colId => colId.startsWith('opt:') ? colId.slice(4) : null
                return (
                  <g key={'kb' + n.id} data-cardnode={n.id}>
                  <KanbanCard {...common} columns={columns} grouped groupBy={gb}
                    onSetGroupBy={g => setKanbanGroupBy(n.id, g)}
                    onRenameBoard={label => updateLabel(n.id, label)}
                    onAddColumn={() => { if (gb.mode === 'property' && gb.propId) { pushUndo(); const OC = ['#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']; addSelectOption(gb.propId, 'New value', OC[(storePropertyDefs.find(d => d.id === gb.propId)?.options?.length || 0) % OC.length]) } }}
                    onRenameColumn={(colId, label) => { const oid = colOptId(colId); if (oid) renameSelectOption(gb.propId, oid, label) }}
                    onDeleteColumn={colId => { const oid = colOptId(colId); if (oid) { pushUndo(); deleteSelectOption(gb.propId, oid) } }}
                    onSetColumnColor={(colId, color) => { const oid = colOptId(colId); if (oid && color) recolorSelectOption(gb.propId, oid, color) }}
                    onSetColumnWip={() => {}}
                    onAddCard={(colId, label) => { pushUndo(); const id = addNode(label || 'New card', kanban.sourceId); applyMove(id, colId) }}
                    onDeleteCard={id => { pushUndo(); deleteNode(id) }}
                    onMoveCard={(cardId, colId) => { pushUndo(); applyMove(cardId, colId) }}
                    onMoveColumn={() => {}} />
                  </g>
                )
              }

              // ── STRUCTURAL board (default) ──────────────────────────────────
              const propId = board?.meta?.propId || null
              const colOptById = {}
              const columns = (childrenOrdered[n.id] || []).map(cid => {
                const cnode = storeNodeById[cid]
                colOptById[cid] = cnode?.meta?.optId || null
                return {
                  id: cid, label: nodeLabelById[cid] || '', optId: cnode?.meta?.optId || null,
                  color: cnode?.meta?.color || null, wip: cnode?.meta?.wip ?? null,
                  cards: (childrenOrdered[cid] || []).map(kid => ({ id: kid, label: nodeLabelById[kid] || '', meta: storeNodeById[kid]?.meta || {}, notes: storeNodeById[kid]?.notes || '', props: storeNodeById[kid]?.props || {} })),
                }
              })
              const setCardCol = (cardId, colId) => { if (propId && colOptById[colId]) setNodeProp(cardId, propId, colOptById[colId]) }
              return (
                <g key={'kb' + n.id} data-cardnode={n.id}>
                <KanbanCard {...common} columns={columns} propId={propId}
                  onRenameBoard={label => renameKanbanBoard(n.id, propId, label)}
                  onAddColumn={() => { pushUndo(); addKanbanColumn(n.id, propId) }}
                  onRenameColumn={(id, label) => renameKanbanColumn(id, propId, label)}
                  onDeleteColumn={id => { pushUndo(); deleteKanbanColumn(id, propId) }}
                  onSetColumnColor={(id, color) => setNodeMeta(id, { color })}
                  onSetColumnWip={(id, wip) => setNodeMeta(id, { wip })}
                  onAddCard={(colId, label) => { pushUndo(); const id = addNode(label || 'New card', colId); setCardCol(id, colId) }}
                  onDeleteCard={id => { pushUndo(); deleteNode(id) }}
                  onMoveCard={(cardId, colId, beforeId) => { pushUndo(); moveCardToColumn(cardId, colId, beforeId); setCardCol(cardId, colId) }}
                  onMoveColumn={(colId, beforeId) => { pushUndo(); moveChild(n.id, colId, beforeId) }} />
                </g>
              )
            })}

            {/* Strategy cards — a node whose whole subtree (every generation) is laid out as draggable
                cards with hand-drawn typed arrows (next / needs / decision-branch). Arrows live on
                node.meta.strategy, SEPARATE from graph edges. */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && strategyNodeSet.has(n.id)).map(n => {
              const board = storeNodeById[n.id]
              const items = flattenSubtree(n.id).map(r => ({ id: r.id, label: nodeLabelById[r.id] || '(untitled)' }))
              const strat = board?.meta?.strategy || {}
              return (
                <g key={'st' + n.id} data-cardnode={n.id}>
                <StrategyCard node={n} title={board?.label || 'Strategy'} items={items}
                  strategy={strat} zoomRef={zoomTransformRef} scale={getVP(n.id).strategyScale || 1}
                  fill={getVP(n.id).fillColor}
                  selectedId={selected?.type === 'node' ? selected.id : null}
                  onHeaderDown={e => handleNodeMouseDown(e, n.id)}
                  onSelect={id => setSelected({ id, type: 'node' })}
                  onRenameBoard={label => updateLabel(n.id, label)}
                  onRenameItem={(id, label) => updateLabel(id, label)}
                  onSetPos={(id, x, y) => setStrategyPos(n.id, id, x, y)}
                  onSetPositions={posMap => setStrategyPositions(n.id, posMap)}
                  onAddEdge={(from, to, kind, label) => addStrategyEdge(n.id, from, to, kind, label)}
                  onSetEdge={(eid, patch) => setStrategyEdge(n.id, eid, patch)}
                  onRemoveEdge={eid => removeStrategyEdge(n.id, eid)}
                  onToggleDecision={id => toggleStrategyDecision(n.id, id)}
                  onSetScale={k => setNodeViewProp(n.id, 'strategyScale', k)}
                  onExit={() => toggleStrategyNode(n.id)} />
                </g>
              )
            })}

            {/* Media nodes — a node carrying `node.media` is a first-class child rendered as its
                photo/video (via ImageNode), but with node behavior: edges, outliner, collapse,
                shift-drag. Drag = move the node; resize scales the media. */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && mediaNodeSet.has(n.id)).map(n => {
              const m = storeNodeById[n.id]?.media
              if (!m) return null
              const meta = storeNodeById[n.id]?.meta || {}
              const mediaImg = { id: n.id, x: n.x, y: n.y, width: m.width, height: m.height, rotation: m.rotation || 0, bgColor: null, ...m, title: storeNodeById[n.id]?.label || m.title, type: m.kind === 'video' ? 'video' : (m.kind === 'audio' ? 'audio' : undefined), autoplayOnZoom: meta.autoplayOnZoom, autoplayOnSlide: meta.autoplayOnSlide }
              // Autoplay-on-focus: a video/audio NODE plays when this node fills the viewport (e.g. arrow-nav
              // zoomed to it) or when its containing frame is presented. Flags live on node.meta.
              let mediaPlay = false
              if ((mediaImg.type === 'video' || mediaImg.type === 'audio') && (meta.autoplayOnZoom || meta.autoplayOnSlide)) {
                const t = zoomTransformRef.current, k = t.k || 1
                const vw = svgRef.current?.clientWidth || 0, vh = svgRef.current?.clientHeight || 0
                if (vw > 0) {
                  const cxs = t.x + n.x * k, cys = t.y + n.y * k
                  const inView = cxs > 0 && cxs < vw && cys > 0 && cys < vh
                  const fill = Math.max((m.width * k) / vw, (m.height * k) / vh)
                  if (inView && fill >= 0.4) mediaPlay = true
                }
                if (!mediaPlay && meta.autoplayOnSlide && isPresenting && presentingSlideIdx != null) {
                  const fr = slideSimNodes[presentingSlideIdx]
                  if (fr) {
                    const fvp = { ...DEFAULT_NODE_PROPS, ...(getVP(fr.id) || {}) }
                    const { halfW: dHW, halfH: dHH } = shapeDims('frame', NODE_R * (fvp.scale || 1))
                    const fhw = fvp.frameHalfW ?? dHW, fhh = fvp.frameHalfH ?? dHH
                    if (Math.abs(n.x - (fr.x || 0)) <= fhw && Math.abs(n.y - (fr.y || 0)) <= fhh) mediaPlay = true
                  }
                }
              }
              return (
                <g key={'media' + n.id} data-cardnode={n.id}>
                  <ImageNode img={mediaImg}
                    isSelected={(selected?.type === 'node' && selected.id === n.id) || selectedNodeIds.has(n.id) || !!movingIds?.has(n.id)}
                    isCropping={false}
                    mediaPlay={mediaPlay}
                    onToggleMedia={prop => setNodeMeta(n.id, { [prop]: !meta[prop] })}
                    onEditVideo={() => setVideoEdit({ kind: 'media', id: n.id })}
                    previewing={videoEdit?.kind === 'media' && videoEdit.id === n.id}
                    onPlayerReady={setVideoPreviewHandle}
                    onMediaTitle={() => { const next = prompt('Title', storeNodeById[n.id]?.label || m.title || ''); if (next !== null) updateLabel(n.id, next.trim()) }}
                    zoomK={T.k}
                    onMouseDown={handleMediaNodeMouseDown} />
                </g>
              )
            })}

            {/* YouTube slideshow nodes — a node carrying `ytss` is a clean multi-clip player. */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && ytssNodeSet.has(n.id)).map(n => {
              const nd = storeNodeById[n.id]; if (!nd?.ytss) return null
              n.__scale = getVP(n.id).ytssScale || 1
              const active = ytssActiveId === n.id
              const inspecting = ytssInspectorId === n.id
              return (
                <YTSlideshowNode key={'ytss' + n.id} node={n} ytss={nd.ytss}
                  currentIdx={ytssIdxMap[n.id] || 0} active={active} playing={active || inspecting}
                  ended={ytssEndedId === n.id}
                  selected={selected?.type === 'node' && selected.id === n.id}
                  isDropTarget={dragHoverNodeId === n.id}
                  onHeaderDown={e => handleNodeMouseDown(e, n.id)}
                  onSelect={() => setSelected({ id: n.id, type: 'node' })}
                  onEnter={() => { setSelected({ id: n.id, type: 'node' }); enterYtssAndPlay(n.id) }}
                  onFullscreen={() => { ytssHandlesRef.current[n.id]?.pause?.(); setYtssActiveId(null); setYtssEndedId(null); setYtssFullscreenId(n.id) }}
                  onReplay={() => { setYtssEndedId(null); setYtssIdxMap(m => ({ ...m, [n.id]: 0 })); ytssPlayingRef.current = true }}
                  onEdit={() => setYtssInspectorId(n.id)}
                  onSetIdx={i => setYtssIdxMap(m => ({ ...m, [n.id]: i }))}
                  onReady={h => { ytssHandlesRef.current[n.id] = h }}
                  onEnded={() => {
                    if (ytssActiveRef.current !== n.id) return   // only the entered slideshow auto-advances
                    const yn2 = useGraphStore.getState().nodes.find(x => x.id === n.id)
                    const clips = yn2?.ytss?.clips || []
                    const cur = Math.max(0, Math.min(ytssIdxMapRef.current[n.id] || 0, clips.length - 1))
                    const clip = clips[cur]; if (!clip) return
                    const advance = () => {
                      const ni = cur + 1
                      if (ni < clips.length) { setYtssIdxMap(m => ({ ...m, [n.id]: ni })); ytssPlayingRef.current = true }
                      else { ytssPlayingRef.current = false; if (presentingSlideIdxRef.current !== null) advanceBuild(1); else setYtssEndedId(n.id) }   // end of show → next slide when presenting, else show replay
                    }
                    if (clip.trigger === 'auto') advance()
                    else if (clip.trigger === 'delay') setTimeout(advance, clip.delayMs || 1500)
                    else if (cur === clips.length - 1) setYtssEndedId(n.id)   // 'click' on the last slide → end state
                    // other 'click' → wait for an arrow / Space
                  }} />
              )
            })}

            {/* Table nodes — a node carrying `table` is drawn as an editable spreadsheet card. */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && tableNodeSet.has(n.id)).map(n => {
              const node = storeNodeById[n.id]
              if (!node?.table) return null
              return (
                <g key={'tbl' + n.id} data-cardnode={n.id}>
                <TableCard node={n} title={node.label} table={node.table} zoomRef={zoomTransformRef}
                  fill={getVP(n.id).fillColor} scale={getVP(n.id).tableScale || 1} palette={COLOR_PALETTE}
                  selected={selected?.type === 'node' && selected.id === n.id}
                  collapsed={!!getVP(n.id).tableCollapsed}
                  collapsedScale={getVP(n.id).collapsedTableScale || 1}
                  onToggleCollapse={() => setNodeViewProp(n.id, 'tableCollapsed', !getVP(n.id).tableCollapsed)}
                  onSetCollapsedScale={k => setNodeViewProp(n.id, 'collapsedTableScale', k)}
                  onPivotTop={dy => {
                    const sn = simNodesRef.current.find(x => x.id === n.id); const vp = getVP(n.id)
                    if (sn) { sn.y = (sn.y || 0) + dy; if (sn.fy != null) sn.fy = sn.y }
                    if (vp.fy != null) setAnchor(n.id, vp.fx ?? sn?.x ?? 0, vp.fy + dy)
                    scheduleRender()
                  }}
                  onWheelScroll={(dx, dy) => {
                    if (!svgRef.current || !zoomBehaviorRef.current) return
                    const k = zoomTransformRef.current.k || 1
                    d3.select(svgRef.current).call(zoomBehaviorRef.current.translateBy, -dx / k, -dy / k)
                  }}
                  onWheelZoom={(dy, cx, cy) => {
                    if (!svgRef.current || !zoomBehaviorRef.current) return
                    const rect = svgRef.current.getBoundingClientRect()
                    const factor = Math.pow(2, -dy * 0.002)   // matches D3's default (non-ctrl) wheel-zoom rate
                    d3.select(svgRef.current).call(zoomBehaviorRef.current.scaleBy, factor, [cx - rect.left, cy - rect.top])
                  }}
                  onHeaderDown={e => handleNodeMouseDown(e, n.id)}
                  onSelect={() => setSelected({ id: n.id, type: 'node' })}
                  onRename={label => updateLabel(n.id, label)}
                  onCell={(rowId, colId, value) => setTableCell(n.id, rowId, colId, value)}
                  onSetCellBg={(rowId, colId, color) => setTableCellBg(n.id, rowId, colId, color)}
                  onAddRow={() => addTableRow(n.id)}
                  onAddColumn={type => addTableColumn(n.id, type)}
                  onInsertRow={at => insertTableRow(n.id, at)}
                  onInsertColumn={(at, type) => insertTableColumn(n.id, at, type)}
                  onDeleteRow={rowId => deleteTableRow(n.id, rowId)}
                  onDeleteColumn={colId => deleteTableColumn(n.id, colId)}
                  onUpdateColumn={(colId, patch) => updateTableColumn(n.id, colId, patch)}
                  onMoveColumn={(colId, targetColId) => { const idx = (node.table.columns || []).findIndex(c => c.id === targetColId); if (idx >= 0) moveTableColumn(n.id, colId, idx) }}
                  onMoveRow={(rowId, targetRowId) => { const idx = (node.table.rows || []).findIndex(r => r.id === targetRowId); if (idx >= 0) moveTableRow(n.id, rowId, idx) }}
                  onSetRowHeight={(rowId, h) => setTableRowHeight(n.id, rowId, h)}
                  onSetColor={c => setNodeViewProp(n.id, 'fillColor', c === 'none' ? 'none' : c)}
                  textColor={getVP(n.id).textColor}
                  onSetTextColor={c => setNodeViewProp(n.id, 'textColor', c === '__default__' ? null : c)}
                  onSetScale={k => setNodeViewProp(n.id, 'tableScale', k)}
                  onDelete={() => setConfirmDeleteNodes([n.id])} />
                </g>
              )
            })}

            {/* 5. Front images — cards flagged `z:'front'` (freshly pasted/dropped) paint here, ABOVE the
                nodes/tables, so the newest element lands on top of everything. Array order keeps the latest
                on top of earlier front cards. */}
            {!drillRoot && (activeView?.images || []).filter(img => img.visible !== false && img.z === 'front').map(renderImageCard)}

            {/* Rubber-band selection rect — on top of nodes/images */}
            {rubberBand && (() => {
              const x = Math.min(rubberBand.sx, rubberBand.ex)
              const y = Math.min(rubberBand.sy, rubberBand.ey)
              const w = Math.abs(rubberBand.ex - rubberBand.sx)
              const h = Math.abs(rubberBand.ey - rubberBand.sy)
              return <rect x={x} y={y} width={w} height={h}
                fill="rgba(91,106,240,0.08)" stroke="#5b6af0" strokeWidth={1} strokeDasharray="4,3"
                pointerEvents="none" />
            })()}

          </g>
        </svg>

        {/* New-node name input — appears at the double-clicked spot */}
        {newNodeAt && (
          <input
            autoFocus
            placeholder="New node…"
            defaultValue=""
            onMouseDown={e => e.stopPropagation()}
            onBlur={e => {
              const label = e.target.value.trim()
              const { sx, sy } = newNodeAt
              setNewNodeAt(null)
              if (!label) return
              const id = addNode(label, drillRoot || null, sx, sy)
              setTimeout(() => {
                const sn = simNodesRef.current.find(n => n.id === id)
                if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy }
                scheduleRender()
              }, 0)
            }}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur() }
            }}
            style={{
              position: 'absolute', left: newNodeAt.px, top: newNodeAt.py,
              transform: 'translate(-50%, -50%)', zIndex: 30, width: 150,
              background: '#16162a', border: '1px solid #5b6af0', borderRadius: 6,
              color: '#fff', fontSize: '0.85rem', padding: '5px 8px', outline: 'none',
              boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
            }}
          />
        )}

        {/* Right-click context menu */}
        {contextMenu && (() => {
          const close = () => { setContextMenu(null); setCtxColors(false); setCtxPanel(null) }
          const item = (icon, label, onClick) => (
            <div onClick={onClick}
              onMouseEnter={e => e.currentTarget.style.background = '#23234a'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              style={{ padding: '6px 12px', fontSize: '0.82rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {icon && <span style={{ width: 16, textAlign: 'center', fontSize: '0.88rem', opacity: 0.9, flexShrink: 0 }}>{icon}</span>}
                <span>{label}</span>
              </span>
            </div>
          )
          return (
            <>
              <div onMouseDown={close} onContextMenu={e => e.preventDefault()}
                style={{ position: 'fixed', inset: 0, zIndex: 34 }} />
              <div data-graphmenu onMouseDown={e => e.stopPropagation()}
                ref={el => clampMenuEl(el, contextMenu.px, contextMenu.py, false)}
                style={{
                  position: 'absolute', left: contextMenu.px, top: contextMenu.py, zIndex: 35,
                  background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 4,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.7)', minWidth: 160,
                }}>
                {item('📋', 'Paste', () => { const { sx, sy } = contextMenu; close(); pasteAnyAt(sx, sy) })}
                <div style={{ borderTop: '1px solid #23233e', margin: '3px 6px' }} />
                <MenuFlyout icon="＋" label="Insert">
                  {item('▭', 'Frame', () => {
                    pushUndo()
                    const { sx, sy } = contextMenu
                    const id = addNode('Frame', drillRoot || null, sx, sy)
                    setNodeViewProp(id, 'shape', 'frame'); setNodeViewProp(id, 'fillColor', 'none'); setNodeViewProp(id, 'strokeColor', null)
                    addSlide(id)
                    setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy } scheduleRender() }, 0)
                    close()
                  })}
                  {item('✚', 'Node', () => { setNewNodeAt({ px: contextMenu.px, py: contextMenu.py, sx: contextMenu.sx, sy: contextMenu.sy }); close() })}
                  {item('🅃', 'Text box', () => { const { sx, sy } = contextMenu; close(); const tid = addTextBox(sx, sy, 220, 60, '<div>Text</div>'); setSelectedNodeIds(new Set()); setSelected(null); setSelectedImageIds(new Set([tid])) })}
                  {item('▦', 'Table', () => {
                    pushUndo()
                    const { sx, sy } = contextMenu
                    const id = addTableNode(sx, sy)
                    if (drillRoot) addEdge(drillRoot, id)
                    setSelected({ id, type: 'node' })
                    setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy } scheduleRender() }, 0)
                    close()
                  })}
                  {item('🗂️', 'Kanban board', () => {
                    pushUndo()
                    const { sx, sy } = contextMenu
                    const id = addKanbanNode(sx, sy)
                    if (drillRoot) addEdge(drillRoot, id)
                    setSelected({ id, type: 'node' })
                    setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy } scheduleRender() }, 0)
                    close()
                  })}
                  {item('⬭', 'Container', () => {
                    pushUndo()
                    const { sx, sy } = contextMenu
                    const id = addNode('Container', drillRoot || null, sx, sy)
                    setNodeViewProp(id, 'shape', 'container'); setNodeViewProp(id, 'containerShape', 'rect')
                    setSelected({ id, type: 'node' })
                    setTimeout(() => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy } scheduleRender() }, 0)
                    close()
                  })}
                  <div style={{ borderTop: '1px solid #23233e', margin: '3px 6px' }} />
                  {item('🖼️', 'Image…', () => { const { sx, sy } = contextMenu; close(); addImageFileAt(sx, sy) })}
                  {item('📋', 'Paste image', () => { const { sx, sy } = contextMenu; close(); pasteImageAt(sx, sy) })}
                  <MenuFlyout icon="🎬" label="Video">
                    {item('⤒', 'Upload a file', () => { const { sx, sy } = contextMenu; close(); addVideoFileAt(sx, sy) })}
                    {item('🔗', 'Paste a YouTube link', () => { const { sx, sy } = contextMenu; close(); addYoutubeAt(sx, sy) })}
                  </MenuFlyout>
                  <MenuFlyout icon="🎵" label="Audio">
                    {item('⤒', 'Upload a file', () => { const { sx, sy } = contextMenu; close(); addAudioFileAt(sx, sy) })}
                    {item('🔗', 'Paste a link', () => { const { sx, sy } = contextMenu; close(); const url = window.prompt('Paste an audio link (mp3, etc.):'); if (url && url.trim()) addAudioUrlAt(url.trim(), sx, sy) })}
                  </MenuFlyout>
                  {item('📺', 'Slideshow', () => { const { sx, sy } = contextMenu; close(); pushUndo(); const id = addYtssNode(sx, sy); setTimeout(() => { const sn = simNodesRef.current.find(m => m.id === id); if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy } scheduleRender() }, 0); setYtssInspectorId(id) })}
                  {item('🔗', 'Link…', () => { const { sx, sy } = contextMenu; close(); const url = window.prompt('Paste a link to unfurl:'); if (url && url.trim()) addLinkAt(url.trim(), sx, sy) })}
                  <div style={{ borderTop: '1px solid #23233e', margin: '3px 6px' }} />
                  {item('🗂️', 'View', () => { pushUndo(); addView(); close() })}
                </MenuFlyout>
                {item('🎞️', 'Make current view a slide', () => { makeCurrentViewAsSlide(); close() })}
                <div style={{ borderTop: '1px solid #23233e', margin: '3px 6px' }} />
                <MenuFlyout icon="🎨" label="Background color">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, width: 168, padding: '4px 8px 6px' }}>
                    {[...BG_COLORS, ...COLOR_PALETTE].map(c => (
                      <div key={c} title={c} onClick={() => { setViewBgColor(c); close() }}
                        style={{ width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer',
                          border: bgColor === c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)' }} />
                    ))}
                  </div>
                </MenuFlyout>
                {item('▣', 'Select all nodes', () => { setSelectedNodeIds(new Set([...visibleNodeIds])); setSelected(null); close() })}
                {item('⤢', 'Fit to view', () => { zoomExtents(); close() })}
                {item('⊙', 'Release all anchors', () => { handleReleaseAll(); close() })}
                {item(hideFrameOutlines ? '⊞' : '⊟', hideFrameOutlines ? 'Show frame outlines' : 'Hide frame outlines', () => { setHideFrameOutlines(v => !v); close() })}
                {item('⤳', showFlowchart ? 'Hide flowchart' : 'Flowchart (Mermaid)', () => { setShowFlowchart(v => !v); close() })}
              </div>
            </>
          )
        })()}

        {/* Bulk right-click menu — applies to every node in the current multi-selection. */}
        {bulkMenu && (() => {
          const ids = bulkMenu.ids
          const close = () => { setBulkMenu(null); setBulkPanel(null) }
          const setAll = (prop, val) => { pushUndo(); ids.forEach(id => setNodeViewProp(id, prop, val)) }
          const item = (icon, label, onClick) => (
            <div onClick={onClick}
              onMouseEnter={e => e.currentTarget.style.background = '#23234a'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              style={{ padding: '6px 12px', fontSize: '0.82rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap', borderRadius: 4, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                {icon && <span style={{ width: 16, textAlign: 'center', fontSize: '0.88rem', opacity: 0.9, flexShrink: 0 }}>{icon}</span>}
                <span>{label}</span>
              </span>
            </div>
          )
          const back = (label) => item(null, <span style={{ color: '#8090b8' }}>‹ {label}</span>, () => setBulkPanel(null))
          const swatchGrid = (withNone, onPick) => (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, width: 178, padding: '4px 8px 6px' }}>
              {withNone && <div title="None" onClick={() => { onPick('__none__'); close() }} style={{ width: 22, height: 22, borderRadius: 4, background: 'transparent', border: '1.5px solid #5b6af0', cursor: 'pointer', color: '#8090b8', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>∅</div>}
              {COLOR_PALETTE.map(c => (
                <div key={c} title={c} onClick={() => { onPick(c); close() }} style={{ width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer', border: '1.5px solid rgba(255,255,255,0.15)' }} />
              ))}
            </div>
          )
          const listPanel = (opts, onPick) => opts.map(([label, val], i) => <div key={i}>{item(null, label, () => { onPick(val); close() })}</div>)
          const PANELS = {
            fill:   () => <>{swatchGrid(true, c => setAll('fillColor', c === '__none__' ? 'none' : c))}</>,
            text:   () => <>{swatchGrid(false, c => setAll('textColor', c))}</>,
            stroke: () => <>{swatchGrid(true, c => setAll('strokeColor', c === '__none__' ? null : c))}</>,
            shape:  () => <>{listPanel([['● Circle', 'circle'], ['⬭ Ellipse', 'ellipse'], ['▢ Rounded', 'roundrect'], ['▮ Rectangle', 'rect'], ['◆ Diamond', 'diamond']], v => setAll('shape', v))}</>,
            width:  () => <>{listPanel([['None', 0], ['Thin', 1], ['Medium', 2], ['Thick', 3.5]], v => setAll('strokeWidth', v))}</>,
            dash:   () => <>{listPanel([['Solid', 'solid'], ['Dashed', 'dashed'], ['Dotted', 'dotted']], v => setAll('strokeDash', v))}</>,
            opacity:() => <>{listPanel([['100%', 1], ['75%', 0.75], ['50%', 0.5], ['25%', 0.25]], v => setAll('opacity', v))}</>,
            size:   () => <>{listPanel([['Small', 0.6], ['Medium', 1], ['Large', 1.5], ['Extra large', 2.2]], v => setAll('scale', v))}</>,
            motion: () => <>{listPanel([['None', null], ['≋ Shake', { type: 'shake' }], ['◎ Orbit', { type: 'circle' }], ['⚡ Pulse', { type: 'scale' }], ['↕ Up/Down', { type: 'updown' }], ['↔ Sideways', { type: 'sideways' }]], v => setAll('nodeMotion', v ? { ...v, speed: 1, intensity: 1 } : null))}</>,
            style:  () => storeStyles.length ? storeStyles.map(st => <div key={st.id}>{item(null, st.name, () => { pushUndo(); applyStyleAction(st.id, ids); close() })}</div>) : <div style={{ padding: '6px 12px', fontSize: '0.78rem', color: '#8090b8' }}>No saved styles</div>,
          }
          const row = (icon, label, panel) => <MenuFlyout icon={icon} label={label} minWidth={190}>{PANELS[panel]()}</MenuFlyout>
          return (
            <>
              <div onMouseDown={close} onContextMenu={e => e.preventDefault()} style={{ position: 'fixed', inset: 0, zIndex: 34 }} />
              <div data-graphmenu onMouseDown={e => e.stopPropagation()} ref={el => clampMenuEl(el, bulkMenu.px, bulkMenu.py, false)}
                style={{ position: 'absolute', left: bulkMenu.px, top: bulkMenu.py, zIndex: 35, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 4, boxShadow: '0 6px 20px rgba(0,0,0,0.7)', minWidth: 190, maxHeight: '70vh', overflowY: 'auto', overflowX: 'hidden' }}>
                <div style={{ padding: '5px 12px 6px', fontSize: '0.7rem', color: '#8090b8', fontWeight: 600, borderBottom: '1px solid #23233e', marginBottom: 3 }}>{ids.length} nodes selected</div>
                {(
                  <>
                    {row('🎨', 'Fill color', 'fill')}
                    {row('🅰️', 'Text color', 'text')}
                    {row('▢', 'Border color', 'stroke')}
                    {row('┃', 'Border width', 'width')}
                    {row('┅', 'Border style', 'dash')}
                    {row('◆', 'Shape', 'shape')}
                    {row('⇲', 'Size', 'size')}
                    {row('◐', 'Opacity', 'opacity')}
                    {row('🌀', 'Motion', 'motion')}
                    {row('🎭', 'Apply style', 'style')}
                    <div style={{ borderTop: '1px solid #23233e', margin: '3px 6px' }} />
                    {item('⚖️', usptoBusy ? 'Checking USPTO…' : 'Check USPTO (live hits)', () => { if (!usptoBusy) { runUSPTOCheck(ids); close() } })}
                    {item('🏷️', 'Tag these…', () => { const t = prompt('Tag to add to the selected nodes'); if (t && t.trim()) { const tag = t.trim().replace(/^#/, ''); ids.forEach(id => addNodeTag(id, tag)) } close() })}
                    <div style={{ borderTop: '1px solid #23233e', margin: '3px 6px' }} />
                    {item('⚓', 'Release anchors', () => { ids.forEach(id => releaseAnchor(id)); ids.forEach(id => { const sn = simNodesRef.current.find(n => n.id === id); if (sn) { sn.fx = null; sn.fy = null } }); simRef.current?.alpha(0.4).restart(); close() })}
                    {item('🙈', 'Hide these', () => { pushUndo(); ids.forEach(id => setNodeViewProp(id, 'visible', false)); setSelectedNodeIds(new Set()); close() })}
                    {item('🗑️', <span style={{ color: '#f0a0a0' }}>Delete these</span>, () => { setConfirmDeleteNodes(ids); close() })}
                  </>
                )}
              </div>
            </>
          )
        })()}

        {showExport && (
          <ExportDialog projectName={projectName} nodes={storeNodes} edges={storeEdges} views={views}
            activeViewId={activeViewId} captureGraphSVG={captureGraphSVG} onClose={() => setShowExport(false)} />
        )}

        {showFlowchart && (
          <FlowchartPanel visibleIds={visibleNodeIds}
            centerXY={() => svgRef.current ? zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2]) : [0, 0]}
            onApplied={() => { simRef.current?.alpha(0.5).restart(); scheduleRender() }}
            onClose={() => setShowFlowchart(false)} />
        )}

        {/* Always-on 3D viewers (rotate mode 'always', not currently selected) */}
        {simNodesRef.current.filter(n => {
          if (!visibleNodeIds.has(n.id)) return false
          if (selected?.type === 'node' && selected.id === n.id) return false
          const vp = getVP(n.id)
          return vp.shape === '3d' && vp.model3dRotate === 'always'
        }).map(n => {
          const vp = getVP(n.id)
          const r = NODE_R * (vp.scale || 1)
          const { halfW: hw, halfH: hh } = shapeDims('3d', r)
          const sn = storeNodes.find(s => s.id === n.id)
          const sx = T.x + (n.x || 0) * T.k, sy = T.y + (n.y || 0) * T.k
          const sw = hw * 2 * T.k, sh = hh * 2 * T.k
          return (
            <div key={`always-${n.id}`}
              style={{ position:'absolute', left:0, top:0,
                transform: `translate(${sx - sw/2}px, ${sy - sh/2}px)`,
                width: sw, height: sh, borderRadius: 12, overflow:'hidden',
                pointerEvents:'none', zIndex: 4 }}>
              <Node3DViewer
                modelData={sn?.modelData} modelType={sn?.modelType}
                camState={vp.model3dCam}
                autoRotate={true} autoRotateSpeed={vp.model3dRotateSpeed ?? 2}
                readOnly={true}
              />
            </div>
          )
        })}

        {/* 3D viewer — active (selected node) */}
        {selected?.type === 'node' && (() => {
          const n3d = simNodesRef.current.find(nd => nd.id === selected.id)
          if (!n3d || !visibleNodeIds.has(selected.id)) return null
          const vp3d = getVP(selected.id)
          if (vp3d.shape !== '3d') return null
          const r3d = NODE_R * (vp3d.scale || 1)
          const { halfW: hw3d, halfH: hh3d } = shapeDims('3d', r3d)
          const storeNode3d = storeNodes.find(s => s.id === selected.id)
          const screenX = T.x + (n3d.x || 0) * T.k
          const screenY = T.y + (n3d.y || 0) * T.k
          const screenW = hw3d * 2 * T.k
          const screenH = hh3d * 2 * T.k
          const rotateMode = vp3d.model3dRotate || 'never'
          const rotateSpeed = vp3d.model3dRotateSpeed ?? 2
          const isFs = fullscreen3dId === selected.id

          const handleImport3d = async file => {
            const nodeId = selected.id
            const ext = file.name.split('.').pop().toLowerCase()
            const reader = new FileReader()
            reader.onload = ev => set3DModel(nodeId, ev.target.result.split(',')[1], ext)
            reader.readAsDataURL(file)
            try {
              const { url, type } = await uploadModel(file, projectId, nodeId)
              set3DModel(nodeId, url, type)
            } catch (e) {
              console.warn('Model storage upload failed, keeping in-memory:', e)
            }
          }

          const viewerStyle = isFs
            ? { position:'fixed', inset:0, zIndex:200, borderRadius:0 }
            : { position:'absolute', left:0, top:0,
                transform: `translate(${screenX - screenW/2}px, ${screenY - screenH/2}px)`,
                width: screenW, height: screenH, borderRadius:12, zIndex:5 }

          return (
            <div key={selected.id}
              onMouseDown={e => { e.stopPropagation(); if (e.button === 1) e.preventDefault(); canvasFocused.current = true }}
              onKeyDown={e => { if (e.key === 'Escape') { if (isFs) { setFullscreen3dId(null) } else { setSelected(null) }; e.stopPropagation() } }}
              tabIndex={-1}
              style={{ overflow:'hidden', outline:'none', ...viewerStyle }}>
              <Node3DViewer
                modelData={storeNode3d?.modelData}
                modelType={storeNode3d?.modelType}
                camState={vp3d.model3dCam}
                onCamEnd={cam => setNodeViewProp(selected.id, 'model3dCam', cam)}
                onThumbnailCapture={thumb => {
                  liveThumbsRef.current[selected.id] = thumb
                  uploadThumbnail(thumb, projectId, selected.id)
                    .then(url => { if (url) setModelThumb(selected.id, url) })
                    .catch(() => {})
                }}
                onImport={handleImport3d}
                autoRotate={rotateMode !== 'never'}
                autoRotateSpeed={rotateSpeed}
                rotateMode={rotateMode}
                onRotateModeChange={mode => setNodeViewProp(selected.id, 'model3dRotate', mode)}
                onRotateSpeedChange={spd => setNodeViewProp(selected.id, 'model3dRotateSpeed', spd)}
                isFullscreen={isFs}
                onToggleFullscreen={() => setFullscreen3dId(isFs ? null : selected.id)}
              />
            </div>
          )
        })()}

        {/* Node menu â€" opens on right-click, anchored at the cursor */}
        {/* Node style toolbar — DOCKED popup near the node, or (when undocked) a draggable floating window. */}
        {nodeMenu && (() => {
          const hn = simNodesRef.current.find(n => n.id === nodeMenu.nodeId)
          const hs = hn && storeNodes.find(n => n.id === hn.id)
          if (!hn || !hs || !visibleNodeIds.has(hn.id)) return null
          const vp = getVP(hn.id)
          const close = () => setNodeMenu(null)
          const toolbar = (
            <NodeToolbar
              key={hn.id}
              floating={floatDock}
              onUndock={() => setFloatDock(true)}
              onRedock={() => { setFloatDock(false); setNodeMenu(null) }}
              nodeTitle={hs.label || 'Untitled'}
              x={nodeMenu.px}
              y={nodeMenu.py}
              viewProps={vp}
              notes={hs.notes || ''}
              onSetFill={c => setNodeViewProp(hn.id, 'fillColor', c)}
              onSetTextColor={c => setNodeViewProp(hn.id, 'textColor', c)}
              onSetStrokeColor={c => setNodeViewProp(hn.id, 'strokeColor', c)}
              onSetStrokeWidth={w => setNodeViewProp(hn.id, 'strokeWidth', w)}
              onSetStrokeDash={d => setNodeViewProp(hn.id, 'strokeDash', d)}
              onArrange={layout => { doArrange(hn.id, layout); close() }}
              onReleaseChildren={() => { doReleaseSubtree(hn.id); close() }}
              selCount={selectedNodeIds.size}
              styles={storeStyles}
              onSaveStyle={name => saveStyleFromNode(hn.id, name)}
              onUpdateStyle={id => updateStyleFromNode(id, hn.id)}
              onRenameStyle={renameStyle}
              onDeleteStyle={deleteStyle}
              onApplyStyle={id => { pushUndo(); const ids = selectedNodeIds.size > 1 ? [...selectedNodeIds] : [hn.id]; applyStyleAction(id, ids) }}
              onSetBorderBlur={v => setNodeViewProp(hn.id, 'borderBlur', v)}
              onSetOpacity={v => setNodeViewProp(hn.id, 'opacity', v)}
              onSetShadow={v => setNodeViewProp(hn.id, 'shadow', v)}
              onSetBorderFx={v => setNodeViewProp(hn.id, 'borderFx', v)}
              onSetBorderFxAmp={v => setNodeViewProp(hn.id, 'borderFxAmp', v)}
              onSetBorderFxCount={v => setNodeViewProp(hn.id, 'borderFxCount', v)}
              onSetSpin={v => setNodeViewProp(hn.id, 'spin', v)}
              onSetShape={s => { setNodeViewProp(hn.id, 'shape', s); if (s === 'image') setNodeViewProp(hn.id, 'fillColor', 'transparent'); if (s === '3d') setNodeViewProp(hn.id, 'fillColor', 'none') }}
              onDuplicate={() => { pushUndo(); handleDuplicateNode(hn.id); close() }}
              tags={hs.meta?.tags || []}
              allTags={allProjectTags}
              onAddTag={t => addNodeTag(hn.id, t)}
              onRemoveTag={t => removeNodeTag(hn.id, t)}
              onAutoStyle={() => { setAutoStyleNode(hn.id); close() }}
              onGenContent={() => { setGenDialog({ nodeId: hn.id }); close() }}
              onGenWords={() => { setWgErr(null); setWgDialog({ nodeId: hn.id, mode: 'words' }); close() }}
              onGenVariations={() => { setWgErr(null); setWgDialog({ nodeId: hn.id, mode: 'variations' }); close() }}
              onDrill={() => { setDrillRoot(hn.id); close() }}
              onToggleList={() => { toggleListNode(hn.id); close() }}
              isList={listNodeSet.has(hn.id)}
              onToggleKanban={() => { toggleKanbanNode(hn.id); close() }}
              isKanban={kanbanNodeSet.has(hn.id)}
              onToggleStrategy={() => { toggleStrategyNode(hn.id); close() }}
              isStrategy={strategyNodeSet.has(hn.id)}
              onMakeContainer={vp.shape === 'container' ? null : () => { makeContainer(hn.id); close() }}
              onGroupBoard={gb => { pushUndo(); const bx = (hn.x || 0) + 160, by = (hn.y || 0); const id = addGroupedBoard(hn.id, gb, bx, by); setTimeout(() => { const sn = simNodesRef.current.find(m => m.id === id); if (sn) { sn.x = bx; sn.y = by; sn.fx = bx; sn.fy = by } scheduleRender() }, 0); close() }}
              hasChildrenForList={storeEdges.some(e => e.source === hn.id)}
              childrenEffect={vp.childrenEffect}
              onSetChildrenEffect={fx => setNodeViewProp(hn.id, 'childrenEffect', fx)}
              onHide={() => { pushUndo(); setNodeViewProp(hn.id, 'visible', false); close() }}
              onRelease={() => handleRelease(hn.id)}
              onDelete={() => { setConfirmDelete(hn.id); close() }}
              onNotesChange={notes => updateNotes(hn.id, notes)}
              isAnchored={hn.fx != null}
              imageUrl={hs.imageUrl || ''}
              onSetImageUrl={url => setImageUrl(hn.id, url)}
              onRadiate={what => {
                const childIds = storeEdges.filter(e => e.source === hn.id).map(e => e.target)
                childIds.forEach(cid => {
                  if (what === 'color' || what === 'both') {
                    setNodeViewProp(cid, 'fillColor', vp.fillColor)
                    setNodeViewProp(cid, 'strokeColor', vp.strokeColor ?? null)   // radiate outline colour too
                    if (vp.strokeWidth != null) setNodeViewProp(cid, 'strokeWidth', vp.strokeWidth)
                  }
                  if (what === 'shape' || what === 'both') setNodeViewProp(cid, 'shape', vp.shape)
                })
              }}
              onSetMotion={m => setNodeViewProp(hn.id, 'nodeMotion', m)}
              onSetColorCycle={spd => setNodeViewProp(hn.id, 'nodeColorCycle', spd)}
              onAddEmoji={(value, type = 'unicode') => {
                const cur = (views.find(v => v.id === activeViewId)?.nodeProps?.[hn.id]?.nodeEmojis) || []
                const { halfW: nhW, halfH: nhH } = shapeDims(vp.shape || 'circle', NODE_R * (vp.scale || 1), hs.label, Math.max(9, Math.round(12 * (vp.scale || 1))), vp.labelWidth)
                const cornerAngle = Math.atan2(-nhH, nhW) // true top-right corner for this node's actual dimensions
                setNodeViewProp(hn.id, 'nodeEmojis', [...cur, { id: crypto.randomUUID(), emoji: value, type, angle: cornerAngle }])
              }}
              onRemoveEmojiById={eid => handleRemoveEmoji(hn.id, eid)}
              customEmojis={customEmojis}
              onAddCustomEmoji={(name, src) => addCustomEmoji(name, src)}
              onRemoveCustomEmoji={eid => removeCustomEmoji(eid)}
              onAddNodeImage={(src, w0, h0, position) => {
                const cur = (views.find(v => v.id === activeViewId)?.nodeProps?.[hn.id]?.nodeImages) || []
                const { halfW: nhW, halfH: nhH } = shapeDims(vp.shape || 'circle', NODE_R * (vp.scale || 1), hs.label, Math.max(9, Math.round(12 * (vp.scale || 1))), vp.labelWidth)
                const cornerAngle = Math.atan2(-nhH, nhW)
                setNodeViewProp(hn.id, 'nodeImages', [...cur, { id: crypto.randomUUID(), src, w0, h0, scale: 1, position, angle: cornerAngle }])
              }}
              onSetNodeImagePosition={(imId, position) => handleSetNodeImagePosition(hn.id, imId, position)}
              onRemoveNodeImageById={imId => handleRemoveNodeImage(hn.id, imId)}
              onWheel={e => svgRef.current?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }))}
              nodeId={hn.id}
              propertyDefs={storePropertyDefs}
              nodeProps={hs.props || {}}
              onSetNodeProp={(propId, value) => setNodeProp(hn.id, propId, value)}
              onAddPropertyDef={type => addPropertyDef(type)}
              onAddSelectOption={(propId, name, color) => addSelectOption(propId, name, color)}
              onTogglePropChip={propId => { const d = storePropertyDefs.find(p => p.id === propId); updatePropertyDef(propId, { showChip: !d?.showChip }) }}
              depthExpand={depthExpand?.nodeId === hn.id ? depthExpand : null}
              onSetDepthExpand={setDepthExpand}
              maxExpandRadius={maxExpandRadius}
            />
          )
          if (floatDock) {
            return (
              <Rnd position={{ x: floatRect.x, y: floatRect.y }} size={{ width: 'auto', height: 'auto' }}
                dragHandleClassName="pim-tb-drag" enableResizing={false} bounds="parent" style={{ zIndex: 30 }}
                onDragStop={(e, d) => setFloatRect({ x: d.x, y: d.y })}>
                {toolbar}
              </Rnd>
            )
          }
          return (
            <>
              <div onMouseDown={close} onContextMenu={e => e.preventDefault()}
                style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
              {toolbar}
            </>
          )
        })()}

        {/* Photo menu / image toolbar — hidden while cropping a single image */}
        {/* Photo menu — opens on right-click, anchored at the cursor */}
        {/* Rich-text formatting toolbar — above the single selected Text element (screen space). */}
        {(() => {
          if (selectedImageIds.size !== 1) return null
          const tid = [...selectedImageIds][0]
          const timg = (activeView?.images || []).find(i => i.id === tid)
          if (!timg || timg.type !== 'text') return null
          const left = T.x + (timg.x || 0) * T.k
          const top = T.y + ((timg.y || 0) - (timg.height || 0) / 2) * T.k - 8
          return <TextFormatToolbar left={left} top={top} box={timg} onBoxStyle={patch => updateImage(tid, patch)} />
        })()}

        {photoMenu && !cropImageId && (<>
          <div onMouseDown={() => setPhotoMenu(null)} onContextMenu={e => { e.preventDefault(); setPhotoMenu(null) }}
            style={{ position: 'fixed', inset: 0, zIndex: 24 }} />
          <ImageToolbar
            images={activeView?.images || []}
            selectedImageIds={selectedImageIds}
            anchor={photoMenu}
            onGroup={() => groupImages([...selectedImageIds])}
            onUngroup={() => ungroupImages([...selectedImageIds])}
            onReorderImage={(id, dir) => reorderImage(id, dir)}
            onSetBlur={v => selectedImageIds.forEach(id => updateImage(id, { blur: v }))}
            onSetEdgeBlur={v => selectedImageIds.forEach(id => updateImage(id, { edgeBlur: v }))}
            onSetVideoOpt={(id, patch) => updateImage(id, patch)}
            onCrop={() => { const id = photoMenu.imageId || [...selectedImageIds][0]; if (id) { setCropImageId(id); setDrilledImageId(id); setSelectedImageIds(new Set([id])) } setPhotoMenu(null) }}
            onCopyImage={img => { setPhotoMenu(null); copyImageToClipboard(img?.src) }}
            onSetEffect={patch => selectedImageIds.forEach(id => updateImage(id, patch))}
            onResetEffects={() => selectedImageIds.forEach(id => updateImage(id, { opacity: 1, tint: null }))}
            onAlign={anchor => {
              const imgs = activeView?.images || []
              const updates = alignImages(imgs, selectedImageIds, anchor)
              updates.forEach(({ id, x, y }) => updateImage(id, { x, y }))
            }}
            onDistribute={axis => {
              const imgs = activeView?.images || []
              const updates = distributeImages(imgs, selectedImageIds, axis)
              updates.forEach(u => updateImage(u.id, u))
            }}
            onDuplicate={() => {
              pushUndo()
              const ids = selectedImageIds.size ? [...selectedImageIds] : (photoMenu.imageId ? [photoMenu.imageId] : [])
              const newIds = ids.map(id => duplicateImage(id)).filter(Boolean)
              if (newIds.length) setSelectedImageIds(new Set(newIds))
              setPhotoMenu(null)
            }}
            onDelete={() => { setConfirmDeleteImages([...selectedImageIds]); setPhotoMenu(null) }}
          />
        </>)}

        {/* Delete node confirm — anchored above (or below) the node itself, not screen-centered. */}
        {confirmDelete && (() => {
          const dn = simNodesRef.current.find(n => n.id === confirmDelete)
          const W = svgRef.current?.clientWidth || 800
          const rawX = dn ? T.x + (dn.x || 0) * T.k : W / 2
          const rawY = dn ? T.y + (dn.y || 0) * T.k : (svgRef.current?.clientHeight || 600) / 2
          const px = Math.max(150, Math.min(W - 150, rawX))
          const below = rawY < 150
          // Dependents: descendant nodes (child tables/nodes) + attached media (photos/videos).
          const desc = []; const seen = new Set([confirmDelete]); const q = [confirmDelete]
          while (q.length) { const c = q.shift(); storeEdges.forEach(ed => { if (ed.source === c && !seen.has(ed.target)) { seen.add(ed.target); desc.push(ed.target); q.push(ed.target) } }) }
          const idset = new Set([confirmDelete, ...desc])
          const attached = (activeView?.images || []).filter(i => i.attachedTo && idset.has(i.attachedTo))
          const depCount = desc.length + attached.length
          const delOnly = () => { pushUndo(); (activeView?.images || []).forEach(i => { if (i.attachedTo === confirmDelete) updateImage(i.id, { attachedTo: null }) }); deleteNode(confirmDelete); setSelected(null); setConfirmDelete(null) }
          const delDeep = () => { pushUndo(); if (attached.length) deleteImages(attached.map(m => m.id)); idset.forEach(id => deleteNode(id)); setSelected(null); setConfirmDelete(null) }
          return (
            <div style={confirmStyle} onClick={() => setConfirmDelete(null)}>
              <div style={{ ...confirmBox, position: 'absolute', left: px, top: rawY, transform: below ? 'translate(-50%, 28px)' : 'translate(-50%, calc(-100% - 28px))' }} onClick={e => e.stopPropagation()}>
                <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
                  Delete <strong>{dn?.label || 'this node'}</strong>{depCount > 0 ? <> — it has <strong>{depCount}</strong> child item{depCount === 1 ? '' : 's'}.</> : <> from <strong>all views</strong>?</>}
                </div>
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap: 'wrap' }}>
                  <button style={confirmCancelBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                  {depCount > 0 ? (<>
                    <button style={confirmCancelBtn} onClick={delOnly}>Node only</button>
                    <button style={confirmOkBtn} onClick={delDeep}>Delete with children</button>
                  </>) : (
                    <button style={confirmOkBtn} onClick={delOnly}>Delete</button>
                  )}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Delete multiple selected nodes confirm — anchored over the item(s), not screen-centered. */}
        {confirmDeleteNodes && (() => {
          const pts = confirmDeleteNodes.map(id => simNodesRef.current.find(n => n.id === id)).filter(Boolean)
          const W = svgRef.current?.clientWidth || 800, Hh = svgRef.current?.clientHeight || 600
          const avgX = pts.length ? pts.reduce((a, n) => a + (n.x || 0), 0) / pts.length : 0
          const avgY = pts.length ? pts.reduce((a, n) => a + (n.y || 0), 0) / pts.length : 0
          const rawX = pts.length ? T.x + avgX * T.k : W / 2
          const rawY = pts.length ? T.y + avgY * T.k : Hh / 2
          const px = Math.max(150, Math.min(W - 150, rawX))
          const below = rawY < 150
          return (
            <div style={confirmStyle} onClick={() => setConfirmDeleteNodes(null)}>
              <div style={{ ...confirmBox, position: 'absolute', left: px, top: rawY, transform: below ? 'translate(-50%, 28px)' : 'translate(-50%, calc(-100% - 28px))' }} onClick={e => e.stopPropagation()}>
                <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
                  Delete <strong>{confirmDeleteNodes.length}</strong> item{confirmDeleteNodes.length === 1 ? '' : 's'} from <strong>all views</strong>?
                </div>
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                  <button style={confirmCancelBtn} onClick={() => setConfirmDeleteNodes(null)}>Cancel</button>
                  <button style={confirmOkBtn} onClick={() => {
                    pushUndo()
                    confirmDeleteNodes.forEach(id => deleteNode(id))
                    setSelectedNodeIds(new Set()); setSelected(null); setConfirmDeleteNodes(null)
                  }}>Delete</button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Node search / spotlight (Cmd/Ctrl+K or "/") */}
        {searchOpen && (() => {
          const q = searchQuery.trim().toLowerCase()
          const results = storeNodes
            .filter(n => !q || (n.label || '').toLowerCase().includes(q))
            .slice(0, 50)
          const idx = Math.min(searchIdx, Math.max(0, results.length - 1))
          return (
            <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh' }}
              onClick={() => { setSearchOpen(false); setSearchQuery('') }}>
              <div style={{ width: 'min(520px, 92vw)', background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', overflow: 'hidden' }}
                onClick={e => e.stopPropagation()}>
                <input autoFocus ref={searchInputRef} value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setSearchIdx(0) }}
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIdx(i => Math.min(i + 1, results.length - 1)) }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIdx(i => Math.max(i - 1, 0)) }
                    else if (e.key === 'Enter') { e.preventDefault(); if (results[idx]) goToNode(results[idx].id) }
                    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSearchOpen(false); setSearchQuery('') }
                  }}
                  placeholder="Search nodes…"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '14px 16px', fontSize: 16, background: 'transparent', border: 'none', borderBottom: '1px solid #2d3a6a', color: '#e6ebff', outline: 'none' }} />
                <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
                  {results.length === 0 && <div style={{ padding: '14px 16px', color: '#7080a0' }}>No matching nodes</div>}
                  {results.map((n, i) => {
                    const hidden = viewNodeProps[n.id]?.visible === false
                    return (
                      <div key={n.id}
                        onMouseEnter={() => setSearchIdx(i)}
                        onClick={() => goToNode(n.id)}
                        style={{ padding: '10px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10, background: i === idx ? '#1e2547' : 'transparent', color: '#c5d0ff' }}>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.label || '(untitled)'}</span>
                        {hidden && <span style={{ color: '#8090b8', fontSize: 12, flexShrink: 0 }}>hidden</span>}
                      </div>
                    )
                  })}
                </div>
                <div style={{ padding: '8px 16px', borderTop: '1px solid #2d3a6a', color: '#7080a0', fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <span>↑↓ navigate · ↵ go · esc close</span>
                  <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Delete image confirm — anchored over the photo/video itself. */}
        {confirmDeleteImage && (() => {
          const im = (activeView?.images || []).find(i => i.id === confirmDeleteImage)
          const W = svgRef.current?.clientWidth || 800, Hh = svgRef.current?.clientHeight || 600
          const rawX = im ? T.x + (im.x || 0) * T.k : W / 2
          const rawY = im ? T.y + (im.y || 0) * T.k : Hh / 2
          const px = Math.max(150, Math.min(W - 150, rawX))
          const below = rawY < 150
          const label = im?.type === 'video' ? 'video' : 'photo'
          return (
            <div style={confirmStyle} onClick={() => setConfirmDeleteImage(null)}>
              <div style={{ ...confirmBox, position: 'absolute', left: px, top: rawY, transform: below ? 'translate(-50%, 28px)' : 'translate(-50%, calc(-100% - 28px))' }} onClick={e => e.stopPropagation()}>
                <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>Delete this {label}?</div>
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                  <button style={confirmCancelBtn} onClick={() => setConfirmDeleteImage(null)}>Cancel</button>
                  <button style={confirmOkBtn} onClick={() => { deleteImage(confirmDeleteImage); setSelectedImageIds(new Set()); setConfirmDeleteImage(null) }}>Delete</button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Delete images confirm (multi-select) — anchored over the selection's center. */}
        {confirmDeleteImages && (() => {
          const sel = confirmDeleteImages.map(id => (activeView?.images || []).find(i => i.id === id)).filter(Boolean)
          const W = svgRef.current?.clientWidth || 800, Hh = svgRef.current?.clientHeight || 600
          const avgX = sel.length ? sel.reduce((a, i) => a + (i.x || 0), 0) / sel.length : 0
          const avgY = sel.length ? sel.reduce((a, i) => a + (i.y || 0), 0) / sel.length : 0
          const rawX = sel.length ? T.x + avgX * T.k : W / 2
          const rawY = sel.length ? T.y + avgY * T.k : Hh / 2
          const px = Math.max(150, Math.min(W - 150, rawX))
          const below = rawY < 150
          return (
            <div style={confirmStyle} onClick={() => setConfirmDeleteImages(null)}>
              <div style={{ ...confirmBox, position: 'absolute', left: px, top: rawY, transform: below ? 'translate(-50%, 28px)' : 'translate(-50%, calc(-100% - 28px))' }} onClick={e => e.stopPropagation()}>
                <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
                  Delete {confirmDeleteImages.length} item{confirmDeleteImages.length > 1 ? 's' : ''}?
                </div>
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                  <button style={confirmCancelBtn} onClick={() => setConfirmDeleteImages(null)}>Cancel</button>
                  <button style={confirmOkBtn} onClick={() => {
                    deleteImages(confirmDeleteImages)
                    setSelectedImageIds(new Set()); setDrilledImageId(null)
                    setConfirmDeleteImages(null)
                  }}>Delete</button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Save status */}
        {!isPresenting && <div style={{ position:'absolute', top:10, left:12, pointerEvents:'none' }}>
          <span style={{ fontSize:'0.68rem', color: saveStatus==='error'?'#f87171':saveStatus==='saving'?'#5b6af0':'#2a3a2a' }}>
            {saveStatus==='error'?'● save failed':saveStatus==='saving'?'● saving…':'● saved'}
          </span>
        </div>}

        {/* AI assistant command bar (Cmd/Ctrl+J or the ✦ button) */}
        {!readOnly && !isPresenting && (
          <CommandBar getSelection={() => ({
            selectedNodeId: selected?.type === 'node' ? selected.id : null,
            selectedNodeIds: [...selectedNodeIds],
          })} />
        )}

        {/* "Edit builds" entry chip — shown when a frame is selected and we're not already editing it. */}
        {!readOnly && !isPresenting && timelineFrameId == null && selected?.type === 'node' && getVP(selected.id).shape === 'frame' && (
          <button onClick={() => enterTimeline(selected.id)}
            style={{ position: 'absolute', left: 12, bottom: 64, zIndex: 40, background: '#12122a', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: 12.5, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', gap: 7 }}>
            🎬 Stages{(getVP(selected.id).stages?.length) ? ` · ${getVP(selected.id).stages.length}` : ''}
          </button>
        )}

        {/* Container options — shown when a container node is selected. */}
        {!readOnly && !isPresenting && selected?.type === 'node' && getVP(selected.id).shape === 'container' && (() => {
          const cid = selected.id, cvp = getVP(cid)
          const links = cvp.containerLinks || 'grandmother'
          const dragOut = cvp.containerDragOut || 'springback'
          const cshape = cvp.containerShape || 'rect'
          const seg = (label, active, onClick) => (
            <button onClick={onClick} style={{ flex: 1, background: active ? '#1e2547' : '#12122a', border: `1px solid ${active ? '#5b6af0' : '#2d3a6a'}`, color: active ? '#dbe4ff' : '#9fb0e8', borderRadius: 6, padding: '4px 6px', cursor: 'pointer', fontSize: 11 }}>{label}</button>
          )
          return (
            <div onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
              style={{ position: 'absolute', left: 12, bottom: 64, zIndex: 40, width: 210, background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.55)', padding: 10, fontFamily: '-apple-system, sans-serif', color: '#c5d0ff', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700 }}>⬭ Container</div>
              <div><div style={{ fontSize: 10.5, color: '#9fb0e8', marginBottom: 3 }}>Shape</div>
                <div style={{ display: 'flex', gap: 5 }}>{seg('○ Circle', cshape === 'circle', () => setNodeViewProp(cid, 'containerShape', 'circle'))}{seg('▢ Rect', cshape === 'rect', () => setNodeViewProp(cid, 'containerShape', 'rect'))}</div></div>
              <div><div style={{ fontSize: 10.5, color: '#9fb0e8', marginBottom: 3 }}>Child links point to</div>
                <div style={{ display: 'flex', gap: 5 }}>
                  {seg('Grandmother', links === 'grandmother', () => { setNodeViewProp(cid, 'containerLinks', 'grandmother'); rerouteContainerLinks(cid, 'grandmother') })}
                  {seg('Container', links === 'container', () => { setNodeViewProp(cid, 'containerLinks', 'container'); rerouteContainerLinks(cid, 'container') })}
                </div></div>
              <div><div style={{ fontSize: 10.5, color: '#9fb0e8', marginBottom: 3 }}>When a node is pulled out</div>
                <div style={{ display: 'flex', gap: 5 }}>
                  {seg('Spring back', dragOut === 'springback', () => setNodeViewProp(cid, 'containerDragOut', 'springback'))}
                  {seg('Release', dragOut === 'release', () => setNodeViewProp(cid, 'containerDragOut', 'release'))}
                </div></div>
              <button onClick={() => revertContainer(cid)} style={{ background: '#12122a', border: '1px solid #3a2d4a', color: '#c8a0e0', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 11 }}>↩ Turn back into node</button>
            </div>
          )
        })()}

        {/* On-frame timeline strip — screen-space, pinned under the frame and clamped to the viewport. */}
        {!readOnly && !isPresenting && timelineFrameId != null && (() => {
          const fnode = simNodesRef.current.find(n => n.id === timelineFrameId)
          if (!fnode) return null
          const fvp = getVP(timelineFrameId)
          const fr = NODE_R * (fvp.scale || 1)
          const { halfW: dHW, halfH: dHH } = shapeDims('frame', fr)
          const halfW = fvp.frameHalfW ?? dHW, halfH = fvp.frameHalfH ?? dHH
          // Pin the strip ALONG the frame's bottom edge — width = frame width, tracking pan/zoom. It sits
          // just below the border. Positions are viewport-relative (position:fixed), so we add the SVG's
          // on-screen offset (the canvas starts to the right of the sidebar). (No viewport clamping — you
          // edit stages zoomed into the frame.)
          const box = svgRef.current?.getBoundingClientRect() || { left: 0, top: 0 }
          const left = box.left + T.x + ((fnode.x || 0) - halfW) * T.k
          const width = 2 * halfW * T.k
          const top = box.top + T.y + ((fnode.y || 0) + halfH) * T.k + 6
          const stages = fvp.stages || []
          return (
            <FrameTimeline
              rect={{ left, top, width }} frameName={storeNodeById[timelineFrameId]?.label}
              stages={stages} currentIdx={timelineStageIdx} playing={timelinePlaying} recordPulse={timelineRecordPulse}
              onGoto={gotoTimelineStage} onAdd={addTimelineStage} onDelete={deleteTimelineStage}
              onRename={renameTimelineStage} onReorder={reorderTimelineStage} onSetAdvance={setTimelineStageAdvance} onSetSpeed={setTimelineStageSpeed}
              onSetCam={(i) => { const r = currentViewRect(); if (r) setTimelineStageCam(i, r) }}
              onFrameSelectionCam={(i) => { const r = selectionCamRect(); if (r) setTimelineStageCam(i, r); else alert('Select one or more elements on the canvas first, then use Frame selection.') }}
              onGotoCam={gotoTimelineStageCam} onClearCam={(i) => setTimelineStageCam(i, undefined)}
              onSetFade={setTimelineStageFade}
              onPlay={startTimelinePlay} onStop={stopTimelinePlay} onNext={timelinePlayNext}
              onExit={exitTimeline} onRefit={() => { const fn = simNodesRef.current.find(n => n.id === timelineFrameId); if (fn) zoomToFrame(fn, true) }}
            />
          )
        })()}




        {/* Back arrow -- drill exit, top-left canvas */}
        {drillRoot && !isPresenting && (
          <button onClick={exitDrill}
            style={{ position:'absolute', top:'0.75rem', left:'0.75rem', zIndex:20, background:'rgba(18,18,42,0.9)', border:'1px solid #2d3a6a', color:'#c5d0ff', borderRadius:7, padding:'6px 12px', cursor:'pointer', fontSize:'1rem', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', gap:6 }}>
            {'←'} Back
          </button>
        )}

        {/* Property filter — top-right. (In-graph "Organize" packing was removed: it couldn't coexist
            with the live force simulation. The standalone "pack" tab does deterministic circle packing.) */}
        {!isPresenting && (storePropertyDefs.length > 0 || propFilter) && (
          <div style={{ position:'absolute', top:'0.75rem', right:'0.75rem', zIndex:20, display:'flex', gap:8 }}>
            <FilterControl defs={storePropertyDefs} filter={propFilter} onSet={setPropFilter} onClear={() => setPropFilter(null)} />
          </div>
        )}

        {/* Build timestamp â€" bottom right */}
        {!isPresenting && <div style={{ position:'absolute', bottom:'0.5rem', right:'0.75rem', zIndex:20, fontSize:'0.62rem', color:'#7080a0', fontFamily:'monospace', userSelect:'none' }}>
          {new Date(__BUILD_TIME__).toISOString().slice(0,16).replace('T',' ')}
        </div>}


        {/* Frame color picker â€" shows when a frame is selected */}
        {!isPresenting && selected?.type === 'node' && (() => {
          const sn = simNodesRef.current.find(n => n.id === selected.id)
          if (!sn) return null
          const fvp = getVP(selected.id)
          if (fvp.shape !== 'frame') return null
          const { halfH: defHH } = shapeDims('frame', NODE_R * (fvp.scale || 1))
          const halfH = fvp.frameHalfH ?? defHH
          const rawX = T.x + (sn.x || 0) * T.k
          const rawY = T.y + ((sn.y || 0) + halfH) * T.k + 14
          const canvasW = svgRef.current?.clientWidth || 800
          const canvasH = svgRef.current?.clientHeight || 600
          const pickerW = 184, pickerH = 84
          const screenX = Math.max(pickerW / 2 + 4, Math.min(canvasW - pickerW / 2 - 4, rawX))
          const screenY = Math.min(canvasH - pickerH - 4, rawY)
          return (
            <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
              style={{ position:'absolute', left: screenX, top: screenY, transform:'translateX(-50%)',
                background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8, padding:'6px 8px',
                display:'flex', flexDirection:'column', gap:4, zIndex:25, boxShadow:'0 4px 16px rgba(0,0,0,0.6)' }}>
              <div style={{ fontSize:'0.63rem', color:'#8090b8', letterSpacing:'0.06em' }}>FILL</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:4, width:188 }}>
                <div title="No fill" onClick={() => setNodeViewProp(selected.id, 'fillColor', 'none')}
                  style={{ width:20, height:20, borderRadius:3, cursor:'pointer',
                    backgroundImage: 'linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%)',
                    backgroundSize: '6px 6px', backgroundPosition: '0 0, 3px 3px',
                    border: (fvp.fillColor==='none'||!fvp.fillColor) ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.12)' }} />
                {COLOR_PALETTE.map(c => (
                  <div key={c} onClick={() => setNodeViewProp(selected.id, 'fillColor', c)}
                    style={{ width:20, height:20, borderRadius:3, background:c, cursor:'pointer',
                      border: fvp.fillColor===c ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.12)' }} />
                ))}
              </div>
            </div>
          )
        })()}

        {/* Keyboard-nav focus indicator: shows current zoom depth + closeness while arrow-navigating */}
        {navHud && !isPresenting && (
          <div style={{ position:'absolute', bottom:24, left:'50%', transform:'translateX(-50%)', pointerEvents:'none', zIndex:28,
            background:'rgba(10,10,24,0.9)', border:'1px solid #2d3a6a', borderRadius:10, padding:'7px 14px',
            display:'flex', gap:12, alignItems:'center', boxShadow:'0 4px 18px rgba(0,0,0,0.55)', fontFamily:'-apple-system, sans-serif' }}>
            <span style={{ color:'#c5d0ff', fontSize:'0.8rem', fontWeight:600 }}>
              {navHud.depth === 0 ? 'Focus: node only' : `Focus: +${navHud.depth} level${navHud.depth > 1 ? 's' : ''} down`}
            </span>
            <span style={{ color:'#7c8cff', fontSize:'0.76rem' }}>zoom {navHud.zoom.toFixed(1)}×</span>
            <span style={{ color:'#7080a0', fontSize:'0.64rem', lineHeight:1.2 }}>Shift+↑↓ depth · +/− closeness</span>
          </div>
        )}

        {/* Presentation controls overlay */}
        {isPresenting && (
          <div style={{ position:'absolute', inset:0, pointerEvents:'none', zIndex:30 }}>
            {/* Bottom nav bar */}
            <div style={{ position:'absolute', bottom:24, left:'50%', transform:'translateX(-50%)', pointerEvents:'all',
              background:'rgba(10,10,24,0.88)', border:'1px solid #2d3a6a', borderRadius:10,
              padding:'8px 18px', display:'flex', gap:14, alignItems:'center', boxShadow:'0 4px 20px rgba(0,0,0,0.6)' }}>
              <button style={canvasBtnStyle} onClick={() => advanceBuild(-1)} title="Previous build (←)">← Prev</button>
              <span style={{ color:'#88b4e8', fontSize:'0.85rem', minWidth:60, textAlign:'center', lineHeight:1.25 }}>
                <div>Slide {(presentingSlideIdx ?? 0) + 1} / {slideSimNodes.length}</div>
                {(() => { const st = slideSimNodes[presentingSlideIdx ?? 0]; const ns = st ? (getVP(st.id).stages || []).length : 0; return ns > 1 ? <div style={{ fontSize:'0.68rem', color:'#7c8cff' }}>build {presentStageIdx + 1} / {ns}</div> : null })()}
              </span>
              <button style={canvasBtnStyle} onClick={() => advanceBuild(1)} title="Next build (→ / Space)">Next →</button>
              <span style={{ color:'#5a6a9a', fontSize:'0.62rem', maxWidth:120, lineHeight:1.2 }}>↑↓ jump slides</span>
            </div>
          </div>
        )}
      </div>

      {/* Draw palette (tabbed with Slides via the right rail; mutually exclusive) */}
      {!isPresenting && showDraw && (
        <DrawPalette palette={COLOR_PALETTE} hasFrames={frameSimNodes.length > 0}
          onStartDrag={startDrawDrag}
          onSwitchSlides={() => { setShowDraw(false); setShowSlideSidebar(true) }}
          onClose={() => setShowDraw(false)} />
      )}

      {/* Slide sidebar â€" hidden while presenting */}
      {!isPresenting && showSlideSidebar && frameSimNodes.length > 0 && (
        <SlideSidebar
          slideSimNodes={slideSimNodes}
          allSimNodes={simNodesRef.current}
          frameSimNodes={frameSimNodes}
          viewImages={activeView?.images || []}
          slideIds={slideIds}
          slideshows={slideshows}
          activeSlideshowId={activeSlideshowId}
          presentingSlideIdx={presentingSlideIdx}
          getVP={getVP}
          zoomToFrame={zoomToFrame}
          setPresentingSlideIdx={setPresentingSlideIdx}
          onPresent={(idx) => presentSlide(idx, 'fwd')}
          removeSlide={removeSlide}
          addSlide={addSlide}
          reorderSlides={reorderSlides}
          addSlideshow={addSlideshow}
          deleteSlideshow={deleteSlideshow}
          renameSlideshow={renameSlideshow}
          setActiveSlideshowId={setActiveSlideshowId}
          setSlideBgColor={setSlideBgColor}
          onAddSlideFromView={makeCurrentViewAsSlide}
          onUpdateSlideToView={updateSlideToView}
          onClose={() => setShowSlideSidebar(false)}
          canvasBtnStyle={canvasBtnStyle}
        />
      )}

      {/* Right rail — thin tab strip to toggle Draw / Slides (mutually exclusive panels sit to its left) */}
      {!isPresenting && (
        <div style={{ width: 30, flexShrink: 0, borderLeft: '1px solid #1e1e2e', background: '#0b0b16', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 8 }}>
          <div title="Draw" onClick={() => { setShowDraw(v => !v); setShowSlideSidebar(false) }}
            style={{ width: 24, height: 30, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 15,
              background: showDraw ? '#2d3a6a' : 'transparent', border: `1px solid ${showDraw ? '#5b6af0' : 'transparent'}` }}>✏️</div>
          {frameSimNodes.length > 0 && (
            <div title="Slides" onClick={() => { setShowSlideSidebar(v => !v); setShowDraw(false) }}
              style={{ width: 24, height: 30, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 14,
                background: showSlideSidebar ? '#2d3a6a' : 'transparent', border: `1px solid ${showSlideSidebar ? '#5b6af0' : 'transparent'}` }}>🎞️</div>
          )}
        </div>
      )}

      {/* Ghost that follows the cursor while dragging a palette item onto the canvas */}
      {dragDraw && (
        <div style={{ position: 'fixed', left: dragDraw.ghost.x + 8, top: dragDraw.ghost.y + 8, zIndex: 100, pointerEvents: 'none',
          fontSize: dragDraw.kind === 'emoji' ? 26 : 14, color: '#c5d0ff', background: '#16162a', border: '1px solid #3a4a8a', borderRadius: 6, padding: '2px 7px', boxShadow: '0 4px 14px rgba(0,0,0,0.5)' }}>
          {dragDraw.kind === 'emoji' ? dragDraw.defaults.emoji : dragDraw.kind === 'text' ? 'Text' : dragDraw.kind === 'shape' ? (dragDraw.defaults.shape) : dragDraw.kind}
        </div>
      )}

      {/* Alt-drag: after duplicating a node that has children, ask whether to also copy the children */}
      {dupChildrenPrompt && (<>
        <div onMouseDown={() => setDupChildrenPrompt(null)} style={{ position: 'fixed', inset: 0, zIndex: 59 }} />
        <div style={{ position: 'fixed', left: Math.max(120, Math.min(window.innerWidth - 120, dupChildrenPrompt.cx)), top: Math.max(20, Math.min(window.innerHeight - 80, dupChildrenPrompt.cy)), zIndex: 60, transform: 'translate(-50%, 10px)', background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 9, padding: '9px 11px', boxShadow: '0 10px 28px rgba(0,0,0,0.65)' }}>
          <div style={{ fontSize: 12.5, color: '#c5d0ff', marginBottom: 7, whiteSpace: 'nowrap' }}>This node has children — copy them too?</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setDupChildrenPrompt(null)} style={{ background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: '5px 10px' }}>Just this node</button>
            <button onClick={() => { pushUndo(); copyChildrenInto(dupChildrenPrompt.srcId, dupChildrenPrompt.newId); setDupChildrenPrompt(null) }} style={{ background: '#2e3a72', border: '1px solid #5b6af0', color: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: '5px 10px', fontWeight: 600 }}>With children</button>
          </div>
        </div>
      </>)}

      {notePopupId && (() => {
        const n = simNodesRef.current.find(x => x.id === notePopupId)
        const sn = storeNodes.find(x => x.id === notePopupId)
        if (!n || !sn || !svgRef.current) return null
        const rect = svgRef.current.getBoundingClientRect()
        const T = zoomTransformRef.current
        let cx = rect.left + T.x + (n.x || 0) * T.k
        let cy = rect.top + T.y + (n.y || 0) * T.k + 18
        cx = Math.max(10, Math.min(window.innerWidth - 290, cx))
        cy = Math.max(10, Math.min(window.innerHeight - 200, cy))
        return (
          <>
            <div onMouseDown={() => setNotePopupId(null)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
            <div onMouseDown={e => e.stopPropagation()} style={{ position: 'fixed', left: cx, top: cy, zIndex: 45, width: 270, background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 10, padding: 10, boxShadow: '0 12px 34px rgba(0,0,0,0.65)' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ color: '#c5d0ff', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📝 {sn.label || 'Untitled'}</span>
                <button onClick={() => setNotePopupId(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: 13 }}>✕</button>
              </div>
              <textarea autoFocus value={sn.notes || ''} onChange={e => updateNotes(notePopupId, e.target.value)} placeholder="Notes…"
                style={{ width: '100%', minHeight: 96, resize: 'vertical', background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 7, padding: '7px 9px', fontSize: 12.5, lineHeight: 1.45, outline: 'none', boxSizing: 'border-box', fontFamily: '-apple-system, sans-serif' }} />
            </div>
          </>
        )
      })()}

      {wgDialog && (
        <WordgenDialog
          nodeLabel={storeNodes.find(n => n.id === wgDialog.nodeId)?.label || ''}
          mode={wgDialog.mode}
          busy={wgBusy}
          err={wgErr}
          onRun={(count, modifier, seeds, assess) => runWordgen(wgDialog.nodeId, wgDialog.mode, { count, modifier, seeds, assess })}
          onClose={() => { if (!wgBusy) { setWgDialog(null); setWgErr(null) } }}
        />
      )}

      {genDialog && (() => {
        const gn = storeNodes.find(n => n.id === genDialog.nodeId)
        if (!gn) return null
        const parentOf = {}; storeEdges.forEach(e => { parentOf[e.target] = e.source })
        const kids = storeEdges.filter(e => e.source === gn.id).map(e => storeNodes.find(n => n.id === e.target)?.label).filter(Boolean)
        const parentLabel = parentOf[gn.id] ? storeNodes.find(n => n.id === parentOf[gn.id])?.label : null
        const nearby = [...(parentLabel ? [parentLabel] : []), ...kids].slice(0, 12)
        return (
          <GenerateDialog
            node={gn}
            nearby={nearby}
            onApply={(mode, text, opts) => applyGenerated(genDialog.nodeId, mode, text, opts)}
            onClose={() => setGenDialog(null)}
          />
        )
      })()}

      {autoStyleNode && (() => {
        const an = storeNodes.find(n => n.id === autoStyleNode)
        if (!an) return null
        return (
          <AutoStyleDialog
            node={an}
            styles={storeStyles || []}
            propertyDefs={storePropertyDefs || []}
            onSave={(autoStyle) => { setNodeMeta(autoStyleNode, { autoStyle }); setAutoStyleNode(null) }}
            onClose={() => setAutoStyleNode(null)}
          />
        )
      })()}

      {ytssInspectorId && (() => {
        const yn = storeNodes.find(n => n.id === ytssInspectorId)
        if (!yn?.ytss) return null
        const sn = simNodesRef.current.find(n => n.id === ytssInspectorId)
        const T = zoomTransformRef.current, rect = svgRef.current?.getBoundingClientRect()
        let anchor = null
        if (sn && rect) {
          const halfW = 240 * (getVP(ytssInspectorId).ytssScale || 1)
          anchor = { x: rect.left + T.x + (sn.x + halfW) * T.k + 14, y: rect.top + T.y + sn.y * T.k }
        }
        return (
          <YTSlideshowInspector
            clips={yn.ytss.clips || []}
            anchor={anchor}
            preview={{
              select: (i) => { setYtssIdxMap(m => ({ ...m, [ytssInspectorId]: i })) },   // idx change → node shows+plays it
              seek: t => ytssHandlesRef.current[ytssInspectorId]?.seekTo?.(t),
              play: () => ytssHandlesRef.current[ytssInspectorId]?.play?.(),
              pause: () => ytssHandlesRef.current[ytssInspectorId]?.pause?.(),
              setRate: r => ytssHandlesRef.current[ytssInspectorId]?.setRate?.(r),
              mute: () => ytssHandlesRef.current[ytssInspectorId]?.mute?.(),
              unMute: () => ytssHandlesRef.current[ytssInspectorId]?.unMute?.(),
              time: () => ytssHandlesRef.current[ytssInspectorId]?.time?.() || 0,
              duration: () => ytssHandlesRef.current[ytssInspectorId]?.duration?.() || 0,
            }}
            fullscreen={!!yn.ytss.fullscreen}
            onToggleFullscreen={v => setYtssProp(ytssInspectorId, { fullscreen: v })}
            onChange={clips => setYtssClips(ytssInspectorId, clips)}
            onUpload={() => uploadSlideToYtss(ytssInspectorId)}
            onExtract={clip => { const s = simNodesRef.current.find(n => n.id === ytssInspectorId); extractSlide(clip, (s?.x || 0) + 340, (s?.y || 0)) }}
            onClose={() => { ytssHandlesRef.current[ytssInspectorId]?.pause?.(); setYtssInspectorId(null) }}
          />
        )
      })()}

      {ytssFullscreenId && (() => {
        const yn = storeNodes.find(n => n.id === ytssFullscreenId)
        const clips = yn?.ytss?.clips || []
        if (!clips.length) return null
        const start = Math.max(0, Math.min(ytssIdxMapRef.current[ytssFullscreenId] || 0, clips.length - 1))
        return (
          <YTFullscreenPlayer clips={clips} startIndex={start}
            onExit={() => {
              const id = ytssFullscreenId
              setYtssFullscreenId(null)
              setYtssIdxMap(m => ({ ...m, [id]: 0 }))   // returning replays from the beginning
              // Back to the node on the canvas: focus + zoom it (not "entered", so the next arrow resumes nav).
              navFocusRef.current = id; navOutRef.current = 0; useGraphStore.getState().setNavFocusNodeId(id)
              zoomNavRef.current?.(id, navDepthRef.current)
            }} />
        )
      })()}

      {videoEdit && (() => {
        const T = zoomTransformRef.current, rect = svgRef.current?.getBoundingClientRect()
        let video = null, onPatch = null, anchor = null
        let onPatchPoster = null
        if (videoEdit.kind === 'image') {
          const img = (activeView?.images || []).find(i => i.id === videoEdit.id)
          if (!img || img.type !== 'video') return null
          video = { youtubeId: img.youtubeId, videoKind: img.videoKind, src: img.src, start: img.start, end: img.end, autoplayOnZoom: img.autoplayOnZoom, autoplayOnSlide: img.autoplayOnSlide, muted: img.muted, speed: img.speed, captions: img.captions, loop: img.loop, poster: img.poster, cuts: img.cuts, keepPlaying: img.keepPlaying }
          onPatch = patch => updateImage(videoEdit.id, patch)
          onPatchPoster = url => updateImage(videoEdit.id, { poster: url })
          if (rect) anchor = { x: rect.left + T.x + (img.x + (img.width || 0) / 2) * T.k + 14, y: rect.top + T.y + img.y * T.k }
        } else {
          const node = storeNodes.find(n => n.id === videoEdit.id)
          const m = node?.media; if (!m || m.kind !== 'video') return null
          const meta = node.meta || {}
          video = { youtubeId: m.youtubeId, videoKind: m.videoKind, src: m.src, start: m.start, end: m.end, autoplayOnZoom: meta.autoplayOnZoom, autoplayOnSlide: meta.autoplayOnSlide, muted: m.muted, speed: m.speed, captions: m.captions, loop: m.loop, poster: m.poster, cuts: m.cuts, keepPlaying: m.keepPlaying }
          onPatchPoster = url => updateNodeMedia(videoEdit.id, { poster: url })
          onPatch = patch => {
            const metaKeys = ['autoplayOnZoom', 'autoplayOnSlide']
            const mp = {}, dp = {}
            Object.entries(patch).forEach(([k, v]) => { (metaKeys.includes(k) ? mp : dp)[k] = v })
            if (Object.keys(mp).length) setNodeMeta(videoEdit.id, mp)
            if (Object.keys(dp).length) updateNodeMedia(videoEdit.id, dp)
          }
          const sn = simNodesRef.current.find(x => x.id === videoEdit.id)
          if (sn && rect) anchor = { x: rect.left + T.x + (sn.x + (m.width || 0) / 2) * T.k + 14, y: rect.top + T.y + sn.y * T.k }
        }
        videoEditSelRef.current = { start: video?.start || 0, end: video?.end || 0 }
        return (<>
          {/* Click-away backdrop — clicking anywhere outside the panel closes it. */}
          <div onMouseDown={() => setVideoEdit(null)} style={{ position: 'fixed', inset: 0, zIndex: 499 }} />
          <YTVideoOptions video={video} anchor={anchor} onPatch={onPatch}
            onClose={() => setVideoEdit(null)}
            onScrubTime={videoScrubTo}
            onLoopSel={videoLoopSel}
            onPreviewPause={() => { clearVideoEndLoop(); videoPreviewHandleRef.current?.pause?.() }}
            getDuration={() => videoPreviewHandleRef.current?.duration?.() || 0}
            getTime={() => videoPreviewHandleRef.current?.time?.() || 0}
            onUploadPoster={() => {
              const inp = document.createElement('input')
              inp.type = 'file'; inp.accept = 'image/*'
              inp.onchange = () => {
                const f = inp.files?.[0]; if (!f) return
                const reader = new FileReader()
                reader.onload = () => {
                  onPatchPoster?.(reader.result)   // instant local preview
                  uploadImageDataUrl(reader.result, projectId).then(url => { if (url && url !== reader.result) onPatchPoster?.(url) })
                }
                reader.readAsDataURL(f)
              }
              inp.click()
            }}
            onResetPoster={() => onPatchPoster?.(null)}
            onPlayFullscreen={() => setVideoFullscreen({ youtubeId: video.youtubeId, start: video.start || 0, end: video.end || 0, muted: video.muted === true, speed: video.speed || 1, captions: video.captions === true })} />
        </>)
      })()}

      {videoFullscreen?.youtubeId && (
        <YTFullscreenPlayer clips={[{ id: 'one', youtubeId: videoFullscreen.youtubeId, start: videoFullscreen.start, end: videoFullscreen.end, speed: videoFullscreen.speed || 1, trigger: 'click' }]}
          startIndex={0} muted={videoFullscreen.muted} captions={videoFullscreen.captions === true} onExit={() => setVideoFullscreen(null)} />
      )}
    </div>
  )
}

// Stops native mousedown/wheel from bubbling to D3's SVG listeners (React synthetic events can't do this)
function ThreeDWrapper({ children, onFocus }) {
  const ref = useRef()
  const onFocusRef = useRef(onFocus)
  useEffect(() => { onFocusRef.current = onFocus })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onMD = e => { e.stopPropagation(); onFocusRef.current?.() }
    const onWH = e => { e.stopPropagation(); e.preventDefault() }
    el.addEventListener('mousedown', onMD)
    el.addEventListener('wheel', onWH, { passive: false })
    return () => {
      el.removeEventListener('mousedown', onMD)
      el.removeEventListener('wheel', onWH)
    }
  }, []) // eslint-disable-line
  return <div ref={ref} data-3d-canvas="true" style={{ width:'100%', height:'100%', borderRadius:12, overflow:'hidden' }}>{children}</div>
}

// â"€â"€â"€ SlideSidebar â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function SlideSidebar({ slideSimNodes, allSimNodes, frameSimNodes, viewImages, slideIds, slideshows, activeSlideshowId, presentingSlideIdx, getVP, zoomToFrame, setPresentingSlideIdx, onPresent, removeSlide, addSlide, reorderSlides, addSlideshow, deleteSlideshow, renameSlideshow, setActiveSlideshowId, setSlideBgColor, onAddSlideFromView, onUpdateSlideToView, onClose, canvasBtnStyle }) {
  const activeSlideshow = slideshows.find(ss => ss.id === activeSlideshowId) || slideshows[0]
  const activeSlideBgColors = activeSlideshow?.slideBgColors || {}
  const [dragIdx, setDragIdx] = useState(null)
  const [dropIdx, setDropIdx] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [currentIdx, setCurrentIdx] = useState(0)   // which slide "Update slide" targets (last clicked / presented)
  const containerRef = useRef()
  const [slideMenu, setSlideMenu] = useState(null)   // { frameId, label, x, y } — right-click options
  const activeIdx = presentingSlideIdx ?? currentIdx

  // Whole-card drag with click threshold â€" click zooms, drag reorders
  const handleCardMouseDown = (e, idx) => {
    if (e.button !== 0 || e.target.closest('[data-remove]')) return
    e.preventDefault()
    const startX = e.clientX, startY = e.clientY
    let dragging = false

    const onMove = me => {
      if (!dragging) {
        if (Math.abs(me.clientX - startX) < 5 && Math.abs(me.clientY - startY) < 5) return
        dragging = true
        setDragIdx(idx)
      }
      if (!containerRef.current) return
      const items = containerRef.current.querySelectorAll('[data-slide-idx]')
      let insertBefore = items.length
      items.forEach(el => {
        const rect = el.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        if (me.clientY < mid) {
          const idx = parseInt(el.dataset.slideIdx)
          if (idx < insertBefore) insertBefore = idx
        }
      })
      setDropIdx(insertBefore)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!dragging) {
        setCurrentIdx(idx)
        zoomToFrame(slideSimNodes[idx])
        setDragIdx(null); setDropIdx(null)
        return
      }
      const fromIdx = idx
      setDragIdx(null)
      setDropIdx(dp => {
        if (dp !== null && dp !== fromIdx) {
          const newOrder = slideSimNodes.map(n => n.id)
          const [moved] = newOrder.splice(fromIdx, 1)
          newOrder.splice(dp, 0, moved)
          reorderSlides(newOrder)
        }
        return null
      })
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const nonSlideFrames = frameSimNodes.filter(n => !slideIds.includes(n.id))

  return (
    <div ref={containerRef} data-slide-sidebar="1" onMouseDown={e => e.stopPropagation()}
      style={{ width: 190, flexShrink: 0, borderLeft: '1px solid #1e1e2e', background: '#0d0d1a',
        overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '8px 8px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6, paddingBottom:6, borderBottom:'1px solid #1e1e2e' }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'#8090b8', cursor:'pointer', fontSize:14, padding:'0 2px', lineHeight:1 }}>‹</button>
          <span style={{ fontSize:'0.68rem', color:'#8090b8', letterSpacing:'0.08em', fontWeight:600 }}>SLIDES</span>
        </div>
        <button style={{ ...canvasBtnStyle, fontSize:'0.7rem', padding:'2px 6px' }}
          onClick={() => { if (slideSimNodes.length) (onPresent ? onPresent(0) : (setPresentingSlideIdx(0), zoomToFrame(slideSimNodes[0]))) }}
          disabled={!slideSimNodes.length}>▶ Present</button>
      </div>

      {/* Slideshow selector */}
      <div style={{ marginBottom:10 }}>
        {slideshows.map(ss => (
          renamingId === ss.id ? (
            <input key={ss.id} autoFocus value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={() => { renameSlideshow(ss.id, renameVal || ss.name); setRenamingId(null) }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { renameSlideshow(ss.id, renameVal || ss.name); setRenamingId(null) } e.stopPropagation() }}
              style={{ width:'100%', fontSize:'0.75rem', background:'#0d1020', border:'1px solid #4a5280', borderRadius:4, color:'#e0e4ff', padding:'3px 7px', outline:'none', marginBottom:2, boxSizing:'border-box' }}
            />
          ) : (
            <div key={ss.id} style={{ display:'flex', alignItems:'center', marginBottom:2 }}>
              <button
                onDoubleClick={() => { setRenamingId(ss.id); setRenameVal(ss.name) }}
                onClick={() => setActiveSlideshowId(ss.id)}
                style={{ flex:1, textAlign:'left', fontSize:'0.75rem', padding:'4px 8px', borderRadius:4, border:'none',
                  background: ss.id === activeSlideshowId ? '#222a5a' : 'transparent',
                  color: ss.id === activeSlideshowId ? '#ffffff' : '#9aa0c8',
                  cursor:'pointer', fontWeight: ss.id === activeSlideshowId ? 600 : 400 }}>
                {ss.name}
              </button>
              {slideshows.length > 1 && (
                <button onClick={() => deleteSlideshow(ss.id)} title="Delete slideshow"
                  style={{ background:'transparent', border:'none', color:'#6070a0', cursor:'pointer', fontSize:14, padding:'0 4px', lineHeight:1, flexShrink:0 }}>×</button>
              )}
            </div>
          )
        ))}
        <button onClick={() => addSlideshow()}
          style={{ fontSize:'0.72rem', padding:'3px 8px', borderRadius:4, border:'1px solid #3a4878', background:'transparent', color:'#9aa0c8', cursor:'pointer', marginTop:2 }}>+ new slideshow</button>
      </div>

      {/* Capture / update slides from the current viewport — sits with the slideshow controls. */}
      <div style={{ display:'flex', gap:6, marginBottom:10 }}>
        <button onClick={() => onAddSlideFromView?.()} title="Add a new slide framing the current view"
          style={{ flex:1, fontSize:'0.72rem', padding:'5px 6px', borderRadius:5, border:'1px solid #3a4a8a', background:'#1a1f4a', color:'#c5d0ff', cursor:'pointer', whiteSpace:'nowrap' }}>＋ From view</button>
        <button onClick={() => { const fn = slideSimNodes[activeIdx]; if (fn) onUpdateSlideToView?.(fn.id) }} disabled={!slideSimNodes[activeIdx]}
          title="Resize the current slide to match the current view"
          style={{ flex:1, fontSize:'0.72rem', padding:'5px 6px', borderRadius:5, border:'1px solid #2a3358', background:'transparent', color:'#c5d0ff', cursor:'pointer', whiteSpace:'nowrap', opacity: slideSimNodes[activeIdx] ? 1 : 0.5 }}>⟳ Update slide</button>
      </div>

      {slideSimNodes.map((fn, i) => {
        const fvp = getVP(fn.id)
        const fr = NODE_R * (fvp.scale || 1)
        const { halfW: defHW, halfH: defHH } = shapeDims('frame', fr)
        const halfW = fvp.frameHalfW ?? defHW, halfH = fvp.frameHalfH ?? defHH
        const TW = 162, TH = Math.max(60, Math.round(TW * halfH / halfW))
        const nodesInFrame = allSimNodes.filter(n => {
          if (n.id === fn.id) return false
          const nvp = getVP(n.id)
          if (nvp.shape === 'frame') return false
          return nvp.containedIn === fn.id ||
            (Math.abs((n.x||0) - (fn.x||0)) < halfW && Math.abs((n.y||0) - (fn.y||0)) < halfH)
        })
        const showLineBefore = dragIdx !== null && dropIdx === i && dragIdx !== i
        return [
          showLineBefore && <div key={`line-${i}`} style={{ height:2, background:'#5b6af0', borderRadius:1, margin:'2px 0 6px' }} />,
          <div key={fn.id} data-slide-idx={i}
            onMouseDown={e => handleCardMouseDown(e, i)}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setSlideMenu({ frameId: fn.id, label: fn.label || 'Frame', x: e.clientX, y: e.clientY }) }}
            style={{ marginBottom: 8, position: 'relative', cursor: 'grab', userSelect: 'none',
              opacity: dragIdx === i ? 0.4 : 1,
              borderRadius: 6 }}>
            <div style={{ borderRadius:6, overflow:'hidden',
              border: activeIdx === i ? '2px solid #5b6af0' : '1.5px solid #1e2a3a',
              background: '#111827' }}>
              <svg width={TW} height={TH}
                viewBox={`${-halfW} ${-halfH} ${halfW*2} ${halfH*2}`}
                style={{ display:'block', background: fvp.fillColor || '#1a2a4a', opacity:0.92, pointerEvents:'none' }}>
                {viewImages.map(img => {
                  const relX = (img.x || 0) - (fn.x || 0)
                  const relY = (img.y || 0) - (fn.y || 0)
                  if (Math.abs(relX) > halfW + img.width / 2 || Math.abs(relY) > halfH + img.height / 2) return null
                  return (
                    <g key={img.id} transform={`translate(${relX},${relY}) rotate(${img.rotation || 0})`}>
                      {img.bgColor && <rect x={-img.width/2} y={-img.height/2} width={img.width} height={img.height} fill={img.bgColor} rx={2} />}
                      <image href={img.src} x={-img.width/2} y={-img.height/2} width={img.width} height={img.height} />
                    </g>
                  )
                })}
                {nodesInFrame.map(n => {
                  const nvp = getVP(n.id)
                  const nr = NODE_R * (nvp.scale || 1)
                  const nFs = Math.max(9, Math.round(12 * (nvp.scale || 1)))
                  const { halfW: nW, halfH: nH } = shapeDims(nvp.shape || 'circle', nr, n.label || '', nFs, nvp.labelWidth)
                  return (
                    <g key={n.id} transform={`translate(${(n.x||0)-(fn.x||0)},${(n.y||0)-(fn.y||0)})`}>
                      <ShapeBody shape={nvp.shape||'circle'} halfW={nW} halfH={nH} r={nr}
                        fill={nvp.fillColor || '#12122a'} stroke="none" strokeWidth={0} />
                      {nvp.shape !== 'frame' && (
                        <text textAnchor="middle" dominantBaseline="central"
                          fontSize={Math.max(5, nFs * 0.8)}
                          fill={nvp.textColor || '#fff'}
                          style={{ userSelect:'none', pointerEvents:'none' }}>
                          {(n.label || '').split('\n')[0].slice(0, 24)}
                        </text>
                      )}
                    </g>
                  )
                })}
              </svg>
              <div style={{ display:'flex', alignItems:'center', padding:'3px 6px 3px 8px', gap:4 }}>
                <span style={{ flex:1, fontSize:'0.72rem', color:'#88b4e8', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                  {i + 1}. {fn.label || 'Frame'}
                </span>
                <button data-remove="true" title="Remove from slideshow"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); removeSlide(fn.id) }}
                  style={{ background:'transparent', border:'none', color:'#f87171', cursor:'pointer', fontSize:13, padding:'0 2px', lineHeight:1, flexShrink:0 }}>×</button>
              </div>
            </div>
          </div>
        ]
      })}
      {dragIdx !== null && dropIdx === slideSimNodes.length && (
        <div style={{ height:2, background:'#5b6af0', borderRadius:1, margin:'2px 0' }} />
      )}

      {nonSlideFrames.length > 0 && (
        <div style={{ marginTop:8, paddingTop:8, borderTop:'1px solid #1e2a3a' }}>
          <div style={{ fontSize:'0.62rem', color:'#7080a0', marginBottom:6, letterSpacing:'0.06em' }}>NOT IN SLIDESHOW</div>
          {nonSlideFrames.map(fn => (
            <div key={fn.id} style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
              <span style={{ flex:1, fontSize:'0.72rem', color:'#8090b8', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                {fn.label || 'Frame'}
              </span>
              <button onClick={() => addSlide(fn.id)}
                style={{ background:'transparent', border:'1px solid #2d3a6a', color:'#5b6af0', cursor:'pointer', fontSize:'0.68rem', padding:'1px 5px', borderRadius:3, flexShrink:0 }}>+ Add</button>
            </div>
          ))}
        </div>
      )}

      {/* Right-click slide options (background color, present, remove) */}
      {slideMenu && (
        <>
          <div onMouseDown={() => setSlideMenu(null)} onContextMenu={e => { e.preventDefault(); setSlideMenu(null) }}
            style={{ position:'fixed', inset:0, zIndex:9998 }} />
          <div onMouseDown={e => e.stopPropagation()}
            style={{ position:'fixed', left: Math.min(slideMenu.x, window.innerWidth - 224), top: Math.min(slideMenu.y, window.innerHeight - 190),
              zIndex:9999, background:'#12122a', border:'1px solid #2d3a6a', borderRadius:8, padding:'6px 0', minWidth:206,
              boxShadow:'0 12px 34px rgba(0,0,0,0.55)' }}>
            <div style={{ padding:'2px 12px 8px', fontSize:'0.72rem', color:'#8090b8', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{slideMenu.label}</div>
            <div style={{ padding:'2px 12px 8px', display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
              <span style={{ fontSize:'0.62rem', color:'#7080a0', width:'100%', marginBottom:3 }}>Background</span>
              <div title="Default" onClick={() => setSlideBgColor(activeSlideshowId, slideMenu.frameId, null)}
                style={{ width:16, height:16, borderRadius:3, cursor:'pointer',
                  backgroundImage:'linear-gradient(45deg,#444 25%,transparent 25%,transparent 75%,#444 75%),linear-gradient(45deg,#444 25%,transparent 25%,transparent 75%,#444 75%)',
                  backgroundSize:'6px 6px', backgroundPosition:'0 0,3px 3px',
                  border: !activeSlideBgColors[slideMenu.frameId] ? '2px solid #fff' : '1px solid #3a4a6a' }} />
              {SLIDE_BG_COLORS.map(c => (
                <div key={c} onClick={() => setSlideBgColor(activeSlideshowId, slideMenu.frameId, c)}
                  style={{ width:16, height:16, borderRadius:3, background:c, cursor:'pointer',
                    border: activeSlideBgColors[slideMenu.frameId]===c ? '2px solid #5b6af0' : '1px solid rgba(255,255,255,0.2)' }} />
              ))}
            </div>
            <div style={{ borderTop:'1px solid #1e2a3a', margin:'4px 0' }} />
            <div onClick={() => { const idx = slideSimNodes.findIndex(s => s.id === slideMenu.frameId); if (idx >= 0) { onPresent ? onPresent(idx) : (setPresentingSlideIdx(idx), zoomToFrame(slideSimNodes[idx])) } setSlideMenu(null) }}
              onMouseEnter={e => e.currentTarget.style.background='#1e2547'} onMouseLeave={e => e.currentTarget.style.background='transparent'}
              style={{ padding:'8px 12px', cursor:'pointer', color:'#c5d0ff', fontSize:'0.8rem' }}>Present from here</div>
            <div onClick={() => { removeSlide(slideMenu.frameId); setSlideMenu(null) }}
              onMouseEnter={e => e.currentTarget.style.background='#1e2547'} onMouseLeave={e => e.currentTarget.style.background='transparent'}
              style={{ padding:'8px 12px', cursor:'pointer', color:'#f87171', fontSize:'0.8rem' }}>Remove from slideshow</div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── FlowchartPanel ───────────────────────────────────────────────────────────
// A docked text editor (Mermaid-flavored) that two-way syncs with the graph: the canvas' visible
// nodes/edges are serialized to text; editing the text (debounced) parses and applies back, matching
// nodes by their stable `flowId` so hand-placed positions survive. New nodes get an auto-layout.
function FlowchartPanel({ visibleIds, centerXY, onApplied, onClose }) {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const ensureFlowIds = useGraphStore(s => s.ensureFlowIds)
  const applyFlowchart = useGraphStore(s => s.applyFlowchart)
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  const focusedRef = useRef(false)
  const applyingRef = useRef(false)
  const debRef = useRef(null)

  const regen = useCallback(() => {
    ensureFlowIds([...visibleIds])
    const st = useGraphStore.getState()
    const props = st.views.find(v => v.id === st.activeViewId)?.nodeProps || {}
    const byId = Object.fromEntries(st.nodes.map(n => [n.id, n]))
    const vis = st.nodes.filter(n => visibleIds.has(n.id))
    const flowIdOf = id => byId[id]?.flowId || id
    const shapeOf = id => props[id]?.shape || 'rect'
    const visEdges = st.edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target))
    setText(graphToMermaid(vis, visEdges, shapeOf, flowIdOf))
  }, [visibleIds, ensureFlowIds])

  useEffect(() => { regen() }, [])                                             // eslint-disable-line
  useEffect(() => { if (!focusedRef.current && !applyingRef.current) regen() }, [nodes, edges]) // eslint-disable-line

  const applyNow = (val) => {
    try {
      const parsed = parseMermaid(val)
      const [cx, cy] = (centerXY && centerXY()) || [0, 0]
      const layout = layeredLayout(parsed.nodes, parsed.edges, { ox: cx, oy: cy })
      applyingRef.current = true
      applyFlowchart(parsed, layout)
      onApplied && onApplied()
      setStatus(`${parsed.nodes.length} nodes · ${parsed.edges.length} links`)
      setTimeout(() => { applyingRef.current = false }, 60)
    } catch (e) { setStatus('Parse error: ' + (e?.message || e)) }
  }

  const onEdit = (val) => {
    setText(val)
    if (debRef.current) clearTimeout(debRef.current)
    debRef.current = setTimeout(() => applyNow(val), 550)
  }

  return (
    <div style={fcp.panel} onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
      <div style={fcp.header}>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#c5d0ff' }}>⤳ Flowchart</span>
        <span style={{ fontSize: 11, color: '#8090b8', marginLeft: 'auto' }}>text ⇄ graph</span>
        <button style={fcp.close} onClick={onClose} title="Close">×</button>
      </div>
      <div style={{ fontSize: 11, color: '#8090b8', padding: '0 12px 6px', lineHeight: 1.45 }}>
        Edit as text — the graph updates live. Shapes:&nbsp;
        <code style={fcp.code}>[ ]</code> box · <code style={fcp.code}>( )</code> round · <code style={fcp.code}>{'{ }'}</code> decision · <code style={fcp.code}>([ ])</code> start/end. Links: <code style={fcp.code}>A --&gt; B</code>, <code style={fcp.code}>A --&gt;|yes| B</code>.
      </div>
      <textarea value={text}
        onFocus={() => { focusedRef.current = true }}
        onBlur={() => { focusedRef.current = false }}
        onChange={e => onEdit(e.target.value)}
        onKeyDown={e => e.stopPropagation()}
        spellCheck={false} style={fcp.textarea} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px' }}>
        <button style={fcp.apply} onClick={() => applyNow(text)}>Apply</button>
        <button style={fcp.ghost} onClick={regen} title="Rebuild the text from the current graph">Sync from graph</button>
        <span style={{ fontSize: 11, color: status.startsWith('Parse') ? '#f0a0a0' : '#8090b8', marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</span>
      </div>
    </div>
  )
}

const fcp = {
  panel: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 360, maxWidth: '46vw', zIndex: 36, background: '#12122a', borderLeft: '1px solid #2d3a6a', boxShadow: '-8px 0 28px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, sans-serif' },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid #23233e' },
  close: { background: 'transparent', border: 'none', color: '#c5d0ff', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' },
  code: { background: '#1c1c38', color: '#c5d0ff', borderRadius: 4, padding: '1px 4px', fontSize: 10.5, fontFamily: 'ui-monospace, monospace' },
  textarea: { flex: 1, margin: '0 12px', background: '#0d0d1e', border: '1px solid #2a3358', borderRadius: 8, color: '#dbe4ff', fontSize: 12.5, fontFamily: 'ui-monospace, SFMono-Regular, monospace', lineHeight: 1.55, padding: 10, outline: 'none', resize: 'none', whiteSpace: 'pre' },
  apply: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: '5px 12px' },
  ghost: { background: 'transparent', border: '1px solid #2a3358', color: '#aab4dd', borderRadius: 6, cursor: 'pointer', fontSize: 12, padding: '5px 10px' },
}

// ─── ExportDialog ───────────────────────────────────────────────────────────
// Quick export: outline and/or graph, to PDF (print dialog) or Word (.doc), for the selected views.
// The graph image is only produced for the ACTIVE view (the one with a live layout).
function ExportDialog({ projectName, nodes, edges, views, activeViewId, captureGraphSVG, onClose }) {
  const [doOutline, setDoOutline] = useState(true)
  const [doGraph, setDoGraph] = useState(true)
  const [format, setFormat] = useState('pdf')
  const [viewIds, setViewIds] = useState(() => new Set([activeViewId]))
  const [busy, setBusy] = useState(false)
  const toggleView = (id) => setViewIds(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s })

  const run = async () => {
    if (!doOutline && !doGraph) return
    setBusy(true)
    try {
      const chosen = views.filter(v => viewIds.has(v.id))
      const cap = doGraph ? captureGraphSVG() : null
      const graphPng = cap ? await svgToPng(cap.svg, cap.width, cap.height, cap.bg) : null
      const sections = chosen.map(v => {
        const hidden = new Set(Object.entries(v.nodeProps || {}).filter(([, p]) => p?.visible === false).map(([id]) => id))
        return {
          viewName: v.name || 'View',
          outline: doOutline ? outlineHTML(nodes, edges, hidden) : null,
          graphPng: (doGraph && v.id === activeViewId) ? graphPng : null,
        }
      })
      const html = buildDocumentHTML(projectName || 'PIM export', sections, format === 'word')
      if (format === 'word') downloadDoc(html, (projectName || 'pim'))
      else printPDF(html)
      onClose()
    } finally { setBusy(false) }
  }

  const row = { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem', color: '#c5d0ff', cursor: 'pointer', padding: '3px 0' }
  const multipleWithGraph = doGraph && viewIds.size > 1
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(4,5,14,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 'min(380px,92vw)', maxHeight: '84vh', overflow: 'auto', background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 12, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ color: '#e8eeff', fontSize: '1rem', fontWeight: 700 }}>Export</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#8090b8', fontSize: '1.3rem', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ fontSize: '0.66rem', letterSpacing: '0.08em', color: '#7080a0', margin: '4px 0 4px' }}>INCLUDE</div>
        <label style={row}><input type="checkbox" checked={doOutline} onChange={e => setDoOutline(e.target.checked)} /> Outline (nested list)</label>
        <label style={row}><input type="checkbox" checked={doGraph} onChange={e => setDoGraph(e.target.checked)} /> Graph (image of the current layout)</label>

        <div style={{ fontSize: '0.66rem', letterSpacing: '0.08em', color: '#7080a0', margin: '12px 0 4px' }}>FORMAT</div>
        <label style={row}><input type="radio" name="fmt" checked={format === 'pdf'} onChange={() => setFormat('pdf')} /> PDF (print dialog)</label>
        <label style={row}><input type="radio" name="fmt" checked={format === 'word'} onChange={() => setFormat('word')} /> Word (.doc)</label>

        <div style={{ fontSize: '0.66rem', letterSpacing: '0.08em', color: '#7080a0', margin: '12px 0 4px' }}>VIEWS</div>
        <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid #23233e', borderRadius: 6, padding: '4px 8px' }}>
          {views.map(v => (
            <label key={v.id} style={row}>
              <input type="checkbox" checked={viewIds.has(v.id)} onChange={() => toggleView(v.id)} />
              {v.name || 'View'}{v.id === activeViewId && <span style={{ color: '#8ecbff', fontSize: '0.68rem' }}>active</span>}
            </label>
          ))}
        </div>
        {multipleWithGraph && <div style={{ fontSize: '0.72rem', color: '#f0b090', marginTop: 6 }}>The graph image is exported for the active view only; other views export the outline.</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ background: '#181834', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '7px 14px', fontSize: '0.82rem', cursor: 'pointer' }}>Cancel</button>
          <button onClick={run} disabled={busy || (!doOutline && !doGraph) || viewIds.size === 0}
            style={{ background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 7, padding: '7px 16px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', opacity: (busy || (!doOutline && !doGraph) || viewIds.size === 0) ? 0.5 : 1 }}>
            {busy ? 'Exporting…' : format === 'word' ? 'Download .doc' : 'Open PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── EffectsOverlay ─────────────────────────────────────────────────────────
// Animates a node's children as a group. Runs its OWN RAF and re-renders only itself, so continuous
// effects don't re-render the whole graph. Highlights are drawn in the child's ACTUAL shape.
function shapeOutline(shape, hw, hh, props) {
  if (shape === 'ellipse') return <ellipse rx={hw} ry={hh} {...props} />
  if (shape === 'rect') return <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} {...props} />
  if (shape === 'roundrect') return <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} rx={Math.min(hw, hh) * 0.4} {...props} />
  if (shape === 'diamond') return <polygon points={`0,${-hh} ${hw},0 0,${hh} ${-hw},0`} {...props} />
  return <circle r={Math.max(hw, hh)} {...props} />
}
function EffectsOverlay({ parents, simNodesRef, getVP, visibleRef, childrenOrdered, scheduleRender }) {
  const [, setT] = useState(0)
  const orbitPrevRef = useRef(new Set())
  const hasOrbit = parents.some(p => p.fx?.type === 'orbit')
  useEffect(() => {
    let raf
    const loop = () => { setT(x => (x + 1) % 1e6); if (hasOrbit) scheduleRender(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [hasOrbit, scheduleRender])
  // Release any orbit pins when the overlay unmounts (effect turned off / node deleted).
  useEffect(() => () => { orbitPrevRef.current.forEach(id => { const n = simNodesRef.current.find(x => x.id === id); if (n) { n.fx = null; n.fy = null } }) }, []) // eslint-disable-line

  const now = performance.now() / 1000
  const nodeMap = new Map(simNodesRef.current.map(n => [n.id, n]))
  const hls = []
  const orbitNow = new Set()
  const colOf = (fx, cid, i, n) => {
    if (fx.color === 'rainbow') return `hsl(${Math.round((now * 90 + i * 360 / Math.max(1, n)) % 360)},90%,60%)`
    if (fx.color === 'own') { const f = getVP(cid).fillColor; return (f && f !== 'none' && f !== 'transparent') ? f : '#ffd24d' }
    return fx.color || '#ffd24d'
  }
  parents.forEach(({ id: pid, fx }) => {
    if (!fx) return
    const parent = nodeMap.get(pid)
    const kids = (childrenOrdered[pid] || []).filter(cid => visibleRef.current.has(cid) && nodeMap.has(cid))
    const n = kids.length
    const speed = fx.speed ?? (fx.speedSec ? Math.max(0.2, 0.5 / fx.speedSec) : 1)   // higher = faster (back-compat)
    const rev = fx.dir === 'rev'
    const add = (cid, color, intensity, scale, style) => { const node = nodeMap.get(cid); if (node) hls.push({ key: pid + cid, node, color, intensity: Math.max(0, Math.min(1, intensity)), scale, style: style || 'halo' }) }
    if (fx.type === 'orbit' || fx.type === 'orbitwave') {
      const radius = fx.radius ?? 130
      const wob = fx.type === 'orbitwave' ? (fx.amp ?? 0.4) : 0   // far/close radial shift as they circle
      const dir = rev ? -1 : 1
      kids.forEach((cid, i) => { const node = nodeMap.get(cid); if (!node || !parent) return
        const ang = dir * now * speed * 0.9 + i / n * Math.PI * 2
        const rr = radius * (1 + wob * Math.sin(now * speed * 1.6 + i * Math.PI))
        node.fx = parent.x + Math.cos(ang) * rr; node.fy = parent.y + Math.sin(ang) * rr; node.x = node.fx; node.y = node.fy; orbitNow.add(cid) })
    } else if (!n) { /* nothing to light */ } else if (fx.type === 'chase') {
      const span = Math.max(1, Math.min(6, fx.span || 1)); const idx0 = Math.floor(now * speed * 2.5) % n; const idx = rev ? ((n - idx0) % n) : idx0
      for (let s = 0; s < span; s++) { const i = ((idx - s) % n + n) % n; add(kids[i], colOf(fx, kids[i], idx, n), 1 - s / (span + 0.001), 1, fx.style) }
    } else if (fx.type === 'colorwave') {
      kids.forEach((cid, i) => add(cid, `hsl(${Math.round((now * speed * 90 + i * 360 / n) % 360)},90%,60%)`, 1, 1, fx.style || 'color'))
    } else if (fx.type === 'pulse') {
      const amp = fx.amp ?? 0.3
      kids.forEach((cid, i) => { const ph = (fx.stagger === false ? 0 : i / n * Math.PI * 2); const sc = 1 + amp * (0.5 + 0.5 * Math.sin(now * speed * 3 + ph)); add(cid, colOf(fx, cid, i, n), 0.85, sc, fx.style || 'halo') })
    } else if (fx.type === 'twinkle') {
      const density = fx.density ?? 0.3
      kids.forEach((cid, i) => { const seed = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1; const v = Math.sin(now * speed * 3 + seed * Math.PI * 2); const thr = 1 - density * 2; if (v > thr) add(cid, colOf(fx, cid, i, n), (v - thr) / (density * 2 || 1), 1, fx.style || 'halo') })
    } else if (fx.type === 'ripple') {
      const depth = {}; const q = [[pid, -1]]; const seen = new Set([pid])
      for (let h = 0; h < q.length; h++) { const [id, d] = q[h]; (childrenOrdered[id] || []).forEach(c => { if (!seen.has(c)) { seen.add(c); depth[c] = d + 1; q.push([c, d + 1]) } }) }
      const vals = Object.values(depth); if (vals.length) { const maxD = Math.max(1, ...vals); let front = (now * speed * 1.5) % (maxD + 1.5); if (rev) front = maxD - front; Object.entries(depth).forEach(([cid, d]) => { if (!visibleRef.current.has(cid) || !nodeMap.has(cid)) return; const dist = Math.abs(d - front); if (dist < 1) add(cid, colOf(fx, cid, d, maxD + 1), 1 - dist, 1, fx.style || 'halo') }) }
    }
  })
  orbitPrevRef.current.forEach(id => { if (!orbitNow.has(id)) { const n = nodeMap.get(id); if (n) { n.fx = null; n.fy = null } } })
  orbitPrevRef.current = orbitNow

  return (
    <g pointerEvents="none">
      {hls.map(({ key, node, color, intensity, scale, style }) => {
        const vp = getVP(node.id)
        const shape = vp.shape || 'circle'
        const baseR = NODE_R * (vp.scale || 1)
        let hw, hh
        if (shape === 'circle' || shape === 'none' || shape === 'frame' || shape === '3d') { hw = baseR; hh = baseR }
        else { const d = shapeDims(shape, baseR, node.label || '', Math.max(9, Math.round(12 * (vp.scale || 1))), vp.labelWidth); hw = d.halfW; hh = d.halfH }
        const m = 5
        return (
          <g key={key} transform={`translate(${node.x || 0},${node.y || 0})`} style={{ transition: 'opacity 0.12s linear' }}>
            {(style === 'color' || style === 'both') && shapeOutline(shape, hw * scale, hh * scale, { fill: color, opacity: intensity * 0.42 })}
            {/* Halo = a blurred, node-shaped glow (the blur feature) that pulses BEHIND the crisp node. */}
            {(style === 'halo' || style === 'both') && shapeOutline(shape, (hw + m) * scale * 1.12, (hh + m) * scale * 1.12, { fill: color, opacity: Math.min(1, intensity * 1.05), style: { filter: `blur(${Math.max(5, Math.round(Math.min(hw, hh) * 0.55))}px)` } })}
          </g>
        )
      })}
    </g>
  )
}

// ─── DepthSlider ────────────────────────────────────────────────────────────
// Thin vertical slider with one notch per level. Top = "All" (fully expanded); drag the thumb DOWN
// to fold deeper levels away. Sets the shared collapse level (graph + outline).
function DepthSlider({ level, max, onChange }) {
  const trackRef = useRef(null)
  const H = Math.max(90, Math.min(280, max * 26))
  const setFromY = (clientY) => {
    const r = trackRef.current?.getBoundingClientRect(); if (!r) return
    const t = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    onChange(Math.round((1 - t) * max))   // top = max (All), bottom = 0
  }
  const onDown = (e) => {
    e.preventDefault(); e.stopPropagation()
    setFromY(e.clientY)
    const mv = ev => setFromY(ev.clientY)
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }
  const thumbPct = (1 - level / max) * 100
  return (
    <div onMouseDown={e => e.stopPropagation()} title="Collapse / expand by level (graph + outline)"
      style={{ position: 'absolute', top: 56, left: 10, zIndex: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', borderRadius: 8, padding: '6px 3px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)', width: 26 }}>
      <span style={{ fontSize: '0.56rem', fontWeight: 700, letterSpacing: '0.04em', color: level >= max ? '#8ecbff' : '#7080a0' }}>All</span>
      <div ref={trackRef} onMouseDown={onDown} style={{ position: 'relative', width: 16, height: H, cursor: 'pointer' }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 3, transform: 'translateX(-50%)', background: '#2a2a44', borderRadius: 2 }} />
        <div style={{ position: 'absolute', left: '50%', top: `${thumbPct}%`, bottom: 0, width: 3, transform: 'translateX(-50%)', background: '#5b6af0', borderRadius: 2 }} />
        {Array.from({ length: max + 1 }, (_, i) => (
          <div key={i} style={{ position: 'absolute', left: '50%', top: `${(1 - i / max) * 100}%`, width: 9, height: 1.5, transform: 'translate(-50%,-50%)', background: '#3a4358' }} />
        ))}
        <div style={{ position: 'absolute', left: '50%', top: `${thumbPct}%`, width: 13, height: 13, transform: 'translate(-50%,-50%)', borderRadius: '50%', background: '#8ea0ff', border: '2px solid #14142a', boxShadow: '0 1px 4px rgba(0,0,0,0.6)' }} />
      </div>
      <span style={{ fontSize: '0.64rem', fontWeight: 700, color: '#c5d0ff' }}>{level >= max ? '·' : level + 1}</span>
    </div>
  )
}

// ─── ListCard ───────────────────────────────────────────────────────────────
// A node rendered as one nested, editable outline card (its subtree hidden on the canvas). Drag the
// header to move the node; a row: click = select, double-click = rename, ▲▼ = reorder among siblings,
// × = delete. Rendered as an HTML card inside a <foreignObject> so inputs/scroll/buttons just work.
// Extract a comparable value from a node for a list sort key ('title' | 'done' | 'tag' | 'prop:<id>').
function listSortValue(sortKey, node, defs) {
  if (!node) return ''
  if (sortKey === 'title') return (node.label || '').toLowerCase()
  if (sortKey === 'done') return node.meta?.done ? 1 : 0
  if (sortKey === 'tag') return (node.meta?.tags || []).slice().sort().join(',')
  if (sortKey.startsWith('prop:')) {
    const pid = sortKey.slice(5), def = (defs || []).find(d => d.id === pid), v = node.props?.[pid]
    if (v == null || v === '') return ''
    if (def?.type === 'select') return ((def.options || []).find(o => o.id === v)?.name || '').toLowerCase()
    if (def?.type === 'multiSelect') return (Array.isArray(v) ? v : []).map(id => (def.options || []).find(o => o.id === id)?.name || '').sort().join(',').toLowerCase()
    if (def?.type === 'number') return Number(v)
    if (def?.type === 'checkbox') return v ? 1 : 0
    return String(v).toLowerCase()   // date, text, url
  }
  return ''
}
// Compare two list-sort values: empties last, numbers numeric, else locale string compare.
function cmpListVals(a, b) {
  const ae = a === '' || a == null, be = b === '' || b == null
  if (ae && be) return 0; if (ae) return 1; if (be) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

function ListCard({ node, rootLabel, rows, fill, selectedId, width, onSetWidth, zoomRef, order, arrangements, topOrder, propertyDefs, onHeaderDown, onSelect, onRename, onDelete, onReorder, onMoveRow, onSetOrder, onAddArrangement, onRenameArrangement, onDeleteArrangement, onReorderArrangement, onExit }) {
  const W = width || 248, rowH = 26, headerH = 32, maxH = 420
  const H = Math.min(maxH, headerH + rows.length * rowH + 12)
  // Drag the right edge to widen (symmetric, handle tracks the cursor). Labels wrap, never truncate.
  const startWidthDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, w0 = W, k = zoomRef?.current?.k || 1
    const move = ev => onSetWidth(Math.max(180, Math.min(680, Math.round(w0 + 2 * (ev.clientX - sx) / k))))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const accent = fill && fill !== 'none' && fill !== 'transparent' ? fill : '#3a4a8a'
  const mode = order?.mode || 'structure'
  const [drag, setDrag] = useState(null)   // { id, label, x, y } while dragging a row
  const [dropT, setDropT] = useState(null) // { rowId, pos:'before'|'after'|'into' }
  const [orderMenu, setOrderMenu] = useState(false)
  const orderLabel = mode === 'structure' ? 'Structure'
    : mode === 'arrangement' ? (arrangements.find(a => a.id === order.arrangementId)?.name || 'Arrangement')
    : (order.sortKey === 'title' ? 'Title' : order.sortKey === 'done' ? 'Done' : order.sortKey === 'tag' ? 'Tags'
        : (propertyDefs.find(d => 'prop:' + d.id === order.sortKey)?.name || 'Sort'))

  // Where would a dragged row land? top zone = before target, bottom = after, middle = into (child).
  const computeDrop = (x, y, dragId) => {
    const el = document.elementFromPoint(x, y)
    const rowEl = el && el.closest('[data-listrow]')
    if (!rowEl) return null
    const rid = rowEl.getAttribute('data-listrow')
    if (rid === dragId) return null
    const r = rowEl.getBoundingClientRect()
    const rel = (y - r.top) / r.height
    return { rowId: rid, pos: rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'into' }
  }
  const startRowDrag = (e, row) => {
    if (e.button !== 0) return
    if (mode === 'sort') return                          // sorted list order is computed — not draggable
    if (mode === 'arrangement' && row.depth !== 0) return // arrangements only reorder the first generation
    e.stopPropagation(); e.preventDefault()
    const ox = e.clientX, oy = e.clientY
    let moved = false
    const noSel = ev => ev.preventDefault()
    const onMove = ev => {
      if (!moved && Math.hypot(ev.clientX - ox, ev.clientY - oy) < 4) return
      if (!moved) { moved = true; document.body.style.userSelect = 'none'; document.addEventListener('selectstart', noSel, true) }
      setDrag({ id: row.id, label: row.label, x: ev.clientX, y: ev.clientY })
      setDropT(computeDrop(ev.clientX, ev.clientY, row.id))
    }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove, true); document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('selectstart', noSel, true); document.body.style.userSelect = ''
      const d = moved ? computeDrop(ev.clientX, ev.clientY, row.id) : null
      setDrag(null); setDropT(null)
      if (!d) return
      const target = rows.find(r => r.id === d.rowId); if (!target) return
      // Arrangement mode: reorder the first-gen order only (no nesting), then save it.
      if (mode === 'arrangement') {
        if (target.depth !== 0) return
        const pos = d.pos === 'into' ? 'after' : d.pos
        const ord = topOrder.filter(id => id !== row.id)
        const ti = ord.indexOf(target.id)
        ord.splice(pos === 'before' ? ti : ti + 1, 0, row.id)
        onReorderArrangement(ord)
        return
      }
      if (d.pos === 'into') { onMoveRow(row.id, target.id, null); return }
      const parentId = target.parentId
      if (d.pos === 'before') { onMoveRow(row.id, parentId, target.id); return }
      // after → insert before the target's next sibling under the same parent (or append)
      const idx = rows.findIndex(r => r.id === target.id)
      let beforeId = null
      for (let i = idx + 1; i < rows.length; i++) {
        if (rows[i].parentId === parentId) { beforeId = rows[i].id; break }
        if (rows[i].depth <= target.depth) break
      }
      onMoveRow(row.id, parentId, beforeId)
    }
    document.addEventListener('mousemove', onMove, true); document.addEventListener('mouseup', onUp, true)
  }

  return (
    <foreignObject data-card="true" x={(node.x || 0) - W / 2} y={(node.y || 0) - H / 2} width={W} height={H} style={{ overflow: 'visible' }}>
      <div style={lc.card(accent)}>
        <div style={lc.header(accent)} onMouseDown={onHeaderDown} onClick={e => { e.stopPropagation(); onSelect(node.id) }}
          onDoubleClick={e => e.stopPropagation()} title="Drag to move · click to select">
          <span style={lc.title}>{rootLabel || '(untitled)'}</span>
          <span style={lc.count}>{rows.length}</span>
          <div style={{ position: 'relative' }} onMouseDown={e => e.stopPropagation()}>
            <button style={lc.exitBtn} title="Order the first-generation items" onClick={e => { e.stopPropagation(); setOrderMenu(o => !o) }}>⇅ {orderLabel} ▾</button>
            {orderMenu && <ListOrderMenu order={order} arrangements={arrangements} propertyDefs={propertyDefs}
              onSetOrder={onSetOrder} onAddArrangement={onAddArrangement} onRenameArrangement={onRenameArrangement} onDeleteArrangement={onDeleteArrangement}
              onClose={() => setOrderMenu(false)} />}
          </div>
          <button style={lc.exitBtn} title="Expand back to nodes" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onExit() }}>⤢</button>
        </div>
        <div style={lc.body} onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
          {rows.length === 0 && <div style={{ color: '#8090b8', fontSize: 12, padding: '6px 10px' }}>No children yet.</div>}
          {(() => { let firstGenN = 0; return rows.map(r => {
            const ordinal = (mode !== 'structure' && r.depth === 0) ? (++firstGenN) : null
            return <ListRow key={r.id} row={r} selected={selectedId === r.id} mode={mode} ordinal={ordinal}
              canDrag={mode === 'structure' || (mode === 'arrangement' && r.depth === 0)}
              dropPos={drag && dropT?.rowId === r.id ? dropT.pos : null} dragging={drag?.id === r.id}
              startRowDrag={startRowDrag} onSelect={onSelect} onRename={onRename} onDelete={onDelete} onReorder={onReorder} />
          }) })()}
        </div>
        {/* right-edge resize handle — a thin bar; drag to widen */}
        <div onMouseDown={startWidthDrag} title="Drag to widen"
          style={{ position: 'absolute', top: headerH + 4, bottom: 6, right: -3, width: 7, cursor: 'ew-resize' }} />
      </div>
      {drag && createPortal(
        <div style={{ position: 'fixed', left: drag.x + 8, top: drag.y + 6, zIndex: 9999, pointerEvents: 'none', maxWidth: 200, background: '#1b2140', border: '1px solid #5b6af0', borderRadius: 6, padding: '3px 8px', fontSize: 12, color: '#dbe4ff', boxShadow: '0 6px 16px rgba(0,0,0,0.6)', fontFamily: '-apple-system, sans-serif' }}>
          {drag.label || '(item)'}
        </div>, document.body)}
    </foreignObject>
  )
}

function ListRow({ row, selected, mode = 'structure', ordinal = null, canDrag = true, dropPos, dragging, startRowDrag, onSelect, onRename, onDelete, onReorder }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.label)
  useEffect(() => { if (!editing) setDraft(row.label) }, [row.label, editing])
  const commit = () => { const t = draft.trim(); onRename(row.id, t || row.label); setEditing(false) }
  return (
    <div data-listrow={row.id}
      style={{ ...lc.row, position: 'relative', cursor: canDrag ? 'grab' : 'pointer', opacity: dragging ? 0.4 : 1, paddingLeft: 8 + row.depth * 14,
        background: dropPos === 'into' ? '#26305e' : (selected ? '#1e2048' : 'transparent') }}
      onMouseDown={e => canDrag && startRowDrag(e, row)}
      onClick={e => { e.stopPropagation(); onSelect(row.id) }}>
      {dropPos === 'before' && <div style={lc.dropLine} />}
      {dropPos === 'after' && <div style={{ ...lc.dropLine, top: 'auto', bottom: -1 }} />}
      {ordinal != null ? <span style={lc.ordinal}>{ordinal}.</span> : <span style={{ color: '#5b6af0', fontSize: 9, flexShrink: 0, lineHeight: 1.9 }}>•</span>}
      {editing ? (
        <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
          onBlur={commit} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit() } if (e.key === 'Escape') setEditing(false) }}
          style={lc.input} />
      ) : (
        <span style={lc.rowLabel} onDoubleClick={e => { e.stopPropagation(); setDraft(row.label); setEditing(true) }} title={row.label}>{row.label}</span>
      )}
      <span style={lc.actions} onMouseDown={e => e.stopPropagation()}>
        {mode === 'structure' && <>
          <button style={lc.rowBtn} title="Move up" onClick={e => { e.stopPropagation(); onReorder(row.parentId, row.id, 'up') }}>▲</button>
          <button style={lc.rowBtn} title="Move down" onClick={e => { e.stopPropagation(); onReorder(row.parentId, row.id, 'down') }}>▼</button>
        </>}
        <button style={{ ...lc.rowBtn, color: '#f87171' }} title="Delete" onClick={e => { e.stopPropagation(); onDelete(row.id) }}>×</button>
      </span>
    </div>
  )
}

// Order menu for a list card: Structure (tree order), named Arrangements (manual), or Sort by a key.
function ListOrderMenu({ order, arrangements, propertyDefs, onSetOrder, onAddArrangement, onRenameArrangement, onDeleteArrangement, onClose }) {
  const [renaming, setRenaming] = useState(null)
  const [nm, setNm] = useState('')
  const mode = order?.mode || 'structure'
  const sortDefs = (propertyDefs || []).filter(d => ['select', 'multiSelect', 'number', 'date', 'text', 'checkbox', 'url'].includes(d.type))
  const item = (label, active, onClick, extra) => (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', fontSize: '0.8rem', color: active ? '#fff' : '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap', background: active ? '#23234a' : 'transparent', borderRadius: 4 }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#1c1c3a' }} onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
      <span style={{ flex: 1 }}>{label}</span>{active && <span style={{ color: '#8ab4ff' }}>✓</span>}{extra}
    </div>
  )
  const setSort = (key) => { const dir = (mode === 'sort' && order.sortKey === key && order.sortDir === 'asc') ? 'desc' : 'asc'; onSetOrder({ mode: 'sort', sortKey: key, sortDir: dir }) }
  const arrow = (key) => mode === 'sort' && order.sortKey === key ? (order.sortDir === 'desc' ? ' ↓' : ' ↑') : ''
  return (<>
    <div onMouseDown={e => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
    <div onMouseDown={e => e.stopPropagation()} style={{ position: 'absolute', top: '110%', right: 0, zIndex: 41, minWidth: 190, maxHeight: 320, overflowY: 'auto', background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 9, padding: '5px 0', boxShadow: '0 10px 28px rgba(0,0,0,0.65)' }}>
      {item('Structure (tree order)', mode === 'structure', () => { onSetOrder({ mode: 'structure' }); onClose() })}
      <div style={{ padding: '4px 10px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' }}>Arrangements</div>
      {arrangements.map(a => renaming === a.id ? (
        <div key={a.id} style={{ display: 'flex', gap: 4, padding: '3px 8px' }} onMouseDown={e => e.stopPropagation()}>
          <input autoFocus value={nm} onChange={e => setNm(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { onRenameArrangement(a.id, nm.trim() || a.name); setRenaming(null) } if (e.key === 'Escape') setRenaming(null) }}
            style={{ flex: 1, background: '#0f0f22', border: '1px solid #5b6af0', borderRadius: 4, color: '#fff', fontSize: 12, padding: '2px 6px', outline: 'none' }} />
        </div>
      ) : (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center' }}>
          {item(a.name, mode === 'arrangement' && order.arrangementId === a.id, () => { onSetOrder({ mode: 'arrangement', arrangementId: a.id }); onClose() })}
          <button title="Rename" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setNm(a.name); setRenaming(a.id) }} style={{ background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: 11, padding: '0 4px' }}>✎</button>
          <button title="Delete" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDeleteArrangement(a.id) }} style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 12, padding: '0 6px 0 2px' }}>×</button>
        </div>
      ))}
      <div onClick={() => { onAddArrangement(''); onClose() }} style={{ padding: '5px 10px', fontSize: '0.8rem', color: '#5b6af0', cursor: 'pointer' }}>＋ New arrangement</div>
      <div style={{ padding: '4px 10px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' }}>Sort by</div>
      {item('Title' + arrow('title'), mode === 'sort' && order.sortKey === 'title', () => setSort('title'))}
      {item('Tags' + arrow('tag'), mode === 'sort' && order.sortKey === 'tag', () => setSort('tag'))}
      {sortDefs.map(d => item(d.name + arrow('prop:' + d.id), mode === 'sort' && order.sortKey === 'prop:' + d.id, () => setSort('prop:' + d.id)))}
      {sortDefs.length === 0 && <div style={{ padding: '2px 10px 6px', fontSize: 11, color: '#8090b8' }}>No properties yet — add some in the Table.</div>}
    </div>
  </>)
}

const lc = {
  card: (accent) => ({ position: 'relative', width: '100%', height: '100%', background: '#14142a', border: `1px solid ${accent}`, borderRadius: 10, boxShadow: '0 6px 24px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', overflow: 'visible', fontFamily: '-apple-system, sans-serif' }),
  header: (accent) => ({ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 8px', background: accent, cursor: 'grab', flexShrink: 0, borderTopLeftRadius: 10, borderTopRightRadius: 10 }),
  title: { fontWeight: 700, fontSize: 13, color: '#fff', flex: 1, overflow: 'hidden', wordBreak: 'break-word', whiteSpace: 'normal', lineHeight: 1.25 },
  count: { fontSize: 11, color: 'rgba(255,255,255,0.85)', fontWeight: 600, flexShrink: 0 },
  exitBtn: { background: 'rgba(0,0,0,0.25)', border: 'none', color: '#fff', borderRadius: 5, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '2px 5px', flexShrink: 0, whiteSpace: 'nowrap' },
  body: { flex: 1, overflowY: 'auto', padding: '4px 0' },
  row: { display: 'flex', alignItems: 'flex-start', gap: 5, padding: '4px 6px', minHeight: 20, cursor: 'pointer' },
  dropLine: { position: 'absolute', left: 6, right: 6, top: -1, height: 2, background: '#7c8cff', borderRadius: 1, boxShadow: '0 0 5px #7c8cff', pointerEvents: 'none', zIndex: 2 },
  rowLabel: { flex: 1, fontSize: 12.5, color: '#dbe4ff', whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.3 },
  ordinal: { color: '#8ab4ff', fontSize: 11, fontWeight: 600, flexShrink: 0, minWidth: 14, textAlign: 'right', lineHeight: 1.5 },
  input: { flex: 1, background: '#0f0f22', border: '1px solid #5b6af0', color: '#fff', borderRadius: 4, padding: '1px 5px', fontSize: 12.5, outline: 'none', minWidth: 0 },
  actions: { display: 'flex', gap: 1, flexShrink: 0 },
  rowBtn: { background: 'transparent', border: 'none', color: '#7080a0', cursor: 'pointer', fontSize: 10, padding: '0 3px', lineHeight: 1 },
}

// ─── KanbanCard ───────────────────────────────────────────────────────────────
// A board node drawn as a kanban: direct children = columns, their children = cards. Rendered in a
// <foreignObject> like the list/table cards. Cards drag between columns (mouse-based, using
// elementFromPoint + data-attrs — the same technique as the outliner; HTML5 DnD is unreliable inside
// foreignObject). A per-board text filter hides non-matching cards (matches label or #tag).
function KanbanCard({ node, title, columns, propId, propertyDefs = [], allTags = [], filters, filterText, grouped = false, groupBy, onSetGroupBy, scale = 1, onSetScale, selectedId, zoomRef, onHeaderDown, onSelect, onRenameBoard, onSetFilterText, onSetFilters, onAddColumn, onRenameColumn, onDeleteColumn, onSetColumnColor, onSetColumnWip, onAddCard, onRenameCard, onSetCardNotes, onDeleteCard, onMoveCard, onMoveColumn, onExit }) {
  const COLW = 210, GAP = 10
  const bodyH = 420
  const W = Math.max(COLW + 24, columns.length * (COLW + GAP) + GAP + 8)
  const H = bodyH + 20
  const s = scale || 1
  const [drag, setDrag] = useState(null)      // { cardId, x, y, label }
  const [cardDrop, setCardDrop] = useState(null) // { colId, beforeId } insertion point for the dragged card
  const [colDrag, setColDrag] = useState(null) // { colId, label, x, y } while dragging a column
  const [colDrop, setColDrop] = useState(null) // { beforeColId } insertion point for the dragged column
  const [groupMenu, setGroupMenu] = useState(false)
  const groupByLabel = grouped ? (groupBy?.mode === 'tag' ? 'Tags' : (propertyDefs.find(d => d.id === groupBy?.propId)?.name || 'property')) : null
  const [hover, setHover] = useState(false)    // reveal the header bar only on hover
  const [filterOpen, setFilterOpen] = useState(false)

  // Where would a dragged card land? → { colId, beforeId } (beforeId null = end of column).
  const computeCardDrop = (x, y, draggedId) => {
    const el = document.elementFromPoint(x, y)
    const colEl = el && el.closest('[data-kbcol]')
    if (!colEl) return null
    const colId = colEl.getAttribute('data-kbcol')
    const cardEl = el.closest('[data-kbcard]')
    if (cardEl && cardEl.getAttribute('data-kbcard') !== draggedId) {
      const r = cardEl.getBoundingClientRect()
      if (y < r.top + r.height / 2) return { colId, beforeId: cardEl.getAttribute('data-kbcard') }
      let sib = cardEl.nextElementSibling
      while (sib && !sib.getAttribute?.('data-kbcard')) sib = sib.nextElementSibling
      return { colId, beforeId: sib ? sib.getAttribute('data-kbcard') : null }
    }
    return { colId, beforeId: null }
  }
  // Where would a dragged column land? → { beforeColId } (null = end). Nearest column by cursor x.
  const computeColDrop = (x) => {
    let best = null
    for (const c of columns) {
      const node = document.querySelector(`[data-kbcol="${c.id}"]`)
      if (!node) continue
      const r = node.getBoundingClientRect()
      if (x < r.left + r.width / 2) { best = c.id; break }
    }
    return { beforeColId: best }
  }

  const conds = Array.isArray(filters) ? filters : []
  const q = (filterText || '').trim().toLowerCase()
  const cardMatchesText = (card) => {
    if (!q) return true
    if ((card.label || '').toLowerCase().includes(q)) return true
    const needle = q.replace(/^#/, '')
    return (card.meta?.tags || []).some(t => String(t).toLowerCase().includes(needle))
  }
  const cardMatchesCond = (card, c) => {
    if (c.type === 'tag') return (card.meta?.tags || []).includes(c.value)
    const def = propertyDefs.find(d => d.id === c.propId)
    const val = card.props?.[c.propId]
    if (!def) return true
    if (def.type === 'multiSelect') return Array.isArray(val) && val.includes(c.value)
    if (def.type === 'checkbox') return !!val === (c.value === true || c.value === 'true')
    if (def.type === 'select') return val === c.value
    return String(val ?? '').toLowerCase().includes(String(c.value).toLowerCase())
  }
  const matches = (card) => cardMatchesText(card) && conds.every(c => cardMatchesCond(card, c))

  // ── Card drag (mouse) ──────────────────────────────────────────────────────
  const startDrag = (e, card) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()   // don't begin a text selection on the card
    const ox = e.clientX, oy = e.clientY
    let moved = false
    const noSelect = ev => ev.preventDefault()
    const onMove = ev => {
      if (!moved && Math.hypot(ev.clientX - ox, ev.clientY - oy) < 5) return   // ignore micro-jitter → keep clicks clean
      if (!moved) { moved = true; document.body.style.userSelect = 'none'; document.addEventListener('selectstart', noSelect, true) }
      setDrag({ cardId: card.id, label: card.label, x: ev.clientX, y: ev.clientY })
      setCardDrop(computeCardDrop(ev.clientX, ev.clientY, card.id))
    }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('selectstart', noSelect, true)
      document.body.style.userSelect = ''
      const d = moved ? computeCardDrop(ev.clientX, ev.clientY, card.id) : null
      setDrag(null); setCardDrop(null)
      if (d && d.colId) onMoveCard(card.id, d.colId, d.beforeId)
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }

  // ── Column drag (mouse) → reorder columns by dragging their header ─────────────
  const startColDrag = (e, col) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const ox = e.clientX, oy = e.clientY
    let moved = false
    const noSelect = ev => ev.preventDefault()
    const onMove = ev => {
      if (!moved && Math.hypot(ev.clientX - ox, ev.clientY - oy) < 5) return
      if (!moved) { moved = true; document.body.style.userSelect = 'none'; document.addEventListener('selectstart', noSelect, true) }
      setColDrag({ colId: col.id, label: col.label, x: ev.clientX, y: ev.clientY })
      setColDrop(computeColDrop(ev.clientX))
    }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('selectstart', noSelect, true)
      document.body.style.userSelect = ''
      const d = moved ? computeColDrop(ev.clientX) : null
      setColDrag(null); setColDrop(null)
      if (d) { let beforeId = d.beforeColId; if (beforeId === col.id) beforeId = null; onMoveColumn(col.id, beforeId) }
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }

  // bottom-right handle → scale the board; the top-left (opposite) corner stays pinned because the
  // foreignObject's x/y use the UNSCALED W/H, so growing s only extends down-right.
  const startScale = (e) => {
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY, s0 = s, k = zoomRef?.current?.k || 1
    const move = ev => onSetScale(Math.max(0.5, Math.min(3, s0 + ((ev.clientX - sx) + (ev.clientY - sy)) / 2 / (k * 420))))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  return (
    <foreignObject data-card="true" x={(node.x || 0) - W / 2} y={(node.y || 0) - H / 2} width={W * s + 20} height={H * s + 20} style={{ overflow: 'visible' }}>
      <div style={{ width: W, height: H, transform: `scale(${s})`, transformOrigin: '0 0', position: 'relative' }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setFilterOpen(false) }}>
      <div style={{ ...kb.card, userSelect: 'none' }}>
        {/* board header — always-present minimal bar (no fill), for the title + options; drag to move */}
        <div style={kb.header}
          onMouseDown={onHeaderDown} onClick={e => { e.stopPropagation(); onSelect(node.id) }} title="Drag to move · click to select">
          <EditableText value={title} onCommit={onRenameBoard} style={kb.boardTitle} title="Double-click to rename board" />
          {grouped && (
            <div style={{ position: 'relative' }}>
              <button style={{ ...kb.hBtn, background: '#2e2a5a' }} title="Group cards by…" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setGroupMenu(o => !o) }}>⌗ {groupByLabel} ▾</button>
              {groupMenu && (<>
                <div onMouseDown={e => { e.stopPropagation(); setGroupMenu(false) }} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                <div onMouseDown={e => e.stopPropagation()} style={kb.filterPop}>
                  <div style={kb.menuLabel}>Group by</div>
                  {propertyDefs.filter(d => d.type === 'select' || d.type === 'multiSelect').map(d => (
                    <div key={d.id} style={{ ...kb.menuItem, color: groupBy?.propId === d.id ? '#fff' : '#c5d0ff' }} onClick={() => { onSetGroupBy({ mode: 'property', propId: d.id }); setGroupMenu(false) }}>{d.name}{groupBy?.propId === d.id ? '  ✓' : ''}</div>
                  ))}
                  <div style={{ ...kb.menuItem, color: groupBy?.mode === 'tag' ? '#fff' : '#c5d0ff' }} onClick={() => { onSetGroupBy({ mode: 'tag' }); setGroupMenu(false) }}>Tags{groupBy?.mode === 'tag' ? '  ✓' : ''}</div>
                </div>
              </>)}
            </div>
          )}
          <div style={{ position: 'relative' }}>
            <button style={{ ...kb.hBtn, background: (q || conds.length) ? '#3b4db0' : 'rgba(0,0,0,0.28)' }} title="Filter cards" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setFilterOpen(o => !o) }}>⚑ Filter{conds.length ? ` (${conds.length})` : ''}</button>
            {filterOpen && <FilterPopover text={filterText} conds={conds} propertyDefs={propertyDefs} allTags={allTags} onSetText={onSetFilterText} onSetConds={onSetFilters} onClose={() => setFilterOpen(false)} />}
          </div>
          {!(grouped && groupBy?.mode === 'tag') && <button style={kb.hBtn} title={grouped ? 'Add a value/column' : 'Add column'} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onAddColumn() }}>＋ Col</button>}
          <button style={kb.hBtn} title={grouped ? 'Remove this board (keeps the items)' : 'Expand back to nodes'} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onExit() }}>{grouped ? '✕' : '⤢'}</button>
        </div>
        {/* columns */}
        <div style={kb.cols} onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
          {columns.length === 0 && <div style={{ color: '#8090b8', fontSize: 12, padding: 10 }}>No columns — use the ＋ Col button in the bar.</div>}
          {columns.map(col => (
            <Fragment key={col.id}>
              {colDrag && colDrop?.beforeColId === col.id && <div style={kb.vLine} />}
              <KanbanColumn col={col} q={q} matches={matches} drag={drag} cardDrop={drag ? cardDrop : null} dragOver={drag && cardDrop?.colId === col.id} startDrag={startDrag} COLW={COLW}
                startColDrag={grouped ? null : startColDrag} colDragging={colDrag?.colId === col.id} grouped={grouped} locked={col.locked}
                onRenameColumn={onRenameColumn} onDeleteColumn={onDeleteColumn} onSetColumnColor={onSetColumnColor} onSetColumnWip={onSetColumnWip}
                onAddCard={onAddCard} onRenameCard={onRenameCard} onSetCardNotes={onSetCardNotes} onDeleteCard={onDeleteCard} onSelect={onSelect} />
            </Fragment>
          ))}
          {colDrag && colDrop?.beforeColId == null && <div style={kb.vLine} />}
        </div>
      </div>
      {/* resize handle (bottom-right) — appears on hover; scales the board from the top-left corner */}
      <div onMouseDown={startScale} title="Drag to resize the board"
        style={{ position: 'absolute', right: -4, bottom: -4, width: 18, height: 18, cursor: 'nwse-resize', opacity: hover ? 1 : 0, transition: 'opacity 0.14s', borderRight: '2.5px solid #5b6af0', borderBottom: '2.5px solid #5b6af0', borderBottomRightRadius: 6 }} />
      </div>
      {drag && createPortal(
        <div style={{ position: 'fixed', left: drag.x + 8, top: drag.y + 8, zIndex: 9999, pointerEvents: 'none', maxWidth: 200, background: '#1b2140', border: '1px solid #5b6af0', borderRadius: 6, padding: '5px 8px', fontSize: 12, color: '#dbe4ff', boxShadow: '0 6px 18px rgba(0,0,0,0.6)', fontFamily: '-apple-system, sans-serif' }}>
          {drag.label || '(card)'}
        </div>, document.body)}
      {colDrag && createPortal(
        <div style={{ position: 'fixed', left: colDrag.x + 8, top: colDrag.y + 8, zIndex: 9999, pointerEvents: 'none', background: '#2a3260', border: '1px solid #7c8cff', borderRadius: 7, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, color: '#eef2ff', boxShadow: '0 8px 22px rgba(0,0,0,0.65)', fontFamily: '-apple-system, sans-serif' }}>
          ⠿ {colDrag.label || '(column)'}
        </div>, document.body)}
    </foreignObject>
  )
}

// Rich filter popover: free-text (name/tags) + property/tag conditions (AND). Conditions are
// { type:'prop', propId, value } for select/multiSelect/checkbox props, or { type:'tag', value }.
function FilterPopover({ text, conds, propertyDefs, allTags, onSetText, onSetConds, onClose }) {
  const [pick, setPick] = useState(null)   // a def being value-picked, or '__tag__'
  const selectDefs = (propertyDefs || []).filter(d => d.type === 'select' || d.type === 'multiSelect' || d.type === 'checkbox')
  const addCond = (c) => { if (!conds.some(x => x.type === c.type && x.propId === c.propId && x.value === c.value)) onSetConds([...conds, c]); setPick(null) }
  const removeCond = (i) => onSetConds(conds.filter((_, idx) => idx !== i))
  const defName = (pid) => propertyDefs.find(d => d.id === pid)?.name || 'field'
  const optName = (pid, v) => { const d = propertyDefs.find(x => x.id === pid); const o = (d?.options || []).find(o => o.id === v); return o?.name || String(v) }
  const condLabel = (c) => c.type === 'tag' ? `#${c.value}` : c.propId && propertyDefs.find(d => d.id === c.propId)?.type === 'checkbox' ? `${defName(c.propId)}: ${c.value === true || c.value === 'true' ? '✓' : '✗'}` : `${defName(c.propId)}: ${optName(c.propId, c.value)}`
  return (<>
    <div onMouseDown={e => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
    <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} style={kb.filterPop}>
      <div style={kb.menuLabel}>Text (name or #tag)</div>
      <input value={text || ''} placeholder="Contains…" autoFocus onChange={e => onSetText(e.target.value)} onKeyDown={e => e.stopPropagation()}
        style={{ margin: '2px 8px 8px', width: 'calc(100% - 16px)', boxSizing: 'border-box', background: '#0f0f22', border: '1px solid #2d3a6a', borderRadius: 5, color: '#dbe4ff', fontSize: 12, padding: '4px 7px', outline: 'none' }} />
      {conds.length > 0 && <>
        <div style={kb.menuLabel}>Active conditions</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 8px 6px' }}>
          {conds.map((c, i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#dbe4ff', background: '#243', border: '1px solid #3a4a8a', borderRadius: 8, padding: '1px 6px' }}>{condLabel(c)}<span onClick={() => removeCond(i)} style={{ cursor: 'pointer', opacity: 0.7 }}>×</span></span>)}
        </div>
      </>}
      {!pick ? (
        <>
          <div style={kb.menuLabel}>Add condition</div>
          {selectDefs.map(d => <div key={d.id} style={kb.menuItem} onClick={() => setPick(d.id)}>{d.name} <span style={{ color: '#8090b8' }}>›</span></div>)}
          {(allTags || []).length > 0 && <div style={kb.menuItem} onClick={() => setPick('__tag__')}>Tag <span style={{ color: '#8090b8' }}>›</span></div>}
          {selectDefs.length === 0 && (allTags || []).length === 0 && <div style={{ padding: '4px 12px 8px', fontSize: 11, color: '#8090b8' }}>No properties or tags to filter by yet.</div>}
        </>
      ) : pick === '__tag__' ? (
        <>
          <div style={kb.menuItem} onClick={() => setPick(null)}><span style={{ color: '#8090b8' }}>‹ Tag</span></div>
          {(allTags || []).map(t => <div key={t} style={kb.menuItem} onClick={() => addCond({ type: 'tag', value: t })}>#{t}</div>)}
        </>
      ) : (() => {
        const d = propertyDefs.find(x => x.id === pick)
        return (<>
          <div style={kb.menuItem} onClick={() => setPick(null)}><span style={{ color: '#8090b8' }}>‹ {d?.name}</span></div>
          {d?.type === 'checkbox' ? (
            <>
              <div style={kb.menuItem} onClick={() => addCond({ type: 'prop', propId: d.id, value: true })}>✓ Checked</div>
              <div style={kb.menuItem} onClick={() => addCond({ type: 'prop', propId: d.id, value: false })}>✗ Unchecked</div>
            </>
          ) : (d?.options || []).map(o => <div key={o.id} style={kb.menuItem} onClick={() => addCond({ type: 'prop', propId: d.id, value: o.id })}><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: o.color || '#6366f1', marginRight: 7 }} />{o.name}</div>)}
        </>)
      })()}
    </div>
  </>)
}

// Small inline card-adder: shows a "＋ Add card" button that turns into an input.
function AddCardRow({ onAdd }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const commit = (keep) => { const t = draft.trim(); if (t) onAdd(t); setDraft(''); if (!keep) setAdding(false) }
  if (!adding) return <button style={kb.addCard} onClick={e => { e.stopPropagation(); setAdding(true) }}>＋ Add card</button>
  return (
    <textarea autoFocus value={draft} placeholder="Card text… (Enter to add)" onClick={e => e.stopPropagation()}
      onChange={e => setDraft(e.target.value)} onBlur={() => commit(false)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(true) } if (e.key === 'Escape') { setDraft(''); setAdding(false) } }}
      style={kb.addInput} rows={2} />
  )
}

// One kanban column: header (name, count/limit, ⋯ menu for color + limit + delete) and its cards.
function KanbanColumn({ col, q, matches, drag, cardDrop, dragOver, startDrag, startColDrag, colDragging, grouped, locked, COLW, onRenameColumn, onDeleteColumn, onSetColumnColor, onSetColumnWip, onAddCard, onRenameCard, onSetCardNotes, onDeleteCard, onSelect }) {
  const [menu, setMenu] = useState(false)
  const shown = col.cards.filter(matches)
  const accent = col.color || null
  const over = col.wip != null && col.cards.length > col.wip
  const countText = q ? `${shown.length}/${col.cards.length}` : (col.wip != null ? `${col.cards.length}/${col.wip}` : String(col.cards.length))
  const swatches = ['#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']
  return (
    <div data-kbcol={col.id} style={{ ...kb.col, width: COLW, opacity: colDragging ? 0.4 : 1, border: dragOver ? '2px solid #7c8cff' : (accent ? `1px solid ${accent}` : '1px solid #23233e'), background: dragOver ? (accent ? accent + '4d' : '#1a2246') : (accent ? accent + '30' : '#101024') }}>
      <div style={{ ...kb.colHeader, cursor: startColDrag ? 'grab' : 'default', background: accent ? accent + '66' : 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}
        onMouseDown={e => startColDrag?.(e, col)} title={startColDrag ? 'Drag to reorder column' : undefined}>
        {startColDrag && <span style={{ color: '#8090b8', fontSize: 12, flexShrink: 0, cursor: 'grab' }}>⠿</span>}
        {locked
          ? <span style={{ ...kb.colTitle, color: '#8090b8', fontStyle: 'italic' }}>{col.label}</span>
          : <EditableText value={col.label} onCommit={l => onRenameColumn(col.id, l)} style={kb.colTitle} title="Double-click to rename column" />}
        <span style={{ ...kb.colCount, color: over ? '#f87171' : '#8090b8' }} title={over ? 'Over limit' : undefined}>{countText}</span>
        {!locked && <div style={{ position: 'relative' }}>
          <button style={kb.colMenuBtn} title="Column options" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setMenu(m => !m) }}>⋯</button>
          {menu && (<>
            <div onMouseDown={e => { e.stopPropagation(); setMenu(false) }} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
            <div onMouseDown={e => e.stopPropagation()} style={kb.colMenu}>
              <div style={kb.menuLabel}>Column color</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '2px 10px 8px' }}>
                <div title="None" onClick={() => { onSetColumnColor(col.id, null); setMenu(false) }} style={{ width: 18, height: 18, borderRadius: 5, border: '1.5px solid #3a4a8a', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8090b8', fontSize: 11 }}>∅</div>
                {swatches.map(c => <div key={c} onClick={() => { onSetColumnColor(col.id, c); setMenu(false) }} style={{ width: 18, height: 18, borderRadius: 5, background: c, cursor: 'pointer', border: accent === c ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.15)' }} />)}
              </div>
              {!grouped && <>
                <div style={kb.menuLabel}>Limit</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 10px 8px' }}>
                  <input type="number" min="0" value={col.wip ?? ''} placeholder="none"
                    onChange={e => onSetColumnWip(col.id, e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
                    style={{ width: 64, background: '#0f0f22', border: '1px solid #2d3a6a', borderRadius: 5, color: '#dbe4ff', fontSize: 12, padding: '3px 6px', outline: 'none' }} />
                  {col.wip != null && <button onClick={() => onSetColumnWip(col.id, null)} style={{ ...kb.menuBtn }}>Clear</button>}
                </div>
              </>}
              <div style={{ borderTop: '1px solid #23233e', margin: '2px 0' }} />
              <div style={{ ...kb.menuItem, color: '#f87171' }} onClick={() => { setMenu(false); onDeleteColumn(col.id) }}>{grouped ? 'Delete value' : 'Delete column'}</div>
            </div>
          </>)}
        </div>}
      </div>
      <div style={{ ...kb.colBody, boxShadow: over ? 'inset 0 0 0 1.5px rgba(248,113,113,0.4)' : undefined }}>
        {shown.map(card => (
          <Fragment key={card.id}>
            {cardDrop && cardDrop.colId === col.id && cardDrop.beforeId === card.id && <div style={kb.hLine} />}
            <KanbanCardView card={card} drag={drag} startDrag={startDrag}
              onSelect={onSelect} onRenameCard={onRenameCard} onSetCardNotes={onSetCardNotes} onDeleteCard={onDeleteCard} />
          </Fragment>
        ))}
        {cardDrop && cardDrop.colId === col.id && cardDrop.beforeId == null && <div style={kb.hLine} />}
        <AddCardRow onAdd={label => onAddCard(col.id, label)} />
      </div>
    </div>
  )
}

// One kanban card: label, tags, expandable note, and its own note/delete buttons.
function KanbanCardView({ card, drag, startDrag, onSelect, onRenameCard, onSetCardNotes, onDeleteCard }) {
  const [noteOpen, setNoteOpen] = useState(false)
  const hasNote = !!(card.notes && card.notes.trim())
  return (
    <div data-kbcard={card.id} style={{ ...kb.cardItem, opacity: drag?.cardId === card.id ? 0.4 : 1 }}
      onMouseDown={e => startDrag(e, card)} onClick={e => { e.stopPropagation(); onSelect(card.id) }}>
      <EditableText value={card.label} onCommit={l => onRenameCard(card.id, l)} style={kb.cardLabel} multiline title="Double-click to edit" />
      {(card.meta?.tags || []).length > 0 && (
        <div style={kb.cardTags}>
          {card.meta.tags.slice(0, 4).map(t => <span key={t} style={{ ...kb.cardTag, background: tagColor(t) + '2e', border: `1px solid ${tagColor(t)}`, color: '#e6ebff' }}>{t}</span>)}
        </div>
      )}
      {hasNote && !noteOpen && (
        <div style={kb.notePreview} onClick={e => { e.stopPropagation(); setNoteOpen(true) }} title="Click to edit note">{card.notes}</div>
      )}
      {noteOpen && (
        <textarea autoFocus value={card.notes || ''} placeholder="Note / description…"
          onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
          onChange={e => onSetCardNotes(card.id, e.target.value)}
          onBlur={() => setNoteOpen(false)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setNoteOpen(false) }}
          style={kb.noteInput} rows={3} />
      )}
      <div style={kb.cardBtns} onMouseDown={e => e.stopPropagation()}>
        <button style={{ ...kb.cardMini, color: hasNote || noteOpen ? '#8ecbff' : '#7080a0' }} title={hasNote ? 'Edit note' : 'Add note'} onClick={e => { e.stopPropagation(); setNoteOpen(o => !o) }}>📝</button>
        <button style={{ ...kb.cardMini, color: '#f87171' }} title="Delete card" onClick={e => { e.stopPropagation(); onDeleteCard(card.id) }}>×</button>
      </div>
    </div>
  )
}

// Double-click-to-edit text used for board title, column titles, and card labels.
function EditableText({ value, onCommit, style, multiline, title }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])
  const commit = () => { const t = draft.trim(); onCommit(t || value); setEditing(false) }
  if (!editing) return <span style={style} title={title} onDoubleClick={e => { e.stopPropagation(); setDraft(value); setEditing(true) }}>{value || '(untitled)'}</span>
  const common = {
    autoFocus: true, value: draft, onClick: e => e.stopPropagation(), onMouseDown: e => e.stopPropagation(),
    onChange: e => setDraft(e.target.value), onBlur: commit,
    onKeyDown: e => { e.stopPropagation(); if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); commit() } if (e.key === 'Escape') setEditing(false) },
    style: { ...style, background: '#0f0f22', border: '1px solid #5b6af0', borderRadius: 4, color: '#fff', outline: 'none', padding: '1px 5px', width: '100%', boxSizing: 'border-box', font: 'inherit', resize: 'none' },
  }
  return multiline ? <textarea {...common} rows={2} /> : <input {...common} />
}

const kb = {
  card: { width: '100%', height: '100%', background: '#12122a', border: '1px solid #2d3a6a', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', overflow: 'visible', fontFamily: '-apple-system, sans-serif', position: 'relative' },
  header: { display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box', padding: '7px 10px', background: 'transparent', cursor: 'grab', borderTopLeftRadius: 12, borderTopRightRadius: 12, flexShrink: 0, overflow: 'visible', borderBottom: '1px solid #20233f' },
  boardTitle: { fontWeight: 700, fontSize: 13.5, color: '#dbe4ff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'grab' },
  hBtn: { background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '4px 7px', whiteSpace: 'nowrap' },
  filterPop: { position: 'absolute', top: '112%', right: 0, zIndex: 31, minWidth: 210, maxHeight: 320, overflowY: 'auto', background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 9, padding: '5px 0', boxShadow: '0 10px 30px rgba(0,0,0,0.65)' },
  cols: { flex: 1, display: 'flex', gap: 10, padding: 10, overflowX: 'auto', overflowY: 'hidden', alignItems: 'flex-start' },
  col: { display: 'flex', flexDirection: 'column', border: '1px solid #23233e', borderRadius: 10, maxHeight: '100%', flexShrink: 0, overflow: 'hidden' },
  colHeader: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', flexShrink: 0 },
  colTitle: { fontWeight: 600, fontSize: 12.5, color: '#eaf0ff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' },
  colCount: { fontSize: 11, fontWeight: 600 },
  colMenuBtn: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' },
  colMenu: { position: 'absolute', top: '110%', right: 0, zIndex: 21, minWidth: 176, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  menuLabel: { padding: '4px 10px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  menuItem: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  menuBtn: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 4, cursor: 'pointer', fontSize: '0.72rem', padding: '2px 8px' },
  colBody: { flex: 1, overflowY: 'auto', padding: 7, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 40, borderRadius: 8 },
  cardItem: { position: 'relative', background: '#2a3260', border: '1px solid #414d8a', borderRadius: 7, padding: '7px 34px 7px 9px', cursor: 'grab', boxShadow: '0 2px 6px rgba(0,0,0,0.4)', userSelect: 'none' },
  cardLabel: { display: 'block', fontSize: 12.5, color: '#eef2ff', lineHeight: 1.35, wordBreak: 'break-word', cursor: 'grab', userSelect: 'none' },
  cardTags: { display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 },
  cardTag: { fontSize: 10, borderRadius: 7, padding: '0 5px', whiteSpace: 'nowrap' },
  notePreview: { marginTop: 5, fontSize: 11, color: '#9aa6c8', lineHeight: 1.35, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 46, overflow: 'hidden', cursor: 'text', borderLeft: '2px solid #2d3a6a', paddingLeft: 6 },
  noteInput: { marginTop: 5, width: '100%', boxSizing: 'border-box', background: '#0f0f22', border: '1px solid #5b6af0', borderRadius: 5, color: '#dbe4ff', fontSize: 11.5, padding: '4px 6px', outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 },
  cardBtns: { position: 'absolute', top: 4, right: 4, display: 'flex', gap: 1 },
  cardMini: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '1px 2px' },
  addCard: { background: 'transparent', border: '1px dashed #3a4a8a', borderRadius: 7, color: '#8090b8', cursor: 'pointer', fontSize: 12, padding: '5px 8px', textAlign: 'left' },
  addInput: { background: '#0f0f22', border: '1px solid #5b6af0', borderRadius: 6, color: '#dbe4ff', fontSize: 12.5, padding: '5px 7px', outline: 'none', resize: 'none', fontFamily: 'inherit' },
  hLine: { height: 3, borderRadius: 2, background: '#7c8cff', boxShadow: '0 0 6px #7c8cff', margin: '1px 0', flexShrink: 0 },
  vLine: { width: 3, alignSelf: 'stretch', borderRadius: 2, background: '#7c8cff', boxShadow: '0 0 6px #7c8cff', flexShrink: 0 },
}

// ─── StrategyCard ───────────────────────────────────────────────────────────
// A node whose WHOLE subtree (every generation) is laid out as draggable cards inside one bespoke
// SVG card. The user draws typed arrows by hand: next (→ solid), needs (⇢ dashed), decision-branch
// (◈ labelled, leaves a diamond node). Arrows live on node.meta.strategy — SEPARATE from graph
// edges, so drawing them never touches the outliner hierarchy. Drag-only, no DSL (v1).
const ST_ITEMW = 150, ST_ITEMH = 54, ST_HGAP = 44, ST_VGAP = 74, ST_PAD = 26
const ST_KINDS = {
  next:   { label: 'Next',    icon: '→', color: '#7c8cff', dash: null },
  needs:  { label: 'Needs',   icon: '⇢', color: '#f0a35b', dash: '6,5' },
  branch: { label: 'Branch',  icon: '◈', color: '#f6c65b', dash: null },
}

// Layered top-down layout. Precedence: next/branch = from→to; needs = to→from (the needed one first).
function computeStrategyLayout(items, edges) {
  const ids = items.map(it => it.id)
  const idset = new Set(ids)
  const preds = {}; ids.forEach(id => (preds[id] = []))
  const succs = {}; ids.forEach(id => (succs[id] = []))
  ;(edges || []).forEach(e => {
    if (!idset.has(e.from) || !idset.has(e.to)) return
    const [a, b] = e.kind === 'needs' ? [e.to, e.from] : [e.from, e.to]   // a before b
    succs[a].push(b); preds[b].push(a)
  })
  // longest-path layering with a cycle cap
  const layer = {}; ids.forEach(id => (layer[id] = 0))
  for (let pass = 0; pass < ids.length + 2; pass++) {
    let changed = false
    ids.forEach(id => {
      const want = preds[id].length ? Math.max(...preds[id].map(p => layer[p] + 1)) : 0
      if (want > layer[id] && want < ids.length + 2) { layer[id] = want; changed = true }
    })
    if (!changed) break
  }
  const byLayer = {}
  ids.forEach(id => { (byLayer[layer[id]] = byLayer[layer[id]] || []).push(id) })
  const pos = {}
  Object.keys(byLayer).map(Number).sort((a, b) => a - b).forEach(L => {
    byLayer[L].forEach((id, i) => { pos[id] = { x: ST_PAD + i * (ST_ITEMW + ST_HGAP), y: ST_PAD + L * (ST_ITEMH + ST_VGAP) } })
  })
  return pos
}

function StrategyCard({ node, title, items, strategy, zoomRef, scale = 1, fill, selectedId, onHeaderDown, onSelect, onRenameBoard, onRenameItem, onSetPos, onSetPositions, onAddEdge, onSetEdge, onRemoveEdge, onToggleDecision, onSetScale, onExit }) {
  const s = scale || 1
  const edges = strategy?.edges || []
  const decision = strategy?.decision || {}
  const storedPos = strategy?.pos || {}
  const contentRef = useRef(null)
  const [dragItem, setDragItem] = useState(null)   // { id, x, y } live override while moving
  const [linking, setLinking] = useState(null)     // { from, x, y } while drawing an arrow (content coords)
  const [edgeMenu, setEdgeMenu] = useState(null)    // { id, sx, sy } screen coords
  const [hover, setHover] = useState(false)

  // Fallback auto-layout for any item lacking a stored position.
  const autoPos = useMemo(() => computeStrategyLayout(items, edges), [items, edges])
  const posOf = id => (dragItem?.id === id ? dragItem : (storedPos[id] || autoPos[id] || { x: ST_PAD, y: ST_PAD }))

  // content bounds → scrollable inner size (min = a comfortable viewport)
  let maxX = 320, maxY = 240
  items.forEach(it => { const p = posOf(it.id); maxX = Math.max(maxX, p.x + ST_ITEMW); maxY = Math.max(maxY, p.y + ST_ITEMH) })
  const contentW = maxX + ST_PAD, contentH = maxY + ST_PAD
  const viewW = 560, viewH = 400
  const W = viewW, H = viewH

  const centerOf = id => { const p = posOf(id); return { x: p.x + ST_ITEMW / 2, y: p.y + ST_ITEMH / 2 } }
  const border = (cx, cy, tx, ty) => {
    const dx = tx - cx, dy = ty - cy
    if (!dx && !dy) return { x: cx, y: cy }
    const tX = dx ? (ST_ITEMW / 2) / Math.abs(dx) : Infinity
    const tY = dy ? (ST_ITEMH / 2) / Math.abs(dy) : Infinity
    const t = Math.min(tX, tY)
    return { x: cx + dx * t, y: cy + dy * t }
  }
  // client → content-local coords (accounts for D3 zoom k × card scale s, and scroll via getBoundingClientRect)
  const toContent = (clientX, clientY) => {
    const rect = contentRef.current?.getBoundingClientRect()
    const k = (zoomRef?.current?.k || 1) * s
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left) / k, y: (clientY - rect.top) / k }
  }

  // ── Move an item ──────────────────────────────────────────────────────────
  const startMove = (e, id) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const start = posOf(id)
    const ox = e.clientX, oy = e.clientY
    let moved = false
    const noSelect = ev => ev.preventDefault()
    const onMove = ev => {
      const k = (zoomRef?.current?.k || 1) * s
      const nx = start.x + (ev.clientX - ox) / k, ny = start.y + (ev.clientY - oy) / k
      if (!moved && Math.hypot(ev.clientX - ox, ev.clientY - oy) < 4) return
      if (!moved) { moved = true; document.body.style.userSelect = 'none'; document.addEventListener('selectstart', noSelect, true); showDragShield('grabbing') }
      setDragItem({ id, x: Math.max(0, nx), y: Math.max(0, ny) })
    }
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('selectstart', noSelect, true)
      document.body.style.userSelect = ''
      hideDragShield()
      if (moved) { const k = (zoomRef?.current?.k || 1) * s; onSetPos(id, Math.max(0, start.x + (ev.clientX - ox) / k), Math.max(0, start.y + (ev.clientY - oy) / k)) }
      else onSelect(id)
      setDragItem(null)
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }

  // ── Draw an arrow from an item's connector handle ───────────────────────────
  const startLink = (e, from) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const noSelect = ev => ev.preventDefault()
    document.body.style.userSelect = 'none'; document.addEventListener('selectstart', noSelect, true); showDragShield('crosshair')
    const onMove = ev => setLinking({ from, ...toContent(ev.clientX, ev.clientY) })
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('selectstart', noSelect, true)
      document.body.style.userSelect = ''
      hideDragShield()
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const target = el && el.closest('[data-stratitem]')?.getAttribute('data-stratitem')
      if (target && target !== from) onAddEdge(from, target, decision[from] ? 'branch' : 'next', '')
      setLinking(null)
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }

  const startScale = (e) => {
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY, s0 = s, k = zoomRef?.current?.k || 1
    const move = ev => onSetScale(Math.max(0.5, Math.min(3, s0 + ((ev.clientX - sx) + (ev.clientY - sy)) / 2 / (k * 400))))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); hideDragShield() }
    showDragShield('nwse-resize')
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  return (
    <foreignObject data-card="true" x={(node.x || 0) - W / 2} y={(node.y || 0) - H / 2} width={W * s + 20} height={H * s + 20} style={{ overflow: 'visible' }}>
      <div style={{ width: W, height: H, transform: `scale(${s})`, transformOrigin: '0 0', position: 'relative' }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <div style={{ ...st.card, background: (fill && fill !== 'none' && fill !== 'transparent') ? fill : '#101026' }}>
          {/* header — drag to move, rename, auto-arrange, exit */}
          <div style={st.header} onMouseDown={onHeaderDown} onClick={e => { e.stopPropagation(); onSelect(node.id) }} title="Drag to move · click to select">
            <span style={st.hIcon}>🕸️</span>
            <EditableText value={title} onCommit={onRenameBoard} style={st.title} title="Double-click to rename" />
            <button style={st.hBtn} title="Auto-arrange (layered top-down)" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onSetPositions(computeStrategyLayout(items, edges)) }}>⇄ Arrange</button>
            <button style={st.hBtn} title="Expand back to nodes" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onExit() }}>⤢</button>
          </div>
          {/* body — scrollable strategy surface */}
          <div style={st.body} onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
            {items.length === 0 && <div style={{ color: '#8090b8', fontSize: 12, padding: 14 }}>This node has no descendants yet. Add child nodes, then they appear here to connect.</div>}
            <div ref={contentRef} style={{ position: 'relative', width: contentW, height: contentH }}>
              {/* arrows layer (behind items) */}
              <svg width={contentW} height={contentH} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
                <defs>
                  {Object.entries(ST_KINDS).map(([k, def]) => (
                    <marker key={k} id={`st-arrow-${node.id}-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={def.color} />
                    </marker>
                  ))}
                </defs>
                {edges.map(e => {
                  const a = centerOf(e.from), b = centerOf(e.to)
                  const p1 = border(a.x, a.y, b.x, b.y), p2 = border(b.x, b.y, a.x, a.y)
                  const def = ST_KINDS[e.kind] || ST_KINDS.next
                  return (
                    <line key={e.id} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={def.color} strokeWidth={2}
                      strokeDasharray={def.dash || undefined} markerEnd={`url(#st-arrow-${node.id}-${e.kind || 'next'})`} />
                  )
                })}
                {linking && (() => { const a = centerOf(linking.from); return <line x1={a.x} y1={a.y} x2={linking.x} y2={linking.y} stroke="#7c8cff" strokeWidth={2} strokeDasharray="4,4" /> })()}
              </svg>
              {/* edge midpoint chips — click to edit kind/label, ×2 to delete */}
              {edges.map(e => {
                const a = centerOf(e.from), b = centerOf(e.to)
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
                const def = ST_KINDS[e.kind] || ST_KINDS.next
                return (
                  <div key={'chip' + e.id} style={{ ...st.edgeChip, left: mx, top: my, borderColor: def.color, color: def.color }}
                    title="Click to edit · double-click to delete"
                    onMouseDown={ev => ev.stopPropagation()}
                    onClick={ev => { ev.stopPropagation(); setEdgeMenu({ id: e.id, sx: ev.clientX, sy: ev.clientY }) }}
                    onDoubleClick={ev => { ev.stopPropagation(); onRemoveEdge(e.id) }}>
                    {def.icon}{e.label ? <span style={st.edgeLabel}>{e.label}</span> : null}
                  </div>
                )
              })}
              {/* item cards */}
              {items.map(it => {
                const p = posOf(it.id)
                const isDec = !!decision[it.id]
                const sel = selectedId === it.id
                return (
                  <div key={it.id} data-stratitem={it.id}
                    style={{ ...st.item, left: p.x, top: p.y, width: ST_ITEMW, height: ST_ITEMH,
                      ...(isDec ? st.itemDecision : null),
                      borderColor: sel ? '#7c8cff' : (isDec ? '#f6c65b' : '#414d8a'),
                      boxShadow: sel ? '0 0 0 2px rgba(124,140,255,0.5), 0 3px 10px rgba(0,0,0,0.5)' : '0 3px 10px rgba(0,0,0,0.45)' }}
                    onMouseDown={e => startMove(e, it.id)}>
                    <EditableText value={it.label} onCommit={label => onRenameItem(it.id, label)} style={st.itemLabel} title="Double-click to rename · drag to move" />
                    {/* decision toggle */}
                    <button style={{ ...st.itemBtn, top: 2, right: 2, color: isDec ? '#f6c65b' : '#6b76a8' }}
                      title={isDec ? 'Decision node (branch source)' : 'Make this a decision node'}
                      onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggleDecision(it.id) }}>◇</button>
                    {/* connector handle (bottom-center) — drag to another item to draw an arrow */}
                    <div style={st.handle} title="Drag to another item to connect" onMouseDown={e => startLink(e, it.id)} />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        {/* resize handle (bottom-right) */}
        <div onMouseDown={startScale} title="Drag to resize"
          style={{ position: 'absolute', right: -4, bottom: -4, width: 18, height: 18, cursor: 'nwse-resize', opacity: hover ? 1 : 0, transition: 'opacity 0.14s', borderRight: '2.5px solid #5b6af0', borderBottom: '2.5px solid #5b6af0', borderBottomRightRadius: 6 }} />
      </div>
      {/* edge menu (kind / label / delete) */}
      {edgeMenu && createPortal((() => {
        const e = edges.find(x => x.id === edgeMenu.id)
        if (!e) return null
        return (
          <>
            <div onMouseDown={ev => { ev.stopPropagation(); setEdgeMenu(null) }} onClick={ev => ev.stopPropagation()} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
            <div onMouseDown={ev => ev.stopPropagation()} onClick={ev => ev.stopPropagation()} onWheel={ev => ev.stopPropagation()}
              style={{ position: 'fixed', left: Math.min(edgeMenu.sx, window.innerWidth - 210), top: Math.min(edgeMenu.sy, window.innerHeight - 200), zIndex: 9999, minWidth: 190, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 9, padding: '7px 0', boxShadow: '0 10px 30px rgba(0,0,0,0.7)', fontFamily: '-apple-system, sans-serif' }}>
              <div style={st.menuLabel}>Arrow type</div>
              <div style={{ display: 'flex', gap: 5, padding: '2px 10px 6px' }}>
                {Object.entries(ST_KINDS).map(([k, def]) => (
                  <button key={k} onClick={() => onSetEdge(e.id, { kind: k })}
                    style={{ flex: 1, background: e.kind === k ? def.color : 'transparent', border: `1px solid ${def.color}`, color: e.kind === k ? '#0c0c1a' : def.color, borderRadius: 6, cursor: 'pointer', fontSize: 11.5, fontWeight: 600, padding: '5px 4px' }}
                    title={def.label}>{def.icon} {def.label}</button>
                ))}
              </div>
              <div style={st.menuLabel}>Label</div>
              <input defaultValue={e.label || ''} placeholder="e.g. yes / no…" autoFocus
                onKeyDown={ev => { ev.stopPropagation(); if (ev.key === 'Enter') { onSetEdge(e.id, { label: ev.target.value }); setEdgeMenu(null) } }}
                onBlur={ev => onSetEdge(e.id, { label: ev.target.value })}
                style={{ margin: '2px 10px 8px', width: 'calc(100% - 20px)', boxSizing: 'border-box', background: '#0f0f22', border: '1px solid #2d3a6a', borderRadius: 5, color: '#dbe4ff', fontSize: 12, padding: '5px 7px', outline: 'none' }} />
              <div style={{ ...st.menuItem, color: '#ff9a9a', borderTop: '1px solid #20233f', marginTop: 2, paddingTop: 8 }} onClick={() => { onRemoveEdge(e.id); setEdgeMenu(null) }}>🗑 Delete arrow</div>
            </div>
          </>
        )
      })(), document.body)}
      {linking && createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 1, pointerEvents: 'none' }} />, document.body)}
    </foreignObject>
  )
}

const st = {
  card: { width: '100%', height: '100%', border: '1px solid #2d3a6a', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: '-apple-system, sans-serif', position: 'relative' },
  header: { display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box', padding: '7px 10px', cursor: 'grab', flexShrink: 0, borderBottom: '1px solid #20233f' },
  hIcon: { fontSize: 14, opacity: 0.9 },
  title: { fontWeight: 700, fontSize: 13.5, color: '#dbe4ff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'grab' },
  hBtn: { background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '4px 8px', whiteSpace: 'nowrap' },
  body: { flex: 1, overflow: 'auto', position: 'relative', background: 'rgba(0,0,0,0.14)' },
  item: { position: 'absolute', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', background: '#232a52', border: '1px solid #414d8a', borderRadius: 9, padding: '4px 10px', cursor: 'grab', userSelect: 'none' },
  itemDecision: { background: '#2c2740', borderRadius: 4, clipPath: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)', padding: '4px 18px' },
  itemLabel: { fontSize: 12.5, color: '#eef2ff', lineHeight: 1.25, wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', cursor: 'grab', userSelect: 'none' },
  itemBtn: { position: 'absolute', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '1px 3px' },
  handle: { position: 'absolute', bottom: -6, left: '50%', transform: 'translateX(-50%)', width: 12, height: 12, borderRadius: '50%', background: '#7c8cff', border: '2px solid #101026', cursor: 'crosshair', boxShadow: '0 1px 4px rgba(0,0,0,0.5)' },
  edgeChip: { position: 'absolute', transform: 'translate(-50%, -50%)', display: 'inline-flex', alignItems: 'center', gap: 4, background: '#101026', border: '1.5px solid', borderRadius: 10, padding: '1px 7px', fontSize: 12, fontWeight: 700, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', zIndex: 2 },
  edgeLabel: { fontSize: 10.5, fontWeight: 600, color: '#dbe4ff' },
  menuLabel: { padding: '4px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  menuItem: { padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
}

// ─── TableCard ────────────────────────────────────────────────────────────────
// A node carrying `table = { columns, rows }`, drawn as MINIMAL text + grid lines directly on the canvas
// (transparent — no card). All chrome (title bar, add/delete affordances, resize handles) appears only on
// hover, so at rest it's just the data. Positioned top-left-anchored so the bottom-right handle grows it
// down-right (not center-pivoted). Rendered in a <foreignObject> so inputs/selects just work.
const TYPE_LABELS = { text: 'Text', number: 'Number', checkbox: 'Checkbox', select: 'Select', date: 'Date' }
const TC_LINE = 'rgba(150,163,204,0.5)'   // grid line — reads on the dark canvas, subtle on light
const TC_TXT = '#e8ecff'
function TableCard({ node, title, table, fill, textColor, scale = 1, collapsedScale = 1, palette = [], selected, zoomRef, collapsed, onToggleCollapse, onSetCollapsedScale, onPivotTop, onWheelScroll, onWheelZoom, onHeaderDown, onSelect, onRename, onCell, onSetCellBg, onAddRow, onAddColumn, onInsertRow, onInsertColumn, onDeleteRow, onDeleteColumn, onUpdateColumn, onMoveColumn, onMoveRow, onSetRowHeight, onSetColor, onSetTextColor, onDelete, onSetScale }) {
  const columns = table.columns || [], rows = table.rows || []
  const txt = textColor || TC_TXT   // per-table text colour (view-dependent); falls back to the default
  const colHdrH = 24
  const colW = c => c.width || 120
  // Auto-grow a row to fit any wrap-enabled text column's content (estimated), never below its manual/min height.
  const rowAutoH = (r) => {
    let need = 26
    for (const col of columns) {
      if (!col.wrap || col.type !== 'text') continue
      const val = r.cells?.[col.id]; if (val == null || val === '') continue
      const cpl = Math.max(1, Math.floor((colW(col) - 12) / 6.6))
      // Cells may hold HTML (rich text): count block breaks, then wrap the tag-stripped text.
      const raw = String(val)
      const blocks = (raw.match(/<(br|\/div|\/li|\/p|\/h[1-6])\b/gi) || []).length
      const text = raw.replace(/<[^>]+>/g, ' ')
      const lines = text.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / cpl)), 0) + blocks
      need = Math.max(need, lines * 16 + 10)
    }
    return need
  }
  const rowHeights = rows.map(r => Math.max(r.height || 0, rowAutoH(r), 26))
  const W = Math.max(80, columns.reduce((a, c) => a + colW(c), 0))
  const H = colHdrH + rowHeights.reduce((a, h) => a + h, 0)
  const bg = fill && fill !== 'none' && fill !== 'transparent' ? fill : null
  const accent = bg || '#5b6af0'
  // Below a certain on-screen size the table is too small to edit — the whole surface becomes a drag
  // handle (move only), no cell editing / affordances. Effective size = canvas zoom × table scale.
  const effK = (zoomRef?.current?.k || 1) * (scale || 1)
  const dragOnly = effK < 0.5
  // Pivot-on-top: the table is centered at node.y (transform translates by −H/2). When H changes
  // (column reflow, row add), keep the TOP edge fixed by shifting the anchor y by half the delta.
  const prevHRef = useRef(H)
  useEffect(() => {
    const prev = prevHRef.current
    prevHRef.current = H
    if (collapsed) return                          // don't shift while collapsed (the pill is top-pinned itself)
    const dy = (H - prev) / 2
    if (prev !== H && Math.abs(dy) > 0.01) onPivotTop?.(dy)   // parent shifts the anchor down by dy so the top stays put
  }, [H, collapsed])

  // Wheel over the table: D3's zoom listener sits on the <svg> and, because React delegates events at the
  // root container (above the svg), fires BEFORE any React onWheel here. So intercept natively on the
  // element itself. At an editable zoom a plain wheel scrolls/pans the canvas (a table reads like a
  // document); Ctrl/⌘+wheel (or drag-only zoom level) is left to bubble to the canvas zoom.
  const wheelCfg = useRef({})
  wheelCfg.current = { dragOnly, onWheelScroll, onWheelZoom }
  useEffect(() => {
    const el = rootRef.current; if (!el) return
    const onWheel = (e) => {
      const { dragOnly, onWheelScroll, onWheelZoom } = wheelCfg.current
      const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1   // lines / pages → pixels
      if (e.ctrlKey || e.metaKey) {
        // Zoom at NORMAL speed: D3's own ctrl+wheel handler multiplies the delta by 10 (for trackpad
        // pinch), which makes mouse ctrl+wheel jump. Drive the zoom ourselves instead.
        e.preventDefault(); e.stopPropagation()
        onWheelZoom?.(e.deltaY * m, e.clientX, e.clientY)
        return
      }
      if (dragOnly) return   // zoomed out: a plain wheel zooms via the canvas (normal speed)
      e.preventDefault(); e.stopPropagation()
      onWheelScroll?.(e.deltaX * m, e.deltaY * m)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [collapsed])
  const colX = []; { let a = 0; columns.forEach(c => { colX.push(a); a += colW(c) }) }
  const rowTop = []; { let a = colHdrH; rowHeights.forEach(h => { rowTop.push(a); a += h }) }

  const [hov, setHov] = useState(false)
  const [editTitle, setEditTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title || '')
  useEffect(() => { if (!editTitle) setTitleDraft(title || '') }, [title, editTitle])
  const [menuCol, setMenuCol] = useState(null)
  const [editColId, setEditColId] = useState(null)
  const [showColors, setShowColors] = useState(false)
  const [showTextColors, setShowTextColors] = useState(false)
  const [borderHov, setBorderHov] = useState(false)   // hovering any of the 4 move-borders → light the whole-table ring
  const showAff = hov && !dragOnly                    // editing affordances (handles/menus) only when zoomed in enough
  const [drop, setDrop] = useState(null)              // live reorder destination: { kind:'col'|'row', id }
  const [dragging, setDragging] = useState(false)     // a reorder drag is in progress
  const [ctx, setCtx] = useState(null)                // right-click menu: { x, y, ri, ci } in card-local coords
  const rootRef = useRef(null)
  const gridRef = useRef(null)                        // the grid container, for coordinate-based reorder hit-testing
  const openCtx = (e, ri, ci) => {
    e.preventDefault(); e.stopPropagation()
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    setCtx({ x: e.clientX - rect.left, y: e.clientY - rect.top, ri, ci })
  }

  const eff = () => (zoomRef?.current?.k || 1) * (scale || 1)
  const startColResize = (e, col) => {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startW = colW(col)
    const move = ev => onUpdateColumn(col.id, { width: Math.max(46, Math.round(startW + (ev.clientX - startX) / eff())) })
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const startRowResize = (e, rowId, h0) => {
    e.preventDefault(); e.stopPropagation()
    const startY = e.clientY
    const move = ev => onSetRowHeight(rowId, Math.max(18, Math.round(h0 + (ev.clientY - startY) / eff())))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  // Reorder by dragging a grip — the destination COLUMN/ROW is picked from the cursor's POSITION (row
  // band by Y, column band by X) rather than DOM hit-testing, so the row grip (which sits out in the
  // left margin) still resolves a target when dragged straight down. Highlighted live before mouseup.
  const startReorder = (e, id, attr, onMove) => {
    e.preventDefault(); e.stopPropagation()
    const kind = attr === 'data-tcol' ? 'col' : 'row'
    setDragging(true); setDrop(null)
    let target = null
    const move = ev => {
      const gr = gridRef.current?.getBoundingClientRect(); if (!gr) return
      const k = eff() || 1
      if (kind === 'row') {
        const ly = (ev.clientY - gr.top) / k
        let ti = -1
        for (let i = 0; i < rows.length; i++) { if (ly >= rowTop[i] && ly < rowTop[i] + rowHeights[i]) { ti = i; break } }
        if (ti < 0 && rows.length) ti = ly < rowTop[0] ? 0 : rows.length - 1
        target = rows[ti]?.id ?? null
        const gi = rows.findIndex(r => r.id === id)
        // Insertion line: at the target's top when dropping before it, its bottom when dropping after.
        if (target && target !== id) setDrop({ kind: 'row', pos: ti <= gi ? rowTop[ti] : rowTop[ti] + rowHeights[ti] })
        else setDrop(null)
      } else {
        const lx = (ev.clientX - gr.left) / k
        let ci = -1
        for (let i = 0; i < columns.length; i++) { if (lx >= colX[i] && lx < colX[i] + colW(columns[i])) { ci = i; break } }
        if (ci < 0 && columns.length) ci = lx < colX[0] ? 0 : columns.length - 1
        target = columns[ci]?.id ?? null
        const gi = columns.findIndex(c => c.id === id)
        if (target && target !== id) setDrop({ kind: 'col', pos: ci <= gi ? colX[ci] : colX[ci] + colW(columns[ci]) })
        else setDrop(null)
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      setDragging(false); setDrop(null)
      if (target && target !== id) onMove(id, target)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const startScale = (e) => {   // bottom-right corner → scale the whole table (top-left stays fixed)
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startY = e.clientY, s0 = scale || 1, k = zoomRef?.current?.k || 1
    const move = ev => onSetScale(Math.max(0.4, Math.min(4, s0 + ((ev.clientX - startX) + (ev.clientY - startY)) / 2 / (k * 220))))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const commitTitle = () => { const t = titleDraft.trim(); onRename(t || title || 'Table'); setEditTitle(false) }
  const stop = e => e.stopPropagation()
  const cellBox = (w) => ({ width: w, flexShrink: 0, boxSizing: 'border-box', borderRight: `1px solid ${TC_LINE}`, borderBottom: `1px solid ${TC_LINE}`, display: 'flex', alignItems: 'center', padding: '0 5px', overflow: 'hidden' })

  // top-left anchored: translate is independent of scale, so bottom-right handle grows it down-right.
  // A padded region around the grid so the hover affordances (which sit just outside the grid edges)
  // stay inside the foreignObject's hit-rect — otherwise `overflow:visible` shows them but they aren't
  // clickable, and the gap between grid and affordance drops the hover.
  const PADT = 24, PADR = 34, PADB = 26, PADL = 30

  // Collapsed: render as a compact, scalable node — a table icon + the title — pinned so its TOP-LEFT
  // sits exactly where the expanded table's top-left corner was (node.x − W/2, node.y − H/2), so
  // collapsing doesn't shift it. Expands on double-click (or ⊞). Scaling grows it down/right from there.
  if (collapsed) {
    const label = title || 'Table'
    const cw = Math.max(120, Math.min(300, label.length * 8 + 60))
    const ch = 34
    const cs = collapsedScale || 1
    const topY = (node.y || 0) - H / 2      // the expanded table's top edge
    const startCScale = (e) => {
      e.preventDefault(); e.stopPropagation()
      const sx = e.clientX, sy = e.clientY, s0 = cs, k = zoomRef?.current?.k || 1
      const move = ev => onSetCollapsedScale?.(Math.max(0.4, Math.min(6, s0 + ((ev.clientX - sx) + (ev.clientY - sy)) / 2 / (k * 120))))
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    }
    return (
      <g transform={`translate(${(node.x || 0) - W / 2},${topY}) scale(${cs})`}>
        <foreignObject data-card="true" x={-6} y={-6} width={cw + 12} height={ch + 14} style={{ overflow: 'visible' }}>
          <div onMouseDown={e => { stop(e); onHeaderDown(e) }} onClick={e => { stop(e); onSelect() }}
            onDoubleClick={e => { stop(e); onToggleCollapse?.() }} title="Double-click to expand"
            style={{ position: 'relative', width: cw, height: ch, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 10px',
              background: bg || '#181d3a', border: `1.5px solid ${selected ? accent : '#2d3a6a'}`, borderRadius: 9, cursor: 'move',
              boxShadow: selected ? `0 0 0 1.5px ${accent}` : '0 4px 14px rgba(0,0,0,0.4)', fontFamily: '-apple-system, sans-serif' }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>📊</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            <button onMouseDown={stop} onClick={e => { stop(e); onToggleCollapse?.() }} title="Expand"
              style={{ background: 'transparent', border: 'none', color: '#8fa0d8', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '2px 4px', flexShrink: 0 }}>⊞</button>
            {selected && <div title="Drag to resize" onMouseDown={startCScale}
              style={{ position: 'absolute', right: -5, bottom: -5, width: 11, height: 11, background: accent, borderRadius: 2, cursor: 'nwse-resize', boxShadow: '0 0 0 1px rgba(0,0,0,0.4)' }} />}
          </div>
        </foreignObject>
      </g>
    )
  }

  return (
    <g transform={`translate(${(node.x || 0) - W / 2},${(node.y || 0) - H / 2}) scale(${scale})`}>
    <foreignObject data-card="true" x={-PADL} y={-PADT} width={W + PADL + PADR} height={H + PADT + PADB} style={{ overflow: 'visible' }}>
      <div ref={rootRef} data-table-surface="1" onMouseEnter={() => setHov(true)} onMouseLeave={() => { setHov(false); setMenuCol(null); setShowColors(false); setShowTextColors(false); setBorderHov(false) }}
        onMouseDown={stop} onClick={e => { stop(e); onSelect() }}
        onContextMenu={e => openCtx(e, rows.length - 1, columns.length - 1)}
        style={{ position: 'relative', width: W + PADL + PADR, height: H + PADT + PADB, fontFamily: '-apple-system, sans-serif',
          pointerEvents: (hov || dragging) ? 'auto' : 'none' }}>
      {/* grid-anchor is always interactive so hovering it reveals the (otherwise click-through) padding */}
      <div onMouseEnter={() => setHov(true)} style={{ position: 'absolute', left: PADL, top: PADT, width: W, pointerEvents: 'auto' }}>

        {/* Hover-only header: drag handle · title · colour · delete (floats above the grid) */}
        {showAff && (
          <div style={{ position: 'absolute', left: 0, top: -23, height: 20, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span onMouseDown={onHeaderDown} title="Drag to move" style={{ cursor: 'grab', color: '#8090b8', fontSize: 12, lineHeight: 1 }}>✥</span>
            {editTitle ? (
              <input autoFocus value={titleDraft} onChange={e => setTitleDraft(e.target.value)} onMouseDown={stop} onClick={stop}
                onBlur={commitTitle} onKeyDown={e => { stop(e); if (e.key === 'Enter') { e.preventDefault(); commitTitle() } if (e.key === 'Escape') setEditTitle(false) }}
                style={{ background: '#0d0d1e', border: '1px solid #3a4a8a', color: '#fff', borderRadius: 4, padding: '0 5px', fontSize: 12, height: 18, outline: 'none' }} />
            ) : (
              <span onDoubleClick={e => { stop(e); setTitleDraft(title || ''); setEditTitle(true) }}
                style={{ color: txt, fontSize: 12, fontWeight: 600, cursor: 'text', maxWidth: W - 80, overflow: 'hidden', textOverflow: 'ellipsis' }}>{title || 'Table'}</span>
            )}
            <div style={{ position: 'relative' }}>
              <button style={tc.hbtn} title="Table background colour" onMouseDown={stop} onClick={e => { stop(e); setShowTextColors(false); setShowColors(v => !v) }}>◑</button>
              {showColors && (
                <div style={tc.colorPop} onMouseDown={stop} onClick={stop} onWheel={stop}>
                  <div title="Transparent" onClick={() => { onSetColor('none'); setShowColors(false) }}
                    style={{ width: 18, height: 18, borderRadius: 4, cursor: 'pointer', border: '1px solid #5b6af0', background: 'repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 50% / 8px 8px' }} />
                  {palette.map(c => <div key={c} title={c} onClick={() => { onSetColor(c); setShowColors(false) }} style={{ width: 18, height: 18, borderRadius: 4, background: c, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.15)' }} />)}
                </div>
              )}
            </div>
            <div style={{ position: 'relative' }}>
              <button style={{ ...tc.hbtn, fontWeight: 800 }} title="Table text colour" onMouseDown={stop} onClick={e => { stop(e); setShowColors(false); setShowTextColors(v => !v) }}>A</button>
              {showTextColors && (
                <div style={tc.colorPop} onMouseDown={stop} onClick={stop} onWheel={stop}>
                  <div title="Default" onClick={() => { onSetTextColor('__default__'); setShowTextColors(false) }}
                    style={{ width: 18, height: 18, borderRadius: 4, cursor: 'pointer', border: '1px solid #5b6af0', background: TC_TXT, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#16162a', fontSize: 11, fontWeight: 800 }}>A</div>
                  {palette.map(c => <div key={c} title={c} onClick={() => { onSetTextColor(c); setShowTextColors(false) }} style={{ width: 18, height: 18, borderRadius: 4, background: c, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.15)' }} />)}
                </div>
              )}
            </div>
            <button style={tc.hbtn} title="Collapse table (show title only)" onMouseDown={stop} onClick={e => { stop(e); onToggleCollapse?.() }}>▬</button>
            <button style={{ ...tc.hbtn, color: '#f0a0a0' }} title="Delete table" onMouseDown={stop} onClick={e => { stop(e); onDelete() }}>🗑</button>
          </div>
        )}

        {/* Grid — background (or transparent), lines + text. Right-clicking a non-cell area (gaps,
            borders) falls back to appending rows/columns. */}
        <div ref={gridRef} onContextMenu={e => openCtx(e, rows.length - 1, columns.length - 1)}
          style={{ position: 'relative', borderTop: `1px solid ${TC_LINE}`, borderLeft: `1px solid ${TC_LINE}`, width: W, boxSizing: 'border-box', background: bg || 'transparent', boxShadow: (selected || borderHov) ? `0 0 0 1.5px ${accent}` : 'none' }}>
          {/* Column header row */}
          <div style={{ display: 'flex', height: colHdrH }}>
            {columns.map((col, ci) => (
              <div key={col.id} data-tcol={col.id} onContextMenu={e => openCtx(e, -1, ci)} style={{ ...cellBox(colW(col)), position: 'relative', gap: 2, overflow: menuCol === col.id ? 'visible' : 'hidden', zIndex: menuCol === col.id ? 30 : undefined }}>
                {showAff && <span title="Drag to reorder column" onMouseDown={e => startReorder(e, col.id, 'data-tcol', onMoveColumn)} style={{ position: 'relative', zIndex: 9, cursor: 'grab', color: '#7b8fcc', fontSize: 10, lineHeight: 1, flexShrink: 0 }}>⣿</span>}
                {editColId === col.id ? (
                  <input autoFocus defaultValue={col.name} onMouseDown={stop} onClick={stop}
                    onBlur={e => { onUpdateColumn(col.id, { name: e.target.value.trim() || col.name }); setEditColId(null) }}
                    onKeyDown={e => { stop(e); if (e.key === 'Enter') { onUpdateColumn(col.id, { name: e.target.value.trim() || col.name }); setEditColId(null) } if (e.key === 'Escape') setEditColId(null) }}
                    style={{ flex: 1, minWidth: 0, background: '#0d0d1e', border: '1px solid #3a4a8a', color: '#fff', borderRadius: 3, padding: '0 3px', fontSize: 11, outline: 'none' }} />
                ) : (
                  <span title={`${col.name} · ${TYPE_LABELS[col.type] || col.type}`} onDoubleClick={e => { stop(e); setEditColId(col.id) }}
                    style={{ flex: 1, fontSize: 11, fontWeight: 700, color: txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}>{col.name}</span>
                )}
                {showAff && <button style={tc.colMenuBtn} title="Column type / delete" onMouseDown={stop} onClick={e => { stop(e); setMenuCol(menuCol === col.id ? null : col.id) }}>⋮</button>}
                {menuCol === col.id && (
                  <div style={tc.colMenu} onMouseDown={stop} onClick={stop} onWheel={stop}>
                    <div style={tc.menuLabel}>Type</div>
                    {['text', 'number', 'checkbox', 'select', 'date'].map(t => (
                      <div key={t} style={tc.menuItem(col.type === t)} onClick={() => { onUpdateColumn(col.id, { type: t, ...(t === 'select' && !col.options ? { options: ['Option'] } : {}) }); setMenuCol(null) }}>{TYPE_LABELS[t]}</div>
                    ))}
                    {col.type === 'select' && (<><div style={{ ...tc.menuLabel, marginTop: 4 }}>Options</div><SelectOptionsEditor options={col.options || []} onChange={opts => onUpdateColumn(col.id, { options: opts })} /></>)}
                    {col.type === 'text' && (<>
                      <div style={{ borderTop: '1px solid #23233e', margin: '4px 0' }} />
                      <div style={tc.menuItem(!!col.wrap)} onClick={() => { onUpdateColumn(col.id, { wrap: !col.wrap }); setMenuCol(null) }}>{col.wrap ? '✓ ' : ''}Wrap text</div>
                    </>)}
                    <div style={{ borderTop: '1px solid #23233e', margin: '4px 0' }} />
                    <div style={tc.menuItem(false, '#f0a0a0')} onClick={() => { onDeleteColumn(col.id); setMenuCol(null) }}>Delete column</div>
                  </div>
                )}
              </div>
            ))}
            {showAff && <button style={tc.addColBtn} title="Add column" onMouseDown={stop} onClick={e => { stop(e); onAddColumn('text') }}>＋</button>}
          </div>
          {/* Data rows */}
          {rows.map((r, ri) => (
            <div key={r.id} data-trow={r.id} className="tc-row" style={{ display: 'flex', height: rowHeights[ri], position: 'relative' }}>
              {columns.map((col, ci) => (
                <div key={col.id} onContextMenu={e => openCtx(e, ri, ci)} style={{ ...cellBox(colW(col)), ...(r.cellBg?.[col.id] ? { background: r.cellBg[col.id] } : {}), ...(col.wrap && col.type === 'text' ? { alignItems: 'stretch', padding: '3px 5px' } : {}) }}>
                  <TableCell col={col} value={r.cells?.[col.id]} onChange={v => onCell(r.id, col.id, v)} textColor={txt} editable={!dragOnly} />
                </div>
              ))}
              {showAff && <span className="tc-rowgrip" title="Drag to reorder row" onMouseDown={e => startReorder(e, r.id, 'data-trow', onMoveRow)}
                style={{ position: 'absolute', zIndex: 12, left: 0, top: 0, width: 15, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', color: '#aeb8ff', fontSize: 11, lineHeight: 1, background: 'rgba(18,20,42,0.72)', borderRight: '1px solid rgba(91,106,240,0.4)' }}>⣿</span>}
              {showAff && <button className="tc-rowdel" style={tc.rowDel} title="Delete row" onMouseDown={stop} onClick={e => { stop(e); onDeleteRow(r.id) }}>×</button>}
            </div>
          ))}

          {/* Google-Docs-style resize handles: grab a grid line and drag. Interior lines only, so the outer
              borders stay free for moving. */}
          {showAff && columns.map((col, ci) => ci < columns.length - 1 && (
            <div key={'cd' + col.id} className="tc-linediv" onMouseDown={e => startColResize(e, col)} title="Drag to resize column"
              style={{ position: 'absolute', left: colX[ci] + colW(col) - 3, top: 0, width: 6, height: H, cursor: 'col-resize', zIndex: 6 }} />
          ))}
          {showAff && rows.map((r, ri) => ri < rows.length - 1 && (
            <div key={'rd' + r.id} className="tc-linediv" onMouseDown={e => startRowResize(e, r.id, rowHeights[ri])} title="Drag to resize row"
              style={{ position: 'absolute', left: 0, top: rowTop[ri] + rowHeights[ri] - 3, width: W, height: 6, cursor: 'row-resize', zIndex: 6 }} />
          ))}
          {/* Last column / last row remain resizable via a thin handle on their own edge. */}
          {showAff && columns.length > 0 && <div className="tc-linediv" onMouseDown={e => startColResize(e, columns[columns.length - 1])} title="Drag to resize column" style={{ position: 'absolute', left: W - 3, top: 0, width: 6, height: colHdrH, cursor: 'col-resize', zIndex: 7 }} />}
          {showAff && rows.length > 0 && <div className="tc-linediv" onMouseDown={e => startRowResize(e, rows[rows.length - 1].id, rowHeights[rowHeights.length - 1])} title="Drag to resize row" style={{ position: 'absolute', left: -6, top: rowTop[rows.length - 1] + rowHeights[rowHeights.length - 1] - 3, width: 6, height: 6, cursor: 'row-resize', zIndex: 7 }} />}

          {/* Live reorder destination — an insertion LINE at the boundary where the item will land.
              Kept above the cells and grips (high z) so it's clearly visible during the drag. */}
          {drop && drop.kind === 'col' && <div style={{ position: 'absolute', left: drop.pos - 1.5, top: 0, width: 3, height: H, background: accent, borderRadius: 2, pointerEvents: 'none', zIndex: 20, boxShadow: `0 0 5px ${accent}` }} />}
          {drop && drop.kind === 'row' && <div style={{ position: 'absolute', left: 0, top: drop.pos - 1.5, width: W, height: 3, background: accent, borderRadius: 2, pointerEvents: 'none', zIndex: 20, boxShadow: `0 0 5px ${accent}` }} />}

          {/* Move-the-table borders — drag any of the 4 edges. Hovering ANY of them lights the whole-table
              selection ring (same style/thickness as selecting it), not each border individually. */}
          {showAff && [
            { k: 't', s: { left: 0, top: -3, width: W, height: 6 } },
            { k: 'b', s: { left: 0, top: H - 3, width: W, height: 6 } },
            { k: 'l', s: { left: -3, top: 0, width: 6, height: H } },
            { k: 'r', s: { left: W - 3, top: colHdrH, width: 6, height: H - colHdrH } },
          ].map(({ k, s }) => (
            <div key={'mb' + k} onMouseDown={onHeaderDown} title="Drag to move table"
              onMouseEnter={() => setBorderHov(true)} onMouseLeave={() => setBorderHov(false)}
              style={{ position: 'absolute', ...s, cursor: 'move', zIndex: 5 }} />
          ))}
        </div>

        {/* Zoomed out too far to edit → the whole grid becomes a drag handle (move only). Right-click
            still offers table options. */}
        {dragOnly && <div title="Zoom in to edit" onMouseDown={e => { stop(e); onHeaderDown(e) }} onClick={e => { stop(e); onSelect() }}
          onContextMenu={e => openCtx(e, rows.length - 1, columns.length - 1)}
          style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, cursor: 'move', zIndex: 30 }} />}

        {/* Hover-only add-row + resize corner */}
        {showAff && <button style={tc.addRowBtn} onMouseDown={stop} onClick={e => { stop(e); onAddRow() }}>＋ row</button>}
        {showAff && <div title="Drag to resize table" onMouseDown={startScale}
          style={{ position: 'absolute', right: -5, bottom: -5, width: 11, height: 11, background: accent, borderRadius: 2, cursor: 'nwse-resize', boxShadow: '0 0 0 1px rgba(0,0,0,0.4)' }} />}

        {/* Right-click context menu — add / delete rows & columns right where you clicked. */}
        {ctx && (<>
          <div onMouseDown={e => { stop(e); setCtx(null) }} onContextMenu={e => { e.preventDefault(); stop(e); setCtx(null) }}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div onMouseDown={stop} onClick={stop} onWheel={stop}
            style={{ position: 'absolute', left: ctx.x, top: ctx.y, zIndex: 41, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 4, minWidth: 150, boxShadow: '0 6px 20px rgba(0,0,0,0.7)' }}>
            {ctx.ri >= 0 && <>
              <div style={tc.menuItem(false)} onClick={() => { onInsertRow(ctx.ri); setCtx(null) }}>↑ Add row above</div>
              <div style={tc.menuItem(false)} onClick={() => { onInsertRow(ctx.ri + 1); setCtx(null) }}>↓ Add row below</div>
            </>}
            <div style={tc.menuItem(false)} onClick={() => { onInsertColumn(ctx.ci, 'text'); setCtx(null) }}>← Add column left</div>
            <div style={tc.menuItem(false)} onClick={() => { onInsertColumn(ctx.ci + 1, 'text'); setCtx(null) }}>→ Add column right</div>
            {ctx.ri >= 0 && rows[ctx.ri] && columns[ctx.ci] && (<>
              <div style={{ borderTop: '1px solid #23233e', margin: '4px 0' }} />
              <div style={{ ...tc.menuLabel, padding: '2px 8px 3px' }}>Cell colour</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 8px 4px', maxWidth: 172 }}>
                <div title="None" onClick={() => { onSetCellBg?.(rows[ctx.ri].id, columns[ctx.ci].id, null); setCtx(null) }}
                  style={{ width: 18, height: 18, borderRadius: 4, cursor: 'pointer', border: '1px solid #5b6af0', background: 'repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 50% / 8px 8px' }} />
                {(palette || []).map(c => <div key={c} title={c} onClick={() => { onSetCellBg?.(rows[ctx.ri].id, columns[ctx.ci].id, c); setCtx(null) }}
                  style={{ width: 18, height: 18, borderRadius: 4, background: c, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.15)' }} />)}
              </div>
            </>)}
            <div style={{ borderTop: '1px solid #23233e', margin: '4px 0' }} />
            {ctx.ri >= 0 && rows[ctx.ri] && <div style={tc.menuItem(false, '#f0a0a0')} onClick={() => { onDeleteRow(rows[ctx.ri].id); setCtx(null) }}>Delete row</div>}
            {columns[ctx.ci] && <div style={tc.menuItem(false, '#f0a0a0')} onClick={() => { onDeleteColumn(columns[ctx.ci].id); setCtx(null) }}>Delete column</div>}
            <div style={{ borderTop: '1px solid #23233e', margin: '4px 0' }} />
            <div style={tc.menuItem(false)} onClick={() => { onToggleCollapse?.(); setCtx(null) }}>▬ Collapse table</div>
            <div style={tc.menuItem(false, '#f0a0a0')} onClick={() => { onDelete(); setCtx(null) }}>Delete table</div>
          </div>
        </>)}
      </div>
      </div>
    </foreignObject>
    </g>
  )
}

function TableCell({ col, value, onChange, textColor, editable = true }) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => { setDraft(value ?? '') }, [value])
  const stop = e => e.stopPropagation()
  const col2 = textColor || TC_TXT
  if (col.type === 'checkbox') {
    return <input type="checkbox" checked={!!value} onMouseDown={stop} onChange={e => onChange(e.target.checked)}
      style={{ width: 15, height: 15, accentColor: '#5b6af0', cursor: 'pointer', margin: '0 auto' }} />
  }
  if (col.type === 'select') {
    return (
      <select value={value ?? ''} onMouseDown={stop} onChange={e => onChange(e.target.value)} style={{ ...tc.select, color: col2 }}>
        <option value="">—</option>
        {(col.options || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (col.type === 'text') {
    // Rich text cell: contentEditable holding HTML, with a floating B/I/U/S + bullet toolbar while
    // editing. Wrap columns grow the row to fit; non-wrap stay single-line.
    return <RichCell value={value} wrap={!!col.wrap} textColor={col2} editable={editable} onChange={onChange} />
  }
  const inputType = col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'
  return (
    <input type={inputType} value={draft} onMouseDown={stop} onClick={stop}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if ((draft ?? '') !== (value ?? '')) onChange(draft) }}
      onKeyDown={e => { stop(e); if (e.key === 'Enter') e.currentTarget.blur() }}
      style={{ ...tc.cellInput, color: col2 }} />
  )
}

// A rich-text table cell: contentEditable HTML with a floating format toolbar (bold/italic/underline/
// strikethrough + bullet list). The toolbar renders in a portal so it escapes the SVG/foreignObject
// transform and sits at true screen coordinates above the cell.
function RichCell({ value, wrap, textColor, editable = true, onChange }) {
  const ref = useRef(null)
  const [editing, setEditing] = useState(false)
  const [tb, setTb] = useState(null)   // { left, top } screen coords for the toolbar
  const stop = e => e.stopPropagation()
  useEffect(() => {
    const el = ref.current; if (!el) return
    if (document.activeElement !== el && el.innerHTML !== (value ?? '')) el.innerHTML = value ?? ''
  }, [value])
  // While editing, close the cell (and its floating toolbar) the moment the canvas is panned/zoomed —
  // a wheel gesture, or a mousedown anywhere outside this cell and its toolbar. Stops the toolbar from
  // floating over a moving canvas.
  useEffect(() => {
    if (!editing) return
    const onWheel = () => ref.current?.blur()
    const onDown = e => { const t = e.target; if (ref.current && !ref.current.contains(t) && !t?.closest?.('[data-tcell-tb]')) ref.current.blur() }
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('mousedown', onDown, true)
    return () => { window.removeEventListener('wheel', onWheel, true); window.removeEventListener('mousedown', onDown, true) }
  }, [editing])
  const [tcOpen, setTcOpen] = useState(false)   // text-colour swatch row open
  const placeTb = () => { const r = ref.current?.getBoundingClientRect(); if (r) setTb({ left: r.left, top: r.top - (tcOpen ? 62 : 32) }) }
  const exec = (cmd) => { document.execCommand(cmd, false); ref.current?.focus(); if (ref.current) onChange(ref.current.innerHTML) }
  // Apply a text colour to the current selection. mousedown preventDefault on the swatch keeps the cell
  // focused (selection intact), so no native picker / focus loss.
  const applyColor = (c) => {
    const el = ref.current; if (!el) return
    try { document.execCommand('styleWithCSS', false, true) } catch { /* ignore */ }
    document.execCommand('foreColor', false, c)
    el.focus(); onChange(el.innerHTML)
  }
  const btn = (label, cmd, style) => (
    <button onMouseDown={e => { e.preventDefault(); stop(e); exec(cmd) }} onClick={stop}
      style={{ background: 'transparent', border: 'none', color: '#c5d0ff', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '3px 6px', borderRadius: 4, ...style }}>{label}</button>
  )
  const TEXT_COLORS = ['#e8ecff', '#ffffff', '#7080a0', '#ff6b6b', '#f6ad55', '#ffd84d', '#6ee7a8', '#5b6af0', '#a78bfa', '#f472b6', '#4ade80', '#38bdf8']
  return (<>
    <div ref={ref} contentEditable={editable} suppressContentEditableWarning data-tcell="1"
      onMouseDown={editable ? stop : undefined} onClick={editable ? stop : undefined}
      onFocus={() => { setEditing(true); placeTb() }}
      onScroll={placeTb}
      onBlur={() => { setEditing(false); setTb(null); onChange(ref.current?.innerHTML || '') }}
      onInput={placeTb}
      onKeyDown={e => { stop(e); if (e.key === 'Enter' && !wrap && !e.shiftKey) { e.preventDefault(); ref.current?.blur() } }}
      style={{ ...tc.cellInput, color: textColor || TC_TXT, whiteSpace: wrap ? 'pre-wrap' : 'nowrap',
        wordBreak: wrap ? 'break-word' : 'normal', overflow: 'hidden', cursor: editable ? 'text' : 'inherit', minHeight: 15,
        pointerEvents: editable ? 'auto' : 'none',
        fontFamily: 'inherit', fontSize: 12, lineHeight: wrap ? '16px' : 1.3 }} />
    {editing && editable && tb && createPortal(
      <div data-tcell-tb="1" onMouseDown={e => { e.preventDefault(); stop(e) }} onClick={stop}
        style={{ position: 'fixed', left: tb.left, top: tb.top, zIndex: 10000, display: 'flex', flexDirection: 'column', gap: 3,
          background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 7, padding: 2, boxShadow: '0 6px 20px rgba(0,0,0,0.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {btn('B', 'bold', { fontWeight: 800 })}
          {btn('I', 'italic', { fontStyle: 'italic' })}
          {btn('U', 'underline', { textDecoration: 'underline' })}
          {btn('S', 'strikeThrough', { textDecoration: 'line-through' })}
          <span style={{ width: 1, height: 15, background: '#2d3a6a', margin: '0 2px' }} />
          {btn('•', 'insertUnorderedList')}
          {btn('1.', 'insertOrderedList', { fontSize: 12 })}
          <span style={{ width: 1, height: 15, background: '#2d3a6a', margin: '0 2px' }} />
          <button title="Text colour" onMouseDown={e => { e.preventDefault(); stop(e); setTcOpen(v => !v) }} onClick={stop}
            style={{ background: tcOpen ? '#232a5c' : 'transparent', border: 'none', color: '#c5d0ff', cursor: 'pointer', fontSize: 13, fontWeight: 800, lineHeight: 1, padding: '3px 6px', borderRadius: 4 }}>A</button>
        </div>
        {tcOpen && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '1px 3px 2px', maxWidth: 170 }}>
            {TEXT_COLORS.map(c => <div key={c} title={c} onMouseDown={e => { e.preventDefault(); stop(e); applyColor(c) }}
              style={{ width: 16, height: 16, borderRadius: 3, background: c, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.2)' }} />)}
          </div>
        )}
      </div>, document.body)}
  </>)
}

function SelectOptionsEditor({ options, onChange }) {
  const [adding, setAdding] = useState('')
  const stop = e => e.stopPropagation()
  return (
    <div style={{ padding: '2px 6px 4px' }}>
      {options.map((o, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          <input defaultValue={o} onMouseDown={stop} onClick={stop}
            onBlur={e => { const v = e.target.value.trim(); const next = [...options]; if (v) next[i] = v; else next.splice(i, 1); onChange(next) }}
            onKeyDown={e => { stop(e); if (e.key === 'Enter') e.currentTarget.blur() }}
            style={{ ...tc.cellInput, background: '#0f0f22', border: '1px solid #2a3358', borderRadius: 4, height: 20, flex: 1 }} />
          <button style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 12 }} onMouseDown={stop} onClick={() => onChange(options.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 4 }}>
        <input value={adding} placeholder="Add option…" onMouseDown={stop} onClick={stop} onChange={e => setAdding(e.target.value)}
          onKeyDown={e => { stop(e); if (e.key === 'Enter') { const v = adding.trim(); if (v) { onChange([...options, v]); setAdding('') } } }}
          style={{ ...tc.cellInput, background: '#0f0f22', border: '1px solid #2a3358', borderRadius: 4, height: 20, flex: 1 }} />
      </div>
    </div>
  )
}

const tc = {
  hbtn: { background: 'transparent', border: 'none', color: '#c5d0ff', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '1px 3px' },
  colMenuBtn: { position: 'relative', zIndex: 9, background: 'transparent', border: 'none', color: '#7b8fcc', cursor: 'pointer', fontSize: 12, padding: '0 1px', lineHeight: 1, flexShrink: 0 },
  resizeHandle: { position: 'absolute', right: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 2 },
  colMenu: { position: 'absolute', top: 24, right: 0, zIndex: 20, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 4, boxShadow: '0 6px 20px rgba(0,0,0,0.7)', minWidth: 140 },
  menuLabel: { fontSize: 10, color: '#8090b8', fontWeight: 600, padding: '3px 8px 2px', textTransform: 'uppercase', letterSpacing: 0.4 },
  menuItem: (active, color) => ({ padding: '5px 10px', fontSize: 12, color: color || (active ? '#8ecbff' : '#c5d0ff'), cursor: 'pointer', borderRadius: 4, background: active ? '#20264e' : 'transparent' }),
  cellInput: { width: '100%', background: 'transparent', border: 'none', color: TC_TXT, fontSize: 12, padding: 0, height: '100%', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', background: 'transparent', border: 'none', color: TC_TXT, fontSize: 12, padding: 0, height: '100%', outline: 'none', cursor: 'pointer' },
  addRowBtn: { position: 'absolute', zIndex: 9, left: 0, top: '100%', marginTop: 2, background: 'transparent', border: 'none', color: '#8ecbff', cursor: 'pointer', fontSize: 11, padding: '2px 4px', whiteSpace: 'nowrap' },
  addColBtn: { position: 'absolute', zIndex: 9, left: '100%', top: 0, height: 24, background: 'transparent', border: 'none', color: '#8ecbff', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 5px' },
  rowDel: { position: 'absolute', zIndex: 9, left: -17, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: '#f0a0a0', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 },
  colorPop: { position: 'absolute', top: 20, right: 0, zIndex: 30, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.7)', display: 'flex', flexWrap: 'wrap', gap: 4, width: 150 },
}

// ─── Drawing layer (floating shapes/lines/arrows/emoji/text — per-view, not nodes) ──────────────
function shapeDrawing(shape, hw, hh, props) {
  const poly = pts => <polygon points={pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')} {...props} />
  switch (shape) {
    case 'ellipse': return <ellipse rx={hw} ry={hh} {...props} />
    case 'circle': return <circle r={Math.min(hw, hh)} {...props} />
    case 'roundrect': return <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} rx={Math.min(hw, hh) * 0.3} {...props} />
    case 'triangle': return poly([[0, -hh], [hw, hh], [-hw, hh]])
    case 'diamond': return poly([[0, -hh], [hw, 0], [0, hh], [-hw, 0]])
    case 'pentagon': { const p = []; for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; p.push([hw * Math.cos(a), hh * Math.sin(a)]) } return poly(p) }
    case 'hexagon': { const p = []; for (let i = 0; i < 6; i++) { const a = i * 2 * Math.PI / 6; p.push([hw * Math.cos(a), hh * Math.sin(a)]) } return poly(p) }
    case 'star': { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const r = i % 2 === 0 ? 1 : 0.42; p.push([hw * r * Math.cos(a), hh * r * Math.sin(a)]) } return poly(p) }
    default: return <rect x={-hw} y={-hh} width={hw * 2} height={hh * 2} {...props} />
  }
}

function DrawingItem({ d, selected, zoomRef, palette, onSelect, onUpdate, onDelete }) {
  const stop = e => e.stopPropagation()
  const kz = () => zoomRef?.current?.k || 1
  const x = d.x || 0, y = d.y || 0
  const isLine = d.kind === 'line' || d.kind === 'arrow'
  const [editing, setEditing] = useState(false)

  const startMove = (e) => {
    if (e.button !== 0) return
    stop(e); e.preventDefault(); onSelect()
    const sx = e.clientX, sy = e.clientY, o = { x, y, x2: d.x2, y2: d.y2 }
    const move = ev => {
      const dx = (ev.clientX - sx) / kz(), dy = (ev.clientY - sy) / kz()
      const patch = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) }
      if (o.x2 != null) { patch.x2 = Math.round(o.x2 + dx); patch.y2 = Math.round(o.y2 + dy) }
      onUpdate(patch)
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const startResize = (e) => {
    stop(e); e.preventDefault()
    const sx = e.clientX, sy = e.clientY
    let move
    if (isLine) { const o = { x2: d.x2, y2: d.y2 }; move = ev => onUpdate({ x2: Math.round(o.x2 + (ev.clientX - sx) / kz()), y2: Math.round(o.y2 + (ev.clientY - sy) / kz()) }) }
    else if (d.kind === 'emoji' || d.kind === 'text') { const o = d.size || 40; move = ev => onUpdate({ size: Math.max(10, Math.round(o + (ev.clientX - sx) / kz())) }) }
    else { const ow = d.w || 80, oh = d.h || 60; move = ev => onUpdate({ w: Math.max(12, Math.round(ow + (ev.clientX - sx) / kz())), h: Math.max(12, Math.round(oh + (ev.clientY - sy) / kz())) }) }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  const stroke = d.stroke || '#c5d0ff', sw = d.strokeWidth || 3
  let body = null, bbox = null
  if (d.kind === 'shape') {
    const w = d.w || 80, h = d.h || 60, hw = w / 2, hh = h / 2
    body = shapeDrawing(d.shape || 'rect', hw, hh, { fill: d.fill || '#5b6af0', stroke: d.stroke || 'none', strokeWidth: d.stroke ? sw : 0 })
    bbox = { x: -hw, y: -hh, w, h }
  } else if (isLine) {
    const x2 = (d.x2 ?? x + 120) - x, y2 = (d.y2 ?? y) - y
    body = (<>
      {d.kind === 'arrow' && <defs><marker id={`dah-${d.id}`} markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill={stroke} /></marker></defs>}
      <line x1={0} y1={0} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} strokeDasharray={d.dash || undefined} markerEnd={d.kind === 'arrow' ? `url(#dah-${d.id})` : undefined} strokeLinecap="round" />
    </>)
  } else if (d.kind === 'emoji') {
    const s = (d.size || 44) / 2
    body = <text textAnchor="middle" dominantBaseline="central" fontSize={d.size || 44} style={{ userSelect: 'none' }}>{d.emoji}</text>
    bbox = { x: -s, y: -s, w: s * 2, h: s * 2 }
  } else if (d.kind === 'text') {
    const fs = d.size || 22, w = Math.max(40, (d.text || 'Text').length * fs * 0.6), h = fs * 1.4
    body = <text textAnchor="middle" dominantBaseline="central" fontSize={fs} fill={d.fill || '#fff'} fontWeight={600} style={{ userSelect: 'none' }}>{d.text || 'Text'}</text>
    bbox = { x: -w / 2, y: -h / 2, w, h }
  }

  const hx = bbox ? bbox.x + bbox.w : ((d.x2 ?? x + 120) - x), hy = bbox ? bbox.y + bbox.h : ((d.y2 ?? y) - y)
  const CHECKER = 'repeating-conic-gradient(#555 0% 25%, #222 0% 50%) 50% / 7px 7px'
  const swatchRow = (onPick, label) => (
    <div onMouseDown={stop} style={{ display: 'flex', alignItems: 'center', gap: 3, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 6, padding: '3px 5px', width: 'fit-content' }}>
      {label && <span style={{ fontSize: 8, color: '#8090b8', width: 10, textAlign: 'center', flexShrink: 0 }}>{label}</span>}
      <div title="Transparent" onClick={ev => { stop(ev); onPick('none') }} style={{ width: 13, height: 13, borderRadius: 3, cursor: 'pointer', border: '1px solid #5b6af0', background: CHECKER }} />
      {palette.slice(0, 12).map(c => <div key={c} onClick={ev => { stop(ev); onPick(c) }} style={{ width: 13, height: 13, borderRadius: 3, background: c, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.15)' }} />)}
    </div>
  )
  const pickFill = c => onUpdate({ fill: c === 'none' ? 'none' : c })
  const pickStroke = c => onUpdate({ stroke: c === 'none' ? null : c })
  return (
    <g transform={`translate(${x},${y})`} onClick={e => { stop(e); onSelect() }}
      onDoubleClick={e => { if (d.kind === 'text') { stop(e); setEditing(true) } }}
      onMouseDown={startMove} style={{ cursor: 'move' }}>
      {isLine && <line x1={0} y1={0} x2={(d.x2 ?? x + 120) - x} y2={(d.y2 ?? y) - y} stroke="transparent" strokeWidth={14} />}
      {!(editing && d.kind === 'text') && body}
      {editing && d.kind === 'text' && (
        <foreignObject x={-90} y={-16} width={180} height={32} style={{ overflow: 'visible' }}>
          <input autoFocus defaultValue={d.text || ''} onMouseDown={stop} onClick={stop}
            onBlur={e => { onUpdate({ text: e.target.value || 'Text' }); setEditing(false) }}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { onUpdate({ text: e.target.value || 'Text' }); setEditing(false) } if (e.key === 'Escape') setEditing(false) }}
            style={{ width: '100%', textAlign: 'center', background: '#0d0d1e', border: '1px solid #5b6af0', color: '#fff', borderRadius: 4, fontSize: 14, outline: 'none' }} />
        </foreignObject>
      )}
      {selected && bbox && <rect x={bbox.x} y={bbox.y} width={bbox.w} height={bbox.h} fill="none" stroke="#5b6af0" strokeWidth={1.2} strokeDasharray="4,3" pointerEvents="none" />}
      {selected && (
        isLine
          ? <circle cx={hx} cy={hy} r={6} fill="#fff" stroke="#5b6af0" strokeWidth={1.5} style={{ cursor: 'nwse-resize' }} onMouseDown={startResize} />
          : <rect x={hx - 5} y={hy - 5} width={10} height={10} fill="#fff" stroke="#5b6af0" strokeWidth={1.5} style={{ cursor: 'nwse-resize' }} onMouseDown={startResize} />
      )}
      {selected && (
        <g transform={`translate(${hx + 2},${(bbox ? bbox.y : 0) - 12})`} style={{ cursor: 'pointer' }} onMouseDown={e => { stop(e); onDelete() }}>
          <circle r={8} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.3} />
          <IconGlyph name="close" size={13} color="#f87171" />
        </g>
      )}
      {selected && (d.kind === 'shape' || d.kind === 'text' || isLine) && (
        <foreignObject x={bbox ? bbox.x : 0} y={(bbox ? bbox.y + bbox.h : Math.max(0, hy)) + 8} width={230} height={d.kind === 'shape' ? 58 : 28} style={{ overflow: 'visible' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {d.kind === 'shape' && swatchRow(pickFill, 'F')}
            {(d.kind === 'shape' || isLine) && swatchRow(pickStroke, 'O')}
            {d.kind === 'text' && swatchRow(pickFill, 'F')}
          </div>
        </foreignObject>
      )}
    </g>
  )
}

function DrawPalette({ palette, hasFrames, onStartDrag, onSwitchSlides, onClose }) {
  const emojis = EMOJIS
  const swatch = { display:'flex', flexWrap:'wrap', gap:5 }
  const btn = { width:33, height:33, display:'flex', alignItems:'center', justifyContent:'center', background:'#14142a', border:'1px solid #2a3358', borderRadius:6, cursor:'grab', color:'#c5d0ff', fontSize:17, userSelect:'none' }
  const label = { fontSize:'0.62rem', color:'#7080a0', letterSpacing:'0.08em', margin:'11px 0 5px' }
  return (
    <div style={{ width:212, flexShrink:0, background:'#0d0d1a', borderLeft:'1px solid #1e1e2e', display:'flex', flexDirection:'column', overflow:'hidden' }}
      onMouseDown={e => e.stopPropagation()}>
      <div style={{ display:'flex', alignItems:'center', borderBottom:'1px solid #1e1e2e' }}>
        <div style={{ flex:1, textAlign:'center', padding:'8px 0', fontSize:'0.78rem', fontWeight:700, color:'#c5d0ff', background:'#14142a' }}>✏️ Draw</div>
        {hasFrames && <div onClick={onSwitchSlides} title="Switch to Slides" style={{ padding:'8px 10px', fontSize:'0.78rem', color:'#8090b8', cursor:'pointer' }}>🎞</div>}
        <button onClick={onClose} style={{ background:'transparent', border:'none', color:'#8090b8', cursor:'pointer', fontSize:16, padding:'0 8px' }}>×</button>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'4px 10px 24px' }}>
        <div style={{ fontSize:'0.62rem', color:'#8090b8', lineHeight:1.4, margin:'4px 0' }}>Drag an item onto the canvas.</div>
        <div style={label}>TEXT</div>
        <div style={swatch}><div style={{ ...btn, width:'auto', padding:'0 14px', fontSize:14, fontWeight:700 }} onMouseDown={e => onStartDrag('text',{ text:'Text', size:26, fill:'#ffffff' }, e)}>Text</div></div>
        <div style={label}>EMOJI</div>
        <div style={swatch}>{emojis.map((g,i) => <div key={i} style={{ ...btn, fontSize:19 }} onMouseDown={e => onStartDrag('emoji',{ emoji:g, size:46 }, e)}>{g}</div>)}</div>
      </div>
    </div>
  )
}

// â"€â"€â"€ ImageNode â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Video body — a YouTube <iframe> or an uploaded <video>, honoring the per-video options
// (autoplay/loop/mute/controls/hide-related/start/end/speed). Extracted so it can use refs/effects.
function VideoEmbed({ img, play, previewing, onReady }) {
  const ref = useRef(null)
  const [errCode, setErrCode] = useState(0)
  const [ended, setEnded] = useState(false)   // reached the trim end (or natural end) → freeze the frame, hide all UI
  const curTimeRef = useRef(0)
  const curDurRef = useRef(0)
  const curPlayRef = useRef(false)   // is the player currently playing (for the selected-video scrubber)
  const cutsRef = useRef(img.cuts); cutsRef.current = img.cuts
  const speed = img.speed || 1
  const start = img.start || 0
  const end = (img.end && img.end > start) ? img.end : 0
  useEffect(() => { setErrCode(0) }, [img.src])

  // Autoplay-on-focus: when the media is flagged for zoom/slide autoplay (or "keep playing"), the
  // parent's `play` signal drives play/pause. "Keep playing" auto-starts on mount (muted, per browser
  // policy) without waiting for a click.
  useEffect(() => {
    if (!img.autoplayOnZoom && !img.autoplayOnSlide && !img.keepPlaying) return
    const el = ref.current; if (!el) return
    // Autoplay must play ONLY the trimmed segment [start, end], not the whole video: seek to `start`
    // before (re)starting.
    if (img.videoKind === 'youtube') {
      const cmd = (func, args = []) => { try { el.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*') } catch { /* ignore */ } }
      if (play) {
        // Programmatic play is only allowed MUTED (the parent's keypress gesture doesn't cross into the
        // cross-origin iframe). Mute → seek to trim start → play, retried in case the player isn't ready.
        // Once it's actually playing, retries no-op so a short trim window isn't restarted mid-play.
        const go = () => { if (curPlayRef.current) return; cmd('mute'); if (start) cmd('seekTo', [start, true]); cmd('playVideo') }
        go()
        const t1 = setTimeout(go, 400), t2 = setTimeout(go, 1200)
        return () => { clearTimeout(t1); clearTimeout(t2) }
      } else {
        cmd('pauseVideo')
      }
    } else if (play) {
      // Seek into the trimmed window if we're outside it (past `end`, or before `start`).
      const outside = (start && el.currentTime < start - 0.05) || (end && el.currentTime >= end - 0.05)
      const startPlay = () => { if (start && outside) { try { el.currentTime = start } catch { /* not seekable yet */ } } el.play().catch(() => { /* gesture-gated; ignore */ }) }
      if (el.readyState >= 1) startPlay()
      else { const once = () => { startPlay(); el.removeEventListener('loadedmetadata', once) }; el.addEventListener('loadedmetadata', once) }
    } else {
      el.pause()
    }
  }, [play, img.autoplayOnZoom, img.autoplayOnSlide, img.keepPlaying, img.videoKind, img.src, start, end])

  // Uploaded file: apply playback rate, mute, and trim (start/end) directly on the element.
  useEffect(() => {
    if (img.videoKind === 'youtube') return
    const v = ref.current; if (!v) return
    setEnded(false)
    v.playbackRate = speed
    v.muted = !!img.muted
    const seekStart = () => { if (start) { try { v.currentTime = start } catch { /* not seekable yet */ } } }
    // Freeze on the trim end: pin the frame exactly at `end` and mark ended (which hides all UI).
    const finish = () => { try { if (end) v.currentTime = end } catch { /* ignore */ } v.pause(); setEnded(true) }
    const onTime = () => {
      const tgt = cutSkipTarget(v.currentTime, cutsRef.current)
      if (tgt != null) { try { v.currentTime = tgt } catch { /* ignore */ } return }
      if (end && v.currentTime >= end) {
        if (img.loop) { try { v.currentTime = start } catch { /* ignore */ } v.play().catch(() => {}) }
        else finish()
      }
    }
    const onNativeEnd = () => { if (!img.loop) finish() }         // no trim end → freeze the real last frame too
    const onPlaying = () => setEnded(false)                       // any (re)play clears the frozen state
    v.addEventListener('loadedmetadata', seekStart)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('ended', onNativeEnd)
    v.addEventListener('play', onPlaying)
    if (v.readyState >= 1) seekStart()
    return () => { v.removeEventListener('loadedmetadata', seekStart); v.removeEventListener('timeupdate', onTime); v.removeEventListener('ended', onNativeEnd); v.removeEventListener('play', onPlaying) }
  }, [speed, img.muted, start, end, img.loop, img.videoKind, img.src])

  // YouTube: playback speed can't be set by URL param — poke the player via the JS API postMessage
  // once it's initialized, and again whenever the speed (or a src-changing option) changes.
  useEffect(() => {
    if (img.videoKind !== 'youtube') return
    const f = ref.current; if (!f) return
    const send = () => { try { f.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'setPlaybackRate', args: [speed] }), '*') } catch { /* ignore */ } }
    const t1 = setTimeout(send, 1200), t2 = setTimeout(send, 2600)   // cover slow player init
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [speed, img.videoKind, img.youtubeId, img.autoplay, img.muted, img.loop, img.controls, img.hideRelated, img.start, img.end])

  // Watchdog for a trimmed END: YouTube's own `end` URL param is unreliable with autoplay (and won't
  // fire after a scrub), so we enforce the end ourselves. This must NOT depend on catching a single
  // handshake at the right moment (the player init timing varies, and a missed handshake meant the whole
  // video played). Instead: an interval keeps (re)starting the state stream until currentTime is flowing,
  // then polls it and pauses/loops at the trim end. `curTimeRef` is kept fresh by the handle effect below.
  useEffect(() => {
    if (img.videoKind !== 'youtube' || previewing) return   // while previewing, the trim scrubber drives it
    const endT = (img.end && img.end > (img.start || 0)) ? img.end : 0
    if (!endT) return
    const f = ref.current; if (!f) return
    const post = (msg) => { try { f.contentWindow?.postMessage(JSON.stringify(msg), '*') } catch { /* ignore */ } }
    const startStream = () => post({ event: 'listening', id: 1, channel: 'widget' })
    let streaming = false
    const onMsg = (e) => { if (e.source === f.contentWindow) streaming = true }   // any message ⇒ the stream is live
    window.addEventListener('message', onMsg)
    const iv = setInterval(() => {
      if (!streaming) startStream()          // keep knocking until the player answers
      const t = curTimeRef.current
      if (t >= endT - 0.2) {
        if (img.loop) { post({ event: 'command', func: 'seekTo', args: [img.start || 0, true] }); post({ event: 'command', func: 'playVideo', args: [] }) }
        else post({ event: 'command', func: 'pauseVideo', args: [] })
      }
    }, 200)
    return () => { clearInterval(iv); window.removeEventListener('message', onMsg) }
  }, [img.videoKind, img.youtubeId, img.start, img.end, img.loop, previewing])

  // Expose a control handle (seek/play/pause/time/duration) so the trim scrubber can preview the
  // start/end on the node itself. A persistent infoDelivery listener tracks currentTime + duration.
  useEffect(() => {
    if (img.videoKind !== 'youtube') return
    const f = ref.current; if (!f) return
    const post = (m) => { try { f.contentWindow?.postMessage(JSON.stringify(m), '*') } catch { /* ignore */ } }
    const cmd = (func, args = []) => post({ event: 'command', func, args })
    // Kick the state stream repeatedly until it's flowing — player init timing varies, and a single
    // handshake was easy to miss (which left currentTime/duration at 0: no trim enforcement, no trim slider).
    const listen = () => post({ event: 'listening', id: 1, channel: 'widget' })
    let got = false
    const timers = [setTimeout(listen, 200), setTimeout(listen, 600), setTimeout(listen, 1200), setTimeout(listen, 2200), setTimeout(listen, 3500)]
    const onMsg = (e) => {
      if (e.source !== f.contentWindow) return
      if (!got) { got = true; listen() }   // player is alive → confirm the stream
      let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data } catch { return }
      if (d?.event === 'infoDelivery' && d.info) {
        if (typeof d.info.currentTime === 'number') {
          curTimeRef.current = d.info.currentTime
          const tgt = cutSkipTarget(d.info.currentTime, cutsRef.current)
          if (tgt != null) cmd('seekTo', [tgt, true])   // snip: jump over a cut range
        }
        if (typeof d.info.duration === 'number' && d.info.duration) curDurRef.current = d.info.duration
        if (typeof d.info.playerState === 'number') curPlayRef.current = (d.info.playerState === 1)
      }
    }
    window.addEventListener('message', onMsg)
    onReady?.({
      seek: (s) => cmd('seekTo', [s, true]),
      play: () => cmd('playVideo'),
      pause: () => cmd('pauseVideo'),
      setRate: (r) => cmd('setPlaybackRate', [r]),
      time: () => curTimeRef.current,
      duration: () => curDurRef.current,
      playing: () => curPlayRef.current,
    })
    return () => { timers.forEach(clearTimeout); window.removeEventListener('message', onMsg) }
  }, [img.videoKind, img.youtubeId, previewing]) // eslint-disable-line

  // File video: expose the same control handle so the selected-video scrubber (and the trim-edit
  // preview) can drive it. currentTime/duration stay fresh via the element's own events.
  useEffect(() => {
    if (img.videoKind === 'youtube') return
    const v = ref.current; if (!v) return
    const sync = () => { curTimeRef.current = v.currentTime || 0; curDurRef.current = v.duration || 0; curPlayRef.current = !v.paused }
    v.addEventListener('timeupdate', sync)
    v.addEventListener('durationchange', sync)
    v.addEventListener('loadedmetadata', sync)
    v.addEventListener('play', sync)
    v.addEventListener('pause', sync)
    onReady?.({
      seek: (s) => { try { v.currentTime = s } catch { /* not seekable yet */ } },
      play: () => v.play().catch(() => { /* gesture-gated */ }),
      pause: () => v.pause(),
      setRate: (r) => { v.playbackRate = r },
      time: () => v.currentTime || 0,
      duration: () => v.duration || 0,
      playing: () => !v.paused,
    })
    return () => { v.removeEventListener('timeupdate', sync); v.removeEventListener('durationchange', sync); v.removeEventListener('loadedmetadata', sync); v.removeEventListener('play', sync); v.removeEventListener('pause', sync) }
  }, [img.videoKind, img.src, previewing]) // eslint-disable-line

  if (img.videoKind === 'youtube') {
    // While previewing, hold the src stable (drop start/end so a trim edit doesn't reload the iframe —
    // the scrubber seeks via the handle instead).
    const embedImg = previewing ? { ...img, start: 0, end: 0 } : img
    // Shrink YouTube's (cross-origin, un-styleable) controls: render the iframe at a large LOGICAL size
    // so YouTube draws desktop-proportion controls, then scale it down to fill the box. Controls end up
    // a small, consistent fraction of the video regardless of its on-canvas size/zoom.
    const bw = Math.max(1, img.width || 320), bh = Math.max(1, img.height || 180)
    const LW = 900, LH = Math.max(1, Math.round(LW * bh / bw)), s = bw / LW
    return <iframe ref={ref} src={youtubeEmbedUrl(embedImg)}
      style={{ width: LW, height: LH, border: 0, display: 'block', transformOrigin: 'top left', transform: `scale(${s})` }}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title="YouTube video" />
  }
  if (errCode) {
    // Say the TRUE reason — don't blame the format for what's really a lost/unpersisted file.
    const src = img.src || ''
    const isBlob = src.startsWith('blob:')          // a temporary in-browser URL that didn't survive reload
    const ext = src.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase()
    const UNSUPPORTED = ['avi', 'wmv', 'mkv', 'flv', 'mpg', 'mpeg', 'm2ts', 'ts', 'ogv', '3gp', 'rm', 'vob']
    const badFormat = !isBlob && ext && ext.length <= 5 && UNSUPPORTED.includes(ext)
    let icon = '⚠️', title, hint
    if (isBlob) { title = 'This video wasn’t saved'; hint = 'The upload didn’t finish — usually because the file is over the 50 MB limit. Re-add a smaller clip, or paste a YouTube link.' }
    else if (badFormat) { icon = '🎞️'; title = `.${ext.toUpperCase()} can’t play in browsers`; hint = 'Convert it to MP4 (H.264), WebM, or Ogg and re-add it.' }
    else { title = 'Couldn’t load this video'; hint = 'It may be too large, still uploading, or unavailable. Try reloading — or use a YouTube link.' }
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12, boxSizing: 'border-box', background: '#161a2e', color: '#c5d0ff', textAlign: 'center', fontFamily: '-apple-system, sans-serif' }}>
        <div style={{ fontSize: 22 }}>{icon}</div>
        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: 11, color: '#8fa0d8', lineHeight: 1.35 }}>{hint}</div>
        {!isBlob && <a href={src} target="_blank" rel="noopener noreferrer" onMouseDown={e => e.stopPropagation()}
          style={{ fontSize: 11, color: '#7c8cff', marginTop: 2 }}>Open original</a>}
      </div>
    )
  }
  // When ended, show NOTHING but the frozen frame — no controls, no chrome. Clicking it (invisible
  // affordance, no visible UI) rewinds to the trim start and replays.
  const replay = () => { const v = ref.current; if (!v) return; try { v.currentTime = start } catch { /* ignore */ } setEnded(false); v.play().catch(() => {}) }
  return <video ref={ref} src={img.src} playsInline preload="metadata"
    onError={e => setErrCode(e.currentTarget?.error?.code || 4)}
    onClick={ended ? (e => { e.stopPropagation(); replay() }) : undefined}
    controls={img.controls !== false && !ended} autoPlay={!!img.autoplay} loop={!!img.loop && !end} muted={!!img.muted}
    style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', display: 'block', cursor: ended ? 'pointer' : 'default' }} />
}

// contentEditable rich-text surface for a canvas Text element. Sets innerHTML from `html` on mount and
// when it changes externally (never while focused, so the caret isn't disturbed); saves on input.
function RichTextBox({ html, editable, selected, bgColor, borderColor, textShadow, halo, fontScale = 1, valign = 'top', zoomK = 1, onChange, onResize }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current; if (!el) return
    if (document.activeElement !== el && el.innerHTML !== (html || '')) el.innerHTML = html || ''
  }, [html])
  useEffect(() => { if (editable) requestAnimationFrame(() => ref.current?.focus()) }, [editable])
  const shadows = []
  if (halo) { const c = typeof halo === 'string' ? halo : 'rgba(0,0,0,0.9)'; shadows.push(`0 0 2px ${c}`, `0 0 2px ${c}`, `0 0 5px ${c}`) }
  if (textShadow) shadows.push('2px 2px 4px rgba(0,0,0,0.55)')
  const justify = valign === 'middle' ? 'center' : valign === 'bottom' ? 'flex-end' : 'flex-start'
  // Handle size: constant on screen (counter-scale the canvas zoom), clamped so it stays grabbable.
  const hz = Math.max(7, Math.min(46, 11 / (zoomK || 1)))
  const hzHalf = hz / 2
  const handle = (extra) => ({ position: 'absolute', background: '#fff', border: `${Math.max(1, 1.4 / (zoomK || 1))}px solid #5b6af0`, borderRadius: hz * 0.16, zIndex: 6, ...extra })
  const edgeThick = Math.max(6, Math.min(40, 9 / (zoomK || 1)))
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', background: bgColor || 'transparent',
      border: borderColor ? `1.5px solid ${borderColor}` : 'none', outline: editable ? '1px solid #5b6af0' : 'none', borderRadius: 4, overflow: 'visible' }}>
      <div ref={ref} data-richtext="true" contentEditable={editable} suppressContentEditableWarning
        onInput={() => onChange?.(ref.current?.innerHTML || '')}
        onMouseDown={e => { if (editable) e.stopPropagation() }}
        onKeyDown={e => e.stopPropagation()}
        onPaste={e => { e.preventDefault(); const t = e.clipboardData?.getData('text/plain') || ''; document.execCommand('insertText', false, t) }}
        style={{ position: 'absolute', inset: 0, boxSizing: 'border-box', padding: '6px 8px',
          display: 'flex', flexDirection: 'column', justifyContent: justify,
          color: '#e8ecff', fontFamily: '-apple-system, sans-serif', fontSize: Math.max(6, 15 * (fontScale || 1)), lineHeight: 1.35, textShadow: shadows.join(', ') || 'none',
          overflow: 'hidden', cursor: editable ? 'text' : 'move', pointerEvents: editable ? 'auto' : 'none', userSelect: editable ? 'text' : 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} />
      {selected && onResize && (<>
        {/* Right edge — reflow width only (no font change) */}
        <div title="Drag to set width" onMouseDown={e => onResize('textwidth', e)}
          style={{ position: 'absolute', top: 8, bottom: 8, right: -edgeThick / 2, width: edgeThick, cursor: 'ew-resize', zIndex: 5 }} />
        {/* Bottom edge — reflow height only */}
        <div title="Drag to set height" onMouseDown={e => onResize('textheight', e)}
          style={{ position: 'absolute', left: 8, right: 8, bottom: -edgeThick / 2, height: edgeThick, cursor: 'ns-resize', zIndex: 5 }} />
        {/* Bottom-right square — scale box + text together */}
        <div title="Drag to scale box and text" onMouseDown={e => onResize('textscale', e)}
          style={handle({ right: -hzHalf, bottom: -hzHalf, width: hz, height: hz, cursor: 'nwse-resize' })} />
      </>)}
    </div>
  )
}

// Screen-space formatting toolbar for the selected Text element. It tracks the last text selection inside
// any rich-text box (opening a <select> or color picker steals focus, which would otherwise lose the
// selection execCommand needs), then restores that range before running each command.
const TEXT_FONTS = [
  { label: 'System', exec: '-apple-system, BlinkMacSystemFont, sans-serif' },
  { label: 'Inter', exec: 'Inter, sans-serif' },
  { label: 'Roboto', exec: 'Roboto, sans-serif' },
  { label: 'Poppins', exec: 'Poppins, sans-serif' },
  { label: 'Montserrat', exec: 'Montserrat, sans-serif' },
  { label: 'Georgia', exec: 'Georgia, serif' },
  { label: 'Playfair Display', exec: '"Playfair Display", serif' },
  { label: 'Merriweather', exec: 'Merriweather, serif' },
  { label: 'Lora', exec: 'Lora, serif' },
  { label: 'JetBrains Mono', exec: '"JetBrains Mono", monospace' },
  { label: 'Courier', exec: '"Courier New", monospace' },
  { label: 'Bebas Neue', exec: '"Bebas Neue", sans-serif' },
  { label: 'Pacifico', exec: 'Pacifico, cursive' },
  { label: 'Caveat', exec: 'Caveat, cursive' },
]
function TextFormatToolbar({ left, top, box, onBoxStyle }) {
  const savedRange = useRef(null)
  useEffect(() => {
    const onSel = () => {
      const s = window.getSelection()
      if (!s || !s.rangeCount || !s.anchorNode) return
      const el = s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode
      if (el?.closest?.('[data-richtext]')) savedRange.current = s.getRangeAt(0).cloneRange()
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])
  const exec = (cmd, val) => {
    const r = savedRange.current
    const node = r && (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer)
    const editable = node?.closest?.('[data-richtext]')
    if (editable) editable.focus()
    if (r) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(r) }
    try { document.execCommand('styleWithCSS', false, true) } catch { /* */ }
    document.execCommand(cmd, false, val)
    if (editable) editable.dispatchEvent(new Event('input', { bubbles: true }))
    const s2 = window.getSelection(); if (s2 && s2.rangeCount) savedRange.current = s2.getRangeAt(0).cloneRange()
  }
  // Font size in px. Stored as `em` relative to the 15px base so it scales with the box's corner handle.
  const applyFontSize = (px) => {
    const r = savedRange.current; if (!r || r.collapsed) return
    const node = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer
    const editable = node?.closest?.('[data-richtext]'); if (!editable) return
    editable.focus()
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    const span = document.createElement('span'); span.style.fontSize = (px / 15).toFixed(3) + 'em'
    try { span.appendChild(r.extractContents()); r.insertNode(span) } catch { return }
    const nr = document.createRange(); nr.selectNodeContents(span); s.removeAllRanges(); s.addRange(nr)
    savedRange.current = nr.cloneRange()
    editable.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const btn = { background: 'transparent', border: 'none', color: '#c5d0ff', cursor: 'pointer', fontSize: 13, padding: '3px 6px', borderRadius: 4, lineHeight: 1 }
  const selStyle = { background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 4, fontSize: 11, padding: '2px 3px', cursor: 'pointer' }
  const sep = <span style={{ width: 1, height: 18, background: '#2d3a6a', margin: '0 3px' }} />
  const keep = e => e.preventDefault()   // buttons keep the editable focused
  return (
    <div style={{ position: 'absolute', left, top, transform: 'translate(-50%,-100%)', zIndex: 40, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', maxWidth: 480,
      background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '4px 6px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)', fontFamily: '-apple-system, sans-serif' }}>
      <button style={{ ...btn, fontWeight: 800 }} onMouseDown={keep} title="Bold" onClick={() => exec('bold')}>B</button>
      <button style={{ ...btn, fontStyle: 'italic' }} onMouseDown={keep} title="Italic" onClick={() => exec('italic')}>I</button>
      <button style={{ ...btn, textDecoration: 'underline' }} onMouseDown={keep} title="Underline" onClick={() => exec('underline')}>U</button>
      <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Text color">A
        <input type="color" defaultValue="#e8ecff" onInput={e => exec('foreColor', e.target.value)} style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} /></label>
      {sep}
      <select title="Font" value="" onChange={e => exec('fontName', e.target.value)} style={selStyle}>
        <option value="" disabled>Font</option>
        {TEXT_FONTS.map(f => <option key={f.label} value={f.exec} style={{ fontFamily: f.exec }}>{f.label}</option>)}
      </select>
      <select title="Text size (px)" value="" onChange={e => applyFontSize(Number(e.target.value))} style={selStyle}>
        <option value="" disabled>Size</option>
        {[10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96].map(v => <option key={v} value={v}>{v}</option>)}
      </select>
      {sep}
      <button style={btn} onMouseDown={keep} title="Align left" onClick={() => exec('justifyLeft')}>⯇</button>
      <button style={btn} onMouseDown={keep} title="Align center" onClick={() => exec('justifyCenter')}>≡</button>
      <button style={btn} onMouseDown={keep} title="Align right" onClick={() => exec('justifyRight')}>⯈</button>
      {sep}
      <button style={btn} onMouseDown={keep} title="Bulleted list" onClick={() => exec('insertUnorderedList')}>•</button>
      <button style={btn} onMouseDown={keep} title="Numbered list" onClick={() => exec('insertOrderedList')}>1.</button>
      <button style={btn} onMouseDown={keep} title="Link" onClick={() => { const u = window.prompt('Link URL:'); if (u) exec('createLink', u) }}>🔗</button>
      {sep}
      {/* Box-level styles (whole text element) */}
      <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Background color">▧
        <input type="color" value={box?.bgColor && box.bgColor !== 'none' ? box.bgColor : '#12122a'} onInput={e => onBoxStyle?.({ bgColor: e.target.value })} style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} /></label>
      {box?.bgColor && box.bgColor !== 'none' && <button style={{ ...btn, fontSize: 10, color: '#8fa0d8' }} onMouseDown={keep} title="No background" onClick={() => onBoxStyle?.({ bgColor: null })}>✕bg</button>}
      <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Border color">▢
        <input type="color" value={box?.borderColor || '#5b6af0'} onInput={e => onBoxStyle?.({ borderColor: e.target.value })} style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} /></label>
      {box?.borderColor && <button style={{ ...btn, fontSize: 10, color: '#8fa0d8' }} onMouseDown={keep} title="No border" onClick={() => onBoxStyle?.({ borderColor: null })}>✕bd</button>}
      <button style={{ ...btn, background: box?.textShadow ? '#232a5c' : 'transparent' }} onMouseDown={keep} title="Drop shadow" onClick={() => onBoxStyle?.({ textShadow: !box?.textShadow })}>⌵</button>
      <button style={{ ...btn, background: box?.halo ? '#232a5c' : 'transparent' }} onMouseDown={keep} title="Halo (outline glow for legibility)" onClick={() => onBoxStyle?.({ halo: !box?.halo })}>◎</button>
      {sep}
      {/* Vertical alignment (whole box) */}
      <button style={{ ...btn, background: (box?.valign || 'top') === 'top' ? '#232a5c' : 'transparent' }} onMouseDown={keep} title="Align text to top" onClick={() => onBoxStyle?.({ valign: 'top' })}>⤒</button>
      <button style={{ ...btn, background: box?.valign === 'middle' ? '#232a5c' : 'transparent' }} onMouseDown={keep} title="Center vertically" onClick={() => onBoxStyle?.({ valign: 'middle' })}>⇔</button>
      <button style={{ ...btn, background: box?.valign === 'bottom' ? '#232a5c' : 'transparent' }} onMouseDown={keep} title="Align text to bottom" onClick={() => onBoxStyle?.({ valign: 'bottom' })}>⤓</button>
    </div>
  )
}

function ImageNode({ img, isSelected, isCropping, onMouseDown, onCaption, mediaPlay, onToggleMedia, onMediaTitle, onEditVideo, previewing, onPlayerReady, onTextChange, zoomK = 1 }) {
  const { id, src, x, y, width, height, rotation, bgColor } = img
  const isVideo = img.type === 'video'
  const isAudio = img.type === 'audio'
  const isText = img.type === 'text'
  // Video player is "pass-through" (canvas pan/zoom work over it) until the user activates it. A
  // YouTube iframe otherwise swallows the scroll wheel so the canvas can't zoom over it (Miro-style).
  const [videoActive, setVideoActive] = useState(false)
  useEffect(() => { if (!isSelected) setVideoActive(false) }, [isSelected])
  // YouTube videos show a clean, user-pickable POSTER frame (no YouTube chrome) until played — we
  // only mount the iframe on demand. `playing` is set by the play button / double-click / autoplay.
  const isYT = isVideo && img.videoKind === 'youtube'
  const [playing, setPlaying] = useState(false)
  useEffect(() => { if (!isSelected && !mediaPlay && !img.keepPlaying) setPlaying(false) }, [isSelected, mediaPlay, img.keepPlaying])
  const ytPoster = isYT && img.youtubeId ? `https://img.youtube.com/vi/${img.youtubeId}/hqdefault.jpg` : null
  const posterSrc = (isVideo && img.poster) || ytPoster
  const ytPosterMode = isYT && !(playing || mediaPlay || previewing || img.keepPlaying)   // poster shown; iframe not yet mounted
  // "Keep playing" mounts the player and never reverts to the poster on focus change.
  useEffect(() => { if (img.keepPlaying && isYT) setPlaying(true) }, [img.keepPlaying, isYT])
  // Selected-video scrubber: a play/pause button + progress slider shown while the video is SELECTED
  // (no hover, no Edit dialog needed) so you can preview the clip. Driven by the live player handle
  // that VideoEmbed hands us; polled while selected so the slider tracks playback.
  const playHandleRef = useRef(null)
  const [scrub, setScrub] = useState({ t: 0, d: 0, playing: false })
  useEffect(() => {
    if (!isVideo || !isSelected || previewing) return
    const poll = () => { const h = playHandleRef.current; if (h) setScrub({ t: h.time?.() || 0, d: h.duration?.() || 0, playing: !!h.playing?.() }) }
    poll()
    const iv = setInterval(poll, 200)
    return () => clearInterval(iv)
  }, [isVideo, isSelected, previewing])
  const isLink = img.type === 'link'
  // Audio autoplay: when a card is flagged for zoom/slide autoplay, the parent's `audioPlay` signal
  // drives play/pause. Manual native controls still work when neither flag is on.
  const audioRef = useRef(null)
  useEffect(() => {
    if (!isAudio) return
    const a = audioRef.current; if (!a) return
    if (!img.autoplayOnZoom && !img.autoplayOnSlide) return
    if (mediaPlay) a.play().catch(() => { /* gesture-gated; ignore */ })
    else a.pause()
  }, [isAudio, mediaPlay, img.autoplayOnZoom, img.autoplayOnSlide, img.src])
  const hw = width / 2, hh = height / 2

  // Crop rect (normalised source rect → local box coords). Defaults to the whole box.
  const crop = img.crop || { x: 0, y: 0, w: 1, h: 1 }
  const hasCrop = crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1
  const cx = -hw + width * crop.x, cy = -hh + height * crop.y
  const cw = width * crop.w, ch = height * crop.h
  const clipId = `fimg-clip-${id}`
  const blur = img.blur || 0
  const blurId = `fimg-blur-${id}`
  // Edge blur feathers ONLY the photo's outer edges (a blurred alpha mask), leaving the
  // interior sharp — distinct from `blur`, which softens the whole image. The two combine.
  const edgeBlur = img.edgeBlur || 0
  const edgeMaskId = `fimg-edgemask-${id}`
  const edgeFilterId = `fimg-edgefilter-${id}`

  // Visual effects: transparency + colorize (a tint whose hue+chroma replace the photo's via the
  // 'color' blend mode, keeping its luminance → classic duotone-style recolor). Both are animatable
  // across frame stages. Applied as a wrapping opacity + an isolated overlay rect over the image.
  const photoOpacity = img.opacity == null ? 1 : img.opacity
  const photoTint = img.tint && img.tint.amount > 0 ? img.tint : null
  const renderPhotoBody = (clipAttr) => photoTint ? (
    <g clipPath={clipAttr} style={{ isolation: 'isolate' }}>
      <image href={src} x={-hw} y={-hh} width={width} height={height} />
      <rect x={cx} y={cy} width={cw} height={ch} fill={photoTint.color}
        opacity={Math.max(0, Math.min(1, photoTint.amount))}
        style={{ mixBlendMode: 'color', pointerEvents: 'none' }} />
    </g>
  ) : (
    <image href={src} x={-hw} y={-hh} width={width} height={height} clipPath={clipAttr} />
  )

  // Visible-rect geometry drives the selection chrome (so handles hug the cropped area).
  const vL = cx, vT = cy, vR = cx + cw, vB = cy + ch
  const HS = 5  // half-size of square handles (px in local space)
  const SQ = { width: HS * 2, height: HS * 2, fill: '#fff', stroke: '#5b6af0', strokeWidth: 1.5 }

  const corners = [
    ['tl', vL, vT, 'nwse-resize'], ['tr', vR, vT, 'nesw-resize'],
    ['bl', vL, vB, 'nesw-resize'], ['br', vR, vB, 'nwse-resize'],
  ]
  const medians = [
    ['t', (vL + vR) / 2, vT, 'ns-resize'], ['b', (vL + vR) / 2, vB, 'ns-resize'],
    ['l', vL, (vT + vB) / 2, 'ew-resize'], ['r', vR, (vT + vB) / 2, 'ew-resize'],
  ]

  return (
    <g transform={`translate(${x},${y}) rotate(${rotation})`}
      data-img="true" data-imgid={id}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => { if (e.button !== 0 || isCropping) return; e.stopPropagation(); onMouseDown(e, id) }}
      onDoubleClick={(!isVideo && !isLink && img.type !== 'audio' && !isCropping) ? (e => { e.stopPropagation(); onCaption?.() }) : undefined}
      style={{ cursor: isCropping ? 'default' : 'move' }}
    >
      {(hasCrop || blur > 0 || edgeBlur > 0) && (
        <defs>
          {hasCrop && <clipPath id={clipId}><rect x={cx} y={cy} width={cw} height={ch} /></clipPath>}
          {blur > 0 && (
            <filter id={blurId} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur in="SourceGraphic" stdDeviation={blur} colorInterpolationFilters="sRGB" />
            </filter>
          )}
          {edgeBlur > 0 && (() => {
            // Deterministic edge feather: a white interior with four black→transparent
            // gradient strips that eat each edge to fully transparent over `edgeBlur` px.
            // Symmetric on both axes (the old blurred-inset-rect mask under-feathered the
            // short axis of tall/wide photos, leaving left/right looking hard). The strips
            // composite multiplicatively, so corners fade cleanly.
            const fx = Math.min(edgeBlur, cw / 2)   // horizontal feather width (clamped)
            const fy = Math.min(edgeBlur, ch / 2)   // vertical feather width
            const gL = `${edgeFilterId}-l`, gR = `${edgeFilterId}-r`
            const gT = `${edgeFilterId}-t`, gB = `${edgeFilterId}-b`
            return (<>
              <linearGradient id={gL} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#000" stopOpacity="1" /><stop offset="1" stopColor="#000" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={gR} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity="1" />
              </linearGradient>
              <linearGradient id={gT} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#000" stopOpacity="1" /><stop offset="1" stopColor="#000" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={gB} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity="1" />
              </linearGradient>
              <mask id={edgeMaskId} maskUnits="userSpaceOnUse" x={cx} y={cy} width={cw} height={ch}>
                <rect x={cx} y={cy} width={cw} height={ch} fill="#fff" />
                <rect x={cx} y={cy} width={fx} height={ch} fill={`url(#${gL})`} />
                <rect x={cx + cw - fx} y={cy} width={fx} height={ch} fill={`url(#${gR})`} />
                <rect x={cx} y={cy} width={cw} height={fy} fill={`url(#${gT})`} />
                <rect x={cx} y={cy + ch - fy} width={cw} height={fy} fill={`url(#${gB})`} />
              </mask>
            </>)
          })()}
        </defs>
      )}
      {bgColor && <rect x={cx} y={cy} width={cw} height={ch} fill={bgColor} rx={2}
        mask={edgeBlur > 0 ? `url(#${edgeMaskId})` : undefined} />}
      {isLink ? (
        // Link-preview card ("unfurled" URL). pointer-events on only when selected → an unselected
        // card still selects/drags via the parent <g>; when selected, clicking opens the URL.
        <foreignObject x={-hw} y={-hh} width={width} height={height} style={{ overflow: 'visible' }}>
          <a href={isSelected ? img.url : undefined} target="_blank" rel="noopener noreferrer"
            onClick={e => { if (!isSelected) e.preventDefault() }} onMouseDown={e => { if (isSelected) e.stopPropagation() }}
            title={isSelected ? `Open ${img.url}` : img.url}
            style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', boxSizing: 'border-box',
              background: '#161a2e', border: '1px solid #2d3a6a', borderRadius: 10, overflow: 'hidden', textDecoration: 'none',
              boxShadow: '0 4px 16px rgba(0,0,0,0.45)', pointerEvents: isSelected ? 'auto' : 'none', fontFamily: '-apple-system, sans-serif',
              cursor: isSelected ? 'pointer' : 'move' }}>
            {img.image && <div style={{ width: '100%', flex: '1 1 auto', minHeight: 0, background: `#0c0c1a center/cover no-repeat url("${img.image}")` }} />}
            <div style={{ flex: '0 0 auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#dbe4ff', lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {img.loading ? 'Loading preview…' : (img.title || img.url)}
              </div>
              {img.description && <div style={{ fontSize: 11, color: '#9aa6c8', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{img.description}</div>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
                {img.favicon && <img src={img.favicon} alt="" width={13} height={13} style={{ borderRadius: 2, flexShrink: 0 }} onError={e => { e.currentTarget.style.display = 'none' }} />}
                <span style={{ fontSize: 10.5, color: '#7c8cff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{img.siteName || img.url}</span>
              </div>
            </div>
          </a>
        </foreignObject>
      ) : isText ? (
        // Rich text box — a contentEditable card. Editable when selected; pass-through otherwise so the
        // canvas pans/zooms over it. Content (HTML) saved on input.
        <foreignObject x={-hw} y={-hh} width={width} height={height} style={{ overflow: 'visible' }}>
          <RichTextBox html={img.html} editable={isSelected} selected={isSelected} bgColor={bgColor}
            borderColor={img.borderColor} textShadow={img.textShadow} halo={img.halo} fontScale={img.fontScale}
            valign={img.valign} zoomK={zoomK}
            onChange={html => onTextChange?.(html)} onResize={(mode, e) => onMouseDown(e, id, mode)} />
        </foreignObject>
      ) : (isVideo && ytPosterMode) ? (
        // YouTube poster frame — our OWN image (default: the video thumbnail; overridable via the
        // edit dialog), with a play button + title bar drawn by us. No YouTube iframe is mounted yet,
        // so there is zero YouTube chrome. It's pass-through, so the canvas pans/zooms over it; the
        // play button (SVG, below) and double-click both mount the player.
        <>
          {posterSrc
            ? <image href={posterSrc} x={-hw} y={-hh} width={width} height={height} preserveAspectRatio="xMidYMid slice"
                style={{ pointerEvents: 'none' }} onError={e => { e.currentTarget.style.display = 'none' }} />
            : <rect x={-hw} y={-hh} width={width} height={height} rx={4} fill="#0b0b18" style={{ pointerEvents: 'none' }} />}
        </>
      ) : isVideo ? (
        // Player mounted (played, autoplaying, or a file video). Stays pass-through (canvas zoom/pan work
        // OVER it — a cross-origin YouTube iframe would otherwise eat the wheel) until ARMED via
        // videoActive (double-click). Playback is driven by our own scrubber, so arming is only needed for
        // the native player controls.
        <foreignObject x={-hw} y={-hh} width={width} height={height} style={{ overflow: 'hidden' }}>
          <div style={{ width: '100%', height: '100%', borderRadius: 4, overflow: 'hidden', background: '#000', pointerEvents: (isSelected && videoActive && !previewing) ? 'auto' : 'none' }}>
            <VideoEmbed img={isYT ? { ...img, autoplay: true, hideRelated: true } : img} play={mediaPlay || !!img.keepPlaying} previewing={previewing}
              onReady={h => { playHandleRef.current = h; if (previewing) onPlayerReady?.(h) }} />
          </div>
        </foreignObject>
      ) : isAudio ? (
        // Audio card. Native controls are interactive when selected; otherwise pass-through so the
        // canvas pans/zooms over it (a transparent hit rect below selects/drags it).
        <foreignObject x={-hw} y={-hh} width={width} height={height} style={{ overflow: 'hidden' }}>
          <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: '#14142a',
            border: `1px solid ${mediaPlay ? '#4ade80' : '#2d3a6a'}`, borderRadius: 10, overflow: 'hidden',
            display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, sans-serif',
            pointerEvents: isSelected ? 'auto' : 'none' }}>
            <div onDoubleClick={e => { e.stopPropagation(); onMediaTitle?.() }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px 3px', minHeight: 0 }}>
              <span style={{ fontSize: 15, color: '#8ab4ff' }}>♪</span>
              <span style={{ fontSize: 12.5, color: '#c5d0ff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{img.title || 'Audio'}</span>
            </div>
            <div style={{ padding: '0 8px 8px', marginTop: 'auto' }}>
              <audio ref={audioRef} controls src={img.src} style={{ width: '100%', height: 32 }}
                onMouseDown={e => { if (isSelected) e.stopPropagation() }} />
            </div>
          </div>
        </foreignObject>
      ) : (<>
      {/* While cropping, show the full image dimmed so trimmed areas stay visible */}
      {isCropping && (
        <image href={src} x={-hw} y={-hh} width={width} height={height} opacity={0.3}
          style={{ pointerEvents: 'none' }} />
      )}
      <g opacity={photoOpacity !== 1 ? photoOpacity : undefined}>
        {blur > 0 ? (
          <g filter={`url(#${blurId})`} mask={edgeBlur > 0 ? `url(#${edgeMaskId})` : undefined}>
            {renderPhotoBody(hasCrop ? `url(#${clipId})` : undefined)}
          </g>
        ) : edgeBlur > 0 ? (
          <g mask={`url(#${edgeMaskId})`}>
            {renderPhotoBody(hasCrop ? `url(#${clipId})` : undefined)}
          </g>
        ) : (
          renderPhotoBody(hasCrop ? `url(#${clipId})` : undefined)
        )}
      </g>
      </>)}

      {/* Transparent hit target for videos/links: their body is pointer-events:none until activated,
          which otherwise lets clicks (incl. ctrl-click to multi-select) fall through instead of hitting
          the node. This rect gives a solid surface; mousedown bubbles to the <g>'s handler. Omitted
          while the player is active (so its controls work) or when a link is selected (so it's clickable). */}
      {((isVideo && !(isSelected && videoActive)) || (isLink && !isSelected) || (isAudio && !isSelected) || (isText && !isSelected)) && (
        <rect x={-hw} y={-hh} width={width} height={height} fill="transparent"
          onDoubleClick={isVideo ? (e => { e.stopPropagation(); if (isYT) setPlaying(true); setVideoActive(true) }) : undefined}
          style={{ cursor: 'move' }}>
          {isVideo && <title>{img.title ? `${img.title} — double-click to interact` : 'Double-click to interact'}</title>}
        </rect>
      )}

      {/* Play button on the YouTube poster — always visible so an unselected poster reads as a video.
          Clicking it mounts the player (a real user gesture, so it plays with sound). */}
      {isVideo && ytPosterMode && (() => {
        // Size proportional to the video so a small (or small+zoomed-in) clip gets small controls.
        const R = Math.max(3, Math.min(cw, ch) * 0.18)
        return (
          <g onMouseDown={e => { e.stopPropagation(); setPlaying(true) }} style={{ cursor: 'pointer' }}>
            <circle cx={0} cy={0} r={R} fill="rgba(8,8,20,0.55)" stroke="#fff" strokeWidth={Math.max(0.4, R * 0.05)} />
            <path d={`M ${-R * 0.32} ${-R * 0.5} L ${-R * 0.32} ${R * 0.5} L ${R * 0.6} 0 Z`} fill="#fff" />
          </g>
        )
      })()}

      {/* Editable title bar across the top of the poster — rendered ON TOP of the hit rect so its
          double-click (rename) wins over the poster's double-click (play). Scales with the video size. */}
      {isVideo && ytPosterMode && (img.title || isSelected) && (() => {
        const barH = Math.max(6, Math.min(26, height * 0.15))
        const fs = barH * 0.6
        const maxCh = Math.max(4, Math.floor((width - fs) / (fs * 0.56)))
        return (
          <g onMouseDown={e => e.stopPropagation()} onDoubleClick={e => { e.stopPropagation(); onMediaTitle?.() }} style={{ cursor: onMediaTitle ? 'text' : 'default' }}>
            <rect x={-hw} y={-hh} width={width} height={barH} fill="rgba(8,8,20,0.62)" />
            <text x={-hw + fs * 0.55} y={-hh + barH * 0.72} fontSize={fs} fill="#eef1ff" style={{ userSelect: 'none' }}>
              {(() => { const t = img.title || 'Untitled video'; return t.length > maxCh ? t.slice(0, maxCh - 1) + '…' : t })()}
            </text>
            {isSelected && <title>Double-click to rename</title>}
          </g>
        )
      })()}

      {/* Caption — editable text beneath the photo (any non-link media). Always visible when set;
          a "＋ caption" hint shows when selected and empty. Click it (or double-click the photo) to edit. */}
      {!isLink && !isVideo && !isAudio && !isText && !isCropping && (() => {
        const fs = 12
        const maxCh = Math.max(12, Math.floor(width / (fs * 0.55)))
        if (img.caption) {
          const parts = []
          let rest = String(img.caption)
          while (rest.length > maxCh && parts.length < 2) { parts.push(rest.slice(0, maxCh)); rest = rest.slice(maxCh) }
          parts.push(rest.length > maxCh ? rest.slice(0, maxCh - 1) + '…' : rest)
          return (
            <text x={0} y={hh + 15} textAnchor="middle" fontSize={fs} fill="#c5d0ff"
              style={{ cursor: 'text' }} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onCaption?.() }}
              paintOrder="stroke" stroke="rgba(12,12,26,0.85)" strokeWidth={fs * 0.14}>
              {parts.map((ln, i) => <tspan key={i} x={0} dy={i === 0 ? 0 : fs * 1.2}>{ln}</tspan>)}
            </text>
          )
        }
        return isSelected ? (
          <text x={0} y={hh + 15} textAnchor="middle" fontSize={fs} fill="#7080a0"
            style={{ cursor: 'text' }} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onCaption?.() }}>＋ caption</text>
        ) : null
      })()}
      {/* Video caption — the title, shown beneath the clip (until renamed). Always visible; sits below
          the inline scrubber when selected. Click to rename. */}
      {isVideo && !isCropping && !ytPosterMode && (img.title || isSelected) && (() => {
        const fs = 11
        const y = hh + (isSelected ? 32 : 14)
        const t = img.title || 'Untitled video'
        const shown = t.length > 44 ? t.slice(0, 43) + '…' : t
        return (
          <text x={0} y={y} textAnchor="middle" fontSize={fs} fill={img.title ? '#c5d0ff' : '#7080a0'}
            style={{ cursor: 'text' }} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onMediaTitle?.() }}
            paintOrder="stroke" stroke="rgba(12,12,26,0.85)" strokeWidth={fs * 0.14}>
            {shown}
          </text>
        )
      })()}
      {isSelected && !isCropping && (<>
        <rect x={vL - 3} y={vT - 3} width={cw + 6} height={ch + 6}
          fill="none" stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,3" rx={2} />
        {/* Attached-to-a-node badge (child of that node — moves & can delete with it) */}
        {img.attachedTo && (
          <g transform={`translate(${vR - 10},${vT + 2})`} style={{ pointerEvents: 'none' }}>
            <circle r={9} fill="#12122aee" stroke="#5b6af0" strokeWidth={1} />
            <IconGlyph name="link" size={12} color="#9fb0e8" />
          </g>
        )}
        {/* Top drag-bar to move it (the body's pointer events belong to the player/link). Not needed on
            a YouTube poster — the whole poster is pass-through, so dragging anywhere moves the node. */}
        {((isVideo && !ytPosterMode) || isLink || isAudio || isText) && (() => {
          // Scale the drag bar with the media size so a small (or small+zoomed-in) clip doesn't get a
          // giant bar. Capped so normal-size media keep the familiar bar.
          const barH = Math.max(4, Math.min(16, ch * 0.11))
          const fs = barH * 0.58
          const label = cw > fs * 13 ? '⠿ drag to move' : cw > fs * 3 ? '⠿ drag' : '⠿'
          return (
            <g onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id) }} style={{ cursor: 'move' }}>
              <rect x={vL} y={vT - barH * 0.2} width={cw} height={barH} rx={Math.min(2, barH * 0.25)} fill="#5b6af0" opacity={0.85} />
              <text x={vL + cw / 2} y={vT - barH * 0.2 + barH * 0.74} textAnchor="middle" fontSize={fs} fill="#fff" style={{ userSelect: 'none', pointerEvents: 'none' }}>{label}</text>
            </g>
          )
        })()}
        {/* Audio: autoplay toggles below the card. "On zoom" also fires when you arrow-nav into the
            media; "On slide" plays it while its frame is presented. (Video's equivalents live in the
            Edit dialog — kept off the canvas per the video's own controls below.) */}
        {isAudio && (() => {
          const py = vB + 6
          const pill = (px, on, label, prop) => (
            <g key={prop} transform={`translate(${px},${py})`} style={{ cursor: 'pointer' }}
              onMouseDown={e => { e.stopPropagation(); onToggleMedia?.(prop) }}>
              <rect x={0} y={0} width={label.length * 6.2 + 16} height={20} rx={10}
                fill={on ? '#232a5c' : '#12122a'} stroke={on ? '#5b6af0' : '#2d3a6a'} strokeWidth={1.1} />
              <text x={8} y={13.5} fontSize={10.5} fill={on ? '#aeb8ff' : '#7d84a4'} style={{ userSelect: 'none' }}>{label}</text>
            </g>
          )
          return (<>
            {pill(vL, !!img.autoplayOnZoom, '⚡ On zoom', 'autoplayOnZoom')}
            {pill(vL + 92, !!img.autoplayOnSlide, '▷ On slide', 'autoplayOnSlide')}
          </>)
        })()}
        {/* Video: an inline scrubber (play/pause + progress) shown while selected, so you can preview
            the clip without opening Edit. Seeks within the trimmed window [start, end]. + an Edit button. */}
        {isVideo && (() => {
          const lo = img.start || 0
          const hi = (img.end && img.end > lo) ? img.end : (scrub.d || 0)
          const span = Math.max(0.01, hi - lo)
          const frac = Math.min(1, Math.max(0, (scrub.t - lo) / span))
          const py = vB + 10
          const btnR = 8
          const editW = 46
          const railX = vL + btnR * 2 + 6
          const railW = Math.max(8, cw - (btnR * 2 + 6) - editW - 8)
          const railY = py
          const thumbX = railX + frac * railW
          const seekFrom = (clientX, rect) => {
            const f = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
            const t = lo + f * span
            playHandleRef.current?.seek?.(t)
            setScrub(s => ({ ...s, t }))
          }
          const onRailDown = e => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            seekFrom(e.clientX, rect)
            const mv = ev => seekFrom(ev.clientX, rect)
            const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
            window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
          }
          const togglePlay = e => {
            e.stopPropagation()
            if (scrub.playing) { playHandleRef.current?.pause?.() }
            else if (isYT && ytPosterMode) { setPlaying(true) }   // mount the iframe → autoplays from trim start
            else { playHandleRef.current?.play?.() }
            setScrub(s => ({ ...s, playing: !s.playing }))
          }
          return (<>
            {/* play / pause */}
            <g transform={`translate(${vL + btnR},${py})`} onMouseDown={togglePlay} style={{ cursor: 'pointer' }}>
              <circle r={btnR} fill="#12122aee" stroke="#5b6af0" strokeWidth={1.1} />
              {scrub.playing
                ? <g fill="#c5d0ff"><rect x={-3} y={-3.5} width={2.2} height={7} /><rect x={1} y={-3.5} width={2.2} height={7} /></g>
                : <path d="M -2.6 -3.6 L -2.6 3.6 L 3.6 0 Z" fill="#c5d0ff" />}
            </g>
            {/* progress rail */}
            <g onMouseDown={onRailDown} style={{ cursor: 'pointer' }}>
              <rect x={railX} y={railY - 6} width={railW} height={12} fill="transparent" />
              <rect x={railX} y={railY - 1.5} width={railW} height={3} rx={1.5} fill="#2d3a6a" />
              <rect x={railX} y={railY - 1.5} width={frac * railW} height={3} rx={1.5} fill="#5b6af0" />
              <circle cx={thumbX} cy={railY} r={4.5} fill="#c5d0ff" stroke="#5b6af0" strokeWidth={1} />
            </g>
            {/* Edit */}
            <g transform={`translate(${vR - editW},${py - 10})`} style={{ cursor: 'pointer' }} onMouseDown={e => { e.stopPropagation(); onEditVideo?.() }}>
              <rect x={0} y={0} width={editW} height={20} rx={10} fill="#12122a" stroke="#2d3a6a" strokeWidth={1.1} />
              <g transform="translate(12,10)"><IconGlyph name="edit" size={12} color="#aeb8ff" /></g>
              <text x={22} y={13.5} fontSize={10.5} fill="#aeb8ff" style={{ userSelect: 'none' }}>Edit</text>
            </g>
          </>)
        })()}
        {/* Video: the body pans/zooms with the canvas until you "arm" the player (so the canvas can zoom
            OVER it). When mounted but not armed, a low-key hint says double-click to interact with the
            native controls; once armed, a small ✕ (top-right) releases it back to the canvas. */}
        {isVideo && !videoActive && !(isYT && ytPosterMode) && (
          <g transform={`translate(0,${vB - 16})`} onMouseDown={e => { e.stopPropagation(); if (isYT) setPlaying(true); setVideoActive(true) }} style={{ cursor: 'pointer' }}>
            <rect x={-64} y={-9} width={128} height={18} rx={9} fill="#0c0c1acc" />
            <text x={0} y={1} textAnchor="middle" dominantBaseline="middle" fontSize={9.5} fill="#c5d0ff" style={{ userSelect: 'none', pointerEvents: 'none' }}>double-click to interact</text>
          </g>
        )}
        {isVideo && videoActive && (
          <g transform={`translate(${vR - 11},${vT + 3})`} onMouseDown={e => { e.stopPropagation(); setVideoActive(false) }} style={{ cursor: 'pointer' }}>
            <circle r={9} fill="#12122aee" stroke="#5b6af0" strokeWidth={1.2} />
            <IconGlyph name="close" size={13} color="#c5d0ff" />
          </g>
        )}
        {/* YouTube playing (unarmed) → a ✕ to return to the clean poster frame. */}
        {isVideo && isYT && !ytPosterMode && !videoActive && (
          <g transform={`translate(${vL + 11},${vT + 3})`} onMouseDown={e => { e.stopPropagation(); setPlaying(false) }} style={{ cursor: 'pointer' }}>
            <circle r={9} fill="#12122aee" stroke="#5b6af0" strokeWidth={1.2} />
            <IconGlyph name="close" size={13} color="#c5d0ff" />
          </g>
        )}
        {/* Text box handles live inside the box (RichTextBox), so nothing here. Photos get corner handles,
            sized to stay grabbable at any zoom (counter-scale the zoom, clamped). */}
        {!isText && (() => {
          const hzS = Math.max(4, Math.min(22, 5 / (zoomK || 1)))   // half-size in canvas units
          return corners.map(([c, hx, hy, cur]) => (
            <rect key={c} x={hx - hzS} y={hy - hzS} width={hzS * 2} height={hzS * 2} rx={1.5}
              fill="#fff" stroke="#5b6af0" strokeWidth={Math.max(1, 1.5 / (zoomK || 1))}
              onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id, 'resize', c) }}
              style={{ cursor: cur }} />
          ))
        })()}
        {/* Rotate — top-center */}
        <line x1={(vL + vR) / 2} y1={vT} x2={(vL + vR) / 2} y2={vT - 22} stroke="#a78bfa" strokeWidth={1} opacity={0.6} />
        <g transform={`translate(${(vL + vR) / 2},${vT - 28})`}
          onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id, 'rotate') }} style={{ cursor: 'grab' }}>
          <circle r={8} fill="#16162a" stroke="#a78bfa" strokeWidth={1.5} />
          <IconGlyph name="refresh" size={13} color="#a78bfa" />
        </g>
      </>)}

      {isCropping && (<>
        <rect x={vL} y={vT} width={cw} height={ch}
          fill="none" stroke="#fff" strokeWidth={1.5} strokeDasharray="4,2" style={{ pointerEvents: 'none' }} />
        {/* Four square crop handles at the edge medians */}
        {medians.map(([edge, hx, hy, cur]) => (
          <rect key={edge} x={hx - HS} y={hy - HS} {...SQ} rx={1.5}
            onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id, 'crop', edge) }}
            style={{ cursor: cur }} />
        ))}
        <text x={(vL + vR) / 2} y={vT - 8} textAnchor="middle" fontSize={9} fill="#fff"
          style={{ pointerEvents: 'none', userSelect: 'none' }}>ESC or click outside to finish</text>
      </>)}
    </g>
  )
}

// â"€â"€â"€ FrameNode â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function FrameNode({ node, viewProps, isSelected, inSlides, isPresenting, onMouseDown, onResizeMouseDown, onDelete, onLabelChange, onToggleSlide, hideOutline }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const [hover, setHover] = useState(false)
  const inputRef = useRef()

  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])

  const commitEdit = () => { onLabelChange(node.id, draft.trim() || 'Frame'); setEditing(false) }

  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const { halfW: defHW, halfH: defHH } = shapeDims('frame', r)
  const halfW = viewProps.frameHalfW ?? defHW
  const halfH = viewProps.frameHalfH ?? defHH
  const fill = (viewProps.fillColor && viewProps.fillColor !== 'none') ? viewProps.fillColor : 'none'
  const fillOpacity = fill !== 'none' ? 0.18 : 0
  const titleFontSize = Math.max(11, Math.round(13 * scale))
  const x = node.x ?? 0, y = node.y ?? 0

  return (
    <g transform={`translate(${x},${y})`}
      data-frame="true"
      onMouseDown={e => onMouseDown(e, node.id)}
      onClick={e => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true); requestAnimationFrame(() => inputRef.current?.select()) }}
      style={{ cursor: 'move' }}
    >
      {/* Invisible hit target - makes frame draggable even with no fill */}
      <rect x={-halfW} y={-halfH} width={halfW * 2} height={halfH * 2} rx={8}
        fill="transparent" stroke="none" style={{ cursor: 'move' }} />
      {/* Frame body â€" hidden in presentation mode or when outlines hidden */}
      {!isPresenting && !hideOutline && <rect x={-halfW} y={-halfH} width={halfW * 2} height={halfH * 2} rx={8}
        fill={fill} fillOpacity={fillOpacity}
        stroke={isSelected ? '#5b6af0' : '#4a7abf'}
        strokeWidth={isSelected ? 2.5 : 1.5}
        strokeDasharray="10,6"
      />}

      {/* Title at top-left */}
      {!editing && !isPresenting && !hideOutline && (
        <text x={-halfW + 12} y={-halfH + titleFontSize + 6}
          fill={viewProps.textColor || '#88b4e8'}
          fontSize={titleFontSize}
          fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
          fontWeight="600"
          style={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {node.label}
        </text>
      )}

      {/* Title edit input */}
      {editing && (
        <foreignObject x={-halfW + 8} y={-halfH + 4} width={halfW * 2 - 16} height={titleFontSize + 10}
          onMouseDown={e => e.stopPropagation()}>
          <input ref={inputRef} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
            }}
            style={{
              width: '100%', background: 'rgba(10,20,40,0.85)', border: '1.5px solid #5b6af0',
              borderRadius: 4, color: '#88b4e8', fontSize: titleFontSize, fontWeight: 600,
              padding: '2px 6px', outline: 'none', boxSizing: 'border-box',
            }}
          />
        </foreignObject>
      )}

      {/* × delete (top-right) */}
      {isSelected && (
        <g transform={`translate(${halfW - 12},${-halfH + 12})`}
          onClick={e => { e.stopPropagation(); onDelete(node.id) }}
          style={{ cursor: 'pointer' }}>
          <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
          <IconGlyph name="close" size={14} color="#f87171" />
        </g>
      )}

      {/* Slide toggle (top-right, left of delete) */}
      {isSelected && (
        <g transform={`translate(${halfW - 36},${-halfH + 12})`}
          onClick={e => { e.stopPropagation(); onToggleSlide(node.id) }}
          style={{ cursor: 'pointer' }}
          title={inSlides ? 'Remove from slideshow' : 'Add to slideshow'}>
          <circle r={9} fill="#1a1a2e" stroke={inSlides ? '#5b6af0' : '#7080a0'} strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={9} fill={inSlides ? '#5b6af0' : '#9aa8d8'} style={{ userSelect: 'none' }}>
            {inSlides ? '⊟' : '⊞'}
          </text>
        </g>
      )}

      {/* Corner resize handles — pivot on the opposite corner. All 4 when selected; when merely
          hovered (not selected), just the bottom-right one so you can resize without selecting. */}
      {(isSelected ? [[-1,-1,'tl','nwse-resize'],[1,-1,'tr','nesw-resize'],[-1,1,'bl','nesw-resize'],[1,1,'br','nwse-resize']]
                   : (hover && !isPresenting ? [[1,1,'br','nwse-resize']] : [])).map(([sx, sy, corner, cur]) => (
        <g key={corner} transform={`translate(${sx * halfW},${sy * halfH})`}
          onMouseDown={e => { e.stopPropagation(); onResizeMouseDown(e, node.id, corner) }}
          style={{ cursor: cur }}>
          <circle r={7} fill="#16162a" stroke="#5b6af0" strokeWidth={1.5} opacity={isSelected ? 1 : 0.85} />
          <IconGlyph name="resize" size={12} color="#5b6af0" />
        </g>
      ))}
    </g>
  )
}

// ─── ContainerNode ── a real tree node drawn as a big circle/rect that holds its contents ──
// Title sits OUTSIDE, just above the shape. Collapses to a small node-like pill (contents hidden by
// containment in visibleNodeIds). Dragging it carries its contained nodes along (handled in the drag
// handler, same path as frames).
function ContainerNode({ node, viewProps, isSelected, isCollapsed, isDropTarget, memberCount, onMouseDown, onResizeMouseDown, onDelete, onLabelChange, onToggleCollapse, onSetContainerShape }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const [hover, setHover] = useState(false)
  const inputRef = useRef()
  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])
  const commitEdit = () => { onLabelChange(node.id, draft.trim() || 'Container'); setEditing(false) }

  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const cshape = viewProps.containerShape || 'rect'
  const { halfW: defHW, halfH: defHH } = shapeDims('container', r)
  const halfW = viewProps.frameHalfW ?? defHW
  const halfH = viewProps.frameHalfH ?? defHH
  const fill = (viewProps.fillColor && viewProps.fillColor !== 'none') ? viewProps.fillColor : '#141a33'
  const stroke = isDropTarget ? '#4ade80' : (isSelected ? '#5b6af0' : (viewProps.strokeColor || '#4a7abf'))
  const strokeW = isDropTarget ? 3 : (isSelected ? 2.5 : 1.5)
  const titleFS = Math.max(11, Math.round(13 * scale))
  const x = node.x ?? 0, y = node.y ?? 0

  // Collapsed → a compact node-like pill; click the ▸ to expand back into the container.
  if (isCollapsed) {
    const pw = Math.max(60, (node.label || 'Container').length * 7 + 34)
    return (
      <g transform={`translate(${x},${y})`} data-container="true"
        onMouseDown={e => onMouseDown(e, node.id)} onClick={e => e.stopPropagation()}
        onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true) }} style={{ cursor: 'move' }}>
        <rect x={-pw / 2} y={-16} width={pw} height={32} rx={16} fill={fill} stroke={stroke} strokeWidth={isSelected ? 2.5 : 1.5} />
        <g transform={`translate(${-pw / 2 + 15},0)`} onClick={e => { e.stopPropagation(); onToggleCollapse() }} style={{ cursor: 'pointer' }}>
          <circle r={9} fill="#0c0c1a" stroke="#f6ad55" strokeWidth={1.2} /><IconGlyph name="chevronR" size={12} color="#f6ad55" />
        </g>
        <text x={6} y={1} textAnchor="middle" dominantBaseline="middle" fontSize={titleFS} fill="#c5d0ff" style={{ userSelect: 'none', pointerEvents: 'none' }}>{node.label || 'Container'}{memberCount ? ` · ${memberCount}` : ''}</text>
      </g>
    )
  }

  return (
    <g transform={`translate(${x},${y})`} data-container="true"
      onMouseDown={e => onMouseDown(e, node.id)} onClick={e => e.stopPropagation()}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true); requestAnimationFrame(() => inputRef.current?.select()) }}
      style={{ cursor: 'move' }}>
      {/* Body (circle or rect). Semi-transparent so contents read through. Green glow while a drag hovers. */}
      {cshape === 'circle'
        ? <ellipse rx={halfW} ry={halfH} fill={fill} fillOpacity={isDropTarget ? 0.7 : 0.5} stroke={stroke} strokeWidth={strokeW} />
        : <rect x={-halfW} y={-halfH} width={halfW * 2} height={halfH * 2} rx={16} fill={fill} fillOpacity={isDropTarget ? 0.7 : 0.5} stroke={stroke} strokeWidth={strokeW} />}

      {/* Title OUTSIDE, just above the shape */}
      {!editing ? (
        <text x={0} y={-halfH - 8} textAnchor="middle" fill={viewProps.textColor || '#9fb0e8'} fontSize={titleFS} fontWeight="600" style={{ userSelect: 'none', pointerEvents: 'none' }}>{node.label || 'Container'}</text>
      ) : (
        <foreignObject x={-90} y={-halfH - titleFS - 16} width={180} height={titleFS + 14} onMouseDown={e => e.stopPropagation()}>
          <input ref={inputRef} value={draft} autoFocus onChange={e => setDraft(e.target.value)} onBlur={commitEdit}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { e.preventDefault(); setEditing(false) } }}
            style={{ width: '100%', textAlign: 'center', background: 'rgba(10,20,40,0.9)', border: '1.5px solid #5b6af0', borderRadius: 5, color: '#c5d0ff', fontSize: titleFS, fontWeight: 600, padding: '2px 6px', outline: 'none', boxSizing: 'border-box' }} />
        </foreignObject>
      )}

      {/* Collapse chevron — bottom center */}
      {(isSelected || hover) && (
        <g transform={`translate(0,${halfH + 12})`} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggleCollapse() }} style={{ cursor: 'pointer' }}>
          <circle r={10} fill="#16162a" stroke="rgba(255,255,255,0.2)" strokeWidth={1.2} /><IconGlyph name="chevronD" size={13} color="#9aa8d8" />
        </g>
      )}

      {isSelected && (<>
        {/* × delete */}
        <g transform={`translate(${halfW - 12},${-halfH + 12})`} onClick={e => { e.stopPropagation(); onDelete(node.id) }} style={{ cursor: 'pointer' }}>
          <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} /><text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect: 'none' }}>×</text>
        </g>
        {/* Corner resize handles — image-style white squares, consistent across the app */}
        {[[-1, -1, 'tl', 'nwse-resize'], [1, -1, 'tr', 'nesw-resize'], [-1, 1, 'bl', 'nesw-resize'], [1, 1, 'br', 'nwse-resize']].map(([sx, sy, corner, cur]) => (
          <rect key={corner} x={sx * halfW - 6} y={sy * halfH - 6} width={12} height={12} rx={2}
            fill="#fff" stroke="#5b6af0" strokeWidth={1.5}
            onMouseDown={e => { e.stopPropagation(); onResizeMouseDown(e, node.id, corner) }} style={{ cursor: cur }} />
        ))}
      </>)}
      {hover && !isSelected && (
        <rect x={halfW - 6} y={halfH - 6} width={12} height={12} rx={2}
          fill="#fff" stroke="#5b6af0" strokeWidth={1.5} opacity={0.9}
          onMouseDown={e => { e.stopPropagation(); onResizeMouseDown(e, node.id, 'br') }} style={{ cursor: 'nwse-resize' }} />
      )}
    </g>
  )
}

// ─── AnimatedG ── wraps node visual content with optional motion + color cycle ──
function AnimatedG({ motionType, motionSpeed, motionIntensity, colorCycle, isActive, opacity, children }) {
  const ref = useRef()
  const rafRef = useRef()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (isActive || (!motionType && !colorCycle)) {
      cancelAnimationFrame(rafRef.current)
      el.style.transform = ''
      el.style.animation = ''
      return
    }
    el.style.animation = colorCycle ? `pim-hue-cycle ${colorCycle}s linear infinite` : ''
    if (!motionType) return
    const speed = motionSpeed || 1
    const intensity = motionIntensity || 10
    let startTime = null
    const animate = ts => {
      if (!startTime) startTime = ts
      const t = (ts - startTime) * 0.001 * speed
      const i = intensity
      let tx = 0, ty = 0, sc = 1
      switch (motionType) {
        case 'shake':    tx = (Math.sin(t * 14) * 0.75 + Math.sin(t * 37) * 0.25) * i; ty = (Math.sin(t * 11 + 1.5) * 0.7 + Math.sin(t * 29 + 0.7) * 0.3) * i; break
        case 'circle':   tx = Math.sin(t * 2.5) * i; ty = Math.cos(t * 2.5) * i; break
        case 'jerk':     { const ph = Math.floor(t * 3.5); const ang = (ph * 2.3999632) % (Math.PI * 2); const w = (t * 3.5) % 1; tx = w < 0.35 ? 0 : Math.cos(ang) * i; ty = w < 0.35 ? 0 : Math.sin(ang) * i; break }
        case 'updown':   ty = Math.sin(t * 2.5) * i; break
        case 'sideways': tx = Math.sin(t * 2.5) * i; break
        case 'scale':    sc = 1 + Math.abs(Math.sin(t * 2.5)) * (i * 0.04); break
        case 'rock':     { const rot = Math.sin(t * 2.5) * i * 0.025; el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; el.style.transform = 'rotate(' + (rot * 180 / Math.PI).toFixed(3) + 'deg)'; rafRef.current = requestAnimationFrame(animate); return }
        default: break
      }
      if (el) {
        el.style.transformBox = 'fill-box'
        el.style.transformOrigin = 'center'
        el.style.transform = motionType === 'scale'
          ? `scale(${sc.toFixed(4)})`
          : `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px)`
      }
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => { cancelAnimationFrame(rafRef.current); if (el) { el.style.transform = ''; el.style.animation = '' } }
  }, [motionType, motionSpeed, motionIntensity, colorCycle, isActive])

  return <g ref={ref} style={{ opacity: opacity ?? 1 }}>{children}</g>
}

// â"€â"€â"€ NodeShape â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function NodeShape({ node, viewProps, isSelected, isHovered, isDropTarget, autoEdit, onAutoEditDone, keepEdit, onKeepEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onBoxScaleMouseDown, zoomK, propertyDefs, nodeProps, onSetLabelWidth, onResetLabelWidth, onDelete, onLabelChange, onTab, onCreateSister, onShowNotePopup, onEmojiDragStart, onRemoveEmoji, onEmojiResizeStart, onImageDragStart, onImageResizeStart, onImageCropDragStart, onRemoveNodeImage, hasChildren, isCollapsed, onToggleCollapse, onMouseEnter, onMouseLeave, modelThumb, morphNonce }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const [croppingImgId, setCroppingImgId] = useState(null)
  const inputRef = useRef()

  useEffect(() => {
    if (!croppingImgId) return
    const onKey = e => { if (e.key === 'Escape') setCroppingImgId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [croppingImgId])

  useEffect(() => { if (!editing) setDraft(node.label) }, [node.label, editing])

  // Auto-enter edit on creation â€" clears text, selects all
  useEffect(() => {
    if (autoEdit) {
      setDraft('')
      setEditing(true)
      onAutoEditDone?.()
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, []) // eslint-disable-line

  // Enter-key edit â€" keeps text, selects all on open
  useEffect(() => {
    if (keepEdit && !editing) {
      setDraft(node.label)
      setEditing(true)
      onKeepEditDone?.()
    }
  }, [keepEdit]) // eslint-disable-line

  // Select all after textarea mounts
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  // Click anywhere outside the edit box → commit. Some targets (other nodes, SVG
  // elements) don't blur the textarea on click, so drive the commit from a
  // document-level mousedown and let the textarea's own onBlur do the work.
  useEffect(() => {
    if (!editing) return
    const onDocDown = e => {
      const el = inputRef.current
      if (el && !el.contains(e.target)) el.blur()
    }
    document.addEventListener('mousedown', onDocDown, true)
    return () => document.removeEventListener('mousedown', onDocDown, true)
  }, [editing])

  const commitEdit = () => { onLabelChange(node.id, draft.trim() || 'New node'); setEditing(false) }

  const isAnchored = node.fx != null
  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const shape = viewProps.shape || 'circle'
  // fontScale decouples text size from box size: "scale shape only" grows the box while
  // holding 12*scale*fontScale constant, so the absolute font stays put and text reflows.
  const baseFontSize = Math.max(9, Math.round(12 * scale * (viewProps.fontScale ?? 1)))
  // Handles are drawn in canvas space, so their on-screen size = size × zoom. Counter-scale
  // by 1/zoom to keep them ~constant on screen, clamped so they don't balloon when zoomed in
  // or dwarf a node when zoomed way out.
  const hz = Math.min(2.5, Math.max(0.4, 1 / (zoomK || 1)))
  // On-canvas property chips — only properties flagged showChip that have a value here.
  const chips = []
  if (nodeProps && propertyDefs) {
    for (const def of propertyDefs) {
      if (!def.showChip) continue
      const v = nodeProps[def.id]
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
      if (def.type === 'select') { const o = (def.options || []).find(o => o.id === v); if (o) chips.push({ text: o.name, color: o.color || '#6366f1' }) }
      else if (def.type === 'multiSelect') { (Array.isArray(v) ? v : []).forEach(id => { const o = (def.options || []).find(o => o.id === id); if (o) chips.push({ text: o.name, color: o.color || '#6366f1' }) }) }
      else if (def.type === 'checkbox') { if (v) chips.push({ text: def.name, color: '#22c55e' }) }
      else chips.push({ text: def.type === 'url' ? '🔗 link' : String(v), color: '#5b6af0' })
    }
  }
  const isAutoSized = shape === 'roundrect' || shape === 'rect'
  const { halfW, halfH } = shapeDims(shape, r, node.label, baseFontSize, viewProps.labelWidth)
  const isRound = shape === 'ellipse' || shape === 'circle' || shape === 'diamond'
  // Safe inner half-extents: the largest centered rectangle that fits *inside* the curve,
  // so text wraps/clips within the shape instead of spilling into the cut-off corners.
  const INSET = 1.42 // ≈√2 — inscribed rect of an ellipse/circle
  const labelHalfW = shape === 'ellipse' ? halfW / INSET : shape === 'circle' ? r / INSET : shape === 'diamond' ? halfW / 2 : halfW
  const labelHalfH = shape === 'ellipse' ? halfH / INSET : shape === 'circle' ? r / INSET : shape === 'diamond' ? halfH / 2 : halfH
  // Auto-shrink the font so text fits: round shapes fit the inscribed area; auto-sized
  // rects already grow to fit, so they keep the base size.
  // EXCEPTION — "scale shape only" (Shift-drag) decouples text from the box: it holds the absolute
  // font size by compensating `fontScale`, so once fontScale ≠ 1 we must NOT re-fit the font to the
  // box (that would make the text track the box again and defeat the decoupling — the text reflows /
  // overflows instead, which is the whole point of resizing the shape only).
  const fontDecoupled = (viewProps.fontScale ?? 1) !== 1
  const fontSize = fontDecoupled ? baseFontSize
    : isAutoSized ? baseFontSize
    : isRound ? fitFontToBox(node.label, baseFontSize, (labelHalfW - 4) * 2, (labelHalfH - 4) * 2)
    : (() => {
        const innerW = halfW * 2, innerH = halfH * 2
        const charsPerLine = Math.max(1, Math.floor(innerW / (baseFontSize * 0.55)))
        const linesNeeded = Math.ceil((node.label || ' ').length / charsPerLine)
        const heightNeeded = linesNeeded * baseFontSize * 1.3
        return heightNeeded > innerH ? Math.max(7, Math.round(baseFontSize * innerH / heightNeeded)) : baseFontSize
      })()
  const fill = viewProps.fillColor || DEFAULT_NODE_PROPS.fillColor
  const hasNotes = !!(node.notes && node.notes.length > 0)
  const x = node.x ?? 0, y = node.y ?? 0
  const motion = viewProps.nodeMotion
  const colorCycle = viewProps.nodeColorCycle || 0
  const isActive = isSelected
  // Drop shadow (view-dependent): { distance, opacity, softness } | null. Cast diagonally down-right.
  const shadow = viewProps.shadow
  const hasShadow = shadow && (shadow.opacity ?? 0) > 0 && ((shadow.distance ?? 0) > 0 || (shadow.softness ?? 0) > 0)
  const shadowFilterId = `nsh-${node.id}`

  // ── In-node images: above/below/beside images live INSIDE the node's EXISTING shape —
  // the node never grows. Images shrink to fit whatever space is available instead, and
  // the text area shrinks/shifts to share the box with them.
  const nodeImages = viewProps.nodeImages || []
  const supportsInlineImages = shape !== '3d' && shape !== 'frame'
  const IMG_GAP = 3
  const sizedImg = im => ({ ...im, w: (im.w0 || 60) * (im.scale || 1), h: (im.h0 || 60) * (im.scale || 1) })
  const aboveImgsRaw = supportsInlineImages ? nodeImages.filter(im => im.position === 'above').map(sizedImg) : []
  const belowImgsRaw = supportsInlineImages ? nodeImages.filter(im => im.position === 'below').map(sizedImg) : []
  const besideImgsRaw = supportsInlineImages ? nodeImages.filter(im => im.position === 'beside').map(sizedImg) : []
  const perimeterImgs = nodeImages.filter(im => !im.position || im.position === 'perimeter').map(sizedImg)
  const bgImg = supportsInlineImages ? nodeImages.find(im => im.position === 'background') : null
  const bodyHalfW = halfW, bodyHalfH = halfH, bodyR = r // node size never changes for inline images

  // Shrink (never grow) a row of images uniformly so it fits within maxW × maxH.
  const fitRow = (imgs, maxW, maxH) => {
    if (!imgs.length) return { items: [], w: 0, h: 0 }
    const totalW = imgs.reduce((s, im) => s + im.w, 0) + IMG_GAP * (imgs.length - 1)
    const tallest = Math.max(...imgs.map(im => im.h))
    const scale = Math.min(1, maxW / totalW, maxH / tallest)
    const items = imgs.map(im => ({ ...im, w: im.w * scale, h: im.h * scale }))
    return { items, w: items.reduce((s, im) => s + im.w, 0) + IMG_GAP * (items.length - 1), h: Math.max(...items.map(im => im.h)) }
  }
  const fitCol = (imgs, maxW, maxH) => {
    if (!imgs.length) return { items: [], w: 0, h: 0 }
    const totalH = imgs.reduce((s, im) => s + im.h, 0) + IMG_GAP * (imgs.length - 1)
    const widest = Math.max(...imgs.map(im => im.w))
    const scale = Math.min(1, maxH / totalH, maxW / widest)
    const items = imgs.map(im => ({ ...im, w: im.w * scale, h: im.h * scale }))
    return { items, w: Math.max(...items.map(im => im.w)), h: items.reduce((s, im) => s + im.h, 0) + IMG_GAP * (items.length - 1) }
  }

  const PAD = 4
  const innerW = bodyHalfW * 2 - PAD * 2
  const innerH = bodyHalfH * 2 - PAD * 2
  const vGroups = (aboveImgsRaw.length ? 1 : 0) + (belowImgsRaw.length ? 1 : 0)
  const vFrac = vGroups === 2 ? 0.28 : 0.42
  const aboveFit = fitRow(aboveImgsRaw, innerW, innerH * vFrac)
  const belowFit = fitRow(belowImgsRaw, innerW, innerH * vFrac)
  const besideFit = fitCol(besideImgsRaw, innerW * 0.4, innerH)
  const aboveImgs = aboveFit.items, belowImgs = belowFit.items, besideImgs = besideFit.items

  // Text area shrinks to whatever's left after the image bands are carved out.
  const textTopY = -bodyHalfH + (aboveFit.h ? aboveFit.h + IMG_GAP : 0)
  const textBottomY = bodyHalfH - (belowFit.h ? belowFit.h + IMG_GAP : 0)
  const textRightX = bodyHalfW - (besideFit.w ? besideFit.w + IMG_GAP : 0)
  const textCenterX = (-bodyHalfW + textRightX) / 2
  const textCenterY = (textTopY + textBottomY) / 2
  const textHalfW = Math.max(20, (textRightX - (-bodyHalfW)) / 2)
  const textHalfH = Math.max(14, (textBottomY - textTopY) / 2)
  const hasInlineImages = aboveImgs.length || belowImgs.length || besideImgs.length

  return (
    <g transform={`translate(${x},${y})`}
      data-node="true"
      opacity={node.__fadeOp != null ? node.__fadeOp : undefined}
      onMouseDown={e => onMouseDown(e, node.id)}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => { if (!editing) { e.stopPropagation(); setDraft(node.label); setEditing(true); requestAnimationFrame(() => inputRef.current?.select()) } }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ cursor: 'move', pointerEvents: shape === '3d' && isSelected ? 'none' : undefined }}
    >
      {/* Transparent body hit-area at the BOTTOM of the stack — gives shape:'none' /
          transparent nodes a drag/select target without covering the in-node image
          handles that render above it (double-click-to-edit is handled on the <g>). */}
      {!editing && <ellipse rx={bodyHalfW} ry={bodyHalfH} fill="transparent" style={{ cursor: 'move' }} />}

      {/* Selection / hover rings — outside animation so they don't wiggle */}
      {isSelected && (shape === 'none'
        ? <rect x={-(bodyHalfW+4)} y={-(bodyHalfH+4)} width={(bodyHalfW+4)*2} height={(bodyHalfH+4)*2} rx={4} fill="none" stroke="#5b6af0" strokeWidth={2} strokeDasharray="5,3" />
        : <ShapeBody shape={shape} halfW={bodyHalfW + 4} halfH={bodyHalfH + 4} r={bodyR + 4} fill="none" stroke="#5b6af0" strokeWidth={2.5} />
      )}
      {isDropTarget && shape !== 'none' && (
        <ShapeBody shape={shape} halfW={bodyHalfW + 7} halfH={bodyHalfH + 7} r={bodyR + 7} fill="none" stroke="#4ade80" strokeWidth={3} />
      )}
      {isHovered && !isSelected && shape !== 'none' && (
        <ShapeBody shape={shape} halfW={bodyHalfW + 2} halfH={bodyHalfH + 2} r={bodyR + 2} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={1.5} />
      )}

      {/* Animated visual body */}
      <AnimatedG
        motionType={motion?.type}
        motionSpeed={motion?.speed}
        motionIntensity={motion?.intensity}
        colorCycle={colorCycle}
        isActive={isActive}
        opacity={viewProps.opacity}
      >
        {hasShadow && (
          <defs>
            <filter id={shadowFilterId} x="-80%" y="-80%" width="260%" height="260%">
              <feDropShadow dx={(shadow.distance ?? 6) * 0.72} dy={(shadow.distance ?? 6) * 0.72}
                stdDeviation={shadow.softness ?? 4} floodColor="#000000" floodOpacity={shadow.opacity ?? 0.35} />
            </filter>
          </defs>
        )}
        <g key={`morph-${morphNonce || 0}`} style={morphNonce ? { animation: 'pim-shape-morph 0.42s ease' } : undefined}>
        <g style={viewProps.spin ? { animation: `pim-spin ${viewProps.spin}s linear infinite`, transformOrigin: 'center', transformBox: 'fill-box' } : undefined}>
        <g filter={hasShadow ? `url(#${shadowFilterId})` : undefined}>
        {viewProps.borderFx ? (
          // Decorated perimeter (jagged / wave / petal / …). Replaces the plain body; uses node fill+stroke.
          <path d={borderFxPath(viewProps.borderFx, bodyHalfW, bodyHalfH, viewProps.borderFxCount, viewProps.borderFxAmp)}
            fill={fill} stroke={viewProps.strokeColor || 'none'}
            strokeWidth={viewProps.strokeColor ? (viewProps.strokeWidth || 1.5) : 0}
            strokeDasharray={dashArray(viewProps.strokeDash, viewProps.strokeWidth)}
            strokeLinejoin={(viewProps.borderFx === 'petal' || viewProps.borderFx === 'scallop' || viewProps.borderFx === 'wave' || viewProps.borderFx === 'bloom') ? 'round' : 'miter'} />
        ) : viewProps.borderBlur > 0 ? (
          // SVG feGaussianBlur with sRGB on the primitive: avoids the linearRGB white
          // fringe AND the Chromium white-box bug that CSS filter+transform triggers.
          // The body feathers to transparent; no crisp overlay, no colored glow.
          <>
            <defs>
              <filter id={`bedge-${node.id}`} x="-150%" y="-150%" width="400%" height="400%">
                <feGaussianBlur in="SourceGraphic" stdDeviation={viewProps.borderBlur} colorInterpolationFilters="sRGB" />
              </filter>
            </defs>
            <g filter={`url(#bedge-${node.id})`}>
              <ShapeBody shape={shape} halfW={bodyHalfW} halfH={bodyHalfH} r={bodyR} fill={fill}
                stroke={viewProps.strokeColor || "none"} strokeWidth={viewProps.strokeColor ? (viewProps.strokeWidth || 1.5) : 0} strokeDash={viewProps.strokeDash} />
            </g>
          </>
        ) : (
          <ShapeBody shape={shape} halfW={bodyHalfW} halfH={bodyHalfH} r={bodyR} fill={fill}
            stroke={viewProps.strokeColor || "none"} strokeWidth={viewProps.strokeColor ? (viewProps.strokeWidth || 1.5) : 0} strokeDash={viewProps.strokeDash} />
        )}
        </g>
        </g>
        </g>

        {/* Background image — covers the node body, clipped to its shape, behind the label */}
        {bgImg && (
          <>
            <defs>
              <clipPath id={`nbg-${node.id}`}>
                {shapeClipShape(shape, bodyHalfW, bodyHalfH, bodyR)}
              </clipPath>
            </defs>
            <image href={bgImg.src} x={-bodyHalfW} y={-bodyHalfH} width={bodyHalfW*2} height={bodyHalfH*2}
              preserveAspectRatio="xMidYMid slice" clipPath={`url(#nbg-${node.id})`}
              style={{ pointerEvents:'none' }} />
            {viewProps.strokeColor && (
              <ShapeBody shape={shape} halfW={bodyHalfW} halfH={bodyHalfH} r={bodyR} fill="none"
                stroke={viewProps.strokeColor} strokeWidth={viewProps.strokeWidth || 1.5} />
            )}
          </>
        )}

        {/* 3D thumbnail — shown when not live (node not selected) */}
        {shape === '3d' && modelThumb && !isSelected && (
          <>
            <defs>
              <clipPath id={`tc-${node.id}`}>
                <rect x={-halfW+2} y={-halfH+2} width={(halfW-2)*2} height={(halfH-2)*2} rx={8} />
              </clipPath>
            </defs>
            <image href={modelThumb} x={-halfW+2} y={-halfH+2} width={(halfW-2)*2} height={(halfH-2)*2}
              preserveAspectRatio="xMidYMid meet" clipPath={`url(#tc-${node.id})`}
              style={{ pointerEvents:'none' }} />
          </>
        )}

        {/* Label — shrinks/shifts into whatever space is left after image bands are carved out */}
        {!editing && shape !== '3d' && (
          hasInlineImages ? (
            <g transform={`translate(${textCenterX.toFixed(1)},${textCenterY.toFixed(1)})`}>
              <NodeLabel label={node.label} halfW={textHalfW} halfH={textHalfH} fontSize={fontSize} textColor={viewProps.textColor || '#fff'} />
            </g>
          ) : (
            <NodeLabel label={node.label} halfW={labelHalfW} halfH={labelHalfH} fontSize={fontSize} textColor={viewProps.textColor || '#fff'} />
          )
        )}
        {!editing && shape === '3d' && (
          <text y={halfH + 16} textAnchor="middle" fontSize={Math.max(9, Math.round(11 * scale))}
            fill={viewProps.textColor || '#ccd'} style={{ pointerEvents:'none', userSelect:'none' }}
            dominantBaseline="hanging">
            {node.label}
          </text>
        )}

        {/* In-node images — above/below (row, touching the text) and beside (column, to the right) */}
        {(() => {
          const rows = []
          if (aboveImgs.length) {
            let cx = -aboveFit.w / 2
            const cy = -bodyHalfH + aboveFit.h / 2
            aboveImgs.forEach(im => { rows.push({ im, x: cx + im.w / 2, y: cy }); cx += im.w + IMG_GAP })
          }
          if (belowImgs.length) {
            let cx = -belowFit.w / 2
            const cy = bodyHalfH - belowFit.h / 2
            belowImgs.forEach(im => { rows.push({ im, x: cx + im.w / 2, y: cy }); cx += im.w + IMG_GAP })
          }
          if (besideImgs.length) {
            let cy = -besideFit.h / 2
            const cx = bodyHalfW - besideFit.w / 2
            besideImgs.forEach(im => { rows.push({ im, x: cx, y: cy + im.h / 2 }); cy += im.h + IMG_GAP })
          }
          return rows.map(({ im, x: ix, y: iy }) => {
            const crop = im.crop || { x: 0, y: 0, w: 1, h: 1 }
            const isCropping = croppingImgId === im.id
            const clipId = `imc-${im.id}`
            const cx = -im.w / 2 + im.w * crop.x, cy = -im.h / 2 + im.h * crop.y
            const cw = im.w * crop.w, ch = im.h * crop.h
            const cropHandles = [
              ['tl', cx, cy], ['t', cx+cw/2, cy], ['tr', cx+cw, cy],
              ['l', cx, cy+ch/2], ['r', cx+cw, cy+ch/2],
              ['bl', cx, cy+ch], ['b', cx+cw/2, cy+ch], ['br', cx+cw, cy+ch],
            ]
            const hCursor = e => e==='tl'||e==='br' ? 'nwse-resize' : e==='tr'||e==='bl' ? 'nesw-resize' : e==='l'||e==='r' ? 'ew-resize' : 'ns-resize'
            return (
              <g key={im.id} transform={`translate(${ix.toFixed(1)},${iy.toFixed(1)})`}>
                {(crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) && (
                  <defs>
                    <clipPath id={clipId}>
                      <rect x={cx} y={cy} width={cw} height={ch} />
                    </clipPath>
                  </defs>
                )}
                {isCropping && <image href={im.src} x={-im.w/2} y={-im.h/2} width={im.w} height={im.h} opacity={0.3} style={{ pointerEvents:'none' }} />}
                <image href={im.src} x={-im.w / 2} y={-im.h / 2} width={im.w} height={im.h}
                  clipPath={(crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) ? `url(#${clipId})` : undefined}
                  onDoubleClick={e => { e.stopPropagation(); setCroppingImgId(isCropping ? null : im.id) }}
                  style={{ pointerEvents: isSelected ? 'auto' : 'none', cursor: isSelected ? (isCropping ? 'crosshair' : 'default') : undefined }} />
                {isSelected && !isCropping && (
                  <>
                    <rect x={-im.w / 2} y={-im.h / 2} width={im.w} height={im.h} fill="none" stroke="#5b6af0" strokeWidth={1} />
                    <g transform={`translate(${im.w / 2 - 6},${-im.h / 2 + 6})`}
                      onClick={e => { e.stopPropagation(); onRemoveNodeImage?.(node.id, im.id) }} style={{ cursor:'pointer' }}>
                      <circle r={5.5} fill="#f87171" />
                      <IconGlyph name="close" size={10} color="#fff" />
                    </g>
                    <g transform={`translate(${im.w / 2},${im.h / 2})`}
                      onMouseDown={e => { e.stopPropagation(); onImageResizeStart?.(e, node.id, im.id, (node.x || 0) + ix, (node.y || 0) + iy) }}
                      style={{ cursor: 'nwse-resize' }}>
                      <circle r={12} fill="transparent" />
                      <circle r={5} fill="#5b6af0" stroke="#fff" strokeWidth={1} style={{ pointerEvents:'none' }} />
                    </g>
                  </>
                )}
                {isCropping && (
                  <>
                    <rect x={cx} y={cy} width={cw} height={ch} fill="none" stroke="white" strokeWidth={1} strokeDasharray="4,2" style={{ pointerEvents:'none' }} />
                    {cropHandles.map(([edge, hx, hy]) => (
                      <circle key={edge} cx={hx} cy={hy} r={5} fill="white" stroke="#5b6af0" strokeWidth={1.5}
                        onMouseDown={e => { e.stopPropagation(); onImageCropDragStart?.(e, node.id, im.id, edge, im.w, im.h) }}
                        style={{ cursor: hCursor(edge) }} />
                    ))}
                    <text x={0} y={-im.h/2 - 6} textAnchor="middle" fontSize={9} fill="white" style={{ pointerEvents:'none', userSelect:'none' }}>ESC to done</text>
                  </>
                )}
              </g>
            )
          })
        })()}

        {/* Notes indicator badge */}
        {hasNotes && !isSelected && (
          <g transform={`translate(${bodyHalfW * 0.3}, ${shape === '3d' ? bodyHalfH + 22 : bodyHalfH + 3})`}
            onMouseDown={e => { e.stopPropagation() }}
            onClick={e => { e.stopPropagation(); onShowNotePopup?.(node.id) }}
            style={{ cursor: 'pointer' }}>
            {/* larger transparent hit target so the small ✎ is easy to click */}
            <circle r={13} fill="transparent" />
            <circle r={8} fill="#12122a" stroke="#5b6af0" strokeWidth={1.2} />
            <IconGlyph name="edit" size={12} color="#5b6af0" />
          </g>
        )}

        {/* USPTO live-trademark hit badge (0 = green/likely clear, higher = amber/red) */}
        {node.meta?.usptoHits != null && !isSelected && (() => {
          const h = node.meta.usptoHits
          const col = h === 0 ? '#16a34a' : h <= 2 ? '#f6ad55' : '#f87171'
          const label = 'TM ' + h
          const w = 14 + label.length * 6
          return (
            <g transform={`translate(${-w / 2}, ${-(bodyHalfH) - 22})`}
              onMouseDown={e => e.stopPropagation()}>
              <title>{`${h} live USPTO trademark hit${h === 1 ? '' : 's'}${node.meta.usptoNote && node.meta.usptoNote !== 'ok' ? ' (' + node.meta.usptoNote + ')' : ''}`}</title>
              <rect x={0} y={0} width={w} height={16} rx={8} fill="#101024" stroke={col} strokeWidth={1.2} />
              <text x={w / 2} y={8.5} textAnchor="middle" dominantBaseline="central" fill={col} fontSize={9.5} fontWeight={700} style={{ userSelect: 'none', pointerEvents: 'none' }}>{label}</text>
            </g>
          )
        })()}

        {/* Tag chips — the unified node.meta.tags, shown below the node (hidden while selected to avoid toolbar overlap) */}
        {(node.meta?.tags?.length > 0) && !isSelected && (() => {
          const tags = node.meta.tags.slice(0, 6)
          const gap = 4, h = 15
          const widths = tags.map(t => 12 + t.length * 5.6)
          const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, tags.length - 1)
          let x = -total / 2
          const y = bodyHalfH + 8
          return (
            <g onMouseDown={e => e.stopPropagation()}>
              {tags.map((t, i) => {
                const w = widths[i]; const gx = x; x += w + gap
                const c = tagColor(t)
                return (
                  <g key={t} transform={`translate(${gx}, ${y})`}>
                    <title>{'#' + t}</title>
                    <rect x={0} y={0} width={w} height={h} rx={7} fill="#101024" stroke={c} strokeWidth={1} opacity={0.95} />
                    <text x={w / 2} y={h / 2 + 0.5} textAnchor="middle" dominantBaseline="central" fill={c} fontSize={9} fontWeight={600} style={{ userSelect: 'none', pointerEvents: 'none' }}>{t}</text>
                  </g>
                )
              })}
            </g>
          )
        })()}

      {/* Emoji badges — move with AnimatedG so they animate with the node */}
      {(viewProps.nodeEmojis || []).map(em => {
        const cosA = Math.cos(em.angle), sinA = Math.sin(em.angle)
        let ex, ey
        if (shape === 'circle' || shape === 'ellipse' || shape === 'none') {
          // boundary of the ellipse itself sits exactly on the outline
          ex = cosA * bodyHalfW
          ey = sinA * bodyHalfH
        } else if (shape === 'diamond') {
          const d = 1 / (Math.abs(cosA) / bodyHalfW + Math.abs(sinA) / bodyHalfH)
          ex = cosA * d
          ey = sinA * d
        } else {
          // rect / roundrect / frame / 3d — intersect ray with axis-aligned box
          const d = 1 / Math.max(Math.abs(cosA) / bodyHalfW, Math.abs(sinA) / bodyHalfH)
          ex = cosA * d
          ey = sinA * d
        }
        const emScale = em.scale || 1
        const badgeR = 20 * emScale
        const imgSize = 28 * emScale
        const handleR = badgeR * Math.SQRT1_2 // bottom-right corner of the badge's bounding box
        return (
          <g key={em.id} transform={`translate(${ex.toFixed(1)},${ey.toFixed(1)})`}>
            <circle r={badgeR} fill="transparent"
              stroke={isSelected ? '#5b6af0' : 'transparent'} strokeWidth={1} />
            {em.type === 'image'
              ? <image href={em.emoji} x={-imgSize/2} y={-imgSize/2} width={imgSize} height={imgSize} style={{ pointerEvents:'none' }} />
              : <text textAnchor="middle" dominantBaseline="central" fontSize={23 * emScale} style={{ userSelect:'none', pointerEvents:'none' }}>{em.emoji}</text>}
            {(isSelected || isHovered) && (
              <circle r={badgeR} fill="transparent"
                onMouseDown={e => { e.stopPropagation(); onEmojiDragStart?.(e, node.id, em.id) }}
                style={{ cursor: 'grab' }} />
            )}
            {isSelected && (
              <g transform="translate(14,-14)" onClick={e => { e.stopPropagation(); onRemoveEmoji?.(node.id, em.id) }} style={{ cursor:'pointer' }}>
                <circle r={5.5} fill="#f87171" />
                <IconGlyph name="close" size={10} color="#fff" />
              </g>
            )}
            {isSelected && (
              <g transform={`translate(${badgeR.toFixed(1)},${badgeR.toFixed(1)})`}>
                <circle r={14} fill="transparent" pointerEvents="all"
                  onMouseDown={e => { e.stopPropagation(); onEmojiResizeStart?.(e, node.id, em.id) }}
                  style={{ cursor: 'nwse-resize' }} />
                <circle r={5} fill="#5b6af0" stroke="#fff" strokeWidth={1} style={{ pointerEvents:'none' }} />
              </g>
            )}
          </g>
        )
      })}

      {/* Perimeter-mounted in-node images — half-in/half-out on the outline, like emoji badges */}
      {perimeterImgs.map(im => {
        const cosA = Math.cos(im.angle || -Math.PI / 4), sinA = Math.sin(im.angle || -Math.PI / 4)
        let ix, iy
        if (shape === 'circle' || shape === 'ellipse' || shape === 'none') {
          ix = cosA * bodyHalfW
          iy = sinA * bodyHalfH
        } else if (shape === 'diamond') {
          const d = 1 / (Math.abs(cosA) / bodyHalfW + Math.abs(sinA) / bodyHalfH)
          ix = cosA * d
          iy = sinA * d
        } else {
          const d = 1 / Math.max(Math.abs(cosA) / bodyHalfW, Math.abs(sinA) / bodyHalfH)
          ix = cosA * d
          iy = sinA * d
        }
        const isCropping = croppingImgId === im.id
        const pClipId = `pmc-${im.id}`
        const crop = im.crop || { x: 0, y: 0, w: 1, h: 1 }
        const cx = -im.w/2 + im.w*crop.x, cy = -im.h/2 + im.h*crop.y
        const cw = im.w*crop.w, ch = im.h*crop.h
        const cropHandles = [
          ['tl',cx,cy],['t',cx+cw/2,cy],['tr',cx+cw,cy],
          ['l',cx,cy+ch/2],['r',cx+cw,cy+ch/2],
          ['bl',cx,cy+ch],['b',cx+cw/2,cy+ch],['br',cx+cw,cy+ch],
        ]
        const hCursor = e => e==='tl'||e==='br' ? 'nwse-resize' : e==='tr'||e==='bl' ? 'nesw-resize' : e==='l'||e==='r' ? 'ew-resize' : 'ns-resize'
        return (
          <g key={im.id} transform={`translate(${ix.toFixed(1)},${iy.toFixed(1)})`}>
            {(crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) && (
              <defs>
                <clipPath id={pClipId}><rect x={cx} y={cy} width={cw} height={ch} /></clipPath>
              </defs>
            )}
            {isCropping && <image href={im.src} x={-im.w/2} y={-im.h/2} width={im.w} height={im.h} opacity={0.3} style={{ pointerEvents:'none' }} />}
            <image href={im.src} x={-im.w / 2} y={-im.h / 2} width={im.w} height={im.h}
              clipPath={(crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) ? `url(#${pClipId})` : undefined}
              onDoubleClick={e => { e.stopPropagation(); setCroppingImgId(isCropping ? null : im.id) }}
              style={{ pointerEvents: isSelected || isHovered ? 'auto' : 'none', cursor: isCropping ? 'crosshair' : 'default' }} />
            {(isSelected || isHovered) && !isCropping && (
              <rect x={-im.w / 2} y={-im.h / 2} width={im.w} height={im.h} fill="transparent"
                stroke={isSelected ? '#5b6af0' : 'transparent'} strokeWidth={1}
                onMouseDown={e => { e.stopPropagation(); onImageDragStart?.(e, node.id, im.id) }}
                style={{ cursor: 'grab' }} />
            )}
            {isSelected && !isCropping && (
              <>
                <g transform={`translate(${im.w / 2 - 6},${-im.h / 2 + 6})`}
                  onClick={e => { e.stopPropagation(); onRemoveNodeImage?.(node.id, im.id) }} style={{ cursor:'pointer' }}>
                  <circle r={5.5} fill="#f87171" />
                  <IconGlyph name="close" size={10} color="#fff" />
                </g>
                <g transform={`translate(${im.w / 2},${im.h / 2})`}
                  onMouseDown={e => { e.stopPropagation(); onImageResizeStart?.(e, node.id, im.id, (node.x || 0) + ix - im.w / 2, (node.y || 0) + iy - im.h / 2) }}
                  style={{ cursor: 'nwse-resize' }}>
                  <circle r={12} fill="transparent" />
                  <circle r={5} fill="#5b6af0" stroke="#fff" strokeWidth={1} style={{ pointerEvents:'none' }} />
                </g>
              </>
            )}
            {isCropping && (
              <>
                <rect x={cx} y={cy} width={cw} height={ch} fill="none" stroke="white" strokeWidth={1} strokeDasharray="4,2" style={{ pointerEvents:'none' }} />
                {cropHandles.map(([edge, hx, hy]) => (
                  <circle key={edge} cx={hx} cy={hy} r={5} fill="white" stroke="#5b6af0" strokeWidth={1.5}
                    onMouseDown={e => { e.stopPropagation(); onImageCropDragStart?.(e, node.id, im.id, edge, im.w, im.h) }}
                    style={{ cursor: hCursor(edge) }} />
                ))}
                <text x={0} y={-im.h/2 - 6} textAnchor="middle" fontSize={9} fill="white" style={{ pointerEvents:'none', userSelect:'none' }}>ESC to done</text>
              </>
            )}
          </g>
        )
      })}

      {/* Collapse/expand chevron — only on nodes that have children, sits centered on the bottom edge */}
      {hasChildren && (isSelected || isHovered) && (
        <g transform={`translate(0,${bodyHalfH + 11 * hz}) scale(${hz})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onToggleCollapse?.() }}
          style={{ cursor: 'pointer' }}>
          <title>{isCollapsed ? 'Expand children' : 'Collapse children'}</title>
          <circle r={10} fill="#16162a" stroke={isCollapsed ? '#f6ad55' : 'rgba(255,255,255,0.18)'} strokeWidth={1.2} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={11}
            fill={isCollapsed ? '#f6ad55' : '#9aa8d8'}
            style={{ userSelect:'none', pointerEvents:'none' }}>{isCollapsed ? '▸' : '▾'}</text>
        </g>
      )}
      </AnimatedG>

      {/* On-canvas property chips (properties flagged "Show on canvas") */}
      {chips.length > 0 && (
        <foreignObject x={-Math.max(bodyHalfW, 80)} y={bodyHalfH + 4} width={Math.max(bodyHalfW * 2, 160)} height={72}
          style={{ pointerEvents: 'none', overflow: 'visible' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, justifyContent: 'center' }}>
            {chips.map((c, i) => (
              <span key={i} style={{ fontSize: 9, lineHeight: 1.35, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
                background: c.color + '33', border: `1px solid ${c.color}`, color: '#e6ebff',
                fontFamily: '-apple-system, sans-serif', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.text}</span>
            ))}
          </div>
        </foreignObject>
      )}

      {/* Edit affordance — draws the node's REAL shape as an accent ring (unless the
          selection ring is already showing) so editing reads as "editing this shape",
          not an arbitrary rounded patch. 3D nodes edit their caption below the box. */}
      {editing && shape !== '3d' && !isSelected && (
        shape === 'none'
          ? <rect x={-(bodyHalfW+4)} y={-(bodyHalfH+4)} width={(bodyHalfW+4)*2} height={(bodyHalfH+4)*2} rx={4} fill="none" stroke="#5b6af0" strokeWidth={2} strokeDasharray="5,3" />
          : <ShapeBody shape={shape} halfW={bodyHalfW + 4} halfH={bodyHalfH + 4} r={bodyR + 4} fill="none" stroke="#5b6af0" strokeWidth={2.5} />
      )}

      {/* Edit input — transparent so the node's real shape/fill shows through; sits in the
          same inscribed area the label uses, so text lands where it reads. 3D nodes edit
          their caption below the box (the box itself is covered by the live 3D canvas). */}
      {editing && (() => {
        const is3D = shape === '3d'
        const foX = is3D ? -halfW : -labelHalfW
        const foY = is3D ? halfH + 2 : -labelHalfH
        const foW = is3D ? halfW * 2 : labelHalfW * 2
        const foH = is3D ? 26 : labelHalfH * 2
        const textColor = viewProps.textColor || '#fff'
        return (
          <foreignObject x={foX} y={foY} width={foW} height={foH}
            onMouseDown={e => e.stopPropagation()}>
            <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', boxSizing:'border-box' }}>
              <textarea ref={inputRef} value={draft} autoFocus
                onChange={e => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitEdit() }
                  if (e.key === 'Enter' && e.shiftKey) { e.stopPropagation() }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false) }
                  if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEdit(); onTab?.(node.id) }
                }}
                style={{ width:'100%', height:'100%', background: is3D ? '#1e1e3a' : 'transparent', border:'none', outline: is3D ? '1px solid #5b6af0' : 'none', borderRadius:4, color: is3D ? '#fff' : textColor, textAlign:'center', fontSize: fontSize-1, lineHeight:1.15, padding:'0 2px', boxSizing:'border-box', resize:'none', fontFamily:'inherit', overflow:'hidden', caretColor: is3D ? '#fff' : textColor }}
              ></textarea>
            </div>
          </foreignObject>
        )
      })()}

      {/* Paragraph-width handle (Miro-style) — drag the right edge to widen the wrap so the
          box is the best fit for longer text, without scaling the font (rect/roundrect only).
          Shown when selected or editing. Double-click resets to auto-fit width. */}
      {(editing || isSelected) && isAutoSized && (
        <g transform={`translate(${halfW},0) scale(${hz})`}
          onMouseDown={e => { e.stopPropagation(); onSetLabelWidth?.(e, node.id) }}
          onDoubleClick={e => { e.stopPropagation(); onResetLabelWidth?.(node.id) }}
          style={{ cursor: 'ew-resize' }}>
          <title>Drag to set text width · double-click to auto-fit</title>
          <rect x={-4} y={-14} width={8} height={28} rx={3} fill="#5b6af0" stroke="#fff" strokeWidth={1} />
          <line x1={0} y1={-6} x2={0} y2={6} stroke="#fff" strokeWidth={1} opacity={0.6} />
        </g>
      )}

      {/* 3D-node caption double-click hit area (below the box). The main body hit-area
          ellipse now lives at the bottom of the stack; double-click is on the <g>. */}
      {!editing && shape === '3d' && (
        <rect x={-halfW} y={halfH + 4} width={halfW * 2} height={22} fill="transparent"
          onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true); requestAnimationFrame(() => inputRef.current?.select()) }}
          style={{ cursor: 'text' }}
        />
      )}

      {/* Connector handle — hover only. An OUTGOING-ARROW badge (dragging it draws a line to a new
          child / another node). Offset a little further out so it doesn't overlap the text-width bar. */}
      {isHovered && (
        <g transform={`translate(${bodyHalfW},0) scale(${hz})`}
          onMouseDown={e => { e.stopPropagation(); onConnectorMouseDown(e, node.id) }}
          onMouseEnter={onMouseEnter} style={{ cursor: 'crosshair' }}>
          <title>Drag to another node to connect · drag to empty space for a new child</title>
          <circle cx={12} cy={0} r={15} fill="transparent" />
          <g transform="translate(12,0)" style={{ pointerEvents: 'none' }}>
            <circle r={8} fill="#5b6af0" stroke="#0c0c1a" strokeWidth={1.5} />
            <line x1={-4} y1={0} x2={2.5} y2={0} stroke="#fff" strokeWidth={1.6} strokeLinecap="round" />
            <polyline points="-0.5,-3.4 3.6,0 -0.5,3.4" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </g>
      )}

      {/* Single resize handle (bottom-right). Normal drag = resize node + text together.
          SHIFT-drag = resize the shape only (text keeps its size and reflows). */}
      {isHovered && (
        <g transform={`translate(${bodyHalfW},${bodyHalfH}) scale(${hz})`}
          onMouseDown={e => { e.stopPropagation(); if (e.shiftKey && shape !== '3d' && shape !== 'frame') onBoxScaleMouseDown?.(e, node.id, isAutoSized); else onScaleMouseDown(e, node.id, scale) }}
          onMouseEnter={onMouseEnter}
          style={{ cursor: 'nwse-resize' }}>
          <title>Drag to resize node + text · Shift-drag to resize the shape only (text keeps its size)</title>
          <circle r={14} fill="transparent" />
          <circle r={6} fill="#0c0c1a" stroke="#5b6af0" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
          <line x1={-3} y1={-3} x2={3} y2={3} stroke="#5b6af0" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
          <line x1={0} y1={-3} x2={3} y2={0} stroke="#5b6af0" strokeWidth={1} style={{ pointerEvents: 'none' }} />
        </g>
      )}

      {/* Delete handle (top-left) — hover only */}
      {isHovered && (
        <g transform={`translate(${-bodyHalfW},${-bodyHalfH}) scale(${hz})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDelete?.(node.id) }}
          onMouseEnter={onMouseEnter}
          style={{ cursor: 'pointer' }}>
          <title>Delete node</title>
          <circle r={14} fill="transparent" />
          <circle r={7} fill="#0c0c1a" stroke="#f87171" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
          <line x1={-3} y1={-3} x2={3} y2={3} stroke="#f87171" strokeWidth={1.6} style={{ pointerEvents: 'none' }} />
          <line x1={-3} y1={3} x2={3} y2={-3} stroke="#f87171" strokeWidth={1.6} style={{ pointerEvents: 'none' }} />
        </g>
      )}

    </g>
  )
}

// Keep a popup/menu inside the viewport. Attach via a ref callback:
//   ref={el => clampMenuEl(el, x, y, center)}
// Measures the element and sets left/top so it never spills off the right/bottom edges.
function clampMenuEl(el, x, y, center) {
  if (!el) return
  const m = 8
  const r = el.getBoundingClientRect()
  let left = center ? x - r.width / 2 : x
  let top = y
  if (left + r.width > window.innerWidth - m) left = window.innerWidth - m - r.width
  if (left < m) left = m
  if (top + r.height > window.innerHeight - m) top = window.innerHeight - m - r.height
  if (top < m) top = m
  el.style.left = left + 'px'
  el.style.top = top + 'px'
}

// Non-destructive graph filter control (property → value); clears back to full view.
function FilterControl({ defs, filter, onSet, onClear }) {
  const [open, setOpen] = useState(false)
  const [propId, setPropId] = useState(null)
  const activeDef = defs.find(d => d.id === filter?.propId)
  const valLabel = (def, value) => {
    if (value === '__any__') return 'any value'
    if (!def) return String(value)
    if (def.type === 'checkbox') return 'checked'
    if (def.type === 'select' || def.type === 'multiSelect') return (def.options || []).find(o => o.id === value)?.name || String(value)
    return String(value)
  }
  if (filter) {
    return (
      <div style={fc.pill}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>🔍 {activeDef?.name}: {valLabel(activeDef, filter.value)}</span>
        <span style={fc.x} onClick={onClear} title="Clear filter">✕</span>
      </div>
    )
  }
  return (
    <div style={{ position: 'relative' }}>
      <button style={fc.btn} onClick={() => { setOpen(o => !o); setPropId(null) }}>🔍 Filter</button>
      {open && (<>
        <div style={fc.backdrop} onClick={() => setOpen(false)} />
        <div style={fc.menu} onClick={e => e.stopPropagation()}>
          {!propId ? (
            defs.length ? defs.map(d => <div key={d.id} style={fc.item} onClick={() => setPropId(d.id)}>{d.name} <span style={{ marginLeft: 'auto', color: '#7080a0' }}>›</span></div>)
              : <div style={{ ...fc.item, color: '#8090b8' }}>No properties yet</div>
          ) : (() => {
            const d = defs.find(x => x.id === propId); if (!d) return null
            const vals = []
            if (d.type === 'select' || d.type === 'multiSelect') (d.options || []).forEach(o => vals.push({ label: o.name, value: o.id, color: o.color }))
            else if (d.type === 'checkbox') vals.push({ label: 'Checked', value: true })
            vals.push({ label: 'Has any value', value: '__any__' })
            return (<>
              <div style={fc.back} onClick={() => setPropId(null)}>‹ {d.name}</div>
              {vals.map((v, i) => (
                <div key={i} style={fc.item} onClick={() => { onSet({ propId: d.id, value: v.value }); setOpen(false) }}>
                  {v.color && <span style={{ ...fc.dot, background: v.color }} />}{v.label}
                </div>
              ))}
            </>)
          })()}
        </div>
      </>)}
    </div>
  )
}
const fc = {
  btn: { background: '#12122a', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 6, cursor: 'pointer', fontSize: '0.76rem', padding: '4px 10px' },
  pill: { display: 'flex', alignItems: 'center', gap: 8, background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 6, fontSize: '0.76rem', padding: '4px 10px' },
  x: { cursor: 'pointer', color: '#f87171', fontWeight: 700 },
  backdrop: { position: 'fixed', inset: 0, zIndex: 40 },
  menu: { position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '5px 0', minWidth: 190, maxHeight: '50vh', overflowY: 'auto', boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  item: { display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: '0.8rem', color: '#c5d0ff', cursor: 'pointer', whiteSpace: 'nowrap' },
  back: { padding: '5px 12px', fontSize: '0.72rem', color: '#8090b8', cursor: 'pointer' },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
}

// Organize = force-cluster nodes into groups by a select/tag/checkbox property. Two layouts:
// Pack (grid of cells) and Lanes (one vertical band per group). Optional Size (←Number) and
// Color (←Select) encodings. Non-destructive: computes positions live, never writes fx/fy;
// encodings are visual-only. "Done" restores the mind map.
function OrganizeControl({ defs, organize, onSet, onClear }) {
  const [open, setOpen] = useState(false)
  const groupable = defs.filter(d => d.type === 'select' || d.type === 'multiSelect' || d.type === 'checkbox')
  const numberDefs = defs.filter(d => d.type === 'number')
  const colorDefs = defs.filter(d => d.type === 'select' || d.type === 'multiSelect')
  const activeDef = defs.find(d => d.id === organize?.groupBy)

  if (organize) {
    const set = patch => onSet({ ...organize, ...patch })
    const tab = (val, cur, label) => (
      <div onClick={() => set({ layout: val })}
        style={{ ...oc.tab, ...(cur === val ? oc.tabOn : null) }}>{label}</div>
    )
    return (
      <div style={{ position: 'relative' }}>
        <div style={{ ...fc.pill, background: '#173a2a', border: '1px solid #2f7a55', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
            {organize.layout === 'lanes' ? '☰' : '▦'} {activeDef?.name || '—'}
          </span>
          <span style={{ color: '#7fd8a8' }}>⚙</span>
          <span style={fc.x} onClick={e => { e.stopPropagation(); onClear() }} title="Back to mind map">✕</span>
        </div>
        {open && (<>
          <div style={fc.backdrop} onClick={() => setOpen(false)} />
          <div style={{ ...fc.menu, minWidth: 210 }} onClick={e => e.stopPropagation()}>
            <div style={oc.label}>Layout</div>
            <div style={oc.tabRow}>{tab('pack', organize.layout, '▦ Pack')}{tab('lanes', organize.layout, '☰ Lanes')}</div>
            <PickRow label="Group by" defs={groupable} value={organize.groupBy} onPick={id => set({ groupBy: id })} />
            <PickRow label="Size by" defs={numberDefs} value={organize.sizeBy} clearable onPick={id => set({ sizeBy: id })} empty="No Number property" />
            <PickRow label="Color by" defs={colorDefs} value={organize.colorBy} clearable onPick={id => set({ colorBy: id })} empty="No Select property" />
            <div style={{ borderTop: '1px solid #2a3358', margin: '5px 0' }} />
            <div style={fc.item} onClick={() => set({ showSegments: !organize.showSegments })}>
              <span style={{ width: 16, display: 'inline-block', color: '#7fd8a8' }}>{organize.showSegments ? '✓' : ''}</span> Show links (segments)
            </div>
            <div style={{ ...fc.item, color: '#7fd8a8', fontWeight: 600 }} onClick={() => { onClear(); setOpen(false) }}>✓ Done (back to mind map)</div>
          </div>
        </>)}
      </div>
    )
  }
  return (
    <div style={{ position: 'relative' }}>
      <button style={fc.btn} onClick={() => setOpen(o => !o)} title="Cluster nodes into groups by a property (non-destructive)">▦ Organize</button>
      {open && (<>
        <div style={fc.backdrop} onClick={() => setOpen(false)} />
        <div style={fc.menu} onClick={e => e.stopPropagation()}>
          <div style={oc.label}>Group by</div>
          {groupable.length
            ? groupable.map(d => <div key={d.id} style={fc.item} onClick={() => { onSet({ groupBy: d.id, layout: 'pack', sizeBy: null, colorBy: null }); setOpen(false) }}>{d.name}</div>)
            : <div style={{ ...fc.item, color: '#8090b8' }}>Add a Select, Tags, or Checkbox property first</div>}
        </div>
      </>)}
    </div>
  )
}
// A labelled radio-style picker row used inside the Organize settings popover.
function PickRow({ label, defs, value, onPick, clearable, empty }) {
  return (
    <>
      <div style={oc.label}>{label}</div>
      {defs.length ? (
        <>
          {clearable && <div style={{ ...fc.item, color: value ? '#8090b8' : '#c5d0ff' }} onClick={() => onPick(null)}>{!value && '✓ '}None</div>}
          {defs.map(d => (
            <div key={d.id} style={{ ...fc.item, color: value === d.id ? '#fff' : '#c5d0ff' }} onClick={() => onPick(d.id)}>
              {value === d.id && '✓ '}{d.name}
            </div>
          ))}
        </>
      ) : <div style={{ ...fc.item, color: '#8090b8', fontSize: '0.74rem' }}>{empty || 'None available'}</div>}
    </>
  )
}
const oc = {
  label: { padding: '5px 12px 2px', fontSize: '0.62rem', letterSpacing: '0.06em', color: '#7080a0', textTransform: 'uppercase' },
  tabRow: { display: 'flex', gap: 4, padding: '2px 10px 6px' },
  tab: { flex: 1, textAlign: 'center', padding: '4px 6px', fontSize: '0.76rem', color: '#c5d0ff', border: '1px solid #2d3a6a', borderRadius: 5, cursor: 'pointer' },
  tabOn: { background: '#1f4a35', borderColor: '#2f7a55', color: '#fff' },
}

function EyeIcon() {
  return (
    <g>
      <ellipse rx={5} ry={3.5} fill="none" stroke="#aaa" strokeWidth={1.2} />
      <circle r={1.5} fill="#aaa" />
    </g>
  )
}

// â"€â"€â"€ ColorSubPopup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function ColorSubPopup({ colors, current, onPick, label }) {
  return (
    <div style={{
      position:'absolute', bottom:'110%', left:'50%', transform:'translateX(-50%)',
      background:'#16162a', border:'1px solid #2d3a6a', borderRadius:7,
      padding:'6px 7px', zIndex:30, boxShadow:'0 4px 20px rgba(0,0,0,0.7)',
      display:'flex', flexDirection:'column', gap:4,
    }}>
      <div style={{ fontSize:'0.6rem', color:'#555', letterSpacing:'0.06em' }}>{label}</div>
      <div style={{ display:'flex', gap:4, flexWrap:'wrap', width: 176 }}>
        {colors.map(c => (
          <div key={c} onClick={() => onPick(c)} style={{
            width:16, height:16, borderRadius:'50%', background:c, cursor:'pointer', flexShrink:0,
            border: current===c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.1)',
            boxShadow: current===c ? '0 0 0 1.5px #5b6af0' : 'none',
          }} />
        ))}
      </div>
    </div>
  )
}

// ─── Word-generator dialog ───────────────────────────────────────────────────
// Configure live auto-styling of a node's DIRECT CHILDREN: map properties → visual channels, and/or
// tag rules → saved styles. Saved to node.meta.autoStyle; the overlay engine applies it live.
function AutoStyleDialog({ node, styles, propertyDefs, onSave, onClose }) {
  const init = node.meta?.autoStyle || {}
  const [maps, setMaps] = useState(() => (init.maps || []).map(m => ({ ...m })))
  const [rules, setRules] = useState(() => (init.rules || []).map(r => ({ ...r, tagsText: (r.tags || []).join(', ') })))
  const inp = { background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 6, padding: '6px 8px', fontSize: 12.5, outline: 'none', fontFamily: '-apple-system, sans-serif' }
  const lbl = { fontSize: 11.5, color: '#8fa0d8', margin: '2px 0 6px', fontWeight: 600 }
  const rowX = { background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }
  const addBtn = { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))
  const addMap = () => setMaps(m => [...m, { propId: propertyDefs[0]?.id || '', channel: 'color' }])
  const addRule = () => setRules(r => [...r, { id: uid(), tagsText: '', styleId: styles[0]?.id || '' }])
  const save = () => {
    const cleanMaps = maps.filter(m => m.propId && m.channel).map(m => ({ propId: m.propId, channel: m.channel }))
    const cleanRules = rules
      .map(r => ({ tags: r.tagsText.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean), styleId: r.styleId }))
      .filter(r => r.tags.length && r.styleId)
    onSave({ maps: cleanMaps, rules: cleanRules }); onClose()
  }
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, sans-serif' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 520, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 12, padding: '1.1rem 1.15rem', boxShadow: '0 16px 48px rgba(0,0,0,0.7)' }}>
        <div style={{ color: '#c5d0ff', fontSize: '0.95rem', fontWeight: 700, marginBottom: 3 }}>🪄 Auto-style children</div>
        <div style={{ color: '#8090b8', fontSize: '0.76rem', marginBottom: 14, lineHeight: 1.4 }}>
          Style the direct children of <b style={{ color: '#a9b6ee' }}>“{node.label || 'this node'}”</b> automatically. Updates live as their tags/properties change.
        </div>

        <div style={{ ...lbl, fontSize: 12.5, color: '#c5d0ff', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Map a property → style</div>
        {maps.length === 0 && <div style={{ color: '#7080a0', fontSize: 12, marginBottom: 8 }}>No mappings yet.</div>}
        {maps.map((m, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
            <select value={m.propId} onChange={e => setMaps(a => a.map((x, j) => j === i ? { ...x, propId: e.target.value } : x))} style={{ ...inp, flex: 1 }}>
              {(propertyDefs || []).length === 0 && <option value="">(no properties)</option>}
              {(propertyDefs || []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <span style={{ color: '#7080a0', fontSize: 13 }}>→</span>
            <select value={m.channel} onChange={e => setMaps(a => a.map((x, j) => j === i ? { ...x, channel: e.target.value } : x))} style={{ ...inp, flex: 1 }}>
              {STYLE_CHANNELS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <button style={rowX} onClick={() => setMaps(a => a.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button style={{ ...addBtn, marginBottom: 16 }} onClick={addMap} disabled={!(propertyDefs || []).length}>＋ Add mapping</button>

        <div style={{ ...lbl, fontSize: 12.5, color: '#c5d0ff', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Style rules (tags → saved style)</div>
        {!styles.length && <div style={{ color: '#f6ad55', fontSize: 11.5, marginBottom: 8 }}>No saved styles yet — style a node, then “Save style”, and it’ll appear here.</div>}
        {rules.map((r, i) => (
          <div key={r.id || i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
            <span style={{ color: '#7080a0', fontSize: 12 }}>if</span>
            <input value={r.tagsText} onChange={e => setRules(a => a.map((x, j) => j === i ? { ...x, tagsText: e.target.value } : x))}
              placeholder="task, urgent, marketing" style={{ ...inp, flex: 1.3 }} />
            <span style={{ color: '#7080a0', fontSize: 12 }}>→</span>
            <select value={r.styleId} onChange={e => setRules(a => a.map((x, j) => j === i ? { ...x, styleId: e.target.value } : x))} style={{ ...inp, flex: 1 }} disabled={!styles.length}>
              {!styles.length && <option value="">(none)</option>}
              {styles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button style={rowX} onClick={() => setRules(a => a.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <div style={{ color: '#7080a0', fontSize: 10.5, margin: '2px 0 8px' }}>Comma-separated tags; a child needs ALL of them to match. First matching rule wins, and rules override mappings.</div>
        <button style={{ ...addBtn, marginBottom: 18 }} onClick={addRule} disabled={!styles.length}>＋ Add rule</button>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #2d3a6a', color: '#9aa8d8', borderRadius: 7, padding: '7px 14px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={save} style={{ background: 'linear-gradient(#2a327a, #1e2358)', border: '1px solid #3a4a8a', color: '#e6ebff', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Save</button>
        </div>
      </div>
    </div>
  )
}

// Type a verbal prompt → Claude writes content straight into the node.
// Two phases: compose (prompt + target) → review (editable preview → Apply).
function GenerateDialog({ node, nearby, onApply, onClose }) {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('prose')          // 'prose' | 'list' | 'label'
  const [append, setAppend] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [result, setResult] = useState(null)         // editable preview once generated
  const [keyInput, setKeyInput] = useState(() => getWordgenKey())
  const [live, setLive] = useState(() => hasWordgenKey())
  const hasNotes = !!(node.notes || '').trim()

  const inp = { width: '100%', boxSizing: 'border-box', background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 7, padding: '7px 9px', fontSize: 13, outline: 'none', fontFamily: '-apple-system, sans-serif' }
  const lbl = { fontSize: 11.5, color: '#8fa0d8', margin: '0 0 4px', display: 'block', fontWeight: 600 }
  const MODES = [
    { k: 'prose', icon: '📝', label: 'Notes', hint: "Write into this node's note body" },
    { k: 'list', icon: '🌿', label: 'Child nodes', hint: 'Spin up a list of children' },
    { k: 'label', icon: '✏️', label: 'Rename', hint: 'Rewrite this node\'s label' },
  ]

  const run = async () => {
    if (!prompt.trim()) return
    setBusy(true); setErr(null)
    try {
      const text = await generateContent(prompt.trim(), {
        mode,
        context: { label: node.label, note: node.notes, nearby },
      })
      if (!text) { setErr('Nothing came back — try again or rephrase.'); return }
      setResult(text)
    } catch (e) {
      setErr(e?.message || 'Generation failed.')
    } finally { setBusy(false) }
  }

  const previewCount = result != null && mode === 'list'
    ? result.split('\n').map(s => s.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter(Boolean).length : 0

  return (
    <div onMouseDown={() => { if (!busy) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, sans-serif' }}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ width: 440, maxWidth: '94vw', background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 12, padding: '1.1rem 1.15rem', boxShadow: '0 16px 48px rgba(0,0,0,0.7)' }}>
        <div style={{ color: '#c5d0ff', fontSize: '0.95rem', fontWeight: 700, marginBottom: 3 }}>✨ Generate content</div>
        <div style={{ color: '#8090b8', fontSize: '0.76rem', marginBottom: 12, lineHeight: 1.4 }}>
          Describe what you want for <b style={{ color: '#a9b6ee' }}>“{node.label || 'this node'}”</b> and Claude writes it directly here.
        </div>

        <label style={lbl}>Prompt</label>
        <textarea autoFocus value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
          placeholder="e.g. Summarize the pros and cons of this approach&#10;or: list 6 subtopics to explore&#10;or: a punchier name for this"
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run() } }}
          style={{ ...inp, marginBottom: 12, resize: 'vertical', lineHeight: 1.45 }} />

        <label style={lbl}>Put the result into</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: hasNotes && mode === 'prose' ? 8 : 12 }}>
          {MODES.map(m => (
            <button key={m.k} title={m.hint} onClick={() => { setMode(m.k); setResult(null) }}
              style={{ flex: 1, background: mode === m.k ? '#232a5c' : '#0e0e1c', border: `1px solid ${mode === m.k ? '#4a5aa8' : '#2a2f47'}`, color: mode === m.k ? '#dbe2ff' : '#8fa0d8', borderRadius: 8, padding: '7px 4px', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 15 }}>{m.icon}</span>{m.label}
            </button>
          ))}
        </div>
        {mode === 'prose' && hasNotes && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={append} onChange={e => setAppend(e.target.checked)} style={{ width: 15, height: 15, accentColor: '#5b6af0' }} />
            <span style={{ fontSize: 12.5, color: '#c5d0ff' }}>Append to existing note <span style={{ color: '#8090b8' }}>(otherwise replaces it)</span></span>
          </label>
        )}

        {result != null && (
          <>
            <label style={lbl}>Preview{mode === 'list' ? ` — ${previewCount} node${previewCount === 1 ? '' : 's'} (one per line, editable)` : ' (editable)'}</label>
            <textarea value={result} onChange={e => setResult(e.target.value)} rows={mode === 'label' ? 1 : 6}
              style={{ ...inp, marginBottom: 12, resize: 'vertical', lineHeight: 1.45 }} />
          </>
        )}

        {!live && (
          <div style={{ background: '#0e0e1c', border: '1px solid #2a2f47', borderRadius: 8, padding: '8px 10px', marginBottom: 12 }}>
            <div style={{ color: '#f6ad55', fontSize: '0.72rem', marginBottom: 6 }}>Paste an Anthropic key for generation (stored only in this browser).</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="sk-ant-…" type="password" style={{ ...inp, flex: 1 }} />
              <button onClick={() => { setWordgenKey(keyInput.trim()); setLive(hasWordgenKey()) }}
                style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 7, padding: '0 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Save</button>
            </div>
          </div>
        )}

        {err && <div style={{ color: '#f87171', fontSize: '0.76rem', marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button disabled={busy} onClick={onClose} style={{ background: 'transparent', border: '1px solid #2d3a6a', color: '#9aa8d8', borderRadius: 7, padding: '7px 14px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          {result != null && (
            <button disabled={busy} onClick={run} style={{ background: 'transparent', border: '1px solid #3a4a8a', color: '#a9b6ee', borderRadius: 7, padding: '7px 14px', cursor: busy ? 'default' : 'pointer', fontSize: 13 }}>{busy ? '…' : '↻ Redo'}</button>
          )}
          {result == null ? (
            <button disabled={busy || !prompt.trim()} onClick={run}
              style={{ background: busy ? '#2a3260' : 'linear-gradient(#2a327a, #1e2358)', border: '1px solid #3a4a8a', color: '#e6ebff', borderRadius: 7, padding: '7px 16px', cursor: busy || !prompt.trim() ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: !prompt.trim() ? 0.55 : 1 }}>
              {busy ? 'Generating…' : 'Generate'}
            </button>
          ) : (
            <button disabled={busy || !result.trim()} onClick={() => onApply(mode, result, { append })}
              style={{ background: 'linear-gradient(#2a7a4a, #1e5838)', border: '1px solid #3a8a5a', color: '#e6ffef', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              {mode === 'list' ? 'Add nodes' : mode === 'label' ? 'Rename' : 'Apply'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function WordgenDialog({ nodeLabel, mode, busy, err, onRun, onClose }) {
  const [count, setCount] = useState(8)
  const [modifier, setModifier] = useState('')
  const [seeds, setSeeds] = useState('')
  const [assess, setAssess] = useState(false)
  const [keyInput, setKeyInput] = useState(() => getWordgenKey())
  const [live, setLive] = useState(() => hasWordgenKey())
  const inp = { width: '100%', boxSizing: 'border-box', background: '#0e0e1c', border: '1px solid #2d3a6a', color: '#dbe2ff', borderRadius: 7, padding: '7px 9px', fontSize: 13, outline: 'none' }
  const lbl = { fontSize: 11.5, color: '#8fa0d8', margin: '0 0 4px', display: 'block', fontWeight: 600 }
  return (
    <div onMouseDown={() => { if (!busy) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, sans-serif' }}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ width: 380, maxWidth: '92vw', background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 12, padding: '1.1rem 1.15rem', boxShadow: '0 16px 48px rgba(0,0,0,0.7)' }}>
        <div style={{ color: '#c5d0ff', fontSize: '0.95rem', fontWeight: 700, marginBottom: 3 }}>
          {mode === 'words' ? '⚡ Generate words' : '🎲 Generate variations'}
        </div>
        <div style={{ color: '#8090b8', fontSize: '0.76rem', marginBottom: 12, lineHeight: 1.4 }}>
          {mode === 'words'
            ? <>Uses <b style={{ color: '#a9b6ee' }}>“{nodeLabel || 'this node'}”</b> as the theme and its non-generated children as criteria. New words are added as children.</>
            : <>Creates variations of <b style={{ color: '#a9b6ee' }}>“{nodeLabel || 'this word'}”</b> as its children.</>}
        </div>

        <label style={lbl}>How many</label>
        <input type="number" min={1} max={30} value={count} onChange={e => setCount(Math.max(1, Math.min(30, +e.target.value || 1)))} style={{ ...inp, marginBottom: 10 }} />

        <label style={lbl}>Modifier prompt (optional)</label>
        <input value={modifier} onChange={e => setModifier(e.target.value)} placeholder="e.g. more sci-fi, shorter, Latin roots" style={{ ...inp, marginBottom: 10 }} />

        <label style={lbl}>Seed / example words (optional)</label>
        <textarea value={seeds} onChange={e => setSeeds(e.target.value)} rows={2} placeholder="Made-up or real, comma / line separated — steer the style" style={{ ...inp, marginBottom: 12, resize: 'vertical', fontFamily: 'inherit' }} />
        {mode === 'variations' && <div style={{ color: '#8090b8', fontSize: '0.7rem', marginTop: -6, marginBottom: 10 }}>Inherits the master’s brief + criteria automatically.</div>}

        <label title={live ? '' : 'Requires an API key'} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.5 }}>
          <input type="checkbox" checked={assess && live} disabled={!live} onChange={e => setAssess(e.target.checked)} style={{ width: 15, height: 15, accentColor: '#5b6af0' }} />
          <span style={{ fontSize: 12.5, color: '#c5d0ff' }}>⚠ Assess infringement risk <span style={{ color: '#8090b8' }}>— rings each name green/amber/red{live ? '' : ' (needs API key)'}</span></span>
        </label>

        {!live && (
          <div style={{ background: '#0e0e1c', border: '1px solid #2a2f47', borderRadius: 8, padding: '8px 10px', marginBottom: 12 }}>
            <div style={{ color: '#f6ad55', fontSize: '0.72rem', marginBottom: 6 }}>No API key set — using the built-in stub generator (fake words). Paste an Anthropic key for real generation (stored only in this browser).</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="sk-ant-…" type="password" style={{ ...inp, flex: 1 }} />
              <button onClick={() => { setWordgenKey(keyInput.trim()); setLive(hasWordgenKey()) }}
                style={{ background: '#232a5c', border: '1px solid #3a4a8a', color: '#d3daff', borderRadius: 7, padding: '0 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Save</button>
            </div>
          </div>
        )}
        {live && <div style={{ color: '#7bd88f', fontSize: '0.72rem', marginBottom: 12 }}>✓ Live generation (Anthropic key set). <span onClick={() => { setWordgenKey(''); setLive(false) }} style={{ color: '#8090b8', cursor: 'pointer', textDecoration: 'underline' }}>clear key</span></div>}

        {err && <div style={{ color: '#f87171', fontSize: '0.76rem', marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button disabled={busy} onClick={onClose} style={{ background: 'transparent', border: '1px solid #2d3a6a', color: '#9aa8d8', borderRadius: 7, padding: '7px 14px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button disabled={busy} onClick={() => onRun(count, modifier.trim(), seeds.trim(), assess && live)}
            style={{ background: busy ? '#2a3260' : 'linear-gradient(#2a327a, #1e2358)', border: '1px solid #3a4a8a', color: '#e6ebff', borderRadius: 7, padding: '7px 16px', cursor: busy ? 'default' : 'pointer', fontSize: 13, fontWeight: 600 }}>
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}

// â"€â"€â"€ NodeToolbar â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetStrokeColor, onSetStrokeWidth, onSetStrokeDash, onSetBorderBlur, onSetOpacity, onSetShadow, onSetBorderFx, onSetBorderFxAmp, onSetBorderFxCount, onSetSpin, onSetShape, onDrill, onToggleList, isList, onToggleKanban, isKanban, onToggleStrategy, isStrategy, onMakeContainer, onGroupBoard, hasChildrenForList, childrenEffect, onSetChildrenEffect, onHide, onRelease, onDelete, onNotesChange, isAnchored, onRadiate, onSetMotion, onSetColorCycle, onAddEmoji, onRemoveEmojiById, customEmojis, onAddCustomEmoji, onRemoveCustomEmoji, onAddNodeImage, onSetNodeImagePosition, onRemoveNodeImageById, onMouseEnter, onMouseLeave, onWheel , imageUrl, onSetImageUrl, depthExpand, onSetDepthExpand, maxExpandRadius, nodeId,
  styles = [], onSaveStyle, onUpdateStyle, onRenameStyle, onDeleteStyle, onApplyStyle, onArrange, onReleaseChildren, onDuplicate, onGenContent, onGenWords, onGenVariations, onAutoStyle, selCount = 0,
  propertyDefs = [], nodeProps = {}, onSetNodeProp, onAddPropertyDef, onAddSelectOption, onTogglePropChip,
  tags = [], allTags = [], onAddTag, onRemoveTag,
  floating = false, onUndock, onRedock, nodeTitle }) {
  const shape = viewProps.shape || 'circle'
  const [panel, setPanel] = useState(null) // null | 'color' | 'shape' | 'shadow' | 'styles' | 'note' | 'radiate' | 'motion' | 'emoji' | 'image'
  const [panelTop, setPanelTop] = useState(0) // y-offset of the row that opened the flyout, so it appears next to it
  // Panels grouped under the top-level "Style" row — rendered as a persistent two-pane popover
  // (sub-list on the left, active pane on the right) so you can hop between them without the list vanishing.
  const STYLE_PANES = ['color', 'shape', 'border', 'shadow', 'styles', 'motion', 'radiate']
  // Hover-intent: don't switch/close the flyout the instant a row is grazed — wait a beat so the pointer
  // can travel diagonally to the open flyout without intermediate rows yanking it away.
  const panelTimerRef = useRef(null)
  const cancelPanelTimer = () => { if (panelTimerRef.current) { clearTimeout(panelTimerRef.current); panelTimerRef.current = null } }
  const queuePanel = (p, top) => { cancelPanelTimer(); panelTimerRef.current = setTimeout(() => { setPanel(p); if (top != null) setPanelTop(top) }, 90) }
  const openPanelNow = (p, top) => { cancelPanelTimer(); setPanel(p); if (top != null) setPanelTop(top) }
  useEffect(() => () => cancelPanelTimer(), [])
  const [newStyleName, setNewStyleName] = useState('')
  const [notesDraft, setNotesDraft] = useState(notes)
  const [emojiInput, setEmojiInput] = useState('')
  const [emojiSearch, setEmojiSearch] = useState('')
  const [emojiCategory, setEmojiCategory] = useState(0)
  const [colorPopup, setColorPopup] = useState(null) // 'fill' | 'text' | null
  const [tagDraft, setTagDraft] = useState('')

  useEffect(() => { setNotesDraft(notes) }, [notes])

  const processImageFile = useCallback((file, position = 'above') => {
    if (!file || !file.type?.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const MAX = 90
        const ar = img.naturalWidth / img.naturalHeight || 1
        const w0 = ar >= 1 ? MAX : MAX * ar
        const h0 = ar >= 1 ? MAX / ar : MAX
        onAddNodeImage?.(reader.result, w0, h0, position)
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  }, [onAddNodeImage])

  // While the Image panel is open, Ctrl+V anywhere pastes an image from the clipboard.
  useEffect(() => {
    if (panel !== 'image') return
    const onPaste = e => {
      const item = Array.from(e.clipboardData?.items || []).find(it => it.type?.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      processImageFile(item.getAsFile(), 'above')
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [panel, processImageFile])

  // Close sub-panel when clicking outside the toolbar
  useEffect(() => {
    if (!panel) return
    const onDown = e => {
      if (!e.target.closest('[data-nodetoolbar]')) setPanel(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [panel])

  const shapeIcons = { circle:'○', ellipse:'⬭', roundrect:'▭', rect:'□', diamond:'◇', none:'╌', '3d':'⬡' }

  const wrap = floating ? {
    position:'relative', background:'#16162a', border:'1px solid #3a4a8a', borderRadius:10,
    padding: 4, minWidth: 200, boxShadow:'0 12px 40px rgba(0,0,0,0.7)', pointerEvents:'all',
  } : {
    position:'absolute', left: x, top: y,
    background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8,
    padding: 4, minWidth: 184,
    boxShadow:'0 4px 20px rgba(0,0,0,0.6)', zIndex:20, pointerEvents:'all',
  }
  // Sub-sections fly out beside the toolbar (flip to the left near the right screen edge).
  const flipLeft = typeof window !== 'undefined' && x > window.innerWidth * 0.6
  const flyout = {
    position:'absolute', top: Math.max(-1, panelTop - 6),   // align to the row that opened it (near the cursor)
    [flipLeft ? 'right' : 'left']: '100%',
    [flipLeft ? 'marginRight' : 'marginLeft']: 0,   // flush with the menu — no dead-zone gap to cross
    background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8,
    // Invisible 6px bridge on the menu-facing side (part of the flyout, so hovering it keeps it open).
    // Declared AFTER `border` so the shorthand doesn't reset it.
    [flipLeft ? 'borderRight' : 'borderLeft']: '6px solid transparent',
    padding:'8px 10px', minWidth:210, maxWidth:284, maxHeight:'72vh', overflowY:'auto',
    boxShadow:'0 6px 24px rgba(0,0,0,0.6)', zIndex:21,
  }
  // Text menu row — matches the canvas right-click menu styling.
  // opts.opens: panel id to open on hover (submenu row), or null to close any open flyout
  // (leaf/action row). Undefined = don't touch the flyout on hover.
  const textRow = (label, onClick, opts = {}) => {
    const isOpen = opts.opens != null && (panel === opts.opens || (opts.opens === 'color' && STYLE_PANES.includes(panel)))
    return (
      <div onClick={e => { cancelPanelTimer(); if (opts.opens != null) setPanelTop(e.currentTarget.offsetTop); onClick?.() }}
        onMouseEnter={e => { e.currentTarget.style.background = '#23234a'; if (opts.opens != null) queuePanel(opts.opens, e.currentTarget.offsetTop) }}
        onMouseLeave={e => { e.currentTarget.style.background = isOpen ? '#23234a' : 'transparent' }}
        style={{ padding:'6px 12px', fontSize:'0.82rem', color: opts.color || '#c5d0ff', cursor:'pointer',
          background: isOpen ? '#23234a' : 'transparent',
          whiteSpace:'nowrap', borderRadius:4, display:'flex', justifyContent:'space-between', gap:16 }}>
        <span style={{ display:'flex', alignItems:'center', gap:9 }}>
          {opts.icon && <span style={{ width:16, textAlign:'center', fontSize:'0.88rem', opacity:0.9, flexShrink:0 }}>{opts.icon}</span>}
          <span>{label}</span>
        </span>{opts.right && <span style={{ color: opts.rightColor || '#8090b8' }}>{opts.right}</span>}
      </div>
    )
  }

  const iconBtn = (active) => ({
    background: active ? '#2d3a6a' : 'transparent',
    border: `1px solid ${active ? '#5b6af0' : '#2a3358'}`,
    color: active ? '#c5d0ff' : '#7080a0',
    borderRadius:5, cursor:'pointer', fontSize:'1rem', padding:'4px 7px', lineHeight:1,
  })

  const backBtn = {
    background:'transparent', border:'none', color:'#8090b8', cursor:'pointer',
    fontSize:'0.78rem', padding:'0 4px 0 0', lineHeight:1,
  }
  const arrangeBtn = { background:'#12122a', border:'1px solid #2a3358', color:'#c5d0ff', borderRadius:5, cursor:'pointer', fontSize:'0.72rem', padding:'4px 8px' }
  const styleMiniBtn = { background:'transparent', border:'none', color:'#7b8fcc', cursor:'pointer', fontSize:'0.82rem', padding:'0 3px', lineHeight:1 }
  const styleApplyBtn = { background:'#1a1f4a', border:'1px solid #3a4a8a', color:'#c5d0ff', borderRadius:4, cursor:'pointer', fontSize:'0.68rem', padding:'2px 7px', whiteSpace:'nowrap' }

  return (
    <div style={wrap}
      ref={floating ? undefined : (el => clampMenuEl(el, x, y, true))}
      data-nodetoolbar="1"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
    >
      {/* Header: drag bar + re-dock when floating; a small ⤢ undock affordance when docked. */}
      {floating ? (
        <div className="pim-tb-drag" style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 6px 6px', cursor:'move', borderBottom:'1px solid #23234a', marginBottom:2 }}>
          <span style={{ color:'#8090b8', fontSize:12 }}>⠿</span>
          <span style={{ flex:1, color:'#c5d0ff', fontSize:'0.78rem', fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{nodeTitle || 'Style'}</span>
          <button title="Re-dock the panel" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRedock?.() }} style={{ background:'transparent', border:'none', color:'#8090b8', cursor:'pointer', fontSize:13, lineHeight:1 }}>⤢</button>
        </div>
      ) : (
        <button title="Undock into a floating window" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onUndock?.() }}
          style={{ position:'absolute', top:3, right:4, background:'transparent', border:'none', color:'#6b7bb0', cursor:'pointer', fontSize:12, lineHeight:1, padding:2, zIndex:1 }}>⤢</button>
      )}
      {/* â"€â"€ Main text menu (always visible; sub-sections fly out beside it) â"€â"€ */}
      <>
        {textRow('Style', () => openPanelNow('color'), { icon: '🎨', right: '›', opens: 'color' })}
        {textRow(selCount > 1 ? `Arrange (${selCount} selected)` : 'Arrange', () => setPanel('arrange'), { icon: '▦', right: '›', opens: 'arrange' })}
        {shape === 'image' && textRow('Image URL', () => setPanel('imageUrl'), { icon: '🔗', right: '›', opens: 'imageUrl' })}
        {textRow('Notes', () => setPanel('note'), { icon: '📝', right: notes ? '•' : '›', rightColor: notes ? '#88b4e8' : '#8090b8', opens: 'note' })}
        {textRow('Properties', () => setPanel('props'), (() => {
          const set = Object.values(nodeProps).filter(v => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)).length
          return { icon: '🏷️', right: set > 0 ? String(set) : '›', rightColor: set > 0 ? '#88b4e8' : '#8090b8', opens: 'props' }
        })())}
        {onAddTag && textRow('Tags', () => setPanel('tags'), { icon: '🔖', right: tags.length ? String(tags.length) : '›', rightColor: tags.length ? '#88b4e8' : '#8090b8', opens: 'tags' })}
        {textRow('Emoji', () => setPanel('emoji'), { icon: '😀', right: '›', opens: 'emoji' })}
        {textRow('Image', () => setPanel('image'), { icon: '🖼️', right: (viewProps.nodeImages || []).length > 0 ? '•' : '›', rightColor: (viewProps.nodeImages || []).length > 0 ? '#88b4e8' : '#8090b8', opens: 'image' })}
        {hasChildrenForList && textRow('Effects (children)', () => setPanel('effects'), { icon: '✨', right: childrenEffect ? '•' : '›', rightColor: childrenEffect ? '#8ecbff' : '#8090b8', opens: 'effects' })}
        {textRow(depthExpand !== null ? `Expand hops (+${depthExpand.radius})` : 'Expand hops', () => {
          if (depthExpand !== null) { onSetDepthExpand?.(null) }
          else { onSetDepthExpand?.({ nodeId, radius: 1 }); setPanel('expand') }
        }, { icon: '⊕', right: depthExpand !== null ? '×' : '›', rightColor: depthExpand !== null ? '#f6ad55' : '#8090b8', opens: null })}
        <div style={{ borderTop:'1px solid #2a3358', margin:'3px 6px' }} />
        {onDuplicate && textRow('Duplicate', onDuplicate, { icon: '⧉', opens: null })}
        {onGenContent && textRow('Generate…', onGenContent, { icon: '✨', opens: null })}
        {onGenWords && textRow('Generate words', onGenWords, { icon: '⚡', opens: null })}
        {onGenVariations && textRow('Generate variations', onGenVariations, { icon: '🎲', opens: null })}
        {textRow('Drill in', onDrill, { icon: '🔎', opens: null })}
        {hasChildrenForList && textRow('Show as…', () => setPanel('showas'), { icon: '▧', right: (isList || isKanban || isStrategy) ? '•' : '›', rightColor: (isList || isKanban || isStrategy) ? '#f6ad55' : '#8090b8', opens: 'showas' })}
        {hasChildrenForList && onAutoStyle && textRow('Auto-style children…', onAutoStyle, { icon: '🪄', opens: null })}
        {textRow('Hide', onHide, { icon: '🙈', opens: null })}
        {isAnchored && textRow('Release anchor', onRelease, { icon: '⚓', color: '#f6ad55', opens: null })}
        {textRow('Delete', onDelete, { icon: '🗑️', color: '#f87171', opens: null })}
      </>

      {/* â"€â"€ Fly-out sub-menu (holds whichever section is active) â"€â"€ */}
      {panel && (<div
        style={STYLE_PANES.includes(panel) ? { ...flyout, display: 'flex', gap: 10, maxWidth: 540, alignItems: 'flex-start' } : flyout}
        onMouseDown={e => e.stopPropagation()} onMouseEnter={cancelPanelTimer}>
      {/* Persistent sub-list for the grouped Style panes (Color / Shape / Shadow / …) */}
      {STYLE_PANES.includes(panel) && (() => {
        const sub = (target, icon, label, on) => (
          <div key={target} onMouseEnter={() => openPanelNow(target)} onClick={() => openPanelNow(target)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap',
              fontSize: '0.8rem', background: panel === target ? '#23234a' : 'transparent', color: panel === target ? '#c5d0ff' : '#aab4dd' }}>
            <span style={{ width: 15, textAlign: 'center', fontSize: '0.85rem' }}>{icon}</span><span>{label}</span>
            {on && <span style={{ marginLeft: 'auto', color: '#88b4e8', fontSize: '0.7rem' }}>•</span>}
          </div>
        )
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 126, borderRight: '1px solid #23233e', paddingRight: 8, flexShrink: 0 }}>
            <div style={{ fontSize: '0.62rem', color: '#7080a0', letterSpacing: '0.08em', padding: '2px 9px 4px' }}>STYLE</div>
            {sub('color', '🎨', 'Color')}
            {sub('shape', '◆', 'Shape')}
            {sub('border', '❋', 'Border', viewProps.borderFx || viewProps.spin)}
            {sub('shadow', '🌑', 'Shadow', viewProps.shadow && (viewProps.shadow.opacity ?? 0) > 0)}
            {sub('styles', '🎭', 'Styles')}
            {sub('motion', '🌀', 'Motion', viewProps.nodeMotion || viewProps.nodeColorCycle)}
            {sub('radiate', '📡', 'Radiate')}
          </div>
        )
      })()}
      {/* â"€â"€ Shadow panel â"€â"€ */}
      {panel === 'shadow' && (() => {
        const sh = viewProps.shadow || {}
        const on = (sh.opacity ?? 0) > 0
        const set = (patch) => onSetShadow?.({ distance: sh.distance ?? 8, softness: sh.softness ?? 5, opacity: sh.opacity ?? 0.4, ...patch })
        const slider = (label, key, min, max, step, val, fmt) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: '#8090b8' }}>
              <span>{label}</span><span style={{ color: '#c5d0ff' }}>{fmt(val)}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={val}
              onChange={e => set({ [key]: parseFloat(e.target.value) })}
              style={{ width: '100%', accentColor: '#5b6af0', cursor: 'pointer' }} />
          </div>
        )
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 196 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: '0.72rem', color: '#7080a0', letterSpacing: '0.06em' }}>SHADOW</span>
              <button onClick={() => on ? onSetShadow?.(null) : set({ opacity: 0.4 })}
                style={{ background: on ? '#20264e' : 'transparent', border: '1px solid #3a4a8a', color: on ? '#c5d0ff' : '#8090b8', borderRadius: 5, cursor: 'pointer', fontSize: '0.7rem', padding: '2px 9px' }}>
                {on ? 'On' : 'Off'}
              </button>
            </div>
            {slider('Distance', 'distance', 0, 30, 1, sh.distance ?? 8, v => `${Math.round(v)}px`)}
            {slider('Softness', 'softness', 0, 30, 1, sh.softness ?? 5, v => `${Math.round(v)}px`)}
            {slider('Opacity', 'opacity', 0, 1, 0.05, sh.opacity ?? 0.4, v => `${Math.round(v * 100)}%`)}
            <div style={{ fontSize: '0.66rem', color: '#8090b8', lineHeight: 1.4 }}>Casts a soft drop shadow down-right. New nodes inherit your latest look.</div>
          </div>
        )
      })()}
      {/* â"€â"€ Border treatment panel (decorated perimeter + rotation) â"€â"€ */}
      {panel === 'border' && (() => {
        const fx = viewProps.borderFx || null
        const amp = viewProps.borderFxAmp ?? 0.15
        const count = viewProps.borderFxCount ?? 8
        const spin = viewProps.spin || 0   // seconds per revolution (0 = no spin)
        const TREATMENTS = [['none', 'None'], ['star', 'Star'], ['jagged', 'Jagged'], ['zigzag', 'Zigzag'], ['wave', 'Wave'], ['petal', 'Petal'], ['scallop', 'Scallop'], ['bloom', 'Bloom'], ['gear', 'Gear']]
        const pillBtn = (active) => ({ background: active ? '#2d3a6a' : '#12122a', border: `1px solid ${active ? '#5b6af0' : '#2a3358'}`, color: active ? '#fff' : '#aab4dd', borderRadius: 6, cursor: 'pointer', fontSize: '0.72rem', padding: '4px 9px' })
        const slider = (label, val, min, max, step, fmt, on) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: '#8090b8' }}><span>{label}</span><span style={{ color: '#c5d0ff' }}>{fmt(val)}</span></div>
            <input type="range" min={min} max={max} step={step} value={val} onChange={e => on(parseFloat(e.target.value))} style={{ width: '100%', accentColor: '#5b6af0', cursor: 'pointer' }} />
          </div>
        )
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 210 }}>
            <span style={{ fontSize: '0.72rem', color: '#7080a0', letterSpacing: '0.06em' }}>BORDER TREATMENT</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {TREATMENTS.map(([v, lbl]) => (
                <button key={v} style={pillBtn((fx || 'none') === v)} onClick={() => onSetBorderFx?.(v === 'none' ? null : v)}>{lbl}</button>
              ))}
            </div>
            {fx && slider('Depth', amp, 0.03, 0.5, 0.01, v => `${Math.round(v * 100)}%`, v => onSetBorderFxAmp?.(v))}
            {fx && slider('Count', count, 3, 40, 1, v => `${Math.round(v)}`, v => onSetBorderFxCount?.(Math.round(v)))}
            <div style={{ borderTop: '1px solid #2a3358', margin: '2px 0' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: '0.72rem', color: '#7080a0', letterSpacing: '0.06em' }}>SPIN</span>
              <button onClick={() => onSetSpin?.(spin ? 0 : 6)}
                style={{ background: spin ? '#20264e' : 'transparent', border: '1px solid #3a4a8a', color: spin ? '#c5d0ff' : '#8090b8', borderRadius: 5, cursor: 'pointer', fontSize: '0.7rem', padding: '2px 9px' }}>
                {spin ? 'On' : 'Off'}
              </button>
            </div>
            {/* Slider is revolutions-per-minute for intuition; stored as seconds/rev. Higher = faster. */}
            {spin > 0 && slider('Speed', 60 / spin, 3, 120, 1, v => `${Math.round(v)} rpm`, v => onSetSpin?.(60 / Math.max(1, v)))}
            <div style={{ fontSize: '0.66rem', color: '#8090b8', lineHeight: 1.4 }}>Treatments reshape the outline into a decorated blob. Spin rotates the shape continuously (the label stays upright).</div>
          </div>
        )
      })()}
      {/* â"€â"€ Properties panel (Notion-style DB fields for this node) â"€â"€ */}
      {panel === 'props' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8, minWidth:220 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>PROPERTIES</span>
          </div>
          {propertyDefs.length === 0 && (
            <div style={{ fontSize:'0.75rem', color:'#8090b8', lineHeight:1.4 }}>No properties yet. Add one below — they're shared across the whole project (visible in the Table view too).</div>
          )}
          {propertyDefs.map(def => (
            <div key={def.id} style={{ display:'flex', flexDirection:'column', gap:2 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6 }}>
                <span style={{ fontSize:'0.62rem', color:'#8090b8', letterSpacing:'0.04em' }}>{def.name}</span>
                <button title="Show as a chip on the node" onClick={() => onTogglePropChip?.(def.id)}
                  style={{ background:'transparent', border:'none', cursor:'pointer', fontSize:'0.6rem', color: def.showChip ? '#88b4e8' : '#7080a0' }}>
                  {def.showChip ? '◉ on canvas' : '○ on canvas'}
                </button>
              </div>
              <div style={{ border:'1px solid #2a3358', borderRadius:5, padding:'3px 7px', minHeight:24, display:'flex', alignItems:'center' }}>
                <PropertyField def={def} value={nodeProps[def.id]}
                  onChange={v => onSetNodeProp?.(def.id, v)}
                  onAddOption={(name, color) => onAddSelectOption?.(def.id, name, color)} />
              </div>
            </div>
          ))}
          <div style={{ borderTop:'1px solid #2a3358', margin:'2px 0' }} />
          <div style={{ display:'flex', flexWrap:'wrap', gap:4, alignItems:'center' }}>
            <span style={{ fontSize:'0.62rem', color:'#7080a0' }}>Add:</span>
            {PROP_TYPES.map(t => (
              <button key={t.type} title={t.label} onClick={() => onAddPropertyDef?.(t.type)}
                style={{ background:'transparent', border:'1px solid #2a3358', borderRadius:4, color:'#c5d0ff', cursor:'pointer', fontSize:'0.66rem', padding:'2px 6px' }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* â"€â"€ Color panel â"€â"€ */}
      {panel === 'color' && (
        <div style={{ display:'flex', flexDirection:'column', gap:7, minWidth:190 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>COLOR</span>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#7080a0', marginBottom:4, letterSpacing:'0.05em' }}>FILL</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              <div title="Transparent" onClick={() => onSetFill('none')} style={{
                width:18, height:18, borderRadius:4, cursor:'pointer',
                backgroundImage: 'linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%)',
                backgroundSize: '6px 6px', backgroundPosition: '0 0, 3px 3px',
                border: (viewProps.fillColor==='none'||!viewProps.fillColor) ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.1)',
              }} />
              {COLOR_PALETTE.map(c => (
                <div key={c} onClick={() => onSetFill(c)} style={{
                  width:18, height:18, borderRadius:4, background:c, cursor:'pointer',
                  border: viewProps.fillColor===c ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.1)',
                }} />
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#7080a0', marginBottom:4, letterSpacing:'0.05em' }}>OUTLINE</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              <div title="No outline" onClick={() => { onSetStrokeColor(null); onSetStrokeWidth(0) }} style={{
                width:18, height:18, borderRadius:4, cursor:'pointer', boxSizing:'border-box',
                backgroundImage: 'linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%)',
                backgroundSize: '6px 6px', backgroundPosition: '0 0, 3px 3px',
                border: (!viewProps.strokeColor && !viewProps.strokeWidth) ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.2)',
              }} />
              {COLOR_PALETTE.map(c => (
                <div key={c} onClick={() => onSetStrokeColor(c)} style={{
                  width:18, height:18, borderRadius:4, background:'transparent', cursor:'pointer',
                  border: viewProps.strokeColor===c ? `3px solid ${c}` : `2px solid ${c}`,
                  boxSizing:'border-box',
                }} />
              ))}
            </div>
            <div style={{ display:'flex', gap:5, alignItems:'center', marginTop:5 }}>
              <span style={{ fontSize:'0.6rem', color:'#7080a0', letterSpacing:'0.05em' }}>WIDTH</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetStrokeWidth(Math.max(0, ((viewProps.strokeWidth||0)-0.5)))}>-</button>
              <span style={{ fontSize:'0.7rem', color:'#88b4e8', width:22, textAlign:'center' }}>{(viewProps.strokeWidth||0).toFixed(1)}</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetStrokeWidth(Math.min(8, ((viewProps.strokeWidth||0)+0.5)))}>+</button>
              {(viewProps.strokeColor || viewProps.strokeWidth) && <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:10 }} onClick={() => { onSetStrokeColor(null); onSetStrokeWidth(0) }}>x</button>}
            </div>
            <div style={{ display:'flex', gap:5, alignItems:'center', marginTop:5 }}>
              <span style={{ fontSize:'0.6rem', color:'#7080a0', letterSpacing:'0.05em' }}>LINE</span>
              {[['solid','──'],['dashed','– –'],['dotted','· ·']].map(([d, lbl]) => {
                const on = (viewProps.strokeDash || 'solid') === d
                return <button key={d} onClick={() => onSetStrokeDash && onSetStrokeDash(d)}
                  style={{ padding:'1px 7px', borderRadius:3, border:`1px solid ${on ? '#5b6af0' : '#2a3358'}`, background: on ? '#1e2440' : 'transparent', color: on ? '#c5d0ff' : '#7b8fcc', cursor:'pointer', fontSize:11 }}>{lbl}</button>
              })}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#7080a0', marginBottom:4, letterSpacing:'0.05em' }}>GLOW</div>
            <div style={{ display:'flex', gap:5, alignItems:'center' }}>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetBorderBlur(Math.max(0, ((viewProps.borderBlur||0)-1)))}>-</button>
              <span style={{ fontSize:'0.7rem', color: (viewProps.borderBlur||0) > 0 ? '#88b4e8' : '#7080a0', width:18, textAlign:'center' }}>{(viewProps.borderBlur||0)}</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetBorderBlur(Math.min(30, ((viewProps.borderBlur||0)+1)))}>+</button>
              {(viewProps.borderBlur||0) > 0 && <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:10 }} onClick={() => onSetBorderBlur(0)}>x</button>}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#7080a0', marginBottom:4, letterSpacing:'0.05em' }}>OPACITY</div>
            <div style={{ display:'flex', gap:5, alignItems:'center' }}>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetOpacity(Math.max(0.05, +((viewProps.opacity??1)-0.1).toFixed(2)))}>-</button>
              <span style={{ fontSize:'0.7rem', color:'#88b4e8', width:32, textAlign:'center' }}>{Math.round((viewProps.opacity??1)*100)}%</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetOpacity(Math.min(1, +((viewProps.opacity??1)+0.1).toFixed(2)))}>+</button>
              {(viewProps.opacity??1) < 1 && <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:10 }} onClick={() => onSetOpacity(1)}>x</button>}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#7080a0', marginBottom:4, letterSpacing:'0.05em' }}>TEXT</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {COLOR_PALETTE.map(c => (
                <div key={c} onClick={() => onSetTextColor(c)} style={{
                  width:18, height:18, borderRadius:'50%', background:c, cursor:'pointer',
                  border: (viewProps.textColor||'#ffffff')===c ? '2px solid #5b6af0' : '1.5px solid rgba(255,255,255,0.15)',
                }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* â"€â"€ Arrange panel (one-shot layouts) â"€â"€ */}
      {panel === 'showas' && (
        <div style={{ display:'flex', flexDirection:'column', gap:2, minWidth:190 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#c5d0ff' }}>Show children as…</span>
          </div>
          {textRow(isList ? 'List ✓ (back to nodes)' : 'List', onToggleList, { icon: '☰', rightColor: isList ? '#f6ad55' : '#8090b8', right: isList ? '✓' : '›', opens: null })}
          {onToggleKanban && textRow(isKanban ? 'Board ✓ (back to nodes)' : 'Board (kanban)', onToggleKanban, { icon: '🗂️', right: isKanban ? '✓' : '›', rightColor: isKanban ? '#f6ad55' : '#8090b8', opens: null })}
          {onToggleStrategy && textRow(isStrategy ? 'Strategy ✓ (back to nodes)' : 'Strategy', onToggleStrategy, { icon: '🕸️', right: isStrategy ? '✓' : '›', rightColor: isStrategy ? '#f6ad55' : '#8090b8', opens: null })}
          {onMakeContainer && textRow('Container', onMakeContainer, { icon: '⬭', right: '›', opens: null })}
          {onGroupBoard && textRow('Sorted / grouped by…', () => setPanel('groupboard'), { icon: '⌗', right: '›', opens: 'groupboard' })}
        </div>
      )}
      {panel === 'arrange' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:180 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#c5d0ff' }}>{selCount > 1 ? `Arrange ${selCount} subtrees` : 'Arrange subtree'}</span>
          </div>
          <div style={{ fontSize:'0.6rem', color:'#7080a0', letterSpacing:'0.05em' }}>PARENT + CHILDREN</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
            {SUBTREE_LAYOUTS.map(l => (
              <button key={l.key} style={arrangeBtn} onClick={() => onArrange && onArrange(l.key)}>{l.label}</button>
            ))}
          </div>
          <div style={{ fontSize:'0.6rem', color:'#7080a0', letterSpacing:'0.05em', marginTop:2 }}>{selCount > 1 ? 'SELECTION' : 'DIRECT CHILDREN'}</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
            {FLAT_LAYOUTS.map(l => (
              <button key={l.key} style={arrangeBtn} onClick={() => onArrange && onArrange(l.key)}>{l.label}</button>
            ))}
          </div>
          <div style={{ borderTop:'1px solid #2a3358', margin:'3px 0' }} />
          <button style={{ ...arrangeBtn, color:'#f6ad55', borderColor:'#5a4a2a' }} onClick={() => onReleaseChildren && onReleaseChildren()}>⊙ Unanchor all children</button>
          <div style={{ fontSize:'0.62rem', color:'#7080a0', lineHeight:1.4 }}>
            {selCount > 1 ? 'Parent layouts arrange each selected node’s subtree; flat layouts arrange the selection.' : 'Anchors the arranged nodes; drag or unanchor to free them.'}
          </div>
        </div>
      )}

      {/* â"€â"€ Styles panel (snapshot cosmetics) â"€â"€ */}
      {panel === 'styles' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:190 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#c5d0ff' }}>Styles</span>
          </div>
          <div style={{ display:'flex', gap:4 }}>
            <input value={newStyleName} onChange={e => setNewStyleName(e.target.value)} placeholder="Name this look…"
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && newStyleName.trim()) { onSaveStyle(newStyleName.trim()); setNewStyleName('') } }}
              style={{ flex:1, minWidth:0, background:'#12122a', border:'1px solid #2a3358', borderRadius:4, color:'#e6ebff', fontSize:'0.72rem', padding:'3px 6px', outline:'none' }} />
            <button style={styleApplyBtn} onClick={() => { if (newStyleName.trim()) { onSaveStyle(newStyleName.trim()); setNewStyleName('') } }}>+ Save</button>
          </div>
          {!styles.length && <div style={{ color:'#8090b8', fontSize:'0.7rem', lineHeight:1.4 }}>No styles yet. Save this node's look above, then apply it to other nodes.</div>}
          {styles.map(st => {
            const p = st.props || {}
            const sw = {
              width:18, height:18, flexShrink:0,
              borderRadius: (p.shape === 'rect' || p.shape === 'roundrect') ? 4 : (p.shape === 'diamond' ? 2 : '50%'),
              background: (p.fillColor && p.fillColor !== 'none' && p.fillColor !== 'transparent') ? p.fillColor : 'transparent',
              border: `${Math.max(1, p.strokeWidth || 1.5)}px ${p.strokeDash === 'dotted' ? 'dotted' : p.strokeDash === 'dashed' ? 'dashed' : 'solid'} ${p.strokeColor || '#2d3a6a'}`,
            }
            return (
              <div key={st.id} style={{ display:'flex', alignItems:'center', gap:5 }}>
                <span style={sw} />
                <span style={{ flex:1, minWidth:0, fontSize:'0.74rem', color:'#c5d0ff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {st.name}{p.nodeEmojis?.[0]?.emoji ? ' ' + p.nodeEmojis[0].emoji : ''}
                </span>
                <button style={styleApplyBtn} onClick={() => onApplyStyle(st.id)} title="Apply to selected node(s)">Apply</button>
                <button style={styleMiniBtn} onClick={() => onUpdateStyle(st.id)} title="Update this style from the current node">⟳</button>
                <button style={styleMiniBtn} onClick={() => { const n = prompt('Rename style', st.name); if (n && n.trim()) onRenameStyle(st.id, n.trim()) }} title="Rename">✎</button>
                <button style={{ ...styleMiniBtn, color:'#f87171' }} onClick={() => onDeleteStyle(st.id)} title="Delete style">×</button>
              </div>
            )
          })}
          {styles.length > 0 && <div style={{ fontSize:'0.64rem', color:'#7080a0', lineHeight:1.4 }}>Apply hits the current node, or all selected nodes if several are selected.</div>}
        </div>
      )}

      {/* â"€â"€ Shape panel â"€â"€ */}
      {panel === 'shape' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:160 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>SHAPE</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:5 }}>
            {[...SHAPES, '3d'].map(s => (
              <button key={s} onClick={() => { onSetShape(s); setPanel(null) }} title={s} style={{
                background: shape===s ? '#2d3a6a' : 'transparent',
                border: `1px solid ${shape===s ? '#5b6af0' : '#2a3358'}`,
                color: shape===s ? '#fff' : '#c5d0ff',
                borderRadius:5, cursor:'pointer', fontSize:'1.1rem', padding:'5px 4px', lineHeight:1,
                display:'flex', flexDirection:'column', alignItems:'center', gap:2,
              }}>
                <span>{shapeIcons[s]}</span>
                <span style={{ fontSize:'0.58rem', color: shape===s ? '#fff' : '#aab6e6' }}>{s}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* â"€â"€ Note panel â"€â"€ */}
      {panel === 'note' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:210 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>NOTE</span>
          </div>
          <textarea
            value={notesDraft}
            onChange={e => setNotesDraft(e.target.value)}
            onBlur={() => onNotesChange(notesDraft)}
            placeholder="Notes…"
            rows={4}
            autoFocus
            style={{
              background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#c7d0f8',
              borderRadius:5, padding:'6px 8px', fontSize:'0.82rem', resize:'vertical',
              outline:'none', fontFamily:'-apple-system, sans-serif', lineHeight:1.5,
              width:'100%', boxSizing:'border-box',
            }}
          />
        </div>
      )}

      {panel === 'tags' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8, minWidth:210 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>TAGS</span>
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
            {tags.length === 0 && <span style={{ fontSize:'0.76rem', color:'#8090b8' }}>No tags yet</span>}
            {tags.map(t => (
              <span key={t} style={{ display:'inline-flex', alignItems:'center', gap:3, fontSize:11, color:'#e6ebff', background: tagColor(t) + '2e', border:`1px solid ${tagColor(t)}`, borderRadius:8, padding:'1px 6px', whiteSpace:'nowrap' }}>
                {t}
                <span onClick={() => onRemoveTag?.(t)} title="Remove" style={{ cursor:'pointer', color:'#c5d0ff', opacity:0.7, fontSize:12, lineHeight:1 }}>×</span>
              </span>
            ))}
          </div>
          <input value={tagDraft} autoFocus placeholder="Add tag + Enter…"
            onChange={e => setTagDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const t = tagDraft.trim(); if (t) onAddTag?.(t); setTagDraft('') } }}
            style={{ background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#c7d0f8', borderRadius:5, padding:'5px 8px', fontSize:'0.82rem', outline:'none', width:'100%', boxSizing:'border-box' }} />
          {(() => {
            const q = tagDraft.trim().toLowerCase()
            const suggestions = (allTags || []).filter(t => !tags.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 12)
            if (!suggestions.length) return null
            return (
              <div>
                <div style={{ fontSize:'0.68rem', color:'#7080a0', letterSpacing:'0.05em', marginBottom:4 }}>USED IN PROJECT</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                  {suggestions.map(t => (
                    <span key={t} onClick={() => onAddTag?.(t)} title="Click to add"
                      style={{ cursor:'pointer', fontSize:11, color:'#c5d0ff', background: tagColor(t) + '1f', border:`1px solid ${tagColor(t)}80`, borderRadius:8, padding:'1px 7px', whiteSpace:'nowrap' }}>+ {t}</span>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {panel === 'groupboard' && (
        <div style={{ display:'flex', flexDirection:'column', gap:4, minWidth:210 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>GROUP INTO BOARD BY</span>
          </div>
          <div style={{ fontSize:'0.72rem', color:'#8090b8', padding:'0 4px 4px' }}>Makes a board of this node's descendants, bucketed by a property. You can make several.</div>
          {(propertyDefs || []).filter(d => d.type === 'select' || d.type === 'multiSelect').map(d => (
            <div key={d.id} onClick={() => onGroupBoard({ mode:'property', propId:d.id })}
              style={{ padding:'6px 9px', borderRadius:5, cursor:'pointer', color:'#c5d0ff', fontSize:'0.82rem' }}
              onMouseEnter={e => e.currentTarget.style.background = '#23234a'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>{d.name}</div>
          ))}
          <div onClick={() => onGroupBoard({ mode:'tag' })}
            style={{ padding:'6px 9px', borderRadius:5, cursor:'pointer', color:'#c5d0ff', fontSize:'0.82rem' }}
            onMouseEnter={e => e.currentTarget.style.background = '#23234a'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>Tags</div>
          {(propertyDefs || []).filter(d => d.type === 'select' || d.type === 'multiSelect').length === 0 &&
            <div style={{ fontSize:'0.74rem', color:'#8090b8', padding:'4px 9px' }}>Tip: add a Select property (or Tags) in the Table first, then group by it here.</div>}
        </div>
      )}

      {/* â"€â"€ Emoji panel â"€â"€ */}
      {panel === 'emoji' && (() => {
        const curEmojis = viewProps.nodeEmojis || []
        const search = emojiSearch.trim().toLowerCase()
        const shownEmojis = search
          ? EMOJI_CATALOG.flatMap(([, list]) => list).filter(e => e === search || (EMOJI_KEYWORDS[e] || '').includes(search))
          : EMOJI_CATALOG[emojiCategory]?.[1] || []
        const fileInputId = `emoji-upload-${x}-${y}`
        return (
          <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:230, maxWidth:230 }}>
            <div style={{ display:'flex', alignItems:'center', gap:4 }}>
              <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
              <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>EMOJI</span>
            </div>

            <input value={emojiSearch} onChange={e => setEmojiSearch(e.target.value)}
              placeholder="Search emoji…"
              style={{ background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#fff', borderRadius:4, padding:'3px 6px', fontSize:'0.78rem', outline:'none', fontFamily:'inherit' }} />

            {!search && (
              <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                {EMOJI_CATALOG.map(([cat], i) => (
                  <button key={cat} onClick={() => setEmojiCategory(i)}
                    style={{
                      background: emojiCategory === i ? '#2d3a6a' : 'transparent',
                      border: `1px solid ${emojiCategory === i ? '#5b6af0' : '#2a3358'}`,
                      color: emojiCategory === i ? '#c5d0ff' : '#8090b8',
                      borderRadius:4, cursor:'pointer', fontSize:'0.6rem', padding:'2px 5px', lineHeight:1.4,
                    }}>{cat}</button>
                ))}
              </div>
            )}

            <div onWheel={e => e.stopPropagation()} style={{ display:'flex', flexWrap:'wrap', gap:3, maxHeight:140, overflowY:'auto' }}>
              {shownEmojis.map((em, idx) => (
                <button key={em + idx} onClick={() => onAddEmoji?.(em, 'unicode')} title={em}
                  style={{ background:'transparent', border:'1px solid #2a3358', borderRadius:4, cursor:'pointer', fontSize:'1.1rem', padding:'3px 5px', lineHeight:1 }}>{em}</button>
              ))}
              {shownEmojis.length === 0 && (
                <span style={{ fontSize:'0.7rem', color:'#7080a0', padding:'4px 0' }}>No matches</span>
              )}
            </div>

            <div style={{ display:'flex', gap:4 }}>
              <input value={emojiInput} onChange={e => setEmojiInput(e.target.value)}
                placeholder="Type any emoji…" maxLength={8}
                style={{ flex:1, background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#fff', borderRadius:4, padding:'3px 6px', fontSize:'0.9rem', outline:'none', fontFamily:'inherit' }} />
              <button onClick={() => { if (emojiInput.trim()) { onAddEmoji?.(emojiInput.trim(), 'unicode'); setEmojiInput('') } }}
                style={{ background:'#2d3a6a', border:'none', color:'#fff', borderRadius:4, cursor:'pointer', padding:'3px 10px', fontSize:'0.8rem' }}>+</button>
            </div>

            <div style={{ borderTop:'1px solid #2a3358', paddingTop:6, display:'flex', flexDirection:'column', gap:5 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <span style={{ fontSize:'0.65rem', color:'#7080a0', letterSpacing:'0.05em' }}>CUSTOM</span>
                <label htmlFor={fileInputId} style={{ background:'#2d3a6a', border:'none', color:'#fff', borderRadius:4, cursor:'pointer', padding:'2px 8px', fontSize:'0.68rem' }}>Upload</label>
                <input id={fileInputId} type="file" accept="image/*" style={{ display:'none' }}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = () => onAddCustomEmoji?.(file.name, reader.result)
                    reader.readAsDataURL(file)
                    e.target.value = ''
                  }} />
              </div>
              {(customEmojis || []).length > 0 && (
                <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                  {customEmojis.map(ce => (
                    <div key={ce.id} style={{ position:'relative', width:26, height:26 }}>
                      <button onClick={() => onAddEmoji?.(ce.src, 'image')} title={ce.name}
                        style={{ width:26, height:26, padding:0, background:'transparent', border:'1px solid #2a3358', borderRadius:4, cursor:'pointer', overflow:'hidden' }}>
                        <img src={ce.src} alt={ce.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                      </button>
                      <button onClick={() => onRemoveCustomEmoji?.(ce.id)}
                        style={{ position:'absolute', top:-4, right:-4, background:'#f87171', border:'none', borderRadius:'50%', width:11, height:11, cursor:'pointer', fontSize:7, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', padding:0, lineHeight:1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {curEmojis.length > 0 && (
              <div style={{ display:'flex', flexWrap:'wrap', gap:5, borderTop:'1px solid #2a3358', paddingTop:5 }}>
                {curEmojis.map(em => (
                  <div key={em.id} style={{ position:'relative', display:'inline-flex', alignItems:'center', justifyContent:'center', width:28, height:28 }}>
                    {em.type === 'image'
                      ? <img src={em.emoji} alt="" style={{ width:20, height:20, objectFit:'cover', borderRadius:3 }} />
                      : <span style={{ fontSize:'1.2rem', lineHeight:1 }}>{em.emoji}</span>}
                    <button onClick={() => onRemoveEmojiById?.(em.id)}
                      style={{ position:'absolute', top:-4, right:-4, background:'#f87171', border:'none', borderRadius:'50%', width:13, height:13, cursor:'pointer', fontSize:9, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', padding:0, lineHeight:1 }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Image panel ── */}
      {panel === 'image' && (() => {
        const curImages = viewProps.nodeImages || []
        const fileInputId = `nodeimg-upload-${x}-${y}`
        const POSITIONS = [
          ['above', 'Above'], ['below', 'Below'], ['beside', 'Beside'], ['perimeter', 'Perimeter'], ['background', 'Background'],
        ]
        return (
          <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:230 }}>
            <div style={{ display:'flex', alignItems:'center', gap:4 }}>
              <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
              <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>IMAGE</span>
            </div>

            <label htmlFor={fileInputId} style={{ background:'#2d3a6a', border:'none', color:'#fff', borderRadius:4, cursor:'pointer', padding:'5px 8px', fontSize:'0.78rem', textAlign:'center' }}>Upload image…</label>
            <input id={fileInputId} type="file" accept="image/*" style={{ display:'none' }}
              onChange={e => {
                processImageFile(e.target.files?.[0], 'above')
                e.target.value = ''
              }} />
            <span style={{ fontSize:'0.62rem', color:'#7080a0', textAlign:'center' }}>or paste an image (Ctrl+V)</span>

            {curImages.length > 0 && (
              <div style={{ display:'flex', flexDirection:'column', gap:7, borderTop:'1px solid #2a3358', paddingTop:6 }}>
                {curImages.map(im => (
                  <div key={im.id} style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <div style={{ width:30, height:30, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', background:'#0e0e1c', borderRadius:4, overflow:'hidden' }}>
                      <img src={im.src} alt="" style={{ maxWidth:'100%', maxHeight:'100%' }} />
                    </div>
                    <div style={{ display:'flex', gap:2, flexWrap:'wrap', flex:1 }}>
                      {POSITIONS.map(([val, label]) => (
                        <button key={val} onClick={() => onSetNodeImagePosition?.(im.id, val)} title={label}
                          style={{
                            background: (im.position || 'above') === val ? '#2d3a6a' : 'transparent',
                            border: `1px solid ${(im.position || 'above') === val ? '#5b6af0' : '#2a3358'}`,
                            color: (im.position || 'above') === val ? '#c5d0ff' : '#8090b8',
                            borderRadius:3, cursor:'pointer', fontSize:'0.6rem', padding:'2px 5px',
                          }}>{label[0]}</button>
                      ))}
                    </div>
                    <button onClick={() => onRemoveNodeImageById?.(im.id)}
                      style={{ background:'transparent', border:'none', color:'#f87171', cursor:'pointer', fontSize:13, padding:'0 2px', flexShrink:0 }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* â"€â"€ Radiate panel â"€â"€ */}
      {panel === 'radiate' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:160 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>RADIATE TO CHILDREN</span>
          </div>
          {[['color','Radiate colors (fill + outline)'],['shape','Radiate shape'],['both','Radiate colors + shape']].map(([what, label]) => (
            <button key={what} onClick={() => { onRadiate(what); setPanel(null) }}
              style={{ background:'transparent', border:'1px solid #2a3358', color:'#c5d0ff', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', padding:'5px 8px', textAlign:'left' }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── Effects (children) panel — chase / colour wave / pulse / twinkle / ripple / orbit ── */}
      {panel === 'effects' && (() => {
        const fx = childrenEffect || null
        const t = fx?.type
        const set = (patch) => onSetChildrenEffect?.({ ...(fx || {}), ...patch })
        const DEF = {
          chase: { speed: 1, color: '#ffd24d', span: 1, style: 'halo' },
          colorwave: { speed: 1, style: 'color' },
          pulse: { speed: 1, amp: 0.3, color: '#ffd24d', style: 'halo' },
          twinkle: { speed: 1, color: '#ffd24d', density: 0.3, style: 'halo' },
          ripple: { speed: 1, color: '#7fd8ff', style: 'halo' },
          orbit: { speed: 1, radius: 130 },
          orbitwave: { speed: 1, radius: 130, amp: 0.4 },
        }
        const pick = (type) => onSetChildrenEffect?.({ type, ...DEF[type] })
        const pill = (active, label, onClick) => (
          <button onClick={onClick} style={{ background: active ? '#26306a' : 'transparent', border: `1px solid ${active ? '#5b6af0' : '#2a3358'}`, color: active ? '#fff' : '#c5d0ff', borderRadius: 5, cursor: 'pointer', fontSize: '0.7rem', padding: '3px 7px' }}>{label}</button>
        )
        const slider = (label, key, min, max, step, def) => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.66rem', color: '#8090b8', width: 44 }}>{label}</span>
            <input type="range" min={min} max={max} step={step} value={fx?.[key] ?? def} onChange={e => set({ [key]: Number(e.target.value) })} style={{ flex: 1, accentColor: '#5b6af0' }} />
          </div>
        )
        const styleRow = (withColorStyle) => (
          <div style={{ display: 'flex', gap: 6 }}>
            {pill(fx.style === 'halo' || !fx.style, 'Halo', () => set({ style: 'halo' }))}
            {withColorStyle && pill(fx.style === 'color', 'Color', () => set({ style: 'color' }))}
            {pill(fx.style === 'both', 'Both', () => set({ style: 'both' }))}
          </div>
        )
        const colorRow = () => (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            <button onClick={() => set({ color: 'rainbow' })} title="Rainbow" style={{ width: 20, height: 20, borderRadius: 4, cursor: 'pointer', border: fx.color === 'rainbow' ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.15)', background: 'linear-gradient(90deg,#f43f5e,#f6e05e,#22c55e,#0ea5e9,#a855f7)' }} />
            <button onClick={() => set({ color: 'own' })} title="Each child's own colour" style={{ width: 20, height: 20, borderRadius: 4, cursor: 'pointer', border: fx.color === 'own' ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.15)', background: 'conic-gradient(#f43f5e,#f6e05e,#22c55e,#0ea5e9,#a855f7,#f43f5e)', color: '#000', fontSize: 9, fontWeight: 700 }}>◈</button>
            {COLOR_PALETTE.slice(0, 12).map(c => (
              <button key={c} onClick={() => set({ color: c })} style={{ width: 20, height: 20, borderRadius: 4, cursor: 'pointer', background: c, border: fx.color === c ? '2px solid #fff' : '1.5px solid rgba(255,255,255,0.15)' }} />
            ))}
          </div>
        )
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
              <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
              <span style={{ fontSize: '0.72rem', color: '#7080a0', letterSpacing: '0.06em' }}>EFFECTS · CHILDREN</span>
              {fx && <button onClick={() => onSetChildrenEffect?.(null)} style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #5a2a2a', color: '#f0a0a0', borderRadius: 5, cursor: 'pointer', fontSize: '0.68rem', padding: '2px 7px' }}>Off</button>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {[['chase', 'Chase'], ['colorwave', 'Colour wave'], ['pulse', 'Pulse'], ['twinkle', 'Twinkle'], ['ripple', 'Ripple'], ['orbit', 'Orbit'], ['orbitwave', 'Orbit wave']].map(([ty, label]) => pill(t === ty, label, () => pick(ty)))}
            </div>
            {fx && <div style={{ borderTop: '1px solid #23233e', margin: '2px 0', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {(t === 'chase' || t === 'colorwave' || t === 'pulse' || t === 'twinkle' || t === 'ripple') && <><div style={{ fontSize: '0.64rem', color: '#8090b8' }}>Style</div>{styleRow(t !== 'pulse')}</>}
              {(t === 'chase' || t === 'pulse' || t === 'twinkle' || t === 'ripple') && <><div style={{ fontSize: '0.64rem', color: '#8090b8' }}>Colour</div>{colorRow()}</>}
              {slider('Speed', 'speed', 0.2, 4, 0.1, 1)}
              {t === 'chase' && slider('Tail', 'span', 1, 5, 1, 1)}
              {t === 'pulse' && slider('Amount', 'amp', 0.1, 0.7, 0.05, 0.3)}
              {t === 'twinkle' && slider('Density', 'density', 0.1, 0.7, 0.05, 0.3)}
              {(t === 'orbit' || t === 'orbitwave') && slider('Radius', 'radius', 50, 320, 10, 130)}
              {t === 'orbitwave' && slider('Wobble', 'amp', 0.1, 0.8, 0.05, 0.4)}
              {(t === 'chase' || t === 'ripple' || t === 'orbit' || t === 'orbitwave') && (
                <div style={{ display: 'flex', gap: 6 }}>
                  {pill(fx.dir !== 'rev', 'Forward', () => set({ dir: 'fwd' }))}
                  {pill(fx.dir === 'rev', 'Reverse', () => set({ dir: 'rev' }))}
                </div>
              )}
            </div>}
          </div>
        )
      })()}

      {/* â"€â"€ Motion panel â"€â"€ */}
      {panel === 'motion' && (() => {
        const motion = viewProps.nodeMotion
        const colorCycle = viewProps.nodeColorCycle || 0
        const numBtn = { background:'transparent', border:'1px solid #2a3358', color:'#88b4e8', borderRadius:4, cursor:'pointer', fontSize:'0.75rem', padding:'2px 6px', lineHeight:1 }
        const motionTypes = [
          [null,'○','off'],['shake','≋','shake'],['circle','◎','circle'],
          ['jerk','⚡','jerk'],['updown','↕','up/dn'],['sideways','↔','side'],['scale','⬡','scale'],['rock','↺','rock'],
        ]
        return (
          <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:196 }}>
            <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
              <button style={backBtn} onClick={() => setPanel(null)}>‹</button>
              <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>MOTION</span>
            </div>

            {/* Motion type grid */}
            <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
              {motionTypes.map(([type, icon, label]) => {
                const active = (motion?.type ?? null) === type
                return (
                  <button key={label} title={label}
                    style={{ background: active?'#2d3a6a':'transparent', border:`1px solid ${active?'#5b6af0':'#2a3358'}`, color: active?'#c5d0ff':'#8090b8', borderRadius:4, cursor:'pointer', padding:'3px 5px', lineHeight:1, display:'flex', flexDirection:'column', alignItems:'center', gap:1 }}
                    onClick={() => onSetMotion(type === null ? null : { type, speed: motion?.speed ?? 1, intensity: motion?.intensity ?? 10 })}>
                    <span style={{ fontSize:'1rem' }}>{icon}</span>
                    <span style={{ fontSize:'0.5rem', color: active?'#fff':'#aab6e6' }}>{label}</span>
                  </button>
                )
              })}
            </div>

            {/* Speed / Intensity — only when motion active */}
            {motion && (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ fontSize:'0.6rem', color:'#7080a0', width:32, letterSpacing:'0.04em' }}>SPEED</span>
                  <button style={numBtn} onClick={() => {
                    const v = motion.speed ?? 1
                    const next = v <= 0.5 ? Math.max(0, +(v - 0.1).toFixed(1)) : Math.max(0.5, +(v - 0.5).toFixed(1))
                    onSetMotion({ ...motion, speed: next })
                  }}>−</button>
                  <span style={{ fontSize:'0.7rem', color:'#88b4e8', width:22, textAlign:'center' }}>{(motion.speed ?? 1).toFixed(1)}</span>
                  <button style={numBtn} onClick={() => {
                    const v = motion.speed ?? 1
                    const next = v < 0.5 ? Math.min(5, +(v + 0.1).toFixed(1)) : Math.min(5, +(v + 0.5).toFixed(1))
                    onSetMotion({ ...motion, speed: next })
                  }}>+</button>
                </div>
                {[['INTEN', 'intensity', 2, 40, 2, v => v]].map(([lbl, key, mn, mx, step, fmt]) => (
                  <div key={key} style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <span style={{ fontSize:'0.6rem', color:'#7080a0', width:32, letterSpacing:'0.04em' }}>{lbl}</span>
                    <button style={numBtn} onClick={() => onSetMotion({...motion, [key]: Math.max(mn, (motion[key]??mn+step)-step)})}>−</button>
                    <span style={{ fontSize:'0.7rem', color:'#88b4e8', width:22, textAlign:'center' }}>{fmt(motion[key]??mn+step)}</span>
                    <button style={numBtn} onClick={() => onSetMotion({...motion, [key]: Math.min(mx, (motion[key]??mn)+step)})}>+</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop:'1px solid #2a3358', margin:'2px 0' }} />

            {/* Color cycle */}
            <div style={{ display:'flex', alignItems:'center', gap:5 }}>
              <button style={{ ...iconBtn(!!colorCycle), fontSize:'0.85rem', padding:'3px 6px' }}
                title="Color cycle" onClick={() => onSetColorCycle(colorCycle ? 0 : 4)}>⬡</button>
              <span style={{ fontSize:'0.65rem', color:'#8090b8', flex:1 }}>Color cycle</span>
              {colorCycle > 0 && (
                <>
                  <button style={numBtn} onClick={() => onSetColorCycle(Math.max(1, colorCycle - 1))}>−</button>
                  <span style={{ fontSize:'0.7rem', color:'#88b4e8', width:20, textAlign:'center' }}>{colorCycle}s</span>
                  <button style={numBtn} onClick={() => onSetColorCycle(Math.min(20, colorCycle + 1))}>+</button>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* -- Image URL panel (for image-shape nodes) -- */}
      {panel === 'imageUrl' && (
        <ImageUrlPanel
          imageUrl={imageUrl}
          onSet={url => { onSetImageUrl(url); setPanel(null) }}
          onBack={() => setPanel(null)}
          backBtn={backBtn}
        />
      )}

      {/* ── Expand panel ── */}
      {panel === 'expand' && depthExpand !== null && (
        <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:190 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
            <button style={backBtn} onClick={() => { onSetDepthExpand?.(null); setPanel(null) }}>‹</button>
            <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>EXPAND HOPS</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontSize:'0.65rem', color:'#7080a0' }}>+1</span>
            <input type="range" min={1} max={Math.max(1, maxExpandRadius || 1)} value={depthExpand.radius}
              onChange={e => onSetDepthExpand?.({ ...depthExpand, radius: Number(e.target.value) })}
              style={{ flex:1, accentColor:'#5b6af0' }} />
            <span style={{ fontSize:'0.65rem', color:'#7080a0' }}>+{Math.max(1, maxExpandRadius || 1)}</span>
          </div>
          <div style={{ textAlign:'center', fontSize:'0.85rem', color:'#c5d0ff', fontWeight:600 }}>+{depthExpand.radius} hops</div>
          <button onClick={() => { onSetDepthExpand?.(null); setPanel(null) }}
            style={{ background:'transparent', border:'1px solid #2d3a6a', color:'#f87171', cursor:'pointer', fontSize:'0.7rem', padding:'3px 8px', borderRadius:4, alignSelf:'flex-end' }}>
            Clear
          </button>
        </div>
      )}
      </div>)}
    </div>
  )
}

function ImageUrlPanel({ imageUrl, onSet, onBack, backBtn }) {
  const [draft, setDraft] = React.useState(imageUrl || '')
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:240 }}>
      <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
        <button style={backBtn} onClick={onBack}>‹</button>
        <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>IMAGE URL</span>
      </div>
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); onSet(draft.trim()) } if (e.key === 'Escape') { e.preventDefault(); onBack() } }}
        placeholder="Paste image URL…"
        style={{ background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#c7d0f8', borderRadius:5, padding:'6px 8px', fontSize:'0.82rem', outline:'none', width:'100%', boxSizing:'border-box' }} />
      {draft && <img src={draft} alt="" style={{ width:'100%', maxHeight:120, objectFit:'cover', borderRadius:5, opacity:0.9 }} onError={e => { e.target.style.display='none' }} />}
      <button onClick={() => onSet(draft.trim())}
        style={{ padding:'5px', borderRadius:5, border:'1px solid #5b6af0', background:'#1a1f4a', color:'#c5d0ff', cursor:'pointer', fontSize:'0.78rem' }}>
        Set image
      </button>
      {imageUrl && <button onClick={() => onSet('')}
        style={{ padding:'5px', borderRadius:5, border:'1px solid #2d3a6a', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:'0.78rem' }}>
        Clear
      </button>}
    </div>
  )
}

const tlBtn = { background:'transparent', border:'1px solid #2d3a6a', color:'#aaa', cursor:'pointer', fontSize:'0.72rem', padding:'2px 7px', borderRadius:4, whiteSpace:'nowrap' }

// Delete confirm overlay
const confirmStyle = { position:'absolute', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:50 }
const confirmBox = { background:'#16162a', border:'1px solid #2d3a6a', borderRadius:10, padding:'1.25rem 1.5rem', minWidth:260, boxShadow:'0 8px 32px rgba(0,0,0,0.6)' }
const confirmCancelBtn = { padding:'0.35rem 0.9rem', borderRadius:6, border:'1px solid #2d3a6a', background:'transparent', color:'#888', cursor:'pointer', fontSize:'0.82rem' }
const confirmOkBtn = { padding:'0.35rem 0.9rem', borderRadius:6, border:'1px solid #f87171', background:'#2a1a1a', color:'#f87171', cursor:'pointer', fontSize:'0.82rem', fontWeight:600 }
const canvasBtnStyle = { padding:'0.45rem 0.85rem', borderRadius:7, border:'1px solid #2d3a6a', background:'#12122a', color:'#5b6af0', cursor:'pointer', fontSize:'0.82rem', fontWeight:600, boxShadow:'0 2px 12px rgba(0,0,0,0.4)' }
const sideToolBtnStyle = { padding:'0.3rem 0.6rem', borderRadius:7, border:'1px solid #2a3358', background:'transparent', color:'#8a97cc', cursor:'pointer', fontSize:'0.76rem', fontWeight:600, whiteSpace:'nowrap' }
// Uniform tool-strip button: fixed height, centered icon+label, consistent skin (grid cells share width).
const gToolBtn = { display:'flex', alignItems:'center', justifyContent:'center', gap:4, height:28, padding:'0 6px', borderRadius:6, border:'1px solid #262b47', background:'#141428', color:'#9aa6d8', cursor:'pointer', fontSize:'0.72rem', fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }
const topBtnStyle = { padding:'0.3rem 0.8rem', borderRadius:6, border:'1px solid #2d3a6a', background:'rgba(18,18,42,0.92)', color:'#7b8fcc', cursor:'pointer', fontSize:'0.78rem', fontWeight:600, backdropFilter:'blur(4px)' }
