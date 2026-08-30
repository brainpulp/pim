# PIM — Product Feature List

*A user-facing catalog of what PIM can do. Seed document for end-user documentation. Grouped by area; each entry is a capability a user can act on. Engineering/internal details are intentionally omitted.*

---

## 1. Projects & accounts

- **Sign in with email + password.** Your projects are tied to your account.
- **Project picker.** Create, open, rename, and delete projects.
- **Automatic saving.** Work is saved as you go — no manual save button.
- **Cloud sync across devices.** Open the same project on another device and pick up where you left off.
- **Multiple workspaces (tabs) per project:** Graph, Grouping, Strategy, Table, and Lab.

---

## 2. The Graph — your main canvas

The Graph is where your ideas live as connected nodes on an infinite, pannable canvas.

### Nodes
- **Create nodes** anywhere on the canvas, with a label and freeform notes.
- **Connect nodes** by dragging from a node's connector dot to another node (or to empty space to make a new connected node).
- **Living layout.** Nodes gently float and balance themselves; drag one to pin it in place, release to let it float again.
- **Drill in.** Focus the canvas on a single node and its subtree; step back out to the full picture.
- **Collapse / expand** a node to fold or reveal its children.
- **Expand by hops.** Reveal everything within N connections of a node.
- **Duplicate** a node (optionally with its children).
- **Multi-select** nodes for bulk actions.
- **Background color** for the canvas.

### Node appearance
- **Shapes:** circle, ellipse, rounded rectangle, rectangle, diamond, "no shape" (label only), plus special shapes: frame, container, 3D model, and image.
- **Colors:** fill, text, and outline color; transparent fill option.
- **Outline styling:** thickness and dashed styles.
- **Depth & polish:** opacity, drop shadow, border blur, and decorative border effects.
- **Emoji** badges on nodes.
- **Motion:** animate a node (shake, orbit, jerk, up/down, sideways, scale) with adjustable speed and intensity.
- **Color cycling:** slowly shift a node's hue over time.
- **Saved styles.** Capture a node's look as a named style and apply it to other nodes in one click; update, rename, or delete saved styles.

### The node menu (proximal toolbar)
Click a node to open a compact menu right beside it: Style, Arrange, Notes, Properties, Tags, Emoji, Image, child Effects, Show-as, and quick actions (duplicate, hide, delete, release anchor).

---

## 3. Keyboard navigation & shortcuts

- **Arrow-key tree navigation with focus-zoom.** With nothing selected, an arrow key grabs the nearest node. Then:
  - **← / →** cycle through siblings (at a top-level node, cycles among all roots).
  - **↑** go to the parent, **↓** go to the first child.
  - **Ctrl/Cmd + ↑** jump to the root.
  - **Shift + ↓ / ↑** change how much context stays in frame (just the node → node + children → deeper).
  - **+ / −** (or **[ / ]**) adjust how close the camera zooms; the setting sticks.
- **Enter** creates a sibling (or a child, on a top-level node).
- **Delete / Backspace** removes the selection.
- **Ctrl/Cmd + Z / Y** undo / redo.
- **Esc** deselect / close menus / exit presentation.
- **Search / spotlight (Cmd/Ctrl + K, or `/`).** Fuzzy-search all node labels; jump and zoom to any node. Type immediately — no click needed.
- **Fit to view** to frame everything at once.

---

## 4. Containers

A container is a shape that holds other nodes inside it.

- **Turn any node with children into a container** (or add an empty one).
- **Contents stay inside** and move together when you drag the container.
- **Circle or rectangle** container shape.
- **Title sits just outside** the container.
- **Collapse** a container to a compact pill.
- **Child links reroute** to the container's parent ("grandmother") or back to the container — your choice.
- **Pull a node out:** it springs back in (gravity), or becomes a standalone node — your choice.
- **Turn a container back into a normal node** anytime.

---

## 5. Frames, builds & presentation

- **Frames** are large labeled areas you can place around groups of nodes.
- **Toggle frame outlines** on or off.
- **Build timeline (keyframe editor) on each frame.** Record stages that capture node positions, visibility, size, collapse state, and styling; play them back in sequence.
  - **Per-stage timing:** advance on click or after a set time.
  - **Per-stage speed**, plus smooth transitions (including a shape "morph" when shapes change).
- **Slideshows.** Add frames as slides and order them; keep multiple slideshows per view.
- **Presentation mode** with two navigation sets:
  - **Builds:** → / Space / Enter advance, ← steps back (crossing slide boundaries).
  - **Slides:** ↓ / ↑ (or PageDown / PageUp) jump between slides.
  - On-screen slide and build counters; Esc to exit.

---

## 6. Media on the canvas

- **Photos.** Add by upload or paste. Drag, resize, crop, rotate, set a background color, blur the whole image or feather just its edges.
  - **Captions.** Double-click a photo to add a caption shown beneath it.
- **Videos.** Upload video files or embed YouTube links. The player stays "pass-through" (canvas still pans/zooms over it) until you activate it; double-click to play/pause.
- **Link previews.** Paste a URL to drop an unfurled preview card with title, description, image, and site icon.
- **Audio.** Add by pasting a link or uploading a file. Native play controls, drag, resize, rename.
  - **Autoplay on zoom:** the clip plays when you zoom into it and pauses when you zoom away.
  - **Autoplay on slide:** the clip plays while the frame that contains it is being presented.
- **Attach media to a node** so it moves and deletes together with that node.
- **Turn a floating image or video into a real node** in the graph.

