import { useEffect, useMemo, useState } from 'react'
import { Pencil, Phone, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import { api } from './api'
import { parseContacts, readContactsFile } from './parseContacts'
import type { Contact } from './types'

const resultLabels: Record<string, string> = { interested: 'Interessado', not_interested: 'Sem interesse', callback: 'Retornar depois', do_not_contact: 'Não deseja contato', unknown: 'Não identificado' }
const sourceLabels: Record<Contact['source'], string> = { manual: 'Manual', planilha: 'Planilha', cartao_de_todos: 'Cartão de Todos', ligacao: 'Ligação' }
type Filter = 'todos' | 'novos' | 'ligados' | 'retornar' | 'bloqueados'
const filters: { id: Filter; label: string }[] = [{ id: 'todos', label: 'Todos' }, { id: 'novos', label: 'Nunca ligados' }, { id: 'ligados', label: 'Já ligados' }, { id: 'retornar', label: 'Retornar' }, { id: 'bloqueados', label: 'Não contatar' }]

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '').slice(0, 11)
  if (digits.length <= 2) return digits ? `(${digits}` : ''
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
  return `(${digits.slice(0, 2)}) ${digits.slice(2, digits.length - 4)}-${digits.slice(-4)}`
}
function shortDate(value?: string | null) { return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(value)) : '—' }

