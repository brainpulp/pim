import { create } from 'zustand'

const uid = () => crypto.randomUUID()

export const NODE_R = 34

export const DEFAULT_NODE_PROPS = {
  scale: 1,
  fillColor: '#12122a',
  strokeColor: '#2d3a6a',
  visible: true,
  fx: null,
  fy: null,
  shape: 'circle', // 'circle' | 'ellipse' | 'roundrect' | 'diamond' | 'none'
}

export const SHAPES = ['circle', 'ellipse', 'roundrect', 'diamond', 'none']

export const FILL_COLORS = [
  '#1d4ed8', '#2563eb', '#0f766e', '#0d9488',
  '#7e22ce', '#9333ea', '#b45309', '#d97706',
  '#be185d', '#db2777', '#0e7490', '#0284c7',
  '#15803d', '#16a34a', '#dc2626', '#374151',
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
  // ── View-independent ──────────────────────────────────────────
  nodes: [],
  edges: [],

  // ── Views ─────────────────────────────────────────────────────
  views: [{ id: 'view-default', name: 'Default', nodeProps: {}, drillRoot: null }],
  activeViewId: 'view-default',

  // ── Load a full project snapshot ──────────────────────────────
  loadProjectData: ({ nodes, edges, views, activeViewId }) => set({
    nodes: nodes || [],
    edges: edges || [],
    views: views?.length ? views : [{ id: 'view-default', name: 'Default', nodeProps: {}, drillRoot: null }],
    activeViewId: activeViewId || 'view-default',
  }),

  // ── Node ops ──────────────────────────────────────────────────
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

  deleteNode: (id) => set(s => ({
    nodes: s.nodes.filter(n => n.id !== id),
    edges: s.edges.filter(e => e.source !== id && e.target !== id),
    views: s.views.map(v => {
      const { [id]: _, ...rest } = v.nodeProps
      return { ...v, nodeProps: rest }
    }),
  })),

  // ── Edge ops ──────────────────────────────────────────────────
  addEdge: (source, target) => {
    if (source === target) return
    if (get().edges.find(e => e.source === source && e.target === target)) return
    set(s => ({ edges: [...s.edges, { id: uid(), source, target }] }))
  },

  removeEdge: (id) => set(s => ({ edges: s.edges.filter(e => e.id !== id) })),

  // Remove all parent edges for nodeId, optionally set a new parent
  reparentNode: (nodeId, newParentId) => set(s => {
    const edges = s.edges.filter(e => e.target !== nodeId)
    if (newParentId && newParentId !== nodeId) edges.push({ id: uid(), source: newParentId, target: nodeId })
    return { edges }
  }),

  // ── View-dependent node props ─────────────────────────────────
  setNodeViewProp: (nodeId, prop, value) => set(s => ({
    views: patchViewNode(s.views, s.activeViewId, nodeId, { [prop]: value }),
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

  // ── View ops ──────────────────────────────────────────────────
  addView: (name = 'New View') => {
    const id = uid()
    set(s => ({
      views: [...s.views, { id, name, nodeProps: {}, drillRoot: null }],
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

  setDrillRoot: (nodeId) => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: nodeId } : v),
  })),

  exitDrill: () => set(s => ({
    views: s.views.map(v => v.id === s.activeViewId ? { ...v, drillRoot: null } : v),
  })),
}))

export default useGraphStore
