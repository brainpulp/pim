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

export async function saveProject(id, { nodes, edges, views, activeViewId, propertyDefs }) {
  const patch = {
    nodes: sanitizeNodes(nodes),
    edges,
    views,
    active_view_id: activeViewId,
    updated_at: new Date().toISOString(),
  }
  if (propertyDefs !== undefined) patch.property_defs = propertyDefs
  const { error } = await tb().update(patch).eq('id', id)
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
