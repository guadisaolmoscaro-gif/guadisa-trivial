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
    // Solo Trivial Amigos tiene respuesta correcta; La Vaca y Empatia no
    if (room && (room.game_type ?? 'trivial') === 'trivial' && ['reveal', 'finished'].includes(room.status))
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

// Todas las preguntas de la partida: solo se piden al final, para el resumen
function useAllQuestions(room) {
  const [qs, setQs] = useState([])
  useEffect(() => {
    if (!room || room.status !== 'finished') return
    supabase.from('questions').select('id, sort_order, prompt, options').eq('pack_id', room.pack_id).order('sort_order')
      .then(({ data }) => setQs(data || []))
  }, [room?.id, room?.status])
  return qs
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
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!room) return
    const rpc = (fn) => supabase.rpc(fn, { p_room_id: room.id }).then(({ error }) => setErr(error ? `${fn}: ${error.message}` : ''))
    if (room.status === 'question') {
      // El servidor decide cuando cerrar (todos han contestado o se acabo el tiempo).
      // Cada movil lo pide cada segundo, asi no depende de su reloj.
      const allIn = answered != null && playersCount > 0 && answered >= playersCount
      if (allIn) rpc('close_question')
      const t = setInterval(() => rpc('close_question'), 1000)
      return () => clearInterval(t)
    }
    if (room.status === 'reveal') {
      const t = setInterval(() => rpc('advance_room'), 1000)
      return () => clearInterval(t)
    }
  }, [room?.status, room?.current_order, answered, playersCount])
  return err
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

// La Vaca: quien estuvo con la mayoria, empate o minoria
function RevealVaca({ players, answers, qid, options }) {
  const mine = answers.filter((a) => a.question_id === qid)
  return (
    <ul className="list">
      {players.map((p) => {
        const a = mine.find((x) => x.user_id === p.user_id)
        if (!a) return <li key={p.user_id}>⏱ {p.nickname} · no contestó</li>
        const eligio = options?.[a.chosen_index] ? ` · eligió «${options[a.chosen_index]}»` : ''
        if (a.points >= 1) return <li key={p.user_id}>✅ {p.nickname}{eligio} · era la mayoría · +1</li>
        if (a.points > 0) return <li key={p.user_id}>🤝 {p.nickname}{eligio} · empate · +0,5</li>
        return <li key={p.user_id}>❌ {p.nickname}{eligio} · era minoría</li>
      })}
    </ul>
  )
}

// Empatia: cuantos votos ha tenido cada nombre y quien voto a quien
function RevealEmpatia({ players, answers, qid, options }) {
  const mine = answers.filter((a) => a.question_id === qid)
  const votes = options.map((o, i) => ({ name: o, n: mine.filter((a) => a.chosen_index === i).length }))
  const top = Math.max(0, ...votes.map((v) => v.n))
  return (
    <>
      <p><b>Votos:</b> {votes.map((v) => `${v.name} ${v.n}${v.n === top && top > 0 ? ' ⭐' : ''}`).join(' · ')}</p>
      <ul className="list">
        {players.map((p) => {
          const a = mine.find((x) => x.user_id === p.user_id)
          return <li key={p.user_id}>{a ? `${p.nickname} votó a ${options[a.chosen_index]}` : `${p.nickname} no votó`}</li>
        })}
      </ul>
    </>
  )
}

