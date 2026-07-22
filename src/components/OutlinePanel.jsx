import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
export default function OutlinePanel({ selectedNodeId, onSelectNode, containerNodeIds, searchText = '', onSearchText, drillRoot = null, onExitDrill }) {
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

  // Real-time search: dim every row whose label doesn't match (null = no filter, nothing dimmed).
  const q = (searchText || '').trim().toLowerCase()
  const matchSet = useMemo(() => q ? new Set(nodes.filter(n => (n.label || '').toLowerCase().includes(q)).map(n => n.id)) : null, [q, nodes])

  // Drill: scope the outline to the drilled node's subtree (mirrors the canvas drill state).
  const drillLabel = drillRoot ? (nodes.find(n => n.id === drillRoot)?.label || '(node)') : null
  const drillDesc = useMemo(() => {
    if (!drillRoot) return null
    const set = new Set([drillRoot]); const stack = [drillRoot]
    while (stack.length) { const cur = stack.pop(); edges.forEach(e => { if (e.source === cur && !set.has(e.target)) { set.add(e.target); stack.push(e.target) } }) }
    return set
  }, [drillRoot, edges])
  const scopedNodes = drillDesc ? nodes.filter(n => drillDesc.has(n.id)) : nodes
  const scopedEdges = drillDesc ? edges.filter(e => drillDesc.has(e.source) && drillDesc.has(e.target)) : edges

  const [expanded, setExpanded] = useState(() => new Set()) // expanded by default (empty = all shown)
  const [dropTarget, setDropTarget] = useState(null) // { id, position: 'before'|'after'|'into' }
  const [draggingId, setDraggingId] = useState(null)

  // Mouse drag state
  const dragging = useRef(null) // { nodeId }
  const containerRef = useRef()

  const frameIds = containerNodeIds || new Set()
  const frameNodes   = scopedNodes.filter(n => frameIds.has(n.id))
  const regularNodes = scopedNodes.filter(n => !frameIds.has(n.id))
  const frameTree   = buildTree(frameNodes, [])
  const regularTree = buildTree(regularNodes, scopedEdges.filter(e => !frameIds.has(e.source) && !frameIds.has(e.target)))

  const toggleExpand = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const isExpanded = (id) => !expanded.has(id) // items are expanded by default

  // Selecting a node on the graph → reveal + scroll to its outline row. Expand any collapsed
  // ancestor branches first (so the row is actually rendered), then scroll it into view.
  useEffect(() => {
    if (!selectedNodeId) return
    const parentOf = {}
    edges.forEach(e => { if (parentOf[e.target] === undefined) parentOf[e.target] = e.source })
    const anc = []; const guard = new Set(); let cur = parentOf[selectedNodeId]
    while (cur && !guard.has(cur)) { anc.push(cur); guard.add(cur); cur = parentOf[cur] }
    if (anc.length) setExpanded(prev => (anc.some(a => prev.has(a)) ? new Set([...prev].filter(id => !anc.includes(id))) : prev))
    const t = setTimeout(() => {
      const row = containerRef.current?.querySelector(`[data-outline-id="${CSS.escape(selectedNodeId)}"]`)
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 40)
    return () => clearTimeout(t)
  }, [selectedNodeId, edges])

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
    // Directly set pointer-events:none on the DOM element so elementFromPoint
    // can see through it immediately — don't wait for React re-render
    const rowEl = containerRef.current?.querySelector(`[data-outline-id="${nodeId}"]`)
    if (rowEl) { rowEl.style.pointerEvents = 'none'; rowEl.style.opacity = '0.3' }
    document.body.style.cursor = 'grabbing'

    const onMove = e => {
      const drop = getDropFromPoint(e.clientX, e.clientY)
      setDropTarget(drop)
    }

    const onUp = e => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (rowEl) { rowEl.style.pointerEvents = ''; rowEl.style.opacity = '' }
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
        {matchSet && <span style={{ fontSize: '0.62rem', color: '#8ecbff' }}>{matchSet.size} match{matchSet.size === 1 ? '' : 'es'}</span>}
      </div>

      {/* Real-time search — greys out non-matching rows here and non-matching nodes on the canvas. */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #1e1e2e', flexShrink: 0 }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input value={searchText} onChange={e => onSearchText?.(e.target.value)} placeholder="Search nodes…"
            style={styles.search} />
          {searchText && <button onMouseDown={e => e.preventDefault()} onClick={() => onSearchText?.('')} style={styles.searchClear} title="Clear">×</button>}
        </div>
      </div>

      {/* Drill breadcrumb — reflects the canvas drill-in state; the outline shows only that subtree. */}
      {drillRoot && (
        <div style={styles.drillBar}>
          <span style={{ opacity: 0.7 }}>⊳</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#c5d0ff', fontWeight: 600 }} title={drillLabel}>{drillLabel}</span>
          <button onClick={onExitDrill} style={styles.drillExit} title="Exit drill">exit ✕</button>
        </div>
      )}

      {/* Make-root drop zone */}
      <div
        data-outline-id="__root__"
        style={{
          height: 22, fontSize: '0.68rem', textAlign: 'center', lineHeight: '22px',
          borderBottom: '1px solid #1e1e2e',
          background: dropTarget?.id === '__root__' ? '#1a2a1a' : 'transparent',
          color: dropTarget?.id === '__root__' ? '#4ade80' : '#7080a0',
          transition: 'all 0.1s', userSelect: 'none',
        }}
      >
        ↑ make root
      </div>

      <div style={styles.tree}>
        {regularTree.length === 0 && frameTree.length === 0 && (
          <div style={styles.empty}>No nodes yet.<br />Use the <strong style={{ color: '#a0b4f0' }}>+</strong> button (bottom of the toolbar) → Root node.</div>
        )}
        {regularTree.map((root, i) => (
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
            containerNodeIds={containerNodeIds}
            matchSet={matchSet}
          />
        ))}

        {frameTree.length > 0 && (
          <>
            <div style={{ fontSize:'0.6rem', fontWeight:700, color:'#4a5280', letterSpacing:'0.08em', padding:'8px 8px 3px', borderTop:'1px solid #1e1e2e', marginTop:4 }}>
              FRAMES
            </div>
            {frameTree.map((root, i) => (
              <OutlineItem
                key={root.id + '-frame-' + i}
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
                containerNodeIds={containerNodeIds}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ── OutlineItem ───────────────────────────────────────────────────────────────
function OutlineItem({
  item, depth, selectedNodeId, onSelect,
  onAddChild, onRename, onDelete, onToggleVisible, onDrill,
  viewNodeProps, dropTarget, draggingId, onStartDrag, isExpanded, onToggleExpand, containerNodeIds, matchSet,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.label)
  const inputRef = useRef()

  const hasChildren = item.children.length > 0
  const expanded = isExpanded(item.id)
  const isHidden = viewNodeProps[item.id]?.visible === false
  const dimmed = matchSet && !matchSet.has(item.id)   // real-time search: grey out non-matches
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
          // Only start drag after actual mouse movement (preserves double-click for editing)
          const startX = e.clientX, startY = e.clientY
          const onMove = mv => {
            if (Math.abs(mv.clientX - startX) > 4 || Math.abs(mv.clientY - startY) > 4) {
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onCancel)
              onStartDrag(item.id)
            }
          }
          const onCancel = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onCancel)
          }
          document.addEventListener('mousemove', onMove)
          document.addEventListener('mouseup', onCancel)
        }}
        onClick={() => onSelect?.(item.id)}
        style={{
          paddingLeft: depth * 14 + 4,
          opacity: item.id === draggingId ? 0.3 : dimmed ? 0.32 : 1,
          transition: 'opacity 0.12s',
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

        {containerNodeIds?.has(item.id) && <span title="Frame container" style={{ fontSize: '0.7rem', marginRight: 3, opacity: 0.7 }}>⊞</span>}
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
            style={{ ...styles.label, color: isHidden ? '#7080a0' : undefined, fontStyle: isHidden ? 'italic' : undefined }}
            onDoubleClick={e => { e.stopPropagation(); setDraft(item.label); setEditing(true) }}
            title={item.label}
          >
            {item.label}
          </span>
        )}

        <div className="outline-actions">
          <button style={styles.iconBtn} title="Drill into" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDrill(item.id) }}>⊳</button>
          <button style={styles.iconBtn} title={isHidden ? 'Show' : 'Hide'} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggleVisible(item.id, isHidden) }}>
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
          containerNodeIds={containerNodeIds}
          matchSet={matchSet}
        />
      ))}
    </div>
  )
}

