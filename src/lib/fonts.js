// Google Fonts catalog + on-demand loader, shared by node labels and text boxes.
//
// We can't ship all ~1500 Google families as bundled font files (that would be hundreds of MB), and the
// Google Fonts metadata API needs an API key. Instead we keep a large, curated catalog of family names +
// their Google category, and load each family's CSS on demand from the keyless Google Fonts CSS API the
// first time it's shown or used. That gives a Google-Fonts-style browse/filter experience with a tiny
// bundle cost. The list is easy to extend — just add `[name, cat]` rows.
//
// Categories mirror the Google Fonts site: sans-serif, serif, display, handwriting, monospace.

export const FONT_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'sans-serif', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'display', label: 'Display' },
  { id: 'handwriting', label: 'Handwriting' },
  { id: 'monospace', label: 'Mono' },
]

// Generic fallback stack per category, appended after the chosen family so text stays readable while the
// web font is still loading (or if it fails).
const FALLBACK = {
  'sans-serif': 'system-ui, -apple-system, sans-serif',
  'serif': 'Georgia, "Times New Roman", serif',
  'display': 'system-ui, sans-serif',
  'handwriting': 'cursive',
  'monospace': 'ui-monospace, "Courier New", monospace',
}

// [family, category]. Compact on purpose. Keep names EXACTLY as Google spells them (the CSS API is
// case- and space-sensitive; spaces become "+").
const RAW = [
  // ── Sans-serif ──
  ['Roboto', 'sans-serif'], ['Open Sans', 'sans-serif'], ['Lato', 'sans-serif'], ['Montserrat', 'sans-serif'],
  ['Inter', 'sans-serif'], ['Poppins', 'sans-serif'], ['Raleway', 'sans-serif'], ['Nunito', 'sans-serif'],
  ['Nunito Sans', 'sans-serif'], ['Work Sans', 'sans-serif'], ['DM Sans', 'sans-serif'], ['Rubik', 'sans-serif'],
  ['Mulish', 'sans-serif'], ['Karla', 'sans-serif'], ['Manrope', 'sans-serif'], ['Barlow', 'sans-serif'],
  ['Barlow Condensed', 'sans-serif'], ['Oswald', 'sans-serif'], ['Source Sans 3', 'sans-serif'],
  ['PT Sans', 'sans-serif'], ['Noto Sans', 'sans-serif'], ['Fira Sans', 'sans-serif'], ['Cabin', 'sans-serif'],
  ['Quicksand', 'sans-serif'], ['Josefin Sans', 'sans-serif'], ['Hind', 'sans-serif'], ['Titillium Web', 'sans-serif'],
  ['Heebo', 'sans-serif'], ['Assistant', 'sans-serif'], ['Space Grotesk', 'sans-serif'], ['Public Sans', 'sans-serif'],
  ['Figtree', 'sans-serif'], ['Plus Jakarta Sans', 'sans-serif'], ['Lexend', 'sans-serif'], ['Outfit', 'sans-serif'],
  ['Sora', 'sans-serif'], ['Albert Sans', 'sans-serif'], ['Onest', 'sans-serif'], ['Schibsted Grotesk', 'sans-serif'],
  ['Kanit', 'sans-serif'], ['Prompt', 'sans-serif'], ['Signika', 'sans-serif'], ['Ubuntu', 'sans-serif'],
  ['Dosis', 'sans-serif'], ['Comfortaa', 'sans-serif'], ['Jost', 'sans-serif'], ['Overpass', 'sans-serif'],
  ['Exo 2', 'sans-serif'], ['Chivo', 'sans-serif'], ['Red Hat Display', 'sans-serif'], ['Epilogue', 'sans-serif'],
  ['Urbanist', 'sans-serif'], ['Be Vietnam Pro', 'sans-serif'], ['Mukta', 'sans-serif'], ['Cairo', 'sans-serif'],
  ['Tajawal', 'sans-serif'], ['IBM Plex Sans', 'sans-serif'], ['Archivo', 'sans-serif'], ['Archivo Narrow', 'sans-serif'],
  ['Saira', 'sans-serif'], ['Saira Condensed', 'sans-serif'], ['Maven Pro', 'sans-serif'], ['Asap', 'sans-serif'],
  ['Catamaran', 'sans-serif'], ['Encode Sans', 'sans-serif'], ['Libre Franklin', 'sans-serif'], ['Hanken Grotesk', 'sans-serif'],
  ['Instrument Sans', 'sans-serif'], ['Geist', 'sans-serif'], ['Bricolage Grotesque', 'sans-serif'], ['Familjen Grotesk', 'sans-serif'],
  ['Anek Latin', 'sans-serif'], ['Gantari', 'sans-serif'], ['League Spartan', 'sans-serif'], ['Spline Sans', 'sans-serif'],
  ['Darker Grotesque', 'sans-serif'], ['Antonio', 'sans-serif'], ['Fjalla One', 'sans-serif'], ['PT Sans Narrow', 'sans-serif'],
  ['Roboto Condensed', 'sans-serif'], ['Roboto Flex', 'sans-serif'], ['Noto Sans Display', 'sans-serif'],

  // ── Serif ──
  ['Playfair Display', 'serif'], ['Merriweather', 'serif'], ['Lora', 'serif'], ['PT Serif', 'serif'],
  ['Noto Serif', 'serif'], ['Roboto Slab', 'serif'], ['Bitter', 'serif'], ['Source Serif 4', 'serif'],
  ['Crimson Text', 'serif'], ['Crimson Pro', 'serif'], ['EB Garamond', 'serif'], ['Cormorant Garamond', 'serif'],
  ['Cormorant', 'serif'], ['Libre Baskerville', 'serif'], ['Libre Caslon Text', 'serif'], ['Spectral', 'serif'],
  ['Domine', 'serif'], ['Zilla Slab', 'serif'], ['Frank Ruhl Libre', 'serif'], ['Vollkorn', 'serif'],
  ['Cardo', 'serif'], ['Alegreya', 'serif'], ['Bree Serif', 'serif'], ['Arvo', 'serif'],
  ['Slabo 27px', 'serif'], ['Josefin Slab', 'serif'], ['Noticia Text', 'serif'], ['Rokkitt', 'serif'],
  ['Neuton', 'serif'], ['Gelasio', 'serif'], ['Bodoni Moda', 'serif'], ['DM Serif Display', 'serif'],
  ['DM Serif Text', 'serif'], ['Fraunces', 'serif'], ['Newsreader', 'serif'], ['Petrona', 'serif'],
  ['Literata', 'serif'], ['Piazzolla', 'serif'], ['Instrument Serif', 'serif'], ['Marcellus', 'serif'],
  ['Cinzel', 'serif'], ['Prata', 'serif'], ['IBM Plex Serif', 'serif'], ['Old Standard TT', 'serif'],
  ['Sorts Mill Goudy', 'serif'], ['Tinos', 'serif'], ['Gentium Book Plus', 'serif'], ['Faustina', 'serif'],

  // ── Display ──
  ['Bebas Neue', 'display'], ['Anton', 'display'], ['Righteous', 'display'], ['Abril Fatface', 'display'],
  ['Archivo Black', 'display'], ['Alfa Slab One', 'display'], ['Passion One', 'display'], ['Bungee', 'display'],
  ['Bungee Shade', 'display'], ['Titan One', 'display'], ['Fredoka', 'display'], ['Baloo 2', 'display'],
  ['Lilita One', 'display'], ['Luckiest Guy', 'display'], ['Bangers', 'display'], ['Fugaz One', 'display'],
  ['Staatliches', 'display'], ['Teko', 'display'], ['Russo One', 'display'], ['Black Ops One', 'display'],
  ['Monoton', 'display'], ['Bowlby One SC', 'display'], ['Ultra', 'display'], ['Rowdies', 'display'],
  ['Chewy', 'display'], ['Sigmar One', 'display'], ['Fjord One', 'display'], ['Yeseva One', 'display'],
  ['Concert One', 'display'], ['Paytone One', 'display'], ['Changa One', 'display'], ['Shrikhand', 'display'],
  ['Chango', 'display'], ['Bevan', 'display'], ['Bungee Inline', 'display'], ['Modak', 'display'],
  ['Gluten', 'display'], ['Climate Crisis', 'display'], ['Rampart One', 'display'], ['Silkscreen', 'display'],
  ['Press Start 2P', 'display'], ['Pirata One', 'display'], ['Creepster', 'display'], ['Faster One', 'display'],
  ['Nabla', 'display'], ['Honk', 'display'], ['Sixtyfour', 'display'], ['Playfair Display SC', 'display'],

  // ── Handwriting ──
  ['Pacifico', 'handwriting'], ['Caveat', 'handwriting'], ['Dancing Script', 'handwriting'], ['Lobster', 'handwriting'],
  ['Satisfy', 'handwriting'], ['Great Vibes', 'handwriting'], ['Sacramento', 'handwriting'], ['Shadows Into Light', 'handwriting'],
  ['Permanent Marker', 'handwriting'], ['Indie Flower', 'handwriting'], ['Amatic SC', 'handwriting'], ['Kalam', 'handwriting'],
  ['Patrick Hand', 'handwriting'], ['Gloria Hallelujah', 'handwriting'], ['Architects Daughter', 'handwriting'],
  ['Courgette', 'handwriting'], ['Cookie', 'handwriting'], ['Handlee', 'handwriting'], ['Yellowtail', 'handwriting'],
  ['Kaushan Script', 'handwriting'], ['Marck Script', 'handwriting'], ['Pinyon Script', 'handwriting'],
  ['Allura', 'handwriting'], ['Parisienne', 'handwriting'], ['Homemade Apple', 'handwriting'], ['Rock Salt', 'handwriting'],
  ['Reenie Beanie', 'handwriting'], ['Nanum Pen Script', 'handwriting'], ['Gochi Hand', 'handwriting'],
  ['Covered By Your Grace', 'handwriting'], ['Damion', 'handwriting'], ['Tangerine', 'handwriting'],
  ['Bad Script', 'handwriting'], ['Cedarville Cursive', 'handwriting'], ['Alex Brush', 'handwriting'],
  ['Merienda', 'handwriting'], ['Petit Formal Script', 'handwriting'], ['Mrs Saint Delafield', 'handwriting'],
  ['Caveat Brush', 'handwriting'], ['Neucha', 'handwriting'], ['Shantell Sans', 'handwriting'], ['Grape Nuts', 'handwriting'],

  // ── Monospace ──
  ['Roboto Mono', 'monospace'], ['JetBrains Mono', 'monospace'], ['Source Code Pro', 'monospace'],
  ['Fira Code', 'monospace'], ['IBM Plex Mono', 'monospace'], ['Space Mono', 'monospace'], ['Inconsolata', 'monospace'],
  ['Ubuntu Mono', 'monospace'], ['PT Mono', 'monospace'], ['Cousine', 'monospace'], ['Overpass Mono', 'monospace'],
  ['DM Mono', 'monospace'], ['Red Hat Mono', 'monospace'], ['Martian Mono', 'monospace'], ['Spline Sans Mono', 'monospace'],
  ['Azeret Mono', 'monospace'], ['Fragment Mono', 'monospace'], ['Geist Mono', 'monospace'], ['Noto Sans Mono', 'monospace'],
  ['Anonymous Pro', 'monospace'], ['VT323', 'monospace'], ['Nova Mono', 'monospace'], ['Share Tech Mono', 'monospace'],
]

