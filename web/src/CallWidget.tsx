import { useEffect } from 'react'
import { CheckCircle2, PhoneCall, PhoneOff, RotateCcw, X, XCircle } from 'lucide-react'
import type { Call, CallStatus } from './types'

const statusText: Record<CallStatus, string> = { idle: 'Aguardando', connecting: 'Conectando...', ringing: 'Chamando...', in_progress: 'Em ligação', completed: 'Ligação encerrada', failed: 'Falhou ao ligar', busy: 'Número ocupado', no_answer: 'Não atendeu', canceled: 'Cancelada' }
const finished: CallStatus[] = ['completed', 'failed', 'busy', 'no_answer', 'canceled']
const weekdays = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

interface AppointmentMeta { date?: string; time?: string; specialty?: string; professional?: string; test?: boolean }
function dayLabel(iso?: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? `${weekdays[new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay()]} ${m[3]}/${m[2]}` : ''
}
function clock(seconds: number) { const s = Math.max(0, seconds); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
function maskPhone(phone: string) { const d = phone.replace(/\D/g, '').replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : phone }

/** Mini painel flutuante: mostra se a ligação está chamando e se a consulta foi confirmada, sem precisar ouvir. */
export function CallWidget({ call, elapsed, onOpen, onClose, onRefresh }: { call: Call; elapsed: number; onOpen: () => void; onClose: () => void; onRefresh: () => void }) {
  const done = finished.includes(call.status)
  // Depois que a ligação acaba, relê mais duas vezes para pegar o resultado gravado no final.
  useEffect(() => {
    if (!done) return
    const timers = [window.setTimeout(onRefresh, 2500), window.setTimeout(onRefresh, 8000)]
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [done, call.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const appointment = (call.metadata?.appointment ?? null) as AppointmentMeta | null
  const outcome = (call.metadata?.confirmation as { outcome?: string } | undefined)?.outcome
  const human = Boolean(call.metadata?.human_takeover)
  const talking = call.status === 'in_progress'
  const tone = outcome === 'confirmou' ? 'ok' : outcome === 'desmarcou' ? 'bad' : outcome === 'remarcar' ? 'warn' : done ? 'idle' : talking ? 'live' : 'wait'

  let result = <span className="cw-result wait"><PhoneCall size={14}/> {talking ? 'Aguardando a resposta do paciente...' : 'Aguardando atender...'}</span>
  if (outcome === 'confirmou') result = <span className="cw-result ok"><CheckCircle2 size={15}/> Consulta CONFIRMADA{appointment?.test ? ' (teste, nada gravado)' : ''}</span>
  else if (outcome === 'desmarcou') result = <span className="cw-result bad"><XCircle size={15}/> Consulta DESMARCADA{appointment?.test ? ' (teste, nada gravado)' : ''}</span>
  else if (outcome === 'remarcar') result = <span className="cw-result warn"><RotateCcw size={15}/> Quer remarcar: assuma a ligação</span>
  else if (done && call.status === 'completed') result = <span className="cw-result idle">Encerrou sem confirmar nem desmarcar</span>
  else if (done) result = <span className="cw-result idle"><PhoneOff size={14}/> {statusText[call.status]}</span>

  return <aside className={`call-widget cw-${tone}`} role="status" aria-live="polite">
    <header>
      <span className={`cw-dot ${done ? '' : 'pulse'}`}/>
      <strong>{statusText[call.status]}</strong>
      {talking && <span className="cw-time">{clock(elapsed)}</span>}
      {human && <span className="cw-badge">Você assumiu</span>}
      {appointment?.test && <span className="cw-badge">TESTE</span>}
      <button aria-label="Fechar" onClick={onClose}><X size={15}/></button>
    </header>
    <div className="cw-body">
      <b>{call.patientName}</b>
      <small>{maskPhone(call.phone)}</small>
      {appointment && <small>{appointment.specialty}{appointment.date ? ` · ${dayLabel(appointment.date)} ${appointment.time ?? ''}` : ''}{appointment.professional ? ` · ${appointment.professional}` : ''}</small>}
      {result}
    </div>
    <footer><button onClick={onOpen}>Abrir atendimento</button></footer>
  </aside>
}

/** Aviso flutuante quando a ligação nem chegou a começar (ex.: sem créditos, AMEI desconectada). */
export function StartFailureWidget({ patientName, message, onClose }: { patientName: string; message: string; onClose: () => void }) {
  return <aside className="call-widget cw-bad" role="alert">
    <header><span className="cw-dot"/><strong>Não foi possível ligar</strong><button aria-label="Fechar" onClick={onClose}><X size={15}/></button></header>
    <div className="cw-body"><b>{patientName}</b><span className="cw-result bad"><XCircle size={15}/> {message}</span></div>
  </aside>
}