// Lo que ve todo el mundo al final de cada pregunta: quien acerto, fallo o se quedo sin tiempo
function Reveal({ players, answers, qid, game, options }) {
  if (game === 'vaca') return <RevealVaca players={players} answers={answers} qid={qid} options={options} />
  if (game === 'empatia' || game === 'amor') return <Waiting players={players} answers={answers} qid={qid} />
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
// Empatia: no hay ganador; cada uno ve cuantas veces coincidio con la mayoria
function SummaryEmpatia({ players, answers, me, total, questions }) {
  const majority = {}
  for (const qid of new Set(answers.map((a) => a.question_id))) {
    const counts = {}
    answers.filter((a) => a.question_id === qid).forEach((a) => { counts[a.chosen_index] = (counts[a.chosen_index] || 0) + 1 })
    const top = Math.max(...Object.values(counts))
    majority[qid] = new Set(Object.keys(counts).filter((k) => counts[k] === top).map(Number))
  }
  const rows = players.map((p) => ({
    ...p,
    hits: answers.filter((a) => a.user_id === p.user_id && majority[a.question_id]?.has(a.chosen_index)).length,
  }))
  return (
    <>
      <h2>🧠 Fin de la partida</h2>
      <p>No hay ganador: esto era para conoceros mejor.</p>
      <h3>Así de bien os conocéis</h3>
      <ul className="list">
        {rows.map((r) => (
          <li key={r.user_id} style={{ fontWeight: r.user_id === me ? 800 : 400 }}>
            {r.nickname}: coincidiste con la mayoría en {r.hits} de {total}
          </li>
        ))}
      </ul>
      <h3>Lo que habéis votado</h3>
      <ol className="list">
        {questions.map((q) => {
          const mine = answers.filter((a) => a.question_id === q.id)
          const votes = q.options.map((o, i) => ({ name: o, n: mine.filter((a) => a.chosen_index === i).length }))
          const top = Math.max(0, ...votes.map((v) => v.n))
          return (
            <li key={q.id}>
              <b>{q.prompt}</b><br />
              <small>{votes.map((v) => `${v.name} ${v.n}${v.n === top && top > 0 ? ' ⭐' : ''}`).join(' · ')}</small>
            </li>
          )
        })}
      </ol>
    </>
  )
}

// Empatia y Compatibilidad: durante la partida no se ve lo que contestan, solo quien ya ha contestado
function Waiting({ players, answers, qid }) {
  const mine = answers.filter((a) => a.question_id === qid)
  return (
    <>
      <p><small>Respuesta guardada. Lo que contestáis sale al final de la partida.</small></p>
      <ul className="list">
        {players.map((p) => <li key={p.user_id}>{mine.some((a) => a.user_id === p.user_id) ? '✔' : '⏳'} {p.nickname}</li>)}
      </ul>
    </>
  )
}

// Signos del zodiaco y su elemento: 0 fuego, 1 tierra, 2 aire, 3 agua
const SIGNS = ['Aries', 'Tauro', 'Géminis', 'Cáncer', 'Leo', 'Virgo', 'Libra', 'Escorpio', 'Sagitario', 'Capricornio', 'Acuario', 'Piscis']
const ELEMENT = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]

// Puntuacion 0-100 de dos signos segun la regla clasica de elementos (no hay una tabla unica en internet)
function zodiacScore(i, j) {
  if (i === j) return 85
  const a = ELEMENT[i]
  const b = ELEMENT[j]
  if (a === b) return 90
  const sum = a + b
  if (sum === 2 || sum === 4) return 75 // fuego-aire o tierra-agua: se llevan bien
  if (sum === 1 || sum === 5) return 45 // fuego-tierra o aire-agua: neutros
  return 30 // fuego-agua o aire-tierra: opuestos
}

// Compatibilidad amorosa: texto según el porcentaje
const verdict = (p) => p >= 80 ? '💍 ¡Ya tenéis hasta el nombre de los hijos!'
  : p >= 60 ? '💕 Muy buena química. Peligro de cita doble.'
  : p >= 40 ? '😉 Hay chispa. Hay que cuidarla.'
  : p >= 20 ? '🤝 Mejor como amigos… de momento.'
  : '🧊 Ni la quedada os salvaría.'

