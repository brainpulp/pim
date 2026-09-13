// Pure navigation decision for the fullscreen slideshow player's ←/→ keys. Extracted into its own
// dependency-free module so it can be unit-tested without pulling in React/Three.
//
//   dir: 'right' | 'left'
//   idx: current clip index · count: number of clips · presenting: inside a full-deck presentation ·
//   ended: at the freeze/replay state
//
// Returns one of: 'clip-next' | 'clip-prev' | 'freeze-end' | 'deck-next' | 'deck-prev' | 'exit' | 'noop'
//
// While PRESENTING the player must never dump back to the canvas: past the last clip → advance the deck
// ('deck-next'), and ← on the first clip → go to the previous slide ('deck-prev'), always staying fullscreen.
export function fsArrowAction(dir, { idx, count, presenting, ended }) {
  if (dir === 'right') {
    if (idx < count - 1) return 'clip-next'
    if (presenting) return 'deck-next'      // last clip, presenting → straight to the next slide/build
    if (!ended) return 'freeze-end'         // not presenting → freeze the last frame (replay chrome)
    return 'exit'                           // already frozen → leave fullscreen, back to the node
  }
  // left
  if (idx > 0) return 'clip-prev'
  if (presenting) return 'deck-prev'        // first clip, presenting → previous slide (never a dead key)
  return 'noop'
}
