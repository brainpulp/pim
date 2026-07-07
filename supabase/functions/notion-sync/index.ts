// Supabase Edge Function: notion-sync
// Server-side proxy to the Notion REST API (holds NOTION_TOKEN; browser can't, and CORS blocks direct calls).
//   POST { action: 'pull', databaseId }        → { name, propertyDefs, nodes, edges }  (full import)
//   POST { action: 'push', changes: [...] }    → { updated, errors }                   (write back to Notion)
// The Notion query endpoint paginates ALL rows and is NOT gated by the Business/AI plan (that gate is only
// on the MCP query tool). Requires an internal integration token in the NOTION_TOKEN secret and the target
// database shared with that integration.

const NOTION_TOKEN = Deno.env.get('NOTION_TOKEN') || ''
const NOTION_VERSION = '2022-06-28'
const API = 'https://api.notion.com/v1'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// Notion colour names → hex (matches the app's dark palette reasonably).
const COLOR: Record<string, string> = {
  default: '#6b7280', gray: '#9ca3af', brown: '#a3703b', orange: '#f97316', yellow: '#eab308',
  green: '#22c55e', blue: '#3b82f6', purple: '#8b5cf6', pink: '#ec4899', red: '#ef4444',
}
const hex = (c?: string) => COLOR[c || 'default'] || '#6b7280'

