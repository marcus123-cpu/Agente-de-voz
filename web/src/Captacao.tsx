import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, PlayCircle, Phone, Search, StopCircle } from 'lucide-react'
import { api } from './api'
import type { AutoConfirmStatus, Call, CampaignJobStatus, CampaignMode, CampaignRow, ConfirmOptions, RecoveryInfo } from './types'

function todayIso() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) }
function addDays(iso: string, days: number) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
/** Atalhos de período: hoje, ontem, 7 dias, semana passada (seg a dom) e este mês. */
function presetRange(kind: 'hoje' | 'ontem' | '7dias' | 'semana' | 'mes'): { from: string; to: string } {
  const today = todayIso()
  if (kind === 'hoje') return { from: today, to: today }
  if (kind === 'ontem') { const y = addDays(today, -1); return { from: y, to: y } }
  if (kind === '7dias') return { from: addDays(today, -6), to: today }
  if (kind === 'semana') { const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); const monday = addDays(today, -((dow + 6) % 7) - 7); return { from: monday, to: addDays(monday, 6) } }
  return { from: `${today.slice(0, 7)}-01`, to: today }
}
const CARD_TAGS: Record<NonNullable<CampaignRow['cardStatus']>, { label: string; className: string }> = {
  ativo: { label: 'Cartão ativo', className: 'tag tag-ok' }, devendo: { label: 'Cartão em atraso', className: 'tag tag-block' },
  sem_cartao: { label: 'Sem Cartão de TODOS', className: 'tag tag-block' }, nao_conferido: { label: 'Não conferido', className: 'tag' },
}
function dmy(iso: string) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
function formatPhone(value: string) {
  const d = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '')
  return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : value || '—'
}
const RESOLVED_RECOVERY = new Set(['reagendado', 'recuperado', 'outra_especialidade'])
const recoveryTagClass = (status: RecoveryInfo['status']) => RESOLVED_RECOVERY.has(status) ? 'tag tag-ok' : status === 'conferir' ? 'tag' : 'tag tag-block'
/** Mesma lógica de ConfirmAgenda.tsx: quando reagendou, ou quantas vagas tem (ou só lista de espera). */
function availabilityDetail(row: CampaignRow): string {
  const a = row.availability
  if (!a) return ''
  if (!a.count) return 'Sem vaga livre agora — só lista de espera'
  const first = a.next[0]
  const where = a.professionalOnly ? 'com o mesmo profissional' : 'na especialidade (outro profissional)'
  return `${a.count} vaga${a.count === 1 ? '' : 's'} livre${a.count === 1 ? '' : 's'} ${where}${first ? `, próxima ${dmy(first.date)} às ${first.time}` : ''}`
}

