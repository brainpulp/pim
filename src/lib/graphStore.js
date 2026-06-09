import { create } from 'zustand'

const uid = () => crypto.randomUUID()

const useGraphStore = create((set, get) => ({
  nodes: [
    { id: 'root-1', label: 'Root' },
  ],
  edges: [],

  addNode: (label = 'New node', parentId = null) => {
    const id = uid()
    set(s => ({
      nodes: [...s.nodes, { id, label }],
      edges: parentId
        ? [...s.edges, { id: uid(), source: parentId, target: id }]
        : s.edges,
    }))
    return id
  },

  updateLabel: (id, label) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, label } : n),
  })),

  deleteNode: (id) => set(s => ({
    nodes: s.nodes.filter(n => n.id !== id),
    edges: s.edges.filter(e => e.source !== id && e.target !== id),
  })),

  addEdge: (source, target) => {
    if (source === target) return
    const { edges } = get()
    if (edges.find(e => e.source === source && e.target === target)) return
    set(s => ({ edges: [...s.edges, { id: uid(), source, target }] }))
  },

  removeEdge: (id) => set(s => ({
    edges: s.edges.filter(e => e.id !== id),
  })),

  setAnchor: (id, fx, fy) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, fx, fy } : n),
  })),

  releaseAnchor: (id) => set(s => ({
    nodes: s.nodes.map(n => n.id === id ? { ...n, fx: undefined, fy: undefined } : n),
  })),
}))

export default useGraphStore
