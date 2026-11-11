import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from './config.js';
import * as repo from './repository.js';
import { cvortexReady, startCvortexCall, endCvortexCall, takeoverCvortexCall, markCvortexCallAnswered, greetingForNow } from './cvortex-provider.js';
import { buildConfirmationPrompt, confirmationFirstMessage, buildMissedPrompt, missedFirstMessage, buildWaitlistPrompt, waitlistFirstMessage, buildAcquisitionPrompt, acquisitionFirstMessage, buildCardPitchPrompt, cardPitchFirstMessage, cardReferencePrice } from './confirm-prompt.js';
import { publishLive } from './live.js';
import { sendWhatsapp, whatsappStatus, readWhatsappReplies, WhatsappSendError } from './whatsapp.js';
import { getCampaignSearch, ameiCardContext, ameiResolveBooking, ameiCpfForContext, ameiPrepareBooking, ameiBook, type BookingPlan, ameiStatus, ameiFreeSlots, ameiPatientAppointments, ameiAppointmentContext, ameiApplyOutcome, ameiMissedContext, ameiWaitlistContext, ameiAddToWaitlist, ameiConfirmList, missedSituationOf, startAmeiWarming, spokenLongDay, spokenClock, spokenMoney, AmeiError, type AppointmentContext, type ConfirmFilters } from './amei.js';
import type { Call, CallResult, CallStatus } from './types.js';
import { SELF_TALK_PATTERNS } from './self-talk-patterns.js';

