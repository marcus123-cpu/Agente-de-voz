import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, MessageCircle, Pencil, Plus, Send, Trash2, X } from 'lucide-react'
import { api } from './api'
import type { AmeiStatus, MessageTemplate, WhatsappMessage, WhatsappStatus } from './types'

const statusText: Record<WhatsappMessage['status'], string> = { queued: 'Enviando...', sent: 'Enviada', failed: 'Falhou' }
function when(value: string) { return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) }
function mask(phone: string) { const d = phone.replace(/\D/g, '').replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : phone }

export function AutomationsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [wa, setWa] = useState<WhatsappStatus | null>(null)
  const [amei, setAmei] = useState<AmeiStatus | null>(null)
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null)
  const [messages, setMessages] = useState<WhatsappMessage[]>([])
  const [editing, setEditing] = useState<Partial<MessageTemplate> | null>(null)
  const [testing, setTesting] = useState<MessageTemplate | null>(null)
  const [testPhone, setTestPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const fail = useCallback((cause: unknown, fallback: string) => onNotice(cause instanceof Error ? cause.message : fallback), [onNotice])

  const loadTemplates = useCallback(() => api.templates().then(setTemplates).catch((c) => { setTemplates([]); fail(c, 'Não foi possível carregar os modelos.') }), [fail])
  const loadMessages = useCallback(() => api.whatsappMessages().then(setMessages).catch(() => undefined), [])
  useEffect(() => {
    void loadTemplates(); void loadMessages()
    const tick = () => { void api.whatsappStatus().then(setWa).catch(() => setWa({ browserOpen: false, loggedIn: false, qrVisible: false, busy: false })); void loadMessages(); void api.ameiStatus().then(setAmei).catch(() => setAmei({ browserOpen: false, loggedIn: false })) }
    tick(); const timer = window.setInterval(tick, 5000)
    return () => window.clearInterval(timer)
  }, [loadTemplates, loadMessages])

  async function save() {
    if (!editing) return
    setBusy(true)
    try {
      const values = { name: editing.name ?? '', whenToUse: editing.whenToUse ?? '', body: editing.body ?? '', isActive: editing.isActive !== false }
      if (editing.id) await api.updateTemplate(editing.id, values); else await api.createTemplate(values)
      setEditing(null); onNotice('Modelo salvo. Vale para as próximas ligações.'); await loadTemplates()
    } catch (cause) { fail(cause, 'Não foi possível salvar.') } finally { setBusy(false) }
  }
  async function toggle(t: MessageTemplate) { try { await api.updateTemplate(t.id, { isActive: !t.isActive }); await loadTemplates() } catch (cause) { fail(cause, 'Falha ao atualizar.') } }
  async function remove(t: MessageTemplate) {
    if (!window.confirm(`Excluir o modelo "${t.name}"?`)) return
    try { await api.deleteTemplate(t.id); await loadTemplates() } catch (cause) { fail(cause, 'Falha ao excluir.') }
  }
  async function runTest() {
    if (!testing) return
    setBusy(true)
    try { await api.testWhatsapp(testing.id, testPhone); setTesting(null); setTestPhone(''); onNotice('Teste na fila. Veja o resultado no registro abaixo.'); await loadMessages() }
    catch (cause) { fail(cause, 'Não foi possível enviar o teste.') } finally { setBusy(false) }
  }

  const state = wa === null ? 'Verificando...' : wa.loggedIn ? 'Conectado' : wa.qrVisible ? 'Aguardando leitura do QR code' : wa.browserOpen ? 'Aberto, mas sem login' : 'Desconectado'
  return <div className="page-panel">
    <div className="page-intro"><span className="eyebrow">AUTOMAÇÕES</span><h2>WhatsApp da Giovana</h2><p>Durante a ligação, a Giovana pode oferecer e enviar mensagens prontas por WhatsApp. Ela só usa os modelos abaixo; não escreve texto por conta própria.</p></div>

    <section className="wa-card">
      <div className={`wa-icon ${wa?.loggedIn ? 'on' : ''}`}><MessageCircle size={22}/></div>
      <div className="wa-main"><strong>WhatsApp Web da clínica</strong><span className={`wa-state ${wa?.loggedIn ? 'ok' : ''}`}><span className="status-dot"/>{state}</span>
        <small>{wa?.loggedIn ? 'Pronto para enviar. Mantenha a janela do WhatsApp aberta no PC.' : 'Clique em Abrir, leia o QR code com o celular do número da clínica (WhatsApp > Aparelhos conectados). Só precisa uma vez por PC.'}</small></div>
      <button className="ghost-button" onClick={() => void api.openWhatsapp().then(() => onNotice('Abrindo o WhatsApp Web no PC...')).catch((c) => fail(c, 'Não foi possível abrir.'))}>{wa?.browserOpen ? 'Trazer para frente' : 'Abrir WhatsApp Web'}</button>
    </section>

    <section className="wa-card">
      <div className={`wa-icon ${amei?.loggedIn ? 'on' : ''}`}><CalendarDays size={22}/></div>
      <div className="wa-main"><strong>Agenda AMEI</strong><span className={`wa-state ${amei?.loggedIn ? 'ok' : ''}`}><span className="status-dot"/>{amei === null ? 'Verificando...' : amei.loggedIn ? `Conectada${amei.user ? ` (${amei.user})` : ''}` : amei.browserOpen ? 'Sem login' : 'Navegador do cVortex fechado'}</span>
        <small>{amei?.loggedIn ? 'A Giovana consulta horários livres e a consulta marcada do paciente (somente leitura). Mantenha a aba da AMEI aberta no navegador do cVortex.' : 'Clique em Abrir e entre na AMEI na aba que abrir no navegador do cVortex. O login é feito por você; o sistema não vê sua senha.'}</small></div>
      <button className="ghost-button" onClick={() => void api.openAmei().then(() => onNotice('Abrindo a AMEI no navegador do cVortex...')).catch((c) => fail(c, 'Não foi possível abrir a AMEI.'))}>{amei?.loggedIn ? 'Trazer para frente' : 'Abrir AMEI'}</button>
    </section>

    <div className="contacts-intro section-gap"><div><h3 className="sub-title">Modelos de mensagem</h3><p className="muted">Use <b>{'{nome}'}</b> para inserir o primeiro nome do paciente. A Giovana decide qual enviar pelo campo "Quando usar".</p></div>
      <button className="primary-button" onClick={() => setEditing({ name: '', whenToUse: '', body: '', isActive: true })}><Plus size={15}/> Novo modelo</button></div>
    <div className="template-grid">
      {templates === null && <p className="muted">Carregando...</p>}
      {templates?.length === 0 && <p className="muted">Nenhum modelo ainda. Crie o primeiro.</p>}
      {templates?.map((t) => <article key={t.id} className={`template-card ${t.isActive ? '' : 'off'}`}>
        <header><strong>{t.name}</strong><label className="switch"><input type="checkbox" checked={t.isActive} onChange={() => void toggle(t)}/><span>{t.isActive ? 'Ativo' : 'Desligado'}</span></label></header>
        {t.whenToUse && <p className="when">Quando usar: {t.whenToUse}</p>}
        <pre>{t.body}</pre>
        <footer><button onClick={() => setTesting(t)}><Send size={13}/> Enviar teste</button><button onClick={() => setEditing(t)}><Pencil size={13}/> Editar</button><button onClick={() => void remove(t)}><Trash2 size={13}/></button></footer>
      </article>)}
    </div>

    <h3 className="sub-title section-gap">Mensagens enviadas</h3>
    <div className="table-wrap"><table><thead><tr><th>Quando</th><th>Paciente</th><th>Telefone</th><th>Modelo</th><th>Origem</th><th>Status</th></tr></thead><tbody>
      {messages.length === 0 && <tr><td colSpan={6} className="table-empty">Nenhuma mensagem enviada ainda.</td></tr>}
      {messages.map((m) => <tr key={m.id} title={m.error ?? m.body}><td>{when(m.createdAt)}</td><td>{m.patientName ?? '—'}</td><td>{mask(m.phone)}</td><td>{m.templateSlug ?? '—'}</td><td>{m.source === 'ia' ? 'Giovana' : 'Teste'}</td>
        <td><span className={`tag ${m.status === 'failed' ? 'tag-block' : m.status === 'sent' ? 'tag-ok' : ''}`}>{statusText[m.status]}</span>{m.error && <small className="row-note">{m.error}</small>}</td></tr>)}
    </tbody></table></div>

    {editing && <div className="modal-backdrop" onClick={() => setEditing(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <button className="modal-close" onClick={() => setEditing(null)}><X size={20}/></button>
      <span className="eyebrow">MODELO DE MENSAGEM</span><h2>{editing.id ? 'Editar modelo' : 'Novo modelo'}</h2>
      <label>Nome<input maxLength={80} placeholder="Especialidades e valores" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })}/></label>
      <label>Quando usar (a Giovana lê isso)<input maxLength={300} placeholder="Quando o paciente perguntar quais especialidades temos" value={editing.whenToUse ?? ''} onChange={(e) => setEditing({ ...editing, whenToUse: e.target.value })}/></label>
      <label>Mensagem<textarea rows={8} maxLength={1500} placeholder={'Olá, {nome}! ...'} value={editing.body ?? ''} onChange={(e) => setEditing({ ...editing, body: e.target.value })}/></label>
      <button className="call-button" disabled={busy || !editing.name?.trim() || !editing.body?.trim()} onClick={() => void save()}>Salvar modelo</button>
    </div></div>}

    {testing && <div className="modal-backdrop" onClick={() => setTesting(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <button className="modal-close" onClick={() => setTesting(null)}><X size={20}/></button>
      <span className="eyebrow">TESTE</span><h2>Enviar "{testing.name}"</h2>
      <p className="muted">Envia a mensagem de verdade pelo WhatsApp da clínica. Use o seu próprio número.</p>
      <label>WhatsApp de destino<input inputMode="tel" placeholder="(17) 99654-3210" value={testPhone} onChange={(e) => setTestPhone(e.target.value)}/></label>
      <button className="call-button" disabled={busy || testPhone.replace(/\D/g, '').length < 10} onClick={() => void runTest()}>{busy ? 'Enviando...' : 'Enviar teste'}</button>
    </div></div>}
  </div>
}
