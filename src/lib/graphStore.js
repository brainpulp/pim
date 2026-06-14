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
export const PALETTE = [
  '#ffffff', '#e2e8f0', '#94a3b8', '#475569',
  '#fbbf24', '#f97316', '#ef4444', '#f472b6',
  '#34d399', '#10b981', '#0d9488', '#06b6d4',
  '#60a5fa', '#3b82f6', '#6366f1', '#8b5cf6',
  '#c084fc', '#a78bfa', '#1d4ed8', '#0f766e',
  '#15803d', '#16a34a', '#b45309', '#dc2626',
  '#7e22ce', '#be185d', '#0e7490', '#374151',
  '#0c0c1a', '#0a1628', '#0a1a0a', '#1a0a1a',
]

export const SHAPES = ['circle', 'ellipse', 'roundrect', 'rect', 'diamond', 'none']

export const FILL_COLORS = [
  '#1d4ed8', '#2563eb', '#0f766e', '#0d9488',
  '#7e22ce', '#9333ea', '#b45309', '#d97706',
  '#be185d', '#db2777', '#0e7490', '#0284c7',
  '#15803d', '#16a34a', '#dc2626', '#374151',
]

export const TEXT_COLORS = [
  '#ffffff', '#e2e8f0', '#fbbf24', '#34d399',
  '#60a5fa', '#f87171', '#c084fc', '#fb923c',
]

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

const useGraphStore = create((set, get) => ({
  // â”€â”€ View-independent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  nodes: [],
  edges: [],

  // â”€â”€ Views â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  views: [{ id: 'view-default', name: 'Default', nodeProps: {}, drillRoot: null, bgColor: '#0c0c1a', images: [], slides: [] }],
  activeViewId: 'view-default',

  // â”€â”€ Load a full project snapshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  loadProjectData: ({ nodes, edges, views, activeViewId }) => set({
    nodes: nodes || [],
    edges: edges || [],
    views: views?.length ? views.map(v => {
      const merged = { bgColor: '#0c0c1a', images: [], ...v }
      // Initialize slides from frame nodeProps if not explicitly set
      if (!merged.slides) {
        merged.slides = Object.entries(merged.nodeProps || {})
          .filter(([, p]) => p.shape === 'frame')
          .map(([id]) => id)
      }
      return merged
    }) : [{ id: 'view-default', name: 'Default', nodeProps: {}, drillRoot: null, bgColor: '#0c0c1a', images: [], slides: [] }],
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
      return { ...v, nodeProps: rest, slides: (v.slides || []).filter(sid => sid !== id) }
    }),
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

  // â”€â”€ Slide ops (per view) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  addSlide: (frameId) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v, slides: (v.slides || []).includes(frameId) ? (v.slides || []) : [...(v.slides || []), frameId],
    }),
  })),

  removeSlide: (frameId) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : {
      ...v, slides: (v.slides || []).filter(id => id !== frameId),
    }),
  })),

  reorderSlides: (newSlides) => set(s => ({
    views: s.views.map(v => v.id !== s.activeViewId ? v : { ...v, slides: newSlides }),
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

  // â”€â”€ View ops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  addView: (name = 'New View') => {
    const id = uid()
    set(s => ({
      views: [...s.views, { id, name, nodeProps: {}, drillRoot: null, images: [], slides: [] }],
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

  setDrillRoot: (nodeId) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: nodeId } : v),
  })),

  exitDrill: () => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: null } : v),
  })),
}))

export default useGraphStore
