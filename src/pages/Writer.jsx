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
  const [search, setSearch] = useState('')
  const pendingFocus = useRef(null)
  const inputs = useRef({})

  const descendants = (id) => { const out = []; const walk = x => (childrenOf[x] || []).forEach(c => { out.push(c); walk(c) }); walk(id); return out }
  const ancestorsOf = (id) => { const out = []; let p = parentOf[id]; while (p) { out.push(p); p = parentOf[p] } return out }

  // rows = flattened visible tree (honoring collapse + focusRoot). When searching, a flat matches list.
  const searchLC = search.trim().toLowerCase()
  const rows = useMemo(() => {
    if (searchLC) {
      const hit = n => (n.label || '').toLowerCase().includes(searchLC) || ((n.meta?.tags) || []).some(t => t.toLowerCase().includes(searchLC)) || ((n.meta?.people) || []).some(t => t.toLowerCase().includes(searchLC))
      return nodes.filter(hit).map(n => ({ id: n.id, depth: 0, parentId: parentOf[n.id] || null, hasChildren: (childrenOf[n.id] || []).length > 0 }))
    }
    const out = []; const seen = new Set()
    const walk = (id, depth) => {
      if (seen.has(id) || !byId[id]) return
      seen.add(id)
      const kids = childrenOf[id] || []
      out.push({ id, depth, parentId: parentOf[id] || null, hasChildren: kids.length > 0 })
      if (!collapsed.has(id)) kids.forEach(k => walk(k, depth + 1))
    }
    const startIds = focusRoot ? (childrenOf[focusRoot] || []) : roots
    startIds.forEach(r => walk(r, 0))
    if (!focusRoot) nodes.forEach(n => { if (!seen.has(n.id)) walk(n.id, 0) })
    return out
  }, [byId, childrenOf, parentOf, roots, collapsed, nodes, focusRoot, searchLC])

  const rowIndex = useMemo(() => Object.fromEntries(rows.map((r, i) => [r.id, i])), [rows])

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
  const bulletC = dark ? '#5b6af0' : '#c3c9d6'
  const focusNode = focusId ? byId[focusId] : null
  const fs = focusNode?.writeStyle || {}
  const styleFocused = (patch) => { if (focusId) setNodeWriteStyle(focusId, patch); inputs.current[focusId]?.focus() }
  const words = useMemo(() => nodes.reduce((a, n) => a + ((n.label || '').trim() ? n.label.trim().split(/\s+/).length : 0), 0), [nodes])
  const taskStats = useMemo(() => { let t = 0, d = 0; nodes.forEach(n => { if (n.meta?.itemType === 'task') { t++; if (n.meta.done) d++ } }); return { t, d } }, [nodes])

  const tbtn = (active) => ({ background: active ? (dark ? '#2a3358' : '#e8ebff') : 'transparent', border: `1px solid ${active ? '#5b6af0' : (dark ? '#2a3050' : '#e2e5ee')}`, color: active ? '#5b6af0' : faint, borderRadius: 7, cursor: 'pointer', fontSize: 13, padding: '4px 9px', minWidth: 30 })

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
    return out
  }

  return (
    <div style={{ height: '100%', background: bg, color: fg, display: 'flex', flexDirection: 'column', fontFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: `1px solid ${line}`, flexShrink: 0, fontFamily: '-apple-system, sans-serif', flexWrap: 'wrap' }}>
        <button onClick={addRoot} style={{ ...tbtn(false), fontWeight: 700, color: '#5b6af0', borderColor: '#5b6af0' }}>＋ New</button>
        <div style={{ width: 1, height: 20, background: line, margin: '0 2px' }} />
        <button title="Bold" onClick={() => styleFocused({ bold: !fs.bold })} style={{ ...tbtn(fs.bold), fontWeight: 800 }}>B</button>
        <button title="Italic" onClick={() => styleFocused({ italic: !fs.italic })} style={{ ...tbtn(fs.italic), fontStyle: 'italic' }}>I</button>
        <button title="Metallic" onClick={() => styleFocused({ metallic: !fs.metallic })} style={tbtn(fs.metallic)}>✨</button>
        <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginLeft: 2 }}>
          {TEXT_COLORS.map(c => <div key={c} title={c} onClick={() => styleFocused({ color: c })} style={{ width: 15, height: 15, borderRadius: '50%', background: c, cursor: 'pointer', border: `1.5px solid ${fs.color === c ? '#5b6af0' : (dark ? '#2a3050' : '#e2e5ee')}` }} />)}
          <div title="Default colour" onClick={() => styleFocused({ color: null })} style={{ fontSize: 11, color: faint, cursor: 'pointer', marginLeft: 2 }}>reset</div>
        </div>
        <div style={{ width: 1, height: 20, background: line, margin: '0 2px' }} />
        <button title="Fold all" onClick={foldAll} style={tbtn(false)}>⊟</button>
        <button title="Expand all" onClick={expandAll} style={tbtn(false)}>⊞</button>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
          style={{ background: dark ? '#141821' : '#f4f6fb', border: `1px solid ${line}`, color: fg, borderRadius: 7, padding: '5px 9px', fontSize: 13, fontFamily: '-apple-system, sans-serif', outline: 'none', width: 150 }} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: faint }}>{taskStats.t > 0 && `${taskStats.d}/${taskStats.t} done · `}{words} words · {nodes.length} items</span>
          <button title="Export to Markdown" onClick={exportMd} style={tbtn(false)}>⬇︎</button>
          <button title="Edit keyboard shortcuts" onClick={() => { setShowKeys(true); setCapturing(null) }} style={tbtn(false)}>⌨</button>
          <button title="Toggle light / dark" onClick={() => setDark(d => !d)} style={tbtn(false)}>{dark ? '☀️' : '🌙'}</button>
        </div>
      </div>

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

      {/* Outline */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0 40vh' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 24px' }}>
          {rows.length === 0 && (
            <div style={{ color: faint, fontFamily: '-apple-system, sans-serif', fontSize: 14 }}>
              {searchLC ? 'No matches.' : <>Nothing here yet. Press <b>＋ New</b> (or type). <b>Enter</b> = new line, <b>Tab</b> = indent. Try shorthand: <code>/task</code>, <code>#tag</code>, <code>@who</code>, <code>!high</code>, <code>due:tomorrow</code>.</>}
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
              flex: 1, minWidth: 120, border: 'none', outline: 'none', background: 'transparent', fontSize: hSize, lineHeight: 1.5,
              fontFamily: 'inherit', color: done ? faint : (ws.metallic ? 'transparent' : (ws.color || fg)),
              fontWeight: hWeight, fontStyle: ws.italic ? 'italic' : 'normal', textDecoration: done ? 'line-through' : 'none',
              ...(ws.metallic && !done ? { background: 'linear-gradient(92deg,#b8b8b8,#f5f5f5 30%,#9a9a9a 55%,#e8e8e8 80%,#8f8f8f)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' } : {}),
            }
            return (
              <div key={r.id} style={{ marginLeft: (searchLC ? 0 : r.depth * 26) }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, padding: '1px 0', borderRadius: 6, background: (focusId === r.id || selectedNodeId === r.id) ? (dark ? '#1b2236' : '#eef1fb') : 'transparent', boxShadow: (selectedNodeId === r.id && focusId !== r.id) ? 'inset 3px 0 0 #5b6af0' : 'none' }}>
                  {/* collapse triangle */}
                  <span onClick={() => r.hasChildren && !searchLC && toggleCollapse(r.id)} title={r.hasChildren ? 'Collapse / expand' : ''}
                    style={{ width: 13, textAlign: 'center', cursor: r.hasChildren && !searchLC ? 'pointer' : 'default', color: faint, fontSize: 10, userSelect: 'none', paddingTop: 8, visibility: r.hasChildren && !searchLC ? 'visible' : 'hidden' }}>
                    {collapsed.has(r.id) ? '▸' : '▾'}
                  </span>
                  {/* task checkbox OR bullet (bullet = click to zoom-into-item) */}
                  {isTask
                    ? <input type="checkbox" checked={!!done} onChange={() => setNodeMeta(r.id, { done: !done })} style={{ marginTop: 6, width: 15, height: 15, accentColor: '#5b6af0', cursor: 'pointer', flexShrink: 0 }} />
                    : <span title="Zoom in" onClick={() => setFocusRoot(r.id)} style={{ width: 13, textAlign: 'center', color: bulletC, fontSize: 14, paddingTop: 4, userSelect: 'none', cursor: 'pointer', flexShrink: 0 }}>•</span>}
                  {/* inline emojis */}
                  {emojis.map((em, i) => <span key={i} style={{ fontSize: 15, lineHeight: '26px', flexShrink: 0 }}>{em.type === 'custom' ? '🖼️' : em.emoji}</span>)}
                  <input ref={el => { if (el) inputs.current[r.id] = el }} value={n.label || ''}
                    onChange={e => onChangeLabel(r.id, e.target.value, e.target.selectionStart, e.target)} onFocus={() => selectRow(r.id)}
                    onKeyDown={e => onKey(e, r.id)} placeholder="" spellCheck={true} style={textStyle} />
                  {/* chips */}
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', paddingTop: 4 }}>{metaChips(r.id, m)}</span>
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
        </div>
      </div>

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
