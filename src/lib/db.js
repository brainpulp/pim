import { supabase } from './supabase'

export async function listProjects() {
  const { data, error } = await supabase
    .schema('pim')
    .from('projects')
    .select('id, name, updated_at')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createProject(name = 'Untitled') {
  const { data: { user } } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .schema('pim')
    .from('projects')
    .insert({ user_id: user.id, name })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function loadProject(id) {
  const { data, error } = await supabase
    .schema('pim')
    .from('projects')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

export async function saveProject(id, { nodes, edges, views, activeViewId }) {
  const { error } = await supabase
    .schema('pim')
    .from('projects')
    .update({
      nodes,
      edges,
      views,
      active_view_id: activeViewId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw error
}

export async function renameProject(id, name) {
  const { error } = await supabase
    .schema('pim')
    .from('projects')
    .update({ name })
    .eq('id', id)
  if (error) throw error
}

export async function deleteProject(id) {
  const { error } = await supabase
    .schema('pim')
    .from('projects')
    .delete()
    .eq('id', id)
  if (error) throw error
}
