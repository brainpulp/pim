import { useState } from 'react'

// Shared Notion-style property filter — used by the pack view and the board.
// filter = { text: string, rules: [{ propId, op, value }] }

export const OPS = {
  select: ['is', 'is not', 'is empty', 'not empty'],
  multiSelect: ['contains', 'not contains', 'is empty', 'not empty'],
  number: ['=', '≠', '>', '<', '≥', '≤', 'is empty', 'not empty'],
  date: ['before', 'after', 'on', 'is empty', 'not empty'],
  text: ['contains', 'not contains', 'is empty', 'not empty'],
  url: ['contains', 'is empty', 'not empty'],
  checkbox: ['checked', 'unchecked'],
}
export const needsValue = (op) => !['is empty', 'not empty', 'checked', 'unchecked'].includes(op)

// Default filter when a view has none yet: hide items whose status/select is "done" (any language),
// if such an option exists. Returns a filter object or null.
const DONE_RE = /^(done|hecho|hecha|completado|completada|listo|lista|finalizado|finalizada|terminado|terminada|closed|cerrado)$/i
export function defaultDoneFilter(propertyDefs) {
  for (const d of propertyDefs || []) {
    if (d.type !== 'select' && d.type !== 'multiSelect') continue
    const opt = (d.options || []).find(o => DONE_RE.test((o.name || '').trim()))
    if (opt) return { text: '', rules: [{ propId: d.id, op: d.type === 'multiSelect' ? 'not contains' : 'is not', value: opt.id }] }
  }
  return null
}

export function ruleMatches(node, rule, def) {
  const v = node.props?.[rule.propId]
  const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0)
  switch (rule.op) {
    case 'is empty': return empty
    case 'not empty': return !empty
    case 'is': return v === rule.value
    case 'is not': return v !== rule.value
    case 'contains': return def.type === 'multiSelect' ? (Array.isArray(v) && v.includes(rule.value)) : String(v || '').toLowerCase().includes(String(rule.value || '').toLowerCase())
    case 'not contains': return def.type === 'multiSelect' ? !(Array.isArray(v) && v.includes(rule.value)) : !String(v || '').toLowerCase().includes(String(rule.value || '').toLowerCase())
    case '=': return Number(v) === Number(rule.value)
    case '≠': return Number(v) !== Number(rule.value)
    case '>': return Number(v) > Number(rule.value)
    case '<': return Number(v) < Number(rule.value)
    case '≥': return Number(v) >= Number(rule.value)
    case '≤': return Number(v) <= Number(rule.value)
    case 'before': return !!v && !!rule.value && String(v) < String(rule.value)
    case 'after': return !!v && !!rule.value && String(v) > String(rule.value)
    case 'on': return !!v && !!rule.value && String(v).slice(0, 10) === String(rule.value).slice(0, 10)
    case 'checked': return !!v
    case 'unchecked': return !v
    default: return true
  }
}

export function nodeMatchesFilter(node, filter, propertyDefs) {
  const t = (filter.text || '').trim().toLowerCase()
  if (t && !String(node.label || '').toLowerCase().includes(t)) return false
  for (const rule of filter.rules || []) {
    if (!rule.propId || !rule.op) continue
    const def = propertyDefs.find(d => d.id === rule.propId)
    if (!def) continue
    if (needsValue(rule.op) && (rule.value == null || rule.value === '')) continue
    if (!ruleMatches(node, rule, def)) return false
  }
  return true
}

