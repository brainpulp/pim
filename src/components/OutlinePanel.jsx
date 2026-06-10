import { useState, useEffect, useRef, useCallback } from 'react'
import useGraphStore from '../lib/graphStore'

// ── Tree builder ──────────────────────────────────────────────────────────────
function buildTree(nodes, edges) {
  const childrenOf = {}
  const parentCount = {}
  nodes.forEach(n => { childrenOf[n.id] = []; parentCount[n.id] = 0 })
  edges.forEach(e => {
    if (childrenOf[e.source] !== undefined) childrenOf[e.source].push(e.target)
    if (parentCount[e.target] !== undefined) parentCount[e.target]++
  })

  const roots = nodes.filter(n => parentCount[n.id] === 0)
  const seen = new Set()

  function buildItem(nodeId, ancestors, parentId) {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return null
    const alreadySeen = seen.has(nodeId)
    seen.add(nodeId)
    const newAncestors = new Set([...ancestors, nodeId])
    return {
      id: nodeId, label: node.label, parentId: parentId || null,
      isClone: parentCount[nodeId] > 1 || alreadySeen,
      children: alreadySeen ? [] : (childrenOf[nodeId] || [])
        .filter(cid => !ancestors.has(cid))
        .map(cid => buildItem(cid, newAncestors, nodeId))
        .filter(Boolean),
    }
  }

  const items = roots.map(n => buildItem(n.id, new Set(), null))
  nodes.forEach(n => {
    if (!seen.has(n.id)) {
      seen.add(n.id)
      items.push({ id: n.id, label: n.label, parentId: null, isClone: false,
        children: (childrenOf[n.id] || []).filter(cid => !seen.has(cid))
          .map(cid => buildItem(cid, new Set([n.id]), n.id)).filter(Boolean) })
    }
  })
  return items
}

// ── Flatten tree to list (for mouse-drag hit detection) ───────────────────────
function flattenTree(tree, expandedSet) {
  const result = []
  function walk(items, depth) {
    items.forEach(item => {
      result.push({ id: item.id, parentId: item.parentId, depth })
      if (expandedSet.has(item.id) !== false && item.children.length)
        walk(item.children, depth + 1)
    })
  }
  walk(tree, 0)
  return result
}

