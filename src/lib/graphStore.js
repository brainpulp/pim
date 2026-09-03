import { create } from 'zustand'
import { slugifyFlowId } from './flowchart'

const uid = () => crypto.randomUUID()

export const NODE_R = 44

export const DEFAULT_NODE_PROPS = {
  scale: 1,
  fillColor: '#12122a',
  textColor: '#ffffff',
  strokeColor: null,   // no outline by default (selection/anchor draw their own rings)
  visible: true,
  fx: null,
  fy: null,
  shape: 'circle', // 'circle' | 'ellipse' | 'roundrect' | 'rect' | 'diamond' | 'none' | 'frame'
  containedIn: null, // nodeId of a frame node, or null (per-view)
}

// Unified palette for fill/text/background colors. Radix Colors (MIT) — the step-9 "solid" values,
// engineered to be vivid and legible on dark UIs, arranged by hue; plus a light-tint row and neutrals.
export const PALETTE = [
  // Vivid solids (Radix step 9), red → pink around the wheel
  '#e5484d', '#e54d2e', '#f76b15', '#ffb224', '#ffc53d',
  '#bdee63', '#46a758', '#30a46c', '#12a594', '#00a2c7',
  '#0090ff', '#3e63dd', '#6e56cf', '#8e4ec6', '#ab4aba',
  '#d6409f', '#e93d82', '#7ce2fe',
  // Light tints (soft fills / light text)
  '#ffd1c9', '#ffe4a3', '#d7f5c4', '#c4f1e8', '#cfe0ff', '#e7d7ff',
  // Neutrals (white → near-black)
  '#ffffff', '#c5d0ff', '#8b93b8', '#4a5272', '#232a3e', '#0f1420',
]

export const SHAPES = ['circle', 'ellipse', 'roundrect', 'rect', 'diamond', 'none', 'image']

// Cosmetic props captured by a saved node "style" (snapshot). View-dependent props only.
export const STYLE_KEYS = ['fillColor', 'textColor', 'strokeColor', 'strokeWidth', 'strokeDash', 'shape', 'scale', 'nodeEmojis', 'shadow', 'opacity', 'borderFx', 'borderFxAmp', 'borderFxCount', 'spin']

export const COLOR_PALETTE = PALETTE
export const FILL_COLORS = PALETTE
// Palette for kanban column option colors (matches PropertyField's select-option palette).
const KANBAN_OPT_COLORS = ['#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']
export const TEXT_COLORS = PALETTE

export const BG_COLORS = [
  '#0c0c1a', '#0a0a0a', '#0d1117', '#0f1923',
  '#1a0a0a', '#0a1a0a', '#1a1200', '#130a1a',
  '#111827', '#1e1b2e', '#162032', '#0d1f12',
]

// Slide backgrounds want a full, normal palette (lights, pastels, vivids, darks) —
// not the near-black canvas palette above.
export const SLIDE_BG_COLORS = [
  '#ffffff', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8',
  '#fee2e2', '#ffedd5', '#fef9c3', '#dcfce7', '#cffafe', '#dbeafe', '#ede9fe', '#fce7f3',
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  '#334155', '#1e293b', '#0f172a', '#0c0c1a',
]

// Helper: update nodeProps for a specific node in the active view
const patchViewNode = (views, activeViewId, nodeId, patch) =>
  views.map(v => v.id !== activeViewId ? v : {
    ...v,
    nodeProps: {
      ...v.nodeProps,
      [nodeId]: { ...DEFAULT_NODE_PROPS, ...(v.nodeProps[nodeId] || {}), ...patch },
    },
  })

const _undoHistory = []
const MAX_UNDO = 50

// Cosmetic props that make up a node's "look". New nodes inherit the last-changed values of these
// (see lastStyle below), so styling one node carries forward to the next you create — even across
// sessions (persisted to localStorage). Shape is captured only for basic shapes, never frame/3d/image.
export const LAST_STYLE_PROPS = ['fillColor', 'textColor', 'strokeColor', 'strokeWidth', 'strokeDash', 'opacity', 'shape', 'shadow', 'borderBlur', 'borderFx', 'borderFxAmp', 'borderFxCount', 'spin', 'nodeMotion', 'nodeColorCycle']
// A brand-new node inherits ONLY the plain look (color/shape/opacity) from the last-styled node —
// never the decorative border effects, blur, spin, or motion (those made every new empty node look
// like "patchwork"). Duplicate/sister still copy the full style.
export const NEW_NODE_STYLE_PROPS = ['fillColor', 'textColor', 'strokeColor', 'strokeWidth', 'strokeDash', 'opacity', 'shape']
const BASIC_SHAPES = new Set(['circle', 'ellipse', 'roundrect', 'rect', 'diamond', 'none'])
const LS_KEY = 'pim_last_node_style'
const loadLastStyle = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {} } catch { return {} } }
const saveLastStyle = (obj) => { try { localStorage.setItem(LS_KEY, JSON.stringify(obj)) } catch { /* ignore */ } }