export class PublicError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
type Listener = (call: Call) => void;
const listeners = new Map<string, Set<Listener>>();
const volatileCalls = new Map<string, Call>();
function applyChanges(call: Call, changes: Record<string, unknown>): Call {
  const map: Record<string, keyof Call> = {
    cvortex_call_id:'cvortexCallId', elevenlabs_conversation_id:'elevenlabsConversationId',
    status:'status', answered_at:'answeredAt', ended_at:'endedAt', duration_seconds:'durationSeconds',
    result:'result', summary:'summary', metadata:'metadata',
    transcript:'transcript', flagged:'flagged', flag_reason:'flagReason',
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
        transcript:call.transcript, flagged:call.flagged, flag_reason:call.flagReason,
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
export async function startCall(brainId: string, patientName: string, rawPhone: string, contactContext: 'not_informed' | 'recent_card_member' | 'appointment_confirmation' | 'missed_appointment' | 'waitlist_capture' | 'card_pitch' = 'not_informed', appointment?: AppointmentContext): Promise<Call> {
  if (!brainId || !patientName?.trim() || patientName.length > 120 || !rawPhone) throw new PublicError(400,'Informe cérebro, nome e telefone válidos.');
  if (!['not_informed','recent_card_member','appointment_confirmation','missed_appointment','waitlist_capture','card_pitch'].includes(contactContext)) throw new PublicError(400,'Origem do contato inválida.');
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
      callId:call.id, phone, patientName:patientName.trim(), contactContext, agentId, whatsappModels, ameiAgenda: ameiAvailable, extraVariables: appointment ? appointmentVariables(appointment) : undefined,
      promptOverride: appointment ? promptFor(appointment) : buildAcquisitionPrompt({ patientName: patientName.trim(), greeting: greetingForNow() }),
      firstMessageOverride: appointment ? firstMessageFor(appointment) : acquisitionFirstMessage(greetingForNow(), patientName.trim()),
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
export const TERMINAL_STATUSES: CallStatus[] = ['completed','failed','busy','no_answer','canceled','voicemail'];
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
  if (TERMINAL_STATUSES.includes(call.status)) return call;
  if (call.status===status) return call;
  const rank:Record<string,number>={idle:0,connecting:1,ringing:2,in_progress:3,completed:4,failed:4,busy:4,no_answer:4,canceled:4,voicemail:4};
  if (rank[status]! < rank[call.status]!) return call;
  const terminal = TERMINAL_STATUSES.includes(status);
  const now = new Date().toISOString();
  const changes: Record<string,unknown> = {status};
  if (status==='in_progress' && !call.answeredAt) changes.answered_at=now;
  if (terminal && !call.endedAt) changes.ended_at=now;
  if (duration !== undefined) changes.duration_seconds=duration;
  else if (terminal && call.answeredAt) changes.duration_seconds=Math.max(0,Math.floor((Date.now()-Date.parse(call.answeredAt))/1000));
  const updated=await updateManagedCall(call,changes); publish(updated);
  void repo.appendEvent(call.id,'call.status',{status});
  if (terminal) {
    void deliverAutomation(updated);
    void reviewCall(updated);
    const whatsapp = (status === 'no_answer' || status === 'voicemail') ? sendMissedConfirmationWhatsapp(updated) : Promise.resolve<WhatsappOutcome>('none');
    void whatsapp;
    void logCallInContactNote(updated, whatsapp);
  }
  return updated;
}
const dmy = (iso: string): string => { const [y, m, d] = iso.split('-'); return y && m && d ? `${d}/${m}/${y}` : iso; };
function renderWhatsappPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}
/** A partir de hoje: quando uma ligação de CONFIRMAÇÃO não é atendida (ninguém atendeu ou caiu na caixa
 * postal), manda sozinho um WhatsApp de confirmação com os dados da consulta, usando o modelo
 * "confirmacao_nao_atendeu" (editável na aba Automações). Se o número não tiver WhatsApp, o próprio
 * envio falha e fica registrado no log de mensagens; não trava nem repete sozinho. */
type WhatsappOutcome = 'none' | 'sent' | 'failed';
async function sendMissedConfirmationWhatsapp(call: Call): Promise<WhatsappOutcome> {
  const appointment = (call.metadata as { appointment?: AppointmentContext } | null)?.appointment;
  // Ligação de confirmação nunca grava "kind" no metadata (só faltosos/lista de espera gravam o próprio
  // kind) — então kind ausente também conta como confirmação, só exclui quando for explicitamente outra coisa.
  if (!appointment || appointment.kind === 'missed' || appointment.kind === 'waitlist' || appointment.test) return 'none';
  try {
    if (await repo.isDoNotContact(call.phone)) return 'none';
    if (!(await whatsappStatus()).loggedIn) { console.error('[WHATSAPP] confirmação automática pulada: WhatsApp Web não conectado.'); return 'none'; }
    const tpl = await repo.getTemplateBySlug('confirmacao_nao_atendeu');
    if (!tpl || !tpl.isActive) return 'none';
    const firstName = call.patientName.trim().split(/\s+/)[0] || call.patientName;
    const body = renderWhatsappPlaceholders(tpl.body, {
      nome_paciente: firstName,
      nome_profissional: appointment.professional,
      especialidade: appointment.specialty,
      data_consulta: dmy(appointment.date),
      horario_consulta: appointment.time,
    });
    await queueWhatsapp({ callId: call.id, patientName: call.patientName, phone: call.phone, slug: tpl.slug, body, source: 'ia' });
    return 'sent';
  } catch (error) { console.error('[WHATSAPP] confirmação automática falhou:', error instanceof Error ? error.message : error); return 'failed'; }
}
/** Registra na Observação do contato (aba Contatos) cada tentativa de ligação: dia e horário, o que aconteceu
 * (não atendeu, caixa postal, atendeu e confirmou etc.) e se foi mandada mensagem por WhatsApp. Não grava teste. */
const callTimeFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
async function logCallInContactNote(call: Call, whatsapp: Promise<WhatsappOutcome>): Promise<void> {
  try {
    const meta = call.metadata as { appointment?: { kind?: string; test?: boolean }; test?: boolean; confirmation?: { outcome?: string }; missed?: { outcome?: string } } | null;
    if (meta?.test || meta?.appointment?.test) return;
    const kind = meta?.appointment?.kind;
    const what = kind === 'missed' ? 'recuperação de consulta perdida' : kind === 'waitlist' ? 'lista de espera' : meta?.appointment ? 'confirmação de consulta' : 'contato';
    const [date, time] = callTimeFormat.format(new Date(call.startedAt ?? call.createdAt)).split(', ');
    let result: string;
    if (call.status === 'no_answer') result = 'não atendeu';
    else if (call.status === 'voicemail') result = 'caiu na caixa postal';
    else if (call.status === 'busy') result = 'número ocupado';
    else if (call.status === 'failed') result = 'a ligação falhou';
    else if (call.status === 'canceled') result = 'ligação cancelada';
    else {
      const outcome = meta?.confirmation?.outcome ?? meta?.missed?.outcome;
      const labels: Record<string, string> = { confirmou: 'atendeu e CONFIRMOU a consulta', desmarcou: 'atendeu e DESMARCOU a consulta', remarcar: 'atendeu e quer remarcar', remarcar_horario: 'atendeu e escolheu um horário para remarcar', lista_espera: 'atendeu e foi para a lista de espera', outro_interesse: 'atendeu e tem outro interesse', sem_interesse: 'atendeu, sem interesse em remarcar' };
      result = (outcome && labels[outcome]) || (call.answeredAt ? 'atendeu, mas não confirmou nem desmarcou' : 'ligação encerrada sem atender');
    }
    const sent = await whatsapp;
    const extra = sent === 'sent' ? ' Enviei mensagem por WhatsApp; ainda sem confirmação.' : sent === 'failed' ? ' Tentei enviar WhatsApp, mas não foi possível.' : '';
    await repo.aiUpdateContact(call.phone, { note: `Liguei dia ${date} às ${time} (${what}): ${result}.${extra}` });
  } catch (error) { console.error('[CONTATOS] observação da ligação não registrada:', error instanceof Error ? error.message : error); }
}
// Registro + revisão: busca a transcrição/análise da ElevenLabs depois que a ligação termina e sinaliza
// automaticamente ligações com problema, pra você revisar sem precisar pedir pra olhar uma por uma. A
// análise da ElevenLabs demora alguns segundos pra ficar pronta, então tenta de novo com espaçamento.
// "Alô?" sozinho NÃO entra mais aqui: desde que o roteiro passou a permitir esse "Alô?" curto quando chega
// algo ambíguo antes da primeira fala (ver firstTurnInstruction em confirm-prompt.ts), isso é comportamento
// correto, não confusão — contar isso como sinal de problema geraria falso positivo toda vez que ela acertasse.
const CONFUSION_PATTERNS = [/não entendi/i, /pode repetir/i, /não consegui entender/i, /desculp[ae].{0,20}entender/i, /tá ligado/i];
// Falou sozinha durante silêncio/toque, coisa que o roteiro proíbe explicitamente: só UMA ocorrência já
// é sinal de bug (não é "ela ficou confusa", é ela quebrando uma regra fixa do prompt). Lista compartilhada
// com cvortex-provider.ts, que usa o mesmo padrão pra cortar o áudio na hora (ver self-talk-patterns.ts).
// Fim de ligação válido e esperado (número errado / não é o paciente / parente não pode falar por ele):
// a Giovana se desculpa e encerra sem registrar nada da consulta. Isso NÃO é falha, é o roteiro certo.
// Mais tolerante que só "peço desculpas...incômodo": o modelo mudou (claude-haiku-5-5) e pode variar a
// frase ("desculpe o incômodo", "me desculpe pelo incômodo" etc.) sem deixar de ser o mesmo desfecho correto.
const WRONG_PERSON_PATTERN = /desculp\w*.{0,40}inc[ôo]modo|inc[ôo]modo.{0,40}desculp/i;
function detectCallIssues(call: Call, transcript: CallTranscriptTurn[], _callSuccessful: string | null): string[] {
  const reasons: string[] = [];
  // Nota: o campo call_successful da ElevenLabs não é usado aqui porque, sem nenhum critério de
  // avaliação configurado na conta, ele vem como "failure" por padrão em praticamente toda ligação
  // (até as que terminaram perfeitas) — é ruído, não sinal real de problema.
  const confusions = transcript.filter(t => t.role === 'agent' && CONFUSION_PATTERNS.some(p => p.test(t.message))).length;
  if (confusions >= 2) reasons.push('A Giovana pareceu confusa (pediu pra repetir, ou o paciente perguntou se a ligação ainda estava ativa) mais de uma vez.');
  if (transcript.some(t => t.role === 'agent' && SELF_TALK_PATTERNS.some(p => p.test(t.message)))) reasons.push('A Giovana falou sozinha durante um silêncio/toque, contrariando o roteiro.');
  const appointmentKind = (call.metadata as { appointment?: { kind?: string } } | null)?.appointment?.kind;
  const wrongPerson = transcript.some(t => t.role === 'agent' && WRONG_PERSON_PATTERN.test(t.message));
  if (appointmentKind && call.status === 'completed' && (call.durationSeconds ?? 0) >= 15 && call.result === 'unknown' && !wrongPerson) {
    reasons.push('Ligação de agendamento terminou sem um resultado registrado (nem confirmou, nem desmarcou, nem remarcou).');
  }
  return reasons;
}
async function reviewCall(call: Call): Promise<void> {
  if (!call.elevenlabsConversationId || call.metadata?.test) return;
  for (const delayMs of [5000, 10000, 20000]) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const { transcript, callSuccessful } = await getCallTranscript(call);
      if (!transcript.length) continue; // análise ainda não ficou pronta na ElevenLabs; tenta de novo
      const reasons = detectCallIssues(call, transcript, callSuccessful);
      const latest = await getManagedCall(call.id) || call;
      const updated = await updateManagedCall(latest, { transcript, flagged: reasons.length > 0, flag_reason: reasons.join(' ') || null });
      publish(updated);
      return;
    } catch (error) { console.error('[CALL] review attempt failed', call.id, error); }
  }
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
export interface CallTranscriptTurn { role: 'patient' | 'agent'; message: string; timeInCallSecs: number }
export async function getCallTranscript(call: Call): Promise<{ transcript: CallTranscriptTurn[]; hasAudio: boolean; terminationReason: string | null; callSuccessful: string | null }> {
  if (!call.elevenlabsConversationId) throw new PublicError(404,'Essa ligação ainda não tem conversa registrada na ElevenLabs.');
  if (!config.elevenLabsKey) throw new PublicError(503,'ElevenLabs não configurada.');
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(call.elevenlabsConversationId)}`, { headers: { 'xi-api-key': config.elevenLabsKey }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new PublicError(502,'Não foi possível obter a transcrição na ElevenLabs.');
  const data = await response.json() as { has_audio?: boolean; metadata?: { termination_reason?: string }; analysis?: { call_successful?: string }; transcript?: { role?: string; message?: string | null; time_in_call_secs?: number }[] };
  const transcript = (data.transcript ?? [])
    .filter((turn): turn is { role?: string; message: string; time_in_call_secs?: number } => typeof turn.message === 'string' && turn.message.trim().length > 0)
    .map(turn => ({ role: (turn.role === 'agent' ? 'agent' : 'patient') as 'patient' | 'agent', message: turn.message, timeInCallSecs: turn.time_in_call_secs ?? 0 }));
  return { transcript, hasAudio: Boolean(data.has_audio), terminationReason: data.metadata?.termination_reason ?? null, callSuccessful: data.analysis?.call_successful ?? null };
}
export async function getCallAudio(call: Call): Promise<{ buffer: Buffer; contentType: string }> {
  if (!call.elevenlabsConversationId) throw new PublicError(404,'Essa ligação ainda não tem conversa registrada na ElevenLabs.');
  if (!config.elevenLabsKey) throw new PublicError(503,'ElevenLabs não configurada.');
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(call.elevenlabsConversationId)}/audio`, { headers: { 'xi-api-key': config.elevenLabsKey }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new PublicError(502,'Não foi possível obter o áudio na ElevenLabs.');
  return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'audio/mpeg' };
}
export async function endCall(call: Call): Promise<Call> {
  if (TERMINAL_STATUSES.includes(call.status)) return call;
  try { await endCvortexCall(call.id); return await getManagedCall(call.id) || call; }
  catch(error) {
    console.error('[CALL] end failed',error);
    // O operador pediu pra encerrar: a ponte de áudio com a Giovana já foi derrubada mesmo que o clique no
    // botão do webphone não tenha sido confirmado a tempo (UI lenta). Sem isso, a ligação ficava "presa" como
    // em andamento no nosso sistema até o limite de segurança de 10 minutos, travando a esteira à toa.
    const latest = await getManagedCall(call.id) || call;
    if (!TERMINAL_STATUSES.includes(latest.status)) await updateStatus(latest,'completed').catch(()=>undefined);
    throw new PublicError(502,'O desligamento no webphone não foi confirmado a tempo, mas a ligação foi encerrada no painel mesmo assim.');
  }
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
/** Botão "Caiu em caixa postal": o status 'voicemail' automático depende de um webhook da ElevenLabs que
 * só funciona com uma URL pública (não alcança um servidor local) — então, até isso existir, o operador
 * marca manualmente ao perceber a gravação. Marca o status certo (sem isso a ligação ficava "completed"
 * disfarçada), desliga a ligação (sem motivo pra continuar gastando crédito falando com a máquina) e dispara
 * o WhatsApp de confirmação automaticamente (mesmo caminho do status 'voicemail' normal).
 */
export async function markCallVoicemail(call: Call): Promise<Call> {
  const latest = await getManagedCall(call.id) || call;
  if (TERMINAL_STATUSES.includes(latest.status)) return latest;
  const updated = await updateStatus(latest,'voicemail');
  try { await endCvortexCall(call.id); } catch(error) { console.error('[CALL] markVoicemail hangup failed',error); }
  return await getManagedCall(call.id) || updated;
}
/** Botão "Atendeu": o operador percebeu que a pessoa já está na linha mas a Giovana ainda está muda
 * (esperando o reconhecimento de voz reconhecer algo). Simula a pessoa tendo dito "alô" pra ela reagir
 * e seguir o roteiro normalmente — não existe como o cVortex confirmar isso sozinho (ver cvortex-provider.ts). */
export async function markCallAnswered(call: Call): Promise<void> {
  const latest = await getManagedCall(call.id) || call;
  if (latest.status !== 'in_progress') throw new PublicError(409,'A ligação não está em andamento.');
  try { await markCvortexCallAnswered(call.id); }
  catch(error) { console.error('[CALL] markAnswered failed',error); throw new PublicError(502,'Não foi possível avisar a Giovana agora. Tente de novo em instantes.'); }
  void repo.appendEvent(call.id,'call.marked_answered',{});
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
  if (name === 'agendar_consulta') return requestBooking(callId, phone, appointment, params);
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
    if (previous && !TERMINAL_STATUSES.includes(previous.status)) throw new PublicError(409, 'Já existe uma ligação em andamento para essa consulta.');
  }
  let context: AppointmentContext;
  try { context = await ameiAppointmentContext(appointmentId); }
  catch (error) { throw new PublicError(409, error instanceof AmeiError ? error.message : 'Não foi possível ler a consulta na AMEI.'); }
  const call = await startCall(brainId, context.patientName, context.phone, 'appointment_confirmation', context);
  callsByAppointment.set(appointmentId, call.id);
  return call;
}

