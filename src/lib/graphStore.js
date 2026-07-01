import { create } from 'zustand'

const uid = () => crypto.randomUUID()

export const NODE_R = 44

export const DEFAULT_NODE_PROPS = {
  scale: 1,
  fillColor: '#12122a',
  textColor: '#ffffff',
  strokeColor: '#2d3a6a',
  visible: true,
  fx: null,
  fy: null,
  shape: 'circle', // 'circle' | 'ellipse' | 'roundrect' | 'rect' | 'diamond' | 'none' | 'frame'
  containedIn: null, // nodeId of a frame node, or null (per-view)
}

// Unified palette used for fill colors, text colors, and background colors
// Tailwind 500-series — MIT licensed, one color per hue, proven in UI design
export const PALETTE = [
  '#f43f5e', '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
  '#d946ef', '#ec4899',
  '#ffffff', '#94a3b8', '#334155', '#0f172a',
]

export const SHAPES = ['circle', 'ellipse', 'roundrect', 'rect', 'diamond', 'none', 'image']

export const COLOR_PALETTE = PALETTE
export const FILL_COLORS = PALETTE
export const TEXT_COLORS = PALETTE

export const BG_COLORS = [
  '#0c0c1a', '#0a0a0a', '#0d1117', '#0f1923',
  '#1a0a0a', '#0a1a0a', '#1a1200', '#130a1a',
  '#111827', '#1e1b2e', '#162032', '#0d1f12',
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

const useGraphStore = create((set, get) => ({
  // â”€â”€ View-independent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  nodes: [],
  edges: [],

  // â”€â”€ Notion-style DB schema (per project). propertyDefs describes the columns;
  // each node stores values in node.props[propId]. Types: text|number|date|checkbox|select|multiSelect|url.
  propertyDefs: [],

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
  loadProjectData: ({ nodes, edges, views, activeViewId, propertyDefs }) => set({
    nodes: nodes || [],
    edges: edges || [],
    propertyDefs: propertyDefs || [],
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
          [id]: { ...DEFAULT_NODE_PROPS, ...(x !== null ? { fx: x, fy: y } : {}) },
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
    const edges = s.edges.filter(e => e.target !== nodeId)
    if (newParentId && newParentId !== nodeId) edges.push({ id: uid(), source: newParentId, target: nodeId })
    return { edges }
  }),

  // â”€â”€ View-dependent node props â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  setNodeViewProp: (nodeId, prop, value) => set(s => ({
    views: patchViewNode(s.views, s.activeViewId, nodeId, { [prop]: value }),
  })),

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

  setDrillRoot: (nodeId) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: nodeId } : v),
  })),

  exitDrill: () => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: null } : v),
  })),
}))

export default useGraphStore
