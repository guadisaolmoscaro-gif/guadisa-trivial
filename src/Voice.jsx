import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

// Guía de temas: el anfitrión habla (o escribe) sobre cada uno y la IA monta las preguntas.
const TOPICS = [
  { id: 'origen', title: 'Cómo nos conocimos', hint: '¿Dónde y cuándo empezó el grupo? ¿Quién conoció a quién? ¿Cuál fue la primera quedada?' },
  { id: 'viajes', title: 'Viajes y planes memorables', hint: 'Último viaje, el mejor plan, el que salió peor. Lugares, fechas, quién organizó qué.' },
  { id: 'apodos', title: 'Apodos y mañas', hint: 'Apodos del grupo y de dónde vienen. Manías, costumbres y cosas que hace siempre cada uno.' },
  { id: 'anecdotas', title: 'Anécdotas divertidas', hint: 'Historias que siempre se recuerdan: qué pasó, quién estaba, cómo terminó.' },
  { id: 'gustos', title: 'Gustos de cada uno', hint: 'Comida, canciones, series, aficiones. Qué pide siempre cada persona.' },
  { id: 'grupo', title: 'Cosas del grupo', hint: 'Nombre del chat, frases que se repiten, himno, tradiciones, quién llega tarde, quién tarda en contestar…' },
]

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null
const MAX_CHARS = 12000

function shuffleQuestion(q) {
  if (q.kind !== 'multiple') return q
  const idx = q.options.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return { ...q, options: idx.map((i) => q.options[i]), correct: idx.indexOf(q.correct) }
}