// The bundled fallback catalog (used offline / before the live catalog loads / if the fetch fails).
export const BUNDLED_FONTS = RAW.map(([family, category]) => ({ family, category }))

// Mutable maps, seeded from the bundled list and REPLACED/extended when the live catalog loads.
const CAT_BY_FAMILY = Object.fromEntries(RAW.map(([f, c]) => [f, c]))
const WEIGHTS_BY_FAMILY = {}   // family -> sorted numeric weights the font actually ships (from the live catalog)

// The current catalog the UI should show: live once fetched, else bundled. Read via getCatalog().
let CATALOG = BUNDLED_FONTS
const catalogSubs = new Set()
export function getCatalog() { return CATALOG }
export function isLiveCatalog() { return CATALOG !== BUNDLED_FONTS }
export function subscribeCatalog(cb) { catalogSubs.add(cb); return () => catalogSubs.delete(cb) }

// Numeric weights a font ships (from the live catalog); a sensible default when unknown.
export function weightsFor(family) {
  const w = WEIGHTS_BY_FAMILY[family]
  return (w && w.length) ? w : [400, 700]
}

// GOOGLE_FONTS kept as an alias for the bundled list (back-compat with existing imports).
export const GOOGLE_FONTS = BUNDLED_FONTS

// ── Live catalog (google-webfonts-helper: keyless, CORS-enabled, full Google Fonts list) ──────────────
// Cached in localStorage for a week. On success the whole catalog (family + category + real weights)
// replaces the bundled list and subscribers are notified. Any failure silently keeps the bundled list.
const CACHE_KEY = 'pim_gfonts_catalog_v1'
const CACHE_TTL = 7 * 24 * 3600 * 1000
let liveStarted = false
function ingestLive(list) {
  if (!Array.isArray(list) || !list.length) return
  list.forEach(f => {
    CAT_BY_FAMILY[f.family] = f.category || 'sans-serif'
    if (f.weights && f.weights.length) WEIGHTS_BY_FAMILY[f.family] = f.weights
  })
  CATALOG = list.map(f => ({ family: f.family, category: f.category || 'sans-serif' }))
  catalogSubs.forEach(cb => { try { cb(CATALOG) } catch { /* */ } })
}
function parseGwfh(arr) {
  return arr.map(f => {
    const weights = [...new Set((f.variants || [])
      .filter(v => !/italic/i.test(v))
      .map(v => v === 'regular' ? 400 : parseInt(v, 10))
      .filter(n => !isNaN(n)))].sort((a, b) => a - b)
    return { family: f.family, category: f.category || 'sans-serif', weights: weights.length ? weights : [400] }
  })
}
// Kick off the live load (idempotent). Serves cache immediately if fresh, then/else fetches in the background.
export function ensureLiveCatalog() {
  if (liveStarted) return
  liveStarted = true
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (c && c.t && (Date.now() - c.t) < CACHE_TTL && Array.isArray(c.fonts) && c.fonts.length) { ingestLive(c.fonts); return }
  } catch { /* ignore */ }
  try {
    fetch('https://gwfh.mranftl.com/api/fonts', { mode: 'cors' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)))
      .then(arr => {
        const parsed = parseGwfh(arr)
        if (!parsed.length) return
        ingestLive(parsed)
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), fonts: parsed })) } catch { /* quota */ }
      })
      .catch(() => { /* offline / blocked → keep bundled */ })
  } catch { /* ignore */ }
}

