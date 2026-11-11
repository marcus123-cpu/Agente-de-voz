import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, PlayCircle, Phone, StopCircle, Upload, X } from 'lucide-react'
import { api } from './api'
import { parseContacts, readContactsFile } from './parseContacts'
import type { AutoConfirmStatus, Call, Contact, ReactivationSummary, Result } from './types'

function formatPhone(value: string) {
  const d = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '')
  return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : value || '—'
}
const resultLabels: Record<Result, string> = { interested: 'Interessado', not_interested: 'Sem interesse', callback: 'Retornar depois', do_not_contact: 'Não deseja contato', unknown: 'Não identificado' }
type Tab = 'lista' | 'resumo'

function ResumoView({ summary }: { summary: ReactivationSummary | null }) {
  if (!summary) return <p className="muted">Carregando resumo...</p>
  const pctOf = (n: number, base: number) => base ? ` (${Math.round((n / base) * 100)}%)` : ''
  return <section className="card info-card">
    <div className="section-title"><h3>Funil da campanha de reativação</h3></div>
    <div className="summary-grid">
      <div><span>Total na base</span><strong>{summary.total}</strong></div>
      <div><span>Ainda não ligados</span><strong>{summary.notCalledYet}</strong></div>
      <div><span>Já ligados</span><strong>{summary.called}</strong></div>
      <div><span>Atenderam</span><strong>{summary.answered}{pctOf(summary.answered, summary.called)}</strong></div>
      <div><span>Não atendeu / ocupado / falhou</span><strong>{summary.noAnswer}</strong></div>
      <div><span>Caixa postal</span><strong>{summary.voicemail}</strong></div>
      <div><span>Foi pro Marcos (interesse)</span><strong>{summary.interested}</strong></div>
      <div><span>Sem interesse</span><strong>{summary.notInterested}</strong></div>
      <div><span>Atendeu mas não classificou</span><strong>{summary.unclassified}</strong></div>
    </div>
  </section>
}

