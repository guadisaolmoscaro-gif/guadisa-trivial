-- =====================================================================
-- CONTEXTO OPCIONAL
-- La Vaca y la Compatibilidad amorosa no piden contexto del grupo, asi que
-- su texto interno es mas corto que el minimo de 200 de Trivial Amigos.
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Solo cambia una regla de la tabla room_contexts.
-- =====================================================================

alter table public.room_contexts drop constraint if exists room_contexts_context_check;
alter table public.room_contexts add constraint room_contexts_context_check
  check (char_length(context) between 1 and 12000);
