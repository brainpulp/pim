// AI assistant: tool definitions + executor + context builder + the browser-side agentic loop.
// The tools ARE the store actions, so the model drives the app through the same doors the UI uses.
import useGraphStore, { FILL_COLORS, SHAPES } from './graphStore'
import { callAssistant } from './db'
import { getWordgenKey } from './wordgen'

// Model for the assistant. Swap to 'claude-sonnet-5' or 'claude-haiku-4-5-20251001' for cheaper/faster.
const ASSISTANT_MODEL = 'claude-opus-5'

// ── Tool schemas (sent to Claude) ────────────────────────────────────────────
export const AI_TOOLS = [
  { name: 'create_node', description: 'Create a new node. Optionally make it a child of an existing node by passing parentId. Returns the new node id (use it to connect or nest further).',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      label: { type: 'string', description: 'The node text/label.' },
      parentId: { type: 'string', description: 'Optional id of an existing node to make this a child of.' },
    }, required: ['label'] } },
  { name: 'connect_nodes', description: 'Draw a directed edge from sourceId to targetId (both must be existing node ids).',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      sourceId: { type: 'string' }, targetId: { type: 'string' },
    }, required: ['sourceId', 'targetId'] } },
  { name: 'rename_node', description: 'Change a node\'s label.',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] } },
  { name: 'set_note', description: 'Set the note/body text of a node.',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] } },
  { name: 'add_tag', description: 'Add a tag to a node (no leading #).',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, tag: { type: 'string' } }, required: ['id', 'tag'] } },
  { name: 'set_color', description: `Set a node's fill color. Use a hex like "#f43f5e" or one of the palette colors: ${FILL_COLORS.join(', ')}. Pass "none" for transparent.`,
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, color: { type: 'string' } }, required: ['id', 'color'] } },
  { name: 'set_shape', description: `Set a node's shape. One of: ${SHAPES.join(', ')}.`,
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, shape: { type: 'string', enum: SHAPES } }, required: ['id', 'shape'] } },
  { name: 'reparent_node', description: 'Move a node to be a child of a different parent node.',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, newParentId: { type: 'string' } }, required: ['id', 'newParentId'] } },
  { name: 'delete_node', description: 'Delete a node. Destructive — only when clearly asked. (The whole batch is one undo step.)',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'make_kanban', description: 'Turn a node into a kanban board: its direct children become columns, and each column\'s children become cards. The node must have children.',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'make_strategy', description: 'Show a node\'s whole subtree as a strategy/flowchart card with draggable items.',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'show_as_list', description: 'Show a node\'s children as a nested list card. The node must have children.',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] } },
]

// ── Executor: map a tool call to a store action, return a compact result ──────
export function executeTool(name, input) {
  const s = useGraphStore.getState()
  const has = (id) => s.nodes.some(n => n.id === id)
  try {
    switch (name) {
      case 'create_node': {
        if (input.parentId && !has(input.parentId)) return { error: `No node with id ${input.parentId}` }
        const id = s.addNode(input.label, input.parentId || null)
        return { ok: true, id }
      }
      case 'connect_nodes':
        if (!has(input.sourceId) || !has(input.targetId)) return { error: 'Unknown source/target id' }
        s.addEdge(input.sourceId, input.targetId); return { ok: true }
      case 'rename_node':
        if (!has(input.id)) return { error: 'Unknown id' }
        s.updateLabel(input.id, input.label); return { ok: true }
      case 'set_note':
        if (!has(input.id)) return { error: 'Unknown id' }
        s.updateNotes(input.id, input.note); return { ok: true }
      case 'add_tag':
        if (!has(input.id)) return { error: 'Unknown id' }
        s.addNodeTag(input.id, input.tag); return { ok: true }
      case 'set_color':
        if (!has(input.id)) return { error: 'Unknown id' }
        s.setNodeViewProp(input.id, 'fillColor', input.color); return { ok: true }
      case 'set_shape':
        if (!has(input.id)) return { error: 'Unknown id' }
        s.setNodeViewProp(input.id, 'shape', input.shape); return { ok: true }
      case 'reparent_node':
        if (!has(input.id) || !has(input.newParentId)) return { error: 'Unknown id' }
        s.reparentNode(input.id, input.newParentId); return { ok: true }
      case 'delete_node':
        if (!has(input.id)) return { error: 'Unknown id' }
        s.deleteNode(input.id); return { ok: true }
      case 'make_kanban':
        if (!has(input.id)) return { error: 'Unknown id' }
        if (!s.edges.some(e => e.source === input.id)) return { error: 'Node has no children to make columns.' }
        s.toggleKanbanNode(input.id); return { ok: true }
      case 'make_strategy':
        if (!has(input.id)) return { error: 'Unknown id' }
        s.toggleStrategyNode(input.id); return { ok: true }
      case 'show_as_list':
        if (!has(input.id)) return { error: 'Unknown id' }
        if (!s.edges.some(e => e.source === input.id)) return { error: 'Node has no children to list.' }
        s.toggleListNode(input.id); return { ok: true }
      default:
        return { error: `Unknown tool ${name}` }
    }
  } catch (e) {
    return { error: e?.message || 'tool failed' }
  }
}

