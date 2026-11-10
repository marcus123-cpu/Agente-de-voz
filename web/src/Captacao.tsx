import { useCallback, useEffect, useRef, useState } from 'react'
import { Phone, Search } from 'lucide-react'
import { api } from './api'
import type { Call, CampaignJobStatus, CampaignMode, CampaignRow, ConfirmOptions, RecoveryInfo } from './types'

function thisMonth() { return new Date().toISOString().slice(0, 7) }
function todayIso() { return new Date().toISOString().slice(0, 10) }
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
  const [monthFrom, setMonthFrom] = useState(thisMonth())
  const [monthTo, setMonthTo] = useState(thisMonth())
  const [job, setJob] = useState<CampaignJobStatus | null>(null)
  const [searching, setSearching] = useState(false)
  const [calling, setCalling] = useState<string | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [test, setTest] = useState({ phone: '', patientName: 'Maria da Silva Souza', professional: 'Dra. Ana Souza Exemplo', specialty: 'Psiquiatria', date: todayIso(), time: '08:00', situation: 'faltou' })
  const [testing, setTesting] = useState(false)
  const firstSpecialty = useRef(true)
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

  async function search() {
    if (!specialtyId) { onNotice('Escolha a especialidade.'); return }
    setSearching(true)
    try {
      const { jobId } = await api.startCampaignSearch({ mode, specialtyId, professionalId: professionalId || undefined, monthFrom, monthTo })
      setJob({ jobId, status: 'running', checked: 0, total: 0, found: 0, results: [], truncated: false })
    } catch (cause) { fail(cause, 'Não foi possível iniciar a busca na AMEI.') }
    finally { setSearching(false) }
  }

  async function call(row: CampaignRow) {
    const detail = availabilityDetail(row)
    const when = row.mode === 'faltosos' ? `faltou em ${dmy(row.originDate)}` : `na lista de espera desde ${dmy(row.originDate)}`
    const question = `Ligar agora para ${row.patientName} (${formatPhone(row.phone)}) — ${row.specialty}, ${when}?${detail ? ` ${detail}.` : ''}`
    if (!window.confirm(question)) return
    setCalling(row.id)
    try {
      const call = row.mode === 'faltosos' ? await api.missedCall(brainId, row.id) : await api.waitlistCall(brainId, row.id)
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
      <label>O que puxar *<select value={mode} onChange={(e) => setMode(e.target.value as CampaignMode)}><option value="faltosos">Faltosos sem reagendamento</option><option value="lista_espera">Lista de espera sem consulta futura</option></select></label>
      <label>De (mês) *<input type="month" value={monthFrom} onChange={(e) => { setMonthFrom(e.target.value); if (e.target.value > monthTo) setMonthTo(e.target.value) }}/></label>
      <label>Até (mês) *<input type="month" value={monthTo} min={monthFrom} onChange={(e) => setMonthTo(e.target.value)}/></label>
      <p className="muted confirm-hint">{mode === 'faltosos' ? 'Consultas perdidas (não compareceu, desmarcou ou cancelou) nesses meses, cujo paciente nunca conseguiu remarcar depois.' : 'Pacientes com entrada "pendente" na lista de espera dessa especialidade, criada nesses meses, sem nenhuma consulta futura marcada para ela.'} Se não der pra confirmar com certeza, o paciente fica de fora — a busca é rígida de propósito.</p>
      <button className="primary-button" disabled={searching || running || !specialtyId} onClick={() => void search()}><Search size={15}/> {running ? 'Buscando...' : searching ? 'Iniciando...' : 'Buscar'}</button>
    </section>

    {job && <div className="confirm-summary">
      <span className="tag">{job.found} encontrado{job.found === 1 ? '' : 's'}</span>
      {running && <span className="tag">{job.total ? `Conferindo ${job.checked} de ${job.total}...` : 'Buscando...'}</span>}
      {job.status === 'error' && <span className="tag tag-block">Erro: {job.error}</span>}
      {job.truncated && <small className="muted">Mostrando só os 300 mais relevantes — reduza o período pra ver tudo.</small>}
    </div>}

    <div className="table-wrap"><table><thead><tr><th>Paciente</th><th>Contato</th><th>Especialidade</th><th>Profissional</th><th>{mode === 'faltosos' ? 'Faltou em' : 'Na lista desde'}</th><th>Disponibilidade</th><th/></tr></thead><tbody>
      {!job && <tr><td colSpan={7} className="table-empty">Escolha os filtros e clique em Buscar.</td></tr>}
      {job && job.results.length === 0 && <tr><td colSpan={7} className="table-empty">{running ? 'Conferindo na AMEI...' : 'Nenhum paciente encontrado nesse período e filtro.'}</td></tr>}
      {job?.results.map((r) => <tr key={r.id}>
        <td><strong>{r.patientName}</strong></td>
        <td>{formatPhone(r.phone)}</td>
        <td>{r.specialty}</td>
        <td>{r.professional || '—'}</td>
        <td>{dmy(r.originDate)}{r.situation && <small className="row-note">{r.situation === 'faltou' ? 'Não compareceu' : r.situation === 'desmarcou' ? 'Desmarcado' : 'Cancelada'}</small>}</td>
        <td><span className={recoveryTagClass(r.recoveryStatus)}>{availabilityDetail(r) || 'Sem vaga no momento'}</span></td>
        <td className="row-actions"><button className="icon-call" title="Ligar para oferecer uma nova consulta" disabled={!canCall || calling !== null || r.phone.length < 10} onClick={() => void call(r)}><Phone size={15}/></button></td>
      </tr>)}
    </tbody></table></div>
    {!canCall && <p className="muted">Para ligar, o cVortex e o ElevenLabs precisam estar disponíveis e nenhuma outra ligação pode estar em andamento.</p>}
  </div>
}
