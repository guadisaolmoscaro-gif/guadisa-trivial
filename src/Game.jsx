import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

const COLORS = ['c-red', 'c-blue', 'c-yellow', 'c-green']
const BUCKET = 'question-images'
const MAX_PLAYERS = 8

function useRoom(id) {
  const [room, setRoom] = useState(null)
  const [players, setPlayers] = useState([])
  const [slots, setSlots] = useState([])
  const load = async () => {
    const { data: r } = await supabase.from('rooms').select('*').eq('id', id).single()
    const { data: p } = await supabase.from('room_players').select('*').eq('room_id', id).order('score', { ascending: false })
    const { data: s } = await supabase.from('room_slots').select('*').eq('room_id', id).order('position')
    setRoom(r)
    setPlayers(p || [])
    setSlots(s || [])
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('room-' + id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_slots', filter: `room_id=eq.${id}` }, load)
      .subscribe()
    const t = setInterval(load, 3000) // respaldo por si falla el tiempo real
    return () => { supabase.removeChannel(ch); clearInterval(t) }
  }, [id])
  return { room, players, slots }
}

function useQuestion(room) {
  const [q, setQ] = useState(null)
  useEffect(() => {
    if (!room || room.current_order < 0) return setQ(null)
    supabase.from('questions').select('*').eq('pack_id', room.pack_id).eq('sort_order', room.current_order).maybeSingle().then(({ data }) => setQ(data))
  }, [room?.pack_id, room?.current_order])
  return room && q && q.sort_order === room.current_order ? q : null
}

function useCorrect(room) {
  const [ok, setOk] = useState(null)
  useEffect(() => {
    setOk(null)
    if (room && ['reveal', 'finished'].includes(room.status))
      supabase.rpc('get_correct_index', { p_room_id: room.id }).then(({ data }) => setOk(data))
  }, [room?.status, room?.current_order])
  return ok
}

