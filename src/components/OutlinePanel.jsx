import { useState, useEffect, useRef } from 'react'
import useGraphStore from '../lib/graphStore'

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
      id: nodeId,
      label: node.label,
      parentId: parentId || null,
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
      items.push({
        id: n.id, label: n.label, parentId: null, isClone: false,
        children: (childrenOf[n.id] || [])
          .filter(cid => !seen.has(cid))
          .map(cid => buildItem(cid, new Set([n.id]), n.id))
          .filter(Boolean),
      })
    }
  })
  return items
}

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

  // dropTarget: { id: string|'root', position: 'before'|'after'|'into' } | null
  const [dragId, setDragId] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)

  const tree = buildTree(nodes, edges)

  const handleDrop = (targetId, position) => {
    if (!dragId || dragId === targetId) { setDragId(null); setDropTarget(null); return }

    if (targetId === 'root' || position === 'into') {
      reparentNode(dragId, targetId === 'root' ? null : targetId)
    } else {
      // before / after: become sibling → same parent as target
      const parentEdge = edges.find(e => e.target === targetId)
      reparentNode(dragId, parentEdge?.source || null)
    }
    setDragId(null)
    setDropTarget(null)
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerLabel}>OUTLINE</span>
        <button style={styles.addRootBtn} onClick={() => addNode('New node')}>+ Root</button>
      </div>

      {/* Make-root drop zone (only visible while dragging) */}
      {dragId && (
        <div
          style={{
            ...styles.dropZone,
            background: dropTarget?.id === 'root' ? '#1a2a1a' : 'transparent',
            borderColor: dropTarget?.id === 'root' ? '#4ade80' : '#2d3a6a',
          }}
          onDragOver={e => { e.preventDefault(); setDropTarget({ id: 'root', position: 'into' }) }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={() => handleDrop('root', 'into')}
        >
          ↑ make root
        </div>
      )}

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
            dragId={dragId}
            dropTarget={dropTarget}
            onDragStart={setDragId}
            onDragOver={setDropTarget}
            onDrop={handleDrop}
            onDragEnd={() => { setDragId(null); setDropTarget(null) }}
          />
        ))}
      </div>
    </div>
  )
}

function OutlineItem({
  item, depth, selectedNodeId, onSelect,
  onAddChild, onRename, onDelete, onToggleVisible, onDrill,
  viewNodeProps, dragId, dropTarget, onDragStart, onDragOver, onDrop, onDragEnd,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.label)
  const [expanded, setExpanded] = useState(true)
  const inputRef = useRef()

  const hasChildren = item.children.length > 0
  const isHidden = viewNodeProps[item.id]?.visible === false
  const isSelected = item.id === selectedNodeId
  const isDropInto = dropTarget?.id === item.id && dropTarget?.position === 'into'
  const isDropBefore = dropTarget?.id === item.id && dropTarget?.position === 'before'
  const isDropAfter = dropTarget?.id === item.id && dropTarget?.position === 'after'

  useEffect(() => { if (!editing) setDraft(item.label) }, [item.label, editing])
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])

  const commitEdit = () => { onRename(item.id, draft); setEditing(false) }

  const handleDragOver = (e) => {
    e.preventDefault(); e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const relY = (e.clientY - rect.top) / rect.height
    const position = relY < 0.3 ? 'before' : relY > 0.7 ? 'after' : 'into'
    onDragOver({ id: item.id, position })
  }

  return (
    <div style={{ paddingLeft: depth * 14, position: 'relative' }}>
      {/* Drop-before indicator */}
      {isDropBefore && <div style={styles.dropLine} />}

      <div
        className="outline-row"
        draggable
        style={{
          opacity: (isHidden && !isSelected) ? 0.4 : 1,
          background: isSelected ? '#1e2048' : isDropInto ? '#1a2a3a' : undefined,
          borderLeft: isSelected
            ? '2px solid #5b6af0'
            : isDropInto ? '2px solid #38bdf8'
            : '2px solid transparent',
          cursor: dragId ? 'grabbing' : 'grab',
        }}
        onClick={() => onSelect?.(item.id)}
        onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(item.id) }}
        onDragOver={handleDragOver}
        onDragLeave={e => { e.stopPropagation(); onDragOver(null) }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(item.id, dropTarget?.position || 'into') }}
        onDragEnd={onDragEnd}
      >
        {/* Chevron — always rendered, faded if no children */}
        <span
          style={{
            ...styles.chevron,
            opacity: hasChildren ? 1 : 0.15,
            cursor: hasChildren ? 'pointer' : 'default',
          }}
          onClick={e => { if (!hasChildren) return; e.stopPropagation(); setExpanded(v => !v) }}
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
          <button style={styles.iconBtn} title="Drill" onClick={e => { e.stopPropagation(); onDrill(item.id) }}>⊳</button>
          <button style={styles.iconBtn} title={isHidden ? 'Show' : 'Hide'}
            onClick={e => { e.stopPropagation(); onToggleVisible(item.id, !isHidden) }}>
            {isHidden ? '◌' : '●'}
          </button>
          <button style={styles.iconBtn} title="Add child" onClick={e => { e.stopPropagation(); onAddChild(item.id) }}>+</button>
          <button style={{ ...styles.iconBtn, color: '#f87171' }} title="Delete" onClick={e => { e.stopPropagation(); onDelete(item.id) }}>×</button>
        </div>
      </div>

      {/* Drop-after indicator */}
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
          dragId={dragId}
          dropTarget={dropTarget}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
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
  dropZone: {
    fontSize: '0.68rem', color: '#4ade80', textAlign: 'center', padding: '3px 0',
    border: '1px dashed', borderRadius: 4, margin: '2px 8px', transition: 'all 0.1s',
  },
  dropLine: {
    height: 2, background: '#38bdf8', borderRadius: 1,
    position: 'absolute', left: 0, right: 0, zIndex: 10,
  },
  tree: { flex: 1, overflowY: 'auto', padding: '0.25rem 0.25rem' },
  empty: { color: '#444', fontSize: '0.78rem', textAlign: 'center', padding: '2rem 1rem', lineHeight: 1.6 },
  chevron: {
    fontSize: 11, color: '#aaa', cursor: 'pointer',
    width: 14, flexShrink: 0, userSelect: 'none',
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
    cursor: 'pointer', fontSize: '0.85rem', padding: '0 2px', lineHeight: 1,
  },
}
