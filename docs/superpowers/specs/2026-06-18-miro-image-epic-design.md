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
// when non-null, this single image is treated as ungrouped for interaction purposes
const [drilledImageId, setDrilledImageId] = useState(null)
```

Both are ephemeral UI state — not persisted to Supabase. `drilledImageId` is cleared whenever the user switches views (view change resets all local interaction state).

### New store actions (`graphStore.js`)

```js
groupImages(imageIds)           // assign a shared new UUID as groupId to all listed images
ungroupImages(imageIds)         // set groupId = null for all images with matching ids
reorderImage(id, direction)     // direction: 'up' = higher index in array = renders on top (SVG paint order); 'down' = lower index = renders beneath
```

### Migration for existing images

Existing `view.images[]` entries in Supabase lack `groupId`. Add a `groupId` column to the Supabase table with a default of `null`. JS-side: treat any image where `groupId === undefined` the same as `groupId === null` (ungrouped).

---

## Section 2 — Selection Interaction

| Gesture | Result |
|---|---|
| Click ungrouped image | Select that image only; clear drilledImageId |
| Click grouped image (not drilled) | Select all images sharing its groupId; clear drilledImageId |
| Click drilled image | Select that single image (drill state already active) |
| Shift/Ctrl+Click | Toggle image (or its whole group) in/out of selection |
| Double-click grouped image | Set drilledImageId to that image; select only that image |
| Drag on empty canvas | Rubber-band rect select (see below); clear drilledImageId |
| Ctrl+A | Select all images in `view.images[]`; clear drilledImageId |
| Click empty canvas | Clear selection and drilledImageId |
| Escape | Clear selection, drilledImageId, and cancel any rubber-band in progress |

**Drill state (`drilledImageId`):** When non-null, the drilled image behaves as if ungrouped for all interactions — clicking it selects only it, dragging moves only it. Clearing selection (click empty canvas, Escape, or clicking a different image/group) also clears drilledImageId.

**Drilled image and move:** Moving a drilled image moves only that image, not its group siblings. Its `groupId` is NOT changed — it stays in the group but is positioned independently. (This matches Figma's "double-click into group to move one member" behavior.)

**Drilled image and toolbar:** Ungroup button shows when drilledImageId is set (the image has a groupId). Group button is disabled (only 1 selected). Crop shows (exactly 1 selected).

**Partial group selection via Shift-click:** Shift-clicking individual members of a group adds only those members (not the whole group) to the selection. This is the only way to get a partial group selection. Ctrl+G on a partial group selection creates a new group from the selected members; any unselected sibling that shared the old groupId retains it (now as a smaller group, unless only 1 remains — in which case that orphan's groupId is cleared to null).

**Rubber-band / pan conflict:** Rubber-band is initiated only when `onMouseDown` fires on the canvas background with no modifier key AND the pointer does not move within a 4px threshold before the first `onMouseMove`. Below the threshold the event is treated as a click (clears selection). Above the threshold it becomes a rubber-band — the D3 zoom/pan handler is disabled for the duration (call `d3zoom.filter` to suppress pan while rubber-band is active).

**Rubber-band implementation notes:**
- Track `dragStart` and `dragCurrent` on `onMouseDown` / `onMouseMove` on the canvas background layer (below images)
- Render a semi-transparent rect overlay during drag (positioned in SVG canvas coordinates, converted to screen coordinates for the HTML overlay)
- On `onMouseUp`: compute intersection of drag rect with each image's bounding box; apply group-expansion (if any member of a group intersects, select the whole group). Exception: if `drilledImageId` is set and it is the intersecting member, select only that image (no group expansion for the drilled image).

**Toolbar position — coordinate conversion:** The toolbar is a `position:absolute` HTML div (same pattern as `NodeToolbar`). Canvas-space image coordinates must be converted to screen space on every render using the D3 zoom transform: `screenX = canvasX * transform.k + transform.x` (and similarly for Y). The toolbar re-renders whenever selection changes or the user pans/zooms. Listen on D3's `zoom.on('zoom', handler)` to trigger a React state update (same `tick` counter pattern used by `AnimatedG`) so the toolbar position stays in sync during pan/zoom.

**Ctrl+A scope:** Selects all images in `view.images[]` regardless of any visibility flags (images don't have a visibility field in v1).

---

## Section 3 — Batch Operations

All operations apply to all images in `selectedImageIds`.

### Move
- `onMouseDown` on any selected image begins a move for all selected images
- Apply the same `(dx, dy)` delta to every selected image's `(x, y)`
- Exception: if `drilledImageId` is set and the user drags the drilled image specifically, move only that image. If the user drags a different selected image while `drilledImageId` is set, move all images in `selectedImageIds` as normal (drilledImageId only overrides when the drilled image itself is the drag target).
- Single undo entry (one `setImages` call in the store)

### Delete
- One confirmation dialog: "Delete N image(s)?" for any count (including 1)
- Single store action removing all selected ids

### Resize (multi-select)
- Single bounding-box handle rendered around the combined selection rect (corner drag only)
- Scales all selected images by the same scalar factor; each image's individual aspect ratio is preserved
- Formula: `newWidth = img.width * scaleFactor`, `newHeight = img.height * scaleFactor` where `scaleFactor = newBBoxSize / oldBBoxSize`
- Available for 1 or more selected images. For a single image, this is the same as the existing per-image resize handle; the bounding box collapses to that image's bounds.

### Align / Distribute
- Floating sub-section of the image toolbar (not a separate popup)
- Align buttons: align-left, align-center-H, align-right, align-top, align-middle-V, align-bottom — shown when 2+ images selected
- Distribute buttons: distribute-H, distribute-V — shown when 3+ images selected
- Aligns relative to the combined bounding box edges/center

---

## Section 4 — Grouping

- **Ctrl+G**: group all selected images under a shared new UUID `groupId`. If selected images include members of existing groups, all old groupIds are dissolved and a single new one assigned. If partial group selection: selected members get the new groupId; unselected siblings that previously shared a groupId retain that old groupId (or become null if only 1 sibling remains).
- **Ctrl+Shift+G**: ungroup — set `groupId = null` for all images in `selectedImageIds`
- **Flat model only**: no nested groups in v1
- **Visual indicator**: dashed `#5b6af0` bounding box rendered around all images in a group when any member is selected
- **Z-order on re-group**: images stay in their existing positions in the `view.images[]` array — Ctrl+G does not reorder them
- **Group button**: disabled when fewer than 2 images are selected
- **Ungroup button**: shown when selection contains at least one image with a non-null `groupId`. Clears groupId on all selected images only (not their group siblings unless those siblings are also selected).

