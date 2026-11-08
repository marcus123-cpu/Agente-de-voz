import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from './config.js';
import * as repo from './repository.js';
import { cvortexReady, startCvortexCall, endCvortexCall, takeoverCvortexCall, greetingForNow } from './cvortex-provider.js';
import { buildConfirmationPrompt, confirmationFirstMessage, buildMissedPrompt, missedFirstMessage } from './confirm-prompt.js';
import { publishLive } from './live.js';
import { sendWhatsapp, whatsappStatus, WhatsappSendError } from './whatsapp.js';
import { ameiStatus, ameiFreeSlots, ameiPatientAppointments, ameiAppointmentContext, ameiApplyOutcome, ameiMissedContext, ameiAddToWaitlist, missedSituationOf, startAmeiWarming, spokenLongDay, spokenClock, spokenMoney, AmeiError, type AppointmentContext } from './amei.js';
import type { Call, CallResult, CallStatus } from './types.js';

export class PublicError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
type Listener = (call: Call) => void;
const listeners = new Map<string, Set<Listener>>();
const volatileCalls = new Map<string, Call>();
function applyChanges(call: Call, changes: Record<string, unknown>): Call {
  const map: Record<string, keyof Call> = {
    cvortex_call_id:'cvortexCallId', elevenlabs_conversation_id:'elevenlabsConversationId',
    status:'status', answered_at:'answeredAt', ended_at:'endedAt', duration_seconds:'durationSeconds',
    result:'result', summary:'summary', metadata:'metadata',
  };
  const updated = {...call} as unknown as Record<string, unknown>;
  for (const [key,value] of Object.entries(changes)) if (map[key]) updated[map[key]] = value;
  return updated as unknown as Call;
}
async function updateManagedCall(call: Call, changes: Record<string, unknown>): Promise<Call> {
  const latest = volatileCalls.get(call.id) || call;
  const next = applyChanges(latest, changes);
  volatileCalls.set(call.id, next);
  try {
    const persisted = await repo.updateCall(call.id, changes);
    if (volatileCalls.get(call.id) === next) volatileCalls.delete(call.id);
    return persisted;
  } catch (error) {
    console.error('[CALL] database update deferred', call.id, error);
    return next;
  }
}
async function retryVolatile(): Promise<void> {
  for (const [id, call] of volatileCalls) {
    try {
      const persisted = await repo.updateCall(id, {
        cvortex_call_id:call.cvortexCallId, elevenlabs_conversation_id:call.elevenlabsConversationId,
        status:call.status, answered_at:call.answeredAt, ended_at:call.endedAt,
        duration_seconds:call.durationSeconds, result:call.result, summary:call.summary, metadata:call.metadata,
      });
      if (volatileCalls.get(id) === call) { volatileCalls.delete(id); publish(persisted); }
    } catch { /* Retry while the process is running; the call itself is unaffected. */ }
  }
}
const retryTimer=setInterval(()=>{void retryVolatile();},5000);
retryTimer.unref();
export async function getManagedCall(id: string): Promise<Call | null> {
  const pending=volatileCalls.get(id); if(pending)return pending;
  return repo.getCall(id);
}
export async function listManagedCalls(): Promise<Call[]> {
  let stored:Call[]=[];
  try {stored=await repo.listCalls();} catch(error) {if(!volatileCalls.size)throw error;}
  const merged=new Map(stored.map(call=>[call.id,call]));
  for(const call of volatileCalls.values())merged.set(call.id,call);
  return [...merged.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export async function getManagedCallByConversationId(id:string):Promise<Call|null> {
  for(const call of volatileCalls.values())if(call.elevenlabsConversationId===id)return call;
  return repo.getCallByConversationId(id);
}
export function onCallChange(id: string, listener: Listener): () => void {
  const set = listeners.get(id) || new Set<Listener>(); set.add(listener); listeners.set(id,set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(id); };
}
function publish(call: Call) { listeners.get(call.id)?.forEach(fn=>fn(call)); }
function mask(phone: string) { return `${phone.slice(0,5)}******${phone.slice(-4)}`; }
export function normalizePhone(value: string): string {
  const phone = parsePhoneNumberFromString(value, 'BR');
  if (!phone?.isValid() || phone.country !== 'BR') throw new PublicError(400,'Número inválido. Informe um celular brasileiro com DDD.');
  return phone.number;
}
export async function startCall(brainId: string, patientName: string, rawPhone: string, contactContext: 'not_informed' | 'recent_card_member' | 'appointment_confirmation' | 'missed_appointment' = 'not_informed', appointment?: AppointmentContext): Promise<Call> {
  if (!brainId || !patientName?.trim() || patientName.length > 120 || !rawPhone) throw new PublicError(400,'Informe cérebro, nome e telefone válidos.');
  if (!['not_informed','recent_card_member','appointment_confirmation','missed_appointment'].includes(contactContext)) throw new PublicError(400,'Origem do contato inválida.');
  const phone = normalizePhone(rawPhone);
  await ensureElevenLabsCredits();
  const brain = await repo.getBrain(brainId);
  if (!brain?.isActive) throw new PublicError(404,'Cérebro de IA não encontrado ou inativo.');
  const agentId = brain.elevenlabsAgentId || (brain.slug === 'patient-acquisition' ? config.elevenLabsAgentId : '');
  if (!config.elevenLabsKey || !agentId) throw new PublicError(503,'Agente ElevenLabs não configurado.');
  if (!(await cvortexReady())) throw new PublicError(503,'Abra e autentique o webphone cVortex no perfil isolado antes de discar.');
  if (await repo.isDoNotContact(phone)) throw new PublicError(409,'Este contato solicitou não receber novos contatos.');
  // Quem recebe ligação entra na base de contatos (se já existir, nada muda).
  await repo.importContacts([{ name: patientName.trim(), phone, source: 'ligacao' }]).catch((e: unknown) => console.error('[CONTATOS]', e instanceof Error ? e.message : e));
  const whatsappModels = await whatsappModelsText();
  const ameiAvailable = await ameiAgendaText();
  // Captação: deixa pronta a agenda das especialidades mais procuradas, para a resposta sair na hora.
  const stopWarming = (!appointment || appointment.kind === 'missed') && !appointment?.test && ameiAvailable === 'conectada' ? startAmeiWarming() : () => undefined;
  // Faltoso: já deixa pronta a agenda da especialidade (e do profissional) da consulta perdida.
  if (appointment?.kind === 'missed' && !appointment.test) void ameiFreeSlots({ especialidade: appointment.specialty, refresh: true }).catch(() => undefined);
  let call = await repo.createCall({brain_id:brainId,patient_name:patientName.trim(),phone,provider:'cvortex',status:'connecting',started_at:new Date().toISOString(),result:'unknown',metadata:{contact_context:contactContext,...(appointment?{appointment}:{})}});
  console.info(`[CALL] Starting ${brain.slug} -> ${mask(phone)}`);
  try {
    await startCvortexCall({
      callId:call.id, phone, patientName:patientName.trim(), contactContext, agentId, whatsappModels, ameiAgenda: ameiAvailable, extraVariables: appointment ? appointmentVariables(appointment) : undefined, promptOverride: appointment ? promptFor(appointment) : undefined, firstMessageOverride: appointment ? firstMessageFor(appointment) : undefined,
      onStatus:(status)=>{ void updateStatus(call,status).catch(error=>console.error('[CALL] status callback failed',error)); },
      onAgentConnected:()=>{ void getManagedCall(call.id).then(current=>current && !current.metadata?.human_takeover ? updateManagedCall(current,{metadata:{...(current.metadata||{}),ai_connected:true}}) : null).then(updated=>{if(updated)publish(updated);}).catch(error=>console.error('[CALL] agent callback failed',error)); },
      onConversationId:(id)=>{ void getManagedCall(call.id).then(current=>current && updateManagedCall(current,{elevenlabs_conversation_id:id})).then(updated=>{if(updated)publish(updated);}).catch(error=>console.error('[CALL] conversation callback failed',error)); },
      onEnded:(status)=>{ stopWarming(); void updateStatus(call,status).catch(error=>console.error('[CALL] end callback failed',error)); },
      onAudio:(source,pcm)=>publishLive(call.id,{kind:'audio',source,pcm}),
      onText:(role,text,correction)=>{ const clean=text.replace(/\[[^\]]{1,40}\]/g,'').replace(/\s{2,}/g,' ').trim(); if(clean) publishLive(call.id,{kind:'text',role,text:clean,correction}); },
      onFlush:()=>publishLive(call.id,{kind:'flush'}),
      onToolCall:(name,params)=>handleAgentTool(call.id,phone,call.patientName,name,params,appointment),
    });
  }
  catch(error) {
    stopWarming();
    console.error('[CALL] start failed',error);
    if ((error as {ambiguousStart?:boolean})?.ambiguousStart) {
      call = await updateManagedCall(call,{metadata:{...(call.metadata||{}),start_uncertain:true}}); publish(call);
      throw new PublicError(503,'A discagem pode ter sido aceita. Confira o webphone antes de tentar novamente.');
    }
    call = await updateStatus(call,'failed');
    throw new PublicError(502,'Não foi possível iniciar a ligação pelo webphone cVortex.');
  }
  const current = await getManagedCall(call.id) || call;
  publish(current); void repo.appendEvent(call.id,'call.started',{provider:'cvortex'});
  return current;
}
const statusTransitions=new Map<string,Promise<Call>>();
export async function updateStatus(call: Call, status: CallStatus, duration?: number): Promise<Call> {
  const previous=statusTransitions.get(call.id);
  const transition=(async()=>{
    if(previous) await previous;
    const latest=await getManagedCall(call.id);
    return updateStatusUnlocked(latest||call,status,duration);
  })();
  statusTransitions.set(call.id,transition);
  try {return await transition;} finally {if(statusTransitions.get(call.id)===transition)statusTransitions.delete(call.id);}
}
async function updateStatusUnlocked(call: Call, status: CallStatus, duration?: number): Promise<Call> {
  if (['completed','failed','busy','no_answer','canceled'].includes(call.status)) return call;
  if (call.status===status) return call;
  const rank:Record<string,number>={idle:0,connecting:1,ringing:2,in_progress:3,completed:4,failed:4,busy:4,no_answer:4,canceled:4};
  if (rank[status]! < rank[call.status]!) return call;
  const terminal = ['completed','failed','busy','no_answer','canceled'].includes(status);
  const now = new Date().toISOString();
  const changes: Record<string,unknown> = {status};
  if (status==='in_progress' && !call.answeredAt) changes.answered_at=now;
  if (terminal && !call.endedAt) changes.ended_at=now;
  if (duration !== undefined) changes.duration_seconds=duration;
  else if (terminal && call.answeredAt) changes.duration_seconds=Math.max(0,Math.floor((Date.now()-Date.parse(call.answeredAt))/1000));
  const updated=await updateManagedCall(call,changes); publish(updated);
  void repo.appendEvent(call.id,'call.status',{status});
  if (terminal) void deliverAutomation(updated);
  return updated;
}
async function deliverAutomation(call: Call): Promise<void> {
  if (!config.enableN8n || !config.n8nUrl) { console.info('[N8N] integration disabled'); return; }
  try {
    const brain = await repo.getBrain(call.brainId);
    const response = await fetch(config.n8nUrl,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(5000),body:JSON.stringify({event:'call.completed',call_id:call.id,patient_name:call.patientName,phone:call.phone,brain:brain?.slug,status:call.status,result:call.result,transfer_requested:call.transferRequested,summary:call.summary})});
    if(!response.ok) console.error('[N8N] delivery failed',response.status);
  } catch(error) { console.error('[N8N] delivery failed',error); }
}
export async function syncCall(call: Call): Promise<Call> {
  return await getManagedCall(call.id) || call;
}
export async function endCall(call: Call): Promise<Call> {
  if (['completed','failed','busy','no_answer','canceled'].includes(call.status)) return call;
  try { await endCvortexCall(call.id); return await getManagedCall(call.id) || call; }
  catch(error) { console.error('[CALL] end failed',error); throw new PublicError(502,'Não foi possível confirmar o encerramento no webphone cVortex.'); }
}
export async function takeoverCall(call: Call): Promise<Call> {
  const latest = await getManagedCall(call.id) || call;
  if (latest.status !== 'in_progress') throw new PublicError(409,'A ligação ainda não está pronta para assumir.');
  if (latest.metadata?.human_takeover) return latest;
  if (latest.metadata?.ai_connected !== true) throw new PublicError(409,'A conexão com a Giovana ainda não foi confirmada.');
  try { await takeoverCvortexCall(call.id); }
  catch(error) { console.error('[CALL] takeover failed',error); throw new PublicError(502,'Não foi possível restaurar o microfone. Confira o webphone e tente novamente.'); }
  const updated=await updateManagedCall(latest,{metadata:{...(latest.metadata||{}),ai_connected:false,human_takeover:true,takeover_at:new Date().toISOString()}});
  publish(updated);
  void repo.appendEvent(call.id,'call.human_takeover',{});
  return updated;
}
export async function saveResult(call: Call, result: CallResult, note?: string): Promise<Call> {
  if (!['interested','not_interested','callback','do_not_contact','unknown'].includes(result)) throw new PublicError(400,'Resultado inválido.');
  const summary = {...(call.summary||{}),...(note?.trim()?{operator_note:note.trim().slice(0,2000)}:{})};
  const updated=await updateManagedCall(call,{result,summary}); publish(updated);
  if(result==='do_not_contact') await repo.setDoNotContact(call.patientName,call.phone);
  return updated;
}

