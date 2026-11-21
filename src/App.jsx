import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Host, Link } from './Game.jsx'
import { Invite } from './Invite.jsx'
import { SalasTab, Review } from './Rooms.jsx'
import { PacksTab } from './Packs.jsx'

function Landing({ onPick }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <h2>Crea tu trivial con tu grupo</h2>
      <p>Cuenta lo que sabéis de vuestro grupo y nosotros preparamos el juego. Tú invitas a tus amigos por WhatsApp.</p>
      <p><button onClick={() => onPick('login')}>INICIAR SESIÓN</button></p>
      <p><button className="ghost dark" onClick={() => onPick('register')}>CREAR CUENTA</button></p>
    </div>
  )
}

function Auth({ initial = 'login', back }) {
  const [mode, setMode] = useState(initial)
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
      {back && <p><a href="#" onClick={(e) => { e.preventDefault(); back() }}>← Volver</a></p>}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(undefined)
  const [view, setView] = useState(null)
  const [tab, setTab] = useState('salas')
  const [authMode, setAuthMode] = useState(null) // null = portada; 'login' o 'register'
  const [wm, setWm] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session?.user || session.user.is_anonymous) return
    supabase.from('profiles').select('is_webmaster').eq('id', session.user.id).single()
      .then(({ data }) => setWm(!!data?.is_webmaster))
  }, [session?.user?.id])

  const params = new URLSearchParams(window.location.search)
  const inviteToken = params.get('e')
  if (inviteToken) return <Invite token={inviteToken} />
  const roomToken = params.get('s')
  if (roomToken) return <div className="wrap"><header><h1>🎉 Trivial de amigos</h1></header><Link token={roomToken} /></div>
  if (session === undefined) return <p className="center">Cargando…</p>

  const tabs = [['salas', '🎲 Partidas'], ['paquetes', '📦 Paquetes'], ...(wm ? [['revision', '🔎 Revisar partidas']] : [])]

  return (
    <div className="wrap">
      <header>
        <h1>🎉 Trivial de amigos</h1>
        {session && <button className="ghost" onClick={() => { setView(null); supabase.auth.signOut() }}>Salir</button>}
      </header>
      {session?.user?.is_anonymous
        ? <div className="card"><p>Has salido de la sala. Para volver a jugar, abre el enlace que te pasó el game master.</p></div>
        : session ? (view?.host
          ? <Host room={view.host} exit={() => setView(null)} />
          : <>
              <nav className="tabs main">
                {tabs.map(([id, label]) => (
                  <button key={id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>{label}</button>
                ))}
              </nav>
              {tab === 'salas' && <SalasTab user={session.user} openRoom={(r) => setView({ host: r })} />}
              {tab === 'paquetes' && <PacksTab user={session.user} openRoom={(r) => setView({ host: r })} />}
              {tab === 'revision' && wm && <Review />}
            </>)
          : authMode ? <Auth initial={authMode} back={() => setAuthMode(null)} /> : <Landing onPick={setAuthMode} />}
    </div>
  )
}
