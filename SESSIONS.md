# Session Log

Chronological record of work done across devices. Pull before starting, push after finishing.

---

## 2026-06-14
- Fixed zoom behavior bug
- Fixed force spacing bug
- Added compact node toolbar with color sub-popups
- Added drop shadows on nodes and connectors
- Fixed drag-to-child keeping existing links; alt severs other parents
- Documented gotchas in CLAUDE.md session handoff

## 2026-06-15–16
- Migrated pim to dedicated Supabase project (`ikztpvxfgmhmrcwolwgx`)
- Fixed 3D model data leak: strip base64 from saves, add Storage upload flow
- Added BACKLOG and TODO sections to CLAUDE.md

---

## 2026-06-17
- Added `image` node shape: rounded rectangle, displays image from URL, caption below
- URL input panel in NodeToolbar with live preview, Set/Clear buttons
- Auto-sets transparent fill when switching to image shape
- `setImageUrl` action in graphStore (view-independent, stored on node)
- Restored drop shadows (node + edge) — recovered from old commits (ad511b4, 7b2a08f)
- Restored transparent fill swatch in color palette
- Added depth/expand slider: BFS from focal node, undirected, auto-zooms on change
- Merged other device's push: COLOR_PALETTE (36 colors), customEmojis per-view
- Added BACKLOG items from Notion: quick capture, AI assistant, rewards, emotional weight, outline slider
- Added competitive analysis and monetization notes to CLAUDE.md

## Next up
- [ ] Verify emojis (customEmojis) and in-node image fully restored after merge
- [ ] Investigate 3D node jerkiness during pan/zoom
- [ ] Test project rename on live site
- [ ] Node search / spotlight (Cmd+K) — ~half day
- [ ] Notion-style tags + status on nodes — ~1 day
