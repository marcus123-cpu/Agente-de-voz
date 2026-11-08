import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { Brain, Call, CallResult, Contact, ContactSource, MessageTemplate, WhatsappMessage } from './types.js';

const db = config.supabaseUrl && config.supabaseServiceKey
  ? createClient(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false } }) : null;
export function databaseConfigured(): boolean { return db !== null; }
function database() { if (!db) throw new Error('Supabase não configurado'); return db; }
const brainFields = 'id,name,slug,description,objective,system_prompt,elevenlabs_agent_id,voice_name,is_active';
const callFields = 'id,brain_id,patient_name,phone,status,provider,cvortex_call_id,elevenlabs_conversation_id,started_at,answered_at,ended_at,duration_seconds,result,transfer_requested,summary,metadata,created_at';
type Row = Record<string, unknown>;
function brain(row: Row): Brain { return { id: String(row.id), name: String(row.name), slug: String(row.slug), description: row.description as string | null, objective: row.objective as string | null, systemPrompt: row.system_prompt as string | null, elevenlabsAgentId: row.elevenlabs_agent_id as string | null, voiceName: row.voice_name as string | null, isActive: Boolean(row.is_active) }; }
function call(row: Row): Call { return { id: String(row.id), brainId: String(row.brain_id), patientName: String(row.patient_name), phone: String(row.phone), status: row.status as Call['status'], provider: 'cvortex', cvortexCallId: row.cvortex_call_id as string | null, elevenlabsConversationId: row.elevenlabs_conversation_id as string | null, startedAt: row.started_at as string | null, answeredAt: row.answered_at as string | null, endedAt: row.ended_at as string | null, durationSeconds: row.duration_seconds as number | null, result: row.result as Call['result'], transferRequested: Boolean(row.transfer_requested), summary: row.summary as Call['summary'], metadata: row.metadata as Call['metadata'], createdAt: String(row.created_at) }; }
function unwrap<T>(data: T | null, error: { message: string } | null): T { if (error) throw new Error(error.message); if (data === null) throw new Error('Registro não encontrado'); return data; }
export async function listBrains(): Promise<Brain[]> { const {data,error}=await database().from('brains').select(brainFields).order('name'); return unwrap(data,error).map(brain); }
export async function getBrain(id: string): Promise<Brain | null> { const {data,error}=await database().from('brains').select(brainFields).eq('id',id).maybeSingle(); if(error) throw new Error(error.message); return data ? brain(data) : null; }
export async function createBrain(values: Row): Promise<Brain> { const {data,error}=await database().from('brains').insert(values).select(brainFields).single(); return brain(unwrap(data,error)); }
export async function updateBrain(id: string, changes: Row): Promise<Brain> { const {data,error}=await database().from('brains').update(changes).eq('id',id).select(brainFields).single(); return brain(unwrap(data,error)); }
export async function listCalls(): Promise<Call[]> { const {data,error}=await database().from('calls').select(callFields).order('created_at',{ascending:false}).limit(100); return unwrap(data,error).map(call); }
export async function getCall(id: string): Promise<Call | null> { const {data,error}=await database().from('calls').select(callFields).eq('id',id).maybeSingle(); if(error) throw new Error(error.message); return data ? call(data) : null; }
export async function getCallByCvortexId(id: string): Promise<Call | null> { const {data,error}=await database().from('calls').select(callFields).eq('cvortex_call_id',id).maybeSingle(); if(error) throw new Error(error.message); return data ? call(data) : null; }
export async function getCallByConversationId(id: string): Promise<Call | null> { const {data,error}=await database().from('calls').select(callFields).eq('elevenlabs_conversation_id',id).maybeSingle(); if(error) throw new Error(error.message); return data ? call(data) : null; }
export async function createCall(values: Row): Promise<Call> { const {data,error}=await database().from('calls').insert(values).select(callFields).single(); return call(unwrap(data,error)); }
export async function updateCall(id: string, values: Row): Promise<Call> { const {data,error}=await database().from('calls').update(values).eq('id',id).select(callFields).single(); return call(unwrap(data,error)); }
export async function appendEvent(callId: string, eventType: string, payload: Row): Promise<void> { const {error}=await database().from('call_events').insert({call_id:callId,event_type:eventType,payload}); if(error) console.error('[EVENT]',error.message); }
export async function isDoNotContact(phone: string): Promise<boolean> { const {data,error}=await database().from('contacts').select('do_not_contact').eq('phone',phone).maybeSingle(); if(error) throw new Error(error.message); return Boolean(data?.do_not_contact); }
export async function setDoNotContact(name: string, phone: string): Promise<void> { const {error}=await database().from('contacts').upsert({name,phone,do_not_contact:true},{onConflict:'phone'}); if(error) throw new Error(error.message); }

