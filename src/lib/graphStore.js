import { create } from 'zustand'

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
export const STYLE_KEYS = ['fillColor', 'textColor', 'strokeColor', 'strokeWidth', 'strokeDash', 'shape', 'scale', 'nodeEmojis', 'shadow', 'opacity']

export const COLOR_PALETTE = PALETTE
export const FILL_COLORS = PALETTE
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
const LAST_STYLE_PROPS = ['fillColor', 'textColor', 'strokeColor', 'strokeWidth', 'strokeDash', 'opacity', 'shape', 'shadow', 'nodeMotion', 'nodeColorCycle']
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
    set(s => ({
      nodes: [...s.nodes, { id, label, notes: '' }],
      edges: parentId ? [...s.edges, { id: uid(), source: parentId, target: id }] : s.edges,
      views: s.views.map(v => v.id !== s.activeViewId ? v : {
        ...v,
        nodeProps: {
          ...v.nodeProps,
          [id]: { ...DEFAULT_NODE_PROPS, ...(s.lastStyle || {}), ...(x !== null ? { fx: x, fy: y } : {}) },
        },
      }),
    }))
    return id
  },

  updateLabel: (id, label) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, label } : n),
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
    const labels = { text:'Text', number:'Number', date:'Date', checkbox:'Checkbox', select:'Select', multiSelect:'Tags', url:'URL' }
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
    const out = { views: patchViewNode(s.views, s.activeViewId, nodeId, { [prop]: value }) }
    // Remember style changes so the next new node inherits them.
    if (LAST_STYLE_PROPS.includes(prop) && !(prop === 'shape' && !BASIC_SHAPES.has(value))) {
      const ls = { ...s.lastStyle, [prop]: value }
      saveLastStyle(ls); out.lastStyle = ls
    }
    return out
  }),

  setContainedIn: (nodeId, containerId) => set(s => ({
    views: patchViewNode(s.views, s.activeViewId, nodeId, { containedIn: containerId }),
  })),

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

  updateImage: (imageId, props) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v, images: (v.images || []).map(img => img.id === imageId ? { ...img, ...props } : img),
    }),
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

  setTableCell: (nodeId, rowId, colId, value) => set(s => ({
    nodes: s.nodes.map(n => n.id !== nodeId || !n.table ? n : {
      ...n, table: { ...n.table, rows: n.table.rows.map(r => r.id !== rowId ? r : { ...r, cells: { ...r.cells, [colId]: value } }) },
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

  setDrillRoot: (nodeId) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: nodeId } : v),
  })),

  exitDrill: () => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: null } : v),
  })),
}))

export default useGraphStore