function useLeft(room) {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (room?.status !== 'question') return
    const tick = () => setLeft(Math.max(0, Math.ceil((new Date(room.question_started_at).getTime() + room.seconds_per_question * 1000 - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 250)
    return () => clearInterval(t)
  }, [room?.status, room?.question_started_at])
  return left
}

// Respuestas de la sala: se cargan cuando la pregunta ya esta cerrada (reveal o finished)
function useRoomAnswers(room) {
  const [answers, setAnswers] = useState([])
  useEffect(() => {
    if (!room || !['reveal', 'finished'].includes(room.status)) return
    supabase.from('answers').select('*').eq('room_id', room.id).then(({ data }) => setAnswers(data || []))
  }, [room?.id, room?.status, room?.current_order])
  return answers
}

// Host: cuantos han contestado a la pregunta actual (solo el game master ve todas las respuestas)
function useAnsweredCount(room, cur) {
  const [answered, setAnswered] = useState(0)
  useEffect(() => {
    setAnswered(0)
    if (room?.status !== 'question' || !cur) return
    const f = async () => {
      const { count } = await supabase.from('answers').select('*', { count: 'exact', head: true }).eq('room_id', room.id).eq('question_id', cur.id)
      setAnswered(count || 0)
    }
    f()
    const t = setInterval(f, 1000)
    return () => clearInterval(t)
  }, [room?.status, cur?.id])
  return answered
}

// Ritmo de la partida: lo empuja cualquier jugador, asi no se queda parada si el game master cierra el navegador
function useGameTimers(room, left, answered, playersCount) {
  useEffect(() => {
    if (!room) return
    const rpc = (fn) => supabase.rpc(fn, { p_room_id: room.id })
    if (room.status === 'question') {
      // el game master cierra en cuanto han contestado todos; todos cierran al agotarse el tiempo
      const allIn = answered != null && playersCount > 0 && answered >= playersCount
      if (!allIn && left !== 0) return
      rpc('close_question')
      const t = setInterval(() => rpc('close_question'), 800)
      return () => clearInterval(t)
    }
    if (room.status === 'reveal') {
      const t = setInterval(() => rpc('advance_room'), 1000)
      return () => clearInterval(t)
    }
  }, [room?.status, room?.current_order, left, answered, playersCount])
}

function Options({ q, onPick, picked, ok }) {
  return (
    <>
      <h2>{q.prompt}</h2>
      {q.image_path && <img className="q" src={supabase.storage.from(BUCKET).getPublicUrl(q.image_path).data.publicUrl} alt="" />}
      {q.options.map((o, i) => (
        <button key={i} className={`opt ${COLORS[i]} ${ok != null && ok !== i ? 'dim' : ''}`} disabled={picked != null} onClick={() => onPick?.(i)}>
          {o}{picked === i ? ' ✔' : ''}
        </button>
      ))}
    </>
  )
}

// Lo que ve todo el mundo al final de cada pregunta: quien acerto, fallo o se quedo sin tiempo
function Reveal({ players, answers, qid }) {
  const mine = answers.filter((a) => a.question_id === qid)
  const hits = mine.filter((a) => a.is_correct).sort((a, b) => a.response_ms - b.response_ms)
  const rows = players.map((p) => {
    const a = mine.find((x) => x.user_id === p.user_id)
    const pos = a?.is_correct ? hits.findIndex((x) => x.user_id === p.user_id) + 1 : 0
    return { p, a, pos, key: pos || (a ? 100 : 200) }
  }).sort((x, y) => x.key - y.key)
  return (
    <ul className="list">
      {rows.map(({ p, a, pos }) => (
        <li key={p.user_id}>
          {a?.is_correct && `✅ ${pos}.º ${p.nickname} · ${(a.response_ms / 1000).toFixed(1)} s · +${a.points}`}
          {a && !a.is_correct && `❌ ${p.nickname} · falló`}
          {!a && `⏱ ${p.nickname} · se le agotó el tiempo`}
        </li>
      ))}
    </ul>
  )
}

// Resumen final: ganador por puntos; en empate, el que menos tiempo sumó en sus aciertos
function Summary({ players, answers, me }) {
  const rows = players.map((p) => {
    const hits = answers.filter((a) => a.user_id === p.user_id && a.is_correct)
    return { ...p, hits: hits.length, ms: hits.reduce((s, a) => s + a.response_ms, 0) }
  }).sort((a, b) => b.score - a.score || a.ms - b.ms)
  return (
    <>
      <h2>🏆 ¡Fin de la partida!</h2>
      {rows[0] && <p>Gana <b>{rows[0].nickname}</b> con {rows[0].score} puntos.</p>}
      <ol className="list">
        {rows.map((r, i) => (
          <li key={r.user_id} style={{ fontWeight: r.user_id === me ? 800 : 400 }}>
            {['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {r.nickname} — {r.score} pts · {r.hits} aciertos · {(r.ms / 1000).toFixed(1)} s
          </li>
        ))}
      </ol>
    </>
  )
}

export function Host({ room: first, exit }) {
  const { room, players, slots } = useRoom(first.id)
  const cur = useQuestion(room)
  const ok = useCorrect(room)
  const left = useLeft(room)
  const answers = useRoomAnswers(room)
  const answered = useAnsweredCount(room, cur)
  const busy = useRef(false)
  const [copied, setCopied] = useState(false)

  useGameTimers(room, left, answered, players.length)

  // Cuando han entrado todos, la partida empieza sola
  const allIn = slots.length > 0 && slots.every((s) => s.user_id)
  const [startErr, setStartErr] = useState('')
  useEffect(() => {
    if (room?.status === 'lobby' && room.review_status === 'approved' && allIn)
      supabase.rpc('start_game', { p_room_id: first.id }).then(({ error }) => setStartErr(error?.message || ''))
  }, [room?.status, room?.review_status, allIn])

  const call = async (fn) => {
    if (busy.current) return
    busy.current = true
    const { error } = await supabase.rpc(fn, { p_room_id: first.id })
    busy.current = false
    if (error) alert(error.message)
  }

  if (!room) return <p className="center">Cargando…</p>
  const link = `${window.location.origin}/?s=${room.invite_token}`
  const missing = slots.filter((s) => !s.user_id).length
  return (
    <>
      <button className="ghost" onClick={exit}>← Salir</button>
      <div className="card">
        {room.status === 'lobby' && room.review_status !== 'approved' && (
          <p>{room.review_status === 'rejected'
            ? 'Esta sala no se ha aprobado. Crea una nueva.'
            : room.review_status === 'failed'
              ? 'No se han podido generar las preguntas. Crea la sala de nuevo.'
              : 'Las preguntas están en revisión. Cuando el webmaster las apruebe, aquí aparecerá el enlace para tus amigos.'}</p>
        )}
        {room.status === 'lobby' && room.review_status === 'approved' && (
          <>
            <p>Envía este enlace a tus amigos por WhatsApp:</p>
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <p><button onClick={() => { navigator.clipboard.writeText(link); setCopied(true) }}>{copied ? '¡Copiado!' : 'Copiar enlace'}</button></p>
            <p>Participantes ({slots.length - missing}/{slots.length} dentro):</p>
            <ul className="list">
              {slots.map((s) => <li key={s.id}>{s.user_id ? '✅' : '⏳'} {s.name}</li>)}
            </ul>
            <p>{missing > 0 ? `Esperando a ${missing} más…` : 'Todos dentro: la partida empieza ahora…'}</p>
            {startErr && <p className="msg">Error al empezar: {startErr}</p>}
          </>
        )}
        {room.status === 'question' && cur && (
          <>
            <p>Pregunta {room.current_order + 1} de {room.total_questions} · ⏱ {left}s · Respondieron {answered}/{players.length}</p>
            <Options q={cur} />
          </>
        )}
        {room.status === 'reveal' && cur && (
          <>
            <Options q={cur} ok={ok} />
            <h3>Así ha ido</h3>
            <Reveal players={players} answers={answers} qid={cur.id} />
            <p>Siguiente pregunta en unos segundos…</p>
          </>
        )}
        {room.status === 'finished' && <Summary players={players} answers={answers} me={null} />}
      </div>
    </>
  )
}

export function Play({ roomId, user, exit }) {
  const { room, players, slots } = useRoom(roomId)
  const allIn = slots.length > 0 && slots.every((s) => s.user_id)
  const cur = useQuestion(room)
  const ok = useCorrect(room)
  const left = useLeft(room)
  const answers = useRoomAnswers(room)
  const [picked, setPicked] = useState(null)
  useEffect(() => { setPicked(null) }, [room?.current_order])

  useGameTimers(room, left, null, players.length)
  useEffect(() => {
    if (room?.status === 'lobby' && room.review_status === 'approved' && allIn)
      supabase.rpc('start_game', { p_room_id: roomId })
  }, [room?.status, room?.review_status, allIn])

  async function pick(i) {
    setPicked(i)
    const { error } = await supabase.rpc('submit_answer', { p_room_id: roomId, p_chosen: i })
    if (error) { alert(error.message); setPicked(null) }
  }

  if (!room) return <p className="center">Cargando…</p>
  return (
    <>
      <button className="ghost" onClick={exit}>← Salir</button>
      <div className="card">
        {room.status === 'lobby' && (
          <>
            <h2>Sala {room.code}</h2>
            {allIn
              ? <p>¡Ya estáis todos! La partida empieza ahora…</p>
              : <p>Esperando a que entren todos…</p>}
            {startErr && <p className="msg">Error al empezar: {startErr}</p>}
            <ul className="list">{players.map((p) => <li key={p.user_id}>{p.nickname}</li>)}</ul>
          </>
        )}
        {room.status === 'question' && (cur ? (
          <>
            <p>⏱ {left}s {picked != null && '· Respuesta enviada, esperando al resto…'}</p>
            <Options q={cur} onPick={pick} picked={picked} />
          </>
        ) : <p>Cargando pregunta…</p>)}
        {room.status === 'reveal' && cur && (
          <>
            <h2>{picked == null ? '⏰ No respondiste' : picked === ok ? '✅ ¡Correcto!' : '❌ Fallaste'}</h2>
            <Options q={cur} ok={ok} picked={picked} />
            <h3>Así ha ido</h3>
            <Reveal players={players} answers={answers} qid={cur.id} />
            <p>Siguiente pregunta en unos segundos…</p>
          </>
        )}
        {room.status === 'finished' && <Summary players={players} answers={answers} me={user.id} />}
      </div>
    </>
  )
}

// Entrada por enlace: sesion anonima, elegir nombre de la lista y jugar
export function Link({ token }) {
  const [me, setMe] = useState(null)
  const [info, setInfo] = useState(undefined) // undefined = cargando, null = enlace caducado
  const [roomId, setRoomId] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    const { data, error } = await supabase.rpc('room_by_token', { p_token: token })
    if (error) return setError(error.message)
    setInfo(data)
    if (data?.slots.some((s) => s.mine)) setRoomId(data.id)
  }

  useEffect(() => {
    (async () => {
      const { data: s } = await supabase.auth.getSession()
      let user = s.session?.user
      if (!user) {
        const { data, error } = await supabase.auth.signInAnonymously()
        if (error) return setError('No se pudo entrar a la sala: ' + error.message)
        user = data.user
      }
      setMe(user)
      load()
    })()
  }, [token])

  async function claim(slot) {
    setError('')
    const { data, error } = await supabase.rpc('claim_slot', { p_token: token, p_slot_id: slot.id })
    if (error) return setError(error.message)
    setRoomId(data)
    load()
  }

  if (error) return <div className="card"><p className="msg">{error}</p></div>
  if (!me || info === undefined) return <p className="center">Cargando…</p>
  if (info === null) return <div className="card"><h2>Este enlace ya no está activo</h2><p>La partida ha terminado o el enlace ha caducado.</p></div>
  if (roomId) return <Play roomId={roomId} user={me} exit={() => { window.location.href = '/' }} />
  if (info.status !== 'lobby') return <div className="card"><p>La partida ya ha empezado. Pide un enlace nuevo al game master si te has quedado fuera.</p></div>

  return (
    <div className="card">
      <h2>¿Quién eres?</h2>
      <p>Pulsa tu nombre de la lista.</p>
      <ul className="list">
        {info.slots.map((s) => (
          <li key={s.id} className="row">
            <span style={{ flex: 1 }}>{s.name}</span>
            {s.taken
              ? <small>{s.mine ? 'Eres tú' : 'Ya elegido'}</small>
              : <button onClick={() => claim(s)}>Soy yo</button>}
          </li>
        ))}
      </ul>
      <p><small>Máximo {MAX_PLAYERS} participantes.</small></p>
    </div>
  )
}

export function Importer({ pack, qs, reload }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  async function run() {
    const blocks = text.split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length)
    const parsed = []
    for (const [i, b] of blocks.entries()) {
      const [prompt, ...raw] = b
      const correct = raw.findIndex((o) => o.startsWith('*'))
      const options = raw.map((o) => o.replace(/^\*/, '').trim())
      if (![2, 4].includes(options.length) || correct < 0) return alert(`Pregunta ${i + 1}: necesita 2 o 4 opciones y una marcada con *`)
      parsed.push({ prompt, options, correct })
    }
    if (!parsed.length) return
    setBusy(true)
    let order = qs.length ? Math.max(...qs.map((q) => q.sort_order)) + 1 : 0
    for (const p of parsed) {
      const { data: q, error } = await supabase.from('questions')
        .insert({ pack_id: pack.id, sort_order: order++, kind: p.options.length === 4 ? 'multiple' : 'truefalse', prompt: p.prompt, options: p.options })
        .select().single()
      if (error) { alert(error.message); break }
      const { error: e2 } = await supabase.from('question_keys').insert({ question_id: q.id, correct_index: p.correct })
      if (e2) { await supabase.from('questions').delete().eq('id', q.id); alert(e2.message); break }
    }
    setBusy(false)
    setText('')
    reload()
  }
  return (
    <details className="card">
      <summary><b>📋 Importar muchas preguntas de golpe</b></summary>
      <p><small>Una pregunta por bloque, separados por una línea en blanco. Primera línea = pregunta; después las opciones (4 para test, 2 para verdadero/falso). Marca la correcta con * delante.</small></p>
      <pre>{'¿Dónde nos conocimos?\n*En la uni\nEn un viaje\nEn el trabajo\nEn un bar\n\nNos perdimos en Roma\n*Verdadero\nFalso'}</pre>
      <textarea rows={10} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} />
      <button disabled={busy} onClick={run}>{busy ? 'Importando…' : 'Importar'}</button>
    </details>
  )
}
