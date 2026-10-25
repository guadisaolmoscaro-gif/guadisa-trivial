import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Host, Play, Join, Importer } from './Game.jsx'
import { VoiceWizard } from './Voice.jsx'
import { EventsCard } from './Events.jsx'
import { Invite } from './Invite.jsx'

const COLORS = ['c-red', 'c-blue', 'c-yellow', 'c-green']
const BUCKET = 'question-images'

function Auth() {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    const { data, error } =
      mode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { data: { display_name: name } } })
    setBusy(false)
    if (error) return setMsg(error.message)
    if (mode === 'register' && !data.session)
      setMsg('¡Listo! Revisa tu email para confirmar la cuenta y luego inicia sesión.')
  }

  return (
    <div className="card">
      <h2>{mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h2>
      <form onSubmit={submit}>
        {mode === 'register' && (
          <input placeholder="Tu nombre" value={name} onChange={(e) => setName(e.target.value)} required maxLength={24} />
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Contraseña (mínimo 6)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        <button disabled={busy}>{mode === 'login' ? 'Entrar' : 'Registrarme'}</button>
      </form>
      {msg && <p className="msg">{msg}</p>}
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); setMsg(''); setMode(mode === 'login' ? 'register' : 'login') }}>
          {mode === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
        </a>
      </p>
    </div>
  )
}

function Editor({ pack, user, back }) {
  const [qs, setQs] = useState([])
  const [kind, setKind] = useState('multiple')
  const [prompt, setPrompt] = useState('')
  const [opts, setOpts] = useState(['', '', '', ''])
  const [correct, setCorrect] = useState(0)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const options = kind === 'multiple' ? opts : ['Verdadero', 'Falso']

  const load = async () => {
    const { data } = await supabase.from('questions').select('*').eq('pack_id', pack.id).order('sort_order')
    setQs(data || [])
  }
  useEffect(() => { load() }, [])

  async function add(e) {
    e.preventDefault()
    if (!prompt.trim() || options.some((o) => !o.trim())) return alert('Rellena la pregunta y todas las opciones')
    setBusy(true)
    let image_path = null
    if (file) {
      const ext = file.name.split('.').pop().toLowerCase()
      image_path = `${user.id}/${crypto.randomUUID()}.${ext}`
      const { error } = await supabase.storage.from(BUCKET).upload(image_path, file)
      if (error) { setBusy(false); return alert('Error con la foto: ' + error.message) }
    }
    const sort_order = qs.length ? Math.max(...qs.map((q) => q.sort_order)) + 1 : 0
    const { data: q, error } = await supabase
      .from('questions')
      .insert({ pack_id: pack.id, sort_order, kind, prompt: prompt.trim(), image_path, options: options.map((o) => o.trim()) })
      .select()
      .single()
    if (error) { setBusy(false); return alert(error.message) }
    const { error: e2 } = await supabase.from('question_keys').insert({ question_id: q.id, correct_index: correct })
    if (e2) {
      await supabase.from('questions').delete().eq('id', q.id)
      setBusy(false)
      return alert(e2.message)
    }
    setPrompt(''); setOpts(['', '', '', '']); setCorrect(0); setFile(null); setBusy(false)
    e.target.reset()
    load()
  }

  return (
    <>
      <button className="ghost" onClick={back}>← Mis paquetes</button>
      <div className="card">
        <h2>{pack.title}</h2>
        <ul className="list">
          {qs.map((q, i) => (
            <li key={q.id}>
              <b>{i + 1}. {q.prompt}</b>
              {q.image_path && <div><img className="q" src={supabase.storage.from(BUCKET).getPublicUrl(q.image_path).data.publicUrl} alt="" /></div>}
              {q.options.map((o, j) => <div key={j} className={`opt ${COLORS[j]}`}>{o}</div>)}
            </li>
          ))}
          {!qs.length && <li>Todavía no hay preguntas.</li>}
        </ul>
      </div>
      <VoiceWizard pack={pack} qs={qs} reload={load} />
      <Importer pack={pack} qs={qs} reload={load} />
      <div className="card">
        <h2>Añadir pregunta</h2>
        <form onSubmit={add}>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setCorrect(0) }}>
            <option value="multiple">Test (4 opciones)</option>
            <option value="truefalse">Verdadero / falso</option>
          </select>
          <input placeholder="Pregunta" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={300} />
          {options.map((o, i) => (
            <div className="row" key={i}>
              <input type="radio" name="ok" checked={correct === i} onChange={() => setCorrect(i)} title="Respuesta correcta" />
              {kind === 'multiple'
                ? <input placeholder={`Opción ${i + 1}`} value={o} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} />
                : <b>{o}</b>}
            </div>
          ))}
          <small>Marca el círculo de la respuesta correcta.</small>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files[0] || null)} />
          <small>Foto opcional (máx. 2 MB).</small>
          <p><button disabled={busy}>{busy ? 'Guardando…' : 'Guardar pregunta'}</button></p>
        </form>
      </div>
    </>
  )
}

function Packs({ user, go }) {
  const [secs, setSecs] = useState(20)
  async function host(p) {
    const { data, error } = await supabase.rpc('create_room', { p_pack_id: p.id, p_seconds: Number(secs) })
    if (error) return alert(error.message)
    go({ host: data })
  }
  const [packs, setPacks] = useState([])
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState(null)

  const load = async () => {
    const { data } = await supabase.from('packs').select('*').order('created_at', { ascending: false })
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

  if (open) return <Editor pack={open} user={user} back={() => setOpen(null)} />
  return (
    <>
      <Join go={go} />
      <EventsCard onPackCreated={load} />
      <div className="card">
        <h2>Mis paquetes de preguntas</h2>
        <p>Segundos por pregunta: <select value={secs} onChange={(e) => setSecs(e.target.value)} style={{ width: 90 }}>{[10, 15, 20, 30, 45, 60].map((n) => <option key={n}>{n}</option>)}</select></p>
        <ul className="list">
          {packs.map((p) => <li key={p.id} className="row"><span className="pack" style={{ flex: 1 }} onClick={() => setOpen(p)}>📦 {p.title}</span><button onClick={() => host(p)}>▶ Crear sala</button></li>)}
          {!packs.length && <li>Aún no tienes paquetes. ¡Crea el primero!</li>}
        </ul>
      </div>
      <div className="card">
        <form onSubmit={create}>
          <input placeholder="Nombre del nuevo paquete (ej. Viaje a Roma)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          <button>Crear paquete</button>
        </form>
      </div>
    </>
  )
}

export default function App() {
  const [session, setSession] = useState(undefined)
  const [view, setView] = useState(null)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const inviteToken = new URLSearchParams(window.location.search).get('e')
  if (inviteToken) return <Invite token={inviteToken} />
  if (session === undefined) return <p className="center">Cargando…</p>
  return (
    <div className="wrap">
      <header>
        <h1>🎉 Trivial de amigos</h1>
        {session && <button className="ghost" onClick={() => supabase.auth.signOut()}>Salir</button>}
      </header>
      {session ? (view?.host ? <Host room={view.host} exit={() => setView(null)} /> : view?.play ? <Play roomId={view.play} user={session.user} exit={() => setView(null)} /> : <Packs user={session.user} go={setView} />) : <Auth />}
    </div>
  )
}
