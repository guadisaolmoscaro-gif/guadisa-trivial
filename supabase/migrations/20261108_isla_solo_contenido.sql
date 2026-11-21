-- =====================================================================
-- LA ISLA: solo preguntas de contenido (quien hizo que, con quien se fue, quien se fue sola…)
-- Sin fechas ni datos del programa. Sustituye create_isla_room.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- =====================================================================

create or replace function public.create_isla_room(p_name text, p_length int, p_names text[])
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
  v_i int := 0;
  v_qid uuid;
  v_q jsonb;
  v_qs jsonb := '[
    {"p":"Tras descubrir el trío de su novio Rubén en La isla 11, ¿qué dijo Gema de la otra chica?","o":["Ella fue mi ángel","Ya no hay vuelta atrás","Me ha destrozado el alma","Que se quede con él"],"c":0},
    {"p":"En La isla 11, ¿quién decidió irse sola tras la hoguera final?","o":["Gema","Paola","Náyades","Isa"],"c":0},
    {"p":"En La isla 11, ¿quién quería seguir conociendo a Irini?","o":["Sergio","Rubén","Nacho","Kico"],"c":0},
    {"p":"En La isla 11, ¿quién quería irse con Gema y pidió disculpas por su comportamiento?","o":["Rubén","Sergio","Nando","Kico"],"c":0},
    {"p":"¿Con quién entra Nacho en La isla 11?","o":["Náyades","Paula","Gema","Paola"],"c":0},
    {"p":"¿Con quién entra Kico en La isla 11?","o":["Isa","Gema","Paula","Paola"],"c":2},
    {"p":"¿Con quién entra Rubén en La isla 11?","o":["Paola","Isa","Náyades","Gema"],"c":3},
    {"p":"¿Con quién entra Sergio en La isla 11?","o":["Paola","Gema","Paula","Isa"],"c":0},
    {"p":"¿Con quién entra Nando en La isla 11?","o":["Gema","Isa","Paola","Náyades"],"c":1},
    {"p":"En La isla 10, ¿quién se marchó solo tras la hoguera final?","o":["Atamán","Mar","Alba","Julia"],"c":0},
    {"p":"En La isla 10, ¿con quién se fue Leila?","o":["David","Luis","Christian","Miguel"],"c":0},
    {"p":"En La isla 10, ¿quién confesó en el debate final que ya no estaba con Christian?","o":["Mar","Leila","Alba","Nerea"],"c":0},
    {"p":"En La isla 10, ¿qué pareja se separó tras la hoguera final?","o":["Alba y David","Julia y Luis","Álex y Ainhoa","Bayán y Miguel"],"c":0},
    {"p":"¿Con qué pareja de la 10 se quedaba Atamán?","o":["Mar","Paola","Leila","Gema"],"c":2},
    {"p":"En el debate final de la 10, ¿de qué acusaron a Leila?","o":["De haber sido infiel a Atamán","De mentir sobre su trabajo","De no querer ir al debate","De robar en la villa"],"c":0},
    {"p":"¿Quién dijo «Las gambas me encantan, lo sabes de sobra»?","o":["Anita","Manuel","Alejandro Nieto","Montoya"],"c":3},
    {"p":"¿Quién dijo «Yo no voy a ser aquí Bustamante, quillo»?","o":["Montoya","Anita","Tom Brusse","Lucía"],"c":0},
    {"p":"¿Por qué se criticó a Alejandro Nieto en la cuarta edición?","o":["Por machismo y homofobia","Por no pagar su parte","Por mentir sobre su trabajo","Por romper una villa"],"c":0},
    {"p":"¿Qué frase se hizo famosa con Tom Brusse en la segunda edición?","o":["Tom Brusse, eres un desgraciado","Tom Brusse, vuelve a casa","Tom Brusse, no te quiero","Tom Brusse, estás despedido"],"c":0}
  ]'::jsonb;
begin
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
      insert into public.rooms (code, host_id, pack_id, name, seconds_per_question, total_questions, question_limit, review_status, game_type, theme)
      values (v_code, auth.uid(), v_pack, trim(p_name), 10, 0, p_length, 'approved', 'trivial', 'isla')
      returning * into v_room;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 10 then raise exception 'No se pudo generar un codigo de sala, intentalo de nuevo'; end if;
    end;
  end loop;

  insert into public.room_slots (room_id, name, position)
  select v_room.id, v_names[i], i from generate_subscripts(v_names, 1) as i;

  insert into public.room_contexts (room_id, context)
  values (v_room.id, 'La Isla: preguntas de contenido sobre La isla de las tentaciones, sin contexto del grupo.');

  for v_q in select value from jsonb_array_elements(v_qs) order by random() loop
    exit when v_i >= p_length;
    insert into public.questions (pack_id, sort_order, kind, prompt, options)
    values (v_pack, v_i, 'multiple', v_q->>'p', v_q->'o')
    returning id into v_qid;
    insert into public.question_keys (question_id, correct_index)
    values (v_qid, (v_q->>'c')::int);
    v_i := v_i + 1;
  end loop;

  update public.rooms set total_questions = v_i where id = v_room.id;
  return v_room.id;
end;
$$;

revoke all on function public.create_isla_room(text, int, text[]) from public, anon;
grant execute on function public.create_isla_room(text, int, text[]) to authenticated;