const styles = {
  panel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '0.6rem 0.75rem', borderBottom: '1px solid #1e1e2e', flexShrink: 0,
  },
  headerLabel: { fontSize: '0.65rem', fontWeight: 700, color: '#7080a0', letterSpacing: '0.08em' },
  search: { width: '100%', background: '#12122a', border: '1px solid #2d3a6a', color: '#e8eeff', borderRadius: 6, padding: '5px 26px 5px 8px', fontSize: '0.76rem', outline: 'none' },
  searchClear: { position: 'absolute', right: 4, background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 4px' },
  drillBar: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: '#141a30', borderBottom: '1px solid #23233e', flexShrink: 0, fontSize: '0.74rem', color: '#8ab4ff' },
  drillExit: { background: 'transparent', border: '1px solid #2d3a6a', color: '#8ecbff', borderRadius: 5, padding: '1px 7px', fontSize: '0.68rem', cursor: 'pointer', flexShrink: 0 },
  addRootBtn: {
    fontSize: '0.72rem', padding: '2px 7px', borderRadius: 4,
    border: '1px solid #2a2a3e', background: 'transparent', color: '#5b6af0', cursor: 'pointer',
  },
  dropLine: {
    height: 2, background: '#38bdf8', borderRadius: 1,
    position: 'absolute', left: 0, right: 0, zIndex: 10,
  },
  tree: { flex: 1, overflowY: 'auto', padding: '0.25rem 0' },
  empty: { color: '#8090b8', fontSize: '0.78rem', textAlign: 'center', padding: '2rem 1rem', lineHeight: 1.6 },
  chevron: {
    fontSize: 15, color: '#aaa',
    width: 20, height: 22, flexShrink: 0, userSelect: 'none',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  cloneTag: { fontSize: 9, color: '#5b6af0', flexShrink: 0 },
  label: {
    flex: 1, fontSize: '0.8rem', cursor: 'default',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
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
