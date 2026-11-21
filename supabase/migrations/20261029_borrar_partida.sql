-- =====================================================================
-- BORRAR PARTIDAS
-- El game master puede borrar sus propias partidas (y sus preguntas generadas).
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Solo AÑADE una función nueva.
-- =====================================================================

create or replace function public.delete_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack uuid;
begin
  select pack_id into v_pack from public.rooms
    where id = p_room_id and host_id = auth.uid();
  if not found then
    raise exception 'Esa partida no existe o no es tuya';
  end if;

  -- borrar la partida (se van sus jugadores, respuestas y contexto)
  delete from public.rooms where id = p_room_id;
  -- borrar el paquete de preguntas que se creo para ella
  delete from public.packs where id = v_pack and title like 'Sala:%';
end;
$$;

revoke all on function public.delete_room(uuid) from public, anon;
grant execute on function public.delete_room(uuid) to authenticated;
