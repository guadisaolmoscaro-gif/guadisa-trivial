import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// Página pública que abren los amigos con el enlace. No pide cuenta ni menciona el juego.
const SELF = [
  { key: 'apodo', label: 'Un apodo tuyo, o cómo te llaman', ph: 'Ej. el Capi' },
  { key: 'mania', label: 'Una manía tuya', ph: 'Ej. no soporto que me hablen antes del café' },
  { key: 'plan', label: 'Tu plan de siempre', ph: 'Ej. cena larga y sobremesa infinita' },
  { key: 'cancion', label: 'Tu canción de siempre', ph: 'Título de la canción' },
  { key: 'anecdota', label: 'Una anécdota graciosa tuya (una línea)', ph: 'Ej. me quedé encerrado en el coche de un amigo' },
  { key: 'secreto', label: 'Algo que casi nadie sabe de ti', ph: 'Algo curioso e inofensivo 😉' },
]
const MAX_OTHERS = 3

export function Invite({ token }) {
  const [info, setInfo] = useState(undefined) // undefined = cargando, null = enlace no válido
  const [me, setMe] = useState('')
  const [self, setSelf] = useState({})
  const [others, setOthers] = useState(Array.from({ length: MAX_OTHERS }, () => ({ subject: '', text: '' })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => { document.title = 'Sorpresa 🤫' }, [])
  useEffect(() => {
    supabase.rpc('get_invite', { p_token: token }).then(({ data, error: e }) => setInfo(e ? null : data))
  }, [token])

  async function send(e) {
    e.preventDefault()
    setError('')
    const facts = [
      ...SELF.map((s) => ({ key: s.key, text: (self[s.key] || '').trim() })),
      ...others.filter((o) => o.subject && o.text.trim()).map((o) => ({ key: 'otro', subject: o.subject, text: o.text.trim() })),
    ].filter((f) => f.text)
    if (!me) return setError('Primero dinos quién eres.')
    if (facts.length < 2) return setError('Contesta al menos 2 cosas.')
    setBusy(true)
    const { error: err } = await supabase.rpc('submit_facts', { p_token: token, p_member_id: me, p_facts: facts })
    setBusy(false)
    if (err) return setError(err.message)
    setDone(true)
  }

  const shell = (children) => (
    <div className="wrap">
      <div className="card">{children}</div>
    </div>
  )

  if (info === undefined) return <p className="center">Cargando…</p>
  if (info === null) return shell(<><h2>Enlace no válido</h2><p>Pídele a quien te lo mandó que te lo envíe de nuevo.</p></>)
  if (done) {
    return shell(<>
      <h2>¡Gracias! 🎉</h2>
      <p>Ya está. Ahora, <b>chitón</b>: es una sorpresa y no se lo cuentes a nadie. 🤫</p>
    </>)
  }

  const meMember = info.members.find((m) => m.id === me)
  const others_list = info.members.filter((m) => m.id !== me)

  return shell(
    <form onSubmit={send}>
      <h2>🤫 Sorpresa: «{info.title}»</h2>
      <p>Estoy preparando algo y necesito tu ayuda. Son <b>2 minutos</b>. Tus respuestas son un secreto entre nosotros hasta el día de la sorpresa.</p>

      <label><b>¿Quién eres?</b></label>
      <select value={me} onChange={(e) => setMe(e.target.value)}>
        <option value="">Elige tu nombre…</option>
        {info.members.map((m) => <option key={m.id} value={m.id} disabled={m.done}>{m.name}{m.done ? ' (ya respondió)' : ''}</option>)}
      </select>

      {meMember && (
        <>
          <h3>Sobre ti</h3>
          <p><small>Contesta lo que quieras, mínimo 2. Cuanto más concreto, mejor. No pongas nombres propios: así no se dan pistas.</small></p>
          {SELF.map((s) => (
            <div key={s.key}>
              <label>{s.label}</label>
              <input value={self[s.key] || ''} onChange={(e) => setSelf({ ...self, [s.key]: e.target.value })} maxLength={160} placeholder={s.ph} />
            </div>
          ))}

          <h3>Sobre los demás (opcional)</h3>
          <p><small>Cuenta algo gracioso de otra persona del grupo. Siempre con cariño: nada que pueda sentar mal. Hasta {MAX_OTHERS}.</small></p>
          {others.map((o, i) => (
            <div key={i} className="draft">
              <select value={o.subject} onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))}>
                <option value="">¿De quién?</option>
                {others_list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <input value={o.text} maxLength={160} placeholder="Algo gracioso de esa persona (sin decir su nombre)" onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            </div>
          ))}

          {error && <p className="msg">{error}</p>}
          <p><button disabled={busy}>{busy ? 'Enviando…' : 'Enviar mis respuestas'}</button></p>
          <small>Solo se puede enviar una vez. Quien organiza la sorpresa podrá ver lo que has escrito.</small>
        </>
      )}
      {!meMember && error && <p className="msg">{error}</p>}
    </form>
  )
}
