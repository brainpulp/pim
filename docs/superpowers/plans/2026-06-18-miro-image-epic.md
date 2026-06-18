# Miro Image Epic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-select, grouping, batch operations (move/delete/resize/align/distribute), and a floating toolbar for free-floating canvas images (`view.images[]`) in PIM.

**Architecture:** All selection/drill state lives in local React state in `Graph.jsx`. Grouping (`groupId`) and z-order mutations go through new store actions in `graphStore.js`. The floating `ImageToolbar` is a new component in `Graph.jsx` following the existing `NodeToolbar` pattern — a `position:absolute` HTML div converted from canvas coordinates via the D3 zoom transform. Rubber-band rect select overlays the SVG canvas background layer.

**Tech Stack:** React + Vite, D3.js zoom transform, Zustand (`graphStore.js`), SVG + HTML overlay pattern (matches existing `NodeToolbar`).

**Spec:** `docs/superpowers/specs/2026-06-18-miro-image-epic-design.md`

---

## Important Codebase Notes

- Canvas images are stored as `{ id, src, x, y, width, height, rotation, bgColor }` — the field is `src`, not `url`. Do NOT introduce `img.url` anywhere.
- D3 zoom behavior is stored in `zoomBehaviorRef` (not `d3ZoomRef`). Use `zoomBehaviorRef.current` throughout.
- `deleteImage` (singular, existing) takes a single imageId and is used by node-image code — do NOT remove or modify it. The new `deleteImages` (plural) is separate.
- `uid()` is already imported at the top of `graphStore.js` — use it for new group UUIDs.

---

## File Map

| File | Change |
|---|---|
| `src/lib/graphStore.js` | Add `groupImages`, `ungroupImages`, `reorderImage`, `deleteImages` (new plural action) |
| `src/pages/Graph.jsx` | Replace `selectedImageId` with `selectedImageIds` Set + `drilledImageId`; add rubber-band logic; rewrite image mouse handlers; add `ImageToolbar` and `alignImages`/`distributeImages` helpers; add keyboard shortcuts; add group visual indicator; add multi-image resize |

No Supabase migration needed — `view.images` is a JSONB array column; old entries simply lack `groupId` and the JS fallback `img.groupId ?? null` handles them.

---

## Task 1: Add new store actions to `graphStore.js`

**Files:**
- Modify: `src/lib/graphStore.js` (Image ops section, ~line 260)

- [ ] **Step 1: Add `groupImages` action** after the existing `deleteImage` action. This action also cleans up orphaned siblings — if re-grouping leaves any sibling of an old group with only 1 remaining member, that sibling's `groupId` is cleared to `null`.

```js
groupImages: (imageIds) => {
  const gid = uid()
  set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      // Collect the old groupIds of selected images, to check for orphaned siblings after
      const oldGroupIds = new Set(
        (v.images || []).filter(i => imageIds.includes(i.id) && i.groupId).map(i => i.groupId)
      )
      // Assign new groupId to selected images
      let imgs = (v.images || []).map(img =>
        imageIds.includes(img.id) ? { ...img, groupId: gid } : img
      )
      // Orphan cleanup: count remaining members of each old group
      const counts = {}
      imgs.forEach(img => { if (img.groupId && oldGroupIds.has(img.groupId)) counts[img.groupId] = (counts[img.groupId] || 0) + 1 })
      imgs = imgs.map(img =>
        img.groupId && oldGroupIds.has(img.groupId) && counts[img.groupId] === 1
          ? { ...img, groupId: null }
          : img
      )
      return { ...v, images: imgs }
    }),
  }))
},
```

- [ ] **Step 2: Add `ungroupImages` action** (clears groupId on the specified image ids only — does NOT affect group siblings):

```js
ungroupImages: (imageIds) => set(s => ({
  views: s.views.map(v => v.id !== s.activeViewId ? v : {
    ...v, images: (v.images || []).map(img =>
      imageIds.includes(img.id) ? { ...img, groupId: null } : img
    ),
  }),
})),
```