// Build the CSS font-family value for a chosen family (quoted) + a sensible fallback for its category.
export function fontStack(family) {
  if (!family) return null
  const cat = CAT_BY_FAMILY[family] || 'sans-serif'
  return `"${family}", ${FALLBACK[cat] || FALLBACK['sans-serif']}`
}

// Inject the Google Fonts stylesheet for one family (+ weight), once. Keyless CSS API. We only request
// weights the font actually ships (when known) so a single-weight font doesn't 400 the whole request.
const loaded = new Set()
export function loadFont(family, weight) {
  if (!family || !/^[\w .\-&']+$/.test(family)) return
  const key = family + '@' + (weight || '')
  if (loaded.has(key)) return
  loaded.add(key)
  try {
    const avail = WEIGHTS_BY_FAMILY[family]
    let axis = ''
    if (avail && avail.length) {
      const want = [...new Set([400, weight].filter(Boolean).filter(w => avail.includes(w)))]
      const list = want.length ? want : [avail.includes(400) ? 400 : avail[0]]
      axis = ':wght@' + list.sort((a, b) => a - b).join(';')
    } else if (CAT_BY_FAMILY[family]) {
      axis = ':wght@400;500;600;700'   // bundled fonts: assume the common range
    }
    const id = 'gf-' + (family + '-' + (weight || 'x')).replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    if (document.getElementById(id)) return
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    const fam = encodeURIComponent(family).replace(/%20/g, '+')
    link.href = `https://fonts.googleapis.com/css2?family=${fam}${axis}&display=swap`
    document.head.appendChild(link)
  } catch { /* SSR / blocked — the fallback stack still renders */ }
}