// Compatibilidad amorosa: respuestas de cada uno y una barra por pareja
function SummaryAmor({ players, answers, questions }) {
  // La pregunta de signo es la primera (sort_order 0): con ella se calcula la parte de signos
  const signQ = questions.find((q) => q.sort_order === 0 && q.options.length === 12)
  const restQ = questions.filter((q) => q !== signQ)
  const pick = (uid, qid) => answers.find((x) => x.user_id === uid && x.question_id === qid)?.chosen_index ?? null
  const byPlayer = players.map((p) => ({
    p,
    sign: signQ ? pick(p.user_id, signQ.id) : null,
    picks: restQ.map((q) => pick(p.user_id, q.id)),
  }))
  const pairs = []
  for (let i = 0; i < byPlayer.length; i++) {
    for (let j = i + 1; j < byPlayer.length; j++) {
      let common = 0
      let same = 0
      byPlayer[i].picks.forEach((x, k) => {
        const y = byPlayer[j].picks[k]
        if (x !== null && y !== null) { common++; if (x === y) same++ }
      })
      const answersPct = common ? (same / common) * 100 : 0
      const si = byPlayer[i].sign
      const sj = byPlayer[j].sign
      const hasSigns = si !== null && sj !== null
      const signsPct = hasSigns ? zodiacScore(si, sj) : null
      const pct = Math.round(hasSigns ? answersPct * 0.5 + signsPct * 0.5 : answersPct)
      pairs.push({
        a: byPlayer[i].p.nickname,
        b: byPlayer[j].p.nickname,
        pct,
        signs: hasSigns ? `${SIGNS[si]} y ${SIGNS[sj]}` : null,
      })
    }
  }
  pairs.sort((x, y) => y.pct - x.pct)
  return (
    <>
      <h2>💘 Compatibilidad</h2>
      {pairs.map((pr) => {
        const f = Math.round(pr.pct / 10)
        return (
          <div key={pr.a + pr.b} className="compat">
            <b>{pr.a} y {pr.b}</b>
            <div className="bar-fire">{'█'.repeat(f)}{'░'.repeat(10 - f)} {pr.pct}% 🔥</div>
            <small>{pr.signs ? `${pr.signs} · ` : ''}{verdict(pr.pct)}</small>
          </div>
        )
      })}
      <h3>Las respuestas de cada uno</h3>
      {byPlayer.map(({ p, sign, picks }) => (
        <details key={p.user_id} className="card-in">
          <summary><b>{p.nickname}</b>{sign !== null ? ` · ${SIGNS[sign]}` : ''}</summary>
          <ol>
            {restQ.map((q, k) => <li key={q.id}>{q.prompt} <b>→ {picks[k] !== null ? q.options[picks[k]] : '—'}</b></li>)}
          </ol>
        </details>
      ))}
    </>
  )
}

function Summary({ players, answers, me, game, total, questions }) {
  if (game === 'empatia') return <SummaryEmpatia players={players} answers={answers} me={me} total={total} questions={questions} />
  if (game === 'amor') return <SummaryAmor players={players} answers={answers} questions={questions} />
  const vaca = game === 'vaca'
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
            {['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {r.nickname} — {r.score} pts · {r.hits} {vaca ? 'con la mayoría' : 'aciertos'}{vaca ? '' : ` · ${(r.ms / 1000).toFixed(1)} s`}
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
  const allQs = useAllQuestions(room)
  const answered = useAnsweredCount(room, cur)
  const busy = useRef(false)
  const [copied, setCopied] = useState(false)

  const timerErr = useGameTimers(room, left, answered, players.length)

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
            <Reveal players={players} answers={answers} qid={cur.id} game={room.game_type} options={cur.options} />
            <p>Siguiente pregunta en unos segundos…</p>
          </>
        )}
        {room.status === 'finished' && <Summary players={players} answers={answers} me={null} game={room.game_type} total={room.total_questions} questions={allQs} />}
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
  const allQs = useAllQuestions(room)
  const [picked, setPicked] = useState(null)
  useEffect(() => { setPicked(null) }, [room?.current_order])

  const timerErr = useGameTimers(room, left, null, players.length)
  const [startErr, setStartErr] = useState('')
  useEffect(() => {
    if (room?.status === 'lobby' && room.review_status === 'approved' && allIn)
      supabase.rpc('start_game', { p_room_id: roomId }).then(({ error }) => setStartErr(error?.message || ''))
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
        {timerErr && <p className="msg">Error del servidor → {timerErr}</p>}
        {room.status === 'question' && (cur ? (
          <>
            <p>⏱ {left}s {picked != null && '· Respuesta enviada, esperando al resto…'}</p>
            <Options q={cur} onPick={pick} picked={picked} />
          </>
        ) : <p>Cargando pregunta…</p>)}
        {room.status === 'reveal' && cur && (
          <>
            <h2>{room.game_type !== 'trivial'
              ? (picked == null ? '⏰ No respondiste' : '✔ Respuesta enviada')
              : (picked == null ? '⏰ No respondiste' : picked === ok ? '✅ ¡Correcto!' : '❌ Fallaste')}</h2>
            {ok != null && picked !== ok && <p><b>La respuesta correcta es: {cur.options[ok]}</b></p>}
            <Options q={cur} ok={ok} picked={picked} />
            <h3>Así ha ido</h3>
            <Reveal players={players} answers={answers} qid={cur.id} game={room.game_type} options={cur.options} />
            <p>Siguiente pregunta en unos segundos…</p>
          </>
        )}
        {room.status === 'finished' && <Summary players={players} answers={answers} me={user.id} game={room.game_type} total={room.total_questions} questions={allQs} />}
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
