import { supabase } from './supabase'
import useGraphStore from './graphStore'

// Table lives in public schema as pim_projects to avoid PostgREST schema-exposure issues
const tb = () => supabase.from('pim_projects')
const BUCKET = 'pim-models'

// Strip base64 blobs from nodes before saving — keep storage URLs (start with https://)
// A blob: URL only lives in the browser session that created it — persisting one guarantees a dead/corrupt
// reference on the next load or another device. Uploads swap the blob for a hosted URL asynchronously; this
// is the last line of defence so an in-flight (or failed) upload can never write a blob into the project.
const isBlobUrl = s => typeof s === 'string' && s.startsWith('blob:')

function sanitizeNodes(nodes) {
  return (nodes || []).map(n => {
    const out = { ...n }
    if (out.modelData && !out.modelData.startsWith('https://')) delete out.modelData
    if (out.modelThumb && !out.modelThumb.startsWith('https://')) delete out.modelThumb
    // Drop slideshow clips still pointing at a blob URL (their hosted upload hasn't landed / failed).
    if (out.ytss?.clips?.some(c => isBlobUrl(c.src))) out.ytss = { ...out.ytss, clips: out.ytss.clips.filter(c => !isBlobUrl(c.src)) }
    if (isBlobUrl(out.media?.src)) { const m = { ...out.media }; delete m.src; out.media = m }
    return out
  })
}

// Same defence for free images / videos on each view (view.images[].src).
function sanitizeViews(views) {
  return (views || []).map(v => (v?.images?.some(im => isBlobUrl(im.src))) ? { ...v, images: v.images.filter(im => !isBlobUrl(im.src)) } : v)
}

