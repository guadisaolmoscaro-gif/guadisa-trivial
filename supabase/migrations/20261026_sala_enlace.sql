-- =====================================================================
-- SALAS POR ENLACE (v2)
-- - El game master pone los nombres y recibe un enlace (sin email).
-- - Los jugadores entran con ese enlace (sesion anonima) y eligen su nombre.
-- - 10 segundos por pregunta. Puntos por orden de acierto. Sin "no lo sé".
-- - Ganador: mas puntos; en empate, menos tiempo total en aciertos.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Requisito: en Authentication > Sign In / Providers, activar "Anonymous sign-ins".
-- Solo AÑADE tablas y funciones nuevas. Sustituye submit_answer (misma firma).
-- =====================================================================

-- 1. CAMBIOS EN LA TABLA DE SALAS -------------------------------------
alter table public.rooms
  add column if not exists invite_token text unique
    default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  add column if not exists question_limit int not null default 15,
  add column if not exists questions_played int not null default 0,
  add column if not exists reveal_at timestamptz;

alter table public.rooms alter column seconds_per_question set default 10;

-- 2. PARTICIPANTES DE LA SALA (los nombres que pone el game master) ---
create table if not exists public.room_slots (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  position int not null,
  user_id uuid references public.profiles(id) on delete set null
);
create unique index if not exists room_slots_name_idx on public.room_slots (room_id, lower(name));
create unique index if not exists room_slots_position_idx on public.room_slots (room_id, position);
create unique index if not exists room_slots_user_idx on public.room_slots (room_id, user_id) where user_id is not null;

alter table public.room_slots enable row level security;
create policy "room_slots_members_select" on public.room_slots
  for select to authenticated using (public.is_room_member(room_id));

alter publication supabase_realtime add table public.room_slots;

-- 3. FUNCIONES -----------------------------------------------------------

-- Game master: crear la sala con su enlace, la duracion y los nombres
create or replace function public.create_room_v2(p_pack_id uuid, p_length int, p_names text[])
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_room public.rooms;
  v_total int;
  v_names text[];
  v_tries int := 0;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;

  if not exists (select 1 from public.packs where id = p_pack_id and owner_id = auth.uid()) then
    raise exception 'Ese paquete no existe o no es tuyo';
  end if;

  if p_length not in (15, 30, 50) then
    raise exception 'Elige partida rapida (15), media (30) o larga (50)';
  end if;

  select count(*) into v_total from public.questions where pack_id = p_pack_id;
  if v_total = 0 then raise exception 'El paquete no tiene preguntas'; end if;

  -- nombres sin repetir (sin distinguir mayusculas), en el orden en que se escribieron
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

  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    begin
      insert into public.rooms (code, host_id, pack_id, seconds_per_question, total_questions, question_limit)
      values (v_code, auth.uid(), p_pack_id, 10, least(v_total, p_length), p_length)
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

  return v_room;
end;
$$;

-- Con el enlace: datos de la sala y lista de nombres (null si el enlace ya no vale)
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
  if not found or v_room.status = 'finished' then return null; end if;

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

-- Jugador: elegir su nombre de la lista (o recuperar su plaza si ya la tenia)
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
  if not found or v_room.status = 'finished' then
    raise exception 'Este enlace ya no esta activo';
  end if;

  -- ya tiene plaza en esta sala: solo le devolvemos la sala
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

-- Game master: empezar cuando han entrado todos
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

-- Jugador: responder (el tiempo lo mide el servidor). Los puntos se calculan al cerrar.
create or replace function public.submit_answer(p_room_id uuid, p_chosen int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_q public.questions;
  v_key int;
  v_total_ms int;
  v_elapsed_ms int;
  v_correct boolean;
begin
  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = auth.uid()
  ) then
    raise exception 'No estas en esta sala';
  end if;

  -- "for share" hace que el cierre de la pregunta espere a las respuestas en curso
  select * into v_room from public.rooms where id = p_room_id for share;
  if v_room.status <> 'question' then
    raise exception 'No hay ninguna pregunta abierta';
  end if;

  select * into v_q
  from public.questions
  where pack_id = v_room.pack_id and sort_order = v_room.current_order;
  if v_q.id is null then
    raise exception 'No se encontro la pregunta actual';
  end if;

  if p_chosen is null or p_chosen < 0 or p_chosen >= jsonb_array_length(v_q.options) then
    raise exception 'Opcion no valida';
  end if;

  v_total_ms := v_room.seconds_per_question * 1000;
  v_elapsed_ms := floor(extract(epoch from (clock_timestamp() - v_room.question_started_at)) * 1000)::int;

  -- 1,5 s de margen por la latencia de la red
  if v_elapsed_ms > v_total_ms + 1500 then
    raise exception 'Tiempo agotado';
  end if;
  v_elapsed_ms := least(greatest(v_elapsed_ms, 0), v_total_ms);

  select correct_index into v_key from public.question_keys where question_id = v_q.id;
  v_correct := (p_chosen = v_key);

  insert into public.answers (room_id, user_id, question_id, chosen_index, response_ms, is_correct, points)
  values (p_room_id, auth.uid(), v_q.id, p_chosen, v_elapsed_ms, v_correct, 0)
  on conflict do nothing;

  if not found then
    raise exception 'Ya has respondido a esta pregunta';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Cualquier jugador de la sala: cerrar la pregunta cuando han contestado todos
