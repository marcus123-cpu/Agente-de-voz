import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { CheckCircle2, Hand, PhoneCall, PhoneOff, Redo2, RotateCcw, X, XCircle } from 'lucide-react'
import type { Call, CallStatus } from './types'
import { LiveListen } from './LiveListen'
import { api } from './api'

const DRAG_STORAGE_KEY = 'cw-position'
/** Arrasta o widget pelo cabeçalho (ignora cliques em botões) e lembra a posição entre ligações. */
function useDraggableWidget() {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(() => {
    try { const raw = localStorage.getItem(DRAG_STORAGE_KEY); return raw ? JSON.parse(raw) as { left: number; top: number } : null } catch { return null }
  })
  const drag = useRef<{ offsetX: number; offsetY: number; width: number; height: number } | null>(null)
  const elementRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    function onMove(event: MouseEvent) {
      if (!drag.current) return
      const { offsetX, offsetY, width, height } = drag.current
      const left = Math.min(Math.max(0, event.clientX - offsetX), window.innerWidth - width)
      const top = Math.min(Math.max(0, event.clientY - offsetY), window.innerHeight - height)
      setPos({ left, top })
    }
    function onUp() {
      if (!drag.current) return
      drag.current = null
      setPos((current) => { try { if (current) localStorage.setItem(DRAG_STORAGE_KEY, JSON.stringify(current)) } catch { /* sem localStorage, sem persistência */ } return current })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  function onHeaderMouseDown(event: ReactMouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button')) return
    const rect = elementRef.current?.getBoundingClientRect()
    if (!rect) return
    drag.current = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, height: rect.height }
    setPos({ left: rect.left, top: rect.top })
  }

  return { ref: elementRef, style: pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } as const : undefined, onHeaderMouseDown }
}

const statusText: Record<CallStatus, string> = { idle: 'Aguardando', connecting: 'Conectando...', ringing: 'Chamando...', in_progress: 'Em ligação', completed: 'Ligação encerrada', failed: 'Falhou ao ligar', busy: 'Número ocupado', no_answer: 'Não atendeu', canceled: 'Cancelada', voicemail: 'Caixa postal / URA' }
const finished: CallStatus[] = ['completed', 'failed', 'busy', 'no_answer', 'canceled', 'voicemail']
const weekdays = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