async function notion(path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Notion ${path} ${res.status}: ${data?.message || res.statusText}`)
  return data
}

const plain = (rich: any[]) => (rich || []).map(r => r?.plain_text ?? '').join('')

// ── PULL: Notion database → PIM project shape ────────────────────────────────
async function pull(databaseId: string) {
  const db = await notion(`/databases/${databaseId}`)
  const title = plain(db.title) || 'Notion import'
  const schema: Record<string, any> = db.properties || {}

  // propertyDefs (skip title/relation/system/computed — relations become edges).
  const propertyDefs: any[] = []
  const propType: Record<string, string> = {}   // notion prop id → pim type ('__notes__' for the notes field)
  const relationProps: string[] = []            // property NAMES that are self-relations (→ edges)
  for (const [name, p] of Object.entries(schema)) {
    const t = (p as any).type
    const id = (p as any).id
    if (t === 'title') { propType[id] = '__title__'; continue }
    if (t === 'relation') { relationProps.push(name); continue }
    if (t === 'rich_text' && /descrip|notes?|detalle/i.test(name)) { propType[id] = '__notes__'; continue }
    let pimType: string | null = null
    let options: any[] | undefined
    if (t === 'rich_text') pimType = 'text'
    else if (t === 'number') pimType = 'number'
    else if (t === 'url') pimType = 'url'
    else if (t === 'checkbox') pimType = 'checkbox'
    else if (t === 'date') pimType = 'date'
    else if (t === 'email' || t === 'phone_number') pimType = 'text'
    else if (t === 'select') { pimType = 'select'; options = (p as any).select.options.map((o: any) => ({ id: o.id, name: o.name, color: hex(o.color) })) }
    else if (t === 'status') { pimType = 'select'; options = (p as any).status.options.map((o: any) => ({ id: o.id, name: o.name, color: hex(o.color) })) }
    else if (t === 'multi_select') { pimType = 'multiSelect'; options = (p as any).multi_select.options.map((o: any) => ({ id: o.id, name: o.name, color: hex(o.color) })) }
    else continue   // people, files, formula, rollup, created_time, last_edited_time, button…
    propType[id] = pimType
    const def: any = { id, name, type: pimType }
    if (options) def.options = options
    propertyDefs.push(def)
  }

  // Fetch all pages (paginated).
  const pages: any[] = []
  let cursor: string | undefined
  do {
    const body: any = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const res = await notion(`/databases/${databaseId}/query`, { method: 'POST', body: JSON.stringify(body) })
    pages.push(...res.results)
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)

  const known = new Set(pages.map(p => p.id))
  const nodes: any[] = []
  const edgeSet = new Set<string>()
  const edges: any[] = []
  for (const pg of pages) {
    const props = pg.properties || {}
    let label = '(untitled)'
    let notes = ''
    const pimProps: Record<string, any> = {}
    for (const [name, v] of Object.entries<any>(props)) {
      const t = v.type
      const id = v.id
      const kind = propType[id]
      if (t === 'title') { label = plain(v.title) || '(untitled)'; continue }
      if (kind === '__notes__') { notes = plain(v.rich_text); continue }
      if (t === 'relation') {
        if (/parent|blocked by|blocking/i.test(name) === false && !/sub-?task/i.test(name)) { /* other relations ignored */ }
        // Parent task / Blocked by → directed edge (source depends on semantics); skip inverse sides.
        if (/parent/i.test(name) || /blocked by/i.test(name)) {
          for (const rel of v.relation || []) {
            if (!known.has(rel.id)) continue
            const key = rel.id + '>' + pg.id
            if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ id: crypto.randomUUID(), source: rel.id, target: pg.id }) }
          }
        }
        continue
      }
      if (!kind || kind === '__title__') continue
      if (t === 'select') pimProps[id] = v.select?.id ?? null
      else if (t === 'status') pimProps[id] = v.status?.id ?? null
      else if (t === 'multi_select') pimProps[id] = (v.multi_select || []).map((o: any) => o.id)
      else if (t === 'number') pimProps[id] = v.number
      else if (t === 'checkbox') pimProps[id] = v.checkbox
      else if (t === 'url') pimProps[id] = v.url
      else if (t === 'date') pimProps[id] = v.date?.start ?? null
      else if (t === 'rich_text') pimProps[id] = plain(v.rich_text)
      else if (t === 'email') pimProps[id] = v.email
      else if (t === 'phone_number') pimProps[id] = v.phone_number
    }
    nodes.push({ id: pg.id, label, notes, props: pimProps, notionUrl: pg.url })
  }

  return { name: title, notionDatabaseId: databaseId, propertyDefs, nodes, edges }
}

// ── PUSH: PIM edits → Notion pages.update ────────────────────────────────────
// changes: [{ pageId, updates: [{ propId, type, value }] }]  (type = pim type; value = optionId | optionId[] | scalar)
async function push(changes: any[]) {
  let updated = 0
  const errors: any[] = []
  for (const ch of changes || []) {
    const properties: Record<string, any> = {}
    for (const u of ch.updates || []) {
      const { propId, type, value, notionType } = u
      if (notionType === 'status') properties[propId] = { status: value ? { id: value } : null }
      else if (type === 'select') properties[propId] = { select: value ? { id: value } : null }
      else if (type === 'multiSelect') properties[propId] = { multi_select: (value || []).map((id: string) => ({ id })) }
      else if (type === 'number') properties[propId] = { number: value ?? null }
      else if (type === 'checkbox') properties[propId] = { checkbox: !!value }
      else if (type === 'url') properties[propId] = { url: value || null }
      else if (type === 'date') properties[propId] = { date: value ? { start: value } : null }
      else if (type === 'text') properties[propId] = { rich_text: value ? [{ text: { content: String(value) } }] : [] }
    }
    try { await notion(`/pages/${ch.pageId}`, { method: 'PATCH', body: JSON.stringify({ properties }) }); updated++ }
    catch (e) { errors.push({ pageId: ch.pageId, error: String((e as Error).message) }) }
  }
  return { updated, errors }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (!NOTION_TOKEN) return json({ error: 'NOTION_TOKEN secret is not set on the Edge Function.' }, 500)
  try {
    const { action, databaseId, changes } = await req.json()
    if (action === 'pull') {
      if (!databaseId) return json({ error: 'databaseId required' }, 400)
      return json(await pull(databaseId))
    }
    if (action === 'push') return json(await push(changes))
    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500)
  }
})
