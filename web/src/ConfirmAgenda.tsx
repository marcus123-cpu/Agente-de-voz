import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, PlayCircle, Phone, RefreshCw, Search, StopCircle } from 'lucide-react'
import { api } from './api'
import type { AutoConfirmStatus, Call, ConfirmOptions, ConfirmRow, RecoveryInfo } from './types'

function todayBr() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) }
function dmy(iso: string) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
function formatPhone(value: string) {
  const d = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '')
  return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : value || '—'
}
const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const statusClass = (id: number) => id === 16 ? 'tag tag-ok' : id === 9 || id === 8 || id === 3 || id === 17 ? 'tag tag-block' : 'tag'
const sizes = [10, 25, 50]
const MISSED_STATUS = new Set([3, 9, 17])   // cancelado, desmarcado pelo paciente, não compareceu
const RESOLVED_RECOVERY = new Set(['reagendado', 'recuperado', 'outra_especialidade'])
const recoveryTagClass = (status: RecoveryInfo['status']) => RESOLVED_RECOVERY.has(status) ? 'tag tag-ok' : status === 'conferir' ? 'tag' : 'tag tag-block'
/** Linha pequena embaixo do rótulo: quando reagendou, ou quantas vagas tem (ou só lista de espera). */
function recoveryDetail(info: RecoveryInfo): string {
  if (RESOLVED_RECOVERY.has(info.status) && info.next) return `${dmy(info.next.date)} às ${info.next.time} (${info.next.specialty})`
  const a = info.availability
  if (!a) return ''
  if (!a.count) return 'Sem vaga livre agora — só lista de espera'
  const first = a.next[0]
  const where = a.professionalOnly ? 'com o mesmo profissional' : 'na especialidade (outro profissional)'
  return `${a.count} vaga${a.count === 1 ? '' : 's'} livre${a.count === 1 ? '' : 's'} ${where}${first ? `, próxima ${dmy(first.date)} às ${first.time}` : ''}`
}

type Saved = { dateInit: string; dateFinish: string; statusId: number; specialtyId: string; professionalId: string; patient: string; procedure: string; rows: ConfirmRow[] | null; updatedAt: Date | null; last: { dateInit: string; dateFinish: string; statusId: number; specialtyId?: string; professionalId?: string } | null }
/** Guarda filtros e resultado ao sair da aba, para voltar do jeito que estava. */
let saved: Saved | null = null