const TOOL_TEXT_MAX = 300;
function cleanToolText(value: unknown, max = TOOL_TEXT_MAX): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\p{Cc}+/gu, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
  return text || undefined;
}
/** Lista de modelos que a Giovana pode enviar, injetada no prompt como {{modelos_whatsapp}}. */
export async function whatsappModelsText(): Promise<string> {
  try {
    const [templates, status] = await Promise.all([repo.listTemplates(), whatsappStatus()]);
    const active = templates.filter(t => t.isActive);
    if (!status.loggedIn || !active.length) return 'nenhum (o envio de WhatsApp está indisponível agora; não ofereça enviar mensagem)';
    return active.map(t => `- ${t.slug}: ${t.name}${t.whenToUse ? ` (${t.whenToUse})` : ''}`).join('\n');
  } catch (error) {
    console.error('[WHATSAPP] lista de modelos indisponível:', error instanceof Error ? error.message : error);
    return 'nenhum (o envio de WhatsApp está indisponível agora; não ofereça enviar mensagem)';
  }
}

/** Diz ao prompt ({{agenda_amei}}) se a Giovana pode consultar a agenda da AMEI nesta ligação. */
export async function ameiAgendaText(): Promise<string> {
  try { return (await ameiStatus()).loggedIn ? 'conectada' : 'indisponivel (não consulte horários nem consultas; diga que a equipe confere e retorna)'; }
  catch { return 'indisponivel (não consulte horários nem consultas; diga que a equipe confere e retorna)'; }
}