- [ ] **Step 3: Add `reorderImage` action** (`'up'` = higher array index = renders on top in SVG paint order; `'down'` = lower index = renders beneath):

```js
reorderImage: (imageId, direction) => set(s => ({
  views: s.views.map(v => {
    if (v.id !== s.activeViewId) return v
    const imgs = [...(v.images || [])]
    const idx = imgs.findIndex(i => i.id === imageId)
    if (idx < 0) return v
    if (direction === 'up' && idx < imgs.length - 1) {
      [imgs[idx], imgs[idx + 1]] = [imgs[idx + 1], imgs[idx]]
    } else if (direction === 'down' && idx > 0) {
      [imgs[idx], imgs[idx - 1]] = [imgs[idx - 1], imgs[idx]]
    }
    return { ...v, images: imgs }
  }),
})),
```

- [ ] **Step 4: Add `deleteImages` (plural) — new action, do NOT modify or remove the existing `deleteImage` (singular):**

```js
deleteImages: (imageIds) => set(s => ({
  views: s.views.map(v => {
    if (v.id !== s.activeViewId) return v
    const remaining = (v.images || []).filter(img => !imageIds.includes(img.id))
    // Orphan cleanup: if a group now has only 1 member, clear its groupId
    const groupCounts = {}
    remaining.forEach(img => { if (img.groupId) groupCounts[img.groupId] = (groupCounts[img.groupId] || 0) + 1 })
    return {
      ...v, images: remaining.map(img =>
        img.groupId && groupCounts[img.groupId] === 1 ? { ...img, groupId: null } : img
      ),
    }
  }),
})),
```

- [ ] **Step 5: Verify all four new actions appear in the store's return object** alongside `addImage`, `updateImage`, `deleteImage`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/graphStore.js
git commit -m "feat: add groupImages, ungroupImages, reorderImage, deleteImages store actions"
```

---

## Task 2: Replace single-select state with multi-select state in `Graph.jsx`

**Files:**
- Modify: `src/pages/Graph.jsx`

The existing `selectedImageId` (string | null, ~line 208) becomes a `Set` and a drill id.

- [ ] **Step 1: Replace the state declaration** (find `const [selectedImageId, setSelectedImageId] = useState(null)` ~line 208):

```js
const [selectedImageIds, setSelectedImageIds] = useState(new Set())
const [drilledImageId, setDrilledImageId] = useState(null)
```

- [ ] **Step 2: Add `expandGroup` helper** near those state declarations. This is only called on plain clicks (not Shift-click). Shift-click always toggles the individual image:

```js
// Expand a plain click to select the image's whole group (unless that image is drilled)
const expandGroup = useCallback((imageId, images, drilled) => {
  if (imageId === drilled) return [imageId]
  const img = images.find(i => i.id === imageId)
  if (!img?.groupId) return [imageId]
  return images.filter(i => i.groupId === img.groupId).map(i => i.id)
}, [])
```

- [ ] **Step 3: Fix all references to `selectedImageId`** — grep the file for `selectedImageId` and update each:
  - `isSelected={selectedImageId === img.id}` → `isSelected={selectedImageIds.has(img.id)}`
  - `setSelectedImageId(imageId)` in `handleImageMouseDown` → will be rewritten in Task 3
  - The image toolbar condition `{selectedImageId && ...}` → will be rewritten in Task 7
  - `setConfirmDeleteImage(selectedImageId)` keyboard handler → will be replaced by `confirmDeleteImages` in Task 4

- [ ] **Step 4: Add `groupImages`, `ungroupImages`, `reorderImage`, `deleteImages` to the store destructure** at the top of `Graph.jsx` (where `updateImage`, `deleteImage`, etc. are pulled from `useGraphStore`).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Graph.jsx
git commit -m "refactor: replace selectedImageId with selectedImageIds Set + drilledImageId"
```

