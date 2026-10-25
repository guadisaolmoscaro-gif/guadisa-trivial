import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'

// Plantillas de pregunta por tipo de dato. Sin IA: el texto del amigo se mete tal cual.
const TEMPLATES = {
  apodo: (t) => `¿A quién llaman «${t}»?`,
  mania: (t) => `¿Quién tiene esta manía? «${t}»`,
  plan: (t) => `El plan de siempre de este amigo: «${t}». ¿Quién es?`,
  cancion: (t) => `Su canción de siempre es «${t}». ¿Quién es?`,
  anecdota: (t) => `¿Quién protagonizó esto? «${t}»`,
  secreto: (t) => `Algo que casi nadie sabía: «${t}». ¿De quién es?`,
  otro: (t) => `Cuentan de alguien del grupo: «${t}». ¿De quién se trata?`,
}

// Mensajes para el anfitrión: crean expectación sin desvelar el juego.
const HYPE = [
  { when: 'Para invitarles', text: (l, t) => `¡Hola! Estoy preparando una sorpresa para «${t}» y necesito vuestra ayuda. Son 2 minutos y, chitón, que no se entere nadie 🤫 ${l}` },
  { when: 'Recordatorio a quien falta', text: (l, t) => `Todavía faltan respuestas para la sorpresa de «${t}». ¡Sin vosotros no sale! 😏 ${l}` },
  { when: 'Pista a mitad de semana', text: (_l, t) => `Una pista sobre «${t}»: id pensando en vuestros mejores recuerdos juntos… 👀` },
  { when: 'El día antes', text: (_l, t) => `Mañana es «${t}». Llevad el móvil con batería y muchas ganas de reíros 🔋🎉` },
]

function shuffle(a) {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

const linkFor = (ev) => `${window.location.origin}/?e=${ev.invite_token}`

function Copy({ text, label = 'Copiar' }) {
  const [ok, setOk] = useState(false)
  return (
    <button className="ghost dark" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500) } catch { window.prompt('Copia el texto:', text) }
    }}>{ok ? '✔ Copiado' : label}</button>
  )
}