export function VoiceWizard({ pack, qs, reload }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0) // 0 = nombres, 1..N = temas, N+1 = generar
  const [group, setGroup] = useState('')
  const [members, setMembers] = useState('')
  const [texts, setTexts] = useState({})
  const [listening, setListening] = useState(false)
  const [count, setCount] = useState(15)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState(null) // preguntas generadas para revisar
  const rec = useRef(null)
  const want = useRef(false)
  const topicRef = useRef(null)

  const topic = step >= 1 && step <= TOPICS.length ? TOPICS[step - 1] : null
  topicRef.current = topic

  function stop() {
    want.current = false
    setListening(false)
    try { rec.current?.stop() } catch { /* ya parado */ }
  }

  useEffect(() => { stop() }, [step])
  useEffect(() => () => stop(), [])

  function start() {
    if (!SR) return
    stop()
    const r = new SR()
    r.lang = 'es-ES'
    r.continuous = true
    r.interimResults = false
    r.onresult = (e) => {
      let add = ''
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) add += e.results[i][0].transcript + ' '
      const t = topicRef.current
      if (add && t) setTexts((prev) => ({ ...prev, [t.id]: ((prev[t.id] || '') + ' ' + add).trim() }))
    }
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('No hay permiso para usar el micrófono. Actívalo en el navegador o escribe el texto a mano.')
        want.current = false
        setListening(false)
      }
    }
    // Chrome corta el dictado tras unos segundos de silencio: lo reanudamos mientras el usuario no pare
    r.onend = () => {
      if (want.current) { try { r.start() } catch { setListening(false) } } else setListening(false)
    }
    rec.current = r
    want.current = true
    setError('')
    try { r.start(); setListening(true) } catch { setListening(false) }
  }

  const total = TOPICS.reduce((n, t) => n + (texts[t.id] || '').length, 0)

  async function generate() {
    setError('')
    const notes = TOPICS.map((t) => ({ topic: t.title, text: (texts[t.id] || '').trim() })).filter((n) => n.text)
    if (!notes.length) return setError('Cuenta algo en al menos un tema antes de generar las preguntas.')
    if (total > MAX_CHARS) return setError(`Hay demasiado texto (${total} caracteres, máximo ${MAX_CHARS}). Acorta alguno de los temas.`)
    setBusy(true)
    const { data, error: err } = await supabase.functions.invoke('generate-questions', {
      body: { group: group.trim(), members: members.trim(), notes, count: Number(count) },
    })
    setBusy(false)
    if (err || data?.error) {
      let msg = data?.error || err?.message || 'Error desconocido'
      try { const j = await err?.context?.json?.(); if (j?.error) msg = j.error } catch { /* sin detalle */ }
      return setError(msg)
    }
    const list = (data?.questions || []).map((q) => shuffleQuestion({ ...q, keep: true }))
    if (!list.length) return setError('No se pudo generar ninguna pregunta. Prueba a contar más detalles.')
    setDraft(list)
  }

  const upd = (i, patch) => setDraft((d) => d.map((q, j) => (j === i ? { ...q, ...patch } : q)))
  const updOpt = (i, k, v) => setDraft((d) => d.map((q, j) => (j === i ? { ...q, options: q.options.map((o, m) => (m === k ? v : o)) } : q)))

  async function save() {
    const chosen = draft.filter((q) => q.keep)
    if (chosen.some((q) => !q.prompt.trim() || q.options.some((o) => !o.trim()))) return alert('Hay preguntas con campos vacíos. Complétalos o desmárcalas.')
    if (!chosen.length) return
    setBusy(true)
    let order = qs.length ? Math.max(...qs.map((q) => q.sort_order)) + 1 : 0
    for (const q of chosen) {
      const { data: row, error: e1 } = await supabase.from('questions')
        .insert({ pack_id: pack.id, sort_order: order++, kind: q.kind, prompt: q.prompt.trim().slice(0, 300), options: q.options.map((o) => o.trim()) })
        .select().single()
      if (e1) { alert(e1.message); break }
      const { error: e2 } = await supabase.from('question_keys').insert({ question_id: row.id, correct_index: q.correct })
      if (e2) { await supabase.from('questions').delete().eq('id', row.id); alert(e2.message); break }
    }
    setBusy(false)
    setDraft(null)
    setStep(0)
    setTexts({})
    setOpen(false)
    reload()
  }

  if (!open) {
    return (
      <div className="card">
        <h2>🎙️ Crear preguntas hablando</h2>
        <p>Cuenta anécdotas de tu grupo siguiendo una guía y la IA las convierte en preguntas divertidas. Tú las revisas antes de guardarlas.</p>
        <button onClick={() => setOpen(true)}>Empezar</button>
      </div>
    )
  }

  if (draft) {
    return (
      <div className="card">
        <h2>Revisa las preguntas</h2>
        <p><small>La IA puede equivocarse o exagerar. Corrige lo que haga falta, marca con el círculo la respuesta correcta y desmarca las que no quieras.</small></p>
        {draft.map((q, i) => (
          <div key={i} className="draft">
            <label className="row"><input type="checkbox" checked={q.keep} onChange={(e) => upd(i, { keep: e.target.checked })} /> <b>Pregunta {i + 1}</b></label>
            <input value={q.prompt} maxLength={300} onChange={(e) => upd(i, { prompt: e.target.value })} />
            {q.options.map((o, k) => (
              <div className="row" key={k}>
                <input type="radio" name={`ok-${i}`} checked={q.correct === k} onChange={() => upd(i, { correct: k })} />
                <input value={o} onChange={(e) => updOpt(i, k, e.target.value)} />
              </div>
            ))}
          </div>
        ))}
        <p className="row">
          <button disabled={busy} onClick={save}>{busy ? 'Guardando…' : `Guardar ${draft.filter((q) => q.keep).length} preguntas`}</button>
          <button className="ghost dark" onClick={() => setDraft(null)}>← Volver</button>
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <h2>🎙️ Crear preguntas hablando</h2>
      <p><small>Paso {step + 1} de {TOPICS.length + 2}</small></p>

      {step === 0 && (
        <>
          <p>Primero, lo básico:</p>
          <input placeholder="Nombre del grupo (ej. Las de la uni)" value={group} onChange={(e) => setGroup(e.target.value)} maxLength={60} />
          <textarea rows={3} style={{ width: '100%' }} placeholder="Quiénes sois, con sus apodos si tienen (ej. Isa, Marta «la Jefa», Carlos)" value={members} onChange={(e) => setMembers(e.target.value)} maxLength={500} />
          <small>Los nombres se usan para que las respuestas falsas suenen creíbles.</small>
        </>
      )}

      {topic && (
        <>
          <h3>{topic.title}</h3>
          <p>{topic.hint}</p>
          {SR ? (
            <p>
              <button className={listening ? 'rec' : ''} onClick={listening ? stop : start}>{listening ? '⏹ Parar' : '🎙️ Hablar'}</button>{' '}
              <small>{listening ? 'Escuchando… habla con naturalidad.' : 'Pulsa y cuenta lo que recuerdes.'}</small>
            </p>
          ) : (
            <p><small>Tu navegador no permite dictar. Escribe el texto o usa Chrome, Edge o Safari.</small></p>
          )}
          <textarea rows={7} style={{ width: '100%' }} value={texts[topic.id] || ''} onChange={(e) => setTexts({ ...texts, [topic.id]: e.target.value })} placeholder="Aquí aparecerá lo que cuentes. Puedes corregirlo o escribir a mano." />
          <small>Si no hay nada que contar en este tema, pasa al siguiente.</small>
        </>
      )}

      {step === TOPICS.length + 1 && (
        <>
          <p>Has contado {total} caracteres en {TOPICS.filter((t) => (texts[t.id] || '').trim()).length} de {TOPICS.length} temas.</p>
          <p>¿Cuántas preguntas quieres?{' '}
            <select value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 90 }}>{[8, 10, 15, 20, 25].map((n) => <option key={n}>{n}</option>)}</select>
          </p>
          <p><small>Se envía solo el texto (no se guarda ningún audio) a un servicio de IA para redactar las preguntas. Cuéntalo al grupo y evita datos delicados.</small></p>
          <button disabled={busy} onClick={generate}>{busy ? 'Generando… (puede tardar unos segundos)' : '✨ Generar preguntas'}</button>
        </>
      )}

      {error && <p className="msg">{error}</p>}

      <p className="row">
        {step > 0 && <button className="ghost dark" onClick={() => setStep(step - 1)}>← Anterior</button>}
        {step <= TOPICS.length && <button onClick={() => setStep(step + 1)}>Siguiente →</button>}
        <button className="ghost dark" onClick={() => { stop(); setOpen(false) }}>Cerrar</button>
      </p>
    </div>
  )
}