const useGraphStore = create((set, get) => ({
  // Which project's snapshot is currently in the store (guards loads + gates autosave across all tabs).
  loadedProjectId: null,

  // â”€â”€ View-independent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  nodes: [],
  edges: [],

  // â”€â”€ Notion-style DB schema (per project). propertyDefs describes the columns;
  // each node stores values in node.props[propId]. Types: text|number|date|checkbox|select|multiSelect|url.
  propertyDefs: [],

  // â”€â”€ Reusable node styles (cosmetic snapshots, view-independent list). Applied into a view's nodeProps.
  styles: [],

  // Last cosmetic values applied to any node — new nodes inherit these. Persisted across sessions.
  lastStyle: loadLastStyle(),

  // â”€â”€ Views â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  views: [{ id: 'view-default', name: 'Default', nodeProps: {}, drillRoot: null, bgColor: '#0c0c1a', images: [], customEmojis: [], slides: [], slideshows: [{ id: 'ss-default', name: 'Default', slides: [] }], activeSlideshowId: 'ss-default' }],
  activeViewId: 'view-default',

  // Undo history (module-level array, not reactive state)
  pushUndo: () => {
    const s = get()
    _undoHistory.push(JSON.parse(JSON.stringify({ nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId })))
    if (_undoHistory.length > MAX_UNDO) _undoHistory.shift()
  },
  undo: () => {
    if (!_undoHistory.length) return
    const prev = _undoHistory.pop()
    set({ nodes: prev.nodes, edges: prev.edges, views: prev.views, activeViewId: prev.activeViewId })
  },


  // â”€â”€ Load a full project snapshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  loadProjectData: ({ nodes, edges, views, activeViewId, propertyDefs, styles, loadedProjectId }) => set({
    loadedProjectId: loadedProjectId ?? null,
    nodes: nodes || [],
    edges: edges || [],
    propertyDefs: propertyDefs || [],
    styles: styles || [],
    views: views?.length ? views.map(v => {
      const merged = { bgColor: '#0c0c1a', images: [], customEmojis: [], ...v }
      if (!merged.slides) {
        merged.slides = Object.entries(merged.nodeProps || {})
          .filter(([, p]) => p.shape === 'frame')
          .map(([id]) => id)
      }
      // Migrate old per-view slides to slideshows format
      if (!merged.slideshows) {
        merged.slideshows = [{ id: 'ss-default', name: 'Default', slides: merged.slides || [] }]
        merged.activeSlideshowId = 'ss-default'
      }
      return merged
    }) : [{ id: 'view-default', name: 'Default', nodeProps: {}, drillRoot: null, bgColor: '#0c0c1a', images: [], customEmojis: [], slides: [], slideshows: [{ id: 'ss-default', name: 'Default', slides: [] }], activeSlideshowId: 'ss-default' }],
    activeViewId: activeViewId || 'view-default',
  }),

  // â”€â”€ Node styles (snapshot cosmetics) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Capture the active-view look of a node as a reusable named style.
  saveStyleFromNode: (nodeId, name) => {
    const s = get()
    const vp = s.views.find(v => v.id === s.activeViewId)?.nodeProps?.[nodeId] || {}
    const props = {}
    STYLE_KEYS.forEach(k => { if (vp[k] !== undefined) props[k] = vp[k] })
    const id = uid()
    set(st => ({ styles: [...st.styles, { id, name: name || 'Style', props }] }))
    return id
  },
  updateStyleFromNode: (id, nodeId) => set(s => {
    const vp = s.views.find(v => v.id === s.activeViewId)?.nodeProps?.[nodeId] || {}
    const props = {}
    STYLE_KEYS.forEach(k => { if (vp[k] !== undefined) props[k] = vp[k] })
    return { styles: s.styles.map(x => x.id === id ? { ...x, props } : x) }
  }),
  renameStyle: (id, name) => set(s => ({ styles: s.styles.map(x => x.id === id ? { ...x, name } : x) })),
  deleteStyle: (id) => set(s => ({ styles: s.styles.filter(x => x.id !== id) })),
  // Apply a style's props into the active view's nodeProps for each node id.
  applyStyle: (styleId, nodeIds) => set(s => {
    const st = s.styles.find(x => x.id === styleId); if (!st) return {}
    let views = s.views
    ;(nodeIds || []).forEach(nid => { views = patchViewNode(views, s.activeViewId, nid, st.props) })
    // Applying a saved style also sets it as the look new nodes inherit.
    const ls = { ...s.lastStyle }
    Object.entries(st.props).forEach(([k, v]) => { if (LAST_STYLE_PROPS.includes(k) && !(k === 'shape' && !BASIC_SHAPES.has(v))) ls[k] = v })
    saveLastStyle(ls)
    return { views, lastStyle: ls }
  }),

  // â”€â”€ Node ops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  updateNotes: (id, notes) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, notes } : n),
  })),

  addNode: (label = 'New node', parentId = null, x = null, y = null) => {
    const id = uid()
    set(s => {
      const ls = s.lastStyle || {}
      const inherit = {}
      NEW_NODE_STYLE_PROPS.forEach(k => { if (k in ls) inherit[k] = ls[k] })   // plain look only — no borderFx/spin/motion
      return {
        nodes: [...s.nodes, { id, label, notes: '' }],
        edges: parentId ? [...s.edges, { id: uid(), source: parentId, target: id }] : s.edges,
        views: s.views.map(v => v.id !== s.activeViewId ? v : {
          ...v,
          nodeProps: {
            ...v.nodeProps,
            [id]: { ...DEFAULT_NODE_PROPS, ...inherit, ...(x !== null ? { fx: x, fy: y } : {}) },
          },
        }),
      }
    })
    return id
  },

  // Duplicate ONE node (no children) at position (x,y): a sister under the same parent, or a floating
  // root if the source has no parent. Copies label, notes, meta, props, and the active view's style.
  duplicateNodeAt: (nodeId, x, y) => {
    const s = get()
    const src = s.nodes.find(n => n.id === nodeId)
    if (!src) return null
    const parentId = s.edges.find(e => e.target === nodeId)?.source || null
    const newId = uid()
    const srcVp = s.views.find(v => v.id === s.activeViewId)?.nodeProps?.[nodeId] || {}
    const newNode = { ...src, id: newId, meta: src.meta ? { ...src.meta } : undefined, props: src.props ? { ...src.props } : undefined }
    set(st => ({
      nodes: [...st.nodes, newNode],
      edges: parentId ? [...st.edges, { id: uid(), source: parentId, target: newId }] : st.edges,
      views: st.views.map(v => v.id !== st.activeViewId ? v : {
        ...v, nodeProps: { ...v.nodeProps, [newId]: { ...DEFAULT_NODE_PROPS, ...srcVp, fx: x, fy: y } },
      }),
    }))
    return newId
  },

  // Deep-copy srcNode's whole subtree of children UNDER targetNode (used after duplicateNodeAt when the
  // source had children and the user chose "with children"). Offsets anchored positions by the move delta.
  copyChildrenInto: (srcId, targetId) => set(s => {
    const kids = {}; s.edges.forEach(e => { (kids[e.source] = kids[e.source] || []).push(e.target) })
    const vp = s.views.find(v => v.id === s.activeViewId)?.nodeProps || {}
    const dx = (vp[targetId]?.fx ?? 0) - (vp[srcId]?.fx ?? 0)
    const dy = (vp[targetId]?.fy ?? 0) - (vp[srcId]?.fy ?? 0)
    const byId = Object.fromEntries(s.nodes.map(n => [n.id, n]))
    const newNodes = [], newEdges = [], newProps = {}, seen = new Set([srcId])
    const clone = (origId, newParentId) => {
      (kids[origId] || []).forEach(childId => {
        if (seen.has(childId)) return   // cycle / shared-node guard: copy each descendant once
        seen.add(childId)
        const c = byId[childId]; if (!c) return
        const nid = uid()
        newNodes.push({ ...c, id: nid, meta: c.meta ? { ...c.meta } : undefined, props: c.props ? { ...c.props } : undefined })
        newEdges.push({ id: uid(), source: newParentId, target: nid })
        const cvp = vp[childId]
        if (cvp) { const nv = { ...cvp }; if (nv.fx != null) nv.fx += dx; if (nv.fy != null) nv.fy += dy; newProps[nid] = nv }
        clone(childId, nid)
      })
    }
    clone(srcId, targetId)
    return {
      nodes: [...s.nodes, ...newNodes],
      edges: [...s.edges, ...newEdges],
      views: s.views.map(v => v.id !== s.activeViewId ? v : { ...v, nodeProps: { ...v.nodeProps, ...newProps } }),
    }
  }),

  updateLabel: (id, label) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, label } : n),
  })),

  // Per-item rich text styling for the Writer/outline mode (view-independent): { bold, italic, color, metallic }.
  // Shared cross-surface selection — the sync channel between the canvas (board/graph) and the docked
  // outliner. Not persisted; ephemeral UI state.
  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  navFocusNodeId: null,   // node the keyboard arrow-nav is focused on (highlighted distinctly in the outliner)
  setNavFocusNodeId: (id) => set({ navFocusNodeId: id }),
  // Shared image selection (from the docked outliner's Images section) → the canvas selects that photo
  // and pans/zooms to it. The nonce lets the same photo be re-selected (re-jumped) repeatedly.
  selectedImageReq: null,   // { id, nonce } | null
  selectImageFromOutline: (id) => set(s => ({ selectedImageReq: { id, nonce: (s.selectedImageReq?.nonce || 0) + 1 } })),

  // Shared canvas-panel toggles (Draw / Slides / Views). Lifted out of Graph.jsx so the nav "View" menu
  // in App.jsx can drive them too. Setters accept a value OR a React-style updater fn, so existing
  // Graph call sites (e.g. setShowDraw(v => !v)) keep working unchanged.
  showDraw: false,
  showSlideSidebar: false,
  showViews: (() => { try { return localStorage.getItem('pim_show_views') !== '0' } catch { return true } })(),
  setShowDraw: (v) => set(s => ({ showDraw: typeof v === 'function' ? v(s.showDraw) : v })),
  setShowSlideSidebar: (v) => set(s => ({ showSlideSidebar: typeof v === 'function' ? v(s.showSlideSidebar) : v })),
  setShowViews: (v) => set(s => {
    const next = typeof v === 'function' ? v(s.showViews) : v
    try { localStorage.setItem('pim_show_views', next ? '1' : '0') } catch { /* ignore */ }
    return { showViews: next }
  }),

  setNodeWriteStyle: (id, patch) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, writeStyle: { ...(n.writeStyle || {}), ...patch } } : n),
  })),

  // ── Node metadata (view-independent, queryable everywhere) — the outliner's markdown/tag system writes
  // these: itemType ('task'|'note'|'idea'|'question'|'event'…), done, due (ISO), priority, tags[], people[],
  // fields{key:value}, heading (0|1|2). Stored on the node so a "task" typed in the writer is findable
  // in the table, graph, and any future database view.
  setNodeMeta: (id, patch) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, meta: { ...(n.meta || {}), ...patch } } : n),
  })),
  addNodeTag: (id, tag) => set(s => {
    const clean = String(tag || '').trim().replace(/^#+/, '').trim().replace(/\s+/g, '-')
    if (!clean) return {}
    const nodes = s.nodes.map(n => {
      if (n.id !== id) return n
      const tags = (n.meta?.tags) || []
      return tags.includes(clean) ? n : { ...n, meta: { ...(n.meta || {}), tags: [...tags, clean] } }
    })
    // Auto-surface a single canonical "Tags" column so tags added anywhere show up in the Table.
    const hasTagsCol = s.propertyDefs.some(p => p.type === 'tags')
    const propertyDefs = hasTagsCol ? s.propertyDefs : [...s.propertyDefs, { id: uid(), name: 'Tags', type: 'tags' }]
    return { nodes, propertyDefs }
  }),
  removeNodeTag: (id, tag) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, meta: { ...(n.meta || {}), tags: ((n.meta?.tags) || []).filter(t => t !== tag) } } : n),
  })),
  addNodePerson: (id, person) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== id) return n
      const people = (n.meta?.people) || []
      return people.includes(person) ? n : { ...n, meta: { ...(n.meta || {}), people: [...people, person] } }
    }),
  })),
  setNodeField: (id, key, value) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, meta: { ...(n.meta || {}), fields: { ...((n.meta?.fields) || {}), [key]: value } } } : n),
  })),
  removeNodeField: (id, key) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== id) return n
      const fields = { ...((n.meta?.fields) || {}) }; delete fields[key]
      return { ...n, meta: { ...(n.meta || {}), fields } }
    }),
  })),

  setImageUrl: (id, imageUrl) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, imageUrl } : n),
  })),

  // Cross-project link (view-independent, on the node): { projectId, projectName, nodeId? } | null.
  // Clicking such a node navigates to the other project (App handles the back-stack).
  setNodeLink: (id, linkTo) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, linkTo: linkTo || undefined } : n),
  })),

  set3DModel: (id, modelData, modelType) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, modelData, modelType, modelThumb: null } : n),
  })),

  setModelThumb: (id, modelThumb) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, modelThumb } : n),
  })),

  deleteNode: (id) => set(s => ({
    nodes: s.nodes.filter(n => n.id !== id),
    edges: s.edges.filter(e => e.source !== id && e.target !== id),
    views: s.views.map(v => {
      const { [id]: _, ...rest } = v.nodeProps
      return {
        ...v, nodeProps: rest,
        slides: (v.slides || []).filter(sid => sid !== id),
        slideshows: (v.slideshows || []).map(ss => ({ ...ss, slides: ss.slides.filter(sid => sid !== id) })),
      }
    }),
  })),

  // â”€â”€ Property (Notion-DB column) ops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  addPropertyDef: (type = 'text', name) => {
    const id = uid()
    const labels = { text:'Text', number:'Number', date:'Date', checkbox:'Checkbox', select:'Select', multiSelect:'Multi-select', tags:'Tags', url:'URL' }
    // "Tags" is a canonical singleton backed by node.meta.tags — never create a second one.
    if (type === 'tags') {
      const existing = get().propertyDefs.find(p => p.type === 'tags')
      if (existing) return existing.id
    }
    const def = { id, name: name || labels[type] || 'Property', type }
    if (type === 'select' || type === 'multiSelect') def.options = []
    set(s => ({ propertyDefs: [...s.propertyDefs, def] }))
    return id
  },

  updatePropertyDef: (id, patch) => set(s => ({
    propertyDefs: s.propertyDefs.map(p => p.id === id ? { ...p, ...patch } : p),
  })),

  deletePropertyDef: (id) => set(s => ({
    propertyDefs: s.propertyDefs.filter(p => p.id !== id),
    // strip the value from every node so we don't leave orphans
    nodes: s.nodes.map(n => {
      if (!n.props || !(id in n.props)) return n
      const { [id]: _drop, ...rest } = n.props
      return { ...n, props: rest }
    }),
  })),

  reorderPropertyDefs: (newDefs) => set({ propertyDefs: newDefs }),

  // Add an option to a select/multiSelect property; returns the option id.
  addSelectOption: (propId, name, color) => {
    const optId = uid()
    set(s => ({
      propertyDefs: s.propertyDefs.map(p => p.id !== propId ? p : {
        ...p, options: [...(p.options || []), { id: optId, name, color: color || '#6366f1' }],
      }),
    }))
    return optId
  },

  // Rename a select/multiSelect option (label only; id and node values are untouched).
  renameSelectOption: (propId, optId, name) => set(s => ({
    propertyDefs: s.propertyDefs.map(p => p.id !== propId ? p : {
      ...p, options: (p.options || []).map(o => o.id === optId ? { ...o, name } : o),
    }),
  })),

  // Recolor a select/multiSelect option.
  recolorSelectOption: (propId, optId, color) => set(s => ({
    propertyDefs: s.propertyDefs.map(p => p.id !== propId ? p : {
      ...p, options: (p.options || []).map(o => o.id === optId ? { ...o, color } : o),
    }),
  })),

  // Delete a select/multiSelect option and strip that value from every node.
  deleteSelectOption: (propId, optId) => set(s => ({
    propertyDefs: s.propertyDefs.map(p => p.id !== propId ? p : {
      ...p, options: (p.options || []).filter(o => o.id !== optId),
    }),
    nodes: s.nodes.map(n => {
      const v = n.props?.[propId]; if (v == null) return n
      if (Array.isArray(v)) {
        if (!v.includes(optId)) return n
        return { ...n, props: { ...n.props, [propId]: v.filter(x => x !== optId) } }
      }
      if (v !== optId) return n
      return { ...n, props: { ...n.props, [propId]: null } }
    }),
  })),

  // Set a node's value for a property. value shape depends on type
  // (string | number | boolean | ISO date string | optionId | optionId[]).
  setNodeProp: (nodeId, propId, value) => set(s => ({
    nodes: s.nodes.map(n => n.id === nodeId ? { ...n, props: { ...(n.props || {}), [propId]: value } } : n),
  })),

  // â”€â”€ Edge ops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  addEdge: (source, target) => {
    if (source === target) return
    if (get().edges.find(e => e.source === source && e.target === target)) return
    set(s => ({ edges: [...s.edges, { id: uid(), source, target }] }))
  },

  removeEdge: (id) => set(s => ({ edges: s.edges.filter(e => e.id !== id) })),

  reparentNode: (nodeId, newParentId) => set(s => {
    // Guard against cycles: re-parenting a node UNDER one of its own descendants would disconnect
    // that whole branch from the graph (unreachable → it vanishes from drill/hierarchy views and
    // never comes back). Reject such a move (no-op) so nodes can't be lost this way.
    if (newParentId && newParentId !== nodeId) {
      const childrenOf = {}
      s.edges.forEach(e => { (childrenOf[e.source] = childrenOf[e.source] || []).push(e.target) })
      const desc = new Set(); const stack = [nodeId]
      while (stack.length) { const c = stack.pop(); (childrenOf[c] || []).forEach(t => { if (!desc.has(t)) { desc.add(t); stack.push(t) } }) }
      if (desc.has(newParentId)) return {}   // would create a cycle → refuse
    }
    const edges = s.edges.filter(e => e.target !== nodeId)
    if (newParentId && newParentId !== nodeId) edges.push({ id: uid(), source: newParentId, target: nodeId })
    return { edges }
  }),

  // â”€â”€ View-dependent node props â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  setNodeViewProp: (nodeId, prop, value) => set(s => {
    const views = patchViewNode(s.views, s.activeViewId, nodeId, { [prop]: value })
    const out = { views }
    // Touching ANY style prop makes this node's WHOLE look the default for new nodes — color, motion,
    // border, shadow, everything — not just the one prop you changed. Snapshot the node's full style.
    if (LAST_STYLE_PROPS.includes(prop) && !(prop === 'shape' && !BASIC_SHAPES.has(value))) {
      const vp = views.find(v => v.id === s.activeViewId)?.nodeProps?.[nodeId] || {}
      const ls = {}
      LAST_STYLE_PROPS.forEach(k => {
        if (!(k in vp)) return
        if (k === 'shape' && !BASIC_SHAPES.has(vp[k])) return   // never propagate frame/3d/image as a default
        ls[k] = vp[k]
      })
      saveLastStyle(ls); out.lastStyle = ls
    }
    return out
  }),

  setContainedIn: (nodeId, containerId) => set(s => ({
    views: patchViewNode(s.views, s.activeViewId, nodeId, { containedIn: containerId }),
  })),

  // Reroute a container's contained-children links: 'grandmother' makes each child a child of the
  // container's OWN parent (skipping the container in the tree); 'container' points them back at the
  // container. Membership stays in containedIn (spatial); this only rewrites the logical edges.
  rerouteContainerLinks: (containerId, mode) => set(s => {
    const gm = s.edges.find(e => e.target === containerId)?.source || null   // the container's parent
    const kids = s.nodes.filter(n => {
      const vp = s.views.find(v => v.id === s.activeViewId)?.nodeProps?.[n.id]
      return vp?.containedIn === containerId
    }).map(n => n.id)
    let edges = s.edges
    const hasEdge = (src, tgt) => edges.some(e => e.source === src && e.target === tgt)
    const rid = () => (crypto?.randomUUID ? crypto.randomUUID() : 'e' + edges.length + Math.floor(performance.now()))
    kids.forEach(kid => {
      if (mode === 'grandmother') {
        if (gm && gm !== kid) {   // only reroute when there's actually a grandmother to point at
          edges = edges.filter(e => !(e.source === containerId && e.target === kid))   // drop container→kid
          if (!hasEdge(gm, kid)) edges = [...edges, { id: rid(), source: gm, target: kid }]
        }
      } else {
        if (gm) edges = edges.filter(e => !(e.source === gm && e.target === kid))     // drop grandmother→kid
        if (containerId !== kid && !hasEdge(containerId, kid)) edges = [...edges, { id: rid(), source: containerId, target: kid }]
      }
    })
    return { edges }
  }),

  setAnchor: (id, fx, fy) => set(s => ({
    views: patchViewNode(s.views, s.activeViewId, id, { fx, fy }),
  })),

  releaseAnchor: (id) => set(s => ({
    views: patchViewNode(s.views, s.activeViewId, id, { fx: null, fy: null }),
  })),

  releaseAllAnchors: () => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v,
      nodeProps: Object.fromEntries(
        Object.entries(v.nodeProps).map(([id, p]) => [id, { ...p, fx: null, fy: null }])
      ),
    }),
  })),

  // â”€â”€ Slide ops (operate on the active slideshow of the active view) â”€â”€â”€â”€
  addSlide: (frameId) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v,
      slideshows: (v.slideshows || []).map(ss => ss.id !== v.activeSlideshowId ? ss : {
        ...ss, slides: ss.slides.includes(frameId) ? ss.slides : [...ss.slides, frameId],
      }),
    }),
  })),

  removeSlide: (frameId) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v,
      slideshows: (v.slideshows || []).map(ss => ss.id !== v.activeSlideshowId ? ss : {
        ...ss, slides: ss.slides.filter(id => id !== frameId),
      }),
    }),
  })),

  reorderSlides: (newSlides) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v,
      slideshows: (v.slideshows || []).map(ss => ss.id !== v.activeSlideshowId ? ss : { ...ss, slides: newSlides }),
    }),
  })),

  setSlideBgColor: (ssId, slideId, color) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v,
      slideshows: (v.slideshows || []).map(ss => ss.id !== ssId ? ss : {
        ...ss, slideBgColors: { ...(ss.slideBgColors || {}), [slideId]: color },
      }),
    }),
  })),

  // â”€â”€ Slideshow management (per view) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  addSlideshow: (name = 'New Slideshow') => {
    const id = uid()
    set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v,
        slideshows: [...(v.slideshows || []), { id, name, slides: [] }],
        activeSlideshowId: id,
      }),
    }))
    return id
  },

  deleteSlideshow: (ssId) => set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      const remaining = (v.slideshows || []).filter(ss => ss.id !== ssId)
      if (!remaining.length) return v
      return {
        ...v,
        slideshows: remaining,
        activeSlideshowId: v.activeSlideshowId === ssId ? remaining[0].id : v.activeSlideshowId,
      }
    }),
  })),

  renameSlideshow: (ssId, name) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v,
      slideshows: (v.slideshows || []).map(ss => ss.id !== ssId ? ss : { ...ss, name }),
    }),
  })),

  setActiveSlideshowId: (ssId) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : { ...v, activeSlideshowId: ssId }),
  })),

  // â”€â”€ Image ops (per view) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  addImage: (src, x, y, width, height) => {
    const id = uid()
    set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, images: [...(v.images || []), { id, src, x, y, width, height, rotation: 0, bgColor: null }],
      }),
    }))
    return id
  },

  // A rich-text box — a canvas element (not a graph node) stored in the SAME view.images[] array, so it
  // shares selection / drag / resize / group / delete. `html` holds the formatted content.
  addTextBox: (x, y, width = 220, height = 60, html = '') => {
    const id = uid()
    set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, images: [...(v.images || []), { id, type: 'text', x, y, width, height, rotation: 0, bgColor: null, html }],
      }),
    }))
    return id
  },

  // A video is stored in the SAME view.images[] array (so it shares selection/drag/resize/group/delete)
  // but flagged type:'video'. fields = { videoKind:'youtube', youtubeId } | { videoKind:'file', src }.
  addVideo: (fields, x, y, width, height) => {
    const id = uid()
    set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, images: [...(v.images || []), { id, type: 'video', x, y, width, height, rotation: 0, bgColor: null, ...fields }],
      }),
    }))
    return id
  },

  // A link-preview card ("unfurled" URL, like WhatsApp/Discord). Stored in the SAME view.images[] array
  // (shares selection/drag/resize/group/delete) but flagged type:'link'. fields carry the fetched preview:
  // { url, title, description, image, siteName, favicon, loading? }. Starts with just the url + loading:true
  // until the unfurl edge function fills in the rest (via updateImage).
  addLink: (fields, x, y, width, height) => {
    const id = uid()
    set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, images: [...(v.images || []), { id, type: 'link', x, y, width, height, rotation: 0, bgColor: null, ...fields }],
      }),
    }))
    return id
  },

  // Audio clip, stored in the SAME view.images[] array (shares selection/drag/resize/delete) but
  // flagged type:'audio'. fields = { src, title, autoplayOnZoom?, autoplayOnSlide? }. src is a public
  // URL (pasted link or Storage-offloaded upload).
  addAudio: (fields, x, y, width, height) => {
    const id = uid()
    set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, images: [...(v.images || []), { id, type: 'audio', x, y, width, height, rotation: 0, bgColor: null, ...fields }],
      }),
    }))
    return id
  },

  updateImage: (imageId, props) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v, images: (v.images || []).map(img => img.id === imageId ? { ...img, ...props } : img),
    }),
  })),

  // ── Drawing layer (per-view decorations: shapes/lines/arrows/emoji/text) ──────
  // Floating annotations saved on the view (like images) — NOT graph nodes (no outline, no node-data
  // sync). They render on the canvas and on slides. A drawing: { id, kind, ...geometry, ...style }.
  addDrawing: (drawing) => {
    const id = uid()
    set(s => ({ views: s.views.map(v => v.id !== s.activeViewId ? v : { ...v, drawings: [...(v.drawings || []), { id, ...drawing }] }) }))
    return id
  },
  updateDrawing: (id, props) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : { ...v, drawings: (v.drawings || []).map(d => d.id === id ? { ...d, ...props } : d) }),
  })),
  deleteDrawing: (id) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : { ...v, drawings: (v.drawings || []).filter(d => d.id !== id) }),
  })),

  // Promote a free image/video (view.images[]) into a real child NODE that carries the media on
  // `node.media`. It then participates in the graph fully — edges, outliner, collapse, shift-drag —
  // and is rendered from the media instead of a shape. Removes the images[] entry. Returns the node id.
  convertImageToNode: (imageId, parentId = null) => {
    const nid = uid()
    set(s => {
      const v0 = s.views.find(v => v.id === s.activeViewId)
      const img = (v0?.images || []).find(i => i.id === imageId)
      if (!img) return {}
      const isVideo = img.type === 'video'
      const media = isVideo
        ? { kind: 'video', width: img.width, height: img.height, videoKind: img.videoKind, youtubeId: img.youtubeId, src: img.src,
            autoplay: img.autoplay, loop: img.loop, muted: img.muted, controls: img.controls, hideRelated: img.hideRelated,
            start: img.start, end: img.end, speed: img.speed }
        : { kind: 'image', width: img.width, height: img.height, src: img.src, crop: img.crop, blur: img.blur, edgeBlur: img.edgeBlur, rotation: img.rotation }
      const label = img.title || (isVideo ? 'video' : 'image')
      return {
        nodes: [...s.nodes, { id: nid, label, notes: '', media }],
        edges: (parentId && s.nodes.some(n => n.id === parentId)) ? [...s.edges, { id: uid(), source: parentId, target: nid }] : s.edges,
        views: s.views.map(v => v.id !== s.activeViewId ? v : {
          ...v,
          images: (v.images || []).filter(i => i.id !== imageId),
          nodeProps: { ...v.nodeProps, [nid]: { ...DEFAULT_NODE_PROPS, fx: img.x, fy: img.y } },
        }),
      }
    })
    return nid
  },

  // Patch a media node's `media` (e.g. width/height on resize, or a video option).
  updateNodeMedia: (id, patch) => set(s => ({
    nodes: s.nodes.map(n => (n.id === id && n.media) ? { ...n, media: { ...n.media, ...patch } } : n),
  })),

  deleteImage: (imageId) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v, images: (v.images || []).filter(img => img.id !== imageId),
    }),
  })),

  groupImages: (imageIds) => {
    const idSet = new Set(imageIds)
    // uid() must be outside set() — Zustand may call the updater multiple times
    const gid = uid()
    set(s => ({
      views: s.views.map(v => {
        if (v.id !== s.activeViewId) return v
        // Collect the old groupIds of selected images, to check for orphaned siblings after
        const oldGroupIds = new Set(
          (v.images || []).filter(i => idSet.has(i.id) && i.groupId).map(i => i.groupId)
        )
        // Assign new groupId to selected images
        let imgs = (v.images || []).map(img =>
          idSet.has(img.id) ? { ...img, groupId: gid } : img
        )
        // selected images now have groupId===gid so they won't match oldGroupIds here
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

  ungroupImages: (imageIds) => {
    const idSet = new Set(imageIds)
    return set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, images: (v.images || []).map(img =>
          idSet.has(img.id) ? { ...img, groupId: null } : img
        ),
      }),
    }))
  },

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

  deleteImages: (imageIds) => {
    const idSet = new Set(imageIds)
    return set(s => ({
      views: s.views.map(v => {
        if (v.id !== s.activeViewId) return v
        const remaining = (v.images || []).filter(img => !idSet.has(img.id))
        // Orphan cleanup: if a group now has only 1 member, clear its groupId
        const groupCounts = {}
        remaining.forEach(img => { if (img.groupId) groupCounts[img.groupId] = (groupCounts[img.groupId] || 0) + 1 })
        return {
          ...v, images: remaining.map(img =>
            img.groupId && groupCounts[img.groupId] === 1 ? { ...img, groupId: null } : img
          ),
        }
      }),
    }))
  },

  // ── Custom uploaded emojis (per view) ──────────────────────────
  addCustomEmoji: (name, src) => {
    const id = uid()
    set(s => ({
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, customEmojis: [...(v.customEmojis || []), { id, name, src }],
      }),
    }))
    return id
  },

  removeCustomEmoji: (emojiId) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v, customEmojis: (v.customEmojis || []).filter(e => e.id !== emojiId),
    }),
  })),

  // â”€â”€ View ops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  addView: (name = 'New View') => {
    const id = uid()
    set(s => ({
      views: [...s.views, { id, name, nodeProps: {}, drillRoot: null, images: [], customEmojis: [], slides: [] }],
      activeViewId: id,
    }))
    return id
  },

  duplicateView: (viewId) => {
    const src = get().views.find(v => v.id === viewId)
    if (!src) return
    const id = uid()
    set(s => ({
      views: [...s.views, {
        ...src, id,
        name: src.name + ' copy',
        nodeProps: Object.fromEntries(Object.entries(src.nodeProps).map(([k, v]) => [k, { ...v }])),
        slides: [...(src.slides || [])],
      }],
      activeViewId: id,
    }))
  },

  renameView: (viewId, name) => set(s => ({
    views: s.views.map(v => v.id === viewId ? { ...v, name } : v),
  })),

  deleteView: (viewId) => set(s => {
    const remaining = s.views.filter(v => v.id !== viewId)
    if (!remaining.length) return s
    return {
      views: remaining,
      activeViewId: s.activeViewId === viewId ? remaining[0].id : s.activeViewId,
    }
  }),

  setActiveView: (viewId) => set({ activeViewId: viewId }),

  setViewBgColor: (color) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, bgColor: color } : v),
  })),

  // Board (multi-pack/tree canvas) layout lives on the active view so it syncs across devices.
  setBoardSystems: (systems) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, boardSystems: systems } : v),
  })),

  // Board-only hidden node ids (per active view). Kept SEPARATE from the shared `visible` flag so
  // hiding on the board does NOT hide the same node in the graph (modes are independent lenses).
  setViewBoardHidden: (ids) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, boardHidden: ids } : v),
  })),

  // Free nodes placed directly on the board canvas (per active view). `boardNodes` is a map
  // { [nodeId]: {x, y} } of world coords. A node here is a standalone piece on the board (NOT part
  // of any cluster); clusters exclude these ids so a node is EITHER free OR clustered, never both.
  setViewBoardNode: (nodeId, pos) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId
      ? { ...v, boardNodes: { ...(v.boardNodes || {}), [nodeId]: pos } } : v),
  })),
  removeViewBoardNode: (nodeId) => set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      const next = { ...(v.boardNodes || {}) }
      delete next[nodeId]
      return { ...v, boardNodes: next }
    }),
  })),

  // Pack/board property filter, persisted on the active view (survives reload + syncs across devices).
  setViewFilter: (filter) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, filter } : v),
  })),

  // Anchored pack positions per grouping property, persisted on the active view.
  setViewPackLayout: (propId, layout) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, packLayout: { ...(v.packLayout || {}), [propId]: layout } } : v),
  })),

  // "Color by" property for pack/board bubbles (null = by pack value), persisted on the active view.
  setViewColorBy: (colorBy) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, colorBy } : v),
  })),

  // Board pan/zoom transform, persisted on the active view so it restores on reload.
  setViewBoardTf: (boardTf) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, boardTf } : v),
  })),

  setViewPan: (x, y, k) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : { ...v, pan: { x, y, k } }),
  })),

  toggleCollapseNode: (nodeId) => set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      const c = new Set(v.collapsedNodeIds || [])
      if (c.has(nodeId)) c.delete(nodeId); else c.add(nodeId)
      return { ...v, collapsedNodeIds: [...c] }
    })
  })),

  // Set the collapsed set outright (used by the depth slider to collapse/expand by level).
  setCollapsedNodes: (ids) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, collapsedNodeIds: [...new Set(ids)] } : v),
  })),

  // Pose the live document to a frame-stage snapshot (keyframe editing): for each captured member set
  // its anchor (fx/fy), visibility, scale and collapse state, all in ONE atomic update (no per-prop
  // style-propagation side effects). `snap` = { [nodeId]: { v, x, y, s, c } }.
  applyStagePose: (snap) => set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      const nodeProps = { ...v.nodeProps }
      const collapsed = new Set(v.collapsedNodeIds || [])
      Object.entries(snap || {}).forEach(([id, sn]) => {
        const cur = { ...(nodeProps[id] || {}) }
        cur.fx = sn.x; cur.fy = sn.y
        cur.visible = sn.v !== false
        if (sn.s != null) cur.scale = sn.s
        if (sn.fill !== undefined) cur.fillColor = sn.fill
        if (sn.stroke !== undefined) cur.strokeColor = sn.stroke
        if (sn.shp !== undefined) cur.shape = sn.shp
        nodeProps[id] = cur
        if (sn.c) collapsed.add(id); else collapsed.delete(id)
      })
      return { ...v, nodeProps, collapsedNodeIds: [...collapsed] }
    }),
  })),

  // "Show children as list" — render a node's whole subtree as one nested list card (per active view).
  // Its descendants are hidden from the canvas (like collapse); the card draws them as editable rows.
  // Toggling on also clears any plain-collapse state on that node (the two states are exclusive).
  toggleListNode: (nodeId) => set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      const list = new Set(v.listNodeIds || [])
      const coll = new Set(v.collapsedNodeIds || [])
      if (list.has(nodeId)) list.delete(nodeId)
      else { list.add(nodeId); coll.delete(nodeId) }
      return { ...v, listNodeIds: [...list], collapsedNodeIds: [...coll] }
    })
  })),

  // ── Kanban board nodes ──────────────────────────────────────────────────────
  // A board is a node flagged (per view) as kanban: its DIRECT children are the columns, and each
  // column's children are the cards. The whole subtree is hidden from the canvas (like a list card)
  // and drawn by KanbanCard. Mutually exclusive with the list-card flag.
  toggleKanbanNode: (nodeId) => set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      const kb = new Set(v.kanbanNodeIds || [])
      const list = new Set(v.listNodeIds || [])
      const coll = new Set(v.collapsedNodeIds || [])
      if (kb.has(nodeId)) kb.delete(nodeId)
      else { kb.add(nodeId); list.delete(nodeId); coll.delete(nodeId) }
      return { ...v, kanbanNodeIds: [...kb], listNodeIds: [...list], collapsedNodeIds: [...coll] }
    })
  })),

  // ── Strategy card nodes ─────────────────────────────────────────────────────
  // A strategy node renders ALL its descendants (every generation) as draggable cards inside one
  // bespoke SVG card, with typed arrows the user draws by hand (next / needs / decision-branch).
  // The arrows live on the node's view-independent `meta.strategy` and are SEPARATE from graph edges
  // (drawing them must never corrupt the outliner hierarchy). Mutually exclusive with kanban/list.
  //   meta.strategy = { edges:[{ id, from, to, kind:'next'|'needs'|'branch', label }],
  //                     pos:{[itemId]:{x,y}}, decision:{[itemId]:true} }
  toggleStrategyNode: (nodeId) => set(s => ({
    views: s.views.map(v => {
      if (v.id !== s.activeViewId) return v
      const strat = new Set(v.strategyNodeIds || [])
      const kb = new Set(v.kanbanNodeIds || [])
      const list = new Set(v.listNodeIds || [])
      const coll = new Set(v.collapsedNodeIds || [])
      if (strat.has(nodeId)) strat.delete(nodeId)
      else { strat.add(nodeId); kb.delete(nodeId); list.delete(nodeId); coll.delete(nodeId) }
      return { ...v, strategyNodeIds: [...strat], kanbanNodeIds: [...kb], listNodeIds: [...list], collapsedNodeIds: [...coll] }
    })
  })),

  // Position one item within a strategy card (card-local coords).
  setStrategyPos: (nodeId, itemId, x, y) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId) return n
      const strat = n.meta?.strategy || {}
      return { ...n, meta: { ...(n.meta || {}), strategy: { ...strat, pos: { ...(strat.pos || {}), [itemId]: { x, y } } } } }
    }),
  })),

  // Bulk-set item positions (auto-arrange).
  setStrategyPositions: (nodeId, posMap) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId) return n
      const strat = n.meta?.strategy || {}
      return { ...n, meta: { ...(n.meta || {}), strategy: { ...strat, pos: { ...(strat.pos || {}), ...posMap } } } }
    }),
  })),

  // Add a typed arrow between two items in a strategy card. No-ops on self/duplicate edges.
  addStrategyEdge: (nodeId, from, to, kind = 'next', label = '') => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId || !from || !to || from === to) return n
      const strat = n.meta?.strategy || {}
      const edges = strat.edges || []
      if (edges.some(e => e.from === from && e.to === to)) return n
      return { ...n, meta: { ...(n.meta || {}), strategy: { ...strat, edges: [...edges, { id: uid(), from, to, kind, label }] } } }
    }),
  })),

  // Patch a strategy arrow (kind / label).
  setStrategyEdge: (nodeId, edgeId, patch) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId) return n
      const strat = n.meta?.strategy || {}
      return { ...n, meta: { ...(n.meta || {}), strategy: { ...strat, edges: (strat.edges || []).map(e => e.id === edgeId ? { ...e, ...patch } : e) } } }
    }),
  })),

  // Remove a strategy arrow.
  removeStrategyEdge: (nodeId, edgeId) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId) return n
      const strat = n.meta?.strategy || {}
      return { ...n, meta: { ...(n.meta || {}), strategy: { ...strat, edges: (strat.edges || []).filter(e => e.id !== edgeId) } } }
    }),
  })),

  // Toggle an item's "decision" flag (rendered as a diamond, branch arrows leave it labelled).
  toggleStrategyDecision: (nodeId, itemId) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId) return n
      const strat = n.meta?.strategy || {}
      const dec = { ...(strat.decision || {}) }
      if (dec[itemId]) delete dec[itemId]; else dec[itemId] = true
      return { ...n, meta: { ...(n.meta || {}), strategy: { ...strat, decision: dec } } }
    }),
  })),

  // Create a fresh board (with three starter columns) and flag it as kanban in the active view.
  // A board owns a per-board SELECT property whose options ARE its columns — so each column is both a
  // node (its cards are children) and a value of that property. Cards get the property = their column.
  // board.meta.propId links the board to its property; column.meta.optId links a column to its option.
  addKanbanNode: (x = null, y = null) => {
    const boardId = uid(), propId = uid()
    const cols = ['To do', 'Doing', 'Done'].map((name, i) => ({ id: uid(), name, optId: uid(), color: KANBAN_OPT_COLORS[i % KANBAN_OPT_COLORS.length] }))
    const prop = { id: propId, name: 'Board', type: 'select', options: cols.map(c => ({ id: c.optId, name: c.name, color: c.color })) }
    set(s => ({
      nodes: [...s.nodes,
        { id: boardId, label: 'Board', notes: '', meta: { propId } },
        ...cols.map(c => ({ id: c.id, label: c.name, notes: '', meta: { optId: c.optId } })),
      ],
      edges: [...s.edges, ...cols.map(c => ({ id: uid(), source: boardId, target: c.id }))],
      propertyDefs: [...s.propertyDefs, prop],
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v,
        kanbanNodeIds: [...(v.kanbanNodeIds || []), boardId],
        nodeProps: { ...v.nodeProps, [boardId]: { ...DEFAULT_NODE_PROPS, ...(x !== null ? { fx: x, fy: y } : {}) } },
      }),
    }))
    return boardId
  },

  // Create a GROUPED board: a lightweight view node that references a source parent and groups the
  // source's flattened descendants by a property (or by tags). It has no columns/cards of its own —
  // columns are the property's options (or the distinct tags); cards are computed. Multiple grouped
  // boards can point at the same source with different groupings.
  // groupBy = { mode:'property', propId } | { mode:'tag' }
  addGroupedBoard: (sourceId, groupBy, x = null, y = null) => {
    const boardId = uid()
    const srcLabel = get().nodes.find(n => n.id === sourceId)?.label || 'Board'
    set(s => ({
      nodes: [...s.nodes, { id: boardId, label: srcLabel, notes: '', meta: { kanban: { sourceId, groupBy } } }],
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v,
        kanbanNodeIds: [...(v.kanbanNodeIds || []), boardId],
        nodeProps: { ...v.nodeProps, [boardId]: { ...DEFAULT_NODE_PROPS, ...(x !== null ? { fx: x, fy: y } : {}) } },
      }),
    }))
    return boardId
  },

  // Change a grouped board's grouping (property or tag) in place.
  setKanbanGroupBy: (boardId, groupBy) => set(s => ({
    nodes: s.nodes.map(n => n.id === boardId ? { ...n, meta: { ...(n.meta || {}), kanban: { ...(n.meta?.kanban || {}), groupBy } } } : n),
  })),

  // Add a column to a board: a child node + a matching option in the board's property (linked by optId).
  addKanbanColumn: (boardId, propId, name = 'New column') => {
    const colId = uid(), optId = uid()
    set(s => {
      const prop = s.propertyDefs.find(p => p.id === propId)
      const color = KANBAN_OPT_COLORS[((prop?.options || []).length) % KANBAN_OPT_COLORS.length]
      return {
        nodes: [...s.nodes, { id: colId, label: name, notes: '', meta: { optId } }],
        edges: [...s.edges, { id: uid(), source: boardId, target: colId }],
        propertyDefs: propId ? s.propertyDefs.map(p => p.id !== propId ? p : { ...p, options: [...(p.options || []), { id: optId, name, color }] }) : s.propertyDefs,
      }
    })
    return colId
  },

  // Rename a column and its linked property option together.
  renameKanbanColumn: (colId, propId, label) => set(s => {
    const optId = s.nodes.find(n => n.id === colId)?.meta?.optId
    return {
      nodes: s.nodes.map(n => n.id === colId ? { ...n, label } : n),
      propertyDefs: (propId && optId) ? s.propertyDefs.map(p => p.id !== propId ? p : { ...p, options: (p.options || []).map(o => o.id === optId ? { ...o, name: label } : o) }) : s.propertyDefs,
    }
  }),

  // Delete a column: removes the column node, its cards, and the linked property option.
  deleteKanbanColumn: (colId, propId) => set(s => {
    const optId = s.nodes.find(n => n.id === colId)?.meta?.optId
    const cardIds = s.edges.filter(e => e.source === colId).map(e => e.target)
    const kill = new Set([colId, ...cardIds])
    return {
      nodes: s.nodes.filter(n => !kill.has(n.id)).map(n => {
        if (!optId || !n.props || n.props[propId] !== optId) return n
        return { ...n, props: { ...n.props, [propId]: null } }
      }),
      edges: s.edges.filter(e => !kill.has(e.source) && !kill.has(e.target)),
      propertyDefs: (propId && optId) ? s.propertyDefs.map(p => p.id !== propId ? p : { ...p, options: (p.options || []).filter(o => o.id !== optId) }) : s.propertyDefs,
      views: s.views.map(v => {
        const np = { ...v.nodeProps }; kill.forEach(id => delete np[id])
        return { ...v, nodeProps: np }
      }),
    }
  }),

  // Rename a board and keep its property's name in sync.
  renameKanbanBoard: (boardId, propId, label) => set(s => ({
    nodes: s.nodes.map(n => n.id === boardId ? { ...n, label } : n),
    propertyDefs: propId ? s.propertyDefs.map(p => p.id === propId ? { ...p, name: label } : p) : s.propertyDefs,
  })),

  // Reorder a child among its siblings under `parentId`: move the (parent→child) edge to just before
  // the (parent→beforeId) edge, or to the end when beforeId is null. Children order = edge order.
  moveChild: (parentId, childId, beforeId) => set(s => {
    const edges = [...s.edges]
    const from = edges.findIndex(e => e.source === parentId && e.target === childId)
    if (from < 0) return {}
    const [moved] = edges.splice(from, 1)
    if (beforeId == null) {
      // append after the last sibling edge of this parent
      let lastSib = -1
      edges.forEach((e, i) => { if (e.source === parentId) lastSib = i })
      edges.splice(lastSib + 1, 0, moved)
    } else {
      const to = edges.findIndex(e => e.source === parentId && e.target === beforeId)
      edges.splice(to < 0 ? edges.length : to, 0, moved)
    }
    return { edges }
  }),

  // Move a card under a new column (or reorder within its column) in one atomic edit: drop the card's
  // current parent edge, then insert a (column→card) edge before `beforeId` (or append when null).
  // Used by Kanban drag-and-drop. Refuses moves that would create a cycle.
  moveCardToColumn: (cardId, columnId, beforeId = null) => set(s => {
    if (!columnId || columnId === cardId) return {}
    // cycle guard: never drop a card into its own descendant
    const kids = {}; s.edges.forEach(e => { (kids[e.source] = kids[e.source] || []).push(e.target) })
    const desc = new Set(); const stack = [cardId]
    while (stack.length) { const c = stack.pop(); (kids[c] || []).forEach(t => { if (!desc.has(t)) { desc.add(t); stack.push(t) } }) }
    if (desc.has(columnId)) return {}
    const edges = s.edges.filter(e => e.target !== cardId)   // detach from old parent
    const moved = { id: uid(), source: columnId, target: cardId }
    if (beforeId == null || beforeId === cardId) {
      let lastSib = -1
      edges.forEach((e, i) => { if (e.source === columnId) lastSib = i })
      edges.splice(lastSib + 1, 0, moved)
    } else {
      const to = edges.findIndex(e => e.source === columnId && e.target === beforeId)
      edges.splice(to < 0 ? edges.length : to, 0, moved)
    }
    return { edges }
  }),

  // Status↔column sync: set a card's "Status" select property to `statusName`, auto-creating the
  // Status select property and the matching option (by name, case-insensitive) if they don't exist.
  // Keeps the board column and the Table's Status column as one system.
  setNodeStatusByColumn: (cardId, statusName) => set(s => {
    const name = String(statusName || '').trim()
    if (!name) return {}
    const palette = ['#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']
    let defs = s.propertyDefs
    let prop = defs.find(p => p.type === 'select' && (p.name || '').toLowerCase() === 'status')
    if (!prop) { prop = { id: uid(), name: 'Status', type: 'select', options: [] }; defs = [...defs, prop] }
    let options = prop.options || []
    let opt = options.find(o => (o.name || '').toLowerCase() === name.toLowerCase())
    if (!opt) { opt = { id: uid(), name, color: palette[options.length % palette.length] }; options = [...options, opt] }
    defs = defs.map(p => p.id === prop.id ? { ...p, options } : p)
    const nodes = s.nodes.map(n => n.id === cardId ? { ...n, props: { ...(n.props || {}), [prop.id]: opt.id } } : n)
    return { propertyDefs: defs, nodes }
  }),

  // ── Table nodes ───────────────────────────────────────────────────────────
  // A table node is any node carrying a view-independent `table` = { columns, rows }.
  //   columns: [{ id, name, type:'text'|'number'|'checkbox'|'select'|'date', width, options? }]
  //   rows:    [{ id, cells: { [colId]: value } }]
  // Rendered as an editable HTML card in a foreignObject (like list cards); it is a normal
  // node otherwise (participates in the sim, can be connected by edges or float anchored).
  addTableNode: (x = null, y = null) => {
    const id = uid()
    const c1 = uid(), c2 = uid(), c3 = uid()
    const table = {
      columns: [
        { id: c1, name: 'Name', type: 'text', width: 150 },
        { id: c2, name: 'Status', type: 'select', width: 118, options: ['Todo', 'Doing', 'Done'] },
        { id: c3, name: 'Done', type: 'checkbox', width: 62 },
      ],
      rows: [uid(), uid(), uid()].map(rid => ({ id: rid, cells: {} })),
    }
    set(s => ({
      nodes: [...s.nodes, { id, label: 'Table', notes: '', table }],
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, nodeProps: { ...v.nodeProps, [id]: { ...DEFAULT_NODE_PROPS, ...(x !== null ? { fx: x, fy: y } : {}) } },
      }),
    }))
    return id
  },

  // Create a table node from parsed clipboard data. `parsed` = { columns:[{name,type?,width?,options?}],
  // rows:[{cells:{[colIndex]:value}}] } where cells are keyed by COLUMN INDEX (we assign real ids here).
  addTableNodeFrom: (parsed, x = null, y = null) => {
    const id = uid()
    const columns = (parsed.columns || []).map(c => ({
      id: uid(), name: c.name || '', type: c.type || 'text',
      width: c.width || Math.max(80, Math.min(240, (c.name || '').length * 8 + 40)),
      ...(c.type === 'select' ? { options: c.options || [] } : {}),
    }))
    const rows = (parsed.rows || []).map(r => {
      const cells = {}
      columns.forEach((col, ci) => { const v = r.cells?.[ci]; if (v !== undefined && v !== '') cells[col.id] = v })
      return { id: uid(), cells }
    })
    const table = { columns, rows }
    set(s => ({
      nodes: [...s.nodes, { id, label: parsed.title || 'Table', notes: '', table }],
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, nodeProps: { ...v.nodeProps, [id]: { ...DEFAULT_NODE_PROPS, ...(x !== null ? { fx: x, fy: y } : {}) } },
      }),
    }))
    return id
  },

  // ── YouTube slideshow node (node.ytss) ──────────────────────────────────────
  // A node carrying an ordered list of YouTube clips with per-clip trim + trigger. Rendered as a clean
  // player; arrow-navigable when "entered". clip = { id, youtubeId, title, start, end, trigger, delayMs }.
  addYtssNode: (x = null, y = null) => {
    const id = uid()
    set(s => ({
      nodes: [...s.nodes, { id, label: '', notes: '', ytss: { clips: [] } }],
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v, nodeProps: { ...v.nodeProps, [id]: { ...DEFAULT_NODE_PROPS, ...(x !== null ? { fx: x, fy: y } : {}) } },
      }),
    }))
    return id
  },
  setYtssClips: (nodeId, clips) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.ytss ? n : { ...n, ytss: { ...n.ytss, clips } }),
  })),
  setYtssProp: (nodeId, patch) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.ytss ? n : { ...n, ytss: { ...n.ytss, ...patch } }),
  })),

  setTableCell: (nodeId, rowId, colId, value) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : {
      ...n, table: { ...n.table, rows: n.table.rows.map(r => r.id !== rowId ? r : { ...r, cells: { ...r.cells, [colId]: value } }) },
    }),
  })),

  // Per-cell background colour (right-click). Stored on the row as cellBg[colId]; null/undefined clears it.
  setTableCellBg: (nodeId, rowId, colId, color) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : {
      ...n, table: { ...n.table, rows: n.table.rows.map(r => r.id !== rowId ? r : { ...r, cellBg: { ...(r.cellBg || {}), [colId]: color || undefined } }) },
    }),
  })),

  addTableRow: (nodeId) => {
    const rid = uid()
    set(s => ({
      nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : { ...n, table: { ...n.table, rows: [...n.table.rows, { id: rid, cells: {} }] } }),
    }))
    return rid
  },

  addTableColumn: (nodeId, type = 'text') => {
    const cid = uid()
    const col = { id: cid, name: 'Column', type, width: type === 'checkbox' ? 62 : 120, ...(type === 'select' ? { options: ['Option'] } : {}) }
    set(s => ({
      nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : { ...n, table: { ...n.table, columns: [...n.table.columns, col] } }),
    }))
    return cid
  },

  // Insert a blank row at a specific index (right-click "add row above/below").
  insertTableRow: (nodeId, atIndex) => {
    const rid = uid()
    set(s => ({
      nodes: s.nodes.map(n => {
        if (n.id !== nodeId || !n.table) return n
        const rows = [...n.table.rows]
        rows.splice(Math.max(0, Math.min(rows.length, atIndex)), 0, { id: rid, cells: {} })
        return { ...n, table: { ...n.table, rows } }
      }),
    }))
    return rid
  },

  // Insert a column at a specific index (right-click "add column left/right").
  insertTableColumn: (nodeId, atIndex, type = 'text') => {
    const cid = uid()
    const col = { id: cid, name: 'Column', type, width: type === 'checkbox' ? 62 : 120, ...(type === 'select' ? { options: ['Option'] } : {}) }
    set(s => ({
      nodes: s.nodes.map(n => {
        if (n.id !== nodeId || !n.table) return n
        const cols = [...n.table.columns]
        cols.splice(Math.max(0, Math.min(cols.length, atIndex)), 0, col)
        return { ...n, table: { ...n.table, columns: cols } }
      }),
    }))
    return cid
  },

  deleteTableRow: (nodeId, rowId) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : { ...n, table: { ...n.table, rows: n.table.rows.filter(r => r.id !== rowId) } }),
  })),

  deleteTableColumn: (nodeId, colId) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : {
      ...n, table: {
        ...n.table,
        columns: n.table.columns.filter(c => c.id !== colId),
        rows: n.table.rows.map(r => { const cells = { ...r.cells }; delete cells[colId]; return { ...r, cells } }),
      },
    }),
  })),

  updateTableColumn: (nodeId, colId, patch) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : {
      ...n, table: { ...n.table, columns: n.table.columns.map(c => c.id !== colId ? c : { ...c, ...patch }) },
    }),
  })),

  moveTableColumn: (nodeId, colId, toIndex) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId || !n.table) return n
      const cols = [...n.table.columns]; const from = cols.findIndex(c => c.id === colId); if (from < 0) return n
      const [m] = cols.splice(from, 1); cols.splice(Math.max(0, Math.min(cols.length, toIndex)), 0, m)
      return { ...n, table: { ...n.table, columns: cols } }
    }),
  })),

  moveTableRow: (nodeId, rowId, toIndex) => set(s => ({
    nodes: s.nodes.map(n => {
      if (n.id !== nodeId || !n.table) return n
      const rows = [...n.table.rows]; const from = rows.findIndex(r => r.id === rowId); if (from < 0) return n
      const [m] = rows.splice(from, 1); rows.splice(Math.max(0, Math.min(rows.length, toIndex)), 0, m)
      return { ...n, table: { ...n.table, rows } }
    }),
  })),

  setTableRowHeight: (nodeId, rowId, height) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : {
      ...n, table: { ...n.table, rows: n.table.rows.map(r => r.id === rowId ? { ...r, height } : r) },
    }),
  })),

  // ── Flowchart (Mermaid text ⇄ graph) ────────────────────────────────────────
  setEdgeLabel: (edgeId, label) => set(s => ({
    edges: s.edges.map(e => e.id === edgeId ? { ...e, label: label || undefined } : e),
  })),

  // Give each listed node a short readable `flowId` (used in the flowchart text) if it lacks one.
  ensureFlowIds: (ids) => {
    const s = get()
    const want = new Set(ids || [])
    if (![...want].some(id => { const n = s.nodes.find(x => x.id === id); return n && !n.flowId })) return
    const taken = new Set(s.nodes.map(n => n.flowId).filter(Boolean))
    set({
      nodes: s.nodes.map(n => (want.has(n.id) && !n.flowId) ? { ...n, flowId: slugifyFlowId(n.label, taken) } : n),
    })
  },

  // Apply a parsed flowchart ({ nodes:[{flowId,label,shape}], edges:[{source,target,label}] } where
  // source/target are flowIds) back into the graph. Matches nodes by flowId → preserves positions and
  // identity for survivors, creates new nodes at `layout[flowId]`, reconciles edges AMONG the flowchart
  // nodes (add/remove/label), and never deletes nodes (safe: removing a text line just orphans it).
  applyFlowchart: (parsed, layout = {}) => {
    const s = get()
    const activeViewId = s.activeViewId
    const view = s.views.find(v => v.id === activeViewId)
    const nodeProps = { ...(view?.nodeProps || {}) }
    const flowToId = {}
    s.nodes.forEach(n => { if (n.flowId) flowToId[n.flowId] = n.id })
    const nodesOut = [...s.nodes]
    parsed.nodes.forEach(pn => {
      let id = flowToId[pn.flowId]
      if (!id) {
        id = uid(); flowToId[pn.flowId] = id
        const pos = layout[pn.flowId] || { x: 0, y: 0 }
        nodesOut.push({ id, label: pn.label ?? pn.flowId, notes: '', flowId: pn.flowId })
        nodeProps[id] = { ...DEFAULT_NODE_PROPS, shape: pn.shape || 'rect', fx: pos.x, fy: pos.y }
      } else {
        const idx = nodesOut.findIndex(n => n.id === id)
        if (idx >= 0 && pn.label != null && nodesOut[idx].label !== pn.label) nodesOut[idx] = { ...nodesOut[idx], label: pn.label }
        if (pn.shape) nodeProps[id] = { ...DEFAULT_NODE_PROPS, ...(nodeProps[id] || {}), shape: pn.shape }
      }
    })
    const fcIds = new Set(parsed.nodes.map(pn => flowToId[pn.flowId]).filter(Boolean))
    const desired = parsed.edges
      .map(e => ({ source: flowToId[e.source], target: flowToId[e.target], label: e.label }))
      .filter(e => e.source && e.target)
    const existingByKey = {}
    s.edges.forEach(e => { existingByKey[e.source + '>' + e.target] = e })
    // keep every edge that isn't internal to this flowchart; rebuild the internal ones from the text
    const edgesOut = s.edges.filter(e => !(fcIds.has(e.source) && fcIds.has(e.target)))
    desired.forEach(e => {
      const prev = existingByKey[e.source + '>' + e.target]
      edgesOut.push({ id: prev?.id || uid(), source: e.source, target: e.target, label: e.label || undefined })
    })
    set({ nodes: nodesOut, edges: edgesOut, views: s.views.map(v => v.id === activeViewId ? { ...v, nodeProps } : v) })
  },

  setDrillRoot: (nodeId) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: nodeId } : v),
  })),

  exitDrill: () => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: null } : v),
  })),
}))

export default useGraphStore
