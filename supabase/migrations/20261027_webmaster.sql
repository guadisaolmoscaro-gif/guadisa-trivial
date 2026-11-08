-- =====================================================================
-- WEBMASTER Y REVISION DE SALAS
-- - El game master escribe el contexto del grupo y se generan las preguntas.
-- - El webmaster (profiles.is_webmaster = true) aprueba, rechaza o quita preguntas.
-- - Al aprobar, el game master ve el enlace para WhatsApp.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Solo AÑADE columnas, tablas y funciones; sustituye room_by_token,
-- claim_slot y start_game para exigir que la sala este aprobada.
-- =====================================================================

-- 1. CAMBIOS EN TABLAS ------------------------------------------------
alter table public.profiles
  add column if not exists is_webmaster boolean not null default false;

alter table public.rooms
  add column if not exists name text check (char_length(name) between 1 and 60),
  add column if not exists review_status text not null default 'approved'
    check (review_status in ('generating', 'pending', 'approved', 'rejected', 'failed'));

-- El contexto del grupo: solo lo lee el game master que creo la sala
create table if not exists public.room_contexts (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  context text not null check (char_length(context) between 200 and 12000)
);
alter table public.room_contexts enable row level security;
create policy "room_contexts_host_select" on public.room_contexts
  for select to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_contexts.room_id and r.host_id = auth.uid()));

-- 2. GAME MASTER: CREAR SALA CON CONTEXTO -----------------------------
-- Crea la sala en estado "generating" y su paquete de preguntas (propiedad del webmaster).
create or replace function public.create_room_request(p_name text, p_length int, p_names text[], p_context text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_room public.rooms;
  v_names text[];
  v_wm uuid;
  v_pack uuid;
  v_tries int := 0;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;

  if (select count(*) from public.rooms where host_id = auth.uid()) >= 5 then
    raise exception 'Has llegado al maximo de 5 salas';
  end if;

  if char_length(trim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'El nombre de la sala debe tener entre 1 y 60 caracteres';
  end if;

  if p_length not in (15, 30, 50) then
    raise exception 'Elige partida rapida (15), media (30) o larga (50)';
  end if;

  if char_length(trim(coalesce(p_context, ''))) < 200 then
    raise exception 'Cuenta mas cosas del grupo (minimo 200 caracteres)';
  end if;
  if char_length(p_context) > 12000 then
    raise exception 'Demasiado texto (maximo 12.000 caracteres)';
  end if;

  select array_agg(n order by first_pos) into v_names
  from (
    select min(trim(x)) as n, min(o) as first_pos
    from unnest(coalesce(p_names, array[]::text[])) with ordinality as t(x, o)
    where char_length(trim(x)) between 1 and 30
    group by lower(trim(x))
  ) s;

  if v_names is null or array_length(v_names, 1) < 2 then
    raise exception 'Necesitas al menos 2 participantes';
  end if;
  if array_length(v_names, 1) > 8 then
    raise exception 'Maximo 8 participantes';
  end if;

  select id into v_wm from public.profiles where is_webmaster order by created_at limit 1;
  if v_wm is null then
    raise exception 'La web todavia no tiene webmaster configurado';
  end if;

  insert into public.packs (owner_id, title)
  values (v_wm, 'Sala: ' || trim(p_name))
  returning id into v_pack;

  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    begin
      insert into public.rooms (code, host_id, pack_id, name, seconds_per_question, total_questions, question_limit, review_status)
      values (v_code, auth.uid(), v_pack, trim(p_name), 10, p_length, p_length, 'generating')
      returning * into v_room;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 10 then
        raise exception 'No se pudo generar un codigo de sala, intentalo de nuevo';
      end if;
    end;
  end loop;

  insert into public.room_slots (room_id, name, position)
  select v_room.id, v_names[i], i from generate_subscripts(v_names, 1) as i;

  insert into public.room_contexts (room_id, context)
  values (v_room.id, trim(p_context));

  return v_room.id;
end;
$$;

-- 3. ENLACE Y ENTRADA: solo con la sala aprobada ----------------------
create or replace function public.room_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;

  select * into v_room from public.rooms where invite_token = trim(coalesce(p_token, ''));
  if not found or v_room.status = 'finished' or v_room.review_status <> 'approved' then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_room.id,
    'status', v_room.status,
    'total_questions', v_room.total_questions,
    'slots', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'taken', s.user_id is not null,
        'mine', s.user_id = auth.uid()
      ) order by s.position), '[]'::jsonb)
      from public.room_slots s where s.room_id = v_room.id
    )
  );
