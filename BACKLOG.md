# PIM — Backlog & Task Tracker

Source of truth for open work, parked decisions, and a log of what shipped.
Maintained by Claude across sessions; updated after each change. Mirror to Notion on request.

Legend: �片 open · ⏳ waiting on Maxi · 💤 idea/needs decision · ✅ done · ❌ won't do

---

## Open / in progress

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Instagram reels import (link + thumbnail + folders) | ⏳ | Waiting on a sample of the JSON export (2–3 entries) to confirm fields → then ~1–3 days. Folders = frame nodes, thumbnails = image nodes, dbl-click = inline embed. |
| 2 | Persist **undo** across reloads | 💤 | Undo history is in-memory today (clears on refresh). Could persist per-project. |
| 3 | Pin Fracasos + turn off its orbit | 💤 | So it stops drifting off-screen. One-off data tweak. |
| 4 | Round shapes: "grow to a cap, then shrink" | 💤 | Middle ground vs current pure shrink-to-fit, so small circles with lots of text aren't tiny. |
| 5 | Delete backup project "Hot ideas — backup 2026-06-29" | ⏳ | Safety copy from the Fracasos recovery. Delete once you've confirmed all good. |

## Won't do (for now)

| # | Item | Why |
|---|------|-----|
| 6 | Ownership-hijack RLS trigger | Declined — editor-members can rewrite a project's `user_id` (confirmed by testing). Re-open if sharing goes wider. |

---

## Shipped this session (2026-06-29)

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
