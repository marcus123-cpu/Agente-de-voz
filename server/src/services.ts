import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from './config.js';
import * as repo from './repository.js';
import { cvortexReady, startCvortexCall, endCvortexCall, takeoverCvortexCall } from './cvortex-provider.js';
import { publishLive } from './live.js';
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
export async function startCall(brainId: string, patientName: string, rawPhone: string, contactContext: 'not_informed' | 'recent_card_member' = 'not_informed'): Promise<Call> {
  if (!brainId || !patientName?.trim() || patientName.length > 120 || !rawPhone) throw new PublicError(400,'Informe cérebro, nome e telefone válidos.');
  if (!['not_informed','recent_card_member'].includes(contactContext)) throw new PublicError(400,'Origem do contato inválida.');
  const phone = normalizePhone(rawPhone);
  const brain = await repo.getBrain(brainId);
  if (!brain?.isActive) throw new PublicError(404,'Cérebro de IA não encontrado ou inativo.');
  const agentId = brain.elevenlabsAgentId || (brain.slug === 'patient-acquisition' ? config.elevenLabsAgentId : '');
  if (!config.elevenLabsKey || !agentId) throw new PublicError(503,'Agente ElevenLabs não configurado.');
  if (!(await cvortexReady())) throw new PublicError(503,'Abra e autentique o webphone cVortex no perfil isolado antes de discar.');
  if (await repo.isDoNotContact(phone)) throw new PublicError(409,'Este contato solicitou não receber novos contatos.');
  let call = await repo.createCall({brain_id:brainId,patient_name:patientName.trim(),phone,provider:'cvortex',status:'connecting',started_at:new Date().toISOString(),result:'unknown',metadata:{contact_context:contactContext}});
  console.info(`[CALL] Starting ${brain.slug} -> ${mask(phone)}`);
  try {
    await startCvortexCall({
      callId:call.id, phone, patientName:patientName.trim(), contactContext, agentId,
      onStatus:(status)=>{ void updateStatus(call,status).catch(error=>console.error('[CALL] status callback failed',error)); },
      onAgentConnected:()=>{ void getManagedCall(call.id).then(current=>current && !current.metadata?.human_takeover ? updateManagedCall(current,{metadata:{...(current.metadata||{}),ai_connected:true}}) : null).then(updated=>{if(updated)publish(updated);}).catch(error=>console.error('[CALL] agent callback failed',error)); },
      onConversationId:(id)=>{ void getManagedCall(call.id).then(current=>current && updateManagedCall(current,{elevenlabs_conversation_id:id})).then(updated=>{if(updated)publish(updated);}).catch(error=>console.error('[CALL] conversation callback failed',error)); },
      onEnded:(status)=>{ void updateStatus(call,status).catch(error=>console.error('[CALL] end callback failed',error)); },
      onAudio:(source,pcm)=>publishLive(call.id,{kind:'audio',source,pcm}),
      onText:(role,text,correction)=>{ const clean=text.replace(/\[[^\]]{1,40}\]/g,'').replace(/\s{2,}/g,' ').trim(); if(clean) publishLive(call.id,{kind:'text',role,text:clean,correction}); },
      onFlush:()=>publishLive(call.id,{kind:'flush'}),
    });
  }
  catch(error) {
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