export function CaptacaoPanel({ brainId, canCall, onNotice, onStarted, onFailed }: { brainId: string; canCall: boolean; onNotice: (message: string) => void; onStarted: (call: Call) => void; onFailed: (patientName: string, message: string) => void }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [professionals, setProfessionals] = useState<{ id: string; name: string }[]>([])
  const [specialtyId, setSpecialtyId] = useState('')
  const [professionalId, setProfessionalId] = useState('')
  const [mode, setMode] = useState<CampaignMode>('faltosos')
  const [dateFrom, setDateFrom] = useState(presetRange('ontem').from)
  const [dateTo, setDateTo] = useState(presetRange('ontem').to)
  const [situations, setSituations] = useState<'faltou_desmarcou' | 'faltou' | 'desmarcou'>('faltou_desmarcou')
  const [cardFilter, setCardFilter] = useState<'todos' | 'sem_cartao'>('todos')
  const [job, setJob] = useState<CampaignJobStatus | null>(null)
  const [searching, setSearching] = useState(false)
  const [calling, setCalling] = useState<string | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [test, setTest] = useState({ phone: '', patientName: 'Maria da Silva Souza', professional: 'Dra. Ana Souza Exemplo', specialty: 'Psiquiatria', date: todayIso(), time: '08:00', situation: 'faltou' })
  const [testing, setTesting] = useState(false)
  const firstSpecialty = useRef(true)
  const [auto, setAuto] = useState<AutoConfirmStatus | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)
  const lastAutoCallId = useRef<string | null>(null)
  const onStartedRef = useRef(onStarted)
  onStartedRef.current = onStarted
  const fail = useCallback((cause: unknown, fallback: string) => onNotice(cause instanceof Error ? cause.message : fallback), [onNotice])

  useEffect(() => { void api.confirmOptions().then(setOptions).catch((c) => fail(c, 'Não foi possível carregar os filtros da AMEI.')) }, [fail])
  useEffect(() => {
    if (firstSpecialty.current) firstSpecialty.current = false; else setProfessionalId('')
    if (!specialtyId) { setProfessionals([]); return }
    void api.confirmProfessionals(specialtyId).then(setProfessionals).catch(() => setProfessionals([]))
  }, [specialtyId])

  // Dá poll no job enquanto ele estiver rodando, mostrando resultado parcial aos poucos.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    let alive = true
    const timer = window.setInterval(() => {
      void api.campaignSearchStatus(job.jobId).then((value) => { if (alive) setJob(value) }).catch((cause) => { if (alive) { fail(cause, 'Não foi possível acompanhar a busca.'); setJob(null) } })
    }, 1500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [job, fail])

  // Esteira: confere o status sempre e, quando ela inicia uma ligação sozinha, empurra a ligação pro painel (ouvir ao vivo e widget).
  useEffect(() => {
    let alive = true
    const poll = () => {
      void api.captacaoAutoStatus().then((value) => {
        if (!alive) return
        setAuto(value)
        if (value.currentCallId && value.currentCallId !== lastAutoCallId.current) {
          lastAutoCallId.current = value.currentCallId
          void api.call(value.currentCallId).then((current) => { if (alive) onStartedRef.current(current) }).catch(() => undefined)
        }
      }).catch(() => undefined)
    }
    poll()
    const timer = window.setInterval(poll, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  async function toggleAuto(startFrom?: { id: string; direction: 'up' | 'down' }) {
    setAutoBusy(true)
    try {
      if (auto?.active) { setAuto(await api.stopCaptacaoAuto()); onNotice('Esteira desligada.') }
      else {
        if (!job) { onNotice('Faça a busca primeiro.'); return }
        setAuto(await api.startCaptacaoAuto({ brainId, jobId: job.jobId, startFromId: startFrom?.id, startFromDirection: startFrom?.direction }))
        onNotice(startFrom ? `Esteira ligada a partir desse paciente, pra ${startFrom.direction === 'down' ? 'baixo' : 'cima'}.` : 'Esteira ligada: chamando um paciente atrás do outro.')
      }
    } catch (cause) { fail(cause, 'Não foi possível mudar a esteira.') }
    finally { setAutoBusy(false) }
  }

  async function search() {
    if (!specialtyId) { onNotice('Escolha a especialidade.'); return }
    setSearching(true)
    try {
      const { jobId } = await api.startCampaignSearch({ mode, specialtyId, professionalId: professionalId || undefined, dateFrom, dateTo, situations: mode === 'faltosos' ? situations : undefined, cardFilter })
      setJob({ jobId, status: 'running', checked: 0, total: 0, found: 0, results: [], truncated: false })
    } catch (cause) { fail(cause, 'Não foi possível iniciar a busca na AMEI.') }
    finally { setSearching(false) }
  }

  async function call(row: CampaignRow) {
    const detail = availabilityDetail(row)
    const when = row.mode === 'faltosos' ? `faltou em ${dmy(row.originDate)}` : row.mode === 'cartao' ? `foi atendido em ${dmy(row.originDate)} pelo particular${row.value ? ` (pagou R$ ${row.value})` : ''}, sem Cartão de TODOS` : `na lista de espera desde ${dmy(row.originDate)}`
    const question = `Ligar agora para ${row.patientName} (${formatPhone(row.phone)}) — ${row.specialty}, ${when}?${detail ? ` ${detail}.` : ''}`
    if (!window.confirm(question)) return
    setCalling(row.id)
    try {
      const call = row.mode === 'faltosos' ? await api.missedCall(brainId, row.id) : row.mode === 'cartao' ? await api.cardCall(brainId, row.id) : await api.waitlistCall(brainId, row.id)
      onStarted(call); onNotice('Ligando...')
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Não foi possível iniciar a ligação.'; onFailed(row.patientName, message); fail(cause, message) }
    finally { setCalling(null) }
  }

  async function runTest() {
    setTesting(true)
    try {
      const body = mode === 'faltosos'
        ? { kind: 'missed' as const, situation: test.situation, phone: test.phone, patientName: test.patientName, professional: test.professional, specialty: test.specialty, date: test.date, time: test.time }
        : { kind: 'waitlist' as const, phone: test.phone, patientName: test.patientName, specialty: test.specialty, professional: test.professional || undefined }
      onStarted(await api.confirmTest(brainId, body))
      onNotice('Ligando para o teste... nada será gravado na AMEI.')
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Não foi possível iniciar o teste.'; onFailed(test.patientName, message); fail(cause, message) }
    finally { setTesting(false) }
  }
  const setTestField = (key: keyof typeof test) => (e: { target: { value: string } }) => setTest((old) => ({ ...old, [key]: e.target.value }))
  const testReady = test.phone.replace(/\D/g, '').length >= 10 && test.patientName.trim() && test.specialty.trim() && (mode === 'lista_espera' || (test.professional.trim() && test.date && test.time))

  const running = job?.status === 'running'

  return <div className="page-panel">
    <div className="page-intro"><span className="eyebrow">CAPTAÇÃO</span><h2>Preencher agenda</h2><p>Busca estrita na AMEI: só traz quem realmente precisa de uma nova consulta — faltosos que nunca remarcaram, ou quem está na lista de espera sem nenhuma consulta futura marcada.</p></div>

    <section className="confirm-test">
      <button className="ghost-button" onClick={() => setTestOpen(!testOpen)}>{testOpen ? 'Fechar ligação de teste' : 'Ligação de teste (fictícia)'}</button>
      {testOpen && <>
        <p className="muted">Liga para o telefone que você informar com os dados abaixo, com o roteiro de <b>{mode === 'faltosos' ? 'faltosos' : 'lista de espera'}</b> (conforme o filtro "O que puxar" acima), pra ouvir como a Giovana fala. É tudo fictício: <b>nada é lido nem gravado na AMEI</b>. Use o seu próprio número.</p>
        <div className="confirm-filters">
          <label>Seu telefone (quem vai atender)<input inputMode="tel" placeholder="(17) 99654-3210" value={test.phone} onChange={setTestField('phone')}/></label>
          <label>Nome do paciente<input value={test.patientName} onChange={setTestField('patientName')}/></label>
          <label>Especialidade<input value={test.specialty} onChange={setTestField('specialty')}/></label>
          {mode === 'faltosos' && <label>Nome do doutor(a)<input value={test.professional} onChange={setTestField('professional')}/></label>}
          {mode === 'lista_espera' && <label>Profissional preferido (opcional)<input value={test.professional} onChange={setTestField('professional')}/></label>}
          {mode === 'faltosos' && <label>Situação da consulta<select value={test.situation} onChange={setTestField('situation')}><option value="faltou">Não compareceu</option><option value="desmarcou">Desmarcado pelo paciente</option><option value="cancelada">Cancelada</option></select></label>}
          {mode === 'faltosos' && <label>Dia<input type="date" value={test.date} onChange={setTestField('date')}/></label>}
          {mode === 'faltosos' && <label>Hora<input type="time" value={test.time} onChange={setTestField('time')}/></label>}
          <button className="primary-button" disabled={!canCall || testing || !testReady} onClick={() => void runTest()}><Phone size={15}/> {testing ? 'Ligando...' : 'Ligar para testar'}</button>
        </div>
      </>}
    </section>

    <section className="confirm-filters">
      <label>Área de atuação *<select value={specialtyId} onChange={(e) => setSpecialtyId(e.target.value)}><option value="">Escolha</option>{options?.specialties.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Profissional<select value={professionalId} disabled={!specialtyId} onChange={(e) => setProfessionalId(e.target.value)}><option value="">{specialtyId ? 'Todos' : 'Escolha a área'}</option>{professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>O que puxar *<select value={mode} onChange={(e) => setMode(e.target.value as CampaignMode)}><option value="faltosos">Faltosos sem reagendamento</option><option value="lista_espera">Lista de espera sem consulta futura</option><option value="cartao">Atendidos pelo particular sem Cartão de TODOS</option></select></label>
      <label>{mode === 'faltosos' ? 'Faltou de *' : mode === 'cartao' ? 'Atendido de *' : 'Entrou na lista de *'}<input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); if (e.target.value > dateTo) setDateTo(e.target.value) }}/></label>
      <label>Até *<input type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)}/></label>
      <div className="preset-row">{([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7dias', 'Últimos 7 dias'], ['semana', 'Semana passada'], ['mes', 'Este mês']] as const).map(([kind, label]) => <button key={kind} type="button" className="ghost-button" onClick={() => { const r = presetRange(kind); setDateFrom(r.from); setDateTo(r.to) }}>{label}</button>)}</div>
      {mode === 'faltosos' && <label>Situação<select value={situations} onChange={(e) => setSituations(e.target.value as typeof situations)}><option value="faltou_desmarcou">Faltou ou desmarcou (paciente)</option><option value="faltou">Só quem faltou</option><option value="desmarcou">Só desmarcado pelo paciente</option></select></label>}
      {mode !== 'cartao' && <label>Cartão de TODOS<select value={cardFilter} onChange={(e) => setCardFilter(e.target.value as typeof cardFilter)}><option value="todos">Todos</option><option value="sem_cartao">Só quem NÃO tem o cartão</option></select></label>}
      <p className="muted confirm-hint">{mode === 'faltosos' ? 'Consultas perdidas (não compareceu, desmarcou ou cancelou) nesses dias, cujo paciente nunca conseguiu remarcar depois.' : 'Pacientes com entrada "pendente" na lista de espera dessa especialidade, criada nesses dias, sem nenhuma consulta futura marcada para ela.'} Se não der pra confirmar com certeza, o paciente fica de fora — a busca é rígida de propósito.</p>
      <button className="primary-button" disabled={searching || running || !specialtyId} onClick={() => void search()}><Search size={15}/> {running ? 'Buscando...' : searching ? 'Iniciando...' : 'Buscar'}</button>
    </section>

    {job && (job.results.length > 0 || auto?.active) && <section className="confirm-summary auto-confirm">
      <button className={auto?.active ? 'monitor-button monitor-button-active' : 'monitor-button'} disabled={autoBusy || running || (!auto?.active && !canCall)} onClick={() => void toggleAuto()}>
        {auto?.active ? <StopCircle size={15}/> : <PlayCircle size={15}/>} {auto?.active ? 'Parar esteira' : 'Ligar automaticamente (esteira)'}
      </button>
      {auto?.active && <span className="tag tag-ok">Ligando sozinha{auto.current ? '...' : ''} · {auto.calledCount} ligada{auto.calledCount === 1 ? '' : 's'}{auto.remaining ? ` · ${auto.remaining} na fila` : ''}</span>}
      {auto?.lastError && <small className="muted">Último aviso: {auto.lastError}</small>}
      {!auto?.active && <small className="muted">Liga um paciente atrás do outro, na ordem da lista de baixo, até acabar. Para escolher por onde começar, use as setas ↓ (daquele pra baixo) e ↑ (daquele pra cima) na linha do paciente.</small>}
    </section>}

    {job && <div className="confirm-summary">
      <span className="tag">{job.found} encontrado{job.found === 1 ? '' : 's'}</span>
      {running && <span className="tag">{job.total ? `Conferindo ${job.checked} de ${job.total}...` : 'Buscando...'}</span>}
      {job.status === 'error' && <span className="tag tag-block">Erro: {job.error}</span>}
      {job.truncated && <small className="muted">Mostrando só os 300 mais relevantes — reduza o período pra ver tudo.</small>}
    </div>}

    <div className="table-wrap"><table><thead><tr><th>Paciente</th><th>Contato</th><th>Especialidade</th><th>Profissional</th><th>{mode === 'faltosos' ? 'Faltou em' : mode === 'cartao' ? 'Atendido em' : 'Na lista desde'}</th><th>Cartão de TODOS</th><th>Disponibilidade</th><th/></tr></thead><tbody>
      {!job && <tr><td colSpan={8} className="table-empty">Escolha os filtros e clique em Buscar.</td></tr>}
      {job && job.results.length === 0 && <tr><td colSpan={8} className="table-empty">{running ? 'Conferindo na AMEI...' : 'Nenhum paciente encontrado nesse período e filtro.'}</td></tr>}
      {job?.results.map((r) => <tr key={r.id}>
        <td><strong>{r.patientName}</strong></td>
        <td>{formatPhone(r.phone)}</td>
        <td>{r.specialty}</td>
        <td>{r.professional || '—'}</td>
        <td>{dmy(r.originDate)}{r.situation && <small className="row-note">{r.situation === 'faltou' ? 'Não compareceu' : r.situation === 'desmarcou' ? 'Desmarcado' : 'Cancelada'}</small>}</td>
        <td>{r.cardStatus ? <span className={CARD_TAGS[r.cardStatus].className}>{CARD_TAGS[r.cardStatus].label}</span> : '—'}</td>
        <td>{r.mode === 'cartao' ? <span className="tag">Pagou R$ {r.value ?? '—'} (particular)</span> : <span className={recoveryTagClass(r.recoveryStatus)}>{availabilityDetail(r) || 'Sem vaga no momento'}</span>}</td>
        <td className="row-actions"><button className="icon-call" title={r.mode === 'cartao' ? 'Ligar para apresentar o Cartão de TODOS' : 'Ligar para oferecer uma nova consulta'} disabled={!canCall || calling !== null || auto?.active === true || r.phone.length < 10} onClick={() => void call(r)}><Phone size={15}/></button>
          {!auto?.active && !running && <>
            <button className="icon-call" title="Ligar esteira a partir deste paciente, pra baixo na lista" disabled={autoBusy || !canCall || r.phone.length < 10} onClick={() => void toggleAuto({ id: r.id, direction: 'down' })}><ArrowDown size={15}/></button>
            <button className="icon-call" title="Ligar esteira a partir deste paciente, pra cima na lista" disabled={autoBusy || !canCall || r.phone.length < 10} onClick={() => void toggleAuto({ id: r.id, direction: 'up' })}><ArrowUp size={15}/></button>
          </>}
        </td>
      </tr>)}
    </tbody></table></div>
    {!canCall && <p className="muted">Para ligar, o cVortex e o ElevenLabs precisam estar disponíveis e nenhuma outra ligação pode estar em andamento.</p>}
  </div>
}