---

## Task 3: Rewrite image mouse handlers for multi-select

**Files:**
- Modify: `src/pages/Graph.jsx` (`handleImageMouseDown` ~line 1156)

- [ ] **Step 1: Rewrite `handleImageMouseDown`**. Note that `dragIds` is computed from the synchronously-known `ids` (not from `selectedImageIds` React state, which would be stale on first click):

```js
const handleImageMouseDown = useCallback((e, imageId, mode = 'drag') => {
  e.preventDefault(); e.stopPropagation()
  canvasFocused.current = true
  setSelected(null)

  const images = activeView?.images || []
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

    // Double-click: drill into single group member
    if (e.detail === 2) {
      const img = images.find(i => i.id === imageId)
      if (img?.groupId) {
        setDrilledImageId(imageId)
        setSelectedImageIds(new Set([imageId]))
        return
      }
    }

    // Plain click: select image or its whole group (unless drilled)
    const ids = expandGroup(imageId, images, drilledImageId)
    setSelectedImageIds(new Set(ids))
    if (imageId !== drilledImageId) setDrilledImageId(null)

    // Begin drag-move.
    // Use `ids` (synchronously known) not `selectedImageIds` (stale React state).
    // If the user is dragging the drilled image, move only that one.
    const isDrilledDrag = drilledImageId === imageId
    const dragIds = isDrilledDrag ? [imageId] : ids

    const startSx = (e.clientX - T.x) / T.k
    const startSy = (e.clientY - T.y) / T.k
    const origins = {}
    dragIds.forEach(id => {
      const img = images.find(i => i.id === id)
      if (img) origins[id] = { x: img.x, y: img.y }
    })

    const onMove = me => {
      const sx = (me.clientX - T.x) / T.k, sy = (me.clientY - T.y) / T.k
      const dx = sx - startSx, dy = sy - startSy
      dragIds.forEach(id => {
        if (!origins[id]) return
        updateImage(id, { x: origins[id].x + dx, y: origins[id].y + dy })
      })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)

  } else if (mode === 'resize') {
    // Single-image resize: unchanged from original
    const img = images.find(i => i.id === imageId)
    if (!img) return
    const screenCX = T.x + img.x * T.k, screenCY = T.y + img.y * T.k
    const startDist = Math.hypot(e.clientX - screenCX, e.clientY - screenCY)
    const startW = img.width, startH = img.height
    const onMove = me => {
      if (startDist < 1) return
      const d = Math.hypot(me.clientX - screenCX, me.clientY - screenCY)
      const s = d / startDist
      updateImage(imageId, { width: Math.max(20, Math.round(startW * s)), height: Math.max(10, Math.round(startH * s)) })
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
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
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }
}, [activeView, drilledImageId, updateImage, expandGroup])
```

- [ ] **Step 2: Clear image selection when clicking the canvas background.** Find the SVG background `onMouseDown` handler and add:

```js
setSelectedImageIds(new Set())
setDrilledImageId(null)
```

- [ ] **Step 3: Clear image selection when a node is selected.** In `handleNodeMouseDown` (wherever `setSelected({ type: 'node', id })` is called), also clear:

```js
setSelectedImageIds(new Set())
setDrilledImageId(null)
```

- [ ] **Step 4: Deploy and smoke-test** click, shift-click, double-click drill, drag-move on live site.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Graph.jsx
git commit -m "feat: multi-select and group-expand image click handling"
```

---

## Task 4: Keyboard shortcuts for images

**Files:**
- Modify: `src/pages/Graph.jsx` (the `keydown` handler, ~line 570)

- [ ] **Step 1: Add `confirmDeleteImages` state** near the other confirm states:

```js
const [confirmDeleteImages, setConfirmDeleteImages] = useState(null) // string[] | null
```

- [ ] **Step 2: Update the canvas keydown handler** — find the block that handles `Delete` for image selection and replace/augment it:

```js
// Delete / Backspace — canvas images
if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImageIds.size > 0) {
  e.preventDefault()
  setConfirmDeleteImages([...selectedImageIds])
  return
}