export function ReactivationPanel({ brainId, canCall, visible, onNotice, onStarted, onFailed }: { brainId: string; canCall: boolean; visible: boolean; onNotice: (message: string) => void; onStarted: (call: Call) => void; onFailed: (patientName: string, message: string) => void }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [tab, setTab] = useState<Tab>('lista')
  const [importing, setImporting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [cardSince, setCardSince] = useState('')
  const [busy, setBusy] = useState(false)
  const [maxAttempts, setMaxAttempts] = useState('1')
  const [calling, setCalling] = useState<string | null>(null)
  const [auto, setAuto] = useState<AutoConfirmStatus | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)
  const [summary, setSummary] = useState<ReactivationSummary | null>(null)
  const lastAutoCallId = useRef<string | null>(null)
  const onStartedRef = useRef(onStarted)
  onStartedRef.current = onStarted
  const fail = useCallback((cause: unknown, fallback: string) => onNotice(cause instanceof Error ? cause.message : fallback), [onNotice])

  const load = useCallback(() => {
    api.contacts().then((all) => setContacts(all.filter((c) => c.source === 'cartao_de_todos'))).catch((cause) => { setContacts([]); fail(cause, 'Não foi possível carregar a lista.') })
  }, [fail])
  useEffect(() => { load() }, [load])

  // Atualiza a situação dos filiados (quem já foi ligado) sozinho enquanto a página está aberta,
  // sem precisar dar F5 — pega tanto as ligações manuais quanto as da esteira.
  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [visible, load])

  useEffect(() => {
    if (tab !== 'resumo') return
    let alive = true
    void api.reactivationSummary().then((value) => { if (alive) setSummary(value) }).catch((cause) => fail(cause, 'Não foi possível carregar o resumo.'))
    return () => { alive = false }
  }, [tab, fail])

  // Esteira: confere o status só enquanto essa página está visível (evita polling de fundo nas outras abas), e
  // quando ela inicia uma ligação sozinha, empurra pro painel (ouvir ao vivo e widget).
  useEffect(() => {
    if (!visible) return
    let alive = true
    const poll = () => {
      void api.reactivationAutoStatus().then((value) => {
        if (!alive) return
        setAuto((previous) => { if (previous?.active && !value.active) load(); return value })
        if (value.currentCallId && value.currentCallId !== lastAutoCallId.current) {
          lastAutoCallId.current = value.currentCallId
          void api.call(value.currentCallId).then((current) => { if (alive) onStartedRef.current(current) }).catch(() => undefined)
        }
      }).catch(() => undefined)
    }
    poll()
    const timer = window.setInterval(poll, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [load, visible])

  const preview = useMemo(() => parseContacts(pasted), [pasted])
  async function readFile(file: File | undefined) {
    if (!file) return
    if (file.size > 1_500_000) { onNotice('Arquivo muito grande (máx. 1,5 MB).'); return }
    try { setPasted(await readContactsFile(file)) } catch { onNotice('Não consegui ler esse arquivo. Confira se é um .csv, .txt, .xlsx ou .xls válido.'); return }
    // Relatório de filiação costuma vir como "relatorio-filiacao-...-01082021-31082021.xlsx": pega o ano do período.
    const period = /(\d{2})(\d{2})((?:19|20)\d{2})-(\d{2})(\d{2})((?:19|20)\d{2})/.exec(file.name)
    if (period) setCardSince(period[3])
  }
  async function runImport() {
    setBusy(true)
    try {
      const r = await api.importContacts(preview.slice(0, 5000), 'cartao_de_todos', cardSince.trim() || undefined)
      setImporting(false); setPasted(''); setCardSince(''); load()
      onNotice(`${r.imported} importados${r.duplicates ? ` · ${r.duplicates} já existiam` : ''}${r.invalidCount ? ` · ${r.invalidCount} ignorados (telefone inválido)` : ''}.`)
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Não foi possível importar.') } finally { setBusy(false) }
  }

  async function call(c: Contact) {
    if (!window.confirm(`Ligar agora para ${c.name} (${formatPhone(c.phone)})?`)) return
    setCalling(c.id)
    try { onStarted(await api.startCall(brainId, c.name, c.phone, 'reactivation_card_member')); onNotice('Ligando...') }
    catch (cause) { const message = cause instanceof Error ? cause.message : 'Não foi possível iniciar a ligação.'; onFailed(c.name, message); fail(cause, message) }
    finally { setCalling(null) }
  }

  async function toggleAuto(startFrom?: { contactId: string; direction: 'up' | 'down' }) {
    setAutoBusy(true)
    try {
      if (auto?.active) { setAuto(await api.stopReactivationAuto()); onNotice('Esteira desligada.') }
      else {
        const attempts = Math.min(5, Math.max(1, parseInt(maxAttempts, 10) || 1))
        setAuto(await api.startReactivationAuto({ brainId, maxAttempts: attempts, startFromContactId: startFrom?.contactId, startFromDirection: startFrom?.direction }))
        onNotice(startFrom ? `Esteira ligada a partir desse filiado, pra ${startFrom.direction === 'down' ? 'baixo' : 'cima'}.` : 'Esteira ligada: chamando um filiado atrás do outro.')
      }
    } catch (cause) { fail(cause, 'Não foi possível mudar a esteira.') }
    finally { setAutoBusy(false) }
  }

  const total = contacts?.length ?? 0
  return <div className="page-panel">
    <div className="page-intro contacts-intro">
      <div><span className="eyebrow">CARTÃO DE TODOS</span><h2>Reativação de filiados</h2><p>{contacts ? `${total} filiado${total === 1 ? '' : 's'} na base · ${contacts.filter((c) => c.callCount === 0).length} ainda não ligados` : 'Carregando...'}</p></div>
      <div className="contacts-actions"><button className="ghost-button" onClick={() => setImporting(true)}><Upload size={15}/> Importar lista</button></div>
    </div>

    <div className="filter-chips">
      <button className={tab === 'lista' ? 'chip selected' : 'chip'} onClick={() => setTab('lista')}>Lista</button>
      <button className={tab === 'resumo' ? 'chip selected' : 'chip'} onClick={() => setTab('resumo')}>Resumo</button>
    </div>

    {tab === 'resumo' && <ResumoView summary={summary}/>}

    {tab === 'lista' && <>
      {contacts && contacts.length > 0 && <section className="confirm-summary auto-confirm">
        <button className={auto?.active ? 'monitor-button monitor-button-active' : 'monitor-button'} disabled={autoBusy || (!auto?.active && !canCall)} onClick={() => void toggleAuto()}>
          {auto?.active ? <StopCircle size={15}/> : <PlayCircle size={15}/>} {auto?.active ? 'Parar esteira' : 'Ligar automaticamente (esteira)'}
        </button>
        {!auto?.active && <label className="flex items-center gap-2 text-sm">Tentativas por paciente (até atender)<input type="number" min={1} max={5} style={{ width: '4rem' }} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)}/></label>}
        {auto?.active && <span className="tag tag-ok">Ligando sozinha{auto.current ? '...' : ''} · {auto.calledCount} ligado{auto.calledCount === 1 ? '' : 's'}{auto.remaining ? ` · ${auto.remaining} na fila` : ''}</span>}
        {auto?.lastError && <small className="muted">Último aviso: {auto.lastError}</small>}
        {!auto?.active && <small className="muted">Liga um filiado atrás do outro, na ordem da lista de cima pra baixo, até acabar. Se ele não atender, repete pro mesmo número até o limite de tentativas antes de ir pro próximo. Para escolher por onde começar, use as setas ↓ (daquele pra baixo) e ↑ (daquele pra cima) na linha do filiado.</small>}
      </section>}

      <div className="table-wrap"><table><thead><tr><th>Filiado</th><th>Telefone</th><th>Situação</th><th/></tr></thead><tbody>
        {contacts === null && <tr><td colSpan={4} className="table-empty">Carregando...</td></tr>}
        {contacts !== null && contacts.length === 0 && <tr><td colSpan={4} className="table-empty">Nenhum filiado importado ainda. Clique em "Importar lista".</td></tr>}
        {contacts?.map((c) => <tr key={c.id} className={c.doNotContact ? 'blocked-row' : ''}>
          <td><strong>{c.name}</strong></td>
          <td>{formatPhone(c.phone)}</td>
          <td>{c.doNotContact ? <span className="tag tag-block">Não contatar</span>
            : c.callCount > 0 ? <span className="tag tag-ok">Já ligado{c.callCount > 1 ? ` (${c.callCount}x)` : ''}{c.lastResult && c.lastResult !== 'unknown' ? ` · ${resultLabels[c.lastResult]}` : ''}</span>
            : <span className="tag">Ainda não ligado</span>}</td>
          <td className="row-actions">
            <button className="icon-call" title="Ligar agora" disabled={!canCall || c.doNotContact || calling !== null || auto?.active === true} onClick={() => void call(c)}><Phone size={15}/></button>
            {!auto?.active && <>
              <button className="icon-call" title="Ligar esteira a partir deste filiado, pra baixo na lista" disabled={autoBusy || !canCall || c.doNotContact} onClick={() => void toggleAuto({ contactId: c.id, direction: 'down' })}><ArrowDown size={15}/></button>
              <button className="icon-call" title="Ligar esteira a partir deste filiado, pra cima na lista" disabled={autoBusy || !canCall || c.doNotContact} onClick={() => void toggleAuto({ contactId: c.id, direction: 'up' })}><ArrowUp size={15}/></button>
            </>}
          </td>
        </tr>)}
      </tbody></table></div>
      {!canCall && <p className="muted">Para ligar, o cVortex e o ElevenLabs precisam estar disponíveis e nenhuma outra ligação pode estar em andamento.</p>}
    </>}

    {importing && <div className="modal-backdrop" onClick={() => setImporting(false)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <button className="modal-close" onClick={() => setImporting(false)}><X size={20}/></button>
      <span className="eyebrow">IMPORTAÇÃO</span><h2>Importar lista do Cartão de TODOS</h2>
      <p className="muted">Envie o arquivo direto do Excel (.xlsx/.xls) ou um .csv. A planilha precisa ter nome e telefone (com DDD), em qualquer ordem de colunas; a primeira linha pode ser o cabeçalho. Linhas sem telefone ficam de fora sozinhas.</p>
      <label>Arquivo CSV ou Excel<input type="file" accept=".csv,.txt,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(e) => void readFile(e.target.files?.[0])}/></label>
      <label>…ou cole aqui (nome e telefone, um por linha)<textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'ADECIO LIBERATO DE SOUZA;17997217556\nELAINE DE FATIMA BATISTA;17996548120'}/></label>
      {pasted && <p className="muted">{preview.length} linha{preview.length === 1 ? '' : 's'} encontrada{preview.length === 1 ? '' : 's'}{preview[0] ? ` · ex.: ${preview[0].name || 'Sem nome'} — ${preview[0].phone}` : ''}{preview.length > 5000 ? ' · só as primeiras 5000 serão importadas' : ''}</p>}
      <label>Filiados desde (ano, opcional)<input inputMode="numeric" maxLength={4} placeholder="2021" value={cardSince} onChange={(e) => setCardSince(e.target.value.replace(/\D/g, ''))}/></label>
      <button className="call-button" disabled={busy || !preview.length || (cardSince !== '' && !/^(19|20)\d{2}$/.test(cardSince))} onClick={() => void runImport()}>{busy ? 'Importando...' : `Importar ${preview.length || ''} filiados`}</button>
    </div></div>}
  </div>
}
