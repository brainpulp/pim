import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import Node3DViewer from '../components/Node3DViewer'
import * as d3 from 'd3'
import useGraphStore, { DEFAULT_NODE_PROPS, NODE_R, COLOR_PALETTE, FILL_COLORS, TEXT_COLORS, SHAPES, BG_COLORS } from '../lib/graphStore'
import ViewManager from '../components/ViewManager'
import OutlinePanel from '../components/OutlinePanel'
import { loadProject, saveProject, uploadModel, uploadThumbnail } from '../lib/db'

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
    case 'ellipse':   return { halfW: r * 1.45, halfH: r * 0.9 }
    case 'roundrect': return { halfW: r * 1.5,  halfH: r * 0.85 }
    case 'rect':      return { halfW: r * 1.5,  halfH: r * 0.85 }
    case 'diamond':   return { halfW: r * 1.15, halfH: r * 1.15 }
    case 'none':      return { halfW: r * 1.2,  halfH: r * 0.55 }
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
function ShapeBody({ shape, halfW, halfH, r, fill, stroke, strokeWidth, filter, imageUrl, nodeId }) {
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
    return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={halfH * 0.45} ry={halfH * 0.45} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  if (shape === 'rect')
    return <rect x={-halfW} y={-halfH} width={halfW*2} height={halfH*2} rx={0} ry={0} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  if (shape === 'ellipse')
    return <ellipse rx={halfW} ry={halfH} fill={fill} stroke={stroke} strokeWidth={strokeWidth} filter={filter} />
  if (shape === 'diamond')
    return <polygon points={`0,${-halfH} ${halfW},0 0,${halfH} ${-halfW},0`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} filter={filter} />
  // default: circle
  return <circle r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} filter={filter} />
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