// Escape — clear image selection / cancel rubber-band
if (e.key === 'Escape' && selectedImageIds.size > 0) {
  setSelectedImageIds(new Set()); setDrilledImageId(null)
  // Let existing Escape handling continue for other state (node deselect, etc.)
}

// Ctrl+A — select all images when canvas focused and no node selected
if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !selected && canvasFocused.current) {
  e.preventDefault()
  setSelectedImageIds(new Set((activeView?.images || []).map(i => i.id)))
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
```

- [ ] **Step 3: Add the delete confirm dialog** for images (find the existing `confirmDeleteImage` dialog ~line 1709 and add a second one nearby):

```jsx
{confirmDeleteImages && (
  <div style={confirmStyle} onClick={() => setConfirmDeleteImages(null)}>
    <div style={confirmBox} onClick={e => e.stopPropagation()}>
      <div style={{ fontSize: '0.88rem', color: '#ccc', marginBottom: 12 }}>
        Delete {confirmDeleteImages.length} image{confirmDeleteImages.length > 1 ? 's' : ''}?
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
)}
```

- [ ] **Step 4: Deploy and test** keyboard shortcuts on live site.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Graph.jsx
git commit -m "feat: keyboard shortcuts for image multi-select (Delete, Escape, Ctrl+A, Ctrl+G, Ctrl+Shift+G)"
```

---

## Task 5: Group visual indicator

**Files:**
- Modify: `src/pages/Graph.jsx` (image render section, ~line 1426)

- [ ] **Step 1: Compute group bounds** just before the images map in the SVG render:

```js
// Dashed bounding boxes for groups that have a selected member
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
```

- [ ] **Step 2: Render group bounding boxes in the SVG**, before the images:

```jsx
{/* Group visual indicators */}
{Object.entries(groupBounds).map(([gid, b]) => (
  <rect key={gid}
    x={b.x1 - 6} y={b.y1 - 6}
    width={b.x2 - b.x1 + 12} height={b.y2 - b.y1 + 12}
    fill="none" stroke="#5b6af0" strokeWidth={1.5} strokeDasharray="6,4"
    rx={6} opacity={0.7} pointerEvents="none"
  />
))}
```

- [ ] **Step 3: Deploy and verify** the dashed box appears when clicking any group member.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Graph.jsx
git commit -m "feat: group visual bounding box indicator"
```

---

## Task 6: Rubber-band rect select

**Files:**
- Modify: `src/pages/Graph.jsx`

> **Important:** The D3 zoom behavior is stored in `zoomBehaviorRef` (not `d3ZoomRef`). Use `zoomBehaviorRef.current` everywhere below.

- [ ] **Step 1: Add rubber-band state**:

```js
const [rubberBand, setRubberBand] = useState(null) // { sx, sy, ex, ey } in canvas coords | null
const rubberBandRef = useRef(null)
```

- [ ] **Step 2: Find where D3 zoom is initialized** — look for `zoomBehaviorRef.current = d3.zoom()...` in a `useEffect`. Inside that same effect, add a namespaced zoom handler to trigger toolbar re-render on pan/zoom:

```js
// Add alongside existing .on('zoom', ...) — use namespace to avoid overriding it
zoomBehaviorRef.current.on('zoom.toolbar', () => setZoomTick(t => t + 1))
```

Also add the state near the other state declarations:
```js
const [zoomTick, setZoomTick] = useState(0)
```

- [ ] **Step 3: Rewrite (or replace) the canvas background `onMouseDown`** to add rubber-band. Find the transparent background rect's `onMouseDown` in the SVG and replace it with a `handleCanvasMouseDown` callback:

```js
const handleCanvasMouseDown = useCallback((e) => {
  if (e.button !== 0) return
  // Always clear image selection on canvas background click
  setSelectedImageIds(new Set()); setDrilledImageId(null)
  // Existing canvas-background click handling (clear node selection etc.)
  setSelected(null)
  canvasFocused.current = true

  if (e.shiftKey || e.ctrlKey || e.metaKey) return // modifiers: let D3 pan handle it

  const T = zoomTransformRef.current
  const startClientX = e.clientX, startClientY = e.clientY
  const startSx = (e.clientX - T.x) / T.k
  const startSy = (e.clientY - T.y) / T.k
  let moved = false

  const onMove = me => {
    const dx = me.clientX - startClientX, dy = me.clientY - startClientY
    if (!moved && Math.hypot(dx, dy) < 4) return
    if (!moved) {
      moved = true
      // Suppress D3 pan for the duration of the rubber-band
      zoomBehaviorRef.current?.filter(() => false)
    }
    const ex = (me.clientX - T.x) / T.k, ey = (me.clientY - T.y) / T.k
    rubberBandRef.current = { sx: startSx, sy: startSy, ex, ey }
    setRubberBand({ sx: startSx, sy: startSy, ex, ey })
  }

  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    // Re-enable D3 pan
    zoomBehaviorRef.current?.filter(() => true)

    if (moved && rubberBandRef.current) {
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
    }
    rubberBandRef.current = null
    setRubberBand(null)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}, [drilledImageId])
```

- [ ] **Step 4: Render the rubber-band overlay** in the SVG (alongside group indicator rects):

```jsx
{rubberBand && (() => {
  const x = Math.min(rubberBand.sx, rubberBand.ex)
  const y = Math.min(rubberBand.sy, rubberBand.ey)
  const w = Math.abs(rubberBand.ex - rubberBand.sx)
  const h = Math.abs(rubberBand.ey - rubberBand.sy)
  return <rect x={x} y={y} width={w} height={h}
    fill="rgba(91,106,240,0.08)" stroke="#5b6af0" strokeWidth={1} strokeDasharray="4,3"
    pointerEvents="none" />
})()}
```

- [ ] **Step 5: Wire `handleCanvasMouseDown`** to the SVG background element — replace the existing `onMouseDown` on the transparent background rect.

- [ ] **Step 6: Deploy and test** — rubber-band selects images; pan still works on empty canvas when not drawing a band; group expansion works.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Graph.jsx
git commit -m "feat: rubber-band rect select for canvas images"
```

---

## Task 7: Image toolbar rewrite

**Files:**
- Modify: `src/pages/Graph.jsx` (image toolbar section ~line 1668)

- [ ] **Step 1: Add `alignImages` and `distributeImages` pure helper functions** near the top of the file (outside the component):

```js
function alignImages(images, selectedIds, anchor) {
  const sel = images.filter(i => selectedIds.has(i.id))
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
```

- [ ] **Step 2: Add `ImageToolbar` component** as a function just above (or near) the main `Graph` component:

```jsx
function ImageToolbar({ images, selectedImageIds, drilledImageId, transform, zoomTick,
    onGroup, onUngroup, onReorderImage, onAlign, onDistribute, onDelete }) {
  if (selectedImageIds.size === 0) return null
  const sel = images.filter(i => selectedImageIds.has(i.id))
  const count = sel.length
  if (count === 0) return null

  // Position: centered above combined bounding box, in screen coordinates
  const T = transform
  const x1 = Math.min(...sel.map(i => i.x - i.width / 2))
  const y1 = Math.min(...sel.map(i => i.y - i.height / 2))
  const x2 = Math.max(...sel.map(i => i.x + i.width / 2))
  const cx = (x1 + x2) / 2
  const screenX = T.x + cx * T.k
  const screenY = T.y + y1 * T.k - 12

  const hasGroupId = sel.some(i => i.groupId)
  const isSingle = count === 1

  const btn = (label, onClick, disabled, title, color) => (
    <button key={label + title}
      title={title || label}
      onClick={disabled ? undefined : onClick}
      style={{
        background: 'transparent', border: '1px solid #2d3a6a', borderRadius: 5,
        color: disabled ? '#3a4070' : (color || '#7080a0'), cursor: disabled ? 'default' : 'pointer',
        padding: '3px 7px', fontSize: '0.78rem', whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )

  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: screenX, top: screenY,
        transform: 'translateX(-50%) translateY(-100%)',
        background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8,
        padding: '5px 7px', display: 'flex', flexWrap: 'wrap', gap: 4,
        zIndex: 25, boxShadow: '0 4px 16px rgba(0,0,0,0.6)', maxWidth: 400,
      }}
    >
      {isSingle && btn('▲', () => onReorderImage(sel[0].id, 'up'), false, 'Layer up')}
      {isSingle && btn('▼', () => onReorderImage(sel[0].id, 'down'), false, 'Layer down')}
      {count >= 2 && btn('Group', onGroup, false, 'Ctrl+G')}
      {hasGroupId && btn('Ungroup', onUngroup, false, 'Ctrl+Shift+G')}
      {count >= 2 && btn('⬛L', () => onAlign('left'), false, 'Align left')}
      {count >= 2 && btn('⬛C', () => onAlign('centerH'), false, 'Align center H')}
      {count >= 2 && btn('⬛R', () => onAlign('right'), false, 'Align right')}
      {count >= 2 && btn('⬛T', () => onAlign('top'), false, 'Align top')}
      {count >= 2 && btn('⬛M', () => onAlign('middleV'), false, 'Align middle V')}
      {count >= 2 && btn('⬛B', () => onAlign('bottom'), false, 'Align bottom')}
      {count >= 3 && btn('↔ Dist', () => onDistribute('H'), false, 'Distribute H')}
      {count >= 3 && btn('↕ Dist', () => onDistribute('V'), false, 'Distribute V')}
      {isSingle && btn('Crop', undefined, true, 'Coming in v2', '#3a4070')}
      {btn('✕ Delete', onDelete, false, 'Delete selected', '#f87171')}
    </div>
  )
}
```

- [ ] **Step 3: Replace the existing image toolbar block** (~line 1668, `{selectedImageId && (() => { ... })()} `) with:

```jsx
<ImageToolbar
  images={activeView?.images || []}
  selectedImageIds={selectedImageIds}
  drilledImageId={drilledImageId}
  transform={zoomTransformRef.current}
  zoomTick={zoomTick}
  onGroup={() => groupImages([...selectedImageIds])}
  onUngroup={() => ungroupImages([...selectedImageIds])}
  onReorderImage={(id, dir) => reorderImage(id, dir)}
  onAlign={anchor => {
    const updates = alignImages(activeView?.images || [], selectedImageIds, anchor)
    updates.forEach(({ id, x, y }) => updateImage(id, { x, y }))
  }}
  onDistribute={axis => {
    const updates = distributeImages(activeView?.images || [], selectedImageIds, axis)
    updates.forEach(u => updateImage(u.id, u))
  }}
  onDelete={() => setConfirmDeleteImages([...selectedImageIds])}
/>
```

- [ ] **Step 4: Deploy and test** — all toolbar buttons, align operations, distribute, delete confirm, layer up/down, group/ungroup, toolbar stays in position while panning.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Graph.jsx
git commit -m "feat: image selection toolbar with group/align/distribute/delete"
```

---

## Task 8: Multi-image proportional resize

**Files:**
- Modify: `src/pages/Graph.jsx`

The spec requires a single bounding-box corner handle that scales all selected images proportionally. This is separate from the existing per-image resize handle (which stays for single-image use).

- [ ] **Step 1: Render a combined bounding-box resize handle** for the selection when `selectedImageIds.size >= 1`. Add this to the SVG render, after the images:

```jsx
{/* Combined selection resize handle */}
{selectedImageIds.size >= 1 && (() => {
  const sel = (activeView?.images || []).filter(i => selectedImageIds.has(i.id))
  if (sel.length === 0) return null
  const bx1 = Math.min(...sel.map(i => i.x - i.width / 2))
  const by1 = Math.min(...sel.map(i => i.y - i.height / 2))
  const bx2 = Math.max(...sel.map(i => i.x + i.width / 2))
  const by2 = Math.max(...sel.map(i => i.y + i.height / 2))
  return (
    <g>
      {/* Selection bounding box outline */}
      <rect x={bx1-3} y={by1-3} width={bx2-bx1+6} height={by2-by1+6}
        fill="none" stroke="#5b6af0" strokeWidth={1} strokeDasharray="4,3"
        opacity={0.5} pointerEvents="none" />
      {/* Bottom-right corner resize handle */}
      <rect x={bx2-6} y={by2-6} width={12} height={12}
        fill="#5b6af0" stroke="#fff" strokeWidth={1} rx={2}
        style={{ cursor: 'se-resize' }}
        onMouseDown={e => {
          e.preventDefault(); e.stopPropagation()
          const T = zoomTransformRef.current
          const bboxW = bx2 - bx1, bboxH = by2 - by1
          const startDist = Math.hypot(
            e.clientX - (T.x + bx2 * T.k),
            e.clientY - (T.y + by2 * T.k)
          )
          const startSizes = {}
          sel.forEach(img => { startSizes[img.id] = { w: img.width, h: img.height } })
          const onMove = me => {
            const d = Math.hypot(
              me.clientX - (T.x + bx1 * T.k),
              me.clientY - (T.y + by1 * T.k)
            )
            const origDist = Math.hypot(bboxW * T.k, bboxH * T.k)
            if (origDist < 1) return
            const s = d / origDist
            sel.forEach(img => {
              const { w, h } = startSizes[img.id]
              updateImage(img.id, {
                width: Math.max(20, Math.round(w * s)),
                height: Math.max(10, Math.round(h * s)),
              })
            })
          }
          const onUp = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
          }
          document.addEventListener('mousemove', onMove)
          document.addEventListener('mouseup', onUp)
        }}
      />
    </g>
  )
})()}
```

- [ ] **Step 2: Deploy and test** — select 2+ images, drag the corner handle, verify all scale proportionally.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Graph.jsx
git commit -m "feat: multi-image proportional resize via bounding-box corner handle"
```