export function ConfirmPanel({ brainId, canCall, onNotice, onStarted, onFailed, outcomeKey }: { brainId: string; canCall: boolean; onNotice: (message: string) => void; onStarted: (call: Call) => void; onFailed: (patientName: string, message: string) => void; outcomeKey: string }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [professionals, setProfessionals] = useState<{ id: string; name: string }[]>([])
  const [dateInit, setDateInit] = useState(saved?.dateInit ?? todayBr())
  const [dateFinish, setDateFinish] = useState(saved?.dateFinish ?? todayBr())
  const [statusId, setStatusId] = useState(saved?.statusId ?? 2)
  const [specialtyId, setSpecialtyId] = useState(saved?.specialtyId ?? '')
  const [professionalId, setProfessionalId] = useState(saved?.professionalId ?? '')
  const [patient, setPatient] = useState(saved?.patient ?? '')
  const [procedure, setProcedure] = useState(saved?.procedure ?? '')
  const [rows, setRows] = useState<ConfirmRow[] | null>(saved?.rows ?? null)
  const [loading, setLoading] = useState(false)
  const [calling, setCalling] = useState<string | null>(null)
  const [auto, setAuto] = useState<AutoConfirmStatus | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(10)
  const [testOpen, setTestOpen] = useState(false)
  const [test, setTest] = useState({ kind: 'confirm' as 'confirm' | 'missed', situation: 'faltou', phone: '', patientName: 'Maria da Silva Souza', professional: 'Dra. Ana Souza Exemplo', specialty: 'Psiquiatria', date: todayBr(), time: '08:00', valor: '102' })
  const [testing, setTesting] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(saved?.updatedAt ?? null)
  const [recovery, setRecovery] = useState<Record<string, RecoveryInfo | 'loading'>>({})
  const lastSearch = useRef<Saved['last']>(saved?.last ?? null)
  const firstSpecialty = useRef(true)
  const lastAutoCallId = useRef<string | null>(null)
  const onStartedRef = useRef(onStarted)
  onStartedRef.current = onStarted
  useEffect(() => { saved = { dateInit, dateFinish, statusId, specialtyId, professionalId, patient, procedure, rows, updatedAt, last: lastSearch.current } })
  const fail = useCallback((cause: unknown, fallback: string) => onNotice(cause instanceof Error ? cause.message : fallback), [onNotice])

  useEffect(() => { void api.confirmOptions().then(setOptions).catch((c) => fail(c, 'Não foi possível carregar os filtros da AMEI.')) }, [fail])
  useEffect(() => {
    if (firstSpecialty.current) firstSpecialty.current = false; else setProfessionalId('')
    if (!specialtyId) { setProfessionals([]); return }
    void api.confirmProfessionals(specialtyId).then(setProfessionals).catch(() => setProfessionals([]))
  }, [specialtyId])

  const search = useCallback(async (silent = false) => {
    const filters = silent && lastSearch.current ? lastSearch.current : { dateInit, dateFinish, statusId, specialtyId: specialtyId || undefined, professionalId: professionalId || undefined }
    if (!silent) setLoading(true)
    try {
      const result = await api.confirmList(filters)
      lastSearch.current = filters
      setRows(result.rows); setUpdatedAt(new Date())
      if (!silent) { setPage(0); setRecovery({}) }
    } catch (cause) { if (!silent) { setRows(null); fail(cause, 'Não foi possível pesquisar na AMEI.') } }
    finally { if (!silent) setLoading(false) }
  }, [dateInit, dateFinish, statusId, specialtyId, professionalId, fail])

  // Tempo real: depois da primeira pesquisa, relê a AMEI a cada 20 s (mostra confirmações feitas pela Giovana ou pela equipe).
  useEffect(() => {
    if (rows === null) return
    const timer = window.setInterval(() => { if (!document.hidden) void search(true) }, 20000)
    return () => window.clearInterval(timer)
  }, [rows === null, search]) // eslint-disable-line react-hooks/exhaustive-deps

  // Quando a Giovana confirma ou desmarca, a lista já mostra o novo status na AMEI.
  useEffect(() => { if (rows !== null && !outcomeKey.endsWith(':')) void search(true) }, [outcomeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Esteira: confere o status sempre (mesmo que o operador tenha saído da aba), pra nunca perder de vista que está ligando sozinha.
  // Quando ela mesma inicia uma ligação, o painel não fica sabendo sozinho (quem chamou foi o servidor, não um clique
  // aqui): então, ao notar uma ligação nova, busca e empurra pro estado global (mesmo caminho de um clique manual),
  // pra "Ouvir ao vivo" e o widget de ligação aparecerem também para as ligações da esteira.
  useEffect(() => {
    let alive = true
    const poll = () => {
      void api.autoConfirmStatus().then((value) => {
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

  async function toggleAuto(startFrom?: { appointmentId: string; direction: 'up' | 'down' }) {
    setAutoBusy(true)
    try {
      if (auto?.active) { setAuto(await api.stopAutoConfirm()); onNotice('Esteira desligada.') }
      else {
        setAuto(await api.startAutoConfirm({ brainId, dateInit, dateFinish, specialtyId: specialtyId || undefined, professionalId: professionalId || undefined, startFromAppointmentId: startFrom?.appointmentId, startFromDirection: startFrom?.direction }))
        onNotice(startFrom ? `Esteira ligada a partir desse paciente, pra ${startFrom.direction === 'down' ? 'baixo' : 'cima'}.` : 'Esteira ligada: chamando um agendamento atrás do outro.')
      }
    } catch (cause) { fail(cause, 'Não foi possível mudar a esteira.') }
    finally { setAutoBusy(false) }
  }

  const procedures = useMemo(() => [...new Set((rows ?? []).map((r) => r.procedure).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [rows])
  const visible = useMemo(() => (rows ?? []).filter((r) => (!patient.trim() || norm(`${r.patientName} ${r.patientSocial}`).includes(norm(patient.trim()))) && (!procedure || r.procedure === procedure)), [rows, patient, procedure])
  const pages = Math.max(1, Math.ceil(visible.length / size))
  const shown = useMemo(() => visible.slice(page * size, page * size + size), [visible, page, size])
  const confirmed = (rows ?? []).filter((r) => r.statusId === 16).length

  // Faltosos: pra cada linha visível, confere na AMEI se o paciente já reagendou, sem travar a lista (poucos de cada vez).
  useEffect(() => {
    if (statusId !== -1) return
    const pending = shown.filter((r) => MISSED_STATUS.has(r.statusId) && !(r.appointmentId in recovery))
    if (!pending.length) return
    let alive = true
    const queue = [...pending]
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift()!
        setRecovery((old) => ({ ...old, [row.appointmentId]: 'loading' }))
        try { const info = await api.confirmRecovery(row.appointmentId); if (alive) setRecovery((old) => ({ ...old, [row.appointmentId]: info })) }
        catch { if (alive) setRecovery((old) => ({ ...old, [row.appointmentId]: { status: 'conferir', label: 'Conferir na AMEI' } })) }
      }
    }
    void Promise.all([worker(), worker(), worker()])
    return () => { alive = false }
  }, [shown, statusId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function call(row: ConfirmRow) {
    const when = `${dmy(row.date)} às ${row.time}`
    const missed = MISSED_STATUS.has(row.statusId)
    const info = recovery[row.appointmentId]
    const already = missed && info && info !== 'loading' && RESOLVED_RECOVERY.has(info.status) ? info : null
    const question = already
      ? `Atenção: ${row.patientName} já parece ter resolvido isso (${already.label.toLowerCase()}${already.next ? `, consulta em ${dmy(already.next.date)} às ${already.next.time}` : ''}). Ligar mesmo assim sobre a consulta perdida de ${when}?`
      : missed
      ? `Ligar agora para ${row.patientName} (${formatPhone(row.phone)}) sobre a consulta de ${row.specialty || 'consulta'} de ${when} (${row.status})? A Giovana vai entender o que houve e oferecer nova consulta ou lista de espera.`
      : `Ligar agora para ${row.patientName} (${formatPhone(row.phone)}) para confirmar a consulta de ${row.specialty || 'consulta'} em ${when}?`
    if (!window.confirm(question)) return
    setCalling(row.appointmentId)
    try { onStarted(missed ? await api.missedCall(brainId, row.appointmentId) : await api.confirmCall(brainId, row.appointmentId)); onNotice(missed ? 'Ligando para recuperar a consulta...' : 'Ligando para confirmar a consulta...') }
    catch (cause) { const message = cause instanceof Error ? cause.message : 'Não foi possível iniciar a ligação.'; onFailed(row.patientName, message); fail(cause, message) }
    finally { setCalling(null) }
  }

  async function runTest() {
    setTesting(true)
    try { onStarted(await api.confirmTest(brainId, test)); onNotice('Ligando para o teste... nada será gravado na AMEI.') }
    catch (cause) { const message = cause instanceof Error ? cause.message : 'Não foi possível iniciar o teste.'; onFailed(test.patientName, message); fail(cause, message) }
    finally { setTesting(false) }
  }
  const setField = (key: keyof typeof test) => (e: { target: { value: string } }) => setTest((old) => ({ ...old, [key]: e.target.value }) as typeof old)
  const testReady = test.phone.replace(/\D/g, '').length >= 10 && test.patientName.trim() && test.professional.trim() && test.specialty.trim() && test.date && test.time

  return <div className="page-panel">
    <div className="page-intro"><span className="eyebrow">AGENDA AMEI</span><h2>Confirmar agendamentos</h2><p>Os dados vêm direto da AMEI, ao vivo. Clique no telefone de um paciente: a Giovana liga, confirma a consulta e atualiza a AMEI. Se o paciente quiser remarcar, ela chama o Marcos.</p></div>

    <section className="confirm-test">
      <button className="ghost-button" onClick={() => setTestOpen(!testOpen)}>{testOpen ? 'Fechar ligação de teste' : 'Ligação de teste (consulta fictícia)'}</button>
      {testOpen && <>
        <p className="muted">Liga para o telefone que você informar com os dados abaixo, para ouvir como a Giovana fala tudo. É uma consulta de mentira: <b>nada é lido nem gravado na AMEI</b> (na lista de espera também é só simulado). Use o seu próprio número.</p>
        <div className="confirm-filters">
          <label>Tipo de ligação<select value={test.kind} onChange={setField('kind')}><option value="confirm">Confirmação de consulta</option><option value="missed">Faltoso (recuperar consulta perdida)</option></select></label>
          {test.kind === 'missed' && <label>Situação da consulta<select value={test.situation} onChange={setField('situation')}><option value="faltou">Não compareceu</option><option value="desmarcou">Desmarcado pelo paciente</option><option value="cancelada">Cancelada</option></select></label>}
          <label>Seu telefone (quem vai atender)<input inputMode="tel" placeholder="(17) 99654-3210" value={test.phone} onChange={setField('phone')}/></label>
          <label>Nome do paciente<input value={test.patientName} onChange={setField('patientName')}/></label>
          <label>Nome do doutor(a)<input value={test.professional} onChange={setField('professional')}/></label>
          <label>Especialidade<input value={test.specialty} onChange={setField('specialty')}/></label>
          <label>Dia<input type="date" value={test.date} onChange={setField('date')}/></label>
          <label>Hora<input type="time" value={test.time} onChange={setField('time')}/></label>
          {test.kind === 'confirm' && <label>Valor (R$)<input inputMode="decimal" placeholder="102" value={test.valor} onChange={setField('valor')}/></label>}
          <button className="primary-button" disabled={!canCall || testing || !testReady} onClick={() => void runTest()}><Phone size={15}/> {testing ? 'Ligando...' : 'Ligar para testar'}</button>
        </div>
      </>}
    </section>

    <section className="confirm-filters">
      <label>Paciente<input placeholder="Buscar por nome" value={patient} onChange={(e) => { setPatient(e.target.value); setPage(0) }}/></label>
      <label>Data início *<input type="date" value={dateInit} onChange={(e) => { setDateInit(e.target.value); if (e.target.value > dateFinish) setDateFinish(e.target.value) }}/></label>
      <label>Data fim *<input type="date" value={dateFinish} min={dateInit} onChange={(e) => setDateFinish(e.target.value)}/></label>
      <label>Status *<select value={statusId} onChange={(e) => setStatusId(Number(e.target.value))}>{(options?.statuses ?? [{ id: 2, name: 'Agendado' }]).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Área de atuação<select value={specialtyId} onChange={(e) => setSpecialtyId(e.target.value)}><option value="">Todas</option>{options?.specialties.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Profissional<select value={professionalId} disabled={!specialtyId} onChange={(e) => setProfessionalId(e.target.value)}><option value="">{specialtyId ? 'Todos' : 'Escolha a área'}</option>{professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Procedimentos<select value={procedure} disabled={!procedures.length} onChange={(e) => { setProcedure(e.target.value); setPage(0) }}><option value="">Todos</option>{procedures.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
      {statusId === -1 && <p className="muted confirm-hint">Faltosos: junta <b>não compareceu</b>, <b>desmarcado pelo paciente</b> e <b>cancelado</b>, só de consultas que já passaram. A coluna Reagendou? confere na AMEI se o paciente já resolveu isso antes de ligar. Clique no telefone para a Giovana ligar, entender o que houve e oferecer nova consulta ou lista de espera.</p>}
      <button className="primary-button" disabled={loading || !dateInit || !dateFinish} onClick={() => void search()}><Search size={15}/> {loading ? 'Pesquisando...' : 'Pesquisar'}</button>
      {rows !== null && <button className="ghost-button" disabled={loading} onClick={() => void search()}><RefreshCw size={15}/> Atualizar</button>}
    </section>

    {(statusId === 2 || auto?.active) && <section className="confirm-summary auto-confirm">
      <button className={auto?.active ? 'monitor-button monitor-button-active' : 'monitor-button'} disabled={autoBusy || (!auto?.active && (!canCall || !dateInit || !dateFinish))} onClick={() => void toggleAuto()}>
        {auto?.active ? <StopCircle size={15}/> : <PlayCircle size={15}/>} {auto?.active ? 'Parar esteira' : 'Ligar automaticamente (esteira)'}
      </button>
      {auto?.active && <span className="tag tag-ok">Ligando sozinha{auto.current ? '...' : ''} · {auto.calledCount} ligada{auto.calledCount === 1 ? '' : 's'}{auto.remaining ? ` · ${auto.remaining} na fila` : ''}</span>}
      {auto?.lastError && <small className="muted">Último aviso: {auto.lastError}</small>}
      {!auto?.active && <small className="muted">Liga um agendamento atrás do outro sozinha, dentro do período e filtros de cima, até acabar a lista. Clique em Parar a qualquer momento pra voltar a escolher manualmente.</small>}
    </section>}

    {rows !== null && <div className="confirm-summary"><span className="tag">{rows.length} agendamento{rows.length === 1 ? '' : 's'}</span>{statusId === 2 && <span className="tag tag-ok">{confirmed} confirmados</span>}{updatedAt && <small className="muted">Atualizado às {updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} (renova sozinho a cada 20 s)</small>}</div>}

    <div className="table-wrap"><table><thead><tr><th>Data</th><th>Paciente</th><th>Idade</th><th>Profissional</th><th>Contato</th><th>Confirmação</th>{statusId === -1 && <th>Reagendou?</th>}<th>Observação</th><th/></tr></thead><tbody>
      {rows === null && <tr><td colSpan={statusId === -1 ? 9 : 8} className="table-empty">{loading ? 'Pesquisando na AMEI...' : 'Escolha o período e clique em Pesquisar.'}</td></tr>}
      {rows !== null && shown.length === 0 && <tr><td colSpan={statusId === -1 ? 9 : 8} className="table-empty">Nenhum agendamento neste período e filtro.</td></tr>}
      {shown.map((r) => { const info = recovery[r.appointmentId]; return <tr key={r.appointmentId}>
        <td>{dmy(r.date)}<small className="row-note">{r.time}</small></td>
        <td><strong>{r.patientName}</strong>{r.patientSocial && r.patientSocial !== r.patientName && <small className="row-note">{r.patientSocial}</small>}</td>
        <td>{r.age === null ? '—' : `${r.age} anos`}</td>
        <td>{r.professional}<small className="row-note">{r.specialty}{r.procedure ? ` · ${r.procedure}` : ''}{r.value ? ` · R$ ${r.value}` : ''}</small></td>
        <td>{formatPhone(r.phone)}</td>
        <td><span className={statusClass(r.statusId)}>{r.status}</span>{r.channel && <small className="row-note">via {r.channel}</small>}</td>
        {statusId === -1 && <td>{!MISSED_STATUS.has(r.statusId) ? '—' : info === 'loading' || info === undefined ? <small className="muted">Verificando...</small> : <><span className={recoveryTagClass(info.status)}>{info.label}</span>{recoveryDetail(info) && <small className="row-note">{recoveryDetail(info)}</small>}</>}</td>}
        <td>{r.note || '—'}</td>
        <td className="row-actions">
          <button className="icon-call" title={auto?.active ? 'A esteira está ligando sozinha; pare pra escolher manualmente' : r.statusId === 2 ? 'Ligar para confirmar' : MISSED_STATUS.has(r.statusId) ? 'Ligar para recuperar a consulta (nova consulta ou lista de espera)' : 'Só consultas Agendadas ou perdidas podem ser ligadas'} disabled={!canCall || calling !== null || Boolean(auto?.active) || (r.statusId !== 2 && !MISSED_STATUS.has(r.statusId)) || r.phone.length < 10} onClick={() => void call(r)}><Phone size={15}/></button>
          {statusId === 2 && !auto?.active && r.statusId === 2 && <>
            <button className="icon-call" title="Ligar esteira a partir deste paciente, pra baixo na lista" disabled={autoBusy || !canCall || !dateInit || !dateFinish} onClick={() => void toggleAuto({ appointmentId: r.appointmentId, direction: 'down' })}><ArrowDown size={15}/></button>
            <button className="icon-call" title="Ligar esteira a partir deste paciente, pra cima na lista" disabled={autoBusy || !canCall || !dateInit || !dateFinish} onClick={() => void toggleAuto({ appointmentId: r.appointmentId, direction: 'up' })}><ArrowUp size={15}/></button>
          </>}
        </td>
      </tr> })}
    </tbody></table></div>

    {rows !== null && <div className="confirm-pager"><label>Itens por página<select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0) }}>{sizes.map((n) => <option key={n}>{n}</option>)}</select></label><span>{visible.length ? `${page * size + 1}–${Math.min(visible.length, page * size + size)} de ${visible.length}` : '0'}</span><button className="ghost-button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button><button className="ghost-button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Próxima</button></div>}
    {!canCall && <p className="muted">Para ligar, o cVortex e o ElevenLabs precisam estar disponíveis e nenhuma outra ligação pode estar em andamento.</p>}
  </div>
}
