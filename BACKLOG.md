# PIM — Backlog & Task Tracker

Source of truth for open work, parked decisions, and a log of what shipped.
Maintained by Claude across sessions; updated after each change. Mirror to Notion on request.

Legend: 🟢 open · ⏳ waiting on Maxi · 💤 idea/needs decision · ✅ done · ❌ won't do

---

## Open / in progress

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | In-node image handles don't work | 🟢 | Bug — resize/crop handles on images placed inside a node don't respond. **Next up.** |
| 2 | Instagram reels import (link + thumbnail + folders) | ⏳ | Waiting on a sample of the JSON export (2–3 entries) to confirm fields → then ~1–3 days. Folders = frame nodes, thumbnails = image nodes, dbl-click = inline embed. |
| 3 | Persist **undo** across reloads | 💤 | Undo history is in-memory today (clears on refresh). Could persist per-project. |
| 4 | Pin Fracasos + turn off its orbit | 💤 | So it stops drifting off-screen. One-off data tweak. |
| 5 | Round shapes: "grow to a cap, then shrink" | 💤 | Middle ground vs current pure shrink-to-fit, so small circles with lots of text aren't tiny. |
| 6 | Delete backup project "Hot ideas — backup 2026-06-29" | ⏳ | Safety copy. Now doubly important — it's what restored Hot ideas after the wipe. Keep for now. |
| 7 | Notion-style DB — Phase 2 (per-node property editor on canvas) | ✅ | Done — "Properties" fly-out in NodeToolbar; shared PropertyField component with the Table. |
| 8 | Notion-style DB — Phase 3 (on-canvas chips + filter/sort) | 💤 | Render tags/status as badges under node labels; filter/hide graph nodes by property. |

## Won't do (for now)

| Item | Why |
|------|-----|
| Ownership-hijack RLS trigger | Declined — editor-members can rewrite a project's `user_id` (confirmed by testing). Re-open if sharing goes wider. |

---

## Incident (2026-06-30) — "Hot ideas" blanked, restored

A **failed project load** left the store empty and the autosave wrote that empty doc over the
project (0 nodes). Restored from the 2026-06-29 backup (82 nodes). **Fix shipped:** autosave now
refuses to run unless the project loaded successfully (`loadOkRef` guard). Not caused by feature
work — a latent load/save bug, likely triggered by the flaky Supabase connection.

## Shipped this session (2026-06-30)

- ✅ Two node resize handles: scale-both (corner) vs scale-shape-only (box grows, text reflows).
- ✅ Tooltips on all node handles.
- ✅ Slides: right-click menu (background color, present-from-here, remove).
- ✅ Nav: project title centered; removed redundant outline "+ Root".
- ✅ Reload restores zoom (instant localStorage viewport persistence).
- ✅ Autosave guard so a failed load can't blank a project (see incident).
- ✅ NodeToolbar sub-sections are fly-out submenus (top menu stays; open on hover).
- ✅ Delete handle (red ×) on node hover, top-left.
- ✅ Node handles counter-scale to zoom (clamped 0.4–2.5×) — no longer huge/tiny at extremes.
- ✅ Legibility sweep: replaced banned near-black text greys app-wide; codified the rule in CLAUDE.md.
- ✅ Notion-style DB Phase 0 (per-project property schema: `property_defs` column + store actions + node.props).
- ✅ Notion-style DB Phase 1 (Table view = live grid: typed columns, add/rename/retype/delete, rows, inline options).

## Shipped earlier this session (2026-06-29)

- ✅ Edge blur: feathers all four sides evenly (gradient mask; was a hard line on the short axis).
- ✅ Restored "Fracasos" — was hidden by a collapsed ancestor ("Elementos emocionales del dilema"), not deleted.
- ✅ **Search** spotlight (Cmd/Ctrl+K or `/`): finds nodes; reveals hidden / drilled / collapsed nodes.
- ✅ **Undo** coverage extended (node creation, drag-reparent, drag-into-frame; delete/hide/edge already covered).
- ✅ Node text: double-click selects words while editing (overlay no longer steals clicks).
- ✅ Node text fit: round shapes shrink-to-fit inside the curve; rectangles get a Miro-style right-edge width handle (on selection).
- ✅ **Multi-node delete**: Delete key now works on rubber-band selection (confirm + single undo).
- ✅ **Reload restores zoom/pan** (drill + active view already persisted).

## Security note (sharing)

Editor-members can read+edit a shared project (correct) but can also rewrite its `user_id`
and hijack ownership (confirmed). Fix on file if needed: a `before update` trigger blocking
non-owners from changing `user_id`. Currently **not applied** (per decision above).