---

## Task 9: Final integration smoke-test

- [ ] **Run `npm run deploy`** and open `https://brainpulp.github.io/pim`

- [ ] **Test checklist:**
  - [ ] Rubber-band select (small rect, large rect, partial overlaps, group expansion)
  - [ ] Pan still works normally on empty canvas when not rubber-banding
  - [ ] Shift-click toggles individual images (NOT the whole group)
  - [ ] Ctrl+A selects all images
  - [ ] Move 2+ selected images together
  - [ ] Delete 1 image (confirm dialog); delete 3 images (confirm dialog)
  - [ ] Resize 2+ selected images via bounding-box corner handle (all scale proportionally)
  - [ ] Align L / C / R / T / M / B with 3 images
  - [ ] Distribute H and V with 3+ images
  - [ ] Layer ▲/▼ on single image; confirm buttons absent for multi-select
  - [ ] Group (Ctrl+G) → dashed box appears → click any member selects all → double-click drills into one → move that one alone → Ungroup restores individual
  - [ ] Partial group: Shift-click 2 of 3 group members → Ctrl+G → verify new group has 2 members, third sibling has null groupId (was orphaned — only 1 remained)
  - [ ] Re-group across two existing groups: select members of both → Ctrl+G → single new group
  - [ ] Persistence: group images, reload page, group survives (Supabase-backed)
  - [ ] Cross-tab: group in tab A, open tab B, group visible

- [ ] **Commit any final fixups**, then push:

```bash
git push
```
