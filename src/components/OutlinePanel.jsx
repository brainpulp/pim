import { useState, useEffect, useRef } from 'react'
import useGraphStore from '../lib/graphStore'

// Build display tree. After building from real roots, append any unseen
// nodes as extra top-level items (handles cycles + fully disconnected nodes).
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

  // Orphans and nodes in pure cycles (never seen after root traversal)
  nodes.forEach(n => {
    if (!seen.has(n.id)) {
      seen.add(n.id)
      items.push({
        id: n.id,
        label: n.label,
        isClone: false,
        children: (childrenOf[n.id] || [])
          .filter(cid => !seen.has(cid))
          .map(cid => buildItem(cid, new Set([n.id])))
          .filter(Boolean),
      })
    }
  })

  return items
}

export default function OutlinePanel() {
  const nodes       = useGraphStore(s => s.nodes)
  const edges       = useGraphStore(s => s.edges)
  const addNode     = useGraphStore(s => s.addNode)
  const updateLabel = useGraphStore(s => s.updateLabel)
  const deleteNode  = useGraphStore(s => s.deleteNode)
  const activeViewId  = useGraphStore(s => s.activeViewId)
  const views         = useGraphStore(s => s.views)
  const setNodeViewProp = useGraphStore(s => s.setNodeViewProp)
  const setDrillRoot  = useGraphStore(s => s.setDrillRoot)

  const activeView = views.find(v => v.id === activeViewId) || views[0]
  const viewNodeProps = activeView?.nodeProps || {}

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
            onToggleVisible={(id, val) => setNodeViewProp(id, 'visible', val)}
            onDrill={id => setDrillRoot(id)}
            viewNodeProps={viewNodeProps}
          />
        ))}
      </div>
    </div>
  )
}

function OutlineItem({ item, depth, onAddChild, onRename, onDelete, onToggleVisible, onDrill, viewNodeProps }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.label)
  const [expanded, setExpanded] = useState(true)
  const inputRef = useRef()
  const hasChildren = item.children.length > 0
  const isHidden = viewNodeProps[item.id]?.visible === false

  // Sync label from store (e.g. renamed in graph)
  useEffect(() => { if (!editing) setDraft(item.label) }, [item.label, editing])
  // Select all text when editing starts
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const commitEdit = () => { onRename(item.id, draft); setEditing(false) }

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <div className="outline-row" style={isHidden ? { opacity: 0.4 } : {}}>
        <span
          style={{ ...styles.chevron, opacity: hasChildren ? 1 : 0 }}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? '▾' : '▸'}
        </span>

        {item.isClone && <span style={styles.cloneTag} title="Multi-parent or cycle">⇢</span>}

        {editing ? (
          <input
            ref={inputRef}
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
          <button style={styles.iconBtn} onClick={() => onDrill(item.id)} title="Drill into this node">⊳</button>
          <button style={styles.iconBtn} onClick={() => onToggleVisible(item.id, isHidden ? true : false)} title={isHidden ? 'Show' : 'Hide'}>
            {isHidden ? '◌' : '●'}
          </button>
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
          onToggleVisible={onToggleVisible}
          onDrill={onDrill}
          viewNodeProps={viewNodeProps}
        />
      ))}
    </div>
  )
}

const styles = {
  panel: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.6rem 0.75rem', borderBottom: '1px solid #1e1e2e', flexShrink: 0,
  },
  headerLabel: { fontSize: '0.65rem', fontWeight: 700, color: '#555', letterSpacing: '0.08em' },
  addRootBtn: {
    fontSize: '0.72rem', padding: '2px 7px', borderRadius: 4,
    border: '1px solid #2a2a3e', background: 'transparent', color: '#5b6af0', cursor: 'pointer',
  },
  tree: { flex: 1, overflowY: 'auto', padding: '0.4rem 0.25rem' },
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
