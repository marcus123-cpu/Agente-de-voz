import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Phone, Search } from 'lucide-react'
import { api } from './api'
import type { Call, ConfirmOptions, ConfirmRow } from './types'

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

export function ConfirmPanel({ brainId, canCall, onNotice, onStarted, onFailed, outcomeKey }: { brainId: string; canCall: boolean; onNotice: (message: string) => void; onStarted: (call: Call) => void; onFailed: (patientName: string, message: string) => void; outcomeKey: string }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [professionals, setProfessionals] = useState<{ id: string; name: string }[]>([])
  const [dateInit, setDateInit] = useState(todayBr())
  const [dateFinish, setDateFinish] = useState(todayBr())
  const [statusId, setStatusId] = useState(2)
  const [specialtyId, setSpecialtyId] = useState('')
  const [professionalId, setProfessionalId] = useState('')
  const [patient, setPatient] = useState('')
  const [procedure, setProcedure] = useState('')
  const [rows, setRows] = useState<ConfirmRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [calling, setCalling] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(10)
  const [testOpen, setTestOpen] = useState(false)
  const [test, setTest] = useState({ kind: 'confirm' as 'confirm' | 'missed', situation: 'faltou', phone: '', patientName: 'Maria da Silva Souza', professional: 'Dra. Ana Souza Exemplo', specialty: 'Psiquiatria', date: todayBr(), time: '08:00', valor: '102' })
  const [testing, setTesting] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const lastSearch = useRef<{ dateInit: string; dateFinish: string; statusId: number; specialtyId?: string; professionalId?: string } | null>(null)
  const fail = useCallback((cause: unknown, fallback: string) => onNotice(cause instanceof Error ? cause.message : fallback), [onNotice])

  useEffect(() => { void api.confirmOptions().then(setOptions).catch((c) => fail(c, 'Não foi possível carregar os filtros da AMEI.')) }, [fail])
  useEffect(() => {
    setProfessionalId('')
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
      if (!silent) setPage(0)
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

  const procedures = useMemo(() => [...new Set((rows ?? []).map((r) => r.procedure).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [rows])
  const visible = useMemo(() => (rows ?? []).filter((r) => (!patient.trim() || norm(`${r.patientName} ${r.patientSocial}`).includes(norm(patient.trim()))) && (!procedure || r.procedure === procedure)), [rows, patient, procedure])
  const pages = Math.max(1, Math.ceil(visible.length / size))
  const shown = visible.slice(page * size, page * size + size)
  const confirmed = (rows ?? []).filter((r) => r.statusId === 16).length

  async function call(row: ConfirmRow) {
    const when = `${dmy(row.date)} às ${row.time}`
    const missed = MISSED_STATUS.has(row.statusId)
    const question = missed
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
      {statusId === -1 && <p className="muted confirm-hint">Faltosos: junta <b>não compareceu</b>, <b>desmarcado pelo paciente</b> e <b>cancelado</b>, só de consultas que já passaram. Clique no telefone para a Giovana ligar, entender o que houve e oferecer nova consulta ou lista de espera.</p>}
      <button className="primary-button" disabled={loading || !dateInit || !dateFinish} onClick={() => void search()}><Search size={15}/> {loading ? 'Pesquisando...' : 'Pesquisar'}</button>
    </section>

    {rows !== null && <div className="confirm-summary"><span className="tag">{rows.length} agendamento{rows.length === 1 ? '' : 's'}</span>{statusId === 2 && <span className="tag tag-ok">{confirmed} confirmados</span>}{updatedAt && <small className="muted">Atualizado às {updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} (renova sozinho a cada 20 s)</small>}</div>}

    <div className="table-wrap"><table><thead><tr><th>Data</th><th>Paciente</th><th>Idade</th><th>Profissional</th><th>Contato</th><th>Confirmação</th><th>Observação</th><th/></tr></thead><tbody>
      {rows === null && <tr><td colSpan={8} className="table-empty">{loading ? 'Pesquisando na AMEI...' : 'Escolha o período e clique em Pesquisar.'}</td></tr>}
      {rows !== null && shown.length === 0 && <tr><td colSpan={8} className="table-empty">Nenhum agendamento neste período e filtro.</td></tr>}
      {shown.map((r) => <tr key={r.appointmentId}>
        <td>{dmy(r.date)}<small className="row-note">{r.time}</small></td>
        <td><strong>{r.patientName}</strong>{r.patientSocial && r.patientSocial !== r.patientName && <small className="row-note">{r.patientSocial}</small>}</td>
        <td>{r.age === null ? '—' : `${r.age} anos`}</td>
        <td>{r.professional}<small className="row-note">{r.specialty}{r.procedure ? ` · ${r.procedure}` : ''}{r.value ? ` · R$ ${r.value}` : ''}</small></td>
        <td>{formatPhone(r.phone)}</td>
        <td><span className={statusClass(r.statusId)}>{r.status}</span>{r.channel && <small className="row-note">via {r.channel}</small>}</td>
        <td>{r.note || '—'}</td>
        <td className="row-actions"><button className="icon-call" title={r.statusId === 2 ? 'Ligar para confirmar' : MISSED_STATUS.has(r.statusId) ? 'Ligar para recuperar a consulta (nova consulta ou lista de espera)' : 'Só consultas Agendadas ou perdidas podem ser ligadas'} disabled={!canCall || calling !== null || (r.statusId !== 2 && !MISSED_STATUS.has(r.statusId)) || r.phone.length < 10} onClick={() => void call(r)}><Phone size={15}/></button></td>
      </tr>)}
    </tbody></table></div>

    {rows !== null && <div className="confirm-pager"><label>Itens por página<select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0) }}>{sizes.map((n) => <option key={n}>{n}</option>)}</select></label><span>{visible.length ? `${page * size + 1}–${Math.min(visible.length, page * size + size)} de ${visible.length}` : '0'}</span><button className="ghost-button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button><button className="ghost-button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Próxima</button></div>}
    {!canCall && <p className="muted">Para ligar, o cVortex e o ElevenLabs precisam estar disponíveis e nenhuma outra ligação pode estar em andamento.</p>}
  </div>
}
