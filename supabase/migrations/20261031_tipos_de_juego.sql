-- =====================================================================
-- TIPOS DE JUEGO: Trivial Amigos, La Vaca y Empatia
-- - trivial: como hasta ahora (una respuesta correcta).
-- - vaca: se gana acertando la respuesta de la mayoria (1 punto; empate entre grupos: 0,5).
-- - empatia: sin ganador; cada pregunta es "quien es mas..." con los nombres de la sala.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- =====================================================================

-- 1. TIPO DE JUEGO EN CADA PARTIDA ---------------------------------------
alter table public.rooms
  add column if not exists game_type text not null default 'trivial'
    check (game_type in ('trivial', 'vaca', 'empatia'));

-- 2. PUNTOS CON MEDIOS PUNTOS -------------------------------------------
alter table public.answers alter column points type numeric(6,1);
alter table public.room_players alter column score type numeric(8,1);

-- 3. PREGUNTAS CON N OPCIONES (empatia: una por jugador) ---------------
alter table public.questions drop constraint if exists questions_check;
alter table public.questions drop constraint if exists questions_kind_check;
alter table public.questions add constraint questions_kind_v2
  check (kind in ('multiple', 'truefalse', 'vote'));
alter table public.questions add constraint questions_options_v2 check (
  jsonb_typeof(options) = 'array' and (
    (kind = 'multiple'  and jsonb_array_length(options) = 4) or
    (kind = 'truefalse' and jsonb_array_length(options) = 2) or
    (kind = 'vote'      and jsonb_array_length(options) between 2 and 8)
  )
);

-- 4. CREAR PARTIDA SEGUN EL TIPO ---------------------------------------
create or replace function public.create_game_room(p_name text, p_game text, p_length int, p_names text[], p_context text)
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
  v_prompts text[] := array[
    '¿Quién es más quejica?',
    '¿Quién es más valiente?',
    '¿Quién es más probable que deje el trabajo?',
    '¿Quién es más probable que se enamore a primera vista?',
    '¿Quién es más cocinitas?',
    '¿Quién sabe más de geografía?',
    '¿Quién se queda dormido antes?',
    '¿Quién es más deportista?',
    '¿Quién ha tenido más novios?',
    '¿Quién es más feliz?',
    '¿Quién llora más?',
    '¿Quién es más despistado?',
    '¿Quién es más puntual?',
    '¿Quién es más cotilla?',
    '¿Quién es más optimista?',
    '¿Quién es más dramático?',
    '¿Quién es más fiestero?',
    '¿Quién es más madrugador?',
    '¿Quién es más noctámbulo?',
    '¿Quién es más sensible?',
    '¿Quién es más cabezota?',
    '¿Quién es más detallista?',
    '¿Quién es más ahorrador?',
    '¿Quién es más gastón?',
    '¿Quién es más viajero?',
    '¿Quién es más cantarín?',
    '¿Quién es más bailón?',
    '¿Quién es más exagerado?',
    '¿Quién es más friki?',
    '¿Quién es más romántico?',
    '¿Quién es más competitivo?',
    '¿Quién es más tranquilo?',
    '¿Quién es más olvidadizo?',
    '¿Quién es más curioso?',
    '¿Quién es más generoso?',
    '¿Quién es más tacaño?',
    '¿Quién es más mandón?',
    '¿Quién es más pelota?',
    '¿Quién es más graciosa?',
    '¿Quién es más organizado?',
    '¿Quién es más soñador?',
    '¿Quién es más sociable?'
  ];
  v_i int;
  v_text text;
  v_qid uuid;