export function renderTemplate(body: string, patientName: string): string {
  const first = patientName.trim().split(/\s+/)[0] ?? '';
  const nome = first ? first.charAt(0).toLocaleUpperCase('pt-BR') + first.slice(1).toLocaleLowerCase('pt-BR') : '';
  return body.replaceAll('{nome}', nome || 'tudo bem').trim();
}

const MAX_WHATSAPP_PER_CALL = 3;
const sentByCall = new Map<string, Set<string>>();

/** Coloca a mensagem na fila: grava o registro e envia em segundo plano, sem segurar a conversa. */
async function queueWhatsapp(opts: { callId: string | null; patientName: string; phone: string; slug: string | null; body: string; source: 'ia' | 'teste' }): Promise<string> {
  const id = await repo.logMessage({ call_id: opts.callId, template_slug: opts.slug, patient_name: opts.patientName, phone: opts.phone, body: opts.body, source: opts.source });
  void sendWhatsapp(opts.phone, opts.body)
    .then(() => repo.updateMessage(id, { status: 'sent' }))
    .catch(async (error: unknown) => {
      const reason = error instanceof WhatsappSendError ? error.message : 'Falha inesperada no envio.';
      console.error('[WHATSAPP] envio falhou:', error instanceof Error ? error.message : error);
      await repo.updateMessage(id, { status: 'failed', error: reason });
    });
  return id;
}

