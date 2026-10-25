-- =====================================================================
-- QUEDADAS SORPRESA - Los amigos aportan datos por un enlace (sin registro)
-- Solo AÑADE tablas y funciones nuevas; no toca las existentes.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run
-- =====================================================================

-- 1. TABLAS ------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  event_date date,
  invite_token text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  created_at timestamptz not null default now()
);

create table public.event_members (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  submitted_at timestamptz
);
create unique index event_members_name_idx on public.event_members (event_id, lower(name));

create table public.facts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  subject_member_id uuid not null references public.event_members(id) on delete cascade, -- de quién trata
  author_member_id uuid not null references public.event_members(id) on delete cascade,  -- quién lo escribió
  prompt_key text not null check (prompt_key in ('apodo','mania','plan','cancion','anecdota','secreto','otro')),
  text text not null check (char_length(text) between 1 and 160),
  created_at timestamptz not null default now()
);
create index facts_event_idx on public.facts (event_id);

-- 2. SEGURIDAD (RLS) ---------------------------------------------------
-- Los amigos NO acceden a las tablas: solo usan las funciones de más abajo.
alter table public.events        enable row level security;
alter table public.event_members enable row level security;
alter table public.facts         enable row level security;

create policy "events_owner_all" on public.events
  for all to authenticated
  using (host_id = auth.uid()) with check (host_id = auth.uid());

create policy "event_members_owner_select" on public.event_members
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_members.event_id and e.host_id = auth.uid()));

create policy "facts_owner_select" on public.facts
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = facts.event_id and e.host_id = auth.uid()));

-- 3. FUNCIONES ---------------------------------------------------------

-- Anfitrión: crear la quedada con la lista de amigos (de 4 a 12)
create or replace function public.create_event(p_title text, p_date date, p_names text[])
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.events;
  v_names text[];
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 80 then
    raise exception 'El titulo debe tener entre 1 y 80 caracteres';
  end if;

  select array_agg(n order by first_pos) into v_names
  from (
    select min(trim(x)) as n, min(o) as first_pos
    from unnest(coalesce(p_names, array[]::text[])) with ordinality as t(x, o)
    where char_length(trim(x)) between 1 and 30
    group by lower(trim(x))
  ) s;

  if v_names is null or array_length(v_names, 1) < 4 then
    raise exception 'Necesitas al menos 4 nombres distintos';
  end if;
  if array_length(v_names, 1) > 12 then
    raise exception 'Maximo 12 personas';
  end if;

  insert into public.events (host_id, title, event_date)
  values (auth.uid(), trim(p_title), p_date)
  returning * into v_event;

  insert into public.event_members (event_id, name)
  select v_event.id, unnest(v_names);

  return v_event;
end;
$$;

-- Público (con el enlace): ver el titulo y la lista de amigos
create or replace function public.get_invite(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_event public.events;
begin
  select * into v_event from public.events where invite_token = trim(coalesce(p_token, ''));
  if not found then return null; end if;

  return jsonb_build_object(
    'title', v_event.title,
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'done', m.submitted_at is not null) order by m.name), '[]'::jsonb)
      from public.event_members m where m.event_id = v_event.id
    )
  );
end;
$$;

-- Público (con el enlace): enviar las respuestas de un amigo (una sola vez)
-- p_facts = [{"subject": "<uuid o null si es sobre uno mismo>", "key": "mania", "text": "..."}]
create or replace function public.submit_facts(p_token text, p_member_id uuid, p_facts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.events;
  v_member public.event_members;
  v_item jsonb;
  v_key text;
  v_text text;
  v_subject uuid;
  v_rows jsonb := '[]'::jsonb;
  v_count int := 0;
  v_self_keys constant text[] := array['apodo','mania','plan','cancion','anecdota','secreto'];
begin
  select * into v_event from public.events where invite_token = trim(coalesce(p_token, ''));
  if not found then raise exception 'Enlace no valido'; end if;

  -- "for update" evita que dos envios simultaneos de la misma persona pasen a la vez
  select * into v_member from public.event_members
   where id = p_member_id and event_id = v_event.id for update;
  if not found then raise exception 'Esa persona no esta en la lista'; end if;
  if v_member.submitted_at is not null then
    raise exception 'Ya has enviado tus respuestas';
  end if;

  if p_facts is null or jsonb_typeof(p_facts) <> 'array' then
    raise exception 'Respuestas no validas';
  end if;
  if jsonb_array_length(p_facts) > 12 then
    raise exception 'Demasiadas respuestas';
  end if;

  for v_item in select * from jsonb_array_elements(p_facts) loop
    v_key := v_item->>'key';
    v_text := trim(coalesce(v_item->>'text', ''));
    if v_text = '' then continue; end if;
    if char_length(v_text) > 160 then raise exception 'Una respuesta es demasiado larga (maximo 160 caracteres)'; end if;

    if v_key = any (v_self_keys) then
      v_subject := v_member.id;
    elsif v_key = 'otro' then
      begin
        v_subject := (v_item->>'subject')::uuid;
      exception when others then
        raise exception 'Persona no valida';
      end;
      if v_subject = v_member.id
         or not exists (select 1 from public.event_members where id = v_subject and event_id = v_event.id) then
        raise exception 'Elige a otra persona de la lista';
      end if;
    else
      raise exception 'Tipo de respuesta no valido';
    end if;

    insert into public.facts (event_id, subject_member_id, author_member_id, prompt_key, text)
    values (v_event.id, v_subject, v_member.id, v_key, v_text);
    v_count := v_count + 1;
  end loop;

  if v_count < 2 then
    raise exception 'Contesta al menos 2 cosas';
  end if;

  update public.event_members set submitted_at = now() where id = v_member.id;
  return jsonb_build_object('ok', true, 'saved', v_count);
end;
$$;

-- Anfitrión: dejar que un amigo vuelva a responder (borra lo que envio)
create or replace function public.reset_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
begin
  select m.event_id into v_event_id
  from public.event_members m
  join public.events e on e.id = m.event_id
  where m.id = p_member_id and e.host_id = auth.uid();
  if v_event_id is null then raise exception 'No tienes permiso'; end if;

  delete from public.facts where author_member_id = p_member_id;
  update public.event_members set submitted_at = null where id = p_member_id;
end;
$$;

-- 4. PERMISOS DE EJECUCION ---------------------------------------------
revoke all on function public.create_event(text, date, text[]) from public, anon;
revoke all on function public.get_invite(text)                  from public;
revoke all on function public.submit_facts(text, uuid, jsonb)   from public;
revoke all on function public.reset_member(uuid)                from public, anon;

grant execute on function public.create_event(text, date, text[]) to authenticated;
grant execute on function public.reset_member(uuid)               to authenticated;
grant execute on function public.get_invite(text)                 to anon, authenticated;
grant execute on function public.submit_facts(text, uuid, jsonb)  to anon, authenticated;