/** Pausa entre uma ligação e a próxima da esteira (o webphone do cVortex precisa assentar antes de recarregar). Mais longa se a anterior deu erro. */
const ESTEIRA_PAUSE_MS = 6_000;
const ESTEIRA_PAUSE_AFTER_ERROR_MS = 15_000;
// ─── Esteira: liga um agendamento atrás do outro sozinha até acabar a lista ou ser desligada ────
export interface AutoConfirmStartFrom { appointmentId: string; direction: 'up' | 'down' }
export interface AutoConfirmStatus { active: boolean; current: string | null; currentCallId: string | null; remaining: number; calledCount: number; lastError: string | null; startedAt: string | null }
interface AutoConfirmState { active: boolean; brainId: string; filters: ConfirmFilters; startFrom: AutoConfirmStartFrom | null; attempted: Set<string>; current: string | null; currentCallId: string | null; remaining: number; calledCount: number; lastError: string | null; startedAt: string }
let autoConfirm: AutoConfirmState | null = null;

export function autoConfirmStatus(): AutoConfirmStatus {
  if (!autoConfirm) return { active: false, current: null, currentCallId: null, remaining: 0, calledCount: 0, lastError: null, startedAt: null };
  const { active, current, currentCallId, remaining, calledCount, lastError, startedAt } = autoConfirm;
  return { active, current, currentCallId, remaining, calledCount, lastError, startedAt };
}