interface BookingView { status: 'pending' | 'booking' | 'booked' | 'rejected' | 'expired' | 'failed'; patient: string; specialty: string; professional: string; date: string; time: string; partner: string; procedure: string; local: string; price: number; appointmentId?: string; message?: string }
interface AppointmentMeta { date?: string; time?: string; specialty?: string; professional?: string; test?: boolean; kind?: string; cardStatus?: string }
function dayLabel(iso?: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? `${weekdays[new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay()]} ${m[3]}/${m[2]}` : ''
}
function clock(seconds: number) { const s = Math.max(0, seconds); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
function maskPhone(phone: string) { const d = phone.replace(/\D/g, '').replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : phone }

/** Mini painel flutuante: mostra se a ligação está chamando e se a consulta foi confirmada, sem precisar ouvir. */
export function CallWidget({ call, elapsed, demo, ending, takingOver, markingAnswered, markingVoicemail, redialing, onTakeover, onEnd, onMarkAnswered, onMarkVoicemail, onRedial, onOpen, onClose, onRefresh }: { call: Call; elapsed: number; demo: boolean; ending: boolean; takingOver: boolean; markingAnswered: boolean; markingVoicemail: boolean; redialing?: boolean; onTakeover: () => void; onEnd: () => void; onMarkAnswered: () => void; onMarkVoicemail: () => void; onRedial?: () => void; onOpen: () => void; onClose: () => void; onRefresh: () => void }) {
  const done = finished.includes(call.status)
  const drag = useDraggableWidget()
  // Depois que a ligação acaba, relê mais duas vezes para pegar o resultado gravado no final.
  useEffect(() => {
    if (!done) return
    const timers = [window.setTimeout(onRefresh, 2500), window.setTimeout(onRefresh, 8000)]
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [done, call.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const appointment = (call.metadata?.appointment ?? null) as AppointmentMeta | null
  const outcome = (call.metadata?.confirmation as { outcome?: string } | undefined)?.outcome
  const missed = (call.metadata?.missed as { outcome?: string } | undefined)?.outcome
  const isMissed = appointment?.kind === 'missed'
  const human = Boolean(call.metadata?.human_takeover)
  const talking = call.status === 'in_progress'
  // Atalhos no teclado numérico: 0 = Assumir, 1 = Ouvir (no LiveListen), 2 = Encerrar, 3 = Caixa postal, + = Ligar novamente (só com ligação em andamento/encerrada conforme o caso, e fora de campos de texto).
  const shortcuts = useRef({ done, talking, human, ending, takingOver, markingAnswered, markingVoicemail, redialing, onTakeover, onEnd, onMarkAnswered, onMarkVoicemail, onRedial })
  shortcuts.current = { done, talking, human, ending, takingOver, markingAnswered, markingVoicemail, redialing, onTakeover, onEnd, onMarkAnswered, onMarkVoicemail, onRedial }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const s = shortcuts.current
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (event.code === 'NumpadAdd') { if (s.done && s.onRedial && !s.redialing) { event.preventDefault(); s.onRedial() } return }
      if (s.done) return
      if (event.code === 'Numpad0') { if (!s.human && !s.takingOver) { event.preventDefault(); s.onTakeover() } }
      else if (event.code === 'Numpad2') { if (!s.ending) { event.preventDefault(); s.onEnd() } }
      else if (event.code === 'Numpad3') { if (!s.human && !s.markingVoicemail) { event.preventDefault(); s.onMarkVoicemail() } }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const booking = (call.metadata?.booking_proposal ?? null) as BookingView | null
  const [deciding, setDeciding] = useState(false)
  const decide = useCallback((decision: 'approve' | 'reject') => {
    setDeciding(true)
    void api.bookingDecision(call.id, decision).catch(() => undefined).finally(() => setDeciding(false))
  }, [call.id])
  const bookingPending = booking?.status === 'pending' && !done
  const decideRef = useRef(decide); decideRef.current = decide
  const pendingRef = useRef(bookingPending); pendingRef.current = bookingPending
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code !== 'Numpad4' || event.repeat || !pendingRef.current) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      event.preventDefault(); decideRef.current('approve')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const tone = outcome === 'confirmou' || missed === 'lista_espera' ? 'ok' : outcome === 'desmarcou' ? 'bad' : outcome === 'remarcar' || missed === 'remarcar_horario' || missed === 'outro_interesse' ? 'warn' : done ? 'idle' : talking ? 'live' : 'wait'

  let result = <span className="cw-result wait"><PhoneCall size={14}/> {talking ? (isMissed ? 'Conversando com o paciente...' : 'Aguardando a resposta do paciente...') : 'Aguardando atender...'}</span>
  const sim = appointment?.test ? ' (teste, nada gravado)' : ''
  if (missed === 'lista_espera') result = <span className="cw-result ok"><CheckCircle2 size={15}/> Colocado(a) na LISTA DE ESPERA{sim}</span>
  else if (missed === 'remarcar_horario') result = <span className="cw-result warn"><RotateCcw size={15}/> Escolheu um horário: assuma e agende</span>
  else if (missed === 'outro_interesse') result = <span className="cw-result warn"><RotateCcw size={15}/> Tem outro interesse: assuma a ligação</span>
  else if (missed === 'sem_interesse') result = <span className="cw-result idle"><PhoneOff size={14}/> Sem interesse em remarcar</span>
  else if (outcome === 'confirmou') result = <span className="cw-result ok"><CheckCircle2 size={15}/> Consulta CONFIRMADA{appointment?.test ? ' (teste, nada gravado)' : ''}</span>
  else if (outcome === 'desmarcou') result = <span className="cw-result bad"><XCircle size={15}/> Consulta DESMARCADA{appointment?.test ? ' (teste, nada gravado)' : ''}</span>
  else if (outcome === 'remarcar') result = <span className="cw-result warn"><RotateCcw size={15}/> Quer remarcar: assuma a ligação</span>
  else if (done && call.status === 'completed') result = <span className="cw-result idle">{isMissed ? 'Encerrou sem registrar resultado' : 'Encerrou sem confirmar nem desmarcar'}</span>
  else if (done) result = <span className="cw-result idle"><PhoneOff size={14}/> {statusText[call.status]}</span>

  return <aside ref={drag.ref} className={`call-widget cw-${tone}`} style={drag.style} role="status" aria-live="polite">
    <header className="cw-drag-handle" onMouseDown={drag.onHeaderMouseDown}>
      <span className={`cw-dot ${done ? '' : 'pulse'}`}/>
      <strong>{statusText[call.status]}</strong>
      {talking && <span className="cw-time">{clock(elapsed)}</span>}
      {human && <span className="cw-badge">Você assumiu</span>}
      {isMissed && <span className="cw-badge">FALTOSO</span>}
      {appointment?.kind === 'card' && <span className="cw-badge">CARTÃO DE TODOS</span>}
      {appointment?.cardStatus === 'sem_cartao' && <span className="cw-badge cw-badge-warn">SEM CARTÃO DE TODOS</span>}
      {appointment?.cardStatus === 'devendo' && <span className="cw-badge cw-badge-warn">CARTÃO EM ATRASO</span>}
      {appointment?.test && <span className="cw-badge">TESTE</span>}
      <button aria-label="Fechar" onClick={onClose}><X size={15}/></button>
    </header>
    <div className="cw-body">
      <b>{call.patientName}</b>
      <small>{maskPhone(call.phone)}</small>
      {appointment && <small>{appointment.specialty}{appointment.date ? ` · ${dayLabel(appointment.date)} ${appointment.time ?? ''}` : ''}{appointment.professional ? ` · ${appointment.professional}` : ''}</small>}
      {result}
    </div>
    {booking && <div className={`cw-booking cw-booking-${booking.status}`}>
      <strong>{booking.status === 'pending' ? 'Agendar esta consulta?' : booking.status === 'booking' ? 'Agendando na AMEI...' : booking.status === 'booked' ? `Agendado na AMEI (nº ${booking.appointmentId})` : booking.status === 'rejected' ? 'Agendamento recusado' : booking.status === 'expired' ? 'Agendamento expirou (a Giovana passou para o Marcos)' : 'Não consegui agendar'}</strong>
      <span>{booking.patient} · {booking.specialty}</span>
      <span>{dayLabel(booking.date)} às {booking.time} · {booking.professional}</span>
      <span>{booking.procedure} · {booking.partner} · R$ {booking.price} · {booking.local}</span>
      {booking.message && <small className="cw-err">{booking.message}</small>}
      {bookingPending && <div className="cw-booking-actions">
        <button className="cw-act cw-act-take" disabled={deciding} onClick={() => decide('approve')}>Agendar [4]</button>
        <button className="cw-act" disabled={deciding} onClick={() => decide('reject')}>Recusar</button>
      </div>}
    </div>}
    {!done && <div className="cw-actions">
      {!demo && <LiveListen key={call.id} compact callId={call.id} active={!done} humanTakeover={human}/>}
      {talking && !human && <button className="cw-act cw-act-take" disabled={markingAnswered} title="Use se perceber que a pessoa atendeu e está falando, mas a Giovana continua muda" onClick={onMarkAnswered}><PhoneCall size={13}/>{markingAnswered ? 'Avisando...' : 'Atendeu'}</button>}
      {!human && <button className="cw-act cw-act-take" disabled={markingVoicemail} title="Use se perceber que caiu na caixa postal/gravação: desliga e já manda o WhatsApp de confirmação" onClick={onMarkVoicemail}><PhoneOff size={13}/>{markingVoicemail ? 'Marcando...' : 'Caixa postal [3]'}</button>}
      <button className="cw-act cw-act-take" disabled={human || takingOver} onClick={onTakeover}><Hand size={13}/>{human ? 'Assumida' : takingOver ? 'Assumindo...' : 'Assumir [0]'}</button>
      <button className="cw-act cw-act-end" disabled={ending} onClick={onEnd}><PhoneOff size={13}/>{ending ? 'Encerrando...' : 'Encerrar [2]'}</button>
    </div>}
    {done && onRedial && <div className="cw-actions">
      <button className="cw-act cw-act-take" disabled={redialing} title={`Ligar de novo para o mesmo número (${maskPhone(call.phone)})`} onClick={onRedial}><Redo2 size={13}/>{redialing ? 'Ligando...' : 'Ligar novamente [+]'}</button>
    </div>}
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
