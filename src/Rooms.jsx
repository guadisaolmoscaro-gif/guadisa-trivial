import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const STATUS = {
  generating: '⏳ Generando preguntas… (tarda unos minutos)',
  pending: '🔎 En revisión por el webmaster',
  approved: '✅ Aprobada: pulsa para ver el enlace',
  rejected: '❌ Rechazada',
  failed: '⚠️ No se pudieron generar las preguntas. Crea la sala de nuevo.',
}

// Crear una sala nueva: nombres, duración y contexto del grupo
function NewRoom({ onCreated }) {
  const [name, setName] = useState('')
  const [names, setNames] = useState('')
  const [length, setLength] = useState(15)
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)

  async function create(e) {
    e.preventDefault()
    setBusy(true)
    const list = names.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean)
    const { data: id, error } = await supabase.rpc('create_room_request', {
      p_name: name, p_length: Number(length), p_names: list, p_context: context,
    })
    if (error) { setBusy(false); return alert(error.message) }

    const { error: e2 } = await supabase.functions.invoke('generate-room', { body: { room_id: id } })
    setBusy(false)
    if (e2) alert('La sala está creada, pero no se han podido empezar a generar las preguntas: ' + e2.message)
    setName(''); setNames(''); setContext('')
    onCreated?.()
  }

  return (
    <form className="card" onSubmit={create}>
      <h2>Nueva sala</h2>
      <input placeholder="Nombre de la sala (ej. Cumple de Isa)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
      <p>Participantes (2 a 8, uno por línea o separados por comas):</p>
      <textarea rows={3} style={{ width: '100%' }} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Isa\nMarta\nCarlos'} required />
      <p>Duración: <select value={length} onChange={(e) => setLength(e.target.value)} style={{ width: 200 }}>
        <option value={15}>Rápida (15 preguntas)</option>
        <option value={30}>Media (30 preguntas)</option>
        <option value={50}>Larga (50 preguntas)</option>
      </select></p>
      <p>Cuenta todo lo que sepas del grupo: anécdotas, apodos, viajes, gustos, manías… Cuanto más detalle, mejores preguntas.</p>
      <textarea rows={12} style={{ width: '100%' }} value={context} onChange={(e) => setContext(e.target.value)} maxLength={12000} required placeholder="Escribe aquí el contexto del grupo…" />
      <small>{context.length} / 12000 caracteres (mínimo 200)</small>
      <p><button disabled={busy}>{busy ? 'Creando…' : 'Crear sala'}</button></p>
    </form>
  )
}

// Mis salas: estado de cada una y acceso al enlace cuando esta aprobada
function MyRooms({ user, openRoom, refreshKey }) {
  const [rooms, setRooms] = useState([])
  const load = async () => {
    const { data } = await supabase.from('rooms').select('*').eq('host_id', user.id).order('created_at', { ascending: false })
    setRooms(data || [])
  }
  useEffect(() => { load() }, [refreshKey])
  useEffect(() => {
    const t = setInterval(load, 5000) // para ver cuando cambia el estado de revision
    return () => clearInterval(t)
  }, [])

  return (
    <div className="card">
      <h2>Mis salas ({rooms.length}/5)</h2>
      <ul className="list">
        {rooms.map((r) => (
          <li key={r.id} className="row">
            <span style={{ flex: 1 }}>
              <b>{r.name || 'Sala'}</b><br />
              <small>{STATUS[r.review_status] || r.review_status}</small>
            </span>
            {r.review_status === 'approved' && <button onClick={() => openRoom(r)}>Ver enlace</button>}
          </li>
        ))}
        {!rooms.length && <li>Aún no tienes salas.</li>}
      </ul>
    </div>
  )
}

// Webmaster: revisar las preguntas, quitar las que no valgan, aprobar o rechazar
function Review() {
  const [rooms, setRooms] = useState([])
  const [removed, setRemoved] = useState({}) // { [roomId]: { [questionId]: true } }
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const { data, error } = await supabase.rpc('review_list')
    if (error) return alert(error.message)
    setRooms(data || [])
  }
  useEffect(() => { load() }, [])

  const toggle = (roomId, qid) => setRemoved((r) => ({
    ...r,
    [roomId]: { ...(r[roomId] || {}), [qid]: !r[roomId]?.[qid] },
  }))

  async function decide(room, approve) {
    const remove = Object.keys(removed[room.id] || {}).filter((id) => removed[room.id][id])
    setBusy(true)
    const { error } = await supabase.rpc('review_decide', { p_room_id: room.id, p_approve: approve, p_remove: remove })
    setBusy(false)
    if (error) return alert(error.message)
    load()
  }

  return (
    <div className="card">
      <h2>🔎 Revisión de salas</h2>
      {!rooms.length && <p>No hay salas pendientes.</p>}
      {rooms.map((room) => {
        const left = room.questions.filter((q) => !removed[room.id]?.[q.id]).length
        return (
          <div key={room.id} className="draft">
            <h3>{room.name} · {room.questions.length} preguntas generadas</h3>
            <p><small>Marca con ✖ las preguntas que no quieres. Quedarán {left}.</small></p>
            {room.questions.map((q, i) => (
              <div key={q.id} style={{ opacity: removed[room.id]?.[q.id] ? 0.4 : 1, marginBottom: 8 }}>
                <label className="row">
                  <input type="checkbox" checked={!!removed[room.id]?.[q.id]} onChange={() => toggle(room.id, q.id)} />
                  <b>{i + 1}. {q.prompt}</b>
                </label>
                {q.options.map((o, k) => (
                  <div key={k} style={{ fontWeight: k === q.correct ? 800 : 400 }}>
                    {k === q.correct ? '✔ ' : '· '}{o}
                  </div>
                ))}
              </div>
            ))}
            <p className="row">
              <button disabled={busy} onClick={() => decide(room, true)}>Aprobar sala</button>
              <button className="ghost dark" disabled={busy} onClick={() => decide(room, false)}>Rechazar</button>
            </p>
          </div>
        )
      })}
    </div>
  )
}

// Pantalla principal del game master (y del webmaster, si lo es)
export function Home({ user, openRoom }) {
  const [wm, setWm] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    supabase.from('profiles').select('is_webmaster').eq('id', user.id).single()
      .then(({ data }) => setWm(!!data?.is_webmaster))
  }, [user.id])
  return (
    <>
      <NewRoom onCreated={() => setRefreshKey((k) => k + 1)} />
      <MyRooms user={user} openRoom={openRoom} refreshKey={refreshKey} />
      {wm && <Review />}
    </>
  )
}
