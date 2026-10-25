import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

const COLORS = ['c-red', 'c-blue', 'c-yellow', 'c-green']
const BUCKET = 'question-images'

function useRoom(id) {
  const [room, setRoom] = useState(null)
  const [players, setPlayers] = useState([])
  const load = async () => {
    const { data: r } = await supabase.from('rooms').select('*').eq('id', id).single()
    const { data: p } = await supabase.from('room_players').select('*').eq('room_id', id).order('score', { ascending: false })
    setRoom(r)
    setPlayers(p || [])
  }
  useEffect(() => {
    load()
    const ch = supabase.channel('room-' + id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${id}` }, load)
      .subscribe()
    const t = setInterval(load, 3000) // respaldo por si falla el tiempo real
    return () => { supabase.removeChannel(ch); clearInterval(t) }
  }, [id])
  return { room, players }
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

function Ranking({ players, me }) {
  return (
    <ol className="list">
      {players.map((p, i) => (
        <li key={p.user_id} style={{ fontWeight: p.user_id === me ? 800 : 400 }}>
          {['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {p.nickname} — {p.score} pts
        </li>
      ))}
    </ol>
  )
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

export function Host({ room: first, exit }) {
  const { room, players } = useRoom(first.id)
  const cur = useQuestion(room)
  const ok = useCorrect(room)
  const left = useLeft(room)
  const [answered, setAnswered] = useState(0)
  const busy = useRef(false)

  const call = async (fn) => {
    if (busy.current) return
    busy.current = true
    const { error } = await supabase.rpc(fn, { p_room_id: first.id })
    busy.current = false
    if (error) alert(error.message)
  }

  useEffect(() => {
    setAnswered(0)
    if (room?.status !== 'question' || !cur) return
    const f = async () => {
      const { count } = await supabase.from('answers').select('*', { count: 'exact', head: true }).eq('room_id', room.id).eq('question_id', cur.id)
      setAnswered(count || 0)
    }
    f()
    const t = setInterval(f, 1500)
    return () => clearInterval(t)
  }, [room?.status, cur?.id])

  useEffect(() => {
    if (room?.status !== 'question' || !cur) return
    if (players.length && answered >= players.length) { call('reveal_question'); return }
    if (left === 0) {
      const t = setTimeout(() => call('reveal_question'), 1500)
      return () => clearTimeout(t)
    }
  }, [room?.status, cur?.id, left, answered, players.length])

  if (!room) return <p className="center">Cargando…</p>
  const last = room.current_order + 1 >= room.total_questions
  return (
    <>
      <button className="ghost" onClick={exit}>← Salir</button>
      <div className="card">
        {room.status === 'lobby' && (
          <>
            <p>Código de la sala:</p>
            <div className="code">{room.code}</div>
            <p>Jugadores ({players.length}/8):</p>
            <ul className="list">{players.map((p) => <li key={p.user_id}>{p.nickname}</li>)}</ul>
            <button disabled={!players.length} onClick={() => call('next_question')}>Empezar partida</button>
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
            <h3>Ranking</h3>
            <Ranking players={players} />
            <button onClick={() => call('next_question')}>{last ? 'Ver resultado final' : 'Siguiente pregunta'}</button>
          </>
        )}
        {room.status === 'finished' && (
          <>
            <h2>🏆 ¡Fin de la partida!</h2>
            <Ranking players={players} />
          </>
        )}
      </div>
    </>
  )
}

export function Play({ roomId, user, exit }) {
  const { room, players } = useRoom(roomId)
  const cur = useQuestion(room)
  const ok = useCorrect(room)
  const left = useLeft(room)
  const [picked, setPicked] = useState(null)
  useEffect(() => { setPicked(null) }, [room?.current_order])

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
            <p>Esperando a que el anfitrión empiece…</p>
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
            <h3>Ranking</h3>
            <Ranking players={players} me={user.id} />
            <p>Esperando la siguiente pregunta…</p>
          </>
        )}
        {room.status === 'finished' && (
          <>
            <h2>🏆 ¡Fin de la partida!</h2>
            <Ranking players={players} me={user.id} />
          </>
        )}
      </div>
    </>
  )
}

export function Join({ go }) {
  const [code, setCode] = useState('')
  const [nick, setNick] = useState('')
  async function join(e) {
    e.preventDefault()
    const { data, error } = await supabase.rpc('join_room', { p_code: code, p_nickname: nick })
    if (error) return alert(error.message)
    go({ play: data })
  }
  return (
    <div className="card">
      <h2>Unirme a una sala</h2>
      <form onSubmit={join}>
        <input placeholder="Código de sala" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={5} required />
        <input placeholder="Tu apodo" value={nick} onChange={(e) => setNick(e.target.value)} maxLength={20} required />
        <button>Entrar</button>
      </form>
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