// ── OutlinePanel ──────────────────────────────────────────────────────────────
export default function OutlinePanel({ selectedNodeId, onSelectNode }) {
  const nodes         = useGraphStore(s => s.nodes)
  const edges         = useGraphStore(s => s.edges)
  const addNode       = useGraphStore(s => s.addNode)
  const updateLabel   = useGraphStore(s => s.updateLabel)
  const deleteNode    = useGraphStore(s => s.deleteNode)
  const reparentNode  = useGraphStore(s => s.reparentNode)
  const activeViewId  = useGraphStore(s => s.activeViewId)
  const views         = useGraphStore(s => s.views)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const setDrillRoot  = useGraphStore(s => s.setDrillRoot)

  const activeView    = views.find(v => v.id === activeViewId) || views[0]
  const viewNodeProps = activeView?.nodeProps || {}

  const [expanded, setExpanded] = useState(() => new Set()) // expanded by default (empty = all shown)
  const [dropTarget, setDropTarget] = useState(null) // { id, position: 'before'|'after'|'into' }
  const [draggingId, setDraggingId] = useState(null)

  // Mouse drag state
  const dragging = useRef(null) // { nodeId }
  const containerRef = useRef()

  const tree = buildTree(nodes, edges)

  const toggleExpand = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const isExpanded = (id) => !expanded.has(id) // items are expanded by default

  // ── Mouse drag system ─────────────────────────────────────────────────────
  const getDropFromPoint = useCallback((clientX, clientY) => {
    if (!containerRef.current) return null
    const el = document.elementFromPoint(clientX, clientY)
    if (!el) return null
    const row = el.closest('[data-outline-id]')
    if (!row) return null
    const id = row.dataset.outlineId
    if (id === dragging.current?.nodeId) return null
    const rect = row.getBoundingClientRect()
    const relY = (clientY - rect.top) / rect.height
    const position = relY < 0.28 ? 'before' : relY > 0.72 ? 'after' : 'into'
    return { id, position }
  }, [])

  const startDrag = useCallback((nodeId) => {
    dragging.current = { nodeId }
    setDraggingId(nodeId)
    document.body.style.cursor = 'grabbing'

    const onMove = e => {
      const drop = getDropFromPoint(e.clientX, e.clientY)
      setDropTarget(drop)
    }

    const onUp = e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      const drop = getDropFromPoint(e.clientX, e.clientY)
      if (drop && drop.id !== dragging.current.nodeId) {
        const { id: targetId, position } = drop
        if (targetId === '__root__' || position === 'into') {
          reparentNode(dragging.current.nodeId, targetId === '__root__' ? null : targetId)
        } else {
          const parentEdge = edges.find(e2 => e2.target === targetId)
          reparentNode(dragging.current.nodeId, parentEdge?.source || null)
        }
      }
      dragging.current = null
      setDraggingId(null)
      setDropTarget(null)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [getDropFromPoint, reparentNode, edges])

  return (
    <div ref={containerRef} style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerLabel}>OUTLINE</span>
        <button style={styles.addRootBtn} onClick={() => addNode('New node')}>+ Root</button>
      </div>

      {/* Make-root drop zone */}
      <div
        data-outline-id="__root__"
        style={{
          height: 22, fontSize: '0.68rem', color: '#444', textAlign: 'center', lineHeight: '22px',
          borderBottom: '1px solid #1e1e2e',
          background: dropTarget?.id === '__root__' ? '#1a2a1a' : 'transparent',
          color: dropTarget?.id === '__root__' ? '#4ade80' : '#333',
          transition: 'all 0.1s', userSelect: 'none',
        }}
      >
        ↑ make root
      </div>

      <div style={styles.tree}>
        {tree.length === 0 && (
          <div style={styles.empty}>No nodes yet.<br />Click + Root to start.</div>
        )}
        {tree.map((root, i) => (
          <OutlineItem
            key={root.id + '-' + i}
            item={root}
            depth={0}
            selectedNodeId={selectedNodeId}
            onSelect={onSelectNode}
            onAddChild={parentId => addNode('New node', parentId)}
            onRename={updateLabel}
            onDelete={deleteNode}
            onToggleVisible={(id, val) => setNodeViewProp(id, 'visible', val)}
            onDrill={setDrillRoot}
            viewNodeProps={viewNodeProps}
            dropTarget={dropTarget}
            draggingId={draggingId}
            onStartDrag={startDrag}
            isExpanded={isExpanded}
            onToggleExpand={toggleExpand}
          />
        ))}
      </div>
    </div>
  )
}

