import { supabase } from './supabase'

// Table lives in public schema as pim_projects to avoid PostgREST schema-exposure issues
const tb = () => supabase.from('pim_projects')

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

export async function saveProject(id, { nodes, edges, views, activeViewId }) {
  const { error } = await tb()
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
  const { error } = await tb().update({ name }).eq('id', id)
  if (error) throw error
}

export async function deleteProject(id) {
  const { error } = await tb().delete().eq('id', id)
  if (error) throw error
}
