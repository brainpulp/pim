# PIM — Miro Image Epic: Design Spec

**Date:** 2026-06-18  
**Status:** Approved by user (all 7 sections)  
**Scope:** Free-floating canvas images (`view.images[]`) only — not node-attached images (`nodeImages`). This is a v1 spec; node-image multi-select and Pinterest live integration are explicitly out of scope.

---

## Section 1 — Data Model

### Changes to `view.images[]` entries

Add one new field per image object:

```js
{
  id: string,          // existing
  url: string,         // existing
  x: number,           // existing
  y: number,           // existing
  width: number,       // existing
  height: number,      // existing
  groupId: string | null   // NEW — shared UUID for images in the same group; null = ungrouped
}
```

### New local React state (not persisted)

```js
const [selectedImageIds, setSelectedImageIds] = useState(new Set())
```

Selection is ephemeral UI state — no reason to persist it to Supabase.

### New store actions (`graphStore.js`)

```js
groupImages(imageIds)      // assign a shared new UUID as groupId to all listed images
ungroupImages(groupId)     // set groupId = null for all images with matching groupId
```

---

## Section 2 — Selection Interaction

| Gesture | Result |
|---|---|
| Click ungrouped image | Select that image only |
| Click grouped image | Select all images sharing its groupId |
| Shift/Ctrl+Click | Toggle image (or its whole group) in/out of selection |
| Double-click grouped image | Drill into that single member (select just it, ignoring group) |
| Drag on empty canvas | Rubber-band rect select — select all images whose bounding box intersects the drag rect |
| Ctrl+A | Select all visible images |
| Click empty canvas | Clear selection |
| Escape | Clear selection / cancel rubber-band in progress |

**Rubber-band implementation notes:**
- Track `dragStart` and `dragCurrent` on `onMouseDown` / `onMouseMove` on the canvas layer (below images)
- Render a semi-transparent rect overlay during drag
- On `onMouseUp`: compute intersection with each image's bounding box, apply group-expansion rules (if any member of a group intersects, select the whole group)

---

## Section 3 — Batch Operations

All operations apply to all images in `selectedImageIds`.

### Move
- `onMouseDown` on any selected image begins a move for all selected images
- Apply the same `(dx, dy)` delta to every selected image's `(x, y)`
- Single undo entry (one `setImages` call in the store)

### Delete
- One confirmation dialog: "Delete N images?" — regardless of count
- Single store action removing all selected ids

### Resize
- Single bounding-box handle rendered around the combined selection rect
- Corner drag scales all images uniformly by the same factor (preserves each image's individual aspect ratio)
- Formula: `newWidth = img.width * scaleFactor`, `newHeight = img.height * scaleFactor` where `scaleFactor = newBBoxDim / oldBBoxDim`

### Align / Distribute
- Floating toolbar with 8 buttons: align-left, align-center-H, align-right, align-top, align-middle-V, align-bottom, distribute-H, distribute-V
- Aligns relative to the combined bounding box edges/center
- Only shown when 2+ images are selected

---

## Section 4 — Grouping

- **Ctrl+G**: group all selected images under a shared new UUID `groupId`
- **Ctrl+Shift+G**: ungroup — set `groupId = null` for all selected images
- **Flat model only**: no nested groups in v1
- **Visual indicator**: dashed `#5b6af0` bounding box rendered around grouped selection
- **Re-grouping mixed selection**: if selected images span multiple existing groups, Ctrl+G dissolves all existing groupIds and assigns one new one (matches Figma/Illustrator behavior — no warning dialog)
- **Group/Ungroup buttons**: disabled (not hidden) when the action is not applicable (fewer than 2 selected for Group; selection is not a single group for Ungroup)

**Persistence**: `groupId` is stored in `view.images[]` in Supabase, so groups survive page reload and are visible across browser tabs.

---

## Section 5 — Image Selection Toolbar UI

A floating HTML overlay (same pattern as `NodeToolbar` — `position:absolute`, `zIndex:20`) appears above the canvas when 1+ images are selected. It disappears when selection is cleared.

### Toolbar contents (left to right)

| Control | When shown | Action |
|---|---|---|
| Layer ▲ / Layer ▼ | Always | Move selected images forward/back in z-order (reorder within `view.images[]` array) |
| Group | 2+ selected | Ctrl+G equivalent |
| Ungroup | Selection is a single group | Ctrl+Shift+G equivalent |
| Align L / C / R / T / M / B | 2+ selected | Align operations |
| Distribute H / V | 3+ selected | Distribute operations |
| Crop | Exactly 1 selected | Enter single-image crop mode |
| Delete | Always | Delete selected with confirm |

### Positioning
- Centered horizontally above the combined bounding box of the selection
- Stays in canvas-coordinate space (updates as images are moved)

---

## Section 6 — Error Handling & Edge Cases

- **Partial group deletion**: deleting some (not all) group members is allowed — no cleanup needed, `groupId` is just a shared string with no separate entity
- **Re-grouping**: selecting members of two different groups and pressing Ctrl+G silently replaces both `groupId`s — no data loss, the images remain
- **Resize together**: scale factor is uniform (`scaleFactor = newDim / oldDim`) applied independently to each image's width and height, so individual aspect ratios are always preserved
- **Group/Ungroup button states**: disabled (not hidden) when inapplicable, to make the affordance discoverable without allowing accidental no-ops

---

## Section 7 — Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Click image | Select (or whole group if grouped) |
| Shift/Ctrl+Click | Toggle in/out of selection |
| Double-click grouped | Drill into single member |
| Drag on empty canvas | Rubber-band rect select |
| Ctrl+A | Select all visible images |
| Click empty canvas | Clear selection |
| Delete / Backspace | Delete selected (confirm dialog if 2+) |
| Ctrl+G | Group selected |
| Ctrl+Shift+G | Ungroup selected |
| Escape | Clear selection / cancel rubber-band |

No conflicts with existing PIM node-layer shortcuts (Ctrl+Z undo, node drag, etc.).

---

## Out of Scope (v1)

- Node-attached image (`nodeImages`) multi-select
- Pinterest live integration / scraping
- Nested groups
- Multi-device collaborative editing (real-time sync)
- ANN indexing for similarity

---

## Testing Approach

Manual verification on the live GitHub Pages deployment (`brainpulp.github.io/pim`) after implementation:

1. Rubber-band select (various rect sizes, partial overlaps, group expansion)
2. Shift-click toggle add/remove, Ctrl+A
3. Move, delete, resize together with 2–3+ images selected
4. Align and distribute with mixed selection
5. Group → click any member selects whole group → double-click drills into one → Ungroup restores individual selection
6. **Persistence check**: group images, reload page, verify group membership survives (Supabase-backed)
7. **Cross-tab check**: group in one tab, open another tab, confirm group is visible
