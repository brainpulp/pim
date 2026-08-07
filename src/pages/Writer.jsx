import { useEffect, useMemo, useRef, useState } from 'react'
import useGraphStore from '../lib/graphStore'

// ─── Writer ──────────────────────────────────────────────────────────────────
// Full-screen, keyboard-driven outliner over the same nodes+edges as the graph, with a lightweight
// markdown/tag system: shorthand you type turns line items into database records (tasks, tags, dates,
// people, priorities, custom fields) that are findable everywhere. Tokens render as removable chips.
//
// Shorthand (type it, then a space):
//   /task /note /idea /question /event   → sets the item TYPE (task also gets a checkbox)
//   []  or  [x]  at line start           → task (unchecked / done)
//   #   or  ## at line start             → heading level 1 / 2
//   #tag                                 → tag chip
//   @person                              → person chip
//   !high !med !low !urgent              → priority
//   key:value  (e.g. due:tomorrow, status:doing, cost:50) → a custom field; `due:` parses dates

const TEXT_COLORS = ['#111827', '#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#6b7280', '#ffffff']

const SHORTCUT_ACTIONS = [
  { id: 'newItem', label: 'New item' }, { id: 'indent', label: 'Indent (demote)' },
  { id: 'outdent', label: 'Outdent (promote)' }, { id: 'moveUp', label: 'Move up' },
  { id: 'moveDown', label: 'Move down' }, { id: 'collapse', label: 'Collapse' },
  { id: 'expand', label: 'Expand' }, { id: 'deleteItem', label: 'Delete empty item' },
]
const DEFAULT_KEYS = {
  newItem: 'Enter', indent: 'Tab', outdent: 'Shift+Tab', moveUp: 'Alt+ArrowUp',
  moveDown: 'Alt+ArrowDown', collapse: 'Mod+ArrowUp', expand: 'Mod+ArrowDown', deleteItem: 'Backspace',
}
function comboFromEvent(e) {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null
  const parts = []
  if (e.metaKey || e.ctrlKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return parts.join('+')
}
function prettyCombo(combo) {
  if (!combo) return '—'
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '')
  return combo.split('+').map(p => ({ Mod: mac ? '⌘' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: '⇧', ArrowUp: '↑', ArrowDown: '↓', Enter: '⏎', Backspace: '⌫', Tab: '⇥', Escape: 'Esc' }[p] || p)).join(mac ? '' : '+')
}

const TYPE_META = {
  task: { icon: '☑', label: 'Task', color: '#2563eb' },
  note: { icon: '📝', label: 'Note', color: '#6b7280' },
  idea: { icon: '💡', label: 'Idea', color: '#ca8a04' },
  question: { icon: '❓', label: 'Question', color: '#7c3aed' },
  event: { icon: '📅', label: 'Event', color: '#16a34a' },
}
const PRIORITY_META = {
  urgent: { label: 'Urgent', color: '#dc2626' }, high: { label: 'High', color: '#ea580c' },
  med: { label: 'Med', color: '#ca8a04' }, low: { label: 'Low', color: '#16a34a' },
}
// deterministic colour for a tag string
function tagColor(t) {
  let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360
  return `hsl(${h} 55% 48%)`
}
function parseDate(raw) {
  const s = (raw || '').toLowerCase().trim()
  const d = new Date()
  const iso = x => x.toISOString().slice(0, 10)
  if (s === 'today') return iso(d)
  if (s === 'tomorrow') return iso(new Date(d.getTime() + 864e5))
  if (s === 'yesterday') return iso(new Date(d.getTime() - 864e5))
  const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(s.slice(0, 3))
  if (wd >= 0) { let add = (wd - d.getDay() + 7) % 7; if (add === 0) add = 7; return iso(new Date(d.getTime() + add * 864e5)) }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/)
  if (md) return iso(new Date(d.getFullYear(), +md[1] - 1, +md[2]))
  return raw   // store as-is if unrecognised
}

