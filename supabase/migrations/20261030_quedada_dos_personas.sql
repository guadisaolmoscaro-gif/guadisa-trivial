-- =====================================================================
-- QUEDADA SORPRESA CON DOS PERSONAS O MAS
-- Antes el minimo eran 4 personas. Ahora son 2 (maximo 12).
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Solo sustituye create_event; no toca los datos existentes.
-- =====================================================================

create or replace function public.create_event(p_title text, p_date date, p_names text[])
returns public.events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.events;
  v_names text[];
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesion'; end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 80 then
    raise exception 'El titulo debe tener entre 1 y 80 caracteres';
  end if;

  select array_agg(n order by first_pos) into v_names
  from (
    select min(trim(x)) as n, min(o) as first_pos
    from unnest(coalesce(p_names, array[]::text[])) with ordinality as t(x, o)
    where char_length(trim(x)) between 1 and 30
    group by lower(trim(x))
  ) s;

  if v_names is null or array_length(v_names, 1) < 2 then
    raise exception 'Necesitas al menos 2 nombres distintos';
  end if;
  if array_length(v_names, 1) > 12 then
    raise exception 'Maximo 12 personas';
  end if;

  insert into public.events (host_id, title, event_date)
  values (auth.uid(), trim(p_title), p_date)
  returning * into v_event;

  insert into public.event_members (event_id, name)
  select v_event.id, unnest(v_names);

  return v_event;
end;
$$;

revoke all on function public.create_event(text, date, text[]) from public, anon;
grant execute on function public.create_event(text, date, text[]) to authenticated;
