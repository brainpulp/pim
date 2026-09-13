// ── PIM design system ────────────────────────────────────────────────────────────────────────
// One source of truth for colour, spacing, type, radius, shadow, and the shared control styles.
// PIM styles inline, so this exports plain objects/helpers you spread into `style={...}`.
//
// Rules (see .claude/skills/pim-design):
//  • NEVER hard-code a hex, padding, or font-size that a token already covers — use the token.
//  • Text colour: primary = t.tx, secondary = t.tx2, tertiary = t.tx3. Never darker than t.tx3 on
//    a dark surface (the CLAUDE.md contrast rule — #556/#667/#778 etc. are banned for text).
//  • Refine, don't reinvent: this keeps PIM's dark identity, just consistent and legible.

// Colour — a refined, consistent dark palette (kept close to the app's existing look).
export const c = {
  // Surfaces (dark → light as they come forward)
  canvas: '#0b0b16',   // the graph background
  bg:     '#14142b',   // panels / footers / menus
  bg2:    '#1b1b38',   // raised cards, hover, selected row
  bg3:    '#242449',   // pressed / stronger raise
  input:  '#0f0f22',   // form fields
  // Borders / dividers (never used as text colour)
  line:   '#23234a',   // subtle divider
  border: '#2d3a6a',   // default control border
  border2:'#3a4a8a',   // emphasized / focus-ish border
  // Text (all pass contrast on the dark surfaces above)
  tx:     '#dbe4ff',   // primary
  tx2:    '#9aa6d6',   // secondary
  tx3:    '#7c86ad',   // tertiary / hints (the darkest allowed for text)
  // Accent (indigo)
  accent:  '#6470f5',
  accentH: '#7c8cff',
  accentBg:'#232a5c',  // tinted fill behind an accent control
  // Semantic
  ok:     '#34d399', okTx: '#a7f3d0', okBg: '#153726',
  danger: '#f87171', dangerTx: '#f8b4b4', dangerBg: '#3a1c28',
  warn:   '#ffb454', warnTx: '#ffcf8a', warnBg: '#3a2c10',
}

// Spacing scale (px). Use these, not arbitrary numbers.
export const sp = { 0: 0, 1: 2, 2: 4, 3: 6, 4: 8, 5: 12, 6: 16, 7: 20, 8: 24, 9: 32 }

// Radius scale (px).
export const r = { sm: 5, md: 7, lg: 10, xl: 14, pill: 999 }

// Type scale (px) + weights + the app font stack.
export const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
export const fs = { xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 20, xxl: 26 }
export const fw = { normal: 400, medium: 600, bold: 700 }

// Elevation.
export const shadow = {
  sm: '0 2px 8px rgba(0,0,0,0.35)',
  md: '0 8px 28px rgba(0,0,0,0.45)',
  lg: '0 18px 50px rgba(0,0,0,0.55)',
  panelUp: '0 -10px 40px rgba(0,0,0,0.5)',   // for bottom-docked footers
}

const focusRing = `0 0 0 2px rgba(100,112,245,0.4)`

// ── Shared control styles (spread into inline style) ─────────────────────────────────────────
// Buttons — one place for every variant so they finally match.
export const btn = (variant = 'default', extra = {}) => {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: sp[3],
    fontFamily: font, fontSize: fs.sm, fontWeight: fw.medium, lineHeight: 1.4,
    padding: `${sp[3]}px ${sp[5]}px`, borderRadius: r.md, cursor: 'pointer',
    border: '1px solid transparent', whiteSpace: 'nowrap', transition: 'background .12s, border-color .12s',
  }
  const variants = {
    primary: { background: c.accent, borderColor: c.accentH, color: '#fff', fontWeight: fw.bold },
    default: { background: c.bg2, borderColor: c.border, color: c.tx },
    ghost:   { background: 'transparent', borderColor: c.border, color: c.tx2 },
    subtle:  { background: 'transparent', borderColor: 'transparent', color: c.tx2 },
    danger:  { background: 'transparent', borderColor: c.dangerBg, color: c.danger },
    ok:      { background: c.okBg, borderColor: '#2f6a48', color: c.okTx, fontWeight: fw.bold },
  }
  return { ...base, ...(variants[variant] || variants.default), ...extra }
}

// Form input / select.
export const input = (extra = {}) => ({
  background: c.input, border: `1px solid ${c.border}`, borderRadius: r.md,
  color: c.tx, fontFamily: font, fontSize: fs.sm, padding: `${sp[3]}px ${sp[4]}px`,
  outline: 'none', ...extra,
})

// A floating surface: menu / popover / panel.
export const panel = (extra = {}) => ({
  background: c.bg, border: `1px solid ${c.border}`, borderRadius: r.xl,
  boxShadow: shadow.md, fontFamily: font, color: c.tx, ...extra,
})

// A menu row (text menu item). Hover handled by the caller (onMouseEnter/Leave → c.bg2).
export const menuItem = (extra = {}) => ({
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: sp[6],
  padding: `${sp[3]}px ${sp[5]}px`, borderRadius: r.sm, cursor: 'pointer',
  fontSize: fs.sm, color: c.tx, whiteSpace: 'nowrap', ...extra,
})

// A small labelled chip / pill.
export const chip = (extra = {}) => ({
  display: 'inline-flex', alignItems: 'center', gap: sp[2],
  padding: `${sp[1]}px ${sp[4]}px`, borderRadius: r.pill, fontSize: fs.xs,
  background: c.bg2, border: `1px solid ${c.border}`, color: c.tx2, ...extra,
})

// Perceived luminance (0..1) of a #rgb/#rrggbb colour. >0.5 = light.
export function luminance(hex) {
  if (!hex || typeof hex !== 'string') return 0
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(x => x + x).join('')
  if (h.length !== 6) return 0
  const rr = parseInt(h.slice(0, 2), 16) / 255
  const gg = parseInt(h.slice(2, 4), 16) / 255
  const bb = parseInt(h.slice(4, 6), 16) / 255
  return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb   // Rec. 709 luma
}

// Frame rectangles: NO border line — only a soft drop shadow whose colour reacts to the ground behind
// the frame (a light shadow on a dark background, a dark shadow on a light one). `ground` is the colour
// behind the frame (the frame's own fill if opaque, else the view/canvas bg).
export function frameShadow(ground = c.canvas, { strength = 1 } = {}) {
  const light = luminance(ground) > 0.5           // light background → cast a dark shadow, and vice-versa
  const rgb = light ? '0,0,0' : '255,255,255'
  const a = light ? 0.22 * strength : 0.10 * strength
  const a2 = light ? 0.12 * strength : 0.055 * strength
  // A close contact shadow + a larger soft one — reads as depth without any outline.
  return `0 1px 3px rgba(${rgb},${a2}), 0 10px 30px rgba(${rgb},${a})`
}

export const tokens = { c, sp, r, font, fs, fw, shadow, focusRing, luminance, frameShadow }
export default tokens