**Persistence**: `groupId` is stored in `view.images[]` in Supabase, so groups survive page reload and are visible across browser tabs.

---

## Section 5 — Image Selection Toolbar UI

A floating HTML overlay (same pattern as `NodeToolbar` — `position:absolute`, `zIndex:20`) appears above the canvas when 1+ images are selected. It disappears when selection is cleared. Position: centered horizontally above the combined bounding box of the selection, converted from canvas coordinates to screen coordinates via the D3 zoom transform.

### Toolbar contents (left to right)

| Control | When shown | Action |
|---|---|---|
| Layer ▲ / Layer ▼ | 1 selected only | Move that image forward/back in z-order (`reorderImage` store action). Disabled for multi-select (order within a multi-select group is ambiguous). |
| Group | 2+ selected | Ctrl+G equivalent |
| Ungroup | Any selected image has a non-null groupId | Ctrl+Shift+G equivalent — clears groupId on selected images only |
| Align L / C / R / T / M / B | 2+ selected | Align selected images |
| Distribute H / V | 3+ selected | Distribute selected images |
| Crop | Exactly 1 selected | Deferred to v2 — button is visible but disabled with a "coming soon" tooltip |
| Delete | Always | Delete selected (confirm dialog) |

---

## Section 6 — Error Handling & Edge Cases

- **Delete single image**: confirmation dialog still shown ("Delete 1 image?") — consistent UX, avoids accidental deletion
- **Partial group deletion**: deleting some (not all) group members is allowed. If only 1 sibling remains after deletion, that image's `groupId` is set to `null` (a single-member group is meaningless and should not persist). The delete store action must apply this cleanup.
- **Re-grouping**: selecting members of two different groups and pressing Ctrl+G silently replaces their groupIds — no data loss, images remain
- **Resize with 1 selected**: bounding-box handle collapses to that image's bounds — functionally same as existing single-image resize, no special case needed
- **Layer ▲/▼ multi-select**: disabled for multi-select (button not shown) — order within a combined selection is undefined
- **Distribute with 2 images**: distribute-H/V buttons not shown for 2 images (distributing 2 items is a no-op when they're already at the edges of the bounding box)
- **Crop button**: shown only for 1 selected image, disabled with tooltip "Coming in v2" — not implemented in v1 but surfaced so users know it's planned

---

## Section 7 — Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Click image | Select (or whole group if grouped) |
| Shift/Ctrl+Click | Toggle image (or group) in/out of selection |
| Double-click grouped | Drill into single member |
| Drag on empty canvas | Rubber-band rect select |
| Ctrl+A | Select all images |
| Click empty canvas | Clear selection |
| Delete / Backspace | Delete selected (confirm dialog always) |
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
- Crop implementation (button visible but disabled, deferred to v2)

---

## Testing Approach

Manual verification on the live GitHub Pages deployment (`brainpulp.github.io/pim`) after implementation:

1. Rubber-band select (various rect sizes, partial overlaps, group expansion); confirm pan still works normally when no rubber-band is active
2. Shift-click toggle add/remove; Ctrl+A selects all
3. Move, delete, resize together with 2–3+ images selected
4. Align (L/C/R/T/M/B) and distribute (H/V, requires 3+) with mixed selection
5. Layer ▲/▼ on a single image; confirm disabled for multi-select
6. Group (Ctrl+G) → click any member selects whole group → double-click drills into one → move that one alone → Ungroup (Ctrl+Shift+G) restores individual selection
7. Partial group: Shift-click 2 of 3 group members → Ctrl+G → verify new group has 2 members, third retains old groupId (or gets null if was only remaining)
8. **Persistence check**: group images, reload page, verify group membership survives (Supabase-backed)
9. **Cross-tab check**: group in one tab, open another tab, confirm group is visible