export async function sendTestWhatsapp(rawPhone: string, templateId: string): Promise<void> {
  const phone = normalizePhone(rawPhone);
  const tpl = await repo.getTemplate(templateId);
  if (!tpl) throw new PublicError(404, 'Modelo não encontrado.');
  if (!(await whatsappStatus()).loggedIn) throw new PublicError(503, 'WhatsApp Web não está conectado. Abra e leia o QR code.');
  await queueWhatsapp({ callId: null, patientName: 'Teste', phone, slug: tpl.slug, body: renderTemplate(tpl.body, 'Teste'), source: 'teste' });
}

/** Ferramentas da Giovana. Ela só alcança o contato da própria ligação e só usa modelos cadastrados. */
export async function handleAgentTool(callId: string, phone: string, patientName: string, name: string, params: Record<string, unknown>, appointment?: AppointmentContext): Promise<string> {
  if (name === 'registrar_confirmacao') return registerConfirmation(callId, appointment, params);
  if (name === 'registrar_faltoso') return registerMissed(callId, phone, appointment, params);
  if (name === 'enviar_whatsapp') {
    const slug = cleanToolText(params.modelo, 40)?.toLowerCase();
    if (!slug) return 'Informe qual modelo enviar.';
    if (params.numero_confirmado !== true) return 'Antes de enviar, pergunte ao paciente se o número da ligação é o WhatsApp dele (ou peça outro número) e só então chame de novo.';
    const tpl = await repo.getTemplateBySlug(slug);
    if (!tpl || !tpl.isActive) return 'Modelo inexistente. Use apenas os modelos listados no prompt.';
    let target = phone;
    const other = cleanToolText(params.whatsapp, 30);
    if (other) { try { target = normalizePhone(other); } catch { return 'Esse número de WhatsApp parece inválido; peça para o paciente repetir com DDD.'; } }
    if (await repo.isDoNotContact(target)) return 'Este contato pediu para não receber mensagens.';
    if (!(await whatsappStatus()).loggedIn) return 'WhatsApp indisponível agora. Diga que a equipe envia depois.';
    const done = sentByCall.get(callId) ?? new Set<string>();
    sentByCall.set(callId, done);
    const key = `${slug}:${target}`;
    if (done.has(key)) return 'Essa mensagem já foi enviada nesta ligação.';
    if (done.size >= MAX_WHATSAPP_PER_CALL) return 'Limite de mensagens desta ligação atingido.';
    done.add(key);
    await queueWhatsapp({ callId, patientName, phone: target, slug, body: renderTemplate(tpl.body, patientName), source: 'ia' });
    await repo.appendEvent(callId, 'ai.whatsapp_queued', { template: slug, to: target === phone ? 'numero_da_ligacao' : 'numero_informado' });
    return 'Mensagem enviada ao WhatsApp do paciente. Confirme com ele de forma natural.';
  }
  if (name === 'consultar_horarios_agenda' || name === 'consultar_minha_consulta') {
    try {
      if (name === 'consultar_horarios_agenda') {
        const especialidade = cleanToolText(params.especialidade, 80);
        if (!especialidade) return 'Pergunte qual especialidade o paciente procura.';
        const days = Number(params.dias);
        const text = await ameiFreeSlots({ especialidade, profissional: cleanToolText(params.profissional, 80), dias: Number.isFinite(days) ? days : undefined });
        await repo.appendEvent(callId, 'ai.amei_slots', { especialidade });
        return text;
      }
      const text = await ameiPatientAppointments(phone);
      await repo.appendEvent(callId, 'ai.amei_appointments', {});
      return text;
    } catch (error) {
      console.error('[AMEI] consulta falhou:', error instanceof Error ? error.message : error);
      return error instanceof AmeiError ? `Agenda indisponível agora (${error.message}). Diga que a equipe confere e retorna, sem inventar horários.` : 'Agenda indisponível agora. Diga que a equipe confere e retorna, sem inventar horários.';
    }
  }
  if (name !== 'salvar_informacao_contato') throw new Error('Ferramenta desconhecida.');
  const note = cleanToolText(params.anotacao);
  const correctName = cleanToolText(params.nome_correto, 120);
  const doNotContact = params.nao_contatar === true;
  if (!note && !correctName && !doNotContact) return 'Informe o que deve ser salvo.';
  const result = await repo.aiUpdateContact(phone, { note, name: correctName, doNotContact: doNotContact || undefined });
  await repo.appendEvent(callId, 'ai.contact_updated', { note: note ?? null, name: correctName ?? null, do_not_contact: doNotContact });
  return result;
}