// Pull the ONE shorthand token that ends exactly at the caret (i.e. the user just typed the closing
// space). Anchoring to the caret avoids misreading spaces already present later in the line — e.g. typing
// "# " at the start of "Second point" must become a heading, not the tag "#Second".
// Returns { text, act, caret } or null.
function consumeTokenAt(value, caret) {
  const head = value.slice(0, caret), tail = value.slice(caret)
  let m = head.match(/^\[( |x|X)?\]\s$/)
  if (m) return { text: tail, caret: 0, act: { type: 'task', done: !!(m[1] && m[1].toLowerCase() === 'x') } }
  m = head.match(/^(#{1,2})\s$/)
  if (m) return { text: tail, caret: 0, act: { heading: m[1].length } }
  m = head.match(/(^|\s)(\/[a-z]+|#[\w-]+|@[\w-]+|![\w-]+|[A-Za-z][\w-]*:[\w./-]+)\s$/)
  if (!m) return null
  const newHead = head.slice(0, m.index) + m[1]   // keep the boundary char, drop "token "
  const text = newHead + tail, cpos = newHead.length, tok = m[2]
  let act = null
  if (tok[0] === '/') { const t = tok.slice(1); act = TYPE_META[t] ? { type: t, ...(t === 'task' ? { done: false } : {}) } : null }
  else if (tok[0] === '#') act = { tag: tok.slice(1) }
  else if (tok[0] === '@') act = { person: tok.slice(1) }
  else if (tok[0] === '!') { const pr = tok.slice(1); act = PRIORITY_META[pr] ? { priority: pr } : null }
  else { const [k, ...rest] = tok.split(':'); const v = rest.join(':'); const key = k.toLowerCase(); act = { field: [key, key === 'due' ? parseDate(v) : v] } }
  return { text, caret: cpos, act }
}

export default function Writer({ projectName, embedded = false }) {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const views = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const addNode = useGraphStore(s => s.addNode)
  const updateLabel = useGraphStore(s => s.updateLabel)
  const updateNotes = useGraphStore(s => s.updateNotes)
  const reparentNode = useGraphStore(s => s.reparentNode)
  const moveChild = useGraphStore(s => s.moveChild)
  const deleteNode = useGraphStore(s => s.deleteNode)
  const setNodeWriteStyle = useGraphStore(s => s.setNodeWriteStyle)
  const setNodeMeta = useGraphStore(s => s.setNodeMeta)
  const addNodeTag = useGraphStore(s => s.addNodeTag)
  const removeNodeTag = useGraphStore(s => s.removeNodeTag)
  const addNodePerson = useGraphStore(s => s.addNodePerson)
  const setNodeField = useGraphStore(s => s.setNodeField)
  const removeNodeField = useGraphStore(s => s.removeNodeField)
  const selectedNodeId = useGraphStore(s => s.selectedNodeId)
  const setSelectedNodeId = useGraphStore(s => s.setSelectedNodeId)

  const nodeProps = useMemo(() => (views.find(v => v.id === activeViewId)?.nodeProps) || {}, [views, activeViewId])
  const byId = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes])
  const childrenOf = useMemo(() => { const m = {}; edges.forEach(e => { (m[e.source] = m[e.source] || []).push(e.target) }); return m }, [edges])
  const parentOf = useMemo(() => { const m = {}; edges.forEach(e => { m[e.target] = e.source }); return m }, [edges])
  const roots = useMemo(() => nodes.filter(n => !parentOf[n.id]).map(n => n.id), [nodes, parentOf])

  const [dark, setDark] = useState(() => { try { return localStorage.getItem('pim_writer_dark') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('pim_writer_dark', dark ? '1' : '0') } catch { /* ignore */ } }, [dark])
  const [keymap, setKeymap] = useState(() => { try { return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('pim_writer_keys') || '{}') } } catch { return { ...DEFAULT_KEYS } } })
  useEffect(() => { try { localStorage.setItem('pim_writer_keys', JSON.stringify(keymap)) } catch { /* ignore */ } }, [keymap])
  const keymapRef = useRef(keymap); useEffect(() => { keymapRef.current = keymap }, [keymap])
  const [showKeys, setShowKeys] = useState(false)
  const [capturing, setCapturing] = useState(null)

  const [collapsed, setCollapsed] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set())
  const [focusId, setFocusId] = useState(null)
  const [focusRoot, setFocusRoot] = useState(null)   // zoom-into-item
  const [framesOpen, setFramesOpen] = useState(false)   // collapsible "Frames" section
  const [search, setSearch] = useState('')
  const [showQuery, setShowQuery] = useState(false)                 // the database/query bar
  const [q, setQ] = useState({ type: null, priority: null, tag: null, done: 'all' })
  const [agenda, setAgenda] = useState(false)                       // due-date agenda view
  const [dbTable, setDbTable] = useState(false)                     // database table of all chipped items
  const [showHelp, setShowHelp] = useState(false)                   // markdown cheatsheet
  const [showColorMenu, setShowColorMenu] = useState(false)
  const wrapRef = useRef(null)
  const [isFull, setIsFull] = useState(false)
  const toggleFull = () => {
    const el = wrapRef.current; if (!el) return
    if (!document.fullscreenElement) { el.requestFullscreen?.().then(() => setIsFull(true)).catch(() => {}) }
    else { document.exitFullscreen?.().then(() => setIsFull(false)).catch(() => {}) }
  }
  useEffect(() => { const h = () => setIsFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h) }, [])
  const [templates, setTemplates] = useState(() => { try { return JSON.parse(localStorage.getItem('pim_writer_templates') || '[]') } catch { return [] } })
  useEffect(() => { try { localStorage.setItem('pim_writer_templates', JSON.stringify(templates)) } catch { /* ignore */ } }, [templates])
  const [showTpl, setShowTpl] = useState(false)
  const pendingFocus = useRef(null)
  const inputs = useRef({})

  const allTags = useMemo(() => { const s = new Set(); nodes.forEach(n => (n.meta?.tags || []).forEach(t => s.add(t))); return [...s].sort() }, [nodes])
  const qActive = !!(q.type || q.priority || q.tag || q.done !== 'all')
  const matchesQuery = (n) => {
    const m = n.meta || {}
    if (q.type && m.itemType !== q.type) return false
    if (q.priority && m.priority !== q.priority) return false
    if (q.tag && !(m.tags || []).includes(q.tag)) return false
    if (q.done === 'open' && !(m.itemType === 'task' && !m.done)) return false
    if (q.done === 'done' && !(m.itemType === 'task' && m.done)) return false
    return true
  }

  const descendants = (id) => { const out = []; const walk = x => (childrenOf[x] || []).forEach(c => { out.push(c); walk(c) }); walk(id); return out }
  const ancestorsOf = (id) => { const out = []; let p = parentOf[id]; while (p) { out.push(p); p = parentOf[p] } return out }
  // Rollup: aggregate task done/total across a node's descendants (for the parent progress badge).
  const rollupOf = (id) => { let t = 0, d = 0; descendants(id).forEach(c => { const m = byId[c]?.meta; if (m?.itemType === 'task') { t++; if (m.done) d++ } }); return { t, d } }

  // rows = flattened visible tree (honoring collapse + focusRoot). Search or a query filter → flat list.
  const searchLC = search.trim().toLowerCase()
  const flatMode = searchLC || qActive
  // Frames (and other board-only container shapes) live on the canvas via the per-view
  // `containedIn` prop, not via edges. The outline is edge-driven, so a frame has no parent
  // and would surface as its own root row next to the node it visually wraps — reading as a
  // duplicate. Keep them out of the outline entirely.
  const isFrame = (id) => nodeProps[id]?.shape === 'frame'
  const rows = useMemo(() => {
    if (flatMode) {
      const hit = n => !searchLC || (n.label || '').toLowerCase().includes(searchLC) || ((n.meta?.tags) || []).some(t => t.toLowerCase().includes(searchLC)) || ((n.meta?.people) || []).some(t => t.toLowerCase().includes(searchLC))
      return nodes.filter(n => hit(n) && !isFrame(n.id) && (!qActive || matchesQuery(n))).map(n => ({ id: n.id, depth: 0, parentId: parentOf[n.id] || null, hasChildren: (childrenOf[n.id] || []).length > 0 }))
    }
    const out = []; const seen = new Set()
    const walk = (id, depth) => {
      if (seen.has(id) || !byId[id] || isFrame(id)) return
      seen.add(id)
      const kids = childrenOf[id] || []
      out.push({ id, depth, parentId: parentOf[id] || null, hasChildren: kids.length > 0 })
      if (!collapsed.has(id)) kids.forEach(k => walk(k, depth + 1))
    }
    const startIds = focusRoot ? (childrenOf[focusRoot] || []) : roots
    startIds.forEach(r => walk(r, 0))
    if (!focusRoot) nodes.forEach(n => { if (!seen.has(n.id)) walk(n.id, 0) })
    return out
  }, [byId, childrenOf, parentOf, roots, collapsed, nodes, focusRoot, searchLC, flatMode, qActive, q, nodeProps])

  const rowIndex = useMemo(() => Object.fromEntries(rows.map((r, i) => [r.id, i])), [rows])
  // Frames are kept out of the edge-driven tree above; they get their own grouped section.
  const frameNodes = useMemo(() => nodes.filter(n => isFrame(n.id)), [nodes, nodeProps])

  useEffect(() => {
    if (pendingFocus.current && inputs.current[pendingFocus.current]) {
      const el = inputs.current[pendingFocus.current]; el.focus()
      const v = el.value; el.setSelectionRange(v.length, v.length); pendingFocus.current = null
    }
  })

  const siblings = (id) => { const p = parentOf[id]; return p ? (childrenOf[p] || []) : roots }
  const focusRow = (idx) => { const r = rows[idx]; if (r) { selectRow(r.id); inputs.current[r.id]?.focus() } }
  const selectRow = (id) => { setFocusId(id); setSelectedNodeId(id) }   // sync outliner → canvas

  // Sync canvas → outliner: when the shared selection changes elsewhere, reveal that row here
  // (clear filters, uncollapse its ancestors, scroll it into view; focus it only when docked).
  useEffect(() => {
    if (!selectedNodeId || selectedNodeId === focusId || !byId[selectedNodeId]) return
    setSearch(''); setFocusRoot(null)
    setCollapsed(s => { const n = new Set(s); ancestorsOf(selectedNodeId).forEach(a => n.delete(a)); return n })
    setFocusId(selectedNodeId)
    requestAnimationFrame(() => { const el = inputs.current[selectedNodeId]; if (el) { if (embedded) el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } })
  }, [selectedNodeId]) // eslint-disable-line

  const addSiblingAfter = (id) => {
    const p = parentOf[id] || null
    const sibs = p ? (childrenOf[p] || []) : roots
    const after = sibs[sibs.indexOf(id) + 1] || null
    const newId = addNode('', p)
    if (p && after) moveChild(p, newId, after)
    pendingFocus.current = newId; setFocusId(newId)
  }
  const demote = (id) => { const sibs = siblings(id); const prev = sibs[sibs.indexOf(id) - 1]; if (!prev) return; reparentNode(id, prev); pendingFocus.current = id }
  const promote = (id) => {
    const p = parentOf[id]; if (!p) return
    const gp = parentOf[p] || null
    reparentNode(id, gp)
    if (gp) moveChild(gp, id, (childrenOf[gp] || [])[(childrenOf[gp] || []).indexOf(p) + 1] || null)
    pendingFocus.current = id
  }
  const move = (id, dir) => {
    const p = parentOf[id]; if (!p) return
    const sibs = childrenOf[p] || []; const at = sibs.indexOf(id)
    if (dir < 0 && at > 0) moveChild(p, id, sibs[at - 1])
    else if (dir > 0 && at < sibs.length - 1) moveChild(p, id, sibs[at + 2] || null)
    pendingFocus.current = id
  }
  const toggleCollapse = (id, want) => setCollapsed(s => { const n = new Set(s); if (want === false || (want == null && n.has(id))) n.delete(id); else n.add(id); return n })
  const toggleDetails = (id) => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const foldAll = () => setCollapsed(new Set(nodes.filter(n => (childrenOf[n.id] || []).length).map(n => n.id)))
  const expandAll = () => setCollapsed(new Set())

  // Apply typed shorthand: strip the just-completed token from the text and write node meta. Restores
  // the caret to where the token used to be so typing continues naturally.
  const onChangeLabel = (id, value, caret, el) => {
    // [[Label]] → a relation to another node (found by label, or created). Stored in meta.links.
    const wl = value.match(/\[\[([^[\]]+)\]\]/)
    if (wl && wl[1].trim()) {
      const label = wl[1].trim()
      const found = nodes.find(n => (n.label || '').trim().toLowerCase() === label.toLowerCase())
      const targetId = found?.id || addNode(label, null)
      if (targetId && targetId !== id) {
        const cur = byId[id]?.meta?.links || []
        if (!cur.includes(targetId)) setNodeMeta(id, { links: [...cur, targetId] })
      }
      updateLabel(id, value.slice(0, wl.index) + value.slice(wl.index + wl[0].length))
      return
    }
    const c = consumeTokenAt(value, caret)
    if (!c) { updateLabel(id, value); return }
    const a = c.act
    if (a) {
      if (a.tag) addNodeTag(id, a.tag)
      else if (a.person) addNodePerson(id, a.person)
      else if (a.type) setNodeMeta(id, { itemType: a.type, ...(a.type === 'task' ? { done: false } : {}) })
      else if (a.priority) setNodeMeta(id, { priority: a.priority })
      else if (a.heading != null) setNodeMeta(id, { heading: a.heading })
      else if (a.field) setNodeField(id, a.field[0], a.field[1])
    }
    updateLabel(id, c.text)
  }

  const runAction = (action, id, el) => {
    switch (action) {
      case 'newItem': addSiblingAfter(id); return
      case 'indent': demote(id); return
      case 'outdent': promote(id); return
      case 'moveUp': move(id, -1); return
      case 'moveDown': move(id, 1); return
      case 'collapse': toggleCollapse(id, true); return
      case 'expand': toggleCollapse(id, false); return
      case 'deleteItem':
        if (el.value === '' && (childrenOf[id] || []).length === 0) { const idx = rowIndex[id]; deleteNode(id); focusRow(Math.max(0, idx - 1)) }
        return
    }
  }
  const onKey = (e, id) => {
    const el = e.currentTarget
    const combo = comboFromEvent(e)
    if (combo) {
      const km = keymapRef.current
      const action = SHORTCUT_ACTIONS.map(a => a.id).find(a => km[a] === combo)
      if (action && !(action === 'deleteItem' && el.value !== '')) { e.preventDefault(); runAction(action, id, el); return }
    }
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    if (e.key === 'ArrowUp' && atStart && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); focusRow(rowIndex[id] - 1); return }
    if (e.key === 'ArrowDown' && el.selectionStart === el.value.length && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); focusRow(rowIndex[id] + 1); return }
    if (e.key === 'Escape') el.blur()
  }

  const addRoot = () => { const id = addNode('', null); pendingFocus.current = id; setFocusId(id) }

  // Export the (focused) outline to Markdown, tasks + tags included.
  // ── Templates: save a node's subtree as a reusable outline; insert it under the focused item. ──
  const cleanMeta = (m) => { if (!m) return null; const { links, ...rest } = m; return Object.keys(rest).length ? rest : null }
  const saveTemplate = (id) => {
    const items = []
    const walk = (nid, d) => { const n = byId[nid]; if (!n) return; items.push({ d, label: n.label || '', meta: cleanMeta(n.meta) }); (childrenOf[nid] || []).forEach(c => walk(c, d + 1)) }
    walk(id, 0)
    const name = (window.prompt('Template name:', byId[id]?.label || 'Template') || '').trim()
    if (!name) return
    setTemplates(ts => [...ts.filter(t => t.name !== name), { name, items }])
    setShowTpl(false)
  }
  const insertTemplate = (tpl) => {
    const base = focusId || null
    const stack = []
    let firstId = null
    tpl.items.forEach(it => {
      const parent = it.d === 0 ? base : (stack[it.d - 1] ?? base)
      const newId = addNode(it.label, parent)
      if (it.meta) setNodeMeta(newId, it.meta)
      stack[it.d] = newId; stack.length = it.d + 1
      if (firstId == null) firstId = newId
    })
    setShowTpl(false)
    if (firstId) { pendingFocus.current = firstId; selectRow(firstId) }
  }

  // ── Agenda: group tasks by due date into Overdue / Today / Tomorrow / This week / Later / No date. ──
  const agendaGroups = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const iso = d => d.toISOString().slice(0, 10)
    const todayS = iso(today), tomorrowS = iso(new Date(today.getTime() + 864e5)), weekS = iso(new Date(today.getTime() + 7 * 864e5))
    const G = { Overdue: [], Today: [], Tomorrow: [], 'This week': [], Later: [], 'No date': [] }
    nodes.forEach(n => {
      if (n.meta?.itemType !== 'task') return
      const due = n.meta?.fields?.due
      if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) G['No date'].push(n)
      else if (due < todayS) G.Overdue.push(n)
      else if (due === todayS) G.Today.push(n)
      else if (due === tomorrowS) G.Tomorrow.push(n)
      else if (due <= weekS) G['This week'].push(n)
      else G.Later.push(n)
    })
    Object.values(G).forEach(a => a.sort((x, y) => (x.meta?.fields?.due || '9999').localeCompare(y.meta?.fields?.due || '9999')))
    return G
  }, [nodes])

  const exportMd = () => {
    const lines = []
    const walk = (id, depth) => {
      const n = byId[id]; if (!n) return
      const m = n.meta || {}
      const ind = '  '.repeat(depth)
      let bullet = '-'
      if (m.itemType === 'task') bullet = m.done ? '- [x]' : '- [ ]'
      let text = n.label || ''
      if (m.heading) text = '#'.repeat(m.heading) + ' ' + text
      const tags = [...(m.tags || []).map(t => '#' + t), ...(m.people || []).map(p => '@' + p)]
      if (m.priority) tags.push('!' + m.priority)
      Object.entries(m.fields || {}).forEach(([k, v]) => { if (v != null) tags.push(`${k}:${v}`) })
      lines.push(`${ind}${bullet} ${text}${tags.length ? ' ' + tags.join(' ') : ''}`.replace(/\s+$/, ''))
      ;(childrenOf[id] || []).forEach(c => walk(c, depth + 1))
    }
    ;(focusRoot ? (childrenOf[focusRoot] || []) : roots).forEach(r => walk(r, 0))
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `${(projectName || 'outline').replace(/\s+/g, '-')}.md`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const bg = dark ? '#0f1115' : '#ffffff'
  const fg = dark ? '#e8ecf4' : '#1f2430'
  const faint = dark ? '#7c869c' : '#9aa3b2'
  const line = dark ? '#232838' : '#eceef3'
  // Chevron + bullet are important nav affordances → prominent: high contrast + bold.
  // "In black" applies on the light (white) paper; on the dark theme black would be
  // invisible, so use a bright near-white there (never dark-on-dark).
  const bulletC = dark ? '#e8eeff' : '#000000'
  const chevC = dark ? '#e8eeff' : '#000000'
  const focusNode = focusId ? byId[focusId] : null
  const fs = focusNode?.writeStyle || {}
  const styleFocused = (patch) => { if (focusId) setNodeWriteStyle(focusId, patch); inputs.current[focusId]?.focus() }
  const words = useMemo(() => nodes.reduce((a, n) => a + ((n.label || '').trim() ? n.label.trim().split(/\s+/).length : 0), 0), [nodes])
  const taskStats = useMemo(() => { let t = 0, d = 0; nodes.forEach(n => { if (n.meta?.itemType === 'task') { t++; if (n.meta.done) d++ } }); return { t, d } }, [nodes])

  const tbtn = (active) => ({ background: active ? (dark ? '#2a3358' : '#e8ebff') : 'transparent', border: `1px solid ${active ? '#5b6af0' : (dark ? '#2a3050' : '#e2e5ee')}`, color: active ? '#5b6af0' : faint, borderRadius: 7, cursor: 'pointer', fontSize: 13, padding: '4px 9px', minWidth: 30 })
  // Clean ghost toolbar button (revamped skin) — no borders, subtle hover (see .pim-wtb in index.css).
  const tb = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 5, background: active ? (dark ? '#232a45' : '#eaeefb') : 'transparent', border: 'none', color: active ? '#5b6af0' : faint, borderRadius: 8, cursor: 'pointer', fontSize: 13, padding: '6px 9px', fontFamily: '-apple-system, sans-serif', lineHeight: 1 })
  const segWrap = { display: 'flex', gap: 2, padding: 3, background: dark ? '#14181f' : '#f1f3f9', borderRadius: 10 }
  const segItem = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 500, fontFamily: '-apple-system, sans-serif', background: active ? (dark ? '#282c4a' : '#ffffff') : 'transparent', color: active ? (dark ? '#eef1ff' : '#1f2430') : faint, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.18)' : 'none' })
  const divider = <div style={{ width: 1, height: 18, background: line, margin: '0 3px', flexShrink: 0 }} />
  const mode = dbTable ? 'table' : agenda ? 'agenda' : 'outline'
  const setMode = (m) => { setDbTable(m === 'table'); setAgenda(m === 'agenda') }

  // ── one chip
  const Chip = ({ text, color, onRemove, title }) => (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: '-apple-system, sans-serif', fontSize: 11.5, lineHeight: '18px', height: 18, padding: '0 6px', borderRadius: 9, background: color + '22', color, border: `1px solid ${color}55`, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {text}
      {onRemove && <span onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onRemove() }} style={{ cursor: 'pointer', opacity: 0.6, fontSize: 12 }}>×</span>}
    </span>
  )
  const metaChips = (id, m) => {
    if (!m) return null
    const out = []
    if (m.itemType && m.itemType !== 'task') { const tm = TYPE_META[m.itemType]; out.push(<Chip key="ty" text={`${tm.icon} ${tm.label}`} color={tm.color} onRemove={() => setNodeMeta(id, { itemType: null })} />) }
    if (m.priority) { const pm = PRIORITY_META[m.priority]; out.push(<Chip key="pr" text={pm.label} color={pm.color} onRemove={() => setNodeMeta(id, { priority: null })} />) }
    if (m.fields?.due) out.push(<Chip key="due" text={`📅 ${m.fields.due}`} color="#0891b2" onRemove={() => removeNodeField(id, 'due')} />)
    ;(m.tags || []).forEach(t => out.push(<Chip key={'t' + t} text={`#${t}`} color={tagColor(t)} onRemove={() => removeNodeTag(id, t)} />))
    ;(m.people || []).forEach(p => out.push(<Chip key={'p' + p} text={`@${p}`} color="#db2777" onRemove={() => setNodeMeta(id, { people: (m.people || []).filter(x => x !== p) })} />))
    Object.entries(m.fields || {}).forEach(([k, v]) => { if (k === 'due' || v == null) return; out.push(<Chip key={'f' + k} text={`${k}: ${v}`} color="#6366f1" onRemove={() => removeNodeField(id, k)} />) })
    ;(m.links || []).forEach(lid => { const t = byId[lid]; if (!t) return; out.push(
      <span key={'l' + lid} title="Go to linked item" onClick={() => setSelectedNodeId(lid)} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: '-apple-system, sans-serif', fontSize: 11.5, lineHeight: '18px', height: 18, padding: '0 6px', borderRadius: 9, background: '#7c8cff22', color: '#7c8cff', border: '1px solid #7c8cff55', whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer' }}>
        ↗ {t.label || 'Untitled'}<span onClick={e => { e.stopPropagation(); setNodeMeta(id, { links: (m.links || []).filter(x => x !== lid) }) }} style={{ cursor: 'pointer', opacity: 0.6 }}>×</span>
      </span>) })
    return out
  }

  return (
    <div ref={wrapRef} style={{ height: '100%', background: bg, color: fg, display: 'flex', flexDirection: 'column', fontFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif' }}>
      {/* Toolbar — clean, grouped, ghost buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 14px', borderBottom: `1px solid ${line}`, flexShrink: 0, fontFamily: '-apple-system, sans-serif' }}>
        <button className="pim-wtb" onClick={addRoot} title="New item" style={{ ...tb(false), color: '#5b6af0', fontWeight: 600 }}>＋ New</button>
        {divider}
        {/* format */}
        <button className="pim-wtb" title="Bold" onClick={() => styleFocused({ bold: !fs.bold })} style={{ ...tb(fs.bold), fontWeight: 800, width: 30, justifyContent: 'center' }}>B</button>
        <button className="pim-wtb" title="Italic" onClick={() => styleFocused({ italic: !fs.italic })} style={{ ...tb(fs.italic), fontStyle: 'italic', width: 30, justifyContent: 'center' }}>I</button>
        <button className="pim-wtb" title="Metallic" onClick={() => styleFocused({ metallic: !fs.metallic })} style={{ ...tb(fs.metallic), width: 30, justifyContent: 'center' }}>✨</button>
        <div style={{ position: 'relative' }}>
          <button className="pim-wtb" title="Text colour" onClick={() => setShowColorMenu(v => !v)} style={{ ...tb(false), width: 30, justifyContent: 'center' }}>
            <span style={{ width: 13, height: 13, borderRadius: '50%', background: fs.color || (dark ? '#e8ecf4' : '#1f2430'), border: '1.5px solid rgba(128,128,160,0.4)' }} />
          </button>
          {showColorMenu && (<>
            <div onMouseDown={() => setShowColorMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
            <div onMouseDown={e => e.stopPropagation()} style={{ position: 'absolute', top: '115%', left: 0, zIndex: 41, background: dark ? '#161a24' : '#fff', border: `1px solid ${line}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.3)', padding: 8, display: 'flex', flexWrap: 'wrap', gap: 6, width: 148 }}>
              {TEXT_COLORS.map(c => <div key={c} onClick={() => { styleFocused({ color: c }); setShowColorMenu(false) }} style={{ width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', border: `2px solid ${fs.color === c ? '#5b6af0' : 'transparent'}` }} />)}
              <div onClick={() => { styleFocused({ color: null }); setShowColorMenu(false) }} title="Default" style={{ width: 18, height: 18, borderRadius: '50%', cursor: 'pointer', border: `1px solid ${line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: faint }}>⦸</div>
            </div>
          </>)}
        </div>
        {divider}
        {/* view switcher */}
        <div style={segWrap}>
          <button style={segItem(mode === 'outline')} onClick={() => setMode('outline')}>☰ Outline</button>
          <button style={segItem(mode === 'table')} onClick={() => setMode('table')}>▦ Table</button>
          <button style={segItem(mode === 'agenda')} onClick={() => setMode('agenda')}>🗓 Agenda</button>
        </div>
        <button className="pim-wtb" title="Fold all" onClick={foldAll} style={{ ...tb(false), width: 30, justifyContent: 'center' }}>⊟</button>
        <button className="pim-wtb" title="Expand all" onClick={expandAll} style={{ ...tb(false), width: 30, justifyContent: 'center' }}>⊞</button>
        <button className="pim-wtb" title="Filter" onClick={() => setShowQuery(v => !v)} style={tb(showQuery || qActive)}>⌗ Filter{qActive ? ' •' : ''}</button>
        <div style={{ position: 'relative' }}>
          <button className="pim-wtb" title="Templates" onClick={() => setShowTpl(v => !v)} style={tb(showTpl)}>⧉</button>
          {showTpl && (<>
            <div onMouseDown={() => setShowTpl(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
            <div onMouseDown={e => e.stopPropagation()} style={{ position: 'absolute', top: '110%', left: 0, zIndex: 41, minWidth: 210, background: dark ? '#161a24' : '#fff', border: `1px solid ${line}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.35)', padding: 6 }}>
              <div onClick={() => focusId && saveTemplate(focusId)} style={{ padding: '6px 9px', borderRadius: 6, cursor: focusId ? 'pointer' : 'default', color: focusId ? '#5b6af0' : faint, fontSize: 13 }}>＋ Save “{focusId ? (byId[focusId]?.label || 'item') : '—'}” as template</div>
              {templates.length > 0 && <div style={{ borderTop: `1px solid ${line}`, margin: '4px 0' }} />}
              {templates.map(t => (
                <div key={t.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 9px', borderRadius: 6 }}>
                  <span onClick={() => insertTemplate(t)} style={{ cursor: 'pointer', fontSize: 13, color: fg, flex: 1 }}>{t.name} <span style={{ color: faint, fontSize: 11 }}>({t.items.length})</span></span>
                  <span onClick={() => setTemplates(ts => ts.filter(x => x.name !== t.name))} style={{ cursor: 'pointer', color: '#e11d48', fontSize: 13, paddingLeft: 8 }}>×</span>
                </div>
              ))}
              {templates.length === 0 && <div style={{ padding: '5px 9px', color: faint, fontSize: 12 }}>No templates yet. Focus an item and save it.</div>}
            </div>
          </>)}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
          style={{ background: dark ? '#141821' : '#f4f6fb', border: `1px solid ${line}`, color: fg, borderRadius: 8, padding: '6px 10px', fontSize: 13, fontFamily: '-apple-system, sans-serif', outline: 'none', width: 130 }} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 11.5, color: faint, marginRight: 4 }}>{taskStats.t > 0 && `${taskStats.d}/${taskStats.t} · `}{nodes.length} items</span>
          <button className="pim-wtb" title="Markdown shortcuts (help)" onClick={() => setShowHelp(true)} style={{ ...tb(false), width: 30, justifyContent: 'center' }}>?</button>
          <button className="pim-wtb" title="Export to Markdown" onClick={exportMd} style={{ ...tb(false), width: 30, justifyContent: 'center' }}>⬇︎</button>
          <button className="pim-wtb" title="Keyboard shortcuts" onClick={() => { setShowKeys(true); setCapturing(null) }} style={{ ...tb(false), width: 30, justifyContent: 'center' }}>⌨</button>
          <button className="pim-wtb" title={isFull ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFull} style={{ ...tb(isFull), width: 30, justifyContent: 'center' }}>{isFull ? '⤢' : '⛶'}</button>
          <button className="pim-wtb" title="Light / dark" onClick={() => setDark(d => !d)} style={{ ...tb(false), width: 30, justifyContent: 'center' }}>{dark ? '☀️' : '🌙'}</button>
        </div>
      </div>

      {/* Database/query bar — filters the outline into a flat result set (a live "view" of the data) */}
      {showQuery && (() => {
        const seg = (label, active, onClick, color) => (
          <button key={label} onClick={onClick} style={{ background: active ? (color || '#5b6af0') : 'transparent', color: active ? '#fff' : faint, border: `1px solid ${active ? (color || '#5b6af0') : line}`, borderRadius: 999, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}>{label}</button>
        )
        const grp = (title, kids) => <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}><span style={{ fontSize: 11, color: faint, marginRight: 2 }}>{title}</span>{kids}</div>
        return (
          <div style={{ padding: '8px 16px', borderBottom: `1px solid ${line}`, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontFamily: '-apple-system, sans-serif', flexShrink: 0 }}>
            {grp('Type', [seg('Any', !q.type, () => setQ(s => ({ ...s, type: null })))].concat(Object.entries(TYPE_META).map(([k, v]) => seg(`${v.icon} ${v.label}`, q.type === k, () => setQ(s => ({ ...s, type: q.type === k ? null : k })), v.color))))}
            {grp('Priority', [seg('Any', !q.priority, () => setQ(s => ({ ...s, priority: null })))].concat(Object.entries(PRIORITY_META).map(([k, v]) => seg(v.label, q.priority === k, () => setQ(s => ({ ...s, priority: q.priority === k ? null : k })), v.color))))}
            {grp('Status', [seg('All', q.done === 'all', () => setQ(s => ({ ...s, done: 'all' }))), seg('Open', q.done === 'open', () => setQ(s => ({ ...s, done: 'open' })), '#2563eb'), seg('Done', q.done === 'done', () => setQ(s => ({ ...s, done: 'done' })), '#16a34a')])}
            {allTags.length > 0 && grp('Tag', [
              <select key="tagsel" value={q.tag || ''} onChange={e => setQ(s => ({ ...s, tag: e.target.value || null }))}
                style={{ background: dark ? '#141821' : '#f4f6fb', border: `1px solid ${line}`, color: fg, borderRadius: 7, padding: '4px 8px', fontSize: 12, outline: 'none' }}>
                <option value="">any</option>
                {allTags.map(t => <option key={t} value={t}>#{t}</option>)}
              </select>])}
            {qActive && <button onClick={() => setQ({ type: null, priority: null, tag: null, done: 'all' })} style={{ background: 'transparent', border: `1px solid ${line}`, color: faint, borderRadius: 7, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>Clear</button>}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: faint }}>{rows.length} result{rows.length === 1 ? '' : 's'}</span>
          </div>
        )
      })()}

      {/* Breadcrumb when focused into an item */}
      {focusRoot && byId[focusRoot] && (
        <div style={{ padding: '7px 24px', borderBottom: `1px solid ${line}`, fontFamily: '-apple-system, sans-serif', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span onClick={() => setFocusRoot(null)} style={{ cursor: 'pointer', color: '#5b6af0' }}>All</span>
          {[...ancestorsOf(focusRoot).reverse(), focusRoot].map(pid => (
            <span key={pid} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: faint }}>›</span>
              <span onClick={() => setFocusRoot(pid)} style={{ cursor: 'pointer', color: pid === focusRoot ? fg : '#5b6af0', fontWeight: pid === focusRoot ? 700 : 400 }}>{byId[pid]?.label || 'Untitled'}</span>
            </span>
          ))}
        </div>
      )}

      {/* Database table — every chipped item as rows × columns. */}
      {mode === 'table' && (() => {
        const items = nodes.filter(n => { const m = n.meta || {}; return m.itemType || m.priority || (m.tags || []).length || (m.people || []).length || m.fields?.due || m.heading != null })
        const cell = { padding: '8px 12px', borderBottom: `1px solid ${line}`, fontSize: 13, textAlign: 'left', verticalAlign: 'top' }
        const hcell = { ...cell, position: 'sticky', top: 0, background: dark ? '#12151d' : '#f7f8fb', color: faint, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', zIndex: 1 }
        return (
          <div style={{ flex: 1, overflow: 'auto', fontFamily: '-apple-system, sans-serif' }}>
            {items.length === 0
              ? <div style={{ padding: 28, color: faint, fontSize: 14 }}>No tagged items yet. In the outline, type <code>/task</code>, <code>#tag</code>, <code>!high</code> or <code>due:tomorrow</code> — they'll appear here as a database.</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={hcell}>Item</th><th style={hcell}>Type</th><th style={hcell}>Status</th>
                    <th style={hcell}>Priority</th><th style={hcell}>Due</th><th style={hcell}>Tags</th><th style={hcell}>Fields</th>
                  </tr></thead>
                  <tbody>
                    {items.map(n => { const m = n.meta || {}
                      return (
                        <tr key={n.id} onClick={() => setSelectedNodeId(n.id)} style={{ cursor: 'pointer', background: selectedNodeId === n.id ? (dark ? '#1a2236' : '#eef1fb') : 'transparent' }}>
                          <td style={{ ...cell, color: fg, fontWeight: 500, maxWidth: 320 }}>{n.label || '(untitled)'}</td>
                          <td style={cell}>{m.itemType ? <span style={{ color: TYPE_META[m.itemType]?.color }}>{TYPE_META[m.itemType].icon} {TYPE_META[m.itemType].label}</span> : ''}</td>
                          <td style={cell}>{m.itemType === 'task' ? (m.done ? <span style={{ color: '#16a34a' }}>✓ done</span> : <span style={{ color: '#2563eb' }}>open</span>) : ''}</td>
                          <td style={cell}>{m.priority ? <span style={{ color: PRIORITY_META[m.priority].color }}>{PRIORITY_META[m.priority].label}</span> : ''}</td>
                          <td style={{ ...cell, color: m.fields?.due ? '#0891b2' : faint }}>{m.fields?.due || ''}</td>
                          <td style={cell}><span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>{(m.tags || []).map(t => <span key={t} style={{ fontSize: 11, color: tagColor(t), background: tagColor(t) + '22', border: `1px solid ${tagColor(t)}55`, borderRadius: 8, padding: '0 6px' }}>#{t}</span>)}{(m.people || []).map(p => <span key={p} style={{ fontSize: 11, color: '#db2777', background: '#db277722', border: '1px solid #db277755', borderRadius: 8, padding: '0 6px' }}>@{p}</span>)}</span></td>
                          <td style={{ ...cell, color: faint, fontSize: 12 }}>{Object.entries(m.fields || {}).filter(([k, v]) => k !== 'due' && v != null).map(([k, v]) => `${k}:${v}`).join('  ')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
          </div>
        )
      })()}

      {/* Agenda — tasks by due date. */}
      {mode === 'agenda' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0 40vh', fontFamily: '-apple-system, sans-serif' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 24px' }}>
            {Object.entries(agendaGroups).every(([, a]) => a.length === 0) && <div style={{ color: faint, fontSize: 14 }}>No tasks yet. Type <code>/task</code> and a <code>due:tomorrow</code> to see them here.</div>}
            {Object.entries(agendaGroups).map(([grp, arr]) => arr.length === 0 ? null : (
              <div key={grp} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: grp === 'Overdue' ? '#e11d48' : grp === 'Today' ? '#5b6af0' : faint, marginBottom: 6 }}>{grp} · {arr.length}</div>
                {arr.map(n => { const m = n.meta || {}
                  return (
                    <div key={n.id} onClick={() => setSelectedNodeId(n.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 8, cursor: 'pointer', background: selectedNodeId === n.id ? (dark ? '#1b2236' : '#eef1fb') : 'transparent' }}>
                      <input type="checkbox" checked={!!m.done} onClick={e => e.stopPropagation()} onChange={() => setNodeMeta(n.id, { done: !m.done })} style={{ width: 15, height: 15, accentColor: '#5b6af0', cursor: 'pointer' }} />
                      <span style={{ flex: 1, fontSize: 15, color: m.done ? faint : fg, textDecoration: m.done ? 'line-through' : 'none' }}>{n.label || '(untitled)'}</span>
                      {m.priority && <span style={{ fontSize: 11, color: PRIORITY_META[m.priority].color }}>{PRIORITY_META[m.priority].label}</span>}
                      {m.fields?.due && <span style={{ fontSize: 12, color: '#0891b2' }}>📅 {m.fields.due}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outline */}
      {mode === 'outline' && (
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0 40vh' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 24px' }}>
          {rows.length === 0 && (
            <div style={{ color: faint, fontFamily: '-apple-system, sans-serif', fontSize: 14 }}>
              {flatMode ? 'No matches.' : <>Nothing here yet. Press <b>＋ New</b> (or type). <b>Enter</b> = new line, <b>Tab</b> = indent. Try shorthand: <code>/task</code>, <code>#tag</code>, <code>@who</code>, <code>!high</code>, <code>due:tomorrow</code>.</>}
            </div>
          )}
          {rows.map(r => {
            const n = byId[r.id]; const ws = n.writeStyle || {}; const m = n.meta || {}
            const emojis = (nodeProps[r.id]?.nodeEmojis || [])
            const imgs = (nodeProps[r.id]?.nodeImages || [])
            const hasNote = !!(n.notes && n.notes.trim())
            const showDetails = expanded.has(r.id)
            const isTask = m.itemType === 'task'
            const done = isTask && m.done
            const hSize = m.heading === 1 ? 24 : m.heading === 2 ? 19 : 17
            const hWeight = m.heading ? 700 : (ws.bold ? 700 : 400)
            const textStyle = {
              flex: 1, minWidth: 120, border: 'none', outline: 'none', background: 'transparent', fontSize: hSize, lineHeight: 1.35,
              fontFamily: 'inherit', color: done ? faint : (ws.metallic ? 'transparent' : (ws.color || fg)),
              fontWeight: hWeight, fontStyle: ws.italic ? 'italic' : 'normal', textDecoration: done ? 'line-through' : 'none',
              ...(ws.metallic && !done ? { background: 'linear-gradient(92deg,#b8b8b8,#f5f5f5 30%,#9a9a9a 55%,#e8e8e8 80%,#8f8f8f)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' } : {}),
            }
            return (
              <div key={r.id} style={{ marginLeft: (flatMode ? 0 : r.depth * 26) }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, padding: '0', borderRadius: 6, background: (focusId === r.id || selectedNodeId === r.id) ? (dark ? '#1b2236' : '#eef1fb') : 'transparent', boxShadow: (selectedNodeId === r.id && focusId !== r.id) ? 'inset 3px 0 0 #5b6af0' : 'none' }}>
                  {/* collapse triangle — prominent (2× size, bold, high contrast) */}
                  <span onClick={() => r.hasChildren && !flatMode && toggleCollapse(r.id)} title={r.hasChildren ? 'Collapse / expand' : ''}
                    style={{ width: 18, textAlign: 'center', cursor: r.hasChildren && !flatMode ? 'pointer' : 'default', color: chevC, fontSize: 20, fontWeight: 700, lineHeight: 1, userSelect: 'none', paddingTop: 3, visibility: r.hasChildren && !flatMode ? 'visible' : 'hidden' }}>
                    {collapsed.has(r.id) ? '▸' : '▾'}
                  </span>
                  {/* task checkbox OR bullet (bullet = click to zoom-into-item) — prominent */}
                  {isTask
                    ? <input type="checkbox" checked={!!done} onChange={() => setNodeMeta(r.id, { done: !done })} style={{ marginTop: 6, width: 15, height: 15, accentColor: '#5b6af0', cursor: 'pointer', flexShrink: 0 }} />
                    : <span title="Zoom in" onClick={() => setFocusRoot(r.id)} style={{ width: 18, textAlign: 'center', color: bulletC, fontSize: 26, fontWeight: 700, lineHeight: 1, paddingTop: 1, userSelect: 'none', cursor: 'pointer', flexShrink: 0 }}>•</span>}
                  {/* inline emojis */}
                  {emojis.map((em, i) => <span key={i} style={{ fontSize: 15, lineHeight: '26px', flexShrink: 0 }}>{em.type === 'custom' ? '🖼️' : em.emoji}</span>)}
                  <input ref={el => { if (el) inputs.current[r.id] = el }} value={n.label || ''}
                    onChange={e => onChangeLabel(r.id, e.target.value, e.target.selectionStart, e.target)} onFocus={() => selectRow(r.id)}
                    onKeyDown={e => onKey(e, r.id)} placeholder="" spellCheck={true} style={textStyle} />
                  {/* chips */}
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', paddingTop: 4 }}>{metaChips(r.id, m)}</span>
                  {/* rollup: task progress across descendants (on parents, not itself a task) */}
                  {!flatMode && r.hasChildren && !isTask && (() => { const ru = rollupOf(r.id); if (!ru.t) return null
                    const all = ru.d === ru.t
                    return <span title={`${ru.d} of ${ru.t} tasks done`} style={{ fontFamily: '-apple-system, sans-serif', fontSize: 11, color: all ? '#16a34a' : faint, background: (all ? '#16a34a' : '#5b6af0') + '18', border: `1px solid ${(all ? '#16a34a' : '#5b6af0')}44`, borderRadius: 9, padding: '0 7px', height: 18, lineHeight: '18px', flexShrink: 0, marginTop: 4 }}>{all ? '✓ ' : ''}{ru.d}/{ru.t}</span>
                  })()}
                  {/* details toggle */}
                  <span onClick={() => toggleDetails(r.id)} title="Notes & images"
                    style={{ cursor: 'pointer', fontSize: 12, color: (hasNote || imgs.length) ? '#5b6af0' : faint, padding: '6px 4px', userSelect: 'none', flexShrink: 0 }}>
                    {showDetails ? '📖' : (hasNote || imgs.length ? '📄' : '＋')}
                  </span>
                </div>
                {showDetails && (
                  <div style={{ marginLeft: 30, marginBottom: 6, marginTop: 2 }}>
                    <textarea value={n.notes || ''} onChange={e => updateNotes(r.id, e.target.value)} placeholder="Notes…"
                      style={{ width: '100%', minHeight: 46, resize: 'vertical', border: `1px solid ${line}`, borderRadius: 8, background: dark ? '#141821' : '#fbfcfe', color: fg, padding: '8px 10px', fontSize: 14, lineHeight: 1.5, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
                    {imgs.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                        {imgs.map((im, i) => <img key={i} src={im.src} alt="" style={{ maxWidth: 220, maxHeight: 180, borderRadius: 8, border: `1px solid ${line}` }} />)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {/* Frames — canvas containers, grouped in their own collapsible section, visually
              differentiated (italic serif). Kept out of the tree so they don't read as
              duplicate root items. Click a frame to select it (syncs to the canvas). */}
          {!flatMode && !focusRoot && frameNodes.length > 0 && (
            <div style={{ marginTop: 22, borderTop: `1px solid ${line}`, paddingTop: 10 }}>
              <div onClick={() => setFramesOpen(o => !o)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                <span style={{ width: 18, textAlign: 'center', color: chevC, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{framesOpen ? '▾' : '▸'}</span>
                <span style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic', fontWeight: 600, fontSize: 14, letterSpacing: '0.02em', color: faint, textTransform: 'uppercase' }}>Frames</span>
                <span style={{ fontSize: 12, color: faint }}>{frameNodes.length}</span>
              </div>
              {framesOpen && frameNodes.map(n => (
                <div key={n.id} onClick={() => setSelectedNodeId(n.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 24, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', background: selectedNodeId === n.id ? (dark ? '#1b2236' : '#eef1fb') : 'transparent' }}>
                  <span style={{ fontSize: 12, color: faint }}>▢</span>
                  <span style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic', fontSize: 15, color: fg }}>{n.label || 'Untitled frame'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      )}

      {/* Markdown help cheatsheet */}
      {showHelp && (() => {
        const groups = [
          ['Structure', [['Enter', 'new line'], ['Tab / Shift+Tab', 'indent / outdent'], ['# ', 'heading'], ['## ', 'subheading']]],
          ['Make it a record', [['/task', 'task (checkbox)'], ['[] / [x]', 'task / done'], ['/note /idea /question /event', 'item type']]],
          ['Tag & schedule', [['#tag', 'tag chip'], ['@person', 'person'], ['!high / !urgent / !med / !low', 'priority'], ['due:tomorrow · due:2026-08-15 · due:fri', 'date']]],
          ['Fields & links', [['status:doing · cost:50 (key:value)', 'custom field'], ['[[Another item]]', 'link / relation']]],
        ]
        const kbd = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, color: dark ? '#c5d0ff' : '#3a3f66', background: dark ? '#12142a' : '#f0f2fb', border: `1px solid ${line}`, borderRadius: 5, padding: '1px 6px', whiteSpace: 'nowrap' }
        return (
          <div onMouseDown={() => setShowHelp(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, sans-serif' }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ width: 480, maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto', background: dark ? '#161a24' : '#fff', color: fg, border: `1px solid ${line}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.45)' }}>
              <div style={{ padding: '14px 18px', borderBottom: `1px solid ${line}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: dark ? '#161a24' : '#fff' }}>
                <b style={{ fontSize: 15 }}>Markdown shortcuts</b>
                <span onClick={() => setShowHelp(false)} style={{ cursor: 'pointer', color: faint, fontSize: 18 }}>×</span>
              </div>
              <div style={{ padding: '6px 18px 16px' }}>
                <p style={{ fontSize: 12.5, color: faint, margin: '10px 0 6px' }}>Type the shorthand, then a <b>space</b> — it turns into a chip and becomes queryable in the <b>▦ Table</b>.</p>
                {groups.map(([title, rows]) => (
                  <div key={title} style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: faint, marginBottom: 6 }}>{title}</div>
                    {rows.map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '4px 0' }}>
                        <span style={{ ...kbd, flexShrink: 0 }}>{k}</span>
                        <span style={{ fontSize: 13, color: fg }}>{v}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Shortcuts editor */}
      {showKeys && (
        <div onMouseDown={() => { setShowKeys(false); setCapturing(null) }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, sans-serif' }}>
          <div onMouseDown={e => e.stopPropagation()} style={{ width: 380, maxWidth: '92vw', background: dark ? '#161a24' : '#ffffff', color: fg, border: `1px solid ${line}`, borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,0.4)', overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <b style={{ fontSize: 15 }}>Keyboard shortcuts</b>
              <span onClick={() => { setShowKeys(false); setCapturing(null) }} style={{ cursor: 'pointer', color: faint, fontSize: 18, lineHeight: 1 }}>×</span>
            </div>
            <div style={{ padding: '8px 10px' }}>
              {SHORTCUT_ACTIONS.map(a => {
                const isCap = capturing === a.id
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 8px', borderRadius: 8, background: isCap ? (dark ? '#1f2540' : '#eef0ff') : 'transparent' }}>
                    <span style={{ fontSize: 13.5 }}>{a.label}</span>
                    <button ref={el => { if (el && isCap) el.focus() }} onClick={e => { const btn = e.currentTarget; setCapturing(a.id); btn.focus() }}
                      onKeyDown={e => {
                        if (!isCap) return
                        e.preventDefault(); e.stopPropagation()
                        if (e.key === 'Escape') { setCapturing(null); return }
                        const combo = comboFromEvent(e); if (!combo) return
                        setKeymap(km => { const next = { ...km }; for (const k of Object.keys(next)) if (next[k] === combo && k !== a.id) next[k] = ''; next[a.id] = combo; return next })
                        setCapturing(null)
                      }}
                      style={{ minWidth: 84, textAlign: 'center', cursor: 'pointer', background: isCap ? '#5b6af0' : (dark ? '#12142c' : '#f4f6fb'), color: isCap ? '#fff' : fg, border: `1px solid ${isCap ? '#5b6af0' : line}`, borderRadius: 7, padding: '5px 10px', fontSize: 13, fontFamily: 'inherit', fontWeight: 600 }}>
                      {isCap ? 'Press keys…' : prettyCombo(keymap[a.id])}
                    </button>
                  </div>
                )
              })}
            </div>
            <div style={{ padding: '10px 14px', borderTop: `1px solid ${line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11.5, color: faint }}>Click a shortcut, then press the new keys. Esc cancels.</span>
              <button onClick={() => { setKeymap({ ...DEFAULT_KEYS }); setCapturing(null) }} style={{ background: 'transparent', border: `1px solid ${line}`, color: faint, borderRadius: 7, padding: '4px 10px', cursor: 'pointer', fontSize: 12.5 }}>Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