end;
$$;

create or replace function public.claim_slot(p_token text, p_slot_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_slot public.room_slots;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;

  select * into v_room from public.rooms where invite_token = trim(coalesce(p_token, '')) for update;
  if not found or v_room.status = 'finished' or v_room.review_status <> 'approved' then
    raise exception 'Este enlace ya no esta activo';
  end if;

  if exists (select 1 from public.room_slots where room_id = v_room.id and user_id = auth.uid()) then
    return v_room.id;
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'La partida ya ha empezado';
  end if;

  select * into v_slot from public.room_slots where id = p_slot_id and room_id = v_room.id for update;
  if not found then raise exception 'Ese nombre no esta en la lista'; end if;
  if v_slot.user_id is not null then raise exception 'Ese nombre ya lo ha elegido otra persona'; end if;

  update public.room_slots set user_id = auth.uid() where id = v_slot.id;
  insert into public.room_players (room_id, user_id, nickname)
  values (v_room.id, auth.uid(), v_slot.name);

  return v_room.id;
end;
$$;

create or replace function public.start_game(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_first int;
begin
  select * into v_room from public.rooms
  where id = p_room_id and host_id = auth.uid()
  for update;
  if not found then raise exception 'Solo el game master puede empezar la partida'; end if;
  if v_room.status <> 'lobby' then raise exception 'La partida ya ha empezado'; end if;
  if v_room.review_status <> 'approved' then raise exception 'La sala todavia no esta aprobada'; end if;

  if exists (select 1 from public.room_slots where room_id = p_room_id and user_id is null) then
    raise exception 'Faltan jugadores por entrar';
  end if;

  select min(sort_order) into v_first from public.questions where pack_id = v_room.pack_id;

  update public.rooms
    set status = 'question', current_order = v_first, questions_played = 1,
        question_started_at = clock_timestamp()
    where id = p_room_id
    returning * into v_room;

  return v_room;
end;
$$;

-- 4. WEBMASTER: REVISAR ------------------------------------------------
-- Lista de salas pendientes con sus preguntas y la respuesta correcta
create or replace function public.review_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_webmaster) then
    raise exception 'Solo el webmaster puede ver esto';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'length', r.question_limit,
      'questions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', q.id,
          'prompt', q.prompt,
          'options', q.options,
          'correct', k.correct_index
        ) order by q.sort_order), '[]'::jsonb)
        from public.questions q
        join public.question_keys k on k.question_id = q.id
        where q.pack_id = r.pack_id
      )
    ) order by r.created_at)
    from public.rooms r
    where r.review_status = 'pending'
  ), '[]'::jsonb);
end;
$$;

-- Webmaster: quitar las preguntas marcadas y aprobar (o rechazar) la sala
create or replace function public.review_decide(p_room_id uuid, p_approve boolean, p_remove uuid[])
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_left int;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_webmaster) then
    raise exception 'Solo el webmaster puede hacer esto';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.review_status <> 'pending' then
    raise exception 'Esta sala no esta pendiente de revision';
  end if;

  delete from public.questions
    where pack_id = v_room.pack_id and id = any(coalesce(p_remove, array[]::uuid[]));

  select count(*) into v_left from public.questions where pack_id = v_room.pack_id;

  if p_approve then
    if v_left < 3 then
      raise exception 'Quedan menos de 3 preguntas. Para aprobar, deja al menos 3';
    end if;
    update public.rooms
      set review_status = 'approved', total_questions = least(v_left, question_limit)
      where id = p_room_id
      returning * into v_room;
  else
    update public.rooms set review_status = 'rejected' where id = p_room_id returning * into v_room;
  end if;

  return v_room;
end;
$$;

-- 5. PERMISOS -----------------------------------------------------------
revoke all on function public.create_room_request(text, int, text[], text) from public, anon;
revoke all on function public.room_by_token(text)                          from public, anon;
revoke all on function public.claim_slot(text, uuid)                       from public, anon;
revoke all on function public.start_game(uuid)                             from public, anon;
revoke all on function public.review_list()                                from public, anon;
revoke all on function public.review_decide(uuid, boolean, uuid[])         from public, anon;

grant execute on function public.create_room_request(text, int, text[], text) to authenticated;
grant execute on function public.room_by_token(text)                          to authenticated;
grant execute on function public.claim_slot(text, uuid)                       to authenticated;
grant execute on function public.start_game(uuid)                             to authenticated;
grant execute on function public.review_list()                                to authenticated;
grant execute on function public.review_decide(uuid, boolean, uuid[])         to authenticated;
