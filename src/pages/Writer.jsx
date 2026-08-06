import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import useGraphStore from '../lib/graphStore'

// ─── Writer ──────────────────────────────────────────────────────────────────
// A full-screen, keyboard-driven outliner / writing mode over the same nodes+edges as the graph.
// Enter = new item · Tab / Shift+Tab = demote / promote · Alt+↑/↓ = move · Cmd/Ctrl+↑/↓ = collapse /
// expand · Backspace on empty = delete. Per-item styling (bold / italic / colour / metallic), inline
// emojis before the text, and an expandable details drawer (notes + attached images). Light by default,
// with a dark toggle.

const TEXT_COLORS = ['#111827', '#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#6b7280', '#ffffff']

export default function Writer({ projectName }) {
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

  const nodeProps = useMemo(() => (views.find(v => v.id === activeViewId)?.nodeProps) || {}, [views, activeViewId])
  const byId = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes])
  const childrenOf = useMemo(() => { const m = {}; edges.forEach(e => { (m[e.source] = m[e.source] || []).push(e.target) }); return m }, [edges])
  const parentOf = useMemo(() => { const m = {}; edges.forEach(e => { m[e.target] = e.source }); return m }, [edges])
  const roots = useMemo(() => nodes.filter(n => !parentOf[n.id]).map(n => n.id), [nodes, parentOf])

  const [dark, setDark] = useState(() => { try { return localStorage.getItem('pim_writer_dark') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('pim_writer_dark', dark ? '1' : '0') } catch { /* ignore */ } }, [dark])
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set())   // detail drawers (notes + images)
  const [focusId, setFocusId] = useState(null)
  const pendingFocus = useRef(null)
  const inputs = useRef({})

  // Flatten the tree into visible rows, honoring collapse. Cycle-safe.
  const rows = useMemo(() => {
    const out = []; const seen = new Set()
    const walk = (id, depth) => {
      if (seen.has(id) || !byId[id]) return
      seen.add(id)
      const kids = childrenOf[id] || []
      out.push({ id, depth, parentId: parentOf[id] || null, hasChildren: kids.length > 0 })
      if (!collapsed.has(id)) kids.forEach(k => walk(k, depth + 1))
    }
    roots.forEach(r => walk(r, 0))
    nodes.forEach(n => { if (!seen.has(n.id)) walk(n.id, 0) })   // orphans from cycles
    return out
  }, [byId, childrenOf, parentOf, roots, collapsed, nodes])

  const rowIndex = useMemo(() => Object.fromEntries(rows.map((r, i) => [r.id, i])), [rows])

  useEffect(() => {
    if (pendingFocus.current && inputs.current[pendingFocus.current]) {
      const el = inputs.current[pendingFocus.current]
      el.focus()
      const v = el.value; el.setSelectionRange(v.length, v.length)
      pendingFocus.current = null
    }
  })

  const siblings = (id) => { const p = parentOf[id]; return p ? (childrenOf[p] || []) : roots }
  const focusRow = (idx) => { const r = rows[idx]; if (r) { setFocusId(r.id); inputs.current[r.id]?.focus() } }

  // ── Tree operations (plain functions so they always read the freshest tree, never a stale closure) ──
  const addSiblingAfter = (id) => {
    const p = parentOf[id] || null
    const sibs = p ? (childrenOf[p] || []) : roots
    const at = sibs.indexOf(id)
    const after = sibs[at + 1] || null
    const newId = addNode('', p)                 // appended to parent's children
    if (p && after) moveChild(p, newId, after)   // slot it right after the current item
    pendingFocus.current = newId; setFocusId(newId)
  }
  const demote = (id) => {                        // Tab → become last child of previous sibling
    const sibs = siblings(id); const at = sibs.indexOf(id)
    const prev = sibs[at - 1]; if (!prev) return
    reparentNode(id, prev); pendingFocus.current = id
  }
  const promote = (id) => {                        // Shift+Tab → become sibling of parent (after it)
    const p = parentOf[id]; if (!p) return
    const gp = parentOf[p] || null
    reparentNode(id, gp)
    if (gp) moveChild(gp, id, (childrenOf[gp] || [])[(childrenOf[gp] || []).indexOf(p) + 1] || null)
    pendingFocus.current = id
  }
  const move = (id, dir) => {                      // Alt+↑/↓ → reorder among siblings
    const p = parentOf[id]; if (!p) return         // root reordering not supported in v1
    const sibs = childrenOf[p] || []; const at = sibs.indexOf(id)
    if (dir < 0 && at > 0) moveChild(p, id, sibs[at - 1])
    else if (dir > 0 && at < sibs.length - 1) moveChild(p, id, sibs[at + 2] || null)
    pendingFocus.current = id
  }

  const toggleCollapse = (id, want) => setCollapsed(s => { const n = new Set(s); if (want === false || (want == null && n.has(id))) n.delete(id); else n.add(id); return n })
  const toggleDetails = (id) => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const onKey = (e, id) => {
    const el = e.currentTarget
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const empty = el.value === ''
    if (e.key === 'Enter') { e.preventDefault(); addSiblingAfter(id); return }
    if (e.key === 'Tab') { e.preventDefault(); e.shiftKey ? promote(id) : demote(id); return }
    if (e.key === 'Backspace' && empty) {
      e.preventDefault()
      const idx = rowIndex[id]
      if ((childrenOf[id] || []).length === 0) { deleteNode(id); focusRow(Math.max(0, idx - 1)) }
      return
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(id, e.key === 'ArrowUp' ? -1 : 1); return }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); toggleCollapse(id, e.key === 'ArrowDown' ? false : true); return }
    if (e.key === 'ArrowUp' && atStart) { e.preventDefault(); focusRow(rowIndex[id] - 1); return }
    if (e.key === 'ArrowDown' && el.selectionStart === el.value.length) { e.preventDefault(); focusRow(rowIndex[id] + 1); return }
    if (e.key === 'Escape') el.blur()
  }

  const addRoot = () => { const id = addNode('', null); pendingFocus.current = id; setFocusId(id) }

  // Theme tokens
  const bg = dark ? '#0f1115' : '#ffffff'
  const fg = dark ? '#e8ecf4' : '#1f2430'
  const faint = dark ? '#7c869c' : '#9aa3b2'
  const line = dark ? '#232838' : '#eceef3'
  const bulletC = dark ? '#5b6af0' : '#c3c9d6'
  const focusNode = focusId ? byId[focusId] : null
  const fs = focusNode?.writeStyle || {}

  const styleFocused = (patch) => { if (focusId) setNodeWriteStyle(focusId, patch); inputs.current[focusId]?.focus() }
  const words = useMemo(() => nodes.reduce((a, n) => a + ((n.label || '').trim() ? (n.label.trim().split(/\s+/).length) : 0), 0), [nodes])

  const tbtn = (active) => ({ background: active ? (dark ? '#2a3358' : '#e8ebff') : 'transparent', border: `1px solid ${active ? '#5b6af0' : (dark ? '#2a3050' : '#e2e5ee')}`, color: active ? '#5b6af0' : faint, borderRadius: 7, cursor: 'pointer', fontSize: 13, padding: '4px 9px', minWidth: 30 })

  return (
    <div style={{ height: '100%', background: bg, color: fg, display: 'flex', flexDirection: 'column', fontFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: `1px solid ${line}`, flexShrink: 0, fontFamily: '-apple-system, sans-serif' }}>
        <button onClick={addRoot} style={{ ...tbtn(false), fontWeight: 700, color: '#5b6af0', borderColor: '#5b6af0' }}>＋ New</button>
        <div style={{ width: 1, height: 20, background: line, margin: '0 4px' }} />
        <button title="Bold" onClick={() => styleFocused({ bold: !fs.bold })} style={{ ...tbtn(fs.bold), fontWeight: 800 }}>B</button>
        <button title="Italic" onClick={() => styleFocused({ italic: !fs.italic })} style={{ ...tbtn(fs.italic), fontStyle: 'italic' }}>I</button>
        <button title="Metallic" onClick={() => styleFocused({ metallic: !fs.metallic })} style={tbtn(fs.metallic)}>✨</button>
        <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginLeft: 2 }}>
          {TEXT_COLORS.map(c => <div key={c} title={c} onClick={() => styleFocused({ color: c })}
            style={{ width: 16, height: 16, borderRadius: '50%', background: c, cursor: 'pointer', border: `1.5px solid ${fs.color === c ? '#5b6af0' : (dark ? '#2a3050' : '#e2e5ee')}` }} />)}
          <div title="Default colour" onClick={() => styleFocused({ color: null })} style={{ fontSize: 11, color: faint, cursor: 'pointer', marginLeft: 2 }}>reset</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: faint }}>{words} words · {nodes.length} items</span>
          <button title="Toggle light / dark" onClick={() => setDark(d => !d)} style={tbtn(false)}>{dark ? '☀️' : '🌙'}</button>
        </div>
      </div>

      {/* Outline */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '28px 0 40vh' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 24px' }}>
          {rows.length === 0 && (
            <div style={{ color: faint, fontFamily: '-apple-system, sans-serif', fontSize: 14 }}>
              Nothing here yet. Press <b>＋ New</b> (or start typing) — then <b>Enter</b> for a new line, <b>Tab</b> to indent.
            </div>
          )}
          {rows.map(r => {
            const n = byId[r.id]; const ws = n.writeStyle || {}
            const emojis = (nodeProps[r.id]?.nodeEmojis || [])
            const imgs = (nodeProps[r.id]?.nodeImages || [])
            const hasNote = !!(n.notes && n.notes.trim())
            const showDetails = expanded.has(r.id)
            const textStyle = {
              flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 17, lineHeight: 1.55,
              fontFamily: 'inherit', color: ws.metallic ? 'transparent' : (ws.color || fg),
              fontWeight: ws.bold ? 700 : 400, fontStyle: ws.italic ? 'italic' : 'normal',
              ...(ws.metallic ? { background: 'linear-gradient(92deg,#b8b8b8,#f5f5f5 30%,#9a9a9a 55%,#e8e8e8 80%,#8f8f8f)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' } : {}),
            }
            return (
              <div key={r.id} style={{ marginLeft: r.depth * 26 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, padding: '1px 0', borderRadius: 6, background: focusId === r.id ? (dark ? '#161a24' : '#f7f8fb') : 'transparent' }}>
                  {/* collapse triangle */}
                  <span onClick={() => r.hasChildren && toggleCollapse(r.id)} title={r.hasChildren ? 'Collapse / expand' : ''}
                    style={{ width: 14, textAlign: 'center', cursor: r.hasChildren ? 'pointer' : 'default', color: faint, fontSize: 10, userSelect: 'none', paddingTop: 8, visibility: r.hasChildren ? 'visible' : 'hidden' }}>
                    {collapsed.has(r.id) ? '▸' : '▾'}
                  </span>
                  {/* bullet */}
                  <span style={{ width: 12, textAlign: 'center', color: bulletC, fontSize: 14, paddingTop: 5, userSelect: 'none' }}>•</span>
                  {/* inline emojis (small, same line as text) */}
                  {emojis.map((em, i) => <span key={i} style={{ fontSize: 15, lineHeight: '27px', flexShrink: 0 }}>{em.type === 'custom' ? '🖼️' : em.emoji}</span>)}
                  <input ref={el => { if (el) inputs.current[r.id] = el }} value={n.label || ''}
                    onChange={e => updateLabel(r.id, e.target.value)} onFocus={() => setFocusId(r.id)}
                    onKeyDown={e => onKey(e, r.id)} placeholder="" spellCheck={true} style={textStyle} />
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
    </div>
  )
}
