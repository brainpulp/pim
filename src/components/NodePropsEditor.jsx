import { useState } from 'react'

// Modal: edit every property of a node (all types). Writes via onSet(propId, value).
// onAddOption(propId, name) adds a new select/multiSelect value. Shared by pack view + board.
// `actions` = optional [{ label, onClick, danger? }] rendered as a footer button row.
// `projectLink` = optional { projects:[{id,name}], value:linkTo|undefined, currentProjectId, onSet }
//   → renders a "Link to project" picker so a node can jump to another project.
export default function NodePropsEditor({ node, propertyDefs, onSet, onAddOption, onClose, actions, projectLink, cosmetics }) {
  if (!node) return null
  const props = node.props || {}
  return (
    <div style={npe.backdrop} onMouseDown={onClose}>
      <div style={npe.panel} onMouseDown={e => e.stopPropagation()}>
        <div style={npe.head}>
          <span style={npe.title}>{node.label || '(untitled)'}</span>
          <button style={npe.close} onClick={onClose}>×</button>
        </div>
        {cosmetics && <CosmeticsRow {...cosmetics} />}
        {!propertyDefs.length && <div style={{ color: '#8090b8', fontSize: '0.82rem', padding: '8px 2px' }}>This project has no properties yet.</div>}
        <div style={npe.rows}>
          {propertyDefs.map(def => (
            <div key={def.id} style={npe.row}>
              <div style={npe.key}>{def.name}</div>
              <div style={npe.val}><PropInput def={def} value={props[def.id]} onSet={v => onSet(def.id, v)} onAddOption={name => onAddOption(def.id, name)} /></div>
            </div>
          ))}
          {projectLink && <ProjectLinkInput {...projectLink} />}
        </div>
        {actions && actions.length > 0 && (
          <div style={npe.actions}>
            {actions.map((a, i) => (
              <button key={i} style={{ ...npe.actionBtn, ...(a.danger ? npe.actionDanger : {}) }} onClick={a.onClick}>{a.label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Appearance row: fill colour + shape for this node in the active view (mirrors the graph's cosmetics).
const SHAPE_GLYPH = { circle: '●', ellipse: '⬭', roundrect: '▢', rect: '▮', diamond: '◆', none: '○' }
function CosmeticsRow({ fillColors = [], shapes = [], value = {}, onSet }) {
  const cur = value.fillColor || null
  const curShape = value.shape || 'circle'
  return (
    <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #23233e', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={npe.key}>Colour</span>
        <button title="No fill" onClick={() => onSet('fillColor', null)}
          style={{ ...npe.swatch, background: 'transparent', outline: cur ? 'none' : '2px solid #8ab4ff' }}>∅</button>
        {fillColors.map(c => (
          <button key={c} onClick={() => onSet('fillColor', c)}
            style={{ ...npe.swatch, background: c, outline: cur === c ? '2px solid #fff' : 'none' }} />
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={npe.key}>Shape</span>
        {shapes.map(s => (
          <button key={s} title={s} onClick={() => onSet('shape', s)}
            style={{ ...npe.shapeBtn, ...(curShape === s ? npe.shapeBtnOn : {}) }}>{SHAPE_GLYPH[s] || s}</button>
        ))}
      </div>
    </div>
  )
}

// "Link to project" row: a node becomes a portal to another project. value = { projectId, projectName }.
function ProjectLinkInput({ projects = [], value, currentProjectId, onSet }) {
  const others = projects.filter(p => p.id !== currentProjectId)
  return (
    <div style={{ ...npe.row, gridTemplateColumns: '110px 1fr', paddingTop: 6, borderTop: '1px solid #23233e', marginTop: 4 }}>
      <div style={npe.key}>↗ Links to</div>
      <div style={npe.val}>
        {value?.projectId ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ ...npe.chip, background: '#1a1f4a', borderColor: '#3a4a8a', color: '#c5d0ff', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              ↗ {value.projectName || 'project'}
            </span>
            <button style={npe.addChip} onClick={() => onSet(null)}>Clear</button>
          </div>
        ) : (
          <select value="" onChange={e => { const p = others.find(x => x.id === e.target.value); if (p) onSet({ projectId: p.id, projectName: p.name }) }}
            style={{ ...npe.input, cursor: 'pointer' }}>
            <option value="">— link this node to a project —</option>
            {others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}

function PropInput({ def, value, onSet, onAddOption }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  if (def.type === 'checkbox') return <input type="checkbox" checked={!!value} onChange={e => onSet(e.target.checked)} />
  if (def.type === 'number') return <input type="number" value={value ?? ''} onChange={e => onSet(e.target.value === '' ? null : Number(e.target.value))} style={npe.input} />
  if (def.type === 'date') return <input type="date" value={value ? String(value).slice(0, 10) : ''} onChange={e => onSet(e.target.value || null)} style={npe.input} />
  if (def.type === 'url' || def.type === 'text') return <input type="text" value={value ?? ''} onChange={e => onSet(e.target.value)} style={npe.input} placeholder="—" />
  if (def.type === 'select' || def.type === 'multiSelect') {
    const opts = def.options || []
    const selected = def.type === 'multiSelect' ? (Array.isArray(value) ? value : (value ? [value] : [])) : (value ? [value] : [])
    const toggle = (id) => {
      if (def.type === 'multiSelect') { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); onSet([...s]) }
      else onSet(selected[0] === id ? null : id)
    }
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
        {opts.map(o => {
          const on = selected.includes(o.id)
          return <button key={o.id} onClick={() => toggle(o.id)}
            style={{ ...npe.chip, background: on ? (o.color || '#5b6af0') : 'transparent', borderColor: o.color || '#5b6af0', color: on ? '#0c0c1a' : '#c5d0ff', fontWeight: on ? 700 : 400 }}>{o.name}</button>
        })}
        {adding
          ? <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) { onAddOption(draft.trim()); setDraft(''); setAdding(false) } if (e.key === 'Escape') { setDraft(''); setAdding(false) } }}
              onBlur={() => { if (draft.trim()) onAddOption(draft.trim()); setDraft(''); setAdding(false) }}
              placeholder="new value…" style={{ ...npe.input, width: 90 }} />
          : <button style={npe.addChip} onClick={() => setAdding(true)}>+ value</button>}
      </div>
    )
  }
  return <span style={{ color: '#8090b8' }}>—</span>
}

const npe = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,5,14,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  panel: { width: 'min(460px, 92vw)', maxHeight: '82vh', overflow: 'auto', background: '#14142a', border: '1px solid #2d3a6a', borderRadius: 12, padding: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: '#e8eeff', fontSize: '1rem', fontWeight: 700 },
  close: { background: 'transparent', border: 'none', color: '#8090b8', fontSize: '1.3rem', cursor: 'pointer', lineHeight: 1 },
  rows: { display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, alignItems: 'start' },
  key: { color: '#8ab4ff', fontSize: '0.8rem', paddingTop: 5 },
  val: { minWidth: 0 },
  input: { width: '100%', background: '#0f0f22', border: '1px solid #2d3a6a', color: '#e8eeff', borderRadius: 6, padding: '5px 8px', fontSize: '0.82rem', outline: 'none' },
  chip: { border: '1px solid', borderRadius: 100, padding: '3px 10px', fontSize: '0.76rem', cursor: 'pointer' },
  addChip: { border: '1px dashed #3a4a8a', background: 'transparent', color: '#8ab4ff', borderRadius: 100, padding: '3px 10px', fontSize: '0.76rem', cursor: 'pointer' },
  swatch: { width: 20, height: 20, borderRadius: 5, border: '1px solid #2d3a6a', cursor: 'pointer', color: '#8090b8', fontSize: '0.7rem', padding: 0, lineHeight: 1 },
  shapeBtn: { minWidth: 26, height: 26, borderRadius: 6, border: '1px solid #2d3a6a', background: '#0f0f22', color: '#c5d0ff', cursor: 'pointer', fontSize: '0.9rem', padding: '0 4px' },
  shapeBtnOn: { background: '#26306a', borderColor: '#5b6af0', color: '#fff' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid #23233e' },
  actionBtn: { background: '#181834', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 7, padding: '6px 11px', fontSize: '0.78rem', cursor: 'pointer' },
  actionDanger: { borderColor: '#5a2a2a', color: '#f0a0a0' },
}
