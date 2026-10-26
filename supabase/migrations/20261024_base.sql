-- =====================================================================
-- TRIVIAL DE AMIGOS - Esquema de base de datos (Supabase / Postgres)
-- Ejecutar UNA sola vez en: Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PERFILES (uno por usuario registrado)
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  created_at timestamptz not null default now()
);

-- Al registrarse alguien, se crea su perfil automaticamente
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
        nullif(split_part(new.email, '@', 1), ''),
        'Jugador'
      ),
      24
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 2. PAQUETES Y PREGUNTAS (lo que crea el anfitrion)
-- ---------------------------------------------------------------------
create table public.packs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  description text check (char_length(description) <= 300),
  created_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.packs(id) on delete cascade,
  sort_order int not null check (sort_order >= 0),
  kind text not null check (kind in ('multiple', 'truefalse')),
  prompt text not null check (char_length(prompt) between 1 and 300),
  image_path text,                 -- ruta de la foto en Storage (opcional)
  options jsonb not null,          -- lista de textos: 4 (test) o 2 (verdadero/falso)
  created_at timestamptz not null default now(),
  unique (pack_id, sort_order),
  check (
    jsonb_typeof(options) = 'array'
    and (
      (kind = 'multiple'  and jsonb_array_length(options) = 4) or
      (kind = 'truefalse' and jsonb_array_length(options) = 2)
    )
  )
);

-- La respuesta correcta va en una tabla aparte para que los jugadores
-- NUNCA puedan leerla antes de tiempo.
create table public.question_keys (
  question_id uuid primary key references public.questions(id) on delete cascade,
  correct_index int not null check (correct_index >= 0)
);

-- ---------------------------------------------------------------------
-- 3. SALAS, JUGADORES Y RESPUESTAS
-- ---------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  pack_id uuid not null references public.packs(id) on delete cascade,
  seconds_per_question int not null default 20 check (seconds_per_question between 5 and 120),
  total_questions int not null default 0,
  status text not null default 'lobby' check (status in ('lobby', 'question', 'reveal', 'finished')),
  current_order int not null default -1,
  question_started_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.room_players (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 20),
  score int not null default 0,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.answers (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  chosen_index int not null,
  response_ms int not null,
  is_correct boolean not null,
  points int not null default 0,
  answered_at timestamptz not null default now(),
  primary key (room_id, user_id, question_id)
);

create index answers_room_question_idx on public.answers (room_id, question_id);

-- ---------------------------------------------------------------------
-- 4. FUNCION AUXILIAR: ¿soy anfitrion o jugador de esta sala?
-- ---------------------------------------------------------------------
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.rooms r where r.id = p_room_id and r.host_id = auth.uid())
    or exists (select 1 from public.room_players p where p.room_id = p_room_id and p.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- 5. SEGURIDAD (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.packs         enable row level security;
alter table public.questions     enable row level security;
alter table public.question_keys enable row level security;
alter table public.rooms         enable row level security;
alter table public.room_players  enable row level security;
alter table public.answers       enable row level security;

-- Perfiles: cada uno ve y edita el suyo
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Paquetes: solo su dueno
create policy "packs_owner_all" on public.packs
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Preguntas: el dueno del paquete gestiona todo
create policy "questions_owner_all" on public.questions
  for all to authenticated
  using (exists (select 1 from public.packs p where p.id = questions.pack_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.packs p where p.id = questions.pack_id and p.owner_id = auth.uid()));

-- Preguntas: los miembros de una sala solo ven la pregunta actual y las anteriores
create policy "questions_room_members_select" on public.questions
  for select to authenticated
  using (
    exists (
      select 1 from public.rooms r
      where r.pack_id = questions.pack_id
        and r.current_order >= questions.sort_order
        and public.is_room_member(r.id)
    )
  );

-- Respuestas correctas: solo el dueno del paquete
create policy "question_keys_owner_all" on public.question_keys
  for all to authenticated
  using (
    exists (
      select 1 from public.questions q
      join public.packs p on p.id = q.pack_id
      where q.id = question_keys.question_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.questions q
      join public.packs p on p.id = q.pack_id
      where q.id = question_keys.question_id and p.owner_id = auth.uid()
    )
  );

-- Salas: solo las ven sus miembros (se crean y modifican mediante funciones)
create policy "rooms_members_select" on public.rooms
  for select to authenticated using (public.is_room_member(id));

-- Jugadores: los miembros ven a los de su sala; cada uno puede salirse
create policy "room_players_members_select" on public.room_players
  for select to authenticated using (public.is_room_member(room_id));
create policy "room_players_leave" on public.room_players
  for delete to authenticated using (user_id = auth.uid());

-- Respuestas: cada uno ve las suyas; el anfitrion ve todas;
-- los demas ven las de todos solo cuando se revela la pregunta
create policy "answers_select" on public.answers
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.rooms r
      where r.id = answers.room_id and r.host_id = auth.uid()
    )
    or exists (
      select 1 from public.rooms r
      where r.id = answers.room_id
        and r.status in ('reveal', 'finished')
        and public.is_room_member(r.id)
    )
  );