### YouTube slideshow
A dedicated player node that plays through a sequence of YouTube clips, cleanly.
- **Add as many YouTube links as you want**, in order (right-click canvas → Insert → **YouTube slideshow**).
- **Trim each clip** — set a start and end, by dragging a dual-handle slider or punching in `min:sec`.
- **Per-clip advance trigger:** play the next clip **automatically** when one ends, **after a delay**, or **on click / keypress**.
- **Clean playback** — YouTube's own controls, title, and end-screen are hidden before and after each clip; you just see the video.
- **Inspector** (side panel) to preview, trim, reorder (up/down), delete, and add clips.
- **Arrow-key control** once you *enter* the slideshow (double-click or Enter; Esc leaves): **←/→** previous/next clip, **Space** play/pause, **Shift+←/→** rewind/forward 10 seconds.

---

## 7. Properties, tags & fields

- **Custom properties** on nodes: Select, Multi-select, Number, Date, Text, and more.
- **Color-coded options** for Select/Multi-select values.
- **Tags** — freeform labels you can add to any node.
- Property values are shared across all views of a project.

---

## 8. Auto-styling (rules & mappings)

Make a node style its **direct children** automatically — live, and without overwriting their own looks.

- **Map a property to a visual channel:** Color, Size, Shape, Blurriness, Motion, Outline thickness, or Outline color. Category values spread across the channel (using your Select colors when set); number values scale across their range.
- **Tag rules → saved styles:** e.g. *"if tags include task, urgent, marketing → apply the 'clownish' style."* A child must have all listed tags; the first matching rule wins, and rules override mappings.
- **Live.** As you tag or edit children, their styling updates instantly.

---

## 9. Node display modes ("Show as…")

Reframe a node's children into a different layout, in place:

- **List** — a nested outline card.
- **Kanban board** — children become columns, grandchildren become cards.
- **Strategy / flowchart** — a draggable strategy card of the subtree.
- **Container** — hold the children inside a shape (see Containers).
- **Table / grid** — a spreadsheet of the children.
- **Sorted / grouped arrangement** — auto-arrange children by a property.

Any mode can be turned back into plain nodes.

---

## 10. AI-assisted content

- **Generate content on a node from a verbal prompt.** Describe what you want and get text written straight into the node's notes, spun up as child nodes, or used to rename the node — with an editable preview before you apply.
- **Name generator.** Generate candidate names ("words") for a node from a theme and criteria, or variations of an existing name.
- **Brand risk assessment.** Optionally screen generated names for infringement risk (green/amber/red) and run a live trademark check.
- **Built-in assistant.** Ask the assistant to build or edit your graph directly (create/connect/rename nodes, set notes, tag, recolor, reshape, make a kanban/list/strategy, and more).
- **Work with your graph from anywhere in Claude** by connecting PIM as a data source, so you can ask Claude to generate content straight into a project.

---

## 11. The outliner (side panel)

- **Docked outline tree** beside the canvas that mirrors the active view.
- **Drag to reorder and reparent** items.
- **Rename, drill in, toggle visibility, add a child, or delete** from each row.
- **Adjustable text size.**
- **Maximize** the outliner to work in it full-width.
- Keyboard: Enter for a new line, Shift+Enter for a line break, Cmd/Ctrl+Enter for a new item.

---

## 12. Views

- **Multiple views per project.** Each view keeps its own node positions, styling, visibility, background, and slideshows — over the same shared set of nodes and connections.
- **Create, duplicate, rename, and delete** views.
- **Hide/show** individual nodes per view.

---

## 13. Drawing & annotation layer

- Add **shapes, lines, arrows, text, and emoji** directly on the canvas as annotations (separate from nodes).
- Drag, restyle, and delete annotations; they show on the canvas and in slides.

---

## 14. Images: multi-select & arrange (Miro-style)

- **Multi-select** floating images (click, shift-click, or rubber-band).
- **Group / ungroup** images.
- **Align** (left/center/right/top/middle/bottom) and **distribute** evenly.
- **Batch move and resize** a whole selection.
- **Layer order** (bring forward / send back).

---

## 15. Table view

- See your nodes as a **spreadsheet**, with columns for their properties.
- Read and edit values in a familiar grid.

---

## 16. Strategy view

- A dedicated **flowchart / strategy board** for planning, with draggable items and connections.

---

## 17. Grouping (cluster board)

*A secondary canvas for organizing nodes into clusters (currently a companion to the Graph).*

- **Circle packs** — group nodes into nested bubbles by a tag property.
- **Property trees** — branch nodes out by a property and its values; drag an item between values to retag.
- **Due-date buckets** — group by date into Today / Tomorrow / … buckets.
- **Free nodes, connections, and photos** placed directly on the board.

---

## 18. 3D model nodes

- Embed **3D models (GLB/OBJ)** as nodes.
- **Orbit, pan, and zoom** the model in place; the camera angle is remembered per view.
- Automatic **thumbnail** so the model shows even when you're not interacting with it.

---

## 19. Sharing & collaboration

- **Share links.**
  - **View link** — public, read-only; no sign-in required.
  - **Edit link** — the recipient signs in and gets full editing.
- **Revoke** a share link anytime.
- **Live presence.** See collaborators' cursors on the canvas in real time.

---

## 20. Cross-project links

- **Link a node to another project.** A one-click badge jumps you there.
- **Back button.** A floating "← Back to <project>" chip lets you retrace multi-project hops.

---

## 21. Export & interchange

- **Export your outline** as a document (HTML / print to PDF).
- **Export the canvas** as an image (PNG).
- **Flowchart interchange.** Convert to and from Mermaid flowchart syntax.

---

## 22. Delight & polish

- Smooth animated transitions when navigating, presenting, and restyling.
- Empty-state hints to help you get started.
- Consistent, legible dark UI across the app.

---

*This list is a starting point — expand each section into step-by-step guides, screenshots, and tips as the documentation grows.*
