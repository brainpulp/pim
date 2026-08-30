# PIM — Release Notes

*Newest first. User-facing summaries of what shipped.*

---

## Unreleased (current branch)

### 📺 YouTube slideshow
A new player object that plays through a sequence of YouTube clips, cleanly.
- Add as many YouTube links as you want — **right-click the canvas → Insert → YouTube slideshow**.
- **Trim** each clip (start/end) with a dual-handle slider or by punching in `min:sec`.
- Choose how each clip **advances**: automatically when it ends, after a delay, or on click/keypress.
- **Clean playback** — YouTube's controls, title, and end-screen are hidden before and after each clip.
- An **inspector** that unfolds from the node — and **previews on the node itself** (no separate mini-screen). Selecting a clip plays it right on the node.
- **Live trim preview:** drag the start handle and playback restarts from the new start; drag the end handle and it seeks there.
- **Real video titles** shown in the clip list.
- **Drag to reorder** clips (no more up/down buttons).
- **Fullscreen playback** — play the whole slideshow in real fullscreen (fullscreen button when the node is selected).
- **Paste to add:** with a slideshow selected (or entered), paste a YouTube link and it drops straight into the box.
- **Drag videos in and out:** drop a YouTube video from the canvas onto a slideshow to fold it in (it leaves the canvas); pop a clip back out onto the canvas with the pop-out button in the inspector.
- **Arrow-key control** once entered (double-click / Enter to enter, Esc to leave): ←/→ previous/next clip, Space play/pause, Shift+←/→ ∓10 seconds.
- **Auto-play on arrival:** arrow-navigating onto a slideshow starts it playing. When it finishes it shows a **replay** on its last frame; press → to return to the node, → again to continue navigating.
- Crisp, centered control icons.

**How arrow keys stay unambiguous:** arrows always go to the *innermost active layer* — a YouTube slideshow only captures them once you *enter* it; otherwise normal graph navigation (or a running presentation) keeps the arrows. In a presentation, a slide holding a slideshow steps through its clips, then continues to the next slide.

### 🪄 Auto-styling of children
A node can style its **direct children** live: map a property to Color / Size / Shape / Blurriness / Motion / Outline thickness / Outline color, and/or set tag rules like *"if `task, urgent, marketing` → apply the 'clownish' style."* Updates instantly as tags/properties change; never overwrites a node's own styling. (Node menu → **Auto-style children…**)

### ⌨️ Keyboard navigation of the graph
Arrow keys walk the graph and the camera follows — **without selecting**, so nothing pops up as you move:
- ←/→ siblings, ↑ parent, ↓ child; Ctrl/Cmd+↑ jump to root.
- Keep pressing ↑ past the root to **zoom out** progressively — all roots → +1 generation → … → the whole graph.
- **Shift+↑/↓** change how much context stays in frame; **+/−** (or `[ ]`) tune closeness.
- Moving between siblings **arcs out then in**, so you glimpse the neighbours.

### 🎬 Media autoplay on focus
Videos and audio can be set to **autoplay** — ⚡ when you zoom/arrow-nav into them, or ▷ while their slide is presented. (YouTube autoplays muted, per browser rules.)

### 🖼️ Photo captions
Double-click a photo (or the *＋ caption* hint) to add a caption shown beneath it.

### 🔊 Audio clips
Add audio by pasting a link or uploading a file; native controls, autoplay toggles.

### ✨ AI content generation on a node
Type a verbal prompt and get generated text into a node's notes, as child nodes, or as a new label — with an editable preview.

### 🗂️ Canvas → "Grouping"
The cluster board tab is renamed **Grouping**; the **Graph** is the primary tab (and default).