export function startAutoConfirm(brainId: string, filters: ConfirmFilters, startFrom?: AutoConfirmStartFrom): void {
  if (autoConfirm?.active || captacaoAuto?.active) throw new PublicError(409, 'A esteira já está ligando sozinha.');
  if (!brainId) throw new PublicError(400, 'Selecione um cérebro.');
  autoConfirm = { active: true, brainId, filters: { ...filters, statusId: 2 }, startFrom: startFrom ?? null, attempted: new Set(), current: null, currentCallId: null, remaining: 0, calledCount: 0, lastError: null, startedAt: new Date().toISOString() };
  void runAutoConfirm(autoConfirm);
}

export function stopAutoConfirm(): void {
  if (autoConfirm) autoConfirm.active = false;
}

async function waitForCallToFinish(appointmentId: string): Promise<void> {
  const callId = callsByAppointment.get(appointmentId);
  if (!callId) return;
  await waitForCallId(callId);
}
async function waitForCallId(callId: string): Promise<void> {
  const call = await getManagedCall(callId);
  if (!call || TERMINAL_STATUSES.includes(call.status)) return;
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(safety); unsubscribe(); resolve(); };
    // Reage na hora que o status virar terminal (ex.: operador clicou "Encerrar"), em vez de ficar
    // checando de tempos em tempos — a esteira chama o próximo da fila assim que isso acontece.
    const unsubscribe = onCallChange(callId, updated => { if (TERMINAL_STATUSES.includes(updated.status)) finish(); });
    const safety = setTimeout(finish, 10 * 60 * 1000); // ~10 min de segurança: se travar, a esteira não fica presa pra sempre
  });
}

