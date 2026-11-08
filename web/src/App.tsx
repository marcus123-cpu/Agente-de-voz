import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Activity, ArrowRight, CalendarCheck, BrainCircuit, Clock3, History, LayoutDashboard, LogOut, Phone, PhoneOff, Search, Settings2, Sparkles, Users, Workflow, X } from 'lucide-react'
import { api } from './api'
import { LiveListen } from './LiveListen'
import { ContactsPanel } from './Contacts'
import { AutomationsPanel } from './Automations'
import { ConfirmPanel } from './ConfirmAgenda'
import { CallWidget, StartFailureWidget } from './CallWidget'
import type { Brain, Call, CallStatus, ConnectionDetails, IntegrationStatus, Result } from './types'

const demo = import.meta.env.VITE_DEMO_MODE === 'true'
const demoBrain: Brain = { id: 'demo-brain', name: 'Captação de Pacientes', slug: 'patient-acquisition', description: 'Agente responsável por abordar potenciais pacientes.', objective: 'Conversar com novos pacientes e identificar interesse em agendamento.', systemPrompt: 'Você é Giovana, assistente virtual de atendimento da clínica.', elevenlabsAgentId: null, voiceName: null, isActive: true }
const terminal: CallStatus[] = ['completed', 'failed', 'busy', 'no_answer', 'canceled']
const labels: Record<CallStatus, string> = { idle: 'Aguardando', connecting: 'Conectando', ringing: 'Chamando', in_progress: 'Ligação em andamento', completed: 'Encerrada', failed: 'Falhou', busy: 'Ocupado', no_answer: 'Não atendeu', canceled: 'Cancelada' }
const resultLabels: Record<Result, string> = { interested: 'Interessado', not_interested: 'Sem interesse', callback: 'Retornar depois', do_not_contact: 'Não deseja contato', unknown: 'Não identificado' }
type View = 'atendimento' | 'confirm' | 'brains' | 'history' | 'contacts' | 'automation' | 'settings'
function formatPhone(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '').slice(0, 11)
  if (digits.length <= 2) return digits ? `(${digits}` : ''
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
  return `(${digits.slice(0, 2)}) ${digits.slice(2, digits.length - 4)}-${digits.slice(-4)}`
}
function e164(value: string) { const digits = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''); return /^[1-9]\d{9,10}$/.test(digits) ? `+55${digits}` : null }
function duration(seconds: number) { const s = Math.max(0, seconds); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
function date(value?: string | null) { return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—' }
function StatusBadge({ status }: { status: CallStatus }) { return <span className={`status-badge status-${status}`}><span className="status-dot"/>{labels[status]}</span> }
function EmptyState() { return <div className="empty-state"><div className="empty-symbol"><Phone size={28}/></div><h2>Nenhuma ligação em andamento</h2><p>Informe o nome e o telefone para iniciar uma chamada pelo cVortex.</p></div> }
function LoadingState() { return <div className="loading-state"><span className="spinner"/> Carregando dados...</div> }
function Toast({ message, onClose }: { message: string; onClose: () => void }) { return <div className="toast" role="alert">{message}<button aria-label="Fechar aviso" onClick={onClose}><X size={16}/></button></div> }
function Sidebar({ view, setView, logout }: { view: View; setView: (view: View) => void; logout: () => void }) {
  const items: { id: View; label: string; icon: typeof Phone; soon?: boolean }[] = [{ id: 'atendimento', label: 'Atendimento', icon: LayoutDashboard }, { id: 'confirm', label: 'Confirmar agenda', icon: CalendarCheck }, { id: 'brains', label: 'Cérebros IA', icon: BrainCircuit }, { id: 'history', label: 'Histórico', icon: History }, { id: 'settings', label: 'Conexões', icon: Settings2 }, { id: 'contacts', label: 'Contatos', icon: Users }, { id: 'automation', label: 'Automações', icon: Workflow }]
  return <aside className="sidebar"><div className="brand"><div className="brand-mark"><Activity size={21}/></div><div><strong>Voice AI</strong><small>Central de Atendimento</small></div></div><div className="side-label">WORKSPACE</div><nav>{items.map(({ id, label, icon: Icon, soon }) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => setView(id)}><Icon size={18}/><span>{label}</span>{soon && <small>Em breve</small>}</button>)}</nav><div className="sidebar-bottom"><div className="workspace-tag"><span className="workspace-dot"/>Clínica · Operação</div><button className="logout" onClick={logout}><LogOut size={16}/> Sair</button></div></aside>
}
function Header({ view, integrations, ready }: { view: View; integrations: IntegrationStatus | null; ready: boolean | null }) {
  const titles: Record<View, string> = { atendimento: 'Atendimento por IA', confirm: 'Confirmar agenda', brains: 'Cérebros IA', history: 'Histórico de ligações', contacts: 'Contatos', automation: 'Automações', settings: 'Conexões' }
  return <header className="header"><div><div className="header-kicker">CENTRAL INTELIGENTE DE CHAMADAS</div><h1>{titles[view]}</h1></div><div className="header-right"><span className={`system-pill ${integrations?.cvortex ? '' : 'offline'}`}><span className="status-dot"/>cVortex: {integrations === null ? 'verificando' : integrations.cvortex ? 'disponível' : 'pendente'}</span><span className={`system-pill ${integrations?.elevenlabs ? '' : 'offline'}`}><span className="status-dot"/>ElevenLabs: {integrations === null ? 'verificando' : integrations.elevenlabs ? 'disponível' : 'pendente'}</span><span className={`system-pill ${ready ? '' : 'offline'}`}><span className="status-dot"/>{integrations === null ? 'Verificando...' : ready ? 'Pronto para chamadas' : 'Configuração pendente'}</span><div className="avatar-mini">MK</div></div></header>
}
function BrainSelector({ brains, selected, onSelect, ready }: { brains: Brain[]; selected: string; onSelect: (id: string) => void; ready: boolean | null }) {
  const brain = brains.find((item) => item.id === selected)
  const testUrl = brain?.elevenlabsAgentId
    ? `https://elevenlabs.io/app/talk-to?${new URLSearchParams({ agent_id: brain.elevenlabsAgentId, var_patient_name: 'Ana', var_contact_context: 'not_informed', var_origin: 'teste-navegador' })}`
    : null
  return <section className="brain-selector"><div className="brain-icon"><BrainCircuit size={25}/></div><div className="brain-select-main"><span className="eyebrow">CÉREBRO ATIVO</span><select value={selected} onChange={(event) => onSelect(event.target.value)} aria-label="Cérebro ativo">{brains.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div className="brain-objective"><span className="eyebrow">OBJETIVO</span><p>{brain?.objective || 'Selecione um cérebro para iniciar.'}</p></div><span className={`brain-ready ${ready === false ? 'not-ready' : ''}`}><span className="status-dot"/> {ready === null ? 'Verificando...' : ready ? 'Pronto para ligar' : 'Configuração pendente'}</span><button className="test-ai-button" disabled={!testUrl} title="Teste de voz no navegador, sem ligação telefônica. Usa a cota ElevenLabs." onClick={() => { if (testUrl) window.open(testUrl, '_blank', 'noopener,noreferrer') }}>Testar IA no navegador</button></section>
}
function DialerCard({ name, setName, phone, setPhone, contactContext, setContactContext, onCall, busy, enabled }: { name: string; setName: (s: string) => void; phone: string; setPhone: (s: string) => void; contactContext: 'not_informed' | 'recent_card_member'; setContactContext: (s: 'not_informed' | 'recent_card_member') => void; onCall: () => void; busy: boolean; enabled: boolean }) {
  return <section className="card dialer"><div className="card-heading"><div className="card-icon green-icon"><Phone size={18}/></div><div><h2>Discador cVortex</h2><p>Inicie um novo atendimento</p></div></div><div className="form"><label>Nome do paciente<input id="patient-name" autoComplete="off" placeholder="José Carlos" value={name} onChange={(event) => setName(event.target.value)}/></label><label>Telefone<input inputMode="tel" autoComplete="tel" placeholder="(17) 99654-3210" value={phone} onChange={(event) => setPhone(formatPhone(event.target.value))}/></label><p className="input-hint">Número brasileiro com DDD</p><label>Origem do contato<select value={contactContext} onChange={(event) => setContactContext(event.target.value as 'not_informed' | 'recent_card_member')}><option value="not_informed">Não informada</option><option value="recent_card_member">Recém-filiado ao Cartão de TODOS (confirmado)</option></select></label><p className="input-hint">Selecione recém-filiado somente se essa informação foi confirmada.</p><button className="call-button" disabled={!enabled || busy} onClick={onCall}><Phone size={18}/>{busy ? 'Conectando...' : 'Ligar pelo cVortex'}<ArrowRight size={17}/></button></div><div className="dialer-foot"><span className="shield-dot"/>IA exibida como conectada somente após confirmação</div></section>
}
function ParticipantCard({ name, ai, active }: { name: string; ai?: boolean; active: boolean }) { return <div className={`participant ${ai ? 'ai' : ''}`}><div className="participant-top"><span className="eyebrow">{ai ? 'ASSISTENTE IA' : 'PACIENTE'}</span>{ai && <span className="ai-badge">IA</span>}</div><div className={`participant-avatar ${ai ? 'ai-avatar' : ''}`}>{ai ? <Sparkles size={29}/> : name.slice(0, 1).toUpperCase()}</div><h3>{name}</h3><p>{ai ? active ? 'Conexão de IA confirmada' : 'IA desconectada ou aguardando' : active ? 'Ligação em andamento' : 'Aguardando'}</p><span className={`participant-status ${active ? 'active' : ''}`}><span className="status-dot"/>{active ? ai ? 'IA conectada' : 'Em ligação' : 'Aguardando'}</span></div> }
function CallControlBar({ active, aiConnected, humanTakeover, takingOver, ending, onTakeover, onEnd }: { active: boolean; aiConnected: boolean; humanTakeover: boolean; takingOver: boolean; ending: boolean; onTakeover: () => void; onEnd: () => void }) { return <div className="call-controls"><div><span className="eyebrow">AÇÕES DA LIGAÇÃO</span><p>{humanTakeover ? 'Seu microfone do webphone está ativo. Continue a conversa e desligue ao terminar.' : 'Quando a Giovana avisar que chamará um atendente, clique em Assumir.'}</p></div><div className="control-buttons"><button className="takeover" disabled={!active || !aiConnected || humanTakeover || takingOver || ending} onClick={onTakeover}>{humanTakeover ? 'Você assumiu' : takingOver ? 'Assumindo...' : 'Assumir ligação'}</button><button className="end-button" disabled={!active || ending || takingOver} onClick={onEnd}><PhoneOff size={16}/>{ending ? 'Encerrando...' : 'Desligar'}</button></div></div> }
function CallSummary({ call }: { call: Call | null }) { const summary = call?.summary || {}; const field = (key: string) => typeof summary[key] === 'string' && summary[key] ? String(summary[key]) : 'Não identificado'; return <section className="card info-card"><div className="section-title"><h3>Resumo da ligação</h3><Sparkles size={17}/></div><div className="summary-grid"><div><span>Paciente</span><strong>{call?.patientName || 'Não identificado'}</strong></div><div><span>Resultado</span><strong>{call?.result ? resultLabels[call.result as Result] || call.result : 'Não identificado'}</strong></div><div><span>Especialidade mencionada</span><strong>{field('specialty')}</strong></div><div><span>Próximo passo</span><strong>{field('nextStep')}</strong></div><div><span>Transferência solicitada</span><strong>{call?.transferRequested ? 'Sim' : 'Não identificado'}</strong></div></div></section> }

function ConnectionsPanel({ onNotice, onRefresh }: { onNotice: (message: string) => void; onRefresh: () => void }) {
  const [details, setDetails] = useState<ConnectionDetails | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  async function refresh() {
    if (demo) { setDetails({ cvortex: { browserOpen: false, loggedIn: false, activeCall: false }, elevenlabs: { keyConfigured: false, keyValid: null, agentId: null } }); return }
    setLoading(true)
    try { setDetails(await api.connections()); onRefresh() }
    catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Não foi possível verificar as conexões.') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let alive = true
    if (demo) setDetails({ cvortex: { browserOpen: false, loggedIn: false, activeCall: false }, elevenlabs: { keyConfigured: false, keyValid: null, agentId: null } })
    else void api.connections().then((value) => { if (alive) setDetails(value) }).catch(() => { if (alive) setDetails(null) })
    return () => { alive = false }
  }, [])
  async function openCvortex() {
    setBusy(true)
    try { await api.openCvortex(); onNotice('Perfil isolado aberto. Faça o login na janela do cVortex.'); window.setTimeout(() => { void refresh() }, 2500) }
    catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Não foi possível abrir o cVortex.') }
    finally { setBusy(false) }
  }
  async function saveKey(event: FormEvent) {
    event.preventDefault()
    if (!apiKey.trim()) return
    setBusy(true)
    try { setDetails(await api.connectElevenLabs(apiKey)); setApiKey(''); onRefresh(); onNotice('Chave ElevenLabs validada e salva no servidor.') }
    catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Não foi possível conectar a ElevenLabs.') }
    finally { setBusy(false) }
  }
  async function removeKey() {
    if (!window.confirm('Remover a chave ElevenLabs deste servidor? As ligações com IA ficarão indisponíveis até você conectar novamente.')) return
    setBusy(true)
    try { setDetails(await api.disconnectElevenLabs()); onRefresh(); onNotice('Chave ElevenLabs removida do servidor.') }
    catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Não foi possível remover a chave.') }
    finally { setBusy(false) }
  }
  return <div className="connections-page"><div className="page-intro"><span className="eyebrow">ACESSOS DO SISTEMA</span><h2>Conexões</h2><p>Gerencie o navegador isolado do cVortex e a chave usada pelo servidor para falar com a ElevenLabs.</p><button className="connection-secondary" onClick={() => void refresh()} disabled={loading || busy}>{loading ? 'Verificando...' : 'Atualizar status'}</button></div><div className="connection-grid">
    <section className="card connection-card"><div className="connection-card-head"><div className="card-icon green-icon"><Phone size={19}/></div><div><h3>cVortex</h3><p>Login no perfil isolado do webphone</p></div></div><span className={`connection-state ${details?.cvortex.loggedIn ? 'connected' : ''}`}>{details === null ? 'Verificando' : details.cvortex.loggedIn ? details.cvortex.activeCall ? 'Conectado · chamada ativa' : 'Conectado' : details.cvortex.browserOpen ? 'Navegador aberto · faça login' : 'Navegador fechado'}</span><p className="muted">O login é feito diretamente na janela do cVortex. Depois de entrar, volte aqui e atualize o status.</p><button className="connection-primary" onClick={() => void openCvortex()} disabled={busy || demo}>Abrir perfil cVortex</button></section>
    <section className="card connection-card"><div className="connection-card-head"><div className="card-icon"><Sparkles size={19}/></div><div><h3>ElevenLabs</h3><p>Chave de API do servidor</p></div></div><span className={`connection-state ${details?.elevenlabs.keyValid ? 'connected' : ''}`}>{details === null ? 'Verificando' : details.elevenlabs.keyValid === true ? 'Chave válida' : details.elevenlabs.keyValid === false ? 'Sem chave válida' : 'Não foi possível validar agora'}</span><p className="muted">A chave salva nunca aparece no painel. O agente usado em cada ligação é escolhido em Cérebros IA.</p><form onSubmit={(event) => void saveKey(event)}><label>Nova chave de API<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={details?.elevenlabs.keyConfigured ? 'Cole uma chave para substituir a atual' : 'Cole sua chave da ElevenLabs'} /></label><button className="connection-primary" disabled={busy || demo || !apiKey.trim()}>{busy ? 'Validando...' : details?.elevenlabs.keyConfigured ? 'Validar e substituir chave' : 'Validar e conectar'}</button></form><div className="connection-links"><button className="connection-secondary" onClick={() => window.open('https://elevenlabs.io/app/agents', '_blank', 'noopener,noreferrer')}>Abrir ElevenLabs</button>{details?.elevenlabs.keyConfigured && <button className="connection-remove" onClick={() => void removeKey()} disabled={busy || demo}>Remover chave</button>}</div></section>
  </div><p className="muted connection-foot">Para sair do cVortex, use a opção de sair dentro do próprio webphone. A conexão da ElevenLabs utiliza chave de API; entrar no site da ElevenLabs, por si só, não conecta o servidor.</p></div>
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(demo ? true : null)
  const [password, setPassword] = useState('')
  const [view, setView] = useState<View>('atendimento')
  const [brains, setBrains] = useState<Brain[]>(demo ? [demoBrain] : [])
  const [selectedBrain, setSelectedBrain] = useState(demo ? demoBrain.id : '')
  const [calls, setCalls] = useState<Call[]>([])
  const [call, setCall] = useState<Call | null>(null)
  const [widgetClosed, setWidgetClosed] = useState<string | null>(null)
  const [startFailure, setStartFailure] = useState<{ patientName: string; message: string } | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [contactContext, setContactContext] = useState<'not_informed' | 'recent_card_member'>('not_informed')
  const [busy, setBusy] = useState(false)
  const [ending, setEnding] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const [toast, setToast] = useState('')
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [result, setResult] = useState<Result>('unknown')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState<Call | null>(null)
  const [editing, setEditing] = useState<Brain | null>(null)
  const [creating, setCreating] = useState(false)
  const active = Boolean(call && !terminal.includes(call.status))
  const elapsed = call?.answeredAt ? Math.floor((clock - new Date(call.answeredAt).getTime()) / 1000) : call?.durationSeconds || 0
  const selected = useMemo(() => brains.find((item) => item.id === selectedBrain), [brains, selectedBrain])
  const ready = demo ? true : integrations === null ? null : Boolean(selected?.isActive && (selected.elevenlabsAgentId || selected.slug === 'patient-acquisition') && integrations.cvortex && integrations.elevenlabs && integrations.database)

  useEffect(() => { if (!demo) void api.session().then((value) => setAuthenticated(value.authenticated)).catch(() => setAuthenticated(false)) }, [])
  useEffect(() => { if (!authenticated || demo) return; void Promise.all([api.brains(), api.calls(), api.integrations()]).then(([brainList, callList, status]) => { setBrains(brainList); setSelectedBrain((old) => old || brainList.find((item) => item.isActive)?.id || ''); setCalls(callList); setIntegrations(status) }).catch((cause: unknown) => setToast(cause instanceof Error ? cause.message : 'Falha ao carregar dados')) }, [authenticated])
  useEffect(() => {
    if (!authenticated || demo) return
    let alive = true
    let fetching = false
    const timer = window.setInterval(() => {
      if (fetching) return
      fetching = true
      void api.integrations()
        .then((status) => { if (alive) setIntegrations(status) })
        .catch(() => { /* Preserve the last confirmed availability until the next check. */ })
        .finally(() => { fetching = false })
    }, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [authenticated])
  useEffect(() => {
    if (!call?.id || !active || demo) return
    let alive = true
    let fetching = false
    const id = call.id
    const refresh = async () => {
      if (fetching) return
      fetching = true
      try {
        const updated = await api.call(id)
        if (!alive) return
        setCall((previous) => previous?.id === id && !terminal.includes(previous.status) ? updated : previous)
        setCalls((previous) => previous.map((item) => item.id === id && !terminal.includes(item.status) ? updated : item))
      } catch { /* A próxima consulta tentará novamente; a interface preserva o último estado confirmado. */ }
      finally { fetching = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [call?.id, active])
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer) }, [active])

  async function login(event: FormEvent) { event.preventDefault(); setBusy(true); try { await api.login(password); setAuthenticated(true); setPassword('') } catch (cause) { setToast(cause instanceof Error ? cause.message : 'Não foi possível entrar') } finally { setBusy(false) } }
  async function startCall() {
    const normalized = e164(phone)
    if (!normalized) { setToast('Informe um telefone brasileiro válido com DDD.'); return }
    if (!name.trim() || !selectedBrain) { setToast('Informe o nome e selecione um cérebro.'); return }
    setBusy(true)
    setResult('unknown')
    setNotes('')
    try {
      if (demo) {
        const fake: Call = { id: crypto.randomUUID(), brainId: selectedBrain, patientName: name.trim(), phone: normalized, status: 'connecting', startedAt: new Date().toISOString(), createdAt: new Date().toISOString() }
        setCall(fake); setCalls((old) => [fake, ...old]); setToast('Modo demonstração: nenhuma ligação real será feita.')
      } else { const created = await api.startCall(selectedBrain, name.trim(), normalized, contactContext); setCall(created); setCalls((old) => [created, ...old]) }
    } catch (cause) { setToast(cause instanceof Error ? cause.message : 'Não foi possível iniciar a chamada') } finally { setBusy(false) }
  }
  async function endCall() { if (!call) return; setEnding(true); try { if (demo) { const ended = { ...call, status: 'completed' as const, endedAt: new Date().toISOString(), durationSeconds: elapsed }; setCall(ended); setCalls((old) => old.map((item) => item.id === ended.id ? ended : item)) } else { await api.endCall(call.id); setCall(await api.call(call.id)) } } catch (cause) { setToast(cause instanceof Error ? cause.message : 'Não foi possível encerrar') } finally { setEnding(false) } }
  async function takeoverCall() { if (!call) return; setTakingOver(true); try { const updated = demo ? { ...call, metadata: { ...(call.metadata || {}), ai_connected: false, human_takeover: true } } : await api.takeoverCall(call.id); setCall(updated); setCalls((old) => old.map((item) => item.id === updated.id ? updated : item)); setToast('Ligação assumida. Fale pelo microfone do webphone cVortex.') } catch (cause) { setToast(cause instanceof Error ? cause.message : 'Não foi possível assumir a ligação') } finally { setTakingOver(false) } }
  async function saveResult() { if (!call) return; setSaving(true); try { if (demo) { const updated = { ...call, result }; setCall(updated); setCalls((old) => old.map((item) => item.id === updated.id ? updated : item)) } else { await api.saveResult(call.id, result, notes); setCall(await api.call(call.id)); setCalls(await api.calls()) } setToast('Resultado salvo.') } catch (cause) { setToast(cause instanceof Error ? cause.message : 'Não foi possível salvar o resultado') } finally { setSaving(false) } }
  async function saveBrain() { if (!editing) return; try { const updated = demo ? editing : await api.updateBrain(editing.id, { name: editing.name, description: editing.description || '', objective: editing.objective || '', systemPrompt: editing.systemPrompt || '', elevenlabsAgentId: editing.elevenlabsAgentId || '', isActive: editing.isActive }); setBrains((old) => old.map((item) => item.id === updated.id ? updated : item)); setEditing(null); setToast('Cérebro atualizado.') } catch (cause) { setToast(cause instanceof Error ? cause.message : 'Não foi possível salvar o cérebro') } }
  async function createBrain() { if (!editing) return; try { const created = demo ? { ...editing, id: crypto.randomUUID() } : await api.createBrain({ name: editing.name, description: editing.description, objective: editing.objective, systemPrompt: editing.systemPrompt, elevenlabsAgentId: editing.elevenlabsAgentId, isActive: editing.isActive }); setBrains((old) => [...old, created]); setEditing(null); setCreating(false); setToast('Cérebro criado. Vincule um Agent ID da ElevenLabs para usá-lo em ligações.') } catch (cause) { setToast(cause instanceof Error ? cause.message : 'Não foi possível criar o cérebro') } }
  function newBrain(kind: 'confirmation' | 'missed' | 'custom') { const templates = { confirmation: { name: 'Confirmação de consultas', objective: 'Confirmar consultas existentes com informações fornecidas pela clínica.', description: 'Agente para confirmação, após integrar agenda e regras da clínica.' }, missed: { name: 'Pacientes faltosos', objective: 'Retomar contato com pacientes que faltaram e identificar interesse em reagendar.', description: 'Agente de retorno, após integrar lista de faltas e consentimento.' }, custom: { name: 'Novo contexto', objective: '', description: 'Contexto personalizado para um agente específico.' } }; const item = templates[kind]; setEditing({ id: '', slug: '', name: item.name, description: item.description, objective: item.objective, systemPrompt: '', elevenlabsAgentId: null, voiceName: null, isActive: false }); setCreating(true) }
  if (authenticated === null) return <div className="app-loading"><LoadingState/></div>
  if (!authenticated) return <div className="login-screen"><div className="login-panel"><div className="brand login-brand"><div className="brand-mark"><Activity size={21}/></div><div><strong>Voice AI</strong><small>Central de Atendimento</small></div></div><span className="eyebrow">ACESSO DO OPERADOR</span><h1>Bem-vindo de volta.</h1><p>Entre para iniciar e acompanhar os atendimentos.</p><form onSubmit={(event) => void login(event)}><label>Senha de acesso<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required/></label><button className="call-button" disabled={busy}>{busy ? 'Entrando...' : 'Entrar'}<ArrowRight size={17}/></button></form></div>{toast && <Toast message={toast} onClose={() => setToast('')}/>}</div>
  return <div className="app-shell"><Sidebar view={view} setView={setView} logout={() => { if (!demo) void api.logout(); setAuthenticated(false) }}/><main className="main"><Header view={view} integrations={integrations} ready={ready}/><div className="content">{demo && <div className="demo-banner">MODO DEMONSTRAÇÃO · Nenhuma chamada ou monitoramento real será iniciado.</div>}
    {view === 'atendimento' && <>
      <BrainSelector brains={brains} selected={selectedBrain} onSelect={setSelectedBrain} ready={ready}/>
      <div className="dashboard-grid">
        <DialerCard name={name} setName={setName} phone={phone} setPhone={setPhone} contactContext={contactContext} setContactContext={setContactContext} onCall={() => void startCall()} busy={busy} enabled={!active && ready === true}/>
        <div className="call-column">
          <section className="card call-stage">
            <div className="call-stage-head"><div><span className="eyebrow">CHAMADA ATUAL</span><div className="stage-status">{call ? <StatusBadge status={call.status}/> : <StatusBadge status="idle"/>}</div></div><div className="timer"><Clock3 size={17}/>{call ? duration(elapsed) : '00:00:00'}</div></div>
            {call ? <>
              <div className="participants"><ParticipantCard name={call.patientName} active={call.status === 'in_progress'}/><ParticipantCard name={brains.find((brain) => brain.id === call.brainId)?.name || 'Giovana'} ai active={call.metadata?.ai_connected === true}/></div>
              <CallControlBar active={active} aiConnected={call.metadata?.ai_connected === true} humanTakeover={call.metadata?.human_takeover === true} takingOver={takingOver} ending={ending} onTakeover={() => void takeoverCall()} onEnd={() => void endCall()}/>
              {!demo && <LiveListen callId={call.id} active={active} humanTakeover={call.metadata?.human_takeover === true}/>}
            </> : <EmptyState/>}
          </section>
          {call && terminal.includes(call.status) && <section className="card result-card"><div className="section-title"><h3>Resultado do atendimento</h3><StatusBadge status={call.status}/></div><p className="muted">Classifique a ligação e registre uma observação opcional.</p><div className="result-form"><label>Resultado<select value={result} onChange={(event) => setResult(event.target.value as Result)}>{Object.entries(resultLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Adicionar observação<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Observação do operador"/></label><button onClick={() => void saveResult()} disabled={saving}>{saving ? 'Salvando...' : 'Salvar resultado'}</button></div></section>}
        </div>
      </div>
      {call && <div className="bottom-grid"><CallSummary call={call}/></div>}
    </>}
    {view === 'brains' && <div className="page-panel"><div className="page-intro"><span className="eyebrow">CONFIGURAÇÃO DE IA</span><h2>Cérebros disponíveis</h2><p>Cada cérebro usa um Agent ID próprio da ElevenLabs. Captação continua como opção principal.</p><div className="brain-create-actions"><button onClick={() => newBrain('confirmation')}>+ Confirmação</button><button onClick={() => newBrain('missed')}>+ Faltosos</button><button onClick={() => newBrain('custom')}>+ Contexto personalizado</button></div></div>{brains.map((brain) => <div className="brain-list-card" key={brain.id}><div className="brain-list-icon"><BrainCircuit size={23}/></div><div><h3>{brain.name}</h3><p>{brain.description || 'Sem descrição.'}</p><span className="small-pill">{brain.isActive ? 'Ativo' : 'Inativo'}</span></div><button onClick={() => { setCreating(false); setEditing({ ...brain }) }}>Editar cérebro <ArrowRight size={16}/></button></div>)}</div>}
    {view === 'history' && <div className="page-panel"><div className="page-intro"><span className="eyebrow">REGISTROS</span><h2>Histórico de ligações</h2><p>Consulte os atendimentos e os resultados salvos.</p></div><div className="table-wrap"><table><thead><tr><th>Paciente</th><th>Telefone</th><th>Cérebro</th><th>Data</th><th>Duração</th><th>Resultado</th><th>Status</th></tr></thead><tbody>{calls.map((item) => <tr key={item.id} onClick={() => setDetail(item)}><td>{item.patientName}</td><td>{formatPhone(item.phone)}</td><td>{brains.find((brain) => brain.id === item.brainId)?.name || '—'}</td><td>{date(item.createdAt)}</td><td>{item.durationSeconds == null ? '—' : duration(item.durationSeconds)}</td><td>{item.result ? resultLabels[item.result as Result] || item.result : 'Não identificado'}</td><td><StatusBadge status={item.status}/></td></tr>)}</tbody></table>{calls.length === 0 && <div className="table-empty"><Search size={22}/> Nenhuma chamada registrada ainda.</div>}</div></div>}
    {view === 'settings' && <ConnectionsPanel onNotice={setToast} onRefresh={() => { if (!demo) void api.integrations().then(setIntegrations).catch(() => undefined) }}/>}
    {view === 'confirm' && (demo ? <div className="soon-page"><Sparkles size={30}/><h2>Indisponível na demonstração</h2></div> : <ConfirmPanel brainId={selectedBrain} canCall={!active && ready === true} onNotice={setToast} onFailed={(patientName, message) => setStartFailure({ patientName, message })} onStarted={(created) => { setStartFailure(null); setCall(created); setCalls((old) => [created, ...old]); setResult('unknown'); setNotes('') }} outcomeKey={`${call?.id ?? ''}:${String((call?.metadata?.confirmation as { outcome?: string } | undefined)?.outcome ?? (call?.metadata?.missed as { outcome?: string } | undefined)?.outcome ?? '')}`}/>)}
    {view === 'contacts' && (demo ? <div className="soon-page"><Sparkles size={30}/><h2>Indisponível na demonstração</h2></div> : <ContactsPanel onNotice={setToast} onCall={(contactName, contactPhone) => { setName(contactName); setPhone(formatPhone(contactPhone)); setView('atendimento') }}/>)}
    {view === 'automation' && (demo ? <div className="soon-page"><Sparkles size={30}/><h2>Indisponível na demonstração</h2></div> : <AutomationsPanel onNotice={setToast}/>)}
  </div></main>{startFailure && <StartFailureWidget patientName={startFailure.patientName} message={startFailure.message} onClose={() => setStartFailure(null)}/>}{!startFailure && call && view !== 'atendimento' && widgetClosed !== call.id && <CallWidget call={call} elapsed={elapsed} onOpen={() => setView('atendimento')} onClose={() => setWidgetClosed(call.id)} onRefresh={() => { if (!demo) void api.call(call.id).then((updated) => { setCall((previous) => previous?.id === updated.id ? updated : previous); setCalls((previous) => previous.map((item) => item.id === updated.id ? updated : item)) }).catch(() => undefined) }}/>}{toast && <Toast message={toast} onClose={() => setToast('')}/>}
  {detail && <div className="modal-backdrop" onClick={() => setDetail(null)}><div className="modal detail-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDetail(null)}><X size={20}/></button><span className="eyebrow">DETALHES DA LIGAÇÃO</span><h2>{detail.patientName}</h2><div className="detail-grid"><div><span>Telefone</span><strong>{formatPhone(detail.phone)}</strong></div><div><span>Status</span><StatusBadge status={detail.status}/></div><div><span>Início</span><strong>{date(detail.startedAt)}</strong></div><div><span>Atendimento</span><strong>{date(detail.answeredAt)}</strong></div><div><span>Fim</span><strong>{date(detail.endedAt)}</strong></div><div><span>Duração</span><strong>{detail.durationSeconds == null ? '—' : duration(detail.durationSeconds)}</strong></div><div><span>Resultado</span><strong>{detail.result ? resultLabels[detail.result as Result] || detail.result : 'Não identificado'}</strong></div><div><span>Call ID cVortex</span><strong className="id-text">{detail.cvortexCallId || '—'}</strong></div><div><span>Conversation ID ElevenLabs</span><strong className="id-text">{detail.elevenlabsConversationId || '—'}</strong></div></div></div></div>}
  {editing && <div className="modal-backdrop" onClick={() => { setEditing(null); setCreating(false) }}><div className="modal brain-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => { setEditing(null); setCreating(false) }}><X size={20}/></button><span className="eyebrow">CÉREBRO IA</span><h2>{creating ? 'Criar cérebro' : `Editar ${editing.name}`}</h2><label>Nome<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })}/></label><label>Descrição<textarea rows={2} value={editing.description || ''} onChange={(event) => setEditing({ ...editing, description: event.target.value })}/></label><label>Objetivo<textarea rows={2} value={editing.objective || ''} onChange={(event) => setEditing({ ...editing, objective: event.target.value })}/></label><label>ElevenLabs Agent ID<input value={editing.elevenlabsAgentId || ''} onChange={(event) => setEditing({ ...editing, elevenlabsAgentId: event.target.value })}/></label><label className="brain-active-label"><input type="checkbox" checked={editing.isActive} onChange={(event) => setEditing({ ...editing, isActive: event.target.checked })}/> Cérebro ativo</label><label>Contexto planejado<textarea rows={9} value={editing.systemPrompt || ''} onChange={(event) => setEditing({ ...editing, systemPrompt: event.target.value })}/></label><p className="muted">O contexto fica salvo aqui para planejamento. Para mudar o que o agente fala, configure o prompt também na ElevenLabs. Cada cérebro precisa de um Agent ID próprio antes de ligar.</p><button className="call-button" onClick={() => void (creating ? createBrain() : saveBrain())}>{creating ? 'Criar cérebro' : 'Salvar alterações'}</button></div></div>}
  </div>
}
