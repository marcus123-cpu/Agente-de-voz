import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { Brain, Call } from './types.js';

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