async function runAutoConfirm(state: AutoConfirmState): Promise<void> {
  while (state.active) {
    let rows;
    try { rows = (await ameiConfirmList(state.filters)).rows; }
    catch (error) { state.lastError = error instanceof AmeiError ? error.message : 'Não foi possível consultar a AMEI.'; state.active = false; break; }
    // Ponto de partida escolhido pelo operador: "desse paciente pra baixo" continua na ordem da lista a
    // partir dali; "desse paciente pra cima" começa nele e sobe pro começo da lista.
    if (state.startFrom) {
      const anchor = rows.findIndex(row => row.appointmentId === state.startFrom!.appointmentId);
      if (anchor >= 0) rows = state.startFrom.direction === 'up' ? rows.slice(0, anchor + 1).reverse() : rows.slice(anchor);
    }
    const pending = rows.filter(row => row.statusId === 2 && row.phone.length >= 10 && !state.attempted.has(row.appointmentId));
    state.remaining = pending.length;
    const next = pending[0];
    if (!next) { state.active = false; break; }   // acabou a lista desse filtro
    if (!state.active) break;
    state.attempted.add(next.appointmentId);
    state.current = next.appointmentId;
    try { const call = await startConfirmationCall(state.brainId, next.appointmentId); state.currentCallId = call.id; state.calledCount++; state.lastError = null; }
    catch (error) { state.lastError = error instanceof Error ? error.message : 'Não foi possível ligar.'; }
    await waitForCallToFinish(next.appointmentId);
    state.current = null;
    state.currentCallId = null;
    if (!state.active) break;
    await new Promise(resolve => setTimeout(resolve, state.lastError ? ESTEIRA_PAUSE_AFTER_ERROR_MS : ESTEIRA_PAUSE_MS));   // respiro entre uma ligação e outra
  }
  state.current = null;
  state.currentCallId = null;
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
/** Texto das especialidades que ela agenda sozinha nesta ligação (vazio em teste ou se não há liberação). */
function bookableText(a: AppointmentContext): string | undefined {
  if (a.test || !bookingSpecialties().length) return undefined;
  return (process.env.BOOKING_SPECIALTIES_LABEL ?? 'Clínico Geral (Clínica médica)');
}
function promptFor(a: AppointmentContext): string {
  if (a.kind === 'card') { const v = appointmentVariables(a); const ref = cardReferencePrice(a.specialty); const paidNumber = Number(a.valor); return buildCardPitchPrompt({ patientName: v.patient_name!, day: v.consulta_dia!, time: v.consulta_hora!, professional: v.consulta_profissional!, specialty: v.consulta_especialidade!, paid: spokenMoney(a.valor ?? '') || 'o valor particular', cardPrice: ref ? spokenMoney(String(ref)) : '', saving: ref != null && Number.isFinite(paidNumber) && paidNumber > ref, greeting: greetingForNow() }); }
  if (a.kind === 'waitlist') return buildWaitlistPrompt({ patientName: a.patientName, specialty: a.specialty, professional: a.professional || undefined, greeting: greetingForNow(), bookable: bookableText(a) });
  if (a.kind !== 'missed') return confirmationPromptFor(a);
  const v = appointmentVariables(a);
  return buildMissedPrompt({ patientName: v.patient_name!, day: v.consulta_dia!, time: v.consulta_hora!, professional: v.consulta_profissional!, specialty: v.consulta_especialidade!, situation: missedSituationOf(a.statusId), greeting: greetingForNow(), recoveryStatus: a.recovery?.status, recoveryNext: a.recovery?.next, bookable: bookableText(a) });
}
function firstMessageFor(a: AppointmentContext): string {
  if (a.kind === 'card') return cardPitchFirstMessage(greetingForNow(), a.patientName);
  if (a.kind === 'waitlist') return waitlistFirstMessage(greetingForNow(), a.patientName);
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
    if (previous && !TERMINAL_STATUSES.includes(previous.status)) throw new PublicError(409, 'Já existe uma ligação em andamento para essa consulta.');
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

const CARD_RECENT_MS = 30 * 24 * 3600_000;
/** Liga para um paciente atendido como particular que ainda não tem o Cartão de TODOS, para apresentar o cartão. Dados lidos da AMEI na hora. */
export async function startCardCall(brainId: string, appointmentId: string): Promise<Call> {
  if (!/^\d{1,12}$/.test(appointmentId)) throw new PublicError(400, 'Consulta inválida.');
  if (!(await ameiStatus()).loggedIn) throw new PublicError(503, 'A AMEI não está conectada. Entre na AMEI pela aba Automações.');
  const key = `card:${appointmentId}`;
  const previousId = callsByAppointment.get(key);
  if (previousId) {
    const previous = await getManagedCall(previousId);
    if (previous && !TERMINAL_STATUSES.includes(previous.status)) throw new PublicError(409, 'Já existe uma ligação em andamento para esse paciente.');
  }
  let context: AppointmentContext;
  try { context = await ameiCardContext(appointmentId); }
  catch (error) { throw new PublicError(409, error instanceof AmeiError ? error.message : 'Não foi possível ler a consulta na AMEI.'); }
  // Não incomoda duas vezes com o cartão: se já falamos com esse paciente sobre isso nos últimos 30 dias, pula.
  const recent = (await listManagedCalls()).find(c => c.metadata?.contact_context === 'card_pitch' && c.phone === context.phone && c.status === 'completed' && Date.now() - new Date(c.createdAt ?? 0).getTime() < CARD_RECENT_MS);
  if (recent) throw new PublicError(409, 'Já falamos com esse paciente sobre o Cartão de TODOS nos últimos 30 dias.');
  const call = await startCall(brainId, context.patientName, context.phone, 'card_pitch', context);
  callsByAppointment.set(key, call.id);
  return call;
}

const WAITLIST_RECENT_MS = 72 * 3600_000;

/** Liga para um paciente da lista de espera que ainda não tem consulta futura marcada pra essa especialidade. */
export async function startWaitlistCall(brainId: string, waitlistId: string): Promise<Call> {
  if (!/^\d{1,12}$/.test(waitlistId)) throw new PublicError(400, 'Entrada da lista de espera inválida.');
  if (!(await ameiStatus()).loggedIn) throw new PublicError(503, 'A AMEI não está conectada. Entre na AMEI pela aba Automações.');
  let context: AppointmentContext;
  try { context = await ameiWaitlistContext(waitlistId); }
  catch (error) { throw new PublicError(409, error instanceof AmeiError ? error.message : 'Não foi possível ler a lista de espera na AMEI.'); }
  const key = context.appointmentId; // 'waitlist:<id>', já único
  const previousId = callsByAppointment.get(key);
  if (previousId) {
    const previous = await getManagedCall(previousId);
    if (previous && !TERMINAL_STATUSES.includes(previous.status)) throw new PublicError(409, 'Já existe uma ligação em andamento para essa entrada da lista de espera.');
  }
  const recent = (await listManagedCalls()).find(c => (c.metadata?.contact_context === 'waitlist_capture') && (c.metadata?.appointment as { waitlistId?: string } | undefined)?.waitlistId === waitlistId
    && c.status === 'completed' && Date.now() - new Date(c.createdAt ?? 0).getTime() < WAITLIST_RECENT_MS);
  if (recent) throw new PublicError(409, 'Já falamos com esse paciente sobre essa lista de espera nos últimos 3 dias.');
  const call = await startCall(brainId, context.patientName, context.phone, 'waitlist_capture', context);
  callsByAppointment.set(key, call.id);
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

export interface TestWaitlist { phone: string; patientName: string; specialty: string; professional?: string }
/** Ligação de teste do roteiro de captação da lista de espera: entrada FICTÍCIA; nada é lido nem gravado na AMEI. */
export async function startTestWaitlistCall(brainId: string, input: TestWaitlist): Promise<Call> {
  const patientName = cleanToolText(input.patientName, 120), specialty = cleanToolText(input.specialty, 80);
  const professional = input.professional ? cleanToolText(input.professional, 120) : undefined;
  if (!patientName || !specialty) throw new PublicError(400, 'Preencha paciente e especialidade.');
  const phone = normalizePhone(input.phone);
  const today = new Date();
  const date = today.toISOString().slice(0, 10), time = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
  const context: AppointmentContext = { appointmentId: 'teste', date, time, patientName, phone, professional: professional ?? '', specialty, statusId: 0, kind: 'waitlist', patientId: 'teste', specialtyId: 'teste', test: true };
  return startCall(brainId, patientName, phone, 'waitlist_capture', context);
}

const missedState = new Map<string, { outcomes: Set<string>; noted: boolean }>();
const MISSED_OUTCOMES = ['remarcar_horario', 'lista_espera', 'sem_interesse', 'outro_interesse'];

/** Ferramenta registrar_faltoso: só mexe na consulta perdida DESTA ligação. A única escrita na AMEI é a lista de espera. */
async function registerMissed(callId: string, phone: string, appointment: AppointmentContext | undefined, params: Record<string, unknown>): Promise<string> {
  if (!appointment || (appointment.kind !== 'missed' && appointment.kind !== 'waitlist' && appointment.kind !== 'card')) return 'Esta ligação não é de recuperação de consulta perdida, de lista de espera nem do Cartão de TODOS; não use esta ferramenta.';
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


// ─── Confirmação pelo WhatsApp: quem recebeu a mensagem automática e respondeu "sim" é confirmado na AMEI ──
const plain = (value: string): string => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
/** Só "sim" claro e curto vira confirmação. Qualquer negação, pedido de mudança ou dúvida vira 'other' (um humano resolve). */
export function classifyWhatsappReply(text: string): 'yes' | 'other' {
  const t = plain(text);
  if (/👍/u.test(text) && t.length === 0) return 'yes';
  if (!t || t.split(' ').length > 8 || text.includes('?')) return 'other';
  if (/\b(nao|nunca|cancel\w*|desmarc\w*|remarc\w*|mudar|trocar|outro|outra|reagend\w*|duvida|infelizmente|nao vou|nao posso|quem|errado|engano|mas|posso|podemos|queria|preciso|quero|horario|dia|qual|quanto|onde)\b/.test(t)) return 'other';
  if (/^(sim|siim|simm|s|ss|ok|okay|okk|oks|certo|claro|pode|confirmo|confirmado|confirmada|combinado|blz|beleza|tudo certo|ta bom|ta certo|ta confirmado|vou sim|estarei la|estarei presente|presente|com certeza|pode confirmar|pode ser)( |$)/.test(t)) return 'yes';
  if (/\b(confirmo|confirmado|confirmada|estarei|vou sim)\b/.test(t)) return 'yes';
  return 'other';
}
const REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
const lastReplyCheck = new Map<string, number>();
let replyCheckRunning = false;
export async function checkWhatsappReplies(limit = 20): Promise<void> {
  if (replyCheckRunning) return;
  replyCheckRunning = true;
  try {
    if (!(await whatsappStatus()).loggedIn || !(await ameiStatus()).loggedIn) return;
    const messages = (await repo.listMessages(500)).filter(m => m.source === 'ia' && m.status === 'sent' && m.templateSlug === 'confirmacao_nao_atendeu' && m.callId && m.sentAt && Date.now() - Date.parse(m.sentAt) < REPLY_WINDOW_MS);
    console.info('[WHATSAPP] mensagens de confirmação aguardando resposta:', messages.length);
    const seen = new Set<string>();
    const queue = messages.filter(m => (seen.has(m.callId!) ? false : (seen.add(m.callId!), true))).sort((a, b) => (lastReplyCheck.get(a.callId!) ?? 0) - (lastReplyCheck.get(b.callId!) ?? 0)).slice(0, limit);
    for (const message of queue) {
      lastReplyCheck.set(message.callId!, Date.now());
      const call = await getManagedCall(message.callId!);
      const meta = call?.metadata as { appointment?: { appointmentId?: string; date?: string; time?: string; specialty?: string; test?: boolean }; whatsapp_reply?: unknown } | null | undefined;
      const appt = meta?.appointment;
      if (!call || meta?.whatsapp_reply || !appt?.appointmentId || !appt.date || !appt.time || appt.test) continue;
      if (appt.date < new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })) continue; // consulta já passou: não confirma
      if (await repo.isDoNotContact(message.phone)) continue;
      const anchor = message.body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 40);
      const replies = await readWhatsappReplies(message.phone, anchor).catch((error: unknown) => { console.error('[WHATSAPP] leitura da conversa falhou:', error instanceof Error ? error.message : error); return [] as string[]; });
      console.info('[WHATSAPP] respostas lidas', message.phone.slice(-4), replies.length);
      if (!replies.length) continue;
      const kinds = replies.map(classifyWhatsappReply);
      const stamp = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date()).replace(', ', ' às ');
      let outcome: 'confirmou' | 'other' | 'erro' = 'other';
      let note: string;
      if (kinds.every(kind => kind === 'yes')) {
        try {
          await ameiApplyOutcome({ appointmentId: appt.appointmentId, date: appt.date, time: appt.time }, 'confirmou', 'whatsapp');
          outcome = 'confirmou';
          const first = call.patientName.trim().split(/\s+/)[0] || call.patientName;
          const thanks = `Consulta confirmada com sucesso! ${first}, sua consulta de ${appt.specialty ?? ''} no dia ${dmy(appt.date)} às ${appt.time} está confirmada. Muito obrigada! — Clínica Amor Saúde`.replace(/\s{2,}/g, ' ');
          await queueWhatsapp({ callId: call.id, patientName: call.patientName, phone: message.phone, slug: null, body: thanks, source: 'ia' }).catch(() => undefined);
          note = `Respondeu "${replies[0]}" no WhatsApp (${stamp}): consulta de ${dmy(appt.date)} às ${appt.time} CONFIRMADA na AMEI pelo WhatsApp.`;
        } catch (error) {
          if (!(error instanceof AmeiError)) { console.error('[WHATSAPP] confirmação pela AMEI falhou, tento de novo depois:', error instanceof Error ? error.message : error); continue; }
          outcome = 'erro';
          note = `Respondeu "${replies[0]}" no WhatsApp (${stamp}), mas não consegui confirmar na AMEI: ${error.message}`;
        }
      } else {
        note = `Respondeu no WhatsApp (${stamp}): "${replies.join(' | ').slice(0, 300)}". Não confirmei sozinha; precisa de atenção.`;
      }
      const updated = await updateManagedCall(call, { metadata: { ...(call.metadata ?? {}), whatsapp_reply: { outcome, at: new Date().toISOString(), text: replies.join(' | ').slice(0, 300) } } });
      publish(updated);
      void repo.appendEvent(call.id, 'whatsapp.reply', { outcome, replies });
      await repo.aiUpdateContact(message.phone, { note }).catch(() => undefined);
      console.info('[WHATSAPP] resposta processada', call.id, outcome);
    }
  } catch (error) { console.error('[WHATSAPP] verificação de respostas falhou:', error instanceof Error ? error.message : error); }
  finally { replyCheckRunning = false; }
}
export function startWhatsappReplyWatcher(): void {
  if (process.env.NODE_ENV === 'test') return;
  // Ao ligar o servidor já passa por quem respondeu antes (até 7 dias), depois repete a cada 2 minutos.
  setTimeout(() => { void checkWhatsappReplies(80); }, 30_000).unref();
  setInterval(() => { void checkWhatsappReplies(); }, 2 * 60 * 1000).unref();
}


