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

  function buildItem(nodeId, ancestors) {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return null
    const alreadySeen = seen.has(nodeId)
    seen.add(nodeId)
    const newAncestors = new Set([...ancestors, nodeId])
    return {
      id: nodeId,
      label: node.label,
      isClone: parentCount[nodeId] > 1 || alreadySeen,
      children: alreadySeen ? [] : (childrenOf[nodeId] || [])
        .filter(cid => !ancestors.has(cid))
        .map(cid => buildItem(cid, newAncestors))
        .filter(Boolean),
    }
  }

  const items = roots.map(n => buildItem(n.id, new Set()))
  nodes.forEach(n => {
    if (!seen.has(n.id)) {
      seen.add(n.id)
      items.push({
        id: n.id, label: n.label, isClone: false,
        children: (childrenOf[n.id] || [])
          .filter(cid => !seen.has(cid))
          .map(cid => buildItem(cid, new Set([n.id])))
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

  // Drag-drop state: which node id is being dragged
  const [dragId, setDragId] = useState(null)
  const [dropTargetId, setDropTargetId] = useState(null) // 'root' | nodeId

  const tree = buildTree(nodes, edges)

  const handleDrop = (targetId) => {
    if (!dragId || dragId === targetId) return
    reparentNode(dragId, targetId === 'root' ? null : targetId)
    setDragId(null)
    setDropTargetId(null)
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerLabel}>OUTLINE</span>
        <button style={styles.addRootBtn} onClick={() => addNode('New node')}>+ Root</button>
      </div>

      {/* Root drop zone */}
      <div
        style={{
          ...styles.dropZone,
          opacity: dragId ? 1 : 0,
          background: dropTargetId === 'root' ? '#1a2a1a' : 'transparent',
          borderColor: dropTargetId === 'root' ? '#4ade80' : '#2d3a6a',
        }}
        onDragOver={e => { e.preventDefault(); setDropTargetId('root') }}
        onDragLeave={() => setDropTargetId(null)}
        onDrop={() => handleDrop('root')}
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
            dragId={dragId}
            dropTargetId={dropTargetId}
            onDragStart={setDragId}
            onDragOver={setDropTargetId}
            onDrop={handleDrop}
            onDragEnd={() => { setDragId(null); setDropTargetId(null) }}
          />
        ))}
      </div>
    </div>
  )
}

function OutlineItem({
  item, depth, selectedNodeId, onSelect,
  onAddChild, onRename, onDelete, onToggleVisible, onDrill,
  viewNodeProps, dragId, dropTargetId, onDragStart, onDragOver, onDrop, onDragEnd,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.label)
  const [expanded, setExpanded] = useState(true)
  const inputRef = useRef()
  const hasChildren = item.children.length > 0
  const isHidden = viewNodeProps[item.id]?.visible === false
  const isSelected = item.id === selectedNodeId
  const isDropTarget = dropTargetId === item.id

  useEffect(() => { if (!editing) setDraft(item.label) }, [item.label, editing])
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])

  const commitEdit = () => { onRename(item.id, draft); setEditing(false) }

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <div
        className="outline-row"
        draggable
        style={{
          opacity: isHidden ? 0.4 : 1,
          background: isSelected
            ? '#1e2048'
            : isDropTarget
            ? '#1a2a3a'
            : undefined,
          borderLeft: isSelected ? '2px solid #5b6af0' : isDropTarget ? '2px solid #38bdf8' : '2px solid transparent',
          cursor: 'grab',
        }}
        onClick={() => onSelect?.(item.id)}
        onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(item.id) }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); onDragOver(item.id) }}
        onDragLeave={e => { e.stopPropagation(); onDragOver(null) }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(item.id) }}
        onDragEnd={onDragEnd}
      >
        <span
          style={{ ...styles.chevron, opacity: hasChildren ? 1 : 0 }}
          onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
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
          <button style={styles.iconBtn} onClick={e => { e.stopPropagation(); onDrill(item.id) }} title="Drill">⊳</button>
          <button style={styles.iconBtn} onClick={e => { e.stopPropagation(); onToggleVisible(item.id, isHidden ? true : false) }} title={isHidden ? 'Show' : 'Hide'}>
            {isHidden ? '◌' : '●'}
          </button>
          <button style={styles.iconBtn} onClick={e => { e.stopPropagation(); onAddChild(item.id) }} title="Add child">+</button>
          <button style={{ ...styles.iconBtn, color: '#f87171' }} onClick={e => { e.stopPropagation(); onDelete(item.id) }} title="Delete">×</button>
        </div>
      </div>

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
          dropTargetId={dropTargetId}
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
  panel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
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
    pointerEvents: 'auto',
  },
  tree: { flex: 1, overflowY: 'auto', padding: '0.25rem 0.25rem' },
  empty: { color: '#444', fontSize: '0.78rem', textAlign: 'center', padding: '2rem 1rem', lineHeight: 1.6 },
  chevron: { fontSize: 9, color: '#555', cursor: 'pointer', width: 10, flexShrink: 0, userSelect: 'none' },
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
