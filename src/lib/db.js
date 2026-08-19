import { supabase } from './supabase'

// Table lives in public schema as pim_projects to avoid PostgREST schema-exposure issues
const tb = () => supabase.from('pim_projects')
const BUCKET = 'pim-models'

// Strip base64 blobs from nodes before saving — keep storage URLs (start with https://)
function sanitizeNodes(nodes) {
  return nodes.map(n => {
    const out = { ...n }
    if (out.modelData && !out.modelData.startsWith('https://')) delete out.modelData
    if (out.modelThumb && !out.modelThumb.startsWith('https://')) delete out.modelThumb
    return out
  })
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

export async function saveProject(id, { nodes, edges, views, activeViewId, propertyDefs, styles }) {
  const patch = {
    nodes: sanitizeNodes(nodes),
    edges,
    views,
    active_view_id: activeViewId,
    updated_at: new Date().toISOString(),
  }
  if (propertyDefs !== undefined) patch.property_defs = propertyDefs
  if (styles !== undefined) patch.styles = styles
  const { error } = await tb().update(patch).eq('id', id)
  if (error) throw error
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