// ─── Ligação de confirmação de consulta (AMEI) ───────────────────────────────────────────────────
/** Nome para falar ao telefone: primeiro e segundo nome ("Rodrigo Augusto"), sem sobrenomes longos. */
function spokenName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.slice(0, parts.length > 1 && !/^(d[aeo]s?|e)$/i.test(parts[1] ?? '') ? 2 : 1).join(' ');
}
function appointmentVariables(a: AppointmentContext): Record<string, string> {
  return { patient_name: spokenName(a.patientName), consulta_dia: spokenLongDay(a.date), consulta_hora: spokenClock(a.time), consulta_profissional: a.professional || 'o profissional da agenda', consulta_especialidade: a.specialty || 'consulta', consulta_valor: (a.valor && spokenMoney(a.valor)) || 'não informado' };
}

const callsByAppointment = new Map<string, string>();
const confirmWrites = new Map<string, number>();
const MAX_CONFIRM_WRITES = 2;

/** Liga para o paciente de uma consulta da AMEI. Os dados vêm da AMEI na hora, nunca do navegador. */
export async function startConfirmationCall(brainId: string, appointmentId: string): Promise<Call> {
  if (!/^\d{1,12}$/.test(appointmentId)) throw new PublicError(400, 'Consulta inválida.');
  if (!(await ameiStatus()).loggedIn) throw new PublicError(503, 'A AMEI não está conectada. Entre na AMEI pela aba Automações.');
  const previousId = callsByAppointment.get(appointmentId);
  if (previousId) {
    const previous = await getManagedCall(previousId);
    if (previous && !['completed', 'failed', 'busy', 'no_answer', 'canceled'].includes(previous.status)) throw new PublicError(409, 'Já existe uma ligação em andamento para essa consulta.');
  }
  let context: AppointmentContext;
  try { context = await ameiAppointmentContext(appointmentId); }
  catch (error) { throw new PublicError(409, error instanceof AmeiError ? error.message : 'Não foi possível ler a consulta na AMEI.'); }
  const call = await startCall(brainId, context.patientName, context.phone, 'appointment_confirmation', context);
  callsByAppointment.set(appointmentId, call.id);
  return call;
}

