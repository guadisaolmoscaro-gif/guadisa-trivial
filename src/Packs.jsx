import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { VoiceWizard } from './Voice.jsx'
import { parseBulk } from './bulk.js'

const COLORS = ['c-red', 'c-blue', 'c-yellow', 'c-green']
const BUCKET = 'question-images'

// Guarda una pregunta con su respuesta correcta (en dos tablas, para que el jugador nunca vea la clave)
async function saveQuestion(pack, order, q) {
  const { data: row, error } = await supabase.from('questions')
    .insert({ pack_id: pack.id, sort_order: order, kind: q.kind, prompt: q.prompt.trim().slice(0, 300), options: q.options.map((o) => o.trim()), image_path: q.image_path || null })
    .select().single()
  if (error) throw new Error(error.message)
  const { error: e2 } = await supabase.from('question_keys').insert({ question_id: row.id, correct_index: q.correct })
  if (e2) {
    await supabase.from('questions').delete().eq('id', row.id)
    throw new Error(e2.message)
  }
}

// Asistente: una pregunta cada vez, con tic en la correcta
function QuestionWizard({ pack, user, nextOrder, onSaved }) {
  const [kind, setKind] = useState('multiple')
  const [prompt, setPrompt] = useState('')
  const [opts, setOpts] = useState(['', '', '', ''])
  const [correct, setCorrect] = useState(null)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const refs = useRef([])
  const options = kind === 'multiple' ? opts : ['Verdadero', 'Falso']
  const count = kind === 'multiple' ? 4 : 2

  function reset() {
    setPrompt(''); setOpts(['', '', '', '']); setCorrect(null); setFile(null); setErr('')
  }

  async function save() {
    setErr('')
    if (!prompt.trim()) return setErr('Escribe la pregunta')
    if (options.slice(0, count).some((o) => !o.trim())) return setErr('Rellena todas las respuestas')
    if (correct === null) return setErr('Marca con el tic la respuesta correcta')
    setBusy(true)
    try {
      let image_path = null
      if (file) {
        const ext = file.name.split('.').pop().toLowerCase()
        image_path = `${user.id}/${crypto.randomUUID()}.${ext}`
        const { error } = await supabase.storage.from(BUCKET).upload(image_path, file)
        if (error) throw new Error('Error con la foto: ' + error.message)
      }
      await saveQuestion(pack, nextOrder, { kind, prompt, options: options.slice(0, count), correct, image_path })
      reset()
      onSaved()
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  return (
    <div className="card">
      <h2>Pregunta {nextOrder + 1}</h2>
      <p>
        <button type="button" className={kind === 'multiple' ? '' : 'ghost dark'} onClick={() => { setKind('multiple'); setCorrect(null) }}>Test (4 respuestas)</button>{' '}
        <button type="button" className={kind === 'truefalse' ? '' : 'ghost dark'} onClick={() => { setKind('truefalse'); setCorrect(null) }}>Verdadero / falso</button>
      </p>
      <form onSubmit={(e) => { e.preventDefault(); save() }}>
        <input placeholder="Escribe la pregunta" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={300} autoFocus />
        {options.slice(0, count).map((o, i) => (
          <div className="answer" key={i}>
            <button type="button" className={`tic ${correct === i ? 'on' : ''}`} onClick={() => setCorrect(i)} title="Respuesta correcta">✔</button>
            {kind === 'multiple'
              ? <input ref={(el) => (refs.current[i] = el)} placeholder={`Respuesta ${i + 1}`} value={o}
                  onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    if (i < count - 1) refs.current[i + 1]?.focus()
                    else save()
                  }} />
              : <b className="tf">{o}</b>}
          </div>
        ))}
        <small>Pulsa el tic de la respuesta correcta. Enter pasa a la siguiente respuesta.</small>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files[0] || null)} />
        <small>Foto opcional (máx. 2 MB).</small>
        {err && <p className="msg">{err}</p>}
        <p className="row">
          <button disabled={busy}>{busy ? 'Guardando…' : 'Guardar y seguir →'}</button>
        </p>
      </form>
    </div>
  )
}