// ── OutlineItem ───────────────────────────────────────────────────────────────
function OutlineItem({
  item, depth, selectedNodeId, onSelect,
  onAddChild, onRename, onDelete, onToggleVisible, onDrill,
  viewNodeProps, dropTarget, draggingId, onStartDrag, isExpanded, onToggleExpand,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.label)
  const inputRef = useRef()

  const hasChildren = item.children.length > 0
  const expanded = isExpanded(item.id)
  const isHidden = viewNodeProps[item.id]?.visible === false
  const isSelected = item.id === selectedNodeId
  const isDropInto = dropTarget?.id === item.id && dropTarget?.position === 'into'
  const isDropBefore = dropTarget?.id === item.id && dropTarget?.position === 'before'
  const isDropAfter = dropTarget?.id === item.id && dropTarget?.position === 'after'

  useEffect(() => { if (!editing) setDraft(item.label) }, [item.label, editing])
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])

  const commitEdit = () => { onRename(item.id, draft); setEditing(false) }

  return (
    <div style={{ position: 'relative' }}>
      {isDropBefore && <div style={styles.dropLine} />}

      <div
        className="outline-row"
        data-outline-id={item.id}
        onMouseDown={e => {
          if (e.target.closest('button') || e.target.closest('input')) return
          if (e.button !== 0) return
          e.preventDefault()
          onStartDrag(item.id)
        }}
        onClick={() => onSelect?.(item.id)}
        style={{
          paddingLeft: depth * 14 + 4,
          opacity: item.id === draggingId ? 0.3 : (isHidden && !isSelected) ? 0.4 : 1,
          pointerEvents: item.id === draggingId ? 'none' : undefined,
          background: isSelected ? '#1e2048' : isDropInto ? '#1a2a3a' : undefined,
          borderLeft: isSelected
            ? '2px solid #5b6af0'
            : isDropInto ? '2px solid #38bdf8'
            : '2px solid transparent',
          cursor: draggingId ? 'grabbing' : 'default',
        }}
      >
        {/* Chevron */}
        <span
          style={{
            ...styles.chevron,
            opacity: hasChildren ? 1 : 0.15,
            cursor: hasChildren ? 'pointer' : 'default',
          }}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { if (!hasChildren) return; e.stopPropagation(); onToggleExpand(item.id) }}
        >
          {expanded ? '▾' : '▸'}
        </span>

        {item.isClone && <span style={styles.cloneTag} title="Multi-parent or cycle">⇢</span>}

        {editing ? (
          <input
            ref={inputRef}
            style={styles.input}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
          />
        ) : (
          <span
            style={styles.label}
            onDoubleClick={e => { e.stopPropagation(); setDraft(item.label); setEditing(true) }}
            title={item.label}
          >
            {item.label}
          </span>
        )}

        <div className="outline-actions">
          <button style={styles.iconBtn} title="Drill into" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDrill(item.id) }}>⊳</button>
          <button style={styles.iconBtn} title={isHidden ? 'Show' : 'Hide'} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggleVisible(item.id, !isHidden) }}>
            {isHidden ? '◌' : '●'}
          </button>
          <button style={styles.iconBtn} title="Add child" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onAddChild(item.id) }}>+</button>
          <button style={{ ...styles.iconBtn, color: '#f87171' }} title="Delete" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDelete(item.id) }}>×</button>
        </div>
      </div>

      {isDropAfter && <div style={styles.dropLine} />}

      {expanded && item.children.map((child, i) => (
        <OutlineItem
          key={child.id + '-' + depth + '-' + i}
          item={child}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          onSelect={onSelect}
          onAddChild={onAddChild}
          onRename={onRename}
          onDelete={onDelete}
          onToggleVisible={onToggleVisible}
          onDrill={onDrill}
          viewNodeProps={viewNodeProps}
          dropTarget={dropTarget}
          draggingId={draggingId}
          onStartDrag={onStartDrag}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </div>
  )
}

const styles = {
  panel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.6rem 0.75rem', borderBottom: '1px solid #1e1e2e', flexShrink: 0,
  },
  headerLabel: { fontSize: '0.65rem', fontWeight: 700, color: '#555', letterSpacing: '0.08em' },
  addRootBtn: {
    fontSize: '0.72rem', padding: '2px 7px', borderRadius: 4,
    border: '1px solid #2a2a3e', background: 'transparent', color: '#5b6af0', cursor: 'pointer',
  },
  dropLine: {
    height: 2, background: '#38bdf8', borderRadius: 1,
    position: 'absolute', left: 0, right: 0, zIndex: 10,
  },
  tree: { flex: 1, overflowY: 'auto', padding: '0.25rem 0' },
  empty: { color: '#444', fontSize: '0.78rem', textAlign: 'center', padding: '2rem 1rem', lineHeight: 1.6 },
  chevron: {
    fontSize: 15, color: '#aaa',
    width: 20, height: 22, flexShrink: 0, userSelect: 'none',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  cloneTag: { fontSize: 9, color: '#5b6af0', flexShrink: 0 },
  label: {
    flex: 1, fontSize: '0.8rem', cursor: 'default',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none',
  },
  input: {
    flex: 1, background: '#1a1a2e', border: '1px solid #5b6af0',
    color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: '0.8rem', outline: 'none', minWidth: 0,
  },
  iconBtn: {
    background: 'transparent', border: 'none', color: '#5b6af0',
    cursor: 'pointer', fontSize: '0.85rem', padding: '0 3px', lineHeight: 1,
  },
}
