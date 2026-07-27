-- Convert an existing LBE Team Calculator database into a communal workspace.
-- Run this file once in Supabase Dashboard > SQL Editor.
--
-- Result:
--   * Every authenticated user can view, edit, version, and delete every format.
--   * All existing and future formats are treated as communal/team-visible.
--   * Deleting an Auth user no longer deletes formats they originally created.

begin;

-- Preserve formats and version history when a test user is deleted.
alter table public.formats alter column owner_id drop not null;
alter table public.formats alter column updated_by drop not null;
alter table public.format_versions alter column created_by drop not null;

alter table public.formats drop constraint if exists formats_owner_id_fkey;
alter table public.formats drop constraint if exists formats_updated_by_fkey;
alter table public.format_versions drop constraint if exists format_versions_created_by_fkey;

alter table public.formats
  add constraint formats_owner_id_fkey
  foreign key (owner_id) references public.profiles(id) on delete set null;

alter table public.formats
  add constraint formats_updated_by_fkey
  foreign key (updated_by) references public.profiles(id) on delete set null;

alter table public.format_versions
  add constraint format_versions_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- Retire private formats. Keep the column for compatibility with the frontend.
update public.formats
set
  visibility = 'team',
  format_data = jsonb_set(coalesce(format_data, '{}'::jsonb), '{visibility}', '"team"'::jsonb, true)
where visibility <> 'team'
   or coalesce(format_data ->> 'visibility', '') <> 'team';

-- Keep atomic version-conflict protection, but allow any authenticated teammate
-- to update any format.
create or replace function public.update_lbe_format(
  p_format_id uuid,
  p_expected_version integer,
  p_name text,
  p_description text,
  p_visibility text,
  p_currency text,
  p_format_data jsonb,
  p_change_note text
)
returns public.formats
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.formats%rowtype;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select *
  into v_current
  from public.formats
  where id = p_format_id
  for update;

  if not found then
    raise exception 'FORMAT_NOT_FOUND';
  end if;

  if v_current.version_number <> p_expected_version then
    raise exception 'VERSION_CONFLICT|current=%', v_current.version_number;
  end if;

  if p_currency not in ('USD', 'CAD', 'EUR', 'GBP', 'AUD') then
    raise exception 'INVALID_CURRENCY';
  end if;

  update public.formats
  set
    name = left(coalesce(nullif(trim(p_name), ''), 'Untitled format'), 160),
    description = coalesce(p_description, ''),
    visibility = 'team',
    currency = p_currency,
    format_data = jsonb_set(coalesce(p_format_data, '{}'::jsonb), '{visibility}', '"team"'::jsonb, true),
    version_number = version_number + 1,
    last_change_note = left(coalesce(nullif(trim(p_change_note), ''), 'Updated assumptions'), 240),
    updated_by = auth.uid()
  where id = p_format_id
  returning * into v_current;

  return v_current;
end;
$$;

-- Replace owner-based policies with communal authenticated-user policies.
drop policy if exists "Users can view visible formats" on public.formats;
drop policy if exists "Users can create their own formats" on public.formats;
drop policy if exists "Owners can delete their formats" on public.formats;
drop policy if exists "Users can view versions of visible formats" on public.format_versions;
drop policy if exists "Authenticated users can view all formats" on public.formats;
drop policy if exists "Authenticated users can create formats" on public.formats;
drop policy if exists "Authenticated users can delete all formats" on public.formats;
drop policy if exists "Authenticated users can view all format versions" on public.format_versions;

create policy "Authenticated users can view all formats"
on public.formats
for select
to authenticated
using ((select auth.uid()) is not null);

create policy "Authenticated users can create formats"
on public.formats
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and (select auth.uid()) = updated_by
  and visibility = 'team'
);

create policy "Authenticated users can delete all formats"
on public.formats
for delete
to authenticated
using ((select auth.uid()) is not null);

create policy "Authenticated users can view all format versions"
on public.format_versions
for select
to authenticated
using ((select auth.uid()) is not null);

-- Direct UPDATE stays disabled. All edits go through update_lbe_format() so
-- concurrent edits still receive version-conflict protection.
revoke all on function public.update_lbe_format(uuid, integer, text, text, text, text, jsonb, text) from public;
grant execute on function public.update_lbe_format(uuid, integer, text, text, text, text, jsonb, text) to authenticated;

grant select, insert, delete on public.formats to authenticated;
grant select on public.format_versions to authenticated;

commit;
