// dagre auto-layout for the strategy flowchart.
// Ported from the stratego repo (src/layout/dagre.ts).
import dagre from '@dagrejs/dagre'

const NODE_HEIGHT = 48
const DECISION_HEIGHT = 72

function estimateWidth(label, kind) {
  const base = label.length * 7.5 + 40
  if (kind === 'decision') return Math.max(120, base + 30)
  return Math.max(100, Math.min(280, base))
}

export function layoutStrategy(strategy) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 64, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of strategy.nodes) {
    g.setNode(node.id, {
      width: estimateWidth(node.label, node.kind),
      height: node.kind === 'decision' ? DECISION_HEIGHT : NODE_HEIGHT,
    })
  }
  for (const edge of strategy.edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const positions = {}
  for (const node of strategy.nodes) {
    const pos = g.node(node.id)
    // dagre gives centers; React Flow wants top-left corners
    positions[node.id] = {
      x: (pos?.x ?? 0) - (pos?.width ?? 0) / 2,
      y: (pos?.y ?? 0) - (pos?.height ?? 0) / 2,
    }
  }
  return positions
}