function EventDetail({ id, back, onPackCreated }) {
  const [ev, setEv] = useState(null)
  const [facts, setFacts] = useState([])
  const [use, setUse] = useState({})
  const [showWho, setShowWho] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const { data: e } = await supabase.from('events').select('*, event_members(id, name, submitted_at)').eq('id', id).single()
    const { data: f } = await supabase.from('facts').select('*').eq('event_id', id).order('created_at')
    setEv(e)
    setFacts(f || [])
    return { e, f: f || [] }
  }
  useEffect(() => {
    load().then(({ e, f }) => {
      const names = (e?.event_members || []).map((m) => m.name.toLowerCase()).filter((n) => n.length >= 2)
      const init = {}
      for (const x of f) init[x.id] = !names.some((n) => x.text.toLowerCase().includes(n))
      setUse(init)
    })
  }, [id])

  const members = useMemo(() => ev?.event_members || [], [ev])
  const byId = (mid) => members.find((m) => m.id === mid)?.name || '?'
  const done = members.filter((m) => m.submitted_at).length

  async function reset(m) {
    if (!window.confirm(`¿Borrar las respuestas de ${m.name} y dejar que vuelva a contestar?`)) return
    const { error } = await supabase.rpc('reset_member', { p_member_id: m.id })
    if (error) return alert(error.message)
    load()
  }

  async function createPack() {
    const chosen = facts.filter((f) => use[f.id])
    if (!chosen.length) return alert('Marca al menos una respuesta para usar.')
    if (members.length < 4) return alert('Hacen falta al menos 4 personas.')
    setBusy(true)
    const { data: pack, error: e0 } = await supabase.from('packs').insert({ title: ev.title.slice(0, 80) }).select().single()
    if (e0) { setBusy(false); return alert(e0.message) }

    const built = shuffle(chosen).map((f, i) => {
      const subject = members.find((m) => m.id === f.subject_member_id)
      const opts = shuffle([subject, ...shuffle(members.filter((m) => m.id !== subject.id)).slice(0, 3)])
      return {
        row: { pack_id: pack.id, sort_order: i, kind: 'multiple', prompt: TEMPLATES[f.prompt_key](f.text).slice(0, 300), options: opts.map((m) => m.name) },
        correct: opts.findIndex((m) => m.id === subject.id),
      }
    })

    const { data: qs, error: e1 } = await supabase.from('questions').insert(built.map((b) => b.row)).select('id, sort_order')
    if (e1) { await supabase.from('packs').delete().eq('id', pack.id); setBusy(false); return alert(e1.message) }
    const keys = qs.map((q) => ({ question_id: q.id, correct_index: built[q.sort_order].correct }))
    const { error: e2 } = await supabase.from('question_keys').insert(keys)
    if (e2) { await supabase.from('packs').delete().eq('id', pack.id); setBusy(false); return alert(e2.message) }

    setBusy(false)
    onPackCreated?.()
    alert(`Paquete creado con ${qs.length} preguntas. Vuelve a la pantalla principal y pulsa «▶ Crear sala» junto a «${pack.title}».`)
    back()
  }

  if (!ev) return <p className="center">Cargando…</p>
  const link = linkFor(ev)
  return (
    <>
      <button className="ghost" onClick={back}>← Mis quedadas</button>
      <div className="card">
        <h2>🎁 {ev.title}</h2>
        <p><small>Enlace para tus amigos (no necesitan cuenta):</small></p>
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <p className="row">
          <Copy text={link} label="Copiar enlace" />
          <a href={`https://wa.me/?text=${encodeURIComponent(HYPE[0].text(link, ev.title))}`} target="_blank" rel="noreferrer"><button type="button">WhatsApp</button></a>
        </p>
        <h3>Han contestado {done} de {members.length}</h3>
        <ul className="list">
          {members.map((m) => (
            <li key={m.id} className="row">
              <span style={{ flex: 1 }}>{m.submitted_at ? '✅' : '⏳'} {m.name}</span>
              {m.submitted_at && <button className="ghost dark" onClick={() => reset(m)}>Repetir</button>}
            </li>
          ))}
        </ul>
        <button className="ghost dark" onClick={load}>↻ Actualizar</button>
      </div>

      <div className="card">
        <h2>Mensajes para crear expectación</h2>
        <p><small>Copia el que quieras. Ninguno dice que es un juego.</small></p>
        {HYPE.map((h) => (
          <div key={h.when} className="draft">
            <b>{h.when}</b>
            <p>{h.text(link, ev.title)}</p>
            <Copy text={h.text(link, ev.title)} />
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Revisa lo que han contado ({facts.length})</h2>
        <p><small>Las desmarcadas no se usarán. Las que mencionan un nombre propio dan una pista y vienen desmarcadas.</small></p>
        <label className="row"><input type="checkbox" checked={showWho} onChange={(e) => setShowWho(e.target.checked)} style={{ width: 'auto' }} /> Ver de quién habla y quién lo escribió (¡spoiler!)</label>
        <ul className="list">
          {facts.map((f) => {
            const names = members.map((m) => m.name.toLowerCase()).filter((n) => n.length >= 2)
            const flagged = names.some((n) => f.text.toLowerCase().includes(n))
            return (
              <li key={f.id}>
                <label className="row">
                  <input type="checkbox" checked={!!use[f.id]} onChange={(e) => setUse({ ...use, [f.id]: e.target.checked })} style={{ width: 'auto' }} />
                  <span>
                    {f.text} {flagged && <span title="Menciona un nombre">⚠️</span>}
                    {showWho && <small><br />Trata de <b>{byId(f.subject_member_id)}</b> · lo escribió <b>{byId(f.author_member_id)}</b></small>}
                  </span>
                </label>
              </li>
            )
          })}
          {!facts.length && <li>Todavía no ha contestado nadie.</li>}
        </ul>
        <button disabled={busy || !facts.length} onClick={createPack}>{busy ? 'Creando…' : `Crear paquete con ${facts.filter((f) => use[f.id]).length} preguntas`}</button>
        <p><small>Cada pregunta será «¿quién es?» con los amigos como opciones, así que nadie sabe de quién es cada cosa hasta que se adivina.</small></p>
      </div>
    </>
  )
}

export function EventsCard({ onPackCreated }) {
  const [events, setEvents] = useState([])
  const [open, setOpen] = useState(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [names, setNames] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const { data } = await supabase.from('events').select('*, event_members(id, submitted_at)').order('created_at', { ascending: false })
    setEvents(data || [])
  }
  useEffect(() => { load() }, [])

  async function create(e) {
    e.preventDefault()
    const list = names.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
    if (list.length < 4) return alert('Escribe al menos 4 nombres, uno por línea o separados por comas.')
    setBusy(true)
    const { data, error } = await supabase.rpc('create_event', { p_title: title.trim(), p_date: date || null, p_names: list })
    setBusy(false)
    if (error) return alert(error.message)
    setTitle(''); setDate(''); setNames(''); setCreating(false)
    await load()
    setOpen(data.id)
  }

  if (open) return <EventDetail id={open} back={() => { setOpen(null); load() }} onPackCreated={onPackCreated} />

  return (
    <div className="card">
      <h2>🎁 Quedadas sorpresa</h2>
      <p><small>Tus amigos cuentan cosas por un enlace y el juego se monta solo.</small></p>
      <ul className="list">
        {events.map((ev) => {
          const m = ev.event_members || []
          return <li key={ev.id} className="pack" onClick={() => setOpen(ev.id)}>🎁 {ev.title} <small>({m.filter((x) => x.submitted_at).length}/{m.length} han contestado)</small></li>
        })}
        {!events.length && <li>Aún no tienes ninguna.</li>}
      </ul>
      {creating ? (
        <form onSubmit={create}>
          <input placeholder="Nombre de la quedada (ej. Cena de verano)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <textarea rows={5} style={{ width: '100%' }} placeholder={'Quiénes sois (4 a 12), uno por línea o separados por comas.\nIncluye al anfitrión si va a jugar.'} value={names} onChange={(e) => setNames(e.target.value)} required />
          <p className="row">
            <button disabled={busy}>{busy ? 'Creando…' : 'Crear quedada'}</button>
            <button type="button" className="ghost dark" onClick={() => setCreating(false)}>Cancelar</button>
          </p>
        </form>
      ) : <button onClick={() => setCreating(true)}>+ Nueva quedada</button>}
    </div>
  )
}
