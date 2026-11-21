-- =====================================================================
-- COMPATIBILIDAD AMOROSA
-- Cada jugador elige una opcion por pregunta. Sin ganador: al final se
-- ven las respuestas y una barra de compatibilidad por cada pareja de jugadores.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- =====================================================================

-- 1. Nuevo tipo de juego
alter table public.rooms drop constraint if exists rooms_game_type_check;
alter table public.rooms add constraint rooms_game_type_check
  check (game_type in ('trivial', 'vaca', 'empatia', 'amor'));

-- 2. Crear la partida con las preguntas de compatibilidad
create or replace function public.create_amor_room(p_name text, p_length int, p_names text[])
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
    {"p":"¿Cuál es tu plan ideal para una primera cita?","o":["Cena tranquila y buena conversación","Plan improvisado por la ciudad","Cine y palomitas","Algo loco: karaoke, escape room…"]},
    {"p":"Cuando hay un conflicto, tú…","o":["Lo hablas en el momento","Necesitas un rato para pensar","Haces una broma para bajar la tensión","Lo dejas pasar y se olvida"]},
    {"p":"Tu finde perfecto es…","o":["Un viaje sorpresa","Casa, manta y serie","Con amigos hasta tarde","Naturaleza o deporte"]},
    {"p":"¿Cómo demuestras cariño?","o":["Con palabras bonitas","Con detalles y regalos","Con tiempo juntos sin móviles","Con abrazos y cercanía"]},
    {"p":"El dinero en pareja, para ti…","o":["Todo a medias","Cada uno lo suyo","El que más gana, paga más","Ya veremos según el mes"]},
    {"p":"El mensaje de buenos días ideal…","o":["Un emoji o un GIF","Un audio largo","Un buenos días escrito con cariño","Ninguno: lo vemos en persona"]},
    {"p":"Tus vacaciones ideales…","o":["Playa y no hacer nada","Ciudad, museos y restaurantes","Montaña y naturaleza","Recorrer varios países"]},
    {"p":"Cuando algo te molesta, tú…","o":["Lo dices en voz alta","Te lo guardas y se te pasa","Haces bromitas al respecto","Te apartas un rato"]},
    {"p":"Un sábado sin planes, tú…","o":["Te inventas algo","Te quedas en casa","Llamas a alguien","Duermes hasta tarde"]},
    {"p":"Cocinar en pareja es…","o":["Uno cocina y el otro friega","Cocináis a medias","Pedís comida","Cada uno cocina lo suyo"]},
    {"p":"Para hacer las paces, lo que mejor funciona es…","o":["Hablar largo y tendido","Un detalle o un gesto","Dejar pasar un día","Una broma y listo"]},
    {"p":"Dentro de 5 años os imaginas…","o":["Viviendo juntos","Viajando mucho","Casados","Sin etiquetas y a vuestro ritmo"]},
    {"p":"Tu nivel de romanticismo es…","o":["Cartas y sorpresas","Pequeños gestos del día a día","Planes grandes de vez en cuando","Más práctico que romántico"]},
    {"p":"En un viaje en coche, tú…","o":["Conduces tú","Pones la música","Eliges la ruta","Te duermes"]},
    {"p":"Lo que más te hace sentir querido es…","o":["Que te escuchen","Que te dediquen tiempo","Que te ayuden con algo","Que te digan cosas bonitas"]},
    {"p":"Antes de dormir, lo ideal es…","o":["Hablar de todo un poco","Ver algo juntos","Cada uno con su móvil","Dormirse abrazados"]},
    {"p":"En vuestro aniversario prefieres…","o":["Un detalle sencillo","Una cena especial","Un viaje corto","Olvidarlo y recordarlo a las 23:59"]},
    {"p":"Si la otra persona está enfadada, tú…","o":["Le das su espacio","Le preguntas qué le pasa","Le haces reír","Te enfadas tú también"]},
    {"p":"Para ti, una relación sana es sobre todo…","o":["Confianza","Humor","Respeto y libertad","Complicidad"]},
    {"p":"Cuando estás enamorado/a, tú…","o":["Lo dices enseguida","Lo demuestras más que lo dices","Lo dices con una canción","Tardas en darte cuenta"]}
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
      insert into public.rooms (code, host_id, pack_id, name, seconds_per_question, total_questions, question_limit, review_status, game_type)
      values (v_code, auth.uid(), v_pack, trim(p_name), 15, 0, p_length, 'approved', 'amor')
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
  values (v_room.id, 'Compatibilidad amorosa: preguntas generales, sin contexto del grupo.');

  for v_q in select value from jsonb_array_elements(v_qs) loop
    exit when v_i >= p_length;
    insert into public.questions (pack_id, sort_order, kind, prompt, options)
    values (v_pack, v_i, 'multiple', v_q->>'p', v_q->'o')
    returning id into v_qid;
    insert into public.question_keys (question_id, correct_index) values (v_qid, 0);
    v_i := v_i + 1;
  end loop;

  update public.rooms set total_questions = v_i where id = v_room.id;
  return v_room.id;
end;
$$;

revoke all on function public.create_amor_room(text, int, text[]) from public, anon;
grant execute on function public.create_amor_room(text, int, text[]) to authenticated;