export default function Graph({ projectId, projectName }) {
  const svgRef = useRef()
  const simRef = useRef(null)
  const zoomBehaviorRef = useRef(null)
  const simNodesRef = useRef([])
  const simEdgesRef = useRef([])
  const zoomTransformRef = useRef(d3.zoomIdentity)
  const frameRef = useRef(null)
  const [tick, setTick] = useState(0)
  const [connecting, setConnecting] = useState(null)
  const [selected, setSelected] = useState(null)
  const selectedRef = useRef(null)
  useEffect(() => { selectedRef.current = selected }, [selected])
  const [hoveredNodeId, setHoveredNodeId] = useState(null)
  const [isPanning, setIsPanning] = useState(false)
  const [depthExpand, setDepthExpand] = useState(null) // null = off, { nodeId, radius } = expand from node
  const [showBgPicker, setShowBgPicker] = useState(false)
  const [keepEditId, setKeepEditId] = useState(null)
  const canvasFocused = useRef(true)
  const hideTimerRef = useRef(null)
  const showTimerRef = useRef(null)
  const hoveredNodeIdRef = useRef(null)
  const panSaveTimerRef = useRef(null)
  const [notePopupId, setNotePopupId] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null) // nodeId or null
  const [confirmDeleteImage, setConfirmDeleteImage] = useState(null) // imageId or null
  const [pendingEditId, setPendingEditId] = useState(null)
  const [selectedImageId, setSelectedImageId] = useState(null)
  const [dragHoverNodeId, setDragHoverNodeId] = useState(null)
  const dragHoverNodeIdRef = useRef(null)
  const [showSlideSidebar, setShowSlideSidebar] = useState(false)
  const [hideFrameOutlines, setHideFrameOutlines] = useState(false)
  const prevFrameCountRef = useRef(0)
  const [presentingSlideIdx, setPresentingSlideIdx] = useState(null)
  const presentingSlideIdxRef = useRef(null)
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
  const saveTimer = useRef(null)

  useEffect(() => {
    setLoading(true)
    loadProject(projectId)
      .then(d => loadProjectData({ nodes: d.nodes, edges: d.edges, views: d.views, activeViewId: d.active_view_id }))
      .catch(e => console.error('Load failed:', e))
      .finally(() => setLoading(false))
  }, [projectId]) // eslint-disable-line

  const storeNodes      = useGraphStore(s => s.nodes)
  const storeEdges      = useGraphStore(s => s.edges)
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
  const updateImage     = useGraphStore(s => s.updateImage)
  const deleteImage     = useGraphStore(s => s.deleteImage)
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
  const toggleCollapseNode = useGraphStore(s => s.toggleCollapseNode)
  const setViewBgColor  = useGraphStore(s => s.setViewBgColor)
  const setViewPan      = useGraphStore(s => s.setViewPan)
  const setSlideBgColor = useGraphStore(s => s.setSlideBgColor)
  const addView         = useGraphStore(s => s.addView)
  const set3DModel      = useGraphStore(s => s.set3DModel)
  const setModelThumb   = useGraphStore(s => s.setModelThumb)
  const setImageUrl     = useGraphStore(s => s.setImageUrl)

  const addFrameToCenter = useCallback(() => {
    if (!svgRef.current) return
    const { views, activeViewId } = useGraphStore.getState()
    const vp = views.find(v => v.id === activeViewId)?.nodeProps || {}
    const currentFrameCount = Object.values(vp).filter(p => p.shape === 'frame').length
    const [cx, cy] = zoomTransformRef.current.invert([svgRef.current.clientWidth / 2, svgRef.current.clientHeight / 2])
    const id = addNode('Frame', null, cx, cy)
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

  const activeView    = views.find(v => v.id === activeViewId) || views[0]
  const viewNodeProps = activeView?.nodeProps || {}
  const drillRoot     = activeView?.drillRoot || null
  const bgColor       = activeView?.bgColor || '#0c0c1a'
  const slideshows    = activeView?.slideshows || [{ id: 'ss-default', name: 'Default', slides: [] }]
  const activeSlideshowId = activeView?.activeSlideshowId || slideshows[0]?.id
  const activeSlideshow   = slideshows.find(ss => ss.id === activeSlideshowId) || slideshows[0]
  const slideIds      = activeSlideshow?.slides || []
  const customEmojis  = activeView?.customEmojis || []
  const collapsedNodeIds = activeView?.collapsedNodeIds || []
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

  useEffect(() => {
    if (loading) return
    setSaveStatus('saving')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        await saveProject(projectId, { nodes: storeNodes, edges: storeEdges, views, activeViewId })
        setSaveStatus('saved')
      } catch (e) { console.error('Save:', e); setSaveStatus('error') }
    }, 1500)
    return () => clearTimeout(saveTimer.current)
  }, [storeNodes, storeEdges, views, activeViewId, projectId, loading]) // eslint-disable-line

  const getVP = useCallback((nodeId) => ({
    ...DEFAULT_NODE_PROPS, ...(viewNodeProps[nodeId] || {}),
  }), [viewNodeProps])

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
    if (collapsedNodeIds.length) {
      const hidden = new Set()
      const q = [...collapsedNodeIds]
      while (q.length) {
        const cur = q.shift()
        storeEdges.forEach(e => {
          if (e.source === cur && !hidden.has(e.target)) { hidden.add(e.target); q.push(e.target) }
        })
      }
      hidden.forEach(id => base.delete(id))
    }
    if (expandHops !== null) {
      ;[...base].forEach(id => { if (expandHops[id] === undefined) base.delete(id) })
    }
    return base
  }, [drillRoot, storeNodes, storeEdges, viewNodeProps, expandHops, collapsedNodeIds])

  const nodesWithChildren = useMemo(() => new Set(storeEdges.map(e => e.source)), [storeEdges])
  const collapsedSet = useMemo(() => new Set(collapsedNodeIds), [collapsedNodeIds])

  const scheduleRender = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; setTick(t => t + 1) })
  }, [])

  // Topology → sim
  useEffect(() => {
    const posById = {}
    simNodesRef.current.forEach(n => { posById[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy } })
    const cx = svgRef.current?.clientWidth / 2 || 500
    const cy = svgRef.current?.clientHeight / 2 || 350
    simNodesRef.current = storeNodes.map(n => {
      const vp = { ...DEFAULT_NODE_PROPS, ...(viewNodeProps[n.id] || {}) }
      return {
        id: n.id, label: n.label, notes: n.notes || '',
        x: posById[n.id]?.x ?? cx + (Math.random() - 0.5) * 120,
        y: posById[n.id]?.y ?? cy + (Math.random() - 0.5) * 120,
        vx: posById[n.id]?.vx ?? 0, vy: posById[n.id]?.vy ?? 0,
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
        const { halfW: defHW, halfH: defHH } = shapeDims(fvp.shape === '3d' ? '3d' : 'frame', fr)
        const halfW = fvp.shape === '3d' ? defHW : (fvp.frameHalfW ?? defHW)
        const halfH = fvp.shape === '3d' ? defHH : (fvp.frameHalfH ?? defHH)
        const cx = frame.x || 0, cy = frame.y || 0
        const pad = 30
        if (node.x < cx - halfW + pad) node.vx += alpha * 10
        if (node.x > cx + halfW - pad) node.vx -= alpha * 10
        if (node.y < cy - halfH + pad) node.vy += alpha * 10
        if (node.y > cy + halfH - pad) node.vy -= alpha * 10
      }
    }

    if (!simRef.current) {
      simRef.current = d3.forceSimulation(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(120).strength(0.4))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('collide', d3.forceCollide(NODE_R + 8))
        .force('bound', boundingForce())
        .alphaDecay(0.04).velocityDecay(0.5).alphaMin(0.005).on('tick', scheduleRender)
    } else {
      simRef.current.nodes(simNodesRef.current)
        .force('link', d3.forceLink(simEdgesRef.current).id(d => d.id).distance(150).strength(0.4))
        .alpha(0.25).restart()
    }
  }, [storeNodes, storeEdges, scheduleRender]) // eslint-disable-line

  useEffect(() => {
    const { views, activeViewId } = useGraphStore.getState()
    const vp = views.find(v => v.id === activeViewId)?.nodeProps || {}
    simNodesRef.current.forEach(n => {
      const p = { ...DEFAULT_NODE_PROPS, ...(vp[n.id] || {}) }
      n.fx = p.fx ?? null; n.fy = p.fy ?? null
    })
    if (simRef.current) simRef.current.alpha(0.2).restart()
  }, [activeViewId])

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
    setSelected({ id: newId, type: 'node' })
    setPendingEditId(newId)
  }, [getSiblings, addNode])

  // Zoom â€" pan on background only (not on nodes)
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    zoomBehaviorRef.current = d3.zoom()
      .scaleExtent([0.04, 10])
      .filter(e => e.type === 'wheel' || (
        !e.target.closest?.('[data-node]') &&
        !e.target.closest?.('[data-frame]') &&
        !e.target.closest?.('[data-img]') &&
        !e.target.closest?.('[data-3d-canvas]')
      ))
      .on('zoom', e => {
        zoomTransformRef.current = e.transform
        scheduleRender()
        if (panSaveTimerRef.current) clearTimeout(panSaveTimerRef.current)
        panSaveTimerRef.current = setTimeout(() => { if (presentingSlideIdxRef.current === null) setViewPan(e.transform.x, e.transform.y, e.transform.k) }, 600)
      })
    svg.call(zoomBehaviorRef.current)
    svg.on('dblclick.zoom', null)
    return () => svg.on('.zoom', null)
  }, [scheduleRender, loading])

  // Restore pan/zoom when switching views
  useEffect(() => {
    const pan = views.find(v => v.id === activeViewId)?.pan
    if (!pan || !svgRef.current || !zoomBehaviorRef.current) return
    const t = d3.zoomIdentity.translate(pan.x, pan.y).scale(pan.k)
    d3.select(svgRef.current).call(zoomBehaviorRef.current.transform, t)
    zoomTransformRef.current = t
    scheduleRender()
  }, [activeViewId]) // eslint-disable-line

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = e => {
      if (!canvasFocused.current) return
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') {
        if (fullscreen3dId) { setFullscreen3dId(null); return }
        if (presentingSlideIdx !== null) { setPresentingSlideIdx(null); return }
        setSelected(null); setSelectedImageId(null); setConfirmDelete(null); return
      }

      // Presentation mode arrow navigation
      if (presentingSlideIdx !== null) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); navigateSlide(-1); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); navigateSlide(1); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); if (slideSimNodes.length > 0) { setPresentingSlideIdx(0); zoomToFrame(slideSimNodes[0]) } return }
        if (e.key === 'ArrowDown') { e.preventDefault(); if (slideSimNodes.length > 0) { const last = slideSimNodes.length - 1; setPresentingSlideIdx(last); zoomToFrame(slideSimNodes[last]) } return }
        return
      }

      // Enter → create child if root node, sister if non-root
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && selected?.type === 'node') {
        e.preventDefault()
        const isRoot = !storeEdges.some(se => se.target === selected.id)
        if (isRoot) {
          const newId = addNode('New node', selected.id)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        } else {
          handleCreateSister(selected.id)
        }
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedImageId) { setConfirmDeleteImage(selectedImageId); return }
        if (selected?.type === 'edge') { removeEdge(selected.id); setSelected(null) }
        if (selected?.type === 'node') { setConfirmDelete(selected.id) }
        return
      }

      // Ctrl/Cmd+Shift+Enter → create sister node
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        if (selected?.type === 'node') {
          const { parentId } = getSiblings(selected.id)
          const newId = addNode('New node', parentId)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        }
        return
      }

      // Ctrl/Cmd+Enter → create child node
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (selected?.type === 'node') {
          const newId = addNode('New node', selected.id)
          setSelected({ id: newId, type: 'node' })
          setPendingEditId(newId)
        }
        return
      }

      // Tab → cycle to next sibling (enter edit mode)
      if (e.key === 'Tab' && selected?.type === 'node') {
        e.preventDefault()
        handleNodeTab(selected.id)
        return
      }

      // ArrowUp → select parent
      if (e.key === 'ArrowUp' && selected?.type === 'node') {
        e.preventDefault()
        const parentEdge = storeEdges.find(ed => ed.target === selected.id)
        if (parentEdge) setSelected({ id: parentEdge.source, type: 'node' })
        return
      }

      // ArrowDown → select first child
      if (e.key === 'ArrowDown' && selected?.type === 'node') {
        e.preventDefault()
        const childEdge = storeEdges.find(ed => ed.source === selected.id)
        if (childEdge) setSelected({ id: childEdge.target, type: 'node' })
        return
      }

      // ArrowLeft/Right → cycle siblings
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected?.type === 'node') {
        e.preventDefault()
        const { siblings } = getSiblings(selected.id)
        const idx = siblings.indexOf(selected.id)
        const delta = e.key === 'ArrowRight' ? 1 : -1
        const nextId = siblings[(idx + delta + siblings.length) % siblings.length]
        if (nextId && nextId !== selected.id) setSelected({ id: nextId, type: 'node' })
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, removeEdge, addNode, getSiblings, handleNodeTab, handleCreateSister, storeEdges, presentingSlideIdx])

  const clientToSim = useCallback((clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect()
    return zoomTransformRef.current.invert([clientX - rect.left, clientY - rect.top])
  }, [])

  const handleNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    canvasFocused.current = true
    setSelected({ id: nodeId, type: 'node' })
    setHoveredNodeId(null) // hide toolbar while dragging
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    simRef.current.alphaTarget(0.3).restart()

    const isFrame = (viewNodePropsRef.current[nodeId] || {}).shape === 'frame'

    // Collect drag group
    let dragGroup = [simNode]
    if (isFrame) {
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
    let didDrag = false

    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const ddx = sx - startSx, ddy = sy - startSy
      if (!didDrag && Math.abs(ddx) < 2 && Math.abs(ddy) < 2) return
      if (!didDrag) document.body.style.cursor = 'grabbing'
      didDrag = true
      startPositions.forEach(({ node, ox, oy }) => { node.fx = ox + ddx; node.fy = oy + ddy })

      // Hover-detect: find node under cursor to highlight as reparent target
      if (!isFrame) {
        let found = null
        for (const n of simNodesRef.current) {
          if (n.id === nodeId) continue
          const nvp = viewNodePropsRef.current[n.id] || {}
          if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.visible === false) continue
          const nr = NODE_R * (nvp.scale || 1)
          const nLabel = n.label || ''
          const nFontSize = Math.max(9, Math.round(12 * (nvp.scale || 1)))
          const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, nLabel, nFontSize, nvp.labelWidth)
          if (Math.abs((n.x || 0) - sx) < halfW && Math.abs((n.y || 0) - sy) < halfH) {
            found = n.id; break
          }
        }
        if (found !== dragHoverNodeIdRef.current) {
          dragHoverNodeIdRef.current = found
          setDragHoverNodeId(found)
        }
      }
    }
    const onUp = ue => {
      document.body.style.cursor = ''
      simRef.current.alphaTarget(0)

      // Clear hover highlight
      dragHoverNodeIdRef.current = null
      setDragHoverNodeId(null)

      if (didDrag) {
        const [sx, sy] = clientToSim(ue.clientX, ue.clientY)
        const ddx = sx - startSx, ddy = sy - startSy

        // Reparent: if dropped on another regular node, make it a child
        if (!isFrame && dragHoverNodeIdRef.current === null) {
          // re-check at drop position since ref was just cleared
          let dropTarget = null
          for (const n of simNodesRef.current) {
            if (n.id === nodeId) continue
            const nvp = viewNodePropsRef.current[n.id] || {}
            if (nvp.shape === 'frame' || nvp.shape === '3d' || nvp.visible === false) continue
            const nr = NODE_R * (nvp.scale || 1)
            const { halfW, halfH } = shapeDims(nvp.shape || 'circle', nr, n.label || '', Math.max(9, Math.round(12 * (nvp.scale || 1))), nvp.labelWidth)
            const sp = startPositions.find(p => p.node.id === nodeId)
            const dropX = sp ? sp.ox + ddx : sx, dropY = sp ? sp.oy + ddy : sy
            if (Math.abs((n.x || 0) - dropX) < halfW && Math.abs((n.y || 0) - dropY) < halfH) {
              dropTarget = n.id; break
            }
          }
          if (dropTarget) {
            reparentNode(nodeId, dropTarget)
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

        // For regular nodes: check if dropped inside a frame → update containedIn
        if (!isFrame) {
          const sp = startPositions.find(p => p.node.id === nodeId)
          const dropX = sp ? sp.ox + ddx : sx
          const dropY = sp ? sp.oy + ddy : sy
          let newContainerId = null
          for (const fn of simNodesRef.current) {
            const fvp = viewNodePropsRef.current[fn.id] || {}
            if ((fvp.shape !== 'frame' && fvp.shape !== '3d') || fvp.visible === false) continue
            const fr = NODE_R * (fvp.scale || 1)
            const { halfW, halfH } = shapeDims(fvp.shape === '3d' ? '3d' : 'frame', fr)
            if (Math.abs(dropX - (fn.x || 0)) < halfW && Math.abs(dropY - (fn.y || 0)) < halfH) {
              newContainerId = fn.id; break
            }
          }
          setContainedIn(nodeId, newContainerId)
        }
      }
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setAnchor, setContainedIn, reparentNode, releaseAnchor, storeEdges])

  const handleConnectorMouseDown = useCallback((e, sourceId) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const src = simNodesRef.current.find(n => n.id === sourceId)
    if (!src) return
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      setConnecting({ sourceId, x1: src.x, y1: src.y, x2: sx, y2: sy })
    }
    const onUp = ue => {
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

  const handleFrameResizeMouseDown = useCallback((e, nodeId) => {
    e.stopPropagation(); e.preventDefault()
    const simNode = simNodesRef.current.find(n => n.id === nodeId)
    if (!simNode) return
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const newHW = Math.max(80, Math.abs(sx - (simNode.x || 0)))
      const newHH = Math.max(60, Math.abs(sy - (simNode.y || 0)))
      setNodeViewProp(nodeId, 'frameHalfW', newHW)
      setNodeViewProp(nodeId, 'frameHalfH', newHH)
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

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

  const handleEmojiResizeStart = useCallback((e, nodeId, emojiId, bx, by) => {
    e.stopPropagation(); e.preventDefault()
    const { views: vs0, activeViewId: av0 } = useGraphStore.getState()
    const vp0 = vs0.find(v => v.id === av0)?.nodeProps?.[nodeId] || {}
    const startScale = (vp0.nodeEmojis || []).find(em => em.id === emojiId)?.scale || 1
    const [sx0, sy0] = clientToSim(e.clientX, e.clientY)
    const startDist = Math.max(8, Math.hypot(sx0 - bx, sy0 - by))
    const onMove = me => {
      const [sx, sy] = clientToSim(me.clientX, me.clientY)
      const dist = Math.hypot(sx - bx, sy - by)
      const scale = Math.min(4, Math.max(0.4, startScale * (dist / startDist)))
      const { views: vs, activeViewId: av } = useGraphStore.getState()
      const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}
      setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).map(em => em.id === emojiId ? { ...em, scale } : em))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clientToSim, setNodeViewProp])

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
    const wasCollapsed = (vs.find(v => v.id === av)?.collapsedNodeIds || []).includes(nodeId)

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
        descIds.forEach(id => {
          const sn = simNodesRef.current.find(n => n.id === id)
          if (sn) { sn.fx = null; sn.fy = null }
        })
        toggleCollapseNode(nodeId)
      })
    } else {
      // Explode: reveal at the parent's CURRENT position, then animate out to each
      // descendant's remembered offset re-applied around that current position.
      const px = parentNode.x || 0, py = parentNode.y || 0
      descIds.forEach(id => {
        const sn = simNodesRef.current.find(n => n.id === id)
        if (sn) { sn.x = px; sn.y = py; sn.fx = px; sn.fy = py }
      })
      toggleCollapseNode(nodeId)
      const targets = {}
      descIds.forEach(id => {
        const off = collapseOriginsRef.current[id]
        targets[id] = off ? { x: px + off.dx, y: py + off.dy } : { x: px, y: py }
      })
      requestAnimationFrame(() => {
        animateNodesTo(descIds, targets, 320, () => {
          descIds.forEach(id => {
            const sn = simNodesRef.current.find(n => n.id === id)
            if (sn) { sn.fx = null; sn.fy = null }
          })
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
    scheduleRender()
  }, [scheduleRender])

  // â"€â"€ Paste images â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  useEffect(() => {
    const onPaste = e => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))
      if (!item) return
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
          addImage(src, cx, cy, w, h)
        }
        el.src = ev.target.result
      }
      reader.readAsDataURL(blob)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [addImage])

  // â"€â"€ Image interaction (drag / resize / rotate) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  const handleImageMouseDown = useCallback((e, imageId, mode = 'drag') => {
    e.preventDefault()
    canvasFocused.current = true
    setSelectedImageId(imageId)
    setSelected(null)

    const getImg = () => useGraphStore.getState().views
      .find(v => v.id === useGraphStore.getState().activeViewId)
      ?.images?.find(i => i.id === imageId)

    const img = getImg()
    if (!img) return
    const T = zoomTransformRef.current

    if (mode === 'drag') {
      const [startSx, startSy] = [
        (e.clientX - T.x) / T.k,
        (e.clientY - T.y) / T.k,
      ]
      const ox = img.x, oy = img.y
      const onMove = me => {
        const sx = (me.clientX - T.x) / T.k, sy = (me.clientY - T.y) / T.k
        updateImage(imageId, { x: ox + sx - startSx, y: oy + sy - startSy })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)

    } else if (mode === 'resize') {
      const screenCX = T.x + img.x * T.k, screenCY = T.y + img.y * T.k
      const startDist = Math.hypot(e.clientX - screenCX, e.clientY - screenCY)
      const startW = img.width, startH = img.height
      const onMove = me => {
        if (startDist < 1) return
        const d = Math.hypot(me.clientX - screenCX, me.clientY - screenCY)
        const s = d / startDist
        updateImage(imageId, {
          width: Math.max(20, Math.round(startW * s)),
          height: Math.max(10, Math.round(startH * s)),
        })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)

    } else if (mode === 'rotate') {
      const screenCX = T.x + img.x * T.k, screenCY = T.y + img.y * T.k
      const startAngleDeg = Math.atan2(e.clientY - screenCY, e.clientX - screenCX) * 180 / Math.PI
      const startRot = img.rotation || 0
      const onMove = me => {
        const a = Math.atan2(me.clientY - screenCY, me.clientX - screenCX) * 180 / Math.PI
        updateImage(imageId, { rotation: startRot + a - startAngleDeg })
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
    }
  }, [updateImage])

  const T = zoomTransformRef.current
  const selectedNode = selected?.type === 'node' ? simNodesRef.current.find(n => n.id === selected.id) : null
  const selectedStoreNode = selectedNode ? storeNodes.find(n => n.id === selectedNode.id) : null

  if (loading) return <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'#444', background:'#0c0c1a' }}>Loading project…</div>

  // Pre-compute edge geometry for two-pass rendering (lines behind nodes, arrowheads on top)
  const edgeData = simEdgesRef.current.map(e => {
    const s = e.source, t = e.target
    if (!s || !t || s.x == null) return null
    if (!visibleNodeIds.has(s.id) || !visibleNodeIds.has(t.id)) return null
    const isSel = selected?.id === e.id && selected?.type === 'edge'
    const svp = getVP(s.id), tvp = getVP(t.id)
    const sLabel = storeNodes.find(n => n.id === s.id)?.label || ''
    const tLabel = storeNodes.find(n => n.id === t.id)?.label || ''
    const sr = NODE_R * (svp.scale||1), tr = NODE_R * (tvp.scale||1)
    const sFontSize = Math.max(9, Math.round(12 * (svp.scale||1)))
    const tFontSize = Math.max(9, Math.round(12 * (tvp.scale||1)))
    const { halfW: swW, halfH: swH } = shapeDims(svp.shape || 'circle', sr, sLabel, sFontSize, svp.labelWidth)
    const { halfW: twW, halfH: twH } = shapeDims(tvp.shape || 'circle', tr, tLabel, tFontSize, tvp.labelWidth)
    const dx = t.x-s.x, dy = t.y-s.y, dist = Math.sqrt(dx*dx+dy*dy)||1
    const ux = dx/dist, uy = dy/dist
    const sd = clipDist(svp.shape||'circle', swW, swH, ux, uy)
    const td = clipDist(tvp.shape||'circle', twW, twH, ux, uy)
    const x1 = s.x + ux*(sd - 5), y1 = s.y + uy*(sd - 5)
    const ALEN = 10, AW = 5
    const tipX = t.x - ux*(td - 5), tipY = t.y - uy*(td - 5)
    const basX = tipX - ux*ALEN, basY = tipY - uy*ALEN
    const perpX = -uy, perpY = ux
    const arrowPts = `${tipX},${tipY} ${basX+perpX*AW},${basY+perpY*AW} ${basX-perpX*AW},${basY-perpY*AW}`
    const mx = (x1+basX)/2, my = (y1+basY)/2
    const edgeColor = isSel ? '#5b6af0' : '#334155'
    return { id: e.id, x1, y1, x2: basX, y2: basY, tipX, tipY, arrowPts, mx, my, edgeColor, isSel }
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

  const exitPresentation = () => { setPresentingSlideIdx(null) }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Outline sidebar â€" hidden while presenting */}
      {!isPresenting && (<>
      <div onMouseDown={() => { canvasFocused.current = false }}
        style={{ width: sidebarWidth, flexShrink: 0, background: '#0d0d1a', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <OutlinePanel
          selectedNodeId={selected?.type === 'node' ? selected.id : null}
          onSelectNode={id => setSelected({ id, type: 'node' })}
          containerNodeIds={new Set(storeNodes.filter(n => (viewNodeProps[n.id]?.shape) === 'frame').map(n => n.id))}
        />
        <ViewManager />
        {/* Tool strip — consolidated canvas actions */}
        <div style={{ flexShrink:0, borderTop:'1px solid #1e1e2e', padding:'8px 10px', display:'flex', flexDirection:'column', gap:6 }}>
          {drillRoot && (
            <button style={sideToolBtnStyle} onClick={exitDrill}>→ Exit Drill</button>
          )}
          <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
            <button style={sideToolBtnStyle} onClick={zoomExtents} title="Fit all nodes in view">⊡ Fit</button>
            <button style={sideToolBtnStyle} onClick={handleReleaseAll} title="Release all anchors">⊙ Free</button>
            {/* BG color */}
            <div style={{ position:'relative' }}>
              <button style={{ ...sideToolBtnStyle, display:'flex', alignItems:'center', gap:4 }}
                onClick={e => { e.stopPropagation(); setShowBgPicker(v => !v) }} title="Canvas background color">
                <span style={{ width:10, height:10, borderRadius:2, background:bgColor, border:'1px solid #5b6af0', display:'inline-block', flexShrink:0 }} />
                BG
              </button>
              {showBgPicker && (
                <div style={{ position:'absolute', bottom:'100%', left:0, marginBottom:6, background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8, padding:8, display:'flex', flexDirection:'column', gap:6, zIndex:30, boxShadow:'0 4px 20px rgba(0,0,0,0.6)' }}
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
          <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
            <button style={sideToolBtnStyle} onClick={() => setPendingEditId(addNode('New node', selected?.type === 'node' ? selected.id : null))}>+ Node</button>
            <button style={sideToolBtnStyle} onClick={addFrameToCenter}>⊞ Frame</button>
            <button style={{ ...sideToolBtnStyle, color: hideFrameOutlines ? '#f6ad55' : undefined }} onClick={() => setHideFrameOutlines(v => !v)} title="Toggle frame outlines">{hideFrameOutlines ? '⊞ Show' : '⊞ Hide'}</button>
            <button style={sideToolBtnStyle} onClick={() => setPendingEditId(addNode('New node', null))}>+ Root</button>
            <button style={sideToolBtnStyle} onClick={() => addView()}>+ View</button>
          </div>
        </div>
      </div>
      {/* Sidebar resize handle */}
      <div style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: '#1e1e2e', transition: 'background 0.1s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#2d3a6a'}
        onMouseLeave={e => e.currentTarget.style.background = '#1e1e2e'}
        onMouseDown={e => {
          e.preventDefault()
          const startX = e.clientX, startW = sidebarWidth
          const onMove = me => setSidebarWidth(Math.max(150, Math.min(420, startW + me.clientX - startX)))
          const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
          document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
        }}
      />
      </>)}
      <div onMouseDown={() => { canvasFocused.current = true }} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <svg ref={svgRef}
          style={{ width: '100%', height: '100%', background: effectiveBg, display: 'block', cursor: isPanning ? 'grabbing' : 'grab' }}
          onClick={() => { setSelected(null); setSelectedImageId(null); setShowBgPicker(false); setNotePopupId(null) }}
          onDoubleClick={e => {
            if (e.target.closest?.('[data-node]') || e.target.closest?.('[data-frame]') || e.target.closest?.('[data-img]')) return
            const rect = svgRef.current.getBoundingClientRect()
            const [sx, sy] = zoomTransformRef.current.invert([e.clientX - rect.left, e.clientY - rect.top])
            const id = addNode('New node', null, sx, sy)
            setPendingEditId(id)
            setTimeout(() => {
              const sn = simNodesRef.current.find(n => n.id === id)
              if (sn) { sn.x = sx; sn.y = sy; sn.fx = sx; sn.fy = sy }
              scheduleRender()
            }, 0)
          }}
          onMouseDown={e => { if (!e.target.closest?.('[data-node]')) setIsPanning(true) }}
          onMouseUp={() => setIsPanning(false)}
          onMouseLeave={() => setIsPanning(false)}
        >
          <defs>
            <marker id="arr" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,8 L8,4 z" fill="#334155" /></marker>
            <marker id="arr-sel" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,8 L8,4 z" fill="#5b6af0" /></marker>
            <filter id="edge-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#000" floodOpacity="0.6" />
              <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="#000" floodOpacity="0.4" />
            </filter>
            <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#000" floodOpacity="0.5" />
              <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#000" floodOpacity="0.3" />
            </filter>
          </defs>

          <g transform={`translate(${T.x},${T.y}) scale(${T.k})`}>
            {/* 1. Frame containers */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && getVP(n.id).shape === 'frame').map(n => (
              <FrameNode key={n.id} node={n}
                viewProps={getVP(n.id)}
                isSelected={selected?.id === n.id && selected?.type === 'node'}
                inSlides={slideIds.includes(n.id)}
                isPresenting={isPresenting}
                onMouseDown={handleNodeMouseDown}
                onResizeMouseDown={handleFrameResizeMouseDown}
                onDelete={id => setConfirmDelete(id)}
                onLabelChange={updateLabel}
                onToggleSlide={id => slideIds.includes(id) ? removeSlide(id) : addSlide(id)}
                hideOutline={hideFrameOutlines}
              />
            ))}

            {/* 2. Edges â€" node fill covers the tips cleanly */}
            {edgeData.map(({ id, x1, y1, tipX, tipY, arrowPts, mx, my, edgeColor, isSel }) => (
              <g key={id} onClick={ev => { ev.stopPropagation(); setSelected({ id, type: 'edge' }) }} style={{ cursor:'pointer' }}>
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke="transparent" strokeWidth={12} />
                {/* halo â€” bg-tinted outline that separates line from overlapping elements */}
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={bgColor} strokeWidth={isSel?6:4} strokeOpacity={0.55} />
                <polygon points={arrowPts} fill={bgColor} fillOpacity={0.55} stroke={bgColor} strokeWidth={isSel?6:4} strokeOpacity={0.55} strokeLinejoin="round" />
                <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={edgeColor} strokeWidth={isSel?2.5:1.5} filter="url(#edge-shadow)" />
                <polygon points={arrowPts} fill={edgeColor} stroke={edgeColor} strokeWidth={isSel?2.5:1.5} strokeLinejoin="round" filter="url(#edge-shadow)" />
                {isSel && (
                  <g transform={`translate(${mx},${my})`} onClick={ev => { ev.stopPropagation(); removeEdge(id); setSelected(null) }} style={{ cursor:'pointer' }}>
                    <circle r={9} fill="#1a1a2e" stroke="#f87171" strokeWidth={1.5} />
                    <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect:'none' }}>{'\xD7'}</text>
                  </g>
                )}
              </g>
            ))}

            {connecting && <line x1={connecting.x1} y1={connecting.y1} x2={connecting.x2} y2={connecting.y2} stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.7} />}

            {/* 3. Images */}
            {(activeView?.images || []).filter(img => img.visible !== false).map(img => (
              <ImageNode key={img.id} img={img}
                isSelected={selectedImageId === img.id}
                onMouseDown={handleImageMouseDown}
              />
            ))}

            {/* 3b placeholder — 3D viewer is rendered as absolute div outside SVG below */}

            {/* 4. Regular nodes on top */}
            {simNodesRef.current.filter(n => visibleNodeIds.has(n.id) && getVP(n.id).shape !== 'frame').map(n => (
              <NodeShape key={n.id} node={n}
                modelThumb={getVP(n.id).model3dRotate === 'always' ? null : (liveThumbsRef.current[n.id] || storeNodes.find(s => s.id === n.id)?.modelThumb)}
                imageUrl={storeNodes.find(s => s.id === n.id)?.imageUrl || ''}
                viewProps={getVP(n.id)}
                isSelected={selected?.id === n.id && selected?.type === 'node'}
                isHovered={hoveredNodeId === n.id}
                isDropTarget={dragHoverNodeId === n.id}
                autoEdit={pendingEditId === n.id}
                onAutoEditDone={() => setPendingEditId(null)}
                keepEdit={keepEditId === n.id}
                onKeepEditDone={() => setKeepEditId(null)}
                onMouseDown={handleNodeMouseDown}
                onConnectorMouseDown={handleConnectorMouseDown}
                onScaleMouseDown={handleScaleMouseDown}
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
            ))}

          </g>
        </svg>

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

        {/* Node toolbar â€" shows on hover */}
        {(() => {
          const hn = hoveredNodeId && simNodesRef.current.find(n => n.id === hoveredNodeId)
          const hs = hn && storeNodes.find(n => n.id === hn.id)
          if (!hn || !hs || !visibleNodeIds.has(hn.id)) return null
          const vp = getVP(hn.id)
          const { halfH: hnHalfH } = shapeDims(vp.shape||'circle', NODE_R*(vp.scale||1), hs.label, Math.max(9, Math.round(12*(vp.scale||1))), vp.labelWidth)
          // Extra clearance so the popup doesn't sit on top of the collapse/expand chevron
          const chevronClearance = nodesWithChildren.has(hn.id) ? 26 * T.k : 0
          const toolbarY = vp.shape === '3d'
            ? T.y + (hn.y||0) * T.k - hnHalfH * T.k - 14
            : T.y + (hn.y||0) * T.k + hnHalfH * T.k + 14 + chevronClearance
          return (
            <NodeToolbar
              x={T.x + (hn.x||0) * T.k}
              y={toolbarY}
              viewProps={vp}
              notes={hs.notes || ''}
              onSetFill={c => setNodeViewProp(hn.id, 'fillColor', c)}
              onSetTextColor={c => setNodeViewProp(hn.id, 'textColor', c)}
              onSetStrokeColor={c => setNodeViewProp(hn.id, 'strokeColor', c)}
              onSetStrokeWidth={w => setNodeViewProp(hn.id, 'strokeWidth', w)}
              onSetBorderBlur={v => setNodeViewProp(hn.id, 'borderBlur', v)}
              onSetOpacity={v => setNodeViewProp(hn.id, 'opacity', v)}
              onSetShape={s => { setNodeViewProp(hn.id, 'shape', s); if (s === 'image') setNodeViewProp(hn.id, 'fillColor', 'transparent'); if (s === '3d') setNodeViewProp(hn.id, 'fillColor', 'none') }}
              onDrill={() => { setDrillRoot(hn.id); setHoveredNodeId(null); setTimeout(zoomExtents, 50) }}
              onHide={() => { setNodeViewProp(hn.id, 'visible', false); setHoveredNodeId(null) }}
              onRelease={() => handleRelease(hn.id)}
              onDelete={() => { setConfirmDelete(hn.id); setHoveredNodeId(null) }}
              onNotesChange={notes => updateNotes(hn.id, notes)}
              isAnchored={hn.fx != null}
              imageUrl={hs.imageUrl || ''}
              onSetImageUrl={url => setImageUrl(hn.id, url)}
              onRadiate={what => {
                const childIds = storeEdges.filter(e => e.source === hn.id).map(e => e.target)
                childIds.forEach(cid => {
                  if (what === 'color' || what === 'both') setNodeViewProp(cid, 'fillColor', vp.fillColor)
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
              onMouseEnter={() => showToolbar(hn.id)}
              onMouseLeave={hideToolbar}
              onWheel={e => svgRef.current?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }))}
            />
          )
        })()}

        {/* Note popup */}
        {notePopupId && (() => {
          const nn = simNodesRef.current.find(n => n.id === notePopupId)
          const ns = storeNodes.find(n => n.id === notePopupId)
          if (!nn || !ns || !ns.notes) return null
          const vp = getVP(notePopupId)
          const sc = vp.scale || 1
          const { halfH: nh } = shapeDims(vp.shape || 'circle', NODE_R * sc, ns.label, Math.max(9, Math.round(12 * sc)), vp.labelWidth)
          const bOffset = (nh + 40) * T.k
          const screenX = T.x + (nn.x || 0) * T.k
          const screenY = T.y + (nn.y || 0) * T.k - bOffset
          return (
            <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
              style={{ position:'absolute', left:screenX, top:screenY, transform:'translateX(-50%)',
                background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8, padding:'8px 12px',
                maxWidth:260, minWidth:120, zIndex:30, boxShadow:'0 4px 16px rgba(0,0,0,0.7)' }}>
              <pre style={{ fontSize:'0.8rem', color:'#c7d0f8', fontFamily:'inherit', whiteSpace:'pre-wrap', margin:0, lineHeight:1.5 }}>
                {ns.notes}
              </pre>
              <button onClick={() => setNotePopupId(null)}
                style={{ position:'absolute', top:4, right:6, background:'none', border:'none', color:'#556', cursor:'pointer', fontSize:14 }}>x</button>
            </div>
          )
        })()}

        {/* Image toolbar */}
        {selectedImageId && (() => {
          const img = (activeView?.images || []).find(i => i.id === selectedImageId)
          if (!img) return null
          const screenX = T.x + img.x * T.k
          const screenY = T.y + img.y * T.k + (img.height / 2) * T.k + 10
          return (
            <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
              style={{ position: 'absolute', left: screenX, top: screenY, transform: 'translateX(-50%)',
                background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: '6px 8px',
                display: 'flex', flexDirection: 'column', gap: 6, zIndex: 25, boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
              {/* Action row */}
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <button onClick={() => updateImage(selectedImageId, { visible: img.visible === false ? true : false })}
                  title={img.visible === false ? 'Show' : 'Hide'}
                  style={{ ...tlBtn, color: img.visible === false ? '#f6ad55' : '#aaa' }}>
                  {img.visible === false ? '◌ Show' : '◌ Hide'}
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={() => { setConfirmDeleteImage(selectedImageId) }}
                  style={{ ...tlBtn, color: '#f87171' }}>✕ Delete</button>
              </div>
            </div>
          )
        })()}

        {/* Delete node confirm */}
        {confirmDelete && (
          <div style={confirmStyle} onClick={() => setConfirmDelete(null)}>
            <div style={confirmBox} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
                Delete node from <strong>all views</strong>?
              </div>
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button style={confirmCancelBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                <button style={confirmOkBtn} onClick={() => { deleteNode(confirmDelete); setSelected(null); setConfirmDelete(null) }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* Delete image confirm */}
        {confirmDeleteImage && (
          <div style={confirmStyle} onClick={() => setConfirmDeleteImage(null)}>
            <div style={confirmBox} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
                Delete this image?
              </div>
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button style={confirmCancelBtn} onClick={() => setConfirmDeleteImage(null)}>Cancel</button>
                <button style={confirmOkBtn} onClick={() => { deleteImage(confirmDeleteImage); setSelectedImageId(null); setConfirmDeleteImage(null) }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* Save status */}
        {!isPresenting && <div style={{ position:'absolute', top:10, left:12, pointerEvents:'none' }}>
          <span style={{ fontSize:'0.68rem', color: saveStatus==='error'?'#f87171':saveStatus==='saving'?'#5b6af0':'#2a3a2a' }}>
            {saveStatus==='error'?'● save failed':saveStatus==='saving'?'● saving…':'● saved'}
          </span>
        </div>}


        {/* Expand-from-node slider */}
        {!isPresenting && (() => {
          const focalId = depthExpand?.nodeId
          const focalLabel = focalId ? storeNodes.find(n => n.id === focalId)?.label : null
          const radius = depthExpand?.radius ?? 0
          const isOn = depthExpand !== null
          const selectedNodeId = selected?.type === 'node' ? selected.id : null
          return (
            <div style={{ position:'absolute', bottom:'1.25rem', left:'1.25rem', display:'flex', alignItems:'center', gap:8, background:'rgba(18,18,42,0.92)', border:`1px solid ${isOn ? '#5b6af0' : '#2d3a6a'}`, borderRadius:8, padding:'6px 10px', backdropFilter:'blur(4px)', zIndex:10 }}>
              <button
                title={isOn ? 'Exit expand mode' : 'Expand from selected node'}
                onClick={() => {
                  if (isOn) { setDepthExpand(null) }
                  else if (selectedNodeId) { setDepthExpand({ nodeId: selectedNodeId, radius: 1 }) }
                }}
                style={{ background:'transparent', border:'none', color: isOn ? '#5b6af0' : '#445', cursor:'pointer', fontSize:'0.9rem', padding:'0 2px', lineHeight:1 }}>
                ⊛
              </button>
              {isOn && (
                <>
                  {focalLabel && <span style={{ fontSize:'0.7rem', color:'#7b8fcc', maxWidth:80, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{focalLabel}</span>}
                  <span style={{ fontSize:'0.65rem', color:'#445', userSelect:'none' }}>+1</span>
                  <input type="range" min={1} max={Math.max(1, maxExpandRadius)} value={radius}
                    onChange={e => setDepthExpand(d => ({ ...d, radius: Number(e.target.value) }))}
                    style={{ width:80, accentColor:'#5b6af0', cursor:'pointer' }} />
                  <span style={{ fontSize:'0.65rem', color:'#445', userSelect:'none' }}>+{Math.max(1, maxExpandRadius)}</span>
                  <span style={{ fontSize:'0.75rem', color:'#c5d0ff', minWidth:16, textAlign:'center', userSelect:'none', fontWeight:600 }}>+{radius}</span>
                  {selectedNodeId && selectedNodeId !== focalId && (
                    <button onClick={() => setDepthExpand({ nodeId: selectedNodeId, radius })}
                      style={{ background:'transparent', border:'1px solid #2d3a6a', color:'#7b8fcc', cursor:'pointer', fontSize:'0.65rem', padding:'2px 5px', borderRadius:4 }}>
                      refocus
                    </button>
                  )}
                </>
              )}
              {!isOn && <span style={{ fontSize:'0.65rem', color:'#334', userSelect:'none' }}>expand</span>}
            </div>
          )
        })()}


        {/* Build timestamp â€" bottom right */}
        {!isPresenting && <div style={{ position:'absolute', bottom:'0.5rem', right:'0.75rem', zIndex:20, fontSize:'0.62rem', color:'#333', fontFamily:'monospace', userSelect:'none' }}>
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
              <div style={{ fontSize:'0.63rem', color:'#556', letterSpacing:'0.06em' }}>FILL</div>
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

        {/* Presentation controls overlay */}
        {isPresenting && (
          <div style={{ position:'absolute', inset:0, pointerEvents:'none', zIndex:30 }}>
            {/* Bottom nav bar */}
            <div style={{ position:'absolute', bottom:24, left:'50%', transform:'translateX(-50%)', pointerEvents:'all',
              background:'rgba(10,10,24,0.88)', border:'1px solid #2d3a6a', borderRadius:10,
              padding:'8px 18px', display:'flex', gap:14, alignItems:'center', boxShadow:'0 4px 20px rgba(0,0,0,0.6)' }}>
              <button style={canvasBtnStyle} onClick={() => navigateSlide(-1)}>← Prev</button>
              <span style={{ color:'#88b4e8', fontSize:'0.85rem', minWidth:60, textAlign:'center' }}>
                {(presentingSlideIdx ?? 0) + 1} / {slideSimNodes.length}
              </span>
              <button style={canvasBtnStyle} onClick={() => navigateSlide(1)}>Next →</button>
            </div>
          </div>
        )}
      </div>

      {/* Slides tab â€" flex sibling so it's never clipped, always at same zone as sidebar */}
      {frameSimNodes.length > 0 && !isPresenting && !showSlideSidebar && (
        <div onClick={() => setShowSlideSidebar(true)}
          style={{ width:26, flexShrink:0, borderLeft:'1px solid #1e1e2e', background:'#0d0d1a',
            cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
            writingMode:'vertical-rl', textOrientation:'mixed', letterSpacing:'0.1em',
            color:'#5b6af0', fontSize:'0.72rem', fontWeight:600, userSelect:'none',
            gap:0, paddingTop:6 }}>
          ▸ SLIDES
        </div>
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
          removeSlide={removeSlide}
          addSlide={addSlide}
          reorderSlides={reorderSlides}
          addSlideshow={addSlideshow}
          deleteSlideshow={deleteSlideshow}
          renameSlideshow={renameSlideshow}
          setActiveSlideshowId={setActiveSlideshowId}
          setSlideBgColor={setSlideBgColor}
          onClose={() => setShowSlideSidebar(false)}
          canvasBtnStyle={canvasBtnStyle}
        />
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
function SlideSidebar({ slideSimNodes, allSimNodes, frameSimNodes, viewImages, slideIds, slideshows, activeSlideshowId, presentingSlideIdx, getVP, zoomToFrame, setPresentingSlideIdx, removeSlide, addSlide, reorderSlides, addSlideshow, deleteSlideshow, renameSlideshow, setActiveSlideshowId, setSlideBgColor, onClose, canvasBtnStyle }) {
  const activeSlideshow = slideshows.find(ss => ss.id === activeSlideshowId) || slideshows[0]
  const activeSlideBgColors = activeSlideshow?.slideBgColors || {}
  const [dragIdx, setDragIdx] = useState(null)
  const [dropIdx, setDropIdx] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const containerRef = useRef()

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
    <div ref={containerRef} onMouseDown={e => e.stopPropagation()}
      style={{ width: 190, flexShrink: 0, borderLeft: '1px solid #1e1e2e', background: '#0d0d1a',
        overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '8px 8px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6, paddingBottom:6, borderBottom:'1px solid #1e1e2e' }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'#8090b8', cursor:'pointer', fontSize:14, padding:'0 2px', lineHeight:1 }}>‹</button>
          <span style={{ fontSize:'0.68rem', color:'#8090b8', letterSpacing:'0.08em', fontWeight:600 }}>SLIDES</span>
        </div>
        <button style={{ ...canvasBtnStyle, fontSize:'0.7rem', padding:'2px 6px' }}
          onClick={() => { if (slideSimNodes.length) { setPresentingSlideIdx(0); zoomToFrame(slideSimNodes[0]) } }}
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
            style={{ marginBottom: 8, position: 'relative', cursor: 'grab', userSelect: 'none',
              opacity: dragIdx === i ? 0.4 : 1,
              borderRadius: 6 }}>
            <div style={{ borderRadius:6, overflow:'hidden',
              border: presentingSlideIdx === i ? '2px solid #5b6af0' : '1.5px solid #1e2a3a',
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
              {/* Per-slide background color */}
              <div onMouseDown={e => e.stopPropagation()} style={{ display:'flex', alignItems:'center', gap:3, padding:'3px 8px 5px', flexWrap:'wrap' }}>
                <span style={{ fontSize:'0.58rem', color:'#445', letterSpacing:'0.05em', marginRight:2 }}>BG</span>
                <div title="Default" onClick={e => { e.stopPropagation(); setSlideBgColor(activeSlideshowId, fn.id, null) }}
                  style={{ width:13, height:13, borderRadius:2, cursor:'pointer',
                    backgroundImage: 'linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%)',
                    backgroundSize: '5px 5px', backgroundPosition: '0 0, 2.5px 2.5px',
                    border: !activeSlideBgColors[fn.id] ? '1.5px solid #fff' : '1px solid #334' }} />
                {BG_COLORS.map(c => (
                  <div key={c} onClick={e => { e.stopPropagation(); setSlideBgColor(activeSlideshowId, fn.id, c) }}
                    style={{ width:13, height:13, borderRadius:2, background:c, cursor:'pointer',
                      border: activeSlideBgColors[fn.id]===c ? '1.5px solid #fff' : '1px solid rgba(255,255,255,0.15)' }} />
                ))}
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
          <div style={{ fontSize:'0.62rem', color:'#445', marginBottom:6, letterSpacing:'0.06em' }}>NOT IN SLIDESHOW</div>
          {nonSlideFrames.map(fn => (
            <div key={fn.id} style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
              <span style={{ flex:1, fontSize:'0.72rem', color:'#556', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                {fn.label || 'Frame'}
              </span>
              <button onClick={() => addSlide(fn.id)}
                style={{ background:'transparent', border:'1px solid #2d3a6a', color:'#5b6af0', cursor:'pointer', fontSize:'0.68rem', padding:'1px 5px', borderRadius:3, flexShrink:0 }}>+ Add</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// â"€â"€â"€ ImageNode â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function ImageNode({ img, isSelected, onMouseDown }) {
  const { id, src, x, y, width, height, rotation, bgColor } = img
  const hw = width / 2, hh = height / 2

  return (
    <g transform={`translate(${x},${y}) rotate(${rotation})`}
      data-img="true"
      onClick={e => e.stopPropagation()}
      onMouseDown={e => { if (e.button !== 0) return; e.stopPropagation(); onMouseDown(e, id) }}
      style={{ cursor: 'move' }}
    >
      {bgColor && <rect x={-hw} y={-hh} width={width} height={height} fill={bgColor} rx={2} />}
      {isSelected && (
        <rect x={-hw - 3} y={-hh - 3} width={width + 6} height={height + 6}
          fill="none" stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="5,3" rx={2} />
      )}
      <image href={src} x={-hw} y={-hh} width={width} height={height} />
      {isSelected && (<>
        {/* Resize â€" bottom-right (ratio-locked from center distance) */}
        <g transform={`translate(${hw},${hh})`}
          onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id, 'resize') }} style={{ cursor: 'nwse-resize' }}>
          <circle r={8} fill="#16162a" stroke="#5b6af0" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={9} fill="#5b6af0" style={{ userSelect: 'none' }}>⤡</text>
        </g>
        {/* Rotate â€" top-center */}
        <line x1={0} y1={-hh} x2={0} y2={-hh - 22} stroke="#a78bfa" strokeWidth={1} opacity={0.6} />
        <g transform={`translate(0,${-hh - 28})`}
          onMouseDown={e => { e.stopPropagation(); onMouseDown(e, id, 'rotate') }} style={{ cursor: 'grab' }}>
          <circle r={8} fill="#16162a" stroke="#a78bfa" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#a78bfa" style={{ userSelect: 'none' }}>↻</text>
        </g>
      </>)}
    </g>
  )
}

// â"€â"€â"€ FrameNode â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function FrameNode({ node, viewProps, isSelected, inSlides, isPresenting, onMouseDown, onResizeMouseDown, onDelete, onLabelChange, onToggleSlide, hideOutline }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
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
          <text textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#f87171" style={{ userSelect: 'none' }}>×</text>
        </g>
      )}

      {/* Slide toggle (top-right, left of delete) */}
      {isSelected && (
        <g transform={`translate(${halfW - 36},${-halfH + 12})`}
          onClick={e => { e.stopPropagation(); onToggleSlide(node.id) }}
          style={{ cursor: 'pointer' }}
          title={inSlides ? 'Remove from slideshow' : 'Add to slideshow'}>
          <circle r={9} fill="#1a1a2e" stroke={inSlides ? '#5b6af0' : '#445'} strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={9} fill={inSlides ? '#5b6af0' : '#667'} style={{ userSelect: 'none' }}>
            {inSlides ? '⊟' : '⊞'}
          </text>
        </g>
      )}

      {/* 4 corner resize handles */}
      {isSelected && [[-1,-1,'nwse-resize'],[ 1,-1,'nesw-resize'],[-1,1,'nesw-resize'],[ 1,1,'nwse-resize']].map(([sx, sy, cur]) => (
        <g key={`${sx}${sy}`} transform={`translate(${sx * halfW},${sy * halfH})`}
          onMouseDown={e => { e.stopPropagation(); onResizeMouseDown(e, node.id) }}
          style={{ cursor: cur }}>
          <circle r={7} fill="#16162a" stroke="#5b6af0" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="middle" fontSize={9} fill="#5b6af0" style={{ userSelect: 'none' }}>⤡</text>
        </g>
      ))}
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

function NodeShape({ node, viewProps, isSelected, isHovered, isDropTarget, autoEdit, onAutoEditDone, keepEdit, onKeepEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onSetLabelWidth, onResetLabelWidth, onDelete, onLabelChange, onTab, onCreateSister, onShowNotePopup, onEmojiDragStart, onRemoveEmoji, onEmojiResizeStart, onImageDragStart, onImageResizeStart, onImageCropDragStart, onRemoveNodeImage, hasChildren, isCollapsed, onToggleCollapse, onMouseEnter, onMouseLeave, modelThumb }) {
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

  const commitEdit = () => { onLabelChange(node.id, draft.trim() || 'New node'); setEditing(false) }

  const isAnchored = node.fx != null
  const scale = viewProps.scale || 1
  const r = NODE_R * scale
  const shape = viewProps.shape || 'circle'
  const baseFontSize = Math.max(9, Math.round(12 * scale))
  const isAutoSized = shape === 'roundrect' || shape === 'rect'
  const { halfW, halfH } = shapeDims(shape, r, node.label, baseFontSize, viewProps.labelWidth)
  // Auto-shrink font for fixed-size shapes only (auto-sized shapes fit the text)
  const fontSize = isAutoSized ? baseFontSize : (() => {
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
      onMouseDown={e => onMouseDown(e, node.id)}
      onClick={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ cursor: 'move', pointerEvents: shape === '3d' && isSelected ? 'none' : undefined }}
    >
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
        {viewProps.borderBlur > 0 ? (
          <>
            <defs>
              <filter id={`bglow-${node.id}`} x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur in="SourceGraphic" stdDeviation={viewProps.borderBlur} />
              </filter>
            </defs>
            {/* Glow: a solid shape the SAME size as the node, blurred — the Gaussian
                fade straddles the true edge so there's no hard ring before it fades out */}
            <ShapeBody shape={shape} halfW={bodyHalfW} halfH={bodyHalfH} r={bodyR}
              fill={viewProps.strokeColor || '#5b6af0'} stroke="none"
              filter={`url(#bglow-${node.id})`} />
            {/* Crisp fill on top, exact same size — covers the glow's solid interior entirely */}
            <ShapeBody shape={shape} halfW={bodyHalfW} halfH={bodyHalfH} r={bodyR} fill={fill} stroke="none" strokeWidth={0} />
          </>
        ) : (
          <ShapeBody shape={shape} halfW={bodyHalfW} halfH={bodyHalfH} r={bodyR} fill={fill}
            stroke={viewProps.strokeColor || "none"} strokeWidth={viewProps.strokeColor ? (viewProps.strokeWidth || 1.5) : 0} />
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
            <NodeLabel label={node.label} halfW={halfW} halfH={halfH} fontSize={fontSize} textColor={viewProps.textColor || '#fff'} />
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
          const FADE = 6
          return rows.map(({ im, x: ix, y: iy }) => {
            const crop = im.crop || { x: 0, y: 0, w: 1, h: 1 }
            const isCropping = croppingImgId === im.id
            const clipId = `imc-${im.id}`
            const maskId = `imm-${im.id}`
            const filterId = `imf-${im.id}`
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
                <defs>
                  <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation={FADE} />
                  </filter>
                  <mask id={maskId}>
                    <rect x={-im.w/2 + FADE} y={-im.h/2 + FADE} width={im.w - FADE*2} height={im.h - FADE*2}
                      rx={FADE/2} fill="white" filter={`url(#${filterId})`} />
                  </mask>
                  {(crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) && (
                    <clipPath id={clipId}>
                      <rect x={cx} y={cy} width={cw} height={ch} />
                    </clipPath>
                  )}
                </defs>
                {isCropping && <image href={im.src} x={-im.w/2} y={-im.h/2} width={im.w} height={im.h} opacity={0.3} style={{ pointerEvents:'none' }} />}
                <image href={im.src} x={-im.w / 2} y={-im.h / 2} width={im.w} height={im.h}
                  mask={`url(#${maskId})`}
                  clipPath={(crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) ? `url(#${clipId})` : undefined}
                  onDoubleClick={e => { e.stopPropagation(); setCroppingImgId(isCropping ? null : im.id) }}
                  style={{ pointerEvents: isSelected ? 'auto' : 'none', cursor: isSelected ? (isCropping ? 'crosshair' : 'default') : undefined }} />
                {isSelected && !isCropping && (
                  <>
                    <rect x={-im.w / 2} y={-im.h / 2} width={im.w} height={im.h} fill="none" stroke="#5b6af0" strokeWidth={1} />
                    <g transform={`translate(${im.w / 2 - 6},${-im.h / 2 + 6})`}
                      onClick={e => { e.stopPropagation(); onRemoveNodeImage?.(node.id, im.id) }} style={{ cursor:'pointer' }}>
                      <circle r={5.5} fill="#f87171" />
                      <text textAnchor="middle" dominantBaseline="central" fontSize={8} fill="#fff" style={{ userSelect:'none', pointerEvents:'none' }}>×</text>
                    </g>
                    <g transform={`translate(${im.w / 2},${im.h / 2})`}
                      onMouseDown={e => { e.stopPropagation(); onImageResizeStart?.(e, node.id, im.id, x + ix, y + iy) }}
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
            onClick={e => { e.stopPropagation(); onShowNotePopup?.(node.id) }}
            style={{ cursor: 'pointer' }}>
            <circle r={8} fill="#12122a" stroke="#5b6af0" strokeWidth={1.2} />
            <text textAnchor="middle" dominantBaseline="central" fill="#5b6af0" fontSize={9} style={{ userSelect:'none', pointerEvents:'none' }}>✎</text>
          </g>
        )}
      </AnimatedG>

      {/* Emoji badges — outside AnimatedG so they stay fixed while node wiggles */}
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
                <text textAnchor="middle" dominantBaseline="central" fontSize={8} fill="#fff" style={{ userSelect:'none', pointerEvents:'none' }}>×</text>
              </g>
            )}
            {isSelected && (
              <circle cx={handleR} cy={handleR} r={5}
                fill="#5b6af0" stroke="#fff" strokeWidth={1}
                onMouseDown={e => { e.stopPropagation(); onEmojiResizeStart?.(e, node.id, em.id, (node.x || 0) + ex, (node.y || 0) + ey) }}
                style={{ cursor: 'nwse-resize' }} />
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
        const pFADE = 6
        const isCropping = croppingImgId === im.id
        const pClipId = `pmc-${im.id}`, pMaskId = `pmm-${im.id}`, pFiltId = `pmf-${im.id}`
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
            <defs>
              <filter id={pFiltId} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation={pFADE} />
              </filter>
              <mask id={pMaskId}>
                <rect x={-im.w/2 + pFADE} y={-im.h/2 + pFADE} width={im.w - pFADE*2} height={im.h - pFADE*2}
                  rx={pFADE/2} fill="white" filter={`url(#${pFiltId})`} />
              </mask>
              {(crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1) && (
                <clipPath id={pClipId}><rect x={cx} y={cy} width={cw} height={ch} /></clipPath>
              )}
            </defs>
            {isCropping && <image href={im.src} x={-im.w/2} y={-im.h/2} width={im.w} height={im.h} opacity={0.3} style={{ pointerEvents:'none' }} />}
            <image href={im.src} x={-im.w / 2} y={-im.h / 2} width={im.w} height={im.h}
              mask={`url(#${pMaskId})`}
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
                  <text textAnchor="middle" dominantBaseline="central" fontSize={8} fill="#fff" style={{ userSelect:'none', pointerEvents:'none' }}>×</text>
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
      {hasChildren && (isSelected || isHovered || isCollapsed) && (
        <g transform={`translate(0,${bodyHalfH + 11})`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onToggleCollapse?.() }}
          style={{ cursor: 'pointer' }}>
          <circle r={10} fill="#16162a" stroke={isCollapsed ? '#f6ad55' : 'rgba(255,255,255,0.18)'} strokeWidth={1.2} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={11}
            fill={isCollapsed ? '#f6ad55' : '#9aa8d8'}
            style={{ userSelect:'none', pointerEvents:'none' }}>{isCollapsed ? '▸' : '▾'}</text>
        </g>
      )}

      {/* Edit input — for 3D nodes render at caption position below box (inside box is covered by 3D div) */}
      {editing && (() => {
        const foX = -halfW
        const foY = shape === '3d' ? halfH + 2 : -halfH
        const foW = halfW * 2
        const foH = shape === '3d' ? 26 : halfH * 2
        return (
          <foreignObject x={foX} y={foY} width={foW} height={foH}
            onMouseDown={e => e.stopPropagation()}>
            <textarea ref={inputRef} value={draft} autoFocus
              onChange={e => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitEdit() }
                if (e.key === 'Enter' && e.shiftKey) { e.stopPropagation() }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false) }
                if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEdit(); onTab?.(node.id) }
              }}
              style={{ width:'100%', height:'100%', background:'#1e1e3a', border:'none', outline:'1px solid #5b6af0', borderRadius:4, color:'#fff', textAlign:'center', fontSize: fontSize-1, padding:'2px 4px', boxSizing:'border-box', resize:'none', fontFamily:'inherit', overflow:'hidden' }}
            ></textarea>
          </foreignObject>
        )
      })()}

      {/* Paragraph-width handle — drag to pin the wrap width while editing text (rect/roundrect only).
          Double-click resets to auto-fit width. */}
      {editing && isAutoSized && (
        <g transform={`translate(${halfW},0)`}
          onMouseDown={e => { e.stopPropagation(); onSetLabelWidth?.(e, node.id) }}
          onDoubleClick={e => { e.stopPropagation(); onResetLabelWidth?.(node.id) }}
          style={{ cursor: 'ew-resize' }}>
          <rect x={-4} y={-14} width={8} height={28} rx={3} fill="#5b6af0" stroke="#fff" strokeWidth={1} />
          <line x1={0} y1={-6} x2={0} y2={6} stroke="#fff" strokeWidth={1} opacity={0.6} />
        </g>
      )}

      {/* Double-click to edit â€" for 3D nodes also cover caption area below */}
      <ellipse rx={bodyHalfW} ry={bodyHalfH} fill="transparent"
        onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true); requestAnimationFrame(() => inputRef.current?.select()) }}
        style={{ cursor: 'move' }}
      />
      {shape === '3d' && (
        <rect x={-halfW} y={halfH + 4} width={halfW * 2} height={22} fill="transparent"
          onDoubleClick={e => { e.stopPropagation(); setDraft(node.label); setEditing(true); requestAnimationFrame(() => inputRef.current?.select()) }}
          style={{ cursor: 'text' }}
        />
      )}

      {/* Connector handle â€" hover only. Large transparent circle as hit target to bridge gap from node edge. */}
      {isHovered && (
        <g onMouseDown={e => { e.stopPropagation(); onConnectorMouseDown(e, node.id) }}
          onMouseEnter={onMouseEnter} style={{ cursor: 'crosshair' }}>
          <circle cx={bodyHalfW + 7} cy={0} r={14} fill="transparent" />
          <circle cx={bodyHalfW + 7} cy={0} r={5} fill="#5b6af0" stroke="#0c0c1a" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
        </g>
      )}

      {/* Scale handle â€" hover only. Large transparent hit area for easier grabbing. */}
      {isHovered && (
        <g transform={`translate(${bodyHalfW},${bodyHalfH})`}
          onMouseDown={e => { e.stopPropagation(); onScaleMouseDown(e, node.id, scale) }}
          onMouseEnter={onMouseEnter}
          style={{ cursor: 'nwse-resize' }}>
          <circle r={14} fill="transparent" />
          <circle r={6} fill="#0c0c1a" stroke="#5b6af0" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
          <line x1={-3} y1={-3} x2={3} y2={3} stroke="#5b6af0" strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
          <line x1={0} y1={-3} x2={3} y2={0} stroke="#5b6af0" strokeWidth={1} style={{ pointerEvents: 'none' }} />
        </g>
      )}

    </g>
  )
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

// â"€â"€â"€ NodeToolbar â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetStrokeColor, onSetStrokeWidth, onSetBorderBlur, onSetOpacity, onSetShape, onDrill, onHide, onRelease, onDelete, onNotesChange, isAnchored, onRadiate, onSetMotion, onSetColorCycle, onAddEmoji, onRemoveEmojiById, customEmojis, onAddCustomEmoji, onRemoveCustomEmoji, onAddNodeImage, onSetNodeImagePosition, onRemoveNodeImageById, onMouseEnter, onMouseLeave, onWheel , imageUrl, onSetImageUrl }) {
  const shape = viewProps.shape || 'circle'
  const [panel, setPanel] = useState(null) // null | 'color' | 'shape' | 'note' | 'radiate' | 'motion' | 'emoji' | 'image'
  const [notesDraft, setNotesDraft] = useState(notes)
  const [emojiInput, setEmojiInput] = useState('')
  const [emojiSearch, setEmojiSearch] = useState('')
  const [emojiCategory, setEmojiCategory] = useState(0)
  const [colorPopup, setColorPopup] = useState(null) // 'fill' | 'text' | null

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

  const shapeIcons = { circle:'○', ellipse:'⬭', roundrect:'▭', rect:'□', diamond:'◇', none:'╌', '3d':'⬡' }

  const wrap = {
    position:'absolute', left: x, top: y, transform:'translateX(-50%)',
    background:'#16162a', border:'1px solid #2d3a6a', borderRadius:8,
    padding:'6px 8px', minWidth: panel ? 230 : undefined,
    boxShadow:'0 4px 20px rgba(0,0,0,0.6)', zIndex:20, pointerEvents:'all',
  }

  const iconBtn = (active) => ({
    background: active ? '#2d3a6a' : 'transparent',
    border: `1px solid ${active ? '#5b6af0' : '#2a3358'}`,
    color: active ? '#c5d0ff' : '#7080a0',
    borderRadius:5, cursor:'pointer', fontSize:'1rem', padding:'4px 7px', lineHeight:1,
  })

  const backBtn = {
    background:'transparent', border:'none', color:'#556', cursor:'pointer',
    fontSize:'0.78rem', padding:'0 4px 0 0', lineHeight:1,
  }

  const divider = <div style={{ width:1, background:'#2a3358', alignSelf:'stretch', margin:'0 2px' }} />

  return (
    <div style={wrap}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
    >
      {/* â"€â"€ Main icon row â"€â"€ */}
      {panel === null && (
        <div style={{ display:'flex', gap:4, alignItems:'center' }}>
          <button style={iconBtn(false)} title="Color" onClick={() => setPanel('color')}>🎨</button>
          <button style={iconBtn(false)} title="Shape" onClick={() => setPanel('shape')}>◯</button>
          {shape === 'image' && <button style={iconBtn(false)} title="Set image URL" onClick={() => setPanel('imageUrl')}>🖼</button>}
          {divider}
          <button style={iconBtn(false)} title="Show/hide" onClick={onHide}>👁</button>
          <button style={iconBtn(false)} title="Drill" onClick={onDrill}>⊕</button>
          <button style={iconBtn(false)} title="Note" onClick={() => setPanel('note')}>✎</button>
          <button style={iconBtn(!!viewProps.nodeMotion || !!viewProps.nodeColorCycle)} title="Motion & color cycle" onClick={() => setPanel('motion')}>✦</button>
          <button style={iconBtn(false)} title="Radiate to children" onClick={() => setPanel('radiate')}>❋</button>
          {isAnchored && <button style={{ ...iconBtn(false), color:'#f6ad55' }} title="Release anchor" onClick={onRelease}>⊙</button>}
          <button style={iconBtn(panel === 'emoji')} title="Emoji" onClick={() => setPanel(panel === 'emoji' ? null : 'emoji')}>😊</button>
          <button style={iconBtn(panel === 'image' || (viewProps.nodeImages || []).length > 0)} title="Image" onClick={() => setPanel(panel === 'image' ? null : 'image')}>🖼️</button>
          {divider}
          <button style={{ ...iconBtn(false), color:'#f87171' }} title="Delete" onClick={onDelete}>✕</button>
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
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>FILL</div>
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
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>OUTLINE</div>
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
              <span style={{ fontSize:'0.6rem', color:'#778', letterSpacing:'0.05em' }}>WIDTH</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetStrokeWidth(Math.max(0, ((viewProps.strokeWidth||0)-0.5)))}>-</button>
              <span style={{ fontSize:'0.7rem', color:'#88b4e8', width:22, textAlign:'center' }}>{(viewProps.strokeWidth||0).toFixed(1)}</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetStrokeWidth(Math.min(8, ((viewProps.strokeWidth||0)+0.5)))}>+</button>
              {(viewProps.strokeColor || viewProps.strokeWidth) && <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:10 }} onClick={() => { onSetStrokeColor(null); onSetStrokeWidth(0) }}>x</button>}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>GLOW</div>
            <div style={{ display:'flex', gap:5, alignItems:'center' }}>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetBorderBlur(Math.max(0, ((viewProps.borderBlur||0)-1)))}>-</button>
              <span style={{ fontSize:'0.7rem', color: (viewProps.borderBlur||0) > 0 ? '#88b4e8' : '#445', width:18, textAlign:'center' }}>{(viewProps.borderBlur||0)}</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetBorderBlur(Math.min(14, ((viewProps.borderBlur||0)+1)))}>+</button>
              {(viewProps.borderBlur||0) > 0 && <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:10 }} onClick={() => onSetBorderBlur(0)}>x</button>}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>OPACITY</div>
            <div style={{ display:'flex', gap:5, alignItems:'center' }}>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetOpacity(Math.max(0.05, +((viewProps.opacity??1)-0.1).toFixed(2)))}>-</button>
              <span style={{ fontSize:'0.7rem', color:'#88b4e8', width:32, textAlign:'center' }}>{Math.round((viewProps.opacity??1)*100)}%</span>
              <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:11 }} onClick={() => onSetOpacity(Math.min(1, +((viewProps.opacity??1)+0.1).toFixed(2)))}>+</button>
              {(viewProps.opacity??1) < 1 && <button style={{ padding:'1px 5px', borderRadius:3, border:'1px solid #2a3358', background:'transparent', color:'#f87171', cursor:'pointer', fontSize:10 }} onClick={() => onSetOpacity(1)}>x</button>}
            </div>
          </div>
          <div>
            <div style={{ fontSize:'0.65rem', color:'#445', marginBottom:4, letterSpacing:'0.05em' }}>TEXT</div>
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
                color: shape===s ? '#fff' : '#778',
                borderRadius:5, cursor:'pointer', fontSize:'1.1rem', padding:'5px 4px', lineHeight:1,
                display:'flex', flexDirection:'column', alignItems:'center', gap:2,
              }}>
                <span>{shapeIcons[s]}</span>
                <span style={{ fontSize:'0.58rem', color: shape===s ? '#aac' : '#445' }}>{s}</span>
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

      {/* â"€â"€ Emoji panel â"€â"€ */}
      {panel === 'emoji' && (() => {
        const curEmojis = viewProps.nodeEmojis || []
        const search = emojiSearch.trim().toLowerCase()
        const shownEmojis = search
          ? EMOJI_CATALOG.flatMap(([, list]) => list).filter(e => e.includes(search))
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
                      color: emojiCategory === i ? '#c5d0ff' : '#667',
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
                <span style={{ fontSize:'0.7rem', color:'#445', padding:'4px 0' }}>No matches</span>
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
                <span style={{ fontSize:'0.65rem', color:'#445', letterSpacing:'0.05em' }}>CUSTOM</span>
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
          ['above', 'Above'], ['below', 'Below'], ['beside', 'Beside'], ['perimeter', 'Perimeter'],
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
            <span style={{ fontSize:'0.62rem', color:'#445', textAlign:'center' }}>or paste an image (Ctrl+V)</span>

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
                            color: (im.position || 'above') === val ? '#c5d0ff' : '#667',
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
          {[['color','Radiate fill color'],['shape','Radiate shape'],['both','Radiate color + shape']].map(([what, label]) => (
            <button key={what} onClick={() => { onRadiate(what); setPanel(null) }}
              style={{ background:'transparent', border:'1px solid #2a3358', color:'#c5d0ff', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', padding:'5px 8px', textAlign:'left' }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* â"€â"€ Motion panel â"€â"€ */}
      {panel === 'motion' && (() => {
        const motion = viewProps.nodeMotion
        const colorCycle = viewProps.nodeColorCycle || 0
        const numBtn = { background:'transparent', border:'1px solid #2a3358', color:'#88b4e8', borderRadius:4, cursor:'pointer', fontSize:'0.75rem', padding:'2px 6px', lineHeight:1 }
        const motionTypes = [
          [null,'○','off'],['shake','≋','shake'],['circle','◎','circle'],
          ['jerk','⚡','jerk'],['updown','↕','up/dn'],['sideways','↔','side'],['scale','⬡','scale'],
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
                    style={{ background: active?'#2d3a6a':'transparent', border:`1px solid ${active?'#5b6af0':'#2a3358'}`, color: active?'#c5d0ff':'#556', borderRadius:4, cursor:'pointer', padding:'3px 5px', lineHeight:1, display:'flex', flexDirection:'column', alignItems:'center', gap:1 }}
                    onClick={() => onSetMotion(type === null ? null : { type, speed: motion?.speed ?? 1, intensity: motion?.intensity ?? 10 })}>
                    <span style={{ fontSize:'1rem' }}>{icon}</span>
                    <span style={{ fontSize:'0.5rem', color: active?'#aac':'#445' }}>{label}</span>
                  </button>
                )
              })}
            </div>

            {/* Speed / Intensity — only when motion active */}
            {motion && (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ fontSize:'0.6rem', color:'#445', width:32, letterSpacing:'0.04em' }}>SPEED</span>
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
                    <span style={{ fontSize:'0.6rem', color:'#445', width:32, letterSpacing:'0.04em' }}>{lbl}</span>
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
              <span style={{ fontSize:'0.65rem', color:'#556', flex:1 }}>Color cycle</span>
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
const sideToolBtnStyle = { padding:'0.3rem 0.6rem', borderRadius:5, border:'1px solid #2a3358', background:'transparent', color:'#7b8fcc', cursor:'pointer', fontSize:'0.76rem', fontWeight:600, whiteSpace:'nowrap' }
const topBtnStyle = { padding:'0.3rem 0.8rem', borderRadius:6, border:'1px solid #2d3a6a', background:'rgba(18,18,42,0.92)', color:'#7b8fcc', cursor:'pointer', fontSize:'0.78rem', fontWeight:600, backdropFilter:'blur(4px)' }