// ─── Esteira da Captação: liga um paciente atrás do outro da lista da busca, a partir de quem o operador escolher ──
export interface CaptacaoAutoStatus { active: boolean; current: string | null; currentCallId: string | null; remaining: number; calledCount: number; lastError: string | null; startedAt: string | null }
interface CaptacaoAutoState extends CaptacaoAutoStatus { brainId: string; queue: Array<{ id: string; mode: 'faltosos' | 'lista_espera' | 'cartao'; phone: string }>; }
let captacaoAuto: CaptacaoAutoState | null = null;
export function captacaoAutoStatus(): CaptacaoAutoStatus {
  if (!captacaoAuto) return { active: false, current: null, currentCallId: null, remaining: 0, calledCount: 0, lastError: null, startedAt: null };
  const { active, current, currentCallId, remaining, calledCount, lastError, startedAt } = captacaoAuto;
  return { active, current, currentCallId, remaining, calledCount, lastError, startedAt };
}
export function startCaptacaoAuto(brainId: string, jobId: string, startFrom?: { id: string; direction: 'up' | 'down' }): void {
  if (captacaoAuto?.active || autoConfirm?.active) throw new PublicError(409, 'A esteira já está ligando sozinha.');
  if (!brainId) throw new PublicError(400, 'Selecione um cérebro.');
  let rows;
  try { rows = getCampaignSearch(jobId).results; }
  catch (error) { throw new PublicError(409, error instanceof AmeiError ? error.message : 'Busca não encontrada; faça a busca de novo.'); }
  // Mesma ordem da tela: "de cima pra baixo" segue a lista a partir do escolhido; "de baixo pra cima" começa nele e sobe.
  if (startFrom) {
    const anchor = rows.findIndex(row => row.id === startFrom.id);
    if (anchor >= 0) rows = startFrom.direction === 'up' ? rows.slice(0, anchor + 1).reverse() : rows.slice(anchor);
  }
  const queue = rows.filter(row => row.phone.length >= 10).map(row => ({ id: row.id, mode: row.mode, phone: row.phone }));
  if (!queue.length) throw new PublicError(409, 'Nenhum paciente na lista para ligar.');
  captacaoAuto = { active: true, brainId, queue, current: null, currentCallId: null, remaining: queue.length, calledCount: 0, lastError: null, startedAt: new Date().toISOString() };
  void runCaptacaoAuto(captacaoAuto);
}
export function stopCaptacaoAuto(): void { if (captacaoAuto) captacaoAuto.active = false; }
async function runCaptacaoAuto(state: CaptacaoAutoState): Promise<void> {
  while (state.active && state.queue.length) {
    const next = state.queue.shift()!;
    state.remaining = state.queue.length;
    state.current = next.id;
    try {
      const call = next.mode === 'faltosos' ? await startMissedCall(state.brainId, next.id) : next.mode === 'cartao' ? await startCardCall(state.brainId, next.id) : await startWaitlistCall(state.brainId, next.id);
      state.currentCallId = call.id; state.calledCount++; state.lastError = null;
      await waitForCallId(call.id);
    } catch (error) { state.lastError = error instanceof Error ? error.message : 'Não foi possível ligar.'; }   // ex.: já ligou há pouco, já reagendou: pula pro próximo
    state.current = null; state.currentCallId = null;
    if (!state.active) break;
    await new Promise(resolve => setTimeout(resolve, state.lastError ? ESTEIRA_PAUSE_AFTER_ERROR_MS : ESTEIRA_PAUSE_MS));
  }
  state.active = false; state.current = null; state.currentCallId = null;
}