const fs = {
  box: { display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(18,18,42,0.92)', border: '1px solid #2d3a6a', borderRadius: 8, padding: '3px 6px', position: 'relative' },
  input: { background: 'transparent', border: 'none', color: '#e8eeff', fontSize: '0.8rem', outline: 'none', width: 150 },
  clear: { background: 'transparent', border: 'none', color: '#8090b8', cursor: 'pointer', fontSize: '0.9rem', width: 18, lineHeight: 1 },
  tag: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.76rem', padding: '0 6px' },
  backdrop: { position: 'fixed', inset: 0, zIndex: 6 },
  menu: { position: 'absolute', top: '112%', right: 0, zIndex: 7, background: '#16162a', border: '1px solid #2d3a6a', borderRadius: 8, padding: 8, minWidth: 320, boxShadow: '0 8px 26px rgba(0,0,0,0.6)' },
  sel: { background: '#12122a', border: '1px solid #2d3a6a', color: '#c5d0ff', borderRadius: 5, padding: '3px 5px', fontSize: '0.76rem', maxWidth: 110 },
  add: { background: '#1a1f4a', border: '1px solid #3a4a8a', color: '#c5d0ff', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: '0.76rem' },
}

export function FilterBar({ filter, setFilter, propertyDefs }) {
  const [open, setOpen] = useState(false)
  const filterable = propertyDefs.filter(d => OPS[d.type])
  const rules = filter.rules || []
  const setRule = (i, patch) => setFilter(f => ({ ...f, rules: f.rules.map((r, j) => j === i ? { ...r, ...patch } : r) }))
  const addRule = () => { const d = filterable[0]; if (!d) return; setFilter(f => ({ ...f, rules: [...(f.rules || []), { propId: d.id, op: OPS[d.type][0], value: '' }] })); setOpen(true) }
  const delRule = (i) => setFilter(f => ({ ...f, rules: f.rules.filter((_, j) => j !== i) }))
  return (
    <div style={fs.box}>
      <input value={filter.text || ''} onChange={e => setFilter(f => ({ ...f, text: e.target.value }))}
        placeholder="Filter items…" style={fs.input} onMouseDown={e => e.stopPropagation()} />
      {filter.text && <button style={fs.clear} onClick={() => setFilter(f => ({ ...f, text: '' }))}>×</button>}
      <button style={{ ...fs.tag, color: rules.length ? '#8ab4ff' : '#8090b8' }}
        onClick={() => setOpen(o => !o)} title="Filter by property">⛃ {rules.length ? `${rules.length}` : 'Filter'} ▾</button>
      {open && (<>
        <div style={fs.backdrop} onClick={() => setOpen(false)} />
        <div style={fs.menu} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
          {!filterable.length && <div style={{ color: '#8090b8', fontSize: '0.76rem', padding: 4 }}>No filterable properties.</div>}
          {rules.map((r, i) => {
            const def = propertyDefs.find(d => d.id === r.propId) || filterable[0]
            const ops = OPS[def?.type] || ['contains']
            return (
              <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
                <select value={r.propId} onChange={e => { const nd = propertyDefs.find(d => d.id === e.target.value); setRule(i, { propId: e.target.value, op: OPS[nd.type][0], value: '' }) }} style={fs.sel}>
                  {filterable.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <select value={r.op} onChange={e => setRule(i, { op: e.target.value })} style={fs.sel}>
                  {ops.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {needsValue(r.op) && (
                  (def?.type === 'select' || def?.type === 'multiSelect')
                    ? <select value={r.value || ''} onChange={e => setRule(i, { value: e.target.value })} style={fs.sel}>
                        <option value="">—</option>
                        {(def.options || []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    : <input type={def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text'}
                        value={r.value || ''} onChange={e => setRule(i, { value: e.target.value })}
                        style={{ ...fs.sel, width: 90 }} />
                )}
                <button style={fs.clear} onClick={() => delRule(i)}>×</button>
              </div>
            )
          })}
          {!!filterable.length && <button style={fs.add} onClick={addRule}>+ Add filter</button>}
          {rules.length > 0 && <button style={{ ...fs.clear, width: 'auto', marginLeft: 8, fontSize: '0.74rem' }} onClick={() => setFilter(f => ({ ...f, rules: [] }))}>clear all</button>}
        </div>
      </>)}
    </div>
  )
}
