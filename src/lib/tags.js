// Unified tag model. Tags are plain strings stored on `node.meta.tags` (view-independent).
// This is the SINGLE source of truth for tags across the whole app — the graph canvas,
// the graph context menus, the outliner (#tag markdown), the command palette, markdown
// export, and the Table's "Tags" column all read/write this same list. Colours are derived
// deterministically from the tag string, so tags need no option definitions.

// Deterministic colour for a tag string (stable hue per tag).
export function tagColor(t) {
  let h = 0
  const s = String(t || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return `hsl(${h} 55% 48%)`
}

// Normalise a raw tag string: trim, drop a leading '#', collapse inner whitespace to '-'.
export function normalizeTag(raw) {
  return String(raw || '').trim().replace(/^#+/, '').trim().replace(/\s+/g, '-')
}

// Read a node's tags as a string[] (tolerant of missing meta).
export function nodeTags(node) {
  return (node && node.meta && Array.isArray(node.meta.tags)) ? node.meta.tags : []
}