-- ---------------------------------------------------------------------
-- 6. LOGICA DEL JUEGO (funciones que se ejecutan en el servidor)
-- ---------------------------------------------------------------------

-- Crear sala (solo con paquetes propios y con preguntas)
create or replace function public.create_room(p_pack_id uuid, p_seconds int default 20)
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
  v_tries int := 0;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesion';
  end if;

  if not exists (select 1 from public.packs where id = p_pack_id and owner_id = auth.uid()) then
    raise exception 'Ese paquete no existe o no es tuyo';
  end if;

  select count(*) into v_total from public.questions where pack_id = p_pack_id;
  if v_total = 0 then
    raise exception 'El paquete no tiene preguntas';
  end if;

  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;

    begin
      insert into public.rooms (code, host_id, pack_id, seconds_per_question, total_questions)
      values (v_code, auth.uid(), p_pack_id, greatest(5, least(120, coalesce(p_seconds, 20))), v_total)
      returning * into v_room;
      return v_room;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 10 then
        raise exception 'No se pudo generar un codigo de sala, intentalo de nuevo';
      end if;
    end;
  end loop;
end;
$$;

-- Unirse a una sala con codigo (maximo 8 jugadores)
create or replace function public.join_room(p_code text, p_nickname text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_nick text := trim(coalesce(p_nickname, ''));
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesion';
  end if;

  if char_length(v_nick) not between 1 and 20 then
    raise exception 'El apodo debe tener entre 1 y 20 caracteres';
  end if;

  -- "for update" bloquea la sala para que dos personas no ocupen la ultima plaza a la vez
  select * into v_room from public.rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'No existe ninguna sala con ese codigo';
  end if;

  if exists (select 1 from public.room_players where room_id = v_room.id and user_id = auth.uid()) then
    return v_room.id;
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'La partida ya ha empezado';
  end if;

  select count(*) into v_count from public.room_players where room_id = v_room.id;
  if v_count >= 8 then
    raise exception 'La sala esta llena (maximo 8 jugadores)';
  end if;

  if exists (
    select 1 from public.room_players
    where room_id = v_room.id and lower(nickname) = lower(v_nick)
  ) then
    raise exception 'Ese apodo ya esta en uso en la sala';
  end if;

  insert into public.room_players (room_id, user_id, nickname)
  values (v_room.id, auth.uid(), v_nick);

  return v_room.id;
end;
$$;

-- Anfitrion: pasar a la siguiente pregunta (o terminar la partida)
create or replace function public.next_question(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_next int;
begin
  select * into v_room
  from public.rooms
  where id = p_room_id and host_id = auth.uid()
  for update;

  if not found then
    raise exception 'Solo el anfitrion puede hacer esto';
  end if;
  if v_room.status = 'question' then
    raise exception 'La pregunta actual sigue en curso';
  end if;
  if v_room.status = 'finished' then
    raise exception 'La partida ya ha terminado';
  end if;

  select min(sort_order) into v_next
  from public.questions
  where pack_id = v_room.pack_id and sort_order > v_room.current_order;

  if v_next is null then
    update public.rooms
      set status = 'finished', question_started_at = null
      where id = p_room_id
      returning * into v_room;
  else
    update public.rooms
      set status = 'question', current_order = v_next, question_started_at = clock_timestamp()
      where id = p_room_id
      returning * into v_room;
  end if;

  return v_room;
end;
$$;

-- Jugador: responder a la pregunta actual (el tiempo lo mide el servidor)
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
  v_points int := 0;
begin
  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = auth.uid()
  ) then
    raise exception 'No estas en esta sala';
  end if;

  select * into v_room from public.rooms where id = p_room_id;
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

  -- Entre 1000 puntos (respuesta inmediata) y 500 (justo al final del tiempo)
  if v_correct then
    v_points := round(1000 * (1 - (v_elapsed_ms::numeric / v_total_ms) / 2));
  end if;

  insert into public.answers (room_id, user_id, question_id, chosen_index, response_ms, is_correct, points)
  values (p_room_id, auth.uid(), v_q.id, p_chosen, v_elapsed_ms, v_correct, v_points)
  on conflict do nothing;

  if not found then
    raise exception 'Ya has respondido a esta pregunta';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Anfitrion: cerrar la pregunta, sumar puntos y mostrar resultados
create or replace function public.reveal_question(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_qid uuid;
begin
  select * into v_room
  from public.rooms
  where id = p_room_id and host_id = auth.uid()
  for update;

  if not found then
    raise exception 'Solo el anfitrion puede hacer esto';
  end if;
  if v_room.status <> 'question' then
    raise exception 'No hay ninguna pregunta en curso';
  end if;

  select id into v_qid
  from public.questions
  where pack_id = v_room.pack_id and sort_order = v_room.current_order;

  update public.room_players p
    set score = p.score + a.points
    from public.answers a
    where a.room_id = p_room_id
      and a.question_id = v_qid
      and p.room_id = p_room_id
      and p.user_id = a.user_id;

  update public.rooms set status = 'reveal' where id = p_room_id returning * into v_room;
  return v_room;
end;
$$;

-- Miembros: conocer la respuesta correcta, solo cuando ya esta revelada
create or replace function public.get_correct_index(p_room_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_key int;
begin
  if not public.is_room_member(p_room_id) then
    raise exception 'No perteneces a esta sala';
  end if;

  select * into v_room from public.rooms where id = p_room_id;
  if v_room.status not in ('reveal', 'finished') then
    raise exception 'Todavia no se puede ver la respuesta';
  end if;

  select k.correct_index into v_key
  from public.question_keys k
  join public.questions q on q.id = k.question_id
  where q.pack_id = v_room.pack_id and q.sort_order = v_room.current_order;

  return v_key;
end;
$$;

-- Permisos de ejecucion: solo usuarios con sesion iniciada
revoke all on function public.create_room(uuid, int)    from public, anon;
revoke all on function public.join_room(text, text)     from public, anon;
revoke all on function public.next_question(uuid)       from public, anon;
revoke all on function public.submit_answer(uuid, int)  from public, anon;
revoke all on function public.reveal_question(uuid)     from public, anon;
revoke all on function public.get_correct_index(uuid)   from public, anon;
revoke all on function public.is_room_member(uuid)      from public, anon;
revoke all on function public.handle_new_user()         from public, anon, authenticated;

grant execute on function public.create_room(uuid, int)    to authenticated;
grant execute on function public.join_room(text, text)     to authenticated;
grant execute on function public.next_question(uuid)       to authenticated;
grant execute on function public.submit_answer(uuid, int)  to authenticated;
grant execute on function public.reveal_question(uuid)     to authenticated;
grant execute on function public.get_correct_index(uuid)   to authenticated;
grant execute on function public.is_room_member(uuid)      to authenticated;

-- ---------------------------------------------------------------------
-- 7. TIEMPO REAL (para que todos vean los cambios al instante)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.rooms, public.room_players, public.answers;

-- ---------------------------------------------------------------------
-- 8. FOTOS DE LAS PREGUNTAS (Storage)
-- Maximo 2 MB por foto, solo JPG, PNG o WebP.
-- Cada usuario solo puede subir/borrar dentro de su propia carpeta.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('question-images', 'question-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "question_images_upload_own_folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'question-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "question_images_delete_own_folder" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'question-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