// ── Compact snapshot of the current graph, so the model can reference real ids ─
export function buildContext(selection = {}) {
  const s = useGraphStore.getState()
  const parentOf = {}
  s.edges.forEach(e => { if (parentOf[e.target] === undefined) parentOf[e.target] = e.source })
  const nodes = s.nodes.slice(0, 200).map(n => ({
    id: n.id, label: n.label || '', ...(n.meta?.tags?.length ? { tags: n.meta.tags } : {}),
    ...(parentOf[n.id] ? { parent: parentOf[n.id] } : {}),
  }))
  const edges = s.edges.slice(0, 300).map(e => [e.source, e.target])
  const truncated = s.nodes.length > 200
  return { activeView: s.views.find(v => v.id === s.activeViewId)?.name || 'Main',
    selectedNodeId: selection.selectedNodeId || null,
    selectedNodeIds: selection.selectedNodeIds || [],
    nodeCount: s.nodes.length, truncated, nodes, edges }
}

const SYSTEM = `You are the built-in assistant for PIM, a mind-map / knowledge-graph app. You edit the user's graph by calling tools — the tools are the app's own actions.

You are given a JSON snapshot of the current graph: nodes (id, label, optional tags, optional parent), edges as [source,target], the active view name, and the current selection. Reference nodes by their real ids from the snapshot. When the user says "this", "that", "the selected one(s)", use selectedNodeId / selectedNodeIds.

Rules:
- To build structure, create parents first, then create children passing parentId (create_node returns the new id), then connect_nodes if they also want visible edges.
- Only delete when the user clearly asks. Prefer non-destructive edits.
- Do exactly what was asked — don't invent extra nodes or restyle things unprompted.
- If a request is ambiguous or impossible with the available tools, don't call tools; briefly say what you can do instead.
- After acting, reply with ONE short sentence describing what you did (e.g. "Added 5 tasks under Launch and turned it into a kanban board."). No preamble, no bullet lists.`

// One Claude turn. Primary path: direct browser call with the user's own key (same one the naming
// generator uses — zero setup). Fallback: the `assistant` edge function (server-held key).
async function oneTurn(messages) {
  const key = getWordgenKey()
  if (key) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: ASSISTANT_MODEL, max_tokens: 4096, output_config: { effort: 'low' },
        system: SYSTEM, tools: AI_TOOLS, messages,
      }),
    })
    if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json())?.error?.message || m } catch { /* ignore */ } throw new Error(m) }
    return res.json()
  }
  return callAssistant({ messages, tools: AI_TOOLS, system: SYSTEM })
}

// ── Direct content generation (no tools) ─────────────────────────────────────
// Type a verbal prompt, get generated prose back. Used by the node "✨ Generate…"
// action to fill notes / spin up children / rewrite a label. Same key path as the
// assistant (browser-direct with the user's key, edge-function fallback).
const WRITER_MODEL = 'claude-sonnet-5'

const WRITER_SYSTEM = `You are a writing assistant embedded in PIM, a mind-map / knowledge-graph app. The user gives you a short verbal prompt and you produce content directly.

You will be told the desired OUTPUT MODE:
- "prose": write clear, well-structured prose (the node's note body). Use short paragraphs. No title heading — the node already has a label. Plain text, light Markdown at most.
- "list": produce a flat list of short items (each becomes a child node). Return ONE item per line, no numbering, no bullets, no blank lines, no commentary. Aim for the count the user asked for, otherwise 5–8 items. Keep each line under ~8 words.
- "label": produce a single short title/label (a few words). Return ONLY the label text, nothing else.

Context: you may be given the node's current label and note, and a few nearby nodes, to stay on-topic. Honor the user's language. Output only the requested content — no preamble like "Here is…", no closing remarks.`

// One no-tools Claude turn returning plain text. Mode ∈ 'prose' | 'list' | 'label'.
export async function generateContent(prompt, { mode = 'prose', context = null } = {}) {
  const parts = [`OUTPUT MODE: ${mode}`]
  if (context?.label) parts.push(`Node label: ${context.label}`)
  if (context?.note) parts.push(`Node's current note:\n${context.note}`)
  if (context?.nearby?.length) parts.push(`Nearby nodes: ${context.nearby.join(', ')}`)
  parts.push(`\nRequest: ${prompt}`)
  const messages = [{ role: 'user', content: parts.join('\n') }]

  const key = getWordgenKey()
  let text = ''
  if (key) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: WRITER_MODEL, max_tokens: 2048,
        system: WRITER_SYSTEM, messages,
      }),
    })
    if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json())?.error?.message || m } catch { /* ignore */ } throw new Error(m) }
    const json = await res.json()
    text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
  } else {
    const json = await callAssistant({ messages, system: WRITER_SYSTEM })
    text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
  }
  return text
}

// ── Agentic loop (browser-driven). onEvent({type}) for lightweight status. ────
export async function runAssistant(prompt, selection = {}, onEvent = () => {}) {
  const context = buildContext(selection)
  const messages = [{
    role: 'user',
    content: `Current graph snapshot:\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\`\n\nRequest: ${prompt}`,
  }]
  const store = useGraphStore.getState()
  let checkpointed = false
  let finalText = ''

  for (let turn = 0; turn < 6; turn++) {
    onEvent({ type: 'thinking' })
    const res = await oneTurn(messages)
    messages.push({ role: 'assistant', content: res.content })   // preserve full content (incl. thinking)

    const toolUses = (res.content || []).filter(b => b.type === 'tool_use')
    const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
    if (text) finalText = text

    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) break

    // One undo checkpoint for the whole AI action set.
    if (!checkpointed) { store.pushUndo(); checkpointed = true }

    const results = toolUses.map(tu => {
      onEvent({ type: 'tool', name: tu.name })
      const out = executeTool(tu.name, tu.input || {})
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) }
    })
    messages.push({ role: 'user', content: results })
  }

  onEvent({ type: 'done' })
  return finalText || 'Done.'
}
