-- =====================================================================
-- CONTINUAR CUANDO ESTEN TODOS
-- Ahora, si todos los participantes han entrado, cualquiera de ellos
-- puede pulsar "Continuar" para empezar (ademas del game master).
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Solo sustituye start_game. Nadie fuera de la sala puede empezarla.
-- =====================================================================

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
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'Esta sala no existe'; end if;

  -- el game master o cualquier participante de la sala
  if v_room.host_id <> auth.uid()
     and not exists (select 1 from public.room_slots where room_id = p_room_id and user_id = auth.uid()) then
    raise exception 'Solo los participantes pueden empezar la partida';
  end if;

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

revoke all on function public.start_game(uuid) from public, anon;
grant execute on function public.start_game(uuid) to authenticated;