// ─── Agendamento pela Giovana (Fase 1): ela propõe, o operador aprova no painel, o sistema agenda na AMEI ──
/** Especialidades que ela pode propor agendar (BOOKING_SPECIALTIES, separadas por vírgula; padrão: Clínico Geral = "Clínica médica"). */
const bookingNorm = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export function bookingSpecialties(): string[] {
  return (process.env.BOOKING_SPECIALTIES ?? 'clinica medica').split(',').map(bookingNorm).filter(Boolean);
}
const BOOKING_WAIT_MS = 80_000;
export interface BookingProposalView { status: 'pending' | 'booking' | 'booked' | 'rejected' | 'expired' | 'failed'; patient: string; specialty: string; professional: string; date: string; time: string; partner: string; procedure: string; local: string; price: number; appointmentId?: string; message?: string; at: string }
interface PendingBooking { plan: BookingPlan; decide: (decision: 'approve' | 'reject') => void }
const pendingBookings = new Map<string, PendingBooking>();

async function setBookingView(callId: string, view: BookingProposalView): Promise<void> {
  const current = await getManagedCall(callId);
  if (!current) return;
  publish(await updateManagedCall(current, { metadata: { ...(current.metadata || {}), booking_proposal: view } }));
}
const bookingViewOf = (plan: BookingPlan, status: BookingProposalView['status'], extra: Partial<BookingProposalView> = {}): BookingProposalView => ({
  status, patient: (plan.patientName.split(' ')[0] ?? '').replace(/^./, c => c.toLocaleUpperCase('pt-BR')), specialty: plan.specialty, professional: plan.professional, date: plan.date, time: plan.time,
  partner: plan.partner, procedure: plan.procedure, local: plan.local, price: plan.price, at: new Date().toISOString(), ...extra,
});