const contactFields = 'id,name,phone,do_not_contact,source,notes,created_at';
export async function listContacts(): Promise<Contact[]> {
  const { data, error } = await database().from('contacts').select(contactFields).order('created_at', { ascending: false }).limit(5000);
  const rows = unwrap(data, error);
  const { data: callRows, error: callError } = await database().from('calls').select('phone,created_at,result').order('created_at', { ascending: false }).limit(5000);
  if (callError) throw new Error(callError.message);
  const byPhone = new Map<string, { last: string; result: CallResult | null; count: number }>();
  for (const c of callRows ?? []) {
    const key = String(c.phone); const current = byPhone.get(key);
    if (current) current.count += 1; else byPhone.set(key, { last: String(c.created_at), result: (c.result as CallResult | null) ?? null, count: 1 });
  }
  return rows.map((row) => contact(row, byPhone.get(String(row.phone))));
}
export async function createContact(values: { name: string; phone: string; source: ContactSource; notes: string | null }): Promise<Contact> {
  const { data, error } = await database().from('contacts').insert(values).select(contactFields).single();
  if (error?.code === '23505') throw new Error('DUPLICADO');
  return contact(unwrap(data, error));
}
export async function updateContact(id: string, changes: Row): Promise<Contact> {
  const { data, error } = await database().from('contacts').update(changes).eq('id', id).select(contactFields).single();
  return contact(unwrap(data, error));
}
export async function deleteContact(id: string): Promise<void> { const { error } = await database().from('contacts').delete().eq('id', id); if (error) throw new Error(error.message); }
/** Importa em lote ignorando telefones que já existem. Retorna quantos entraram. */
export async function importContacts(rows: { name: string; phone: string; source: ContactSource }[]): Promise<number> {
  if (!rows.length) return 0;
  const { data, error } = await database().from('contacts').upsert(rows, { onConflict: 'phone', ignoreDuplicates: true }).select('id');
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
function contact(row: Row, stats?: { last: string; result: CallResult | null; count: number }): Contact {
  return { id: String(row.id), name: String(row.name), phone: String(row.phone), doNotContact: Boolean(row.do_not_contact), source: row.source as ContactSource, notes: (row.notes as string | null) ?? null, createdAt: String(row.created_at), lastCallAt: stats?.last ?? null, lastResult: stats?.result ?? null, callCount: stats?.count ?? 0 };
}

/** A IA só mexe no contato da própria ligação: acrescenta uma anotação datada (sem apagar nada) e, se pedido, corrige o nome ou marca "não contatar". */
export async function aiUpdateContact(phone: string, changes: { note?: string; name?: string; doNotContact?: boolean }): Promise<string> {
  const { data, error } = await database().from('contacts').select('id,name,notes').eq('phone', phone).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Contato não encontrado.');
  const update: Row = {};
  const done: string[] = [];
  if (changes.note) {
    const stamp = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date());
    const line = `[IA ${stamp}] ${changes.note}`;
    const merged = [data.notes as string | null, line].filter(Boolean).join('\n');
    update.notes = merged.length > NOTES_MAX ? merged.slice(merged.length - NOTES_MAX).replace(/^[^\n]*\n/, '') : merged;
    done.push('anotação');
  }
  if (changes.name) { update.name = changes.name; done.push('nome'); }
  if (changes.doNotContact === true) { update.do_not_contact = true; done.push('não contatar'); }
  if (!done.length) return 'Nada para salvar.';
  const { error: upError } = await database().from('contacts').update(update).eq('id', data.id);
  if (upError) throw new Error(upError.message);
  return `Salvo: ${done.join(', ')}.`;
}
export const NOTES_MAX = 4000;

