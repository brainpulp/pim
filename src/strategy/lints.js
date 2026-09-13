// Gap analysis over a strategy — shown in the Gaps panel.
// Ported from the stratego repo (src/analysis/lints.ts).

const ELSE_LABELS = new Set(['no', 'else', 'otherwise', 'if not'])

export function lintStrategy(strategy) {
  const lints = []
  const outFlow = new Map()
  const outAny = new Map()
  const inAny = new Map()

  for (const e of strategy.edges) {
    outAny.set(e.source, (outAny.get(e.source) ?? 0) + 1)
    inAny.set(e.target, (inAny.get(e.target) ?? 0) + 1)
    if (e.kind === 'flow') {
      const list = outFlow.get(e.source) ?? []
      list.push({ label: e.label })
      outFlow.set(e.source, list)
    }
  }

  for (const node of strategy.nodes) {
    if (node.kind === 'decision') {
      const branches = outFlow.get(node.id) ?? []
      if (branches.length === 0) {
        lints.push({
          id: `decision-empty:${node.id}`,
          severity: 'warning',
          message: `Decision '${node.label}' has no branches — what are the possible outcomes?`,
          nodeId: node.id,
        })
      } else if (branches.length === 1) {
        lints.push({
          id: `decision-single:${node.id}`,
          severity: 'warning',
          message: `Decision '${node.label}' has only one branch ('${branches[0].label ?? 'unlabeled'}') — what happens otherwise?`,
          nodeId: node.id,
        })
      } else if (!branches.some(b => b.label && ELSE_LABELS.has(b.label.toLowerCase()))) {
        const labels = branches.map(b => b.label ?? 'unlabeled').join(', ')
        lints.push({
          id: `decision-no-else:${node.id}`,
          severity: 'suggestion',
          message: `Decision '${node.label}' (${labels}) has no explicit else/no branch — are all outcomes covered?`,
          nodeId: node.id,
        })
      }
    }

    if (node.kind === 'task' && !(outAny.get(node.id) ?? 0)) {
      lints.push({
        id: `dead-end:${node.id}`,
        severity: 'suggestion',
        message: `'${node.label}' is a dead end — nothing follows it. Should it lead somewhere or to an end?`,
        nodeId: node.id,
      })
    }
  }

  // Reachability from start nodes (or, absent starts, from roots).
  const starts = strategy.nodes.filter(n => n.kind === 'start').map(n => n.id)
  const roots = starts.length
    ? starts
    : strategy.nodes.filter(n => n.kind !== 'note' && !(inAny.get(n.id) ?? 0)).map(n => n.id)
  const adjacency = new Map()
  for (const e of strategy.edges) {
    const list = adjacency.get(e.source) ?? []
    list.push(e.target)
    adjacency.set(e.source, list)
  }
  const reachable = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    for (const next of adjacency.get(queue.pop()) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next)
        queue.push(next)
      }
    }
  }
  if (starts.length) {
    for (const node of strategy.nodes) {
      if (node.kind === 'note' || reachable.has(node.id)) continue
      // dependency sources are prerequisites, not unreachable work
      if (strategy.edges.some(e => e.kind === 'dependency' && e.source === node.id)) continue
      lints.push({
        id: `unreachable:${node.id}`,
        severity: 'warning',
        message: `'${node.label}' is not reachable from ${starts.length > 1 ? 'any start' : 'the start'} — how does the flow get there?`,
        nodeId: node.id,
      })
    }
  }

  return lints
}