begin
  -- Trivial Amigos: el flujo de siempre
  if p_game = 'trivial' then
    return public.create_room_request(p_name, p_length, p_names, p_context);
  end if;

  if p_game not in ('vaca', 'empatia') then
    raise exception 'Tipo de juego no valido';
  end if;
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;

  if (select count(*) from public.rooms where host_id = auth.uid()) >= 5 then
    raise exception 'Has llegado al maximo de 5 partidas';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'El nombre debe tener entre 1 y 60 caracteres';
  end if;
  if p_length not in (15, 30, 50) then
    raise exception 'Elige partida rapida (15), media (30) o larga (50)';
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
  if v_wm is null then raise exception 'La web todavia no tiene webmaster configurado'; end if;

  insert into public.packs (owner_id, title)
  values (v_wm, 'Sala: ' || trim(p_name))
  returning id into v_pack;

  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    begin
      insert into public.rooms (code, host_id, pack_id, name, seconds_per_question, total_questions, question_limit, review_status, game_type)
      values (v_code, auth.uid(), v_pack, trim(p_name), 15, p_length, p_length,
              case when p_game = 'vaca' then 'generating' else 'approved' end, p_game)
      returning * into v_room;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 10 then raise exception 'No se pudo generar un codigo de sala, intentalo de nuevo'; end if;
    end;
  end loop;

  insert into public.room_slots (room_id, name, position)
  select v_room.id, v_names[i], i from generate_subscripts(v_names, 1) as i;

  if p_game = 'vaca' then
    -- las preguntas de La Vaca las genera la IA (generate-room) y pasan por el webmaster
    insert into public.room_contexts (room_id, context) values (v_room.id, 'La Vaca: preguntas de opinion general, sin contexto del grupo.');
  else
    -- Empatia: una pregunta por plantilla, con los nombres de la sala como respuestas
    v_i := 0;
    foreach v_text in array v_prompts loop
      exit when v_i >= p_length;
      insert into public.questions (pack_id, sort_order, kind, prompt, options)
      values (v_pack, v_i, 'vote', v_text, to_jsonb(v_names))
      returning id into v_qid;
      insert into public.question_keys (question_id, correct_index) values (v_qid, 0);
      v_i := v_i + 1;
    end loop;
    update public.rooms set total_questions = v_i where id = v_room.id;
  end if;

  return v_room.id;
end;
$$;

-- 5. CIERRE DE PREGUNTA: puntos segun el tipo de juego ----------------
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
  v_top int;
  v_groups int;
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

  if v_room.game_type = 'trivial' then
    with ranked as (
      select user_id, row_number() over (order by response_ms, answered_at) as pos
      from public.answers
      where room_id = p_room_id and question_id = v_q and is_correct
    )
    update public.answers a
      set points = round(1000 * (v_players - r.pos + 1)::numeric / v_players, 1)
      from ranked r
      where a.room_id = p_room_id and a.question_id = v_q and a.user_id = r.user_id;

  elsif v_room.game_type = 'vaca' then
    -- la mayoria: el grupo mas grande que ha elegido lo mismo
    select max(c) into v_top from (
      select count(*) as c from public.answers
      where room_id = p_room_id and question_id = v_q group by chosen_index
    ) s;
    select count(*) into v_groups from (
      select chosen_index from public.answers
      where room_id = p_room_id and question_id = v_q
      group by chosen_index having count(*) = v_top
    ) s2;

    update public.answers a
      set points = case when grp.cnt = v_top then (case when v_groups = 1 then 1.0 else 0.5 end) else 0 end,
          is_correct = (grp.cnt = v_top)
      from (
        select chosen_index as ci, count(*) as cnt from public.answers
        where room_id = p_room_id and question_id = v_q group by chosen_index
      ) grp
      where a.room_id = p_room_id and a.question_id = v_q and a.chosen_index = grp.ci;

  else
    -- empatia: no hay puntos ni aciertos
    update public.answers set points = 0, is_correct = false
      where room_id = p_room_id and question_id = v_q;
  end if;

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

-- 6. REVISION: el webmaster sabe de que tipo es cada partida -----------
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
      'game', r.game_type,
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

-- 7. PERMISOS -----------------------------------------------------------
revoke all on function public.create_game_room(text, text, int, text[], text) from public, anon;
grant execute on function public.create_game_room(text, text, int, text[], text) to authenticated;