-- o se ha agotado el tiempo. Puntos: el 1.º que acierta recibe 1000 y los demas
-- bajan proporcionalmente segun el numero de jugadores. Si ya esta cerrada, no hace nada.
create or replace function public.close_question(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_q uuid;
  v_players int;
  v_answered int;
begin
  if not public.is_room_member(p_room_id) then
    raise exception 'No perteneces a esta sala';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if v_room.status <> 'question' then
    return v_room;
  end if;

  select count(*) into v_players from public.room_slots
    where room_id = p_room_id and user_id is not null;
  select q.id into v_q from public.questions q
    where q.pack_id = v_room.pack_id and q.sort_order = v_room.current_order;
  select count(*) into v_answered from public.answers
    where room_id = p_room_id and question_id = v_q;

  if v_answered < v_players
     and clock_timestamp() <= v_room.question_started_at + make_interval(secs => v_room.seconds_per_question + 1) then
    return v_room; -- todavia no toca cerrar
  end if;

  with ranked as (
    select user_id, row_number() over (order by response_ms, answered_at) as pos
    from public.answers
    where room_id = p_room_id and question_id = v_q and is_correct
  )
  update public.answers a
    set points = round(1000 * (v_players - r.pos + 1)::numeric / v_players)::int
    from ranked r
    where a.room_id = p_room_id and a.question_id = v_q and a.user_id = r.user_id;

  update public.room_players p
    set score = p.score + a.points
    from public.answers a
    where a.room_id = p_room_id and a.question_id = v_q
      and p.room_id = p_room_id and p.user_id = a.user_id;

  update public.rooms set status = 'reveal', reveal_at = clock_timestamp()
    where id = p_room_id
    returning * into v_room;

  return v_room;
end;
$$;

-- Cualquier jugador: pasar a la siguiente pregunta 5 s despues de mostrar los resultados
-- (o terminar la partida). Si todavia no toca, no hace nada.
create or replace function public.advance_room(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_next int;
begin
  if not public.is_room_member(p_room_id) then
    raise exception 'No perteneces a esta sala';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if v_room.status <> 'reveal' then return v_room; end if;
  if clock_timestamp() < v_room.reveal_at + interval '5 seconds' then return v_room; end if;

  select min(sort_order) into v_next
  from public.questions
  where pack_id = v_room.pack_id and sort_order > v_room.current_order;

  if v_room.questions_played >= v_room.total_questions or v_next is null then
    update public.rooms set status = 'finished', question_started_at = null
      where id = p_room_id
      returning * into v_room;
  else
    update public.rooms
      set status = 'question', current_order = v_next,
          questions_played = questions_played + 1,
          question_started_at = clock_timestamp()
      where id = p_room_id
      returning * into v_room;
  end if;

  return v_room;
end;
$$;

-- 4. PERMISOS DE EJECUCION ---------------------------------------------
revoke all on function public.create_room_v2(uuid, int, text[]) from public, anon;
revoke all on function public.room_by_token(text)               from public, anon;
revoke all on function public.claim_slot(text, uuid)            from public, anon;
revoke all on function public.start_game(uuid)                  from public, anon;
revoke all on function public.close_question(uuid)              from public, anon;
revoke all on function public.advance_room(uuid)                from public, anon;

grant execute on function public.create_room_v2(uuid, int, text[]) to authenticated;
grant execute on function public.room_by_token(text)               to authenticated;
grant execute on function public.claim_slot(text, uuid)            to authenticated;
grant execute on function public.start_game(uuid)                  to authenticated;
grant execute on function public.close_question(uuid)              to authenticated;
grant execute on function public.advance_room(uuid)                to authenticated;
