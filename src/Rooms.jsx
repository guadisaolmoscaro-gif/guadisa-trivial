import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { EventsCard } from './Events.jsx'

const CONTEXT_MIN = 200
const CONTEXT_MAX = 12000

const STATE = {
  generating: { label: '⏳ Generando preguntas', tone: 'wait' },
  pending: { label: '🔎 En revisión', tone: 'wait' },
  approved: { label: '✅ Lista para jugar', tone: 'ok' },
  rejected: { label: '❌ Rechazada', tone: 'bad' },
  failed: { label: '⚠️ No se pudieron generar las preguntas', tone: 'bad' },
}

const roomLink = (room) => `${window.location.origin}/?s=${room.invite_token}`

// Asistente para crear una sala en 4 pasos
function NewRoomWizard({ onDone, onCancel }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [names, setNames] = useState('')
  const [length, setLength] = useState(15)
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const list = names.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean)
  const uniq = new Set(list.map((n) => n.toLowerCase())).size

  const checks = [
    () => {
      if (!name.trim()) return 'Ponle un nombre a la sala'
      if (list.length < 2) return 'Escribe al menos 2 participantes'
      if (list.length > 8) return 'Como máximo 8 participantes'
      if (uniq !== list.length) return 'Hay nombres repetidos'
      return ''
    },
    () => '',
    () => (context.trim().length < CONTEXT_MIN ? `Cuenta un poco más (mínimo ${CONTEXT_MIN} caracteres)` : ''),
  ]

  function next() {
    const problem = checks[step]()
    setErr(problem)
    if (!problem) setStep(step + 1)
  }

  async function create() {
    setBusy(true)
    setErr('')
    const { data: id, error } = await supabase.rpc('create_room_request', {
      p_name: name.trim(), p_length: Number(length), p_names: list, p_context: context.trim(),
    })
    if (error) { setBusy(false); return setErr(error.message) }
    const { error: e2 } = await supabase.functions.invoke('generate-room', { body: { room_id: id } })
    setBusy(false)
    if (e2) return setErr('La sala está creada, pero no se han podido empezar las preguntas: ' + e2.message)
    onDone()
  }

  return (
    <div className="card wizard">
      <p className="steps">Paso {step + 1} de 4</p>
      <div className="bar"><div style={{ width: `${((step + 1) / 4) * 100}%` }} /></div>

      {step === 0 && (
        <>
          <h2>¿Cómo se llama la fiesta?</h2>
          <input placeholder="Ej. Cumple de Isa" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
          <h3>¿Quién juega?</h3>
          <textarea rows={4} style={{ width: '100%' }} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Isa\nMarta\nCarlos'} />
          <small>{list.length} de 8 · uno por línea o separados por comas</small>
        </>
      )}

      {step === 1 && (
        <>
          <h2>¿Cuánto queréis jugar?</h2>
          <div className="choices">
            {[[15, 'Rápida', '15 preguntas'], [30, 'Media', '30 preguntas'], [50, 'Larga', '50 preguntas']].map(([n, t, s]) => (
              <button key={n} type="button" className={`choice ${Number(length) === n ? 'on' : ''}`} onClick={() => setLength(n)}>
                <b>{t}</b><span>{s}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h2>Cuéntanos del grupo</h2>
          <p><small>Anécdotas, apodos, viajes, gustos, manías… Cuanto más detalle, mejores preguntas.</small></p>
          <textarea rows={12} style={{ width: '100%' }} value={context} onChange={(e) => setContext(e.target.value)} maxLength={CONTEXT_MAX} placeholder="Escribe aquí…" />
          <small>{context.length} / {CONTEXT_MAX}</small>
        </>
      )}

      {step === 3 && (
        <>
          <h2>Todo listo</h2>
          <ul className="summary">
            <li><b>Sala:</b> {name}</li>
            <li><b>Jugadores:</b> {list.join(', ')}</li>
            <li><b>Duración:</b> {length} preguntas</li>
          </ul>
          <p><small>Las preguntas se preparan en 1-3 minutos. Después las revisa el webmaster y, cuando estén listas, te aparece el enlace para WhatsApp.</small></p>
        </>
      )}

      {err && <p className="msg">{err}</p>}

      <p className="row between">
        {step === 0 ? <button className="ghost dark" onClick={onCancel}>Cancelar</button> : <button className="ghost dark" onClick={() => { setErr(''); setStep(step - 1) }}>← Atrás</button>}
        {step < 3
          ? <button onClick={next}>Siguiente →</button>
          : <button disabled={busy} onClick={create}>{busy ? 'Creando…' : 'Crear sala'}</button>}
      </p>
    </div>
  )
}

// Tarjetas de mis salas con su estado y el enlace cuando ya está lista
function MyRooms({ user, openRoom, refreshKey }) {
  const [rooms, setRooms] = useState([])
  const [copied, setCopied] = useState('')
  const load = async () => {
    const { data } = await supabase.from('rooms').select('*').eq('host_id', user.id).order('created_at', { ascending: false })
    setRooms(data || [])
  }
  useEffect(() => { load() }, [refreshKey])
  useEffect(() => {
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  async function copy(room) {
    try { await navigator.clipboard.writeText(roomLink(room)); setCopied(room.id); setTimeout(() => setCopied(''), 1500) } catch { window.prompt('Copia el enlace:', roomLink(room)) }
  }

  async function remove(room) {
    if (!confirm(`¿Borrar la partida «${room.name || 'sin nombre'}»? Se borran también sus preguntas y sus jugadores.`)) return
    const { error } = await supabase.rpc('delete_room', { p_room_id: room.id })
    if (error) return alert(error.message)
    load()
  }

  if (!rooms.length) return <p className="empty">Aún no has creado ninguna partida.</p>
  return (
    <div className="rooms">
      {rooms.map((r) => {
        const st = STATE[r.review_status] || { label: r.review_status, tone: 'wait' }
        return (
          <div key={r.id} className={`room ${st.tone}`}>
            <div className="room-head">
              <b className="room-name">{r.name || 'Partida sin nombre'}</b>
              <span className={`chip ${st.tone}`}>{st.label}</span>
            </div>
            <small>{r.total_questions} preguntas · {r.status === 'lobby' ? 'esperando jugadores' : r.status === 'finished' ? 'terminada' : 'en juego'}</small>
            <p className="row">
              {r.review_status === 'approved' && (
                <>
                  <button onClick={() => copy(r)}>{copied === r.id ? '✔ Enlace copiado' : '📋 Copiar enlace'}</button>
                  <button className="ghost dark" onClick={() => openRoom(r)}>Ver partida</button>
                </>
              )}
              <button className="ghost dark" onClick={() => remove(r)}>🗑 Borrar</button>
            </p>
          </div>
        )
      })}
    </div>
  )
}

// Webmaster: revisar las preguntas, quitar las que no valgan, aprobar o rechazar
export function Review() {
  const [rooms, setRooms] = useState([])
  const [removed, setRemoved] = useState({})
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

  if (!rooms.length) return <p className="empty">No hay partidas esperando revisión.</p>
  return (
    <>
      <div className="card">
        <p><b>¿Qué es esto?</b> Cuando alguien crea una partida, la IA escribe las preguntas y sus respuestas a partir del texto del grupo. Aquí las revisas antes de que se pueda jugar: quitas las que no tengan sentido o tengan una respuesta equivocada, y luego pulsas <b>Aprobar</b>. Si la partida no vale, pulsa <b>Rechazar</b>.</p>
      </div>
      {rooms.map((room) => {
        const left = room.questions.filter((q) => !removed[room.id]?.[q.id]).length
        return (
          <div key={room.id} className="card">
            <h2>{room.name}</h2>
            <p><small>Marca con la casilla las preguntas que quieras quitar. Quedarán {left}.</small></p>
            {room.questions.map((q, i) => (
              <div key={q.id} className="qrev" style={{ opacity: removed[room.id]?.[q.id] ? 0.4 : 1 }}>
                <label className="row">
                  <input type="checkbox" checked={!!removed[room.id]?.[q.id]} onChange={() => toggle(room.id, q.id)} />
                  <b>{i + 1}. {q.prompt}</b>
                </label>
                {q.options.map((o, k) => (
                  <div key={k} className={k === q.correct ? 'right' : 'wrong'}>{k === q.correct ? '✔ ' : '· '}{o}</div>
                ))}
              </div>
            ))}
            <p className="row between">
              <button disabled={busy} onClick={() => decide(room, true)}>✅ Aprobar sala</button>
              <button className="ghost dark" disabled={busy} onClick={() => decide(room, false)}>Rechazar</button>
            </p>
          </div>
        )
      })}
    </>
  )
}

// Pestaña Salas: crear, ver el estado y compartir
export function SalasTab({ user, openRoom }) {
  const [creating, setCreating] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  return (
    <>
      {creating
        ? <NewRoomWizard onDone={() => { setCreating(false); setRefreshKey((k) => k + 1) }} onCancel={() => setCreating(false)} />
        : (
          <div className="card hero">
            <h2>Tus partidas</h2>
            <button onClick={() => setCreating(true)}>＋ Nueva partida</button>
          </div>
        )}
      <MyRooms user={user} openRoom={openRoom} refreshKey={refreshKey} />
      <details className="card">
        <summary><b>💌 Quedadas sorpresa</b></summary>
        <EventsCard onPackCreated={() => {}} />
      </details>
    </>
  )
}