const templateFields = 'id,slug,name,when_to_use,body,is_active';
function template(row: Row): MessageTemplate { return { id: String(row.id), slug: String(row.slug), name: String(row.name), whenToUse: String(row.when_to_use ?? ''), body: String(row.body), isActive: Boolean(row.is_active) }; }
export async function listTemplates(): Promise<MessageTemplate[]> { const { data, error } = await database().from('message_templates').select(templateFields).order('created_at'); return unwrap(data, error).map(template); }
export async function getTemplateBySlug(slug: string): Promise<MessageTemplate | null> { const { data, error } = await database().from('message_templates').select(templateFields).eq('slug', slug).maybeSingle(); if (error) throw new Error(error.message); return data ? template(data) : null; }
export async function getTemplate(id: string): Promise<MessageTemplate | null> { const { data, error } = await database().from('message_templates').select(templateFields).eq('id', id).maybeSingle(); if (error) throw new Error(error.message); return data ? template(data) : null; }
export async function createTemplate(values: { slug: string; name: string; when_to_use: string; body: string; is_active: boolean }): Promise<MessageTemplate> {
  const { data, error } = await database().from('message_templates').insert(values).select(templateFields).single();
  if (error?.code === '23505') throw new Error('DUPLICADO');
  return template(unwrap(data, error));
}
export async function updateTemplate(id: string, changes: Row): Promise<MessageTemplate> { const { data, error } = await database().from('message_templates').update(changes).eq('id', id).select(templateFields).single(); return template(unwrap(data, error)); }
export async function deleteTemplate(id: string): Promise<void> { const { error } = await database().from('message_templates').delete().eq('id', id); if (error) throw new Error(error.message); }

const messageFields = 'id,call_id,template_slug,patient_name,phone,body,source,status,error,created_at,sent_at';
function message(row: Row): WhatsappMessage { return { id: String(row.id), callId: (row.call_id as string | null) ?? null, templateSlug: (row.template_slug as string | null) ?? null, patientName: (row.patient_name as string | null) ?? null, phone: String(row.phone), body: String(row.body), source: row.source as WhatsappMessage['source'], status: row.status as WhatsappMessage['status'], error: (row.error as string | null) ?? null, createdAt: String(row.created_at), sentAt: (row.sent_at as string | null) ?? null }; }
export async function logMessage(values: { call_id: string | null; template_slug: string | null; patient_name: string | null; phone: string; body: string; source: 'ia' | 'teste' }): Promise<string> {
  const { data, error } = await database().from('whatsapp_messages').insert(values).select('id').single();
  return String(unwrap(data, error).id);
}
export async function updateMessage(id: string, values: { status: 'sent' | 'failed'; error?: string | null }): Promise<void> {
  const { error } = await database().from('whatsapp_messages').update({ status: values.status, error: values.error ?? null, sent_at: values.status === 'sent' ? new Date().toISOString() : null }).eq('id', id);
  if (error) console.error('[WHATSAPP]', error.message);
}
export async function listMessages(limit = 100): Promise<WhatsappMessage[]> { const { data, error } = await database().from('whatsapp_messages').select(messageFields).order('created_at', { ascending: false }).limit(limit); return unwrap(data, error).map(message); }