/** Ferramenta registrar_confirmacao: só mexe na consulta DESTA ligação e só com o que o paciente disse. */
async function registerConfirmation(callId: string, appointment: AppointmentContext | undefined, params: Record<string, unknown>): Promise<string> {
  if (!appointment) return 'Esta ligação não é de confirmação de consulta; não use esta ferramenta.';
  if (appointment.test) return simulateConfirmation(callId, params);
  const outcome = cleanToolText(params.resultado, 20)?.toLowerCase();
  if (outcome !== 'confirmou' && outcome !== 'desmarcou' && outcome !== 'remarcar') return 'Informe o resultado: confirmou, desmarcou ou remarcar.';
  const current = await getManagedCall(callId);
  if (outcome === 'remarcar') {
    await repo.appendEvent(callId, 'ai.reschedule_requested', { appointment_id: appointment.appointmentId });
    if (current) publish(await updateManagedCall(current, { transfer_requested: true, result: 'callback', metadata: { ...(current.metadata || {}), confirmation: { outcome: 'remarcar', at: new Date().toISOString() } } }));
    return 'Registrado que o paciente quer remarcar. Faça agora a passagem para o Marcos do passo 5 e NÃO encerre a ligação.';
  }
  if (outcome === 'desmarcou' && params.paciente_confirmou_cancelamento !== true) return 'Antes de desmarcar, pergunte claramente se o paciente quer CANCELAR a consulta e só então chame de novo com paciente_confirmou_cancelamento=true.';
  const writes = confirmWrites.get(callId) ?? 0;
  if (writes >= MAX_CONFIRM_WRITES) return 'Limite de alterações da agenda nesta ligação atingido. Diga que a equipe confere.';
  confirmWrites.set(callId, writes + 1);
  try {
    const message = await ameiApplyOutcome(appointment, outcome);
    await repo.appendEvent(callId, 'ai.appointment_' + outcome, { appointment_id: appointment.appointmentId });
    if (current) publish(await updateManagedCall(current, { result: outcome === 'confirmou' ? 'interested' : 'not_interested', metadata: { ...(current.metadata || {}), confirmation: { outcome, at: new Date().toISOString() } } }));
    return outcome === 'confirmou'
      ? `${message} Agradeça com carinho e encerre a ligação com a ferramenta end_call.`
      : `${message} Diga que sente muito, que a equipe ajuda a remarcar quando ele quiser, despeça-se e encerre com end_call.`;
  } catch (error) {
    console.error('[AMEI] alteração falhou:', error instanceof Error ? error.message : error);
    await repo.appendEvent(callId, 'ai.appointment_failed', { appointment_id: appointment.appointmentId, outcome, reason: error instanceof Error ? error.message : 'erro' });
    return `Não consegui atualizar a agenda agora${error instanceof AmeiError ? ` (${error.message})` : ''}. Diga que a equipe atualiza manualmente, sem afirmar que confirmou ou desmarcou. Encerre com educação.`;
  }
}

/** Ligação de teste: a Giovana usa a ferramenta normalmente, mas nada é gravado na AMEI. */
async function simulateConfirmation(callId: string, params: Record<string, unknown>): Promise<string> {
  const outcome = cleanToolText(params.resultado, 20)?.toLowerCase();
  if (outcome !== 'confirmou' && outcome !== 'desmarcou' && outcome !== 'remarcar') return 'Informe o resultado: confirmou, desmarcou ou remarcar.';
  if (outcome === 'desmarcou' && params.paciente_confirmou_cancelamento !== true) return 'Antes de desmarcar, pergunte claramente se o paciente quer CANCELAR a consulta e só então chame de novo com paciente_confirmou_cancelamento=true.';
  await repo.appendEvent(callId, 'ai.test_' + outcome, {});
  const current = await getManagedCall(callId);
  if (current) publish(await updateManagedCall(current, { metadata: { ...(current.metadata || {}), confirmation: { outcome, at: new Date().toISOString(), test: true } } }));
  if (outcome === 'remarcar') return 'Registrado que o paciente quer remarcar. Faça agora a passagem para o Marcos do passo 5 e NÃO encerre a ligação.';
  return outcome === 'confirmou'
    ? 'Consulta confirmada na agenda. Agradeça com carinho e encerre a ligação com a ferramenta end_call.'
    : 'Consulta desmarcada na agenda. Diga que sente muito, que a equipe ajuda a remarcar quando ele quiser, despeça-se e encerre com end_call.';
}