export function ContactsPanel({ onNotice, onCall }: { onNotice: (message: string) => void; onCall: (name: string, phone: string, source: Contact['source']) => void }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('todos')
  const [editing, setEditing] = useState<Partial<Contact> | null>(null)
  const [importing, setImporting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [importAsCard, setImportAsCard] = useState(false)
  const [cardSince, setCardSince] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => api.contacts().then(setContacts).catch((cause) => { setContacts([]); onNotice(cause instanceof Error ? cause.message : 'Não foi possível carregar os contatos.') })
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase(); const digits = q.replace(/\D/g, '')
    return (contacts ?? []).filter((c) => {
      if (q && !(c.name.toLowerCase().includes(q) || (digits && c.phone.replace(/\D/g, '').includes(digits)))) return false
      if (filter === 'novos') return c.callCount === 0 && !c.doNotContact
      if (filter === 'ligados') return c.callCount > 0
      if (filter === 'retornar') return c.lastResult === 'callback'
      if (filter === 'bloqueados') return c.doNotContact
      return true
    })
  }, [contacts, query, filter])
  const preview = useMemo(() => parseContacts(pasted), [pasted])

  async function save() {
    if (!editing) return
    setBusy(true)
    try {
      if (editing.id) await api.updateContact(editing.id, { name: editing.name, phone: editing.phone, notes: editing.notes ?? null })
      else await api.createContact({ name: editing.name ?? '', phone: editing.phone ?? '', notes: editing.notes ?? null })
      setEditing(null); onNotice('Contato salvo.'); await load()
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Não foi possível salvar.') } finally { setBusy(false) }
  }
  async function toggleBlock(c: Contact) {
    try { await api.updateContact(c.id, { doNotContact: !c.doNotContact }); await load() } catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Falha ao atualizar.') }
  }
  async function remove(c: Contact) {
    if (!window.confirm(`Excluir ${c.name}? O histórico de ligações dele continua guardado.`)) return
    try { await api.deleteContact(c.id); await load() } catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Falha ao excluir.') }
  }
  async function readFile(file: File | undefined) {
    if (!file) return
    if (file.size > 1_500_000) { onNotice('Arquivo muito grande (máx. 1,5 MB).'); return }
    try { setPasted(await readContactsFile(file)) } catch { onNotice('Não consegui ler esse arquivo. Confira se é um .csv, .txt, .xlsx ou .xls válido.') }
    // Relatório de filiação do Cartão de TODOS vem como "relatorio-filiacao-...-01082021-31082021.csv":
    // já marca a origem e pega o ano do período, pra Giovana dizer "desde 2021".
    const period = /(\d{2})(\d{2})((?:19|20)\d{2})-(\d{2})(\d{2})((?:19|20)\d{2})/.exec(file.name)
    if (/filia/i.test(file.name) || period) setImportAsCard(true)
    if (period) setCardSince(period[3])
  }
  async function runImport() {
    setBusy(true)
    try {
      const r = await api.importContacts(preview.slice(0, 5000), importAsCard ? 'cartao_de_todos' : 'planilha', importAsCard ? cardSince.trim() : undefined)
      setImporting(false); setPasted(''); setImportAsCard(false); setCardSince(''); await load()
      onNotice(`${r.imported} importados${r.duplicates ? ` · ${r.duplicates} já existiam` : ''}${r.invalidCount ? ` · ${r.invalidCount} ignorados (telefone inválido)` : ''}.`)
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : 'Não foi possível importar.') } finally { setBusy(false) }
  }

  const total = contacts?.length ?? 0
  return <div className="page-panel">
    <div className="page-intro contacts-intro">
      <div><span className="eyebrow">BASE DE PACIENTES</span><h2>Contatos</h2><p>{contacts ? `${total} contato${total === 1 ? '' : 's'} · ${(contacts.filter((c) => c.callCount === 0 && !c.doNotContact)).length} nunca ligados` : 'Carregando...'}</p></div>
      <div className="contacts-actions">
        <button className="ghost-button" onClick={() => setImporting(true)}><Upload size={15}/> Importar planilha</button>
        <button className="primary-button" onClick={() => setEditing({ name: '', phone: '', notes: '' })}><Plus size={15}/> Novo contato</button>
      </div>
    </div>
    <div className="contacts-toolbar">
      <label className="search-box"><Search size={15}/><input placeholder="Buscar por nome ou telefone" value={query} onChange={(e) => setQuery(e.target.value)}/></label>
      <div className="filter-chips">{filters.map((f) => <button key={f.id} className={filter === f.id ? 'chip selected' : 'chip'} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
    </div>
    <div className="table-wrap"><table><thead><tr><th>Nome</th><th>Telefone</th><th>Origem</th><th>Ligações</th><th>Última</th><th>Resultado</th><th/></tr></thead><tbody>
      {contacts === null && <tr><td colSpan={7} className="table-empty">Carregando...</td></tr>}
      {contacts !== null && visible.length === 0 && <tr><td colSpan={7} className="table-empty">{total ? 'Nenhum contato com esse filtro.' : 'Nenhum contato ainda. Importe uma planilha ou cadastre o primeiro.'}</td></tr>}
      {visible.map((c) => <tr key={c.id} className={c.doNotContact ? 'blocked-row' : ''} onClick={() => setEditing(c)}>
        <td><strong>{c.name}</strong>{c.notes && <small className="row-note">{c.notes}</small>}</td>
        <td>{formatPhone(c.phone)}</td><td>{sourceLabels[c.source]}</td><td>{c.callCount}</td><td>{shortDate(c.lastCallAt)}</td>
        <td>{c.doNotContact ? <span className="tag tag-block">Não contatar</span> : c.lastResult ? resultLabels[c.lastResult] : '—'}</td>
        <td className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button title="Ligar agora" disabled={c.doNotContact} onClick={() => onCall(c.name, c.phone, c.source)}><Phone size={14}/></button>
          <button title={c.doNotContact ? 'Liberar contato' : 'Marcar como não contatar'} onClick={() => void toggleBlock(c)}>{c.doNotContact ? 'Liberar' : 'Bloquear'}</button>
          <button title="Editar" onClick={() => setEditing(c)}><Pencil size={14}/></button>
          <button title="Excluir" onClick={() => void remove(c)}><Trash2 size={14}/></button>
        </td></tr>)}
    </tbody></table></div>

    {editing && <div className="modal-backdrop" onClick={() => setEditing(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <button className="modal-close" onClick={() => setEditing(null)}><X size={20}/></button>
      <span className="eyebrow">CONTATO</span><h2>{editing.id ? 'Editar contato' : 'Novo contato'}</h2>
      <label>Nome<input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })}/></label>
      <label>Telefone<input inputMode="tel" placeholder="(17) 99654-3210" value={editing.phone ? formatPhone(editing.phone) : ''} onChange={(e) => setEditing({ ...editing, phone: formatPhone(e.target.value) })}/></label>
      <label>Observações<textarea rows={6} maxLength={4000} value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })}/></label>
      <button className="call-button" disabled={busy || !editing.name?.trim() || !editing.phone} onClick={() => void save()}>Salvar</button>
    </div></div>}

    {importing && <div className="modal-backdrop" onClick={() => setImporting(false)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <button className="modal-close" onClick={() => setImporting(false)}><X size={20}/></button>
      <span className="eyebrow">IMPORTAÇÃO</span><h2>Importar planilha</h2>
      <p className="muted">Envie o arquivo direto do Excel (.xlsx/.xls) ou um .csv. A planilha precisa ter nome e telefone (com DDD), em qualquer ordem de colunas; a primeira linha pode ser o cabeçalho. Telefones repetidos são ignorados.</p>
      <label>Arquivo CSV ou Excel<input type="file" accept=".csv,.txt,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(e) => void readFile(e.target.files?.[0])}/></label>
      <label>…ou cole aqui (nome e telefone, um por linha)<textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'Maria Silva;(17) 99654-3210\nJosé Santos;17 99712-0000'}/></label>
      {pasted && <p className="muted">{preview.length} linha{preview.length === 1 ? '' : 's'} encontrada{preview.length === 1 ? '' : 's'}{preview[0] ? ` · ex.: ${preview[0].name || 'Sem nome'} — ${preview[0].phone}` : ''}{preview.length > 5000 ? ' · só as primeiras 5000 serão importadas' : ''}</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={importAsCard} onChange={(e) => setImportAsCard(e.target.checked)}/> Esta lista é da base do Cartão de TODOS (reativação de filiados antigos)</label>
      {importAsCard && <label>Filiados desde (ano)<input inputMode="numeric" maxLength={4} placeholder="2021" value={cardSince} onChange={(e) => setCardSince(e.target.value.replace(/\D/g, ''))}/></label>}
      {importAsCard && <p className="muted">Linhas sem telefone ficam de fora sozinhas; a Giovana só cita o ano se ele estiver preenchido.</p>}
      <button className="call-button" disabled={busy || !preview.length || (importAsCard && cardSince !== '' && !/^(19|20)\d{2}$/.test(cardSince))} onClick={() => void runImport()}>{busy ? 'Importando...' : `Importar ${preview.length || ''} contatos`}</button>
    </div></div>}
  </div>
}