// Pegar en bloque: se revisa antes de guardar
function BulkImport({ pack, nextOrder, onSaved }) {
  const [text, setText] = useState('')
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const bad = items ? items.filter((i) => i.error).length : 0

  async function save() {
    setBusy(true)
    setErr('')
    try {
      for (const [i, q] of items.entries()) {
        await saveQuestion(pack, nextOrder + i, { kind: q.kind, prompt: q.prompt, options: q.options, correct: q.correct })
      }
      setText(''); setItems(null)
      onSaved()
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  return (
    <div className="card">
      <h2>Pegar muchas a la vez</h2>
      <p><small>Pega las preguntas tal cual. Puede haber números, letras o viñetas delante. Marca la correcta con *, ✔ o ✓ (delante o detrás). Puedes separarlas con una línea en blanco o no.</small></p>
      {!items && (
        <>
          <textarea rows={12} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'1. ¿Cuál es la capital de Francia?\nLondres\n*París\nRoma\nMadrid\n\n¿El agua hierve a 100 grados?\nVerdadero *\nFalso'} />
          <button disabled={!text.trim()} onClick={() => setItems(parseBulk(text))}>Revisar antes de guardar</button>
        </>
      )}
      {items && (
        <>
          <p>
            <b>{items.length}</b> preguntas encontradas.{' '}
            {bad ? <span className="msg">{bad} con error: corrígelas en el texto.</span> : <span>Todo correcto.</span>}
          </p>
          <ol className="list">
            {items.map((q, i) => (
              <li key={i} style={{ background: q.error ? '#fff1f3' : 'transparent' }}>
                <b>{q.prompt || '(sin pregunta)'}</b>
                {q.options.map((o, k) => (
                  <div key={k} className={q.error ? '' : `opt ${COLORS[k]}`} style={{ fontWeight: q.correct === k ? 800 : 400 }}>
                    {q.correct === k ? '✔ ' : ''}{o}
                  </div>
                ))}
                {q.error && <div className="msg">⚠ {q.error}</div>}
              </li>
            ))}
          </ol>
          {err && <p className="msg">{err}</p>}
          <p className="row">
            <button disabled={bad > 0 || busy || !items.length} onClick={save}>{busy ? 'Guardando…' : `Guardar ${items.length} preguntas`}</button>
            <button className="ghost dark" onClick={() => setItems(null)}>← Volver a editar el texto</button>
          </p>
        </>
      )}
    </div>
  )
}

function Editor({ pack, user, back }) {
  const [qs, setQs] = useState([])
  const [tab, setTab] = useState('asistente')
  const load = async () => {
    const { data } = await supabase.from('questions').select('*').eq('pack_id', pack.id).order('sort_order')
    setQs(data || [])
  }
  useEffect(() => { load() }, [])

  const nextOrder = qs.length ? Math.max(...qs.map((q) => q.sort_order)) + 1 : 0

  async function remove(q) {
    if (!confirm(`¿Borrar la pregunta «${q.prompt}»?`)) return
    const { error } = await supabase.from('questions').delete().eq('id', q.id)
    if (error) return alert(error.message)
    load()
  }

  return (
    <>
      <button className="ghost" onClick={back}>← Mis paquetes</button>
      <div className="card">
        <h2>📦 {pack.title}</h2>
        <p><small>{qs.length} preguntas guardadas</small></p>
        {!qs.length && <p>Todavía no hay preguntas. Empieza con el asistente.</p>}
        <ol className="list">
          {qs.map((q) => (
            <li key={q.id} className="row">
              <span style={{ flex: 1 }}>
                <b>{q.prompt}</b>
                {q.image_path && <div><img className="q" src={supabase.storage.from(BUCKET).getPublicUrl(q.image_path).data.publicUrl} alt="" /></div>}
              </span>
              <button className="ghost dark" onClick={() => remove(q)} title="Borrar">🗑</button>
            </li>
          ))}
        </ol>
      </div>

      <div className="tabs">
        <button className={tab === 'asistente' ? '' : 'ghost dark'} onClick={() => setTab('asistente')}>✍️ Asistente</button>
        <button className={tab === 'bloque' ? '' : 'ghost dark'} onClick={() => setTab('bloque')}>📋 Pegar en bloque</button>
        <button className={tab === 'ia' ? '' : 'ghost dark'} onClick={() => setTab('ia')}>✨ Con IA</button>
      </div>

      {tab === 'asistente' && <QuestionWizard pack={pack} user={user} nextOrder={nextOrder} onSaved={load} />}
      {tab === 'bloque' && <BulkImport pack={pack} nextOrder={nextOrder} onSaved={load} />}
      {tab === 'ia' && <VoiceWizard pack={pack} qs={qs} reload={load} />}
    </>
  )
}

// Jugar un paquete: nombres y duración, y se crea la partida lista para el enlace
function PlayForm({ pack, openRoom }) {
  const [names, setNames] = useState('')
  const [length, setLength] = useState(15)
  const [busy, setBusy] = useState(false)

  async function go() {
    const list = names.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean)
    if (list.length < 2) return alert('Escribe al menos 2 participantes')
    setBusy(true)
    const { data, error } = await supabase.rpc('create_room_v2', { p_pack_id: pack.id, p_length: Number(length), p_names: list })
    setBusy(false)
    if (error) return alert(error.message)
    openRoom(data)
  }

  return (
    <div className="card play">
      <p><b>¿Quién juega?</b> <small>Uno por línea o separados por comas (de 2 a 8)</small></p>
      <textarea rows={4} style={{ width: '100%' }} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Ana\nLuis\nMarta'} />
      <p className="row">
        <select value={length} onChange={(e) => setLength(e.target.value)} style={{ width: 'auto' }}>
          <option value={15}>Rápida (15)</option>
          <option value={30}>Media (30)</option>
          <option value={50}>Larga (50)</option>
        </select>
        <button disabled={busy} onClick={go}>{busy ? 'Creando…' : 'Crear partida'}</button>
      </p>
    </div>
  )
}

