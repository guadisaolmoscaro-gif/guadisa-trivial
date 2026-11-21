-- =====================================================================
-- LA VACA SIN REVISION
-- Las preguntas de La Vaca no pasan por el webmaster: se aprueban solas.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- =====================================================================

-- Las partidas de La Vaca que estan esperando revision se aprueban ya
update public.rooms set review_status = 'approved'
  where game_type = 'vaca' and review_status = 'pending';

-- Y las futuras: cuando la IA termine, pasan directamente a aprobadas
create or replace function public.vaca_auto_approve()
returns trigger
language plpgsql
as $$
begin
  if new.game_type = 'vaca' and new.review_status = 'pending' then
    new.review_status := 'approved';
  end if;
  return new;
end;
$$;

drop trigger if exists vaca_auto_approve on public.rooms;
create trigger vaca_auto_approve
  before update on public.rooms
  for each row execute function public.vaca_auto_approve();
