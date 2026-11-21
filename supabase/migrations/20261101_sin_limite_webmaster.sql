-- =====================================================================
-- SIN LIMITE DE PARTIDAS PARA EL WEBMASTER
-- El limite de 5 partidas sigue para los demas game masters.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Solo sustituye create_room_request y create_game_room.
-- =====================================================================

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

  if not exists (select 1 from public.profiles where id = auth.uid() and is_webmaster)
     and (select count(*) from public.rooms where host_id = auth.uid()) >= 5 then
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
  if p_game = 'trivial' then
    return public.create_room_request(p_name, p_length, p_names, p_context);
  end if;

  if p_game not in ('vaca', 'empatia') then
    raise exception 'Tipo de juego no valido';
  end if;
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;

  if not exists (select 1 from public.profiles where id = auth.uid() and is_webmaster)
     and (select count(*) from public.rooms where host_id = auth.uid()) >= 5 then
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
    insert into public.room_contexts (room_id, context) values (v_room.id, 'La Vaca: preguntas de opinion general, sin contexto del grupo.');
  else
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

revoke all on function public.create_room_request(text, int, text[], text) from public, anon;
grant execute on function public.create_room_request(text, int, text[], text) to authenticated;
revoke all on function public.create_game_room(text, text, int, text[], text) from public, anon;
grant execute on function public.create_game_room(text, text, int, text[], text) to authenticated;