// Lista de paquetes: se quedan guardados para siempre
export function PacksTab({ user, openRoom }) {
  const [packs, setPacks] = useState([])
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState(null)
  const [playing, setPlaying] = useState(null)

  const load = async () => {
    const { data } = await supabase.from('packs').select('*, questions(count)').eq('owner_id', user.id).not('title', 'like', 'Sala:%').order('created_at', { ascending: false })
    setPacks(data || [])
  }
  useEffect(() => { load() }, [])

  async function create(e) {
    e.preventDefault()
    if (!title.trim()) return
    const { error } = await supabase.from('packs').insert({ title: title.trim() })
    if (error) return alert(error.message)
    setTitle('')
    load()
  }

  async function removePack(p) {
    if (!confirm(`¿Borrar el paquete «${p.title}» y todas sus preguntas?`)) return
    const { error } = await supabase.from('packs').delete().eq('id', p.id)
    if (error) return alert(error.message)
    load()
  }

  if (open) return <Editor pack={open} user={user} back={() => { setOpen(null); load() }} />
  return (
    <>
      <div className="card">
        <h2>Mis paquetes</h2>
        <p><small>Los paquetes se guardan y puedes reutilizarlos cuando quieras.</small></p>
        <ul className="list">
          {packs.map((p) => (
            <li key={p.id}>
              <div className="row">
                <span className="pack" style={{ flex: 1 }} onClick={() => setOpen(p)}>
                  📦 {p.title} <small>· {p.questions?.[0]?.count ?? 0} preguntas</small>
                </span>
                <button onClick={() => setPlaying(playing === p.id ? null : p.id)}>▶ Jugar</button>
                <button className="ghost dark" onClick={() => setOpen(p)}>Editar</button>
                <button className="ghost dark" onClick={() => removePack(p)} title="Borrar paquete">🗑</button>
              </div>
              {playing === p.id && <PlayForm pack={p} openRoom={openRoom} />}
            </li>
          ))}
          {!packs.length && <li>Aún no tienes paquetes.</li>}
        </ul>
      </div>
      <form className="card" onSubmit={create}>
        <h2>Nuevo paquete</h2>
        <input placeholder="Nombre (ej. Viaje a Roma)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
        <button>Crear paquete</button>
      </form>
    </>
  )
}
