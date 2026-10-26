# Trivial de amigos — contexto del proyecto

Web app de juegos personalizados para grupos de amigos. Empezamos por un **Trivial** multijugador en tiempo real; después vendrán Tabú, Pasapalabra y Pictionary. La idea es poder **comercializarla**, así que hay que mantener la creación de contenido muy fácil para el anfitrión.

Las dueñas del proyecto **no programan**: explica los cambios en español, en lenguaje sencillo, y pide confirmación antes de acciones que afecten a la web real, a la base de datos real o a gastos.

## Cómo se juega (decisiones ya tomadas)
- Cada jugador entra desde su móvil/ordenador con un **código de sala** de 5 letras. Hasta **8 jugadores**.
- **Todos responden a la vez**; gana quien suma más puntos. Puntos: de 1000 (respuesta inmediata) a 500 (al límite del tiempo), solo si es correcta. El tiempo lo mide **el servidor**.
- Tiempo por pregunta **configurable por el anfitrión**. Al final solo hay **ranking de esa partida** (sin historial).
- Formatos de pregunta: test de 4 opciones, verdadero/falso, y foto opcional. **No** hay respuesta escrita libre.
- El **anfitrión no juega** (conoce las respuestas); crea la sala y pasa las preguntas.
- Registro con **email** (Supabase Auth). Idioma: **solo español**. Estilo visual: **colorido y divertido, tipo Kahoot**.
- Presupuesto: pequeño (unos pocos euros al mes). Público: cualquiera.

## Quedadas sorpresa (en la rama `desarrollo`)
Para que el anfitrión no tenga que escribir todo: crea una "quedada" con los nombres de los amigos (4–12) y comparte un **enlace sin registro** (`/?e=<token>`). Cada amigo contesta en ~2 min: 6 datos sobre sí mismo y hasta 3 cosas de otros. La página pública **no menciona el juego** (es una sorpresa). Con eso se generan preguntas **anónimas "¿quién es?"** con los amigos como opciones, **sin IA**. El anfitrión revisa antes de crear el paquete y tiene mensajes de "hype" para copiar.
Ideas futuras: más tipos de pregunta (con IA), límite de respuestas por enlace, proyecto de Supabase solo de pruebas.

## Stack
- Frontend: React 18 + Vite, CSS normal (`src/index.css`). Sin Tailwind.
- Backend: **Supabase** (Auth, Postgres con RLS, Realtime, Storage bucket `question-images`, Edge Function `generate-questions`).
- Despliegue: **Vercel** conectado a GitHub (`guadisaolmoscaro-gif/guadisa-trivial`). Variables de Vercel: `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` (Production y Preview).

## Archivos
- `src/App.jsx`: sesión, paquetes, editor de preguntas, ruta pública `?e=`.
- `src/Game.jsx`: sala, partida en tiempo real (anfitrión y jugador), importador de preguntas en bloque.
- `src/Voice.jsx`: asistente "crear preguntas hablando" (dictado del navegador + IA).
- `src/Events.jsx` / `src/Invite.jsx`: quedadas sorpresa (panel del anfitrión / página pública).
- `supabase/migrations/`: SQL en orden de fecha. `20261024_base.sql` (tablas, RLS y lógica del juego) y `20261025_quedadas.sql`.
- `supabase/functions/generate-questions/index.ts`: función que llama a la API de Anthropic. Necesita el secreto `ANTHROPIC_API_KEY`.

## Reglas de seguridad del diseño (no romper)
- La respuesta correcta vive en `question_keys`, que **los jugadores no pueden leer**. La puntuación y el reparto de puntos se hacen en funciones SQL (`submit_answer`, `reveal_question`), nunca en el navegador.
- Los amigos de una quedada **no tienen acceso a las tablas**: solo a `get_invite` y `submit_facts`. Solo el anfitrión lee `events`, `event_members` y `facts`.
- Las funciones `security definer` llevan `set search_path = public` y permisos explícitos (`revoke` + `grant`).

## Cómo trabajar
- **`main` es la web real** (Vercel publica cada push). **No hagas push a `main` sin que lo pidan.** Trabaja en la rama `desarrollo` (Vercel crea una versión de prueba, "Preview").
- **La base de datos de pruebas y la real son la misma** (un solo proyecto de Supabase). Cualquier cambio de SQL afecta a datos reales: avisa antes y prefiere migraciones que solo añaden. Ya se ejecutó `20261024_base.sql` en producción; no la vuelvas a ejecutar.
- Los cambios de SQL se guardan como migración nueva en `supabase/migrations/` y las dueñas (o tú, con su permiso) las ejecutan en Supabase > SQL Editor.
- Para probar en local: `cp .env.example .env.local`, rellena las dos variables, `npm install`, `npm run dev` (abre http://localhost:5173). Antes de dar algo por bueno, ejecuta `npm run build`.
- **Nunca** escribas ni pegues claves o contraseñas (Anthropic, `service_role`, `secret`) en el código, el chat, Vercel o GitHub. Solo van en los secretos de Supabase y en `.env.local`, y las pone la persona.
- Commits en español, claros y pequeños.

## Pendiente a fecha de la última sesión
1. Ejecutar `20261025_quedadas.sql` en Supabase (sin ejecutar aún).
2. Comprobar el despliegue Preview de `desarrollo` en Vercel.
3. Probar de principio a fin el botón "✨ Generar preguntas" de `Voice.jsx` y la función de IA (la clave se guardó, pero no se ha probado; si da 401, desactivar "Verify JWT" en la función).
4. Revocar la clave de Anthropic que se pegó en un chat y crear una nueva (actualizar el secreto en Supabase).
5. Probar una partida real con 2+ cuentas (anfitriona y jugadora) y las quedadas.
6. Antes de comercializar: límites de uso/coste de IA por usuario, política de privacidad y RGPD (se recogen datos de terceros), moderación de fotos, plan de Vercel apto para uso comercial, proyecto de Supabase de pruebas aparte.
