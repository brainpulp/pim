import { Handle, Position } from '@xyflow/react'

export function TaskNode({ data }) {
  const n = data.strategyNode
  return (
    <div className="strat-node-task" title={n.description}>
      <Handle type="target" position={Position.Top} />
      <div className="strat-node-label">{n.label}</div>
      {n.description && <div className="strat-node-description">{n.description}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export function DecisionNode({ data }) {
  const n = data.strategyNode
  return (
    <div className="strat-node-decision" title={n.description}>
      <Handle type="target" position={Position.Top} />
      <div className="strat-node-decision-shape" />
      <div className="strat-node-label">{n.label}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export function StartEndNode({ data }) {
  const n = data.strategyNode
  return (
    <div className={`strat-node-startend strat-node-${n.kind}`}>
      {n.kind !== 'start' && <Handle type="target" position={Position.Top} />}
      <div className="strat-node-label">{n.label}</div>
      {n.kind !== 'end' && <Handle type="source" position={Position.Bottom} />}
    </div>
  )
}

export function NoteNode({ data }) {
  return (
    <div className="strat-node-note">
      <div className="strat-node-label">{data.strategyNode.label}</div>
    </div>
  )
}