export async function listProjects() {
  const { data, error } = await tb()
    .select('id, name, updated_at')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createProject(name = 'Untitled') {
  const { data: { user } } = await supabase.auth.getUser()
  const { data, error } = await tb()
    .insert({ user_id: user.id, name })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function loadProject(id) {
  const { data, error } = await tb()
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

// Save the project — CONDITIONAL on the row still being at the version we loaded, so a stale tab on
// another device can't silently clobber newer work (this is the save-conflict guard for EVERY save
// surface). By default the expected version is the store's loaded baseline; pass `expectedUpdatedAt`
// to override, or `null` to force an unconditional overwrite (used by the "Keep mine" escape hatch).
// On conflict the store's saveConflict flag is raised centrally (so the app banner appears no matter
// which surface triggered it) and nothing is written. On success the baseline advances. Returns
// { conflict, updatedAt }.
export async function saveProject(id, { nodes, edges, views, activeViewId, propertyDefs, styles }, expectedUpdatedAt) {
  let store = null; try { store = useGraphStore.getState() } catch { /* not ready */ }
  const sameProject = !!store && store.loadedProjectId === id
  // undefined → default to the loaded baseline (guarded); null → force unconditional; a value → use it.
  const expected = expectedUpdatedAt === undefined ? (sameProject ? store.loadedUpdatedAt : null) : expectedUpdatedAt
  const nextUpdatedAt = new Date().toISOString()
  const patch = {
    nodes: sanitizeNodes(nodes),
    edges,
    views: sanitizeViews(views),
    active_view_id: activeViewId,
    updated_at: nextUpdatedAt,
  }
  if (propertyDefs !== undefined) patch.property_defs = propertyDefs
  if (styles !== undefined) patch.styles = styles
  let q = tb().update(patch).eq('id', id)
  if (expected) q = q.eq('updated_at', expected)
  const { data, error } = await q.select('id, updated_at')
  if (error) throw error
  if (expected && (!data || data.length === 0)) {
    if (sameProject) { try { store.setSaveConflict(true) } catch { /* */ } }
    return { conflict: true }
  }
  if (sameProject) { try { store.setLoadedUpdatedAt(nextUpdatedAt) } catch { /* */ } }
  return { conflict: false, updatedAt: nextUpdatedAt }
}

// Strategy tab: { text, positions, pinned } stored in the jsonb `strategy` column
export async function loadStrategy(id) {
  const { data, error } = await tb().select('strategy').eq('id', id).single()
  if (error) throw error
  return data?.strategy ?? null
}

export async function saveStrategy(id, strategy) {
  const { error } = await tb()
    .update({ strategy, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// Deep-copy a project into a brand-new row (name + " (copy)"). Storage-hosted images/models are shared by
// public URL, so the copy is independent of the original for all editable content.
export async function duplicateProject(id) {
  const src = await loadProject(id)
  const { data: { user } } = await supabase.auth.getUser()
  const { data, error } = await tb().insert({
    user_id: user.id,
    name: `${src.name || 'Untitled'} (copy)`,
    nodes: src.nodes || [],
    edges: src.edges || [],
    views: src.views || [],
    active_view_id: src.active_view_id,
    property_defs: src.property_defs || [],
    styles: src.styles || [],
    strategy: src.strategy ?? null,
  }).select().single()
  if (error) throw error
  return data
}

export async function renameProject(id, name) {
  const { error } = await tb().update({ name }).eq('id', id)
  if (error) throw error
}

export async function deleteProject(id) {
  const { error } = await tb().delete().eq('id', id)
  if (error) throw error
}

// ── Sharing ──────────────────────────────────────────────────────────────────
// Owner creates a share link. role: 'viewer' | 'editor'. expiresAt: ISO string | null.
export async function createShareLink(projectId, role = 'viewer', expiresAt = null) {
  const { data, error } = await supabase
    .from('pim_share_links')
    .insert({ project_id: projectId, role, expires_at: expiresAt })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listShareLinks(projectId) {
  const { data, error } = await supabase
    .from('pim_share_links')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function revokeShareLink(token) {
  const { error } = await supabase.from('pim_share_links').update({ revoked: true }).eq('token', token)
  if (error) throw error
}

// Public: load a shared project by token (works without login for viewer/editor links).
export async function getSharedProject(token) {
  const { data, error } = await supabase.rpc('pim_get_shared_project', { p_token: token })
  if (error) throw error
  return data // { id, name, nodes, edges, views, active_view_id, role } | null
}

// Signed-in: redeem a link → become a member so the project opens with normal RLS.
export async function redeemShareLink(token) {
  const { data, error } = await supabase.rpc('pim_redeem_share_link', { p_token: token })
  if (error) throw error
  return data // { id, name, role } | null
}

// ── Notion import / sync (via the notion-sync Edge Function) ───────────────────
// Pull a Notion database → { name, notionDatabaseId, propertyDefs, nodes, edges }.
export async function pullNotion(databaseId) {
  const { data, error } = await supabase.functions.invoke('notion-sync', { body: { action: 'pull', databaseId } })
  if (error) throw new Error(error.message || 'notion-sync failed')
  if (data?.error) throw new Error(data.error)
  return data
}

// Push PIM edits back to Notion. changes: [{ pageId, updates: [{ propId, type, notionType, value }] }]
export async function pushNotion(changes) {
  const { data, error } = await supabase.functions.invoke('notion-sync', { body: { action: 'push', changes } })
  if (error) throw new Error(error.message || 'notion-sync failed')
  if (data?.error) throw new Error(data.error)
  return data
}

// Import a Notion database as a brand-new PIM project; returns the created row { id, name, … }.
export async function importNotionDatabase(databaseId) {
  const proj = await pullNotion(databaseId)
  const { data: { user } } = await supabase.auth.getUser()
  const viewId = crypto.randomUUID()
  // Stash the source database id on the view so the app knows this project is Notion-linked (→ Save button).
  const views = [{ id: viewId, name: 'Main', nodeProps: {}, drillRoot: null, bgColor: '#0c0c1a', images: [], slides: [], notionDatabaseId: proj.notionDatabaseId }]
  const { data, error } = await tb().insert({
    user_id: user.id,
    name: proj.name || 'Notion import',
    nodes: sanitizeNodes(proj.nodes || []),
    edges: proj.edges || [],
    views,
    active_view_id: viewId,
    property_defs: proj.propertyDefs || [],
  }).select().single()
  if (error) throw error
  return { row: data, count: (proj.nodes || []).length }
}

// Push the current tag/field values of every Notion-linked node back to Notion.
export async function saveProjectToNotion(nodes, propertyDefs) {
  const changes = (nodes || [])
    .filter(n => n.props && Object.keys(n.props).length)
    .map(n => ({
      pageId: n.id,
      updates: (propertyDefs || [])
        .filter(d => d.notionType && n.props[d.id] !== undefined)
        .map(d => ({ propId: d.id, type: d.type, notionType: d.notionType, value: n.props[d.id] })),
    }))
    .filter(c => c.updates.length)
  return pushNotion(changes) // { updated, errors }
}

// Upload a base64 data-URL image to Storage; returns a public URL (or the original on failure).
// Photos were being embedded as base64 in view.images[].src, bloating the project row to MBs — which
// made loads crawl and oversized saves fail silently. Offloading keeps the row tiny.
// Upload a File/Blob (e.g. a video) directly to Storage and return its public URL. Avoids ever
// base64-encoding a large file into app state. Returns null on failure (caller keeps the local URL).
export async function uploadMediaFile(file, projectId) {
  if (!file) return null
  try {
    const ext = ((file.type.split('/')[1] || 'bin').split('+')[0]).slice(0, 5)
    const path = `${projectId}/vid-${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type || 'video/mp4' })
    if (error) throw error
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return data.publicUrl
  } catch (e) { console.warn('Video upload failed:', e?.message || e); return null }
}

// Fetch a link preview (Open Graph / Twitter Card) via the `unfurl` edge function. The browser can't
// fetch cross-origin pages (CORS), so this runs server-side. Returns { url, title, description, image,
// siteName, favicon } or null on failure (caller keeps the raw URL as the title).
export async function unfurlLink(url) {
  try {
    const { data, error } = await supabase.functions.invoke('unfurl', { body: { url } })
    if (error) throw error
    if (!data || data.error) return null
    return data
  } catch (e) { console.warn('unfurl failed:', e?.message || e); return null }
}

// One turn of the AI assistant: forward messages+tools+system to the `assistant` edge function
// (which holds the Anthropic key) and return Claude's raw response. The browser drives the loop.
export async function callAssistant({ messages, tools, system }) {
  const { data, error } = await supabase.functions.invoke('assistant', { body: { messages, tools, system } })
  if (error) throw new Error(error.message || 'assistant call failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export async function uploadImageDataUrl(dataUrl, projectId) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return dataUrl
  try {
    const res = await fetch(dataUrl); const blob = await res.blob()
    const ext = ((blob.type.split('/')[1] || 'png').split('+')[0]).slice(0, 5)
    const path = `${projectId}/img-${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: blob.type || 'image/png' })
    if (error) throw error
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return data.publicUrl
  } catch (e) { console.warn('Image offload failed, keeping inline:', e?.message || e); return dataUrl }
}

// Rehost a REMOTE image URL (e.g. a Google Slides/Docs image pasted as HTML, whose src is a
// googleusercontent link) into Storage, so the pasted image survives the source URL expiring. Falls
// back to the original URL if the cross-origin fetch is blocked or the upload fails — the browser can
// usually still render the source URL directly in the meantime.
export async function uploadImageFromUrl(url, projectId) {
  if (!url || typeof url !== 'string' || !/^https?:/i.test(url)) return url
  try {
    const res = await fetch(url, { mode: 'cors' }); if (!res.ok) throw new Error('fetch ' + res.status)
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) throw new Error('not an image: ' + blob.type)
    const ext = ((blob.type.split('/')[1] || 'png').split('+')[0]).slice(0, 5)
    const path = `${projectId}/img-${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: blob.type })
    if (error) throw error
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return data.publicUrl
  } catch (e) { console.warn('Remote image rehost failed, keeping source URL:', e?.message || e); return url }
}

// Offload every embedded base64 image in a project's views to Storage. Returns { views, changed }.
export async function compactProjectViews(projectId, views) {
  let changed = 0
  const out = await Promise.all((views || []).map(async v => {
    if (!v?.images?.length) return v
    const images = await Promise.all(v.images.map(async img => {
      if (img?.src && typeof img.src === 'string' && img.src.startsWith('data:')) {
        const url = await uploadImageDataUrl(img.src, projectId)
        if (url && url !== img.src) { changed++; return { ...img, src: url } }
      }
      return img
    }))
    return { ...v, images }
  }))
  return { views: out, changed }
}

// Upload a 3D model file to Supabase Storage; returns { url, type }
export async function uploadModel(file, projectId, nodeId) {
  const ext = file.name.split('.').pop().toLowerCase()
  const path = `${projectId}/${nodeId}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true })
  if (error) throw error
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, type: ext }
}

// Upload a JPEG data URL as a thumbnail; returns storage URL or null on failure
export async function uploadThumbnail(dataUrl, projectId, nodeId) {
  try {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const path = `${projectId}/${nodeId}.thumb.png`
    const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'image/png' })
    if (error) throw error
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return data.publicUrl
  } catch (e) {
    console.warn('Thumbnail upload failed:', e)
    return null
  }
}
