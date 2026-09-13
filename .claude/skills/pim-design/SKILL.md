---
name: pim-design
description: PIM's UI design system — apply whenever adding or changing any UI in the PIM app (panels, menus, toolbars, buttons, inputs, cards, the canvas chrome, the slideshow/video editors). Use the tokens and control styles in src/lib/theme.js instead of hand-rolling hex colors, paddings, or font sizes, so the interface stays consistent and legible. Refine the existing dark theme; never regress contrast.
---

# PIM design system

PIM's UI drifted because every panel hand-rolled its own hex colours, paddings and
font sizes. This skill fixes that: one token module (`src/lib/theme.js`) and a small set
of rules. **Refine the current dark look — do not reinvent it.**

## Use the tokens — never hard-code

Import from `src/lib/theme.js` and spread the helpers into inline `style`:

```js
import { c, sp, r, fs, fw, font, shadow, btn, input, panel, menuItem, chip } from '../lib/theme'

<button style={btn('primary')}>Save</button>
<button style={btn('ghost')}>Cancel</button>
<input style={input({ width: 120 })} />
<div style={panel({ padding: sp[5] })}>…</div>
```

- **Colour** → `c.*` (surfaces `canvas/bg/bg2/bg3/input`, `line/border/border2`, text `tx/tx2/tx3`,
  `accent/accentH/accentBg`, semantics `ok/danger/warn` each with `*Tx`/`*Bg`). Never write a raw hex
  that a token already names.
- **Spacing** → `sp[0..9]` (2,4,6,8,12,16,20,24,32). No arbitrary paddings/margins/gaps.
- **Radius** → `r.sm|md|lg|xl|pill`.
- **Type** → `fs.xs..xxl` + `fw.normal|medium|bold`, family `font`.
- **Elevation** → `shadow.sm|md|lg|panelUp`.
- **Controls** → `btn(variant)`, `input()`, `panel()`, `menuItem()`, `chip()`. Add one-off tweaks via
  the `extra` arg, don't fork the base.

## Hard rules (never regress)

1. **Contrast (from CLAUDE.md):** text is `c.tx` / `c.tx2` / `c.tx3` only. Nothing darker than `c.tx3`
   (#7c86ad) as a text/label colour on a dark surface. `#334/#445/#556/#667/#778` are BANNED for text.
2. **One button system.** Every button is `btn(variant)`. Variants: `primary, default, ghost, subtle,
   danger, ok`. No bespoke button styling.
3. **Consistent surfaces.** Panels/menus/popovers use `panel()`; rows use `menuItem()`; fields use
   `input()`. Same radius/shadow everywhere.
4. **Spacing rhythm.** Group gaps and padding come from `sp`. Prefer 8/12/16 for panel padding, 6 for
   row gaps.
5. **Restraint.** Refined dark theme: subtle borders (`c.line` for dividers, `c.border` for controls),
   one accent (`c.accent`). Avoid stacking heavy borders + heavy shadows on the same element.

## Frame nodes — borderless, adaptive shadow

Frame rectangles use **no border line — only a soft shadow whose colour reacts to the background**
(light shadow on a dark ground, dark shadow on a light ground) via `frameShadow(bgHex)` in `theme.js`
usage. Compute from the ground behind the frame (view bg / canvas), not a fixed colour.

## Working method (staged rollout)

The app is large; polish it surface by surface. For each surface: swap hard-coded values for tokens,
unify buttons/inputs/menus, fix spacing rhythm, verify contrast, build + deploy, and check it live
(the user tests on the GitHub Pages URL, not localhost). Keep behaviour identical — this is a visual
pass, not a refactor of logic.