export interface TestConfirmation { phone: string; patientName: string; professional: string; specialty: string; date: string; time: string; valor?: string }
/** Liga para o telefone informado com uma consulta FICTÍCIA, só para ouvir como a Giovana fala. */
export async function startTestConfirmationCall(brainId: string, input: TestConfirmation): Promise<Call> {
  const patientName = cleanToolText(input.patientName, 120), professional = cleanToolText(input.professional, 120), specialty = cleanToolText(input.specialty, 80);
  if (!patientName || !professional || !specialty) throw new PublicError(400, 'Preencha paciente, profissional e especialidade.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw new PublicError(400, 'Informe um dia válido.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new PublicError(400, 'Informe uma hora válida.');
  const valor = cleanToolText(input.valor, 12)?.replace(/[^\d.,]/g, '');
  const phone = normalizePhone(input.phone);
  const context: AppointmentContext = { appointmentId: 'teste', date: input.date, time: input.time, patientName, phone, professional, specialty, statusId: 2, valor: valor || undefined, test: true };
  return startCall(brainId, patientName, phone, 'appointment_confirmation', context);
}

// ─── Créditos do ElevenLabs: sem eles a conversa nem abre e a ligação cai em segundos ─────────────
let creditsCheck: { at: number; used: number; limit: number; reset: number } | null = null;
async function ensureElevenLabsCredits(): Promise<void> {
  if (!config.elevenLabsKey) return;
  try {
    if (!creditsCheck || Date.now() - creditsCheck.at > 60_000) {
      const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': config.elevenLabsKey }, signal: AbortSignal.timeout(4000) });
      if (!response.ok) return;
      const data = await response.json() as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
      if (typeof data.character_count !== 'number' || typeof data.character_limit !== 'number') return;
      creditsCheck = { at: Date.now(), used: data.character_count, limit: data.character_limit, reset: data.next_character_count_reset_unix ?? 0 };
    }
  } catch { return; /* sem resposta: segue e deixa a ligação tentar */ }
  if (creditsCheck.limit - creditsCheck.used < 50) {
    const renew = creditsCheck.reset ? new Date(creditsCheck.reset * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'a próxima renovação';
    throw new PublicError(402, `Os créditos do ElevenLabs acabaram (${creditsCheck.used} de ${creditsCheck.limit} usados). Renove ou troque o plano no ElevenLabs, ou aguarde até ${renew}.`);
  }
}

function confirmationPromptFor(a: AppointmentContext): string {
  const v = appointmentVariables(a);
  return buildConfirmationPrompt({ patientName: v.patient_name!, day: v.consulta_dia!, time: v.consulta_hora!, professional: v.consulta_profissional!, specialty: v.consulta_especialidade!, value: v.consulta_valor!, greeting: greetingForNow() });
}

// ─── Faltosos: recuperação de consulta perdida (AMEI) ────────────────────────────────────────────
function promptFor(a: AppointmentContext): string {
  if (a.kind !== 'missed') return confirmationPromptFor(a);
  const v = appointmentVariables(a);
  return buildMissedPrompt({ patientName: v.patient_name!, day: v.consulta_dia!, time: v.consulta_hora!, professional: v.consulta_profissional!, specialty: v.consulta_especialidade!, situation: missedSituationOf(a.statusId), greeting: greetingForNow() });
}
function firstMessageFor(a: AppointmentContext): string {
  const name = appointmentVariables(a).patient_name!;
  return a.kind === 'missed' ? missedFirstMessage(greetingForNow(), name) : confirmationFirstMessage(greetingForNow(), name);
}

const MISSED_RECENT_MS = 72 * 3600_000;

/** Liga para um paciente que perdeu a consulta (não compareceu, desmarcou ou cancelada). Dados lidos da AMEI na hora. */
export async function startMissedCall(brainId: string, appointmentId: string): Promise<Call> {
  if (!/^\d{1,12}$/.test(appointmentId)) throw new PublicError(400, 'Consulta inválida.');
  if (!(await ameiStatus()).loggedIn) throw new PublicError(503, 'A AMEI não está conectada. Entre na AMEI pela aba Automações.');
  const previousId = callsByAppointment.get(appointmentId);
  if (previousId) {
    const previous = await getManagedCall(previousId);
    if (previous && !['completed', 'failed', 'busy', 'no_answer', 'canceled'].includes(previous.status)) throw new PublicError(409, 'Já existe uma ligação em andamento para essa consulta.');
  }
  // Não liga duas vezes seguidas para a mesma consulta perdida (só se a anterior não foi atendida).
  const recent = (await listManagedCalls()).find(c => (c.metadata?.contact_context === 'missed_appointment') && (c.metadata?.appointment as { appointmentId?: string } | undefined)?.appointmentId === appointmentId
    && c.status === 'completed' && Date.now() - new Date(c.createdAt ?? 0).getTime() < MISSED_RECENT_MS);
  if (recent) throw new PublicError(409, 'Já falamos com esse paciente sobre essa consulta nos últimos 3 dias.');
  let context: AppointmentContext;
  try { context = await ameiMissedContext(appointmentId); }
  catch (error) { throw new PublicError(409, error instanceof AmeiError ? error.message : 'Não foi possível ler a consulta na AMEI.'); }
  const call = await startCall(brainId, context.patientName, context.phone, 'missed_appointment', context);
  callsByAppointment.set(appointmentId, call.id);
  return call;
}

export interface TestMissed { phone: string; patientName: string; professional: string; specialty: string; date: string; time: string; situation: string }
/** Ligação de teste do roteiro de faltosos: consulta FICTÍCIA; a lista de espera é só simulada. */
export async function startTestMissedCall(brainId: string, input: TestMissed): Promise<Call> {
  const patientName = cleanToolText(input.patientName, 120), professional = cleanToolText(input.professional, 120), specialty = cleanToolText(input.specialty, 80);
  if (!patientName || !professional || !specialty) throw new PublicError(400, 'Preencha paciente, profissional e especialidade.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw new PublicError(400, 'Informe um dia válido.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new PublicError(400, 'Informe uma hora válida.');
  const statusId = input.situation === 'desmarcou' ? 9 : input.situation === 'cancelada' ? 3 : 17;
  const phone = normalizePhone(input.phone);
  const context: AppointmentContext = { appointmentId: 'teste', date: input.date, time: input.time, patientName, phone, professional, specialty, statusId, kind: 'missed', patientId: 'teste', specialtyId: 'teste', test: true };
  return startCall(brainId, patientName, phone, 'missed_appointment', context);
}

const missedState = new Map<string, { outcomes: Set<string>; noted: boolean }>();
const MISSED_OUTCOMES = ['remarcar_horario', 'lista_espera', 'sem_interesse', 'outro_interesse'];

/** Ferramenta registrar_faltoso: só mexe na consulta perdida DESTA ligação. A única escrita na AMEI é a lista de espera. */
async function registerMissed(callId: string, phone: string, appointment: AppointmentContext | undefined, params: Record<string, unknown>): Promise<string> {
  if (!appointment || appointment.kind !== 'missed') return 'Esta ligação não é de recuperação de consulta perdida; não use esta ferramenta.';
  const outcome = cleanToolText(params.resultado, 24)?.toLowerCase() ?? '';
  if (!MISSED_OUTCOMES.includes(outcome)) return 'Informe o resultado: remarcar_horario, lista_espera, sem_interesse ou outro_interesse.';
  const reason = cleanToolText(params.motivo_falta, 160);
  const chosen = cleanToolText(params.horario_escolhido, 80);
  const interest = cleanToolText(params.interesse, 120);
  const state = missedState.get(callId) ?? { outcomes: new Set<string>(), noted: false };
  missedState.set(callId, state);
  if (state.outcomes.has(outcome)) return 'Esse resultado já foi registrado nesta ligação.';
  if (state.outcomes.size >= 3) return 'Limite de registros desta ligação atingido.';
  state.outcomes.add(outcome);
  const what = `${appointment.specialty} de ${appointment.date.split('-').reverse().join('/')}`;
  const current = await getManagedCall(callId);
  const finish = async (result: CallResult, extra: Record<string, unknown> = {}) => {
    if (!current) return;
    const latest = (await getManagedCall(callId)) ?? current;
    publish(await updateManagedCall(latest, { result, ...extra, metadata: { ...(latest.metadata || {}), missed: { outcome, outcomes: [...state.outcomes], at: new Date().toISOString() } } }));
  };
  try {
    if (reason && !state.noted) { state.noted = true; if (!appointment.test) await repo.aiUpdateContact(phone, { note: `Consulta perdida (${what}): ${reason}` }).catch(() => undefined); }
    if (outcome === 'lista_espera') {
      const motivo = reason ?? `consulta de ${what} perdida`;
      const message = appointment.test ? 'Paciente colocado na lista de espera (TESTE: nada foi gravado na AMEI).' : await ameiAddToWaitlist(appointment, motivo);
      await repo.appendEvent(callId, 'ai.waitlist_added', { appointment_id: appointment.appointmentId, test: Boolean(appointment.test) });
      await finish('callback');
      return `${message} Confirme com o paciente de forma natural e siga para o passo 5 (perguntar se tem interesse em outra especialidade, odontologia ou exame).`;
    }
    if (outcome === 'remarcar_horario' || outcome === 'outro_interesse') {
      const note = outcome === 'remarcar_horario' ? `Quer remarcar ${appointment.specialty}${chosen ? `: ${chosen}` : ''}` : `Interesse em: ${interest ?? 'outro atendimento'}`;
      if (!appointment.test) await repo.aiUpdateContact(phone, { note }).catch(() => undefined);
      await repo.appendEvent(callId, `ai.missed_${outcome}`, { appointment_id: appointment.appointmentId });
      await finish('interested', { transfer_requested: true });
      return 'Registrado. Faça agora a passagem para o Marcos (frase única do roteiro) e NÃO encerre a ligação.';
    }
    await repo.appendEvent(callId, 'ai.missed_sem_interesse', { appointment_id: appointment.appointmentId });
    await finish('not_interested');
    return 'Registrado. Despeça-se com carinho e encerre com end_call.';
  } catch (error) {
    state.outcomes.delete(outcome);
    console.error('[AMEI] lista de espera falhou:', error instanceof Error ? error.message : error);
    await repo.appendEvent(callId, 'ai.missed_failed', { appointment_id: appointment.appointmentId, outcome, reason: error instanceof Error ? error.message : 'erro' });
    return `Não consegui registrar agora${error instanceof AmeiError ? ` (${error.message})` : ''}. Diga que a equipe faz o registro, sem afirmar que colocou na lista, e siga o roteiro.`;
  }
}
