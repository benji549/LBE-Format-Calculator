import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { APP_CONFIG } from './config.js';

export const supabase = createClient(
  APP_CONFIG.supabaseUrl,
  APP_CONFIG.supabasePublishableKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function sendMagicLink(email) {
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,display_name,created_at')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateProfile(displayName) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const { data, error } = await supabase
    .from('profiles')
    .update({ display_name: displayName.trim() })
    .eq('id', userData.user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listFormats() {
  const { data, error } = await supabase
    .from('formats')
    .select(`
      id,name,description,visibility,currency,format_data,owner_id,updated_by,
      version_number,created_at,updated_at,
      owner:profiles!formats_owner_id_fkey(id,email,display_name)
    `)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createFormat(format) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user.id;
  const { data, error } = await supabase
    .from('formats')
    .insert({
      name: format.name.trim() || 'Untitled format',
      description: format.description?.trim() || '',
      visibility: format.visibility || 'team',
      currency: format.currency || 'USD',
      format_data: format,
      owner_id: userId,
      updated_by: userId,
      last_change_note: 'Created format',
    })
    .select(`
      id,name,description,visibility,currency,format_data,owner_id,updated_by,
      version_number,created_at,updated_at,
      owner:profiles!formats_owner_id_fkey(id,email,display_name)
    `)
    .single();
  if (error) throw error;
  return data;
}

export async function updateFormat(record, format, changeNote) {
  const { data, error } = await supabase.rpc('update_lbe_format', {
    p_format_id: record.id,
    p_expected_version: record.version_number,
    p_name: format.name.trim() || 'Untitled format',
    p_description: format.description?.trim() || '',
    p_visibility: format.visibility || 'team',
    p_currency: format.currency || 'USD',
    p_format_data: format,
    p_change_note: changeNote?.trim() || 'Updated assumptions',
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function deleteFormat(formatId) {
  const { error } = await supabase.from('formats').delete().eq('id', formatId);
  if (error) throw error;
}

export async function listVersions(formatId) {
  const { data, error } = await supabase
    .from('format_versions')
    .select(`
      id,format_id,version_number,name,description,visibility,currency,format_data,
      change_note,created_at,created_by,
      author:profiles!format_versions_created_by_fkey(id,email,display_name)
    `)
    .eq('format_id', formatId)
    .order('version_number', { ascending: false });
  if (error) throw error;
  return data || [];
}

export function subscribeToFormats(onChange) {
  return supabase
    .channel('team-formats')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'formats' },
      () => onChange(),
    )
    .subscribe();
}
