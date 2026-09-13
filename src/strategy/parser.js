// Stratego DSL parser — line-based grammar for strategy flowcharts.
// Ported from the stratego repo (src/dsl/parser.ts), types stripped.

export function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'node'
}

export function edgeId(source, target, label) {
  return `${source}->${target}${label ? `#${label}` : ''}`
}

/** Splits "A -> B -[maybe]-> C" into segments and the label of each arrow. */
function splitChain(text) {
  const segments = []
  const labels = []
  const arrow = /-\[([^\]]*)\]->|->/g
  let last = 0
  let match
  while ((match = arrow.exec(text)) !== null) {
    segments.push(text.slice(last, match.index).trim())
    labels.push(match[1]?.trim() || undefined)
    last = match.index + match[0].length
  }
  segments.push(text.slice(last).trim())
  return { segments, labels }
}

export function parseDsl(text) {
  const lines = text.split('\n')
  const diagnostics = []

  const nodes = []
  const byId = new Map()
  const idByLowerLabel = new Map()
  const edges = new Map()
  let title

  function addDiag(line, from, to, severity, message) {
    diagnostics.push({ line, from, to, severity, message })
  }

  function declare(label, kind, pos, description) {
    const existingId = idByLowerLabel.get(label.toLowerCase())
    if (existingId) {
      const existing = byId.get(existingId)
      if (existing.kind !== kind) {
        addDiag(pos.line, pos.from, pos.to, 'error',
          `'${existing.label}' is already declared as a ${existing.kind}; it cannot also be a ${kind}.`)
        return null
      }
      if (description) existing.description = description
      return existing
    }
    let id = slugify(label)
    while (byId.has(id)) id = `${id}-x` // slug collision between distinct labels
    const node = { id, kind, label, ...(description ? { description } : {}) }
    nodes.push(node)
    byId.set(id, node)
    idByLowerLabel.set(label.toLowerCase(), id)
    return node
  }

  function resolve(label, pos, opts = {}) {
    const lower = label.toLowerCase()
    const existingId = idByLowerLabel.get(lower)
    if (existingId) return byId.get(existingId)
    // "A -> end" creates the terminator node, not a task named "end"
    if (lower === 'start' || lower === 'end') {
      return declare(lower === 'start' ? 'Start' : 'End', lower, pos)
    }
    if (opts.warnImplicit) {
      addDiag(pos.line, pos.from, pos.to, 'warning', `'${label}' was created implicitly as a task.`)
    }
    return declare(label, 'task', pos)
  }

  function addEdge(source, target, kind, label) {
    const id = edgeId(source, target, label) + (kind === 'dependency' ? '~dep' : '')
    if (!edges.has(id)) edges.set(id, { id, source, target, kind, ...(label ? { label } : {}) })
  }

  // Pass 1: classify lines and register declarations.
  const stmts = []
  let currentDecision = null
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = i + 1
    const from = offset
    const to = offset + raw.length
    offset = to + 1

    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indented = /^\s/.test(raw)
    if (indented) {
      if (currentDecision) {
        stmts.push({ type: 'branch', line, from, to, decision: currentDecision, text: trimmed })
      } else {
        addDiag(line, from, to, 'error', 'Indented branch lines are only allowed directly under a decision.')
      }
      continue
    }

    let m
    if ((m = trimmed.match(/^title:\s*(.*)$/i))) {
      title = m[1].trim() || undefined
    } else if (trimmed.includes('->')) {
      // classified before keywords so "Task review -> Next" is a chain, not a declaration
      stmts.push({ type: 'chain', line, from, to, text: trimmed })
    } else if ((m = trimmed.match(/^task\s+(.+)$/i))) {
      const colon = m[1].indexOf(':')
      const label = (colon >= 0 ? m[1].slice(0, colon) : m[1]).trim()
      const description = colon >= 0 ? m[1].slice(colon + 1).trim() : undefined
      if (!label) addDiag(line, from, to, 'error', 'task is missing a name.')
      else declare(label, 'task', { line, from, to }, description)
    } else if ((m = trimmed.match(/^decision\s+(.+)$/i))) {
      const node = declare(m[1].trim(), 'decision', { line, from, to })
      currentDecision = node?.id ?? null
    } else if (/\s+needs\s+/i.test(trimmed) && !/^(start|end)$/i.test(trimmed) && (m = trimmed.match(/^(.+?)\s+needs\s+(.+)$/i))) {
      stmts.push({ type: 'needs', line, from, to, subject: m[1].trim(), list: m[2].trim() })
    } else if ((m = trimmed.match(/^start(?:\s+(.+))?$/i))) {
      declare(m[1]?.trim() || 'Start', 'start', { line, from, to })
    } else if ((m = trimmed.match(/^end(?:\s+(.+))?$/i))) {
      declare(m[1]?.trim() || 'End', 'end', { line, from, to })
    } else if ((m = trimmed.match(/^note\s+(.+)$/i))) {
      declare(m[1].trim(), 'note', { line, from, to })
    } else {
      addDiag(line, from, to, 'error',
        'Unknown statement. Expected: task, decision, start, end, note, title:, a chain (A -> B), or X needs A, B.')
    }
  }

  // Pass 2: resolve references and build edges.
  for (const stmt of stmts) {
    const pos = { line: stmt.line, from: stmt.from, to: stmt.to }
    if (stmt.type === 'chain') {
      const { segments, labels } = splitChain(stmt.text)
      if (segments.some(s => !s)) {
        addDiag(stmt.line, stmt.from, stmt.to, 'error', 'Chain has a missing name before or after an arrow.')
        continue
      }
      const resolved = segments.map(s => resolve(s, pos))
      for (let i = 0; i < resolved.length - 1; i++) {
        const a = resolved[i]
        const b = resolved[i + 1]
        if (a && b) addEdge(a.id, b.id, 'flow', labels[i])
      }
    } else if (stmt.type === 'needs') {
      const subject = resolve(stmt.subject, pos)
      const parts = stmt.list
        .split(',')
        .flatMap(p => p.split(/\s+and\s+/i))
        .map(p => p.trim())
        .filter(Boolean)
      if (!subject) continue
      if (parts.length === 0) {
        addDiag(stmt.line, stmt.from, stmt.to, 'error', "'needs' must list at least one task name.")
        continue
      }
      for (const part of parts) {
        const dep = resolve(part, pos, { warnImplicit: true })
        if (dep) addEdge(dep.id, subject.id, 'dependency')
      }
    } else {
      // branch line under a decision: "label -> Target [-> Next ...]"
      const { segments, labels } = splitChain(stmt.text)
      if (segments.length < 2 || segments.some(s => !s)) {
        addDiag(stmt.line, stmt.from, stmt.to, 'error', 'Branch line must look like: yes -> Some task')
        continue
      }
      if (labels[0]) {
        addDiag(stmt.line, stmt.from, stmt.to, 'error',
          'Use either a branch label or -[label]->, not both on the first arrow.')
        continue
      }
      const branchLabel = segments[0]
      const resolved = segments.slice(1).map(s => resolve(s, pos))
      if (resolved[0]) addEdge(stmt.decision, resolved[0].id, 'flow', branchLabel)
      for (let i = 0; i < resolved.length - 1; i++) {
        const a = resolved[i]
        const b = resolved[i + 1]
        if (a && b) addEdge(a.id, b.id, 'flow', labels[i + 1])
      }
    }
  }

  return {
    strategy: { version: 1, ...(title ? { title } : {}), nodes, edges: [...edges.values()] },
    diagnostics,
    names: nodes.map(n => n.label),
  }
}