/** O operador clicou em Agendar ou Recusar no painel. */
export function decideBooking(callId: string, decision: 'approve' | 'reject'): void {
  const pending = pendingBookings.get(callId);
  if (!pending) throw new PublicError(409, 'Não há agendamento aguardando aprovação nesta ligação (pode ter expirado).');
  pending.decide(decision);
}

/** Ferramenta agendar_consulta: valida na AMEI, mostra a proposta no painel e espera o operador. */
async function requestBooking(callId: string, phone: string, appointment: AppointmentContext | undefined, params: Record<string, unknown>): Promise<string> {
  if (appointment?.test) return 'TESTE: esta ligação é fictícia, nada foi agendado. Diga ao paciente que a equipe confirma o horário e siga o roteiro.';
  if (pendingBookings.has(callId)) return 'Já existe um agendamento aguardando aprovação nesta ligação. Aguarde.';
  const especialidade = cleanToolText(params.especialidade, 80), data = cleanToolText(params.data, 20), horario = cleanToolText(params.horario, 10);
  if (!especialidade || !data || !horario) return 'Informe especialidade, data e horário do horário que o paciente escolheu.';
  const fallback = 'Diga com naturalidade que o Marcos confirma o horário com ele (chame registrar_faltoso com resultado="remarcar_horario" e horario_escolhido) e NÃO diga que agendou.';
  let plan: BookingPlan;
  try {
    const target = await ameiResolveBooking({ especialidade, profissional: cleanToolText(params.profissional, 80), data, horario });
    if (!bookingSpecialties().includes(bookingNorm(target.specialty))) return `Por enquanto você não agenda ${target.specialty} sozinha. ${fallback}`;
    const cpf = await ameiCpfForContext({ appointmentId: appointment?.appointmentId, patientId: appointment?.patientId });
    plan = await ameiPrepareBooking({ ...target, cpf });
  } catch (error) {
    console.error('[AGENDAMENTO] preparação falhou:', error instanceof Error ? error.message : error);
    await repo.appendEvent(callId, 'ai.booking_unavailable', { reason: error instanceof Error ? error.message : 'erro' });
    return `Não consegui reservar esse horário${error instanceof AmeiError ? ` (${error.message})` : ''}. Peça desculpas, ofereça outro horário da lista ou, se não der, ${fallback}`;
  }
  await repo.appendEvent(callId, 'ai.booking_proposed', { date: plan.date, time: plan.time, specialty_id: plan.specialtyId, professional_id: plan.professionalId });
  const decision = await new Promise<'approve' | 'reject' | 'timeout'>(resolve => {
    const timer = setTimeout(() => { pendingBookings.delete(callId); resolve('timeout'); }, BOOKING_WAIT_MS);
    pendingBookings.set(callId, { plan, decide: d => { clearTimeout(timer); pendingBookings.delete(callId); resolve(d); } });
    void setBookingView(callId, bookingViewOf(plan, 'pending')).catch(() => undefined);
  });
  if (decision === 'timeout') {
    await setBookingView(callId, bookingViewOf(plan, 'expired')).catch(() => undefined);
    return `Ninguém aprovou a tempo. Diga que o Marcos confirma o horário em instantes; ${fallback}`;
  }
  if (decision === 'reject') {
    await setBookingView(callId, bookingViewOf(plan, 'rejected')).catch(() => undefined);
    await repo.appendEvent(callId, 'ai.booking_rejected', {});
    return `O Marcos não aprovou esse horário. Peça desculpas, ofereça outro horário da lista ou diga que ele confirma depois (${fallback})`;
  }
  await setBookingView(callId, bookingViewOf(plan, 'booking')).catch(() => undefined);
  try {
    const result = await ameiBook(plan, 'Agendado pela assistente virtual Giovana (IA), aprovado pela equipe.');
    await setBookingView(callId, bookingViewOf(plan, 'booked', { appointmentId: result.appointmentId })).catch(() => undefined);
    await repo.appendEvent(callId, 'ai.booking_done', { appointment_id: result.appointmentId });
    const when = `${plan.date.split('-').reverse().join('/')} às ${plan.time}`;
    await repo.aiUpdateContact(phone, { note: `Agendado pela Giovana: ${plan.specialty}, ${when}, com ${plan.professional} (${plan.partner}, R$ ${plan.price}).` }).catch(() => undefined);
    const current = await getManagedCall(callId);
    if (current) publish(await updateManagedCall(current, { result: 'interested' }));
    return `AGENDADO com sucesso: ${plan.specialty}, ${spokenLongDay(plan.date)}, às ${spokenClock(plan.time)}, com ${plan.professional}, ${plan.local}. Valor: ${spokenMoney(String(plan.price)) || 'conforme a tabela'} (${plan.partner}). Confirme isso ao paciente em frases curtas, pergunte se precisa de mais alguma coisa e depois se despeça uma única vez e encerre com end_call.`;
  } catch (error) {
    console.error('[AGENDAMENTO] falhou:', error instanceof Error ? error.message : error);
    await setBookingView(callId, bookingViewOf(plan, 'failed', { message: error instanceof Error ? error.message : 'Erro ao agendar.' })).catch(() => undefined);
    await repo.appendEvent(callId, 'ai.booking_failed', { reason: error instanceof Error ? error.message : 'erro' });
    return `Não consegui concluir o agendamento${error instanceof AmeiError ? ` (${error.message})` : ''}. NÃO diga que agendou. ${fallback}`;
  }
}
