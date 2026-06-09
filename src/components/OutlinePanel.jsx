import { useState } from 'react'
import useGraphStore from '../lib/graphStore'

// Build a display tree from flat nodes+edges.
// Multi-parent nodes appear as clones under each parent (isClone = true).
// Cycle detection via ancestor set prevents infinite loops.
function buildTree(nodes, edges) {
  const childrenOf = {}
  const parentCount = {}
  nodes.forEach(n => { childrenOf[n.id] = []; parentCount[n.id] = 0 })

  edges.forEach(e => {
    if (childrenOf[e.source] !== undefined) childrenOf[e.source].push(e.target)
    if (parentCount[e.target] !== undefined) parentCount[e.target]++
  })

  const roots = nodes.filter(n => parentCount[n.id] === 0)

  function buildItem(nodeId, ancestors) {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return null
    const newAncestors = new Set([...ancestors, nodeId])
    return {
      id: nodeId,
      label: node.label,
      isClone: parentCount[nodeId] > 1,
      children: (childrenOf[nodeId] || [])
        .filter(childId => !ancestors.has(childId))
        .map(childId => buildItem(childId, newAncestors))
        .filter(Boolean),
    }
  }

  return roots.map(n => buildItem(n.id, new Set()))
}

export default function OutlinePanel() {
  const nodes = useGraphStore(s => s.nodes)
  const edges = useGraphStore(s => s.edges)
  const addNode = useGraphStore(s => s.addNode)
  const updateLabel = useGraphStore(s => s.updateLabel)
  const deleteNode = useGraphStore(s => s.deleteNode)

  const tree = buildTree(nodes, edges)

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerLabel}>OUTLINE</span>
        <button style={styles.addRootBtn} onClick={() => addNode('New node')}>+ Root</button>
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
            onAddChild={parentId => addNode('New node', parentId)}
            onRename={updateLabel}
            onDelete={deleteNode}
          />
        ))}
      </div>
    </div>
  )
}

function OutlineItem({ item, depth, onAddChild, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.label)
  const [expanded, setExpanded] = useState(true)
  const hasChildren = item.children.length > 0

  const commitEdit = () => {
    onRename(item.id, draft)
    setEditing(false)
  }

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <div className="outline-row">
        <span
          style={{ ...styles.chevron, opacity: hasChildren ? 1 : 0 }}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? '▾' : '▸'}
        </span>

        {item.isClone && <span style={styles.cloneTag} title="This node has multiple parents">⇢</span>}

        {editing ? (
          <input
            style={styles.input}
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
          />
        ) : (
          <span
            style={styles.label}
            onDoubleClick={() => { setDraft(item.label); setEditing(true) }}
            title={item.label}
          >
            {item.label}
          </span>
        )}

        <div className="outline-actions">
          <button style={styles.iconBtn} onClick={() => onAddChild(item.id)} title="Add child">+</button>
          <button style={{ ...styles.iconBtn, color: '#f87171' }} onClick={() => onDelete(item.id)} title="Delete">×</button>
        </div>
      </div>

      {expanded && item.children.map((child, i) => (
        <OutlineItem
          key={child.id + '-' + depth + '-' + i}
          item={child}
          depth={depth + 1}
          onAddChild={onAddChild}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

const styles = {
  panel: {
    width: 220,
    minWidth: 220,
    background: '#111118',
    borderRight: '1px solid #1e1e2e',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.6rem 0.75rem',
    borderBottom: '1px solid #1e1e2e',
    flexShrink: 0,
  },
  headerLabel: {
    fontSize: '0.65rem',
    fontWeight: 700,
    color: '#555',
    letterSpacing: '0.08em',
  },
  addRootBtn: {
    fontSize: '0.72rem',
    padding: '2px 7px',
    borderRadius: 4,
    border: '1px solid #2a2a3e',
    background: 'transparent',
    color: '#5b6af0',
    cursor: 'pointer',
  },
  tree: {
    flex: 1,
    overflowY: 'auto',
    padding: '0.4rem 0.25rem',
  },
  empty: {
    color: '#444',
    fontSize: '0.78rem',
    textAlign: 'center',
    padding: '2rem 1rem',
    lineHeight: 1.6,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    padding: '2px 4px',
    borderRadius: 4,
    color: '#ccc',
    minHeight: 24,
  },
  chevron: {
    fontSize: 9,
    color: '#555',
    cursor: 'pointer',
    width: 10,
    flexShrink: 0,
    userSelect: 'none',
  },
  cloneTag: {
    fontSize: 9,
    color: '#5b6af0',
    flexShrink: 0,
  },
  label: {
    flex: 1,
    fontSize: '0.8rem',
    cursor: 'default',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  input: {
    flex: 1,
    background: '#1a1a2e',
    border: '1px solid #5b6af0',
    color: '#fff',
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: '0.8rem',
    outline: 'none',
    minWidth: 0,
  },
  actions: {
    display: 'flex',
    gap: 2,
    opacity: 0,
    flexShrink: 0,
  },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: '#5b6af0',
    cursor: 'pointer',
    fontSize: '0.85rem',
    padding: '0 3px',
    lineHeight: 1,
  },
}

