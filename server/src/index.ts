import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { clearSession, hasSession, passwordMatches, requireSession, setSession } from './auth.js';
import * as repo from './repository.js';
import { CallEventsService } from './monitor.js';
import { cvortexConnectionStatus, cvortexReady, openCvortexBrowser } from './cvortex-provider.js';
import { connectElevenLabs, connectionDetails, disconnectElevenLabs } from './connections.js';
import { PublicError, endCall, getManagedCall, getManagedCallByConversationId, listManagedCalls, saveResult, startCall, syncCall, takeoverCall, updateStatus } from './services.js';
import type { CallResult } from './types.js';

const app=express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({origin:config.frontendUrl,credentials:true}));
function wrap(fn:(req:Request,res:Response)=>Promise<void>) { return (req:Request,res:Response,next:NextFunction)=>{fn(req,res).catch(next);}; }
function sameOrigin(req:Request,res:Response,next:NextFunction) {
  if(['POST','PATCH','PUT','DELETE'].includes(req.method) && req.headers.origin && req.headers.origin!==config.frontendUrl) {res.status(403).json({error:'Origem não autorizada.'});return;}
  next();
}
function requireCall(call: Awaited<ReturnType<typeof repo.getCall>>) { if(!call) throw new PublicError(404,'Ligação não encontrada.'); return call; }
function idParam(req:Request):string { const id=req.params.id; if(!id)throw new PublicError(400,'ID inválido.'); return id; }
app.use(sameOrigin);
app.get('/api/health',(_req,res)=>res.json({status:'ok'}));
app.post('/api/auth/login',express.json({limit:'8kb'}),rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false}), (req,res)=>{
  if(typeof req.body?.password!=='string' || !passwordMatches(req.body.password)) {res.status(401).json({error:'Senha incorreta.'});return;}
  setSession(res); res.json({authenticated:true});
});
app.get('/api/auth/session',(req,res)=>res.json({authenticated:hasSession(req.headers.cookie)}));
app.post('/api/auth/logout',requireSession,(_req,res)=>{clearSession(res);res.json({authenticated:false});});

app.post('/api/webhooks/elevenlabs',express.raw({type:'application/json',limit:'1mb'}),wrap(async(req,res)=>{
  const header=String(req.headers['elevenlabs-signature']||'');
  const parts=Object.fromEntries(header.split(',').map(part=>part.trim().split('=',2)));
  const timestamp=parts.t; const mac=parts.v0;
  if(!config.elevenLabsWebhookSecret || !timestamp || !mac || Math.abs(Date.now()-Number(timestamp)*1000)>30*60*1000 || !Buffer.isBuffer(req.body)) {res.status(401).end();return;}
  const expected=createHmac('sha256',config.elevenLabsWebhookSecret).update(`${timestamp}.${req.body.toString('utf8')}`).digest('hex');
  if(mac.length!==expected.length || !timingSafeEqual(Buffer.from(mac),Buffer.from(expected))) {res.status(401).end();return;}
  const event=JSON.parse(req.body.toString('utf8')) as {type?:string;data?:{conversation_id?:string;analysis?:{transcript_summary?:string};failure_reason?:string}};
  const conversationId=event.data?.conversation_id;
  if(conversationId) {
    const call=await getManagedCallByConversationId(conversationId);
    if(call) {
      if(event.type==='post_call_transcription') {
        const summary=event.data?.analysis?.transcript_summary;
        if(typeof summary==='string' && summary.trim()) await repo.updateCall(call.id,{summary:{transcript_summary:summary.slice(0,4000)}});
        if (!call.metadata?.human_takeover) await updateStatus(call,'completed');
      } else if(event.type==='call_initiation_failure') {
        const reason=event.data?.failure_reason;
        if (!call.metadata?.human_takeover) await updateStatus(call,reason==='busy'?'busy':reason==='no-answer'?'no_answer':'failed');
      }
    }
  }
  res.json({received:true});
}));

app.use('/api',requireSession);
app.use('/api',express.json({limit:'64kb'}));
app.use('/api',rateLimit({windowMs:60*1000,limit:120,standardHeaders:'draft-7',legacyHeaders:false}));
app.get('/api/connections',wrap(async(_req,res)=>{res.json(await connectionDetails());}));
app.post('/api/connections/cvortex/open',wrap(async(_req,res)=>{await openCvortexBrowser();res.json({opening:true});}));
app.put('/api/connections/elevenlabs',wrap(async(req,res)=>{
  if((await cvortexConnectionStatus()).activeCall)throw new PublicError(409,'Encerre a ligação ativa antes de trocar a chave.');
  const key=req.body?.apiKey;
  if(typeof key!=='string')throw new PublicError(400,'Informe uma chave de API.');
  try {await connectElevenLabs(key);} catch(error) {throw new PublicError(400,error instanceof Error?error.message:'Não foi possível validar a chave.');}
  res.json(await connectionDetails());
}));
app.delete('/api/connections/elevenlabs',wrap(async(_req,res)=>{
  if((await cvortexConnectionStatus()).activeCall)throw new PublicError(409,'Encerre a ligação ativa antes de remover a chave.');
  await disconnectElevenLabs();res.json(await connectionDetails());
}));
app.get('/api/brains',wrap(async(_req,res)=>{res.json({brains:await repo.listBrains()});}));
app.post('/api/brains',wrap(async(req,res)=>{
  const body=req.body as Record<string,unknown>;
  const name=typeof body.name==='string'?body.name.trim():'';
  if(!name || name.length>120)throw new PublicError(400,'Informe um nome de até 120 caracteres.');
  const fields:Record<string,unknown>={name,slug:`custom-${randomUUID()}`,is_active:false};
  for(const [api,db] of Object.entries({description:'description',objective:'objective',systemPrompt:'system_prompt',elevenlabsAgentId:'elevenlabs_agent_id',voiceName:'voice_name'})) {
    const value=body[api]; if(value===undefined)continue;
    if(typeof value!=='string'||value.length>12000)throw new PublicError(400,'Dados do cérebro inválidos.');
    fields[db]=db==='elevenlabs_agent_id'||db==='voice_name' ? value.trim()||null : value.trim();
  }
  if(body.isActive!==undefined){if(typeof body.isActive!=='boolean')throw new PublicError(400,'Status inválido.');fields.is_active=body.isActive;}
  if(fields.is_active && !fields.elevenlabs_agent_id)throw new PublicError(400,'Informe o Agent ID da ElevenLabs para ativar o cérebro.');
  res.status(201).json({brain:await repo.createBrain(fields)});
}));
app.get('/api/brains/:id',wrap(async(req,res)=>{const brain=await repo.getBrain(idParam(req));if(!brain)throw new PublicError(404,'Cérebro não encontrado.');res.json({brain});}));
app.patch('/api/brains/:id',wrap(async(req,res)=>{
  const body=req.body as Record<string,unknown>;
  const fields:Record<string,unknown>={};
  for(const [api,db] of Object.entries({name:'name',description:'description',objective:'objective',systemPrompt:'system_prompt',elevenlabsAgentId:'elevenlabs_agent_id',voiceName:'voice_name',isActive:'is_active'})) {
    const value=body[api]; if(value===undefined)continue;
    if(api==='isActive') {if(typeof value!=='boolean')throw new PublicError(400,'Status inválido.');}
    else if(typeof value!=='string' || value.length>12000)throw new PublicError(400,'Dados do cérebro inválidos.');
    fields[db]=value;
  }
  if(!Object.keys(fields).length)throw new PublicError(400,'Nenhuma alteração enviada.');
  if(fields.is_active===true) {
    const current=await repo.getBrain(idParam(req));
    if(!current)throw new PublicError(404,'Cérebro não encontrado.');
    if(!(fields.elevenlabs_agent_id || current.elevenlabsAgentId))throw new PublicError(400,'Informe o Agent ID da ElevenLabs para ativar o cérebro.');
  }
  res.json({brain:await repo.updateBrain(idParam(req),fields)});
}));
app.get('/api/calls',wrap(async(_req,res)=>{res.json({calls:await listManagedCalls()});}));
app.post('/api/calls',wrap(async(req,res)=>{
  const {brainId,patientName,phone,contactContext='not_informed'}=req.body as {brainId?:string;patientName?:string;phone?:string;contactContext?:'not_informed'|'recent_card_member'};
  if(typeof brainId!=='string'||typeof patientName!=='string'||typeof phone!=='string')throw new PublicError(400,'Informe cérebro, nome e telefone.');
  const call=await startCall(brainId,patientName,phone,contactContext);res.status(201).json({success:true,call});
}));
app.get('/api/calls/:id',wrap(async(req,res)=>{res.json({call:await syncCall(requireCall(await getManagedCall(idParam(req))))});}));
app.post('/api/calls/:id/end',wrap(async(req,res)=>{res.json({call:await endCall(requireCall(await getManagedCall(idParam(req))))});}));
app.post('/api/calls/:id/takeover',wrap(async(req,res)=>{res.json({call:await takeoverCall(requireCall(await getManagedCall(idParam(req))))});}));
app.patch('/api/calls/:id/result',wrap(async(req,res)=>{
  const {result,note}=req.body as {result?:CallResult;note?:string};
  if(typeof result!=='string' || (note!==undefined && typeof note!=='string'))throw new PublicError(400,'Resultado inválido.');
  res.json({call:await saveResult(requireCall(await getManagedCall(idParam(req))),result,note)});
}));
app.get('/api/settings/status',wrap(async(_req,res)=>{res.json({elevenlabs:Boolean(config.elevenLabsKey),cvortex:await cvortexReady(),database:repo.databaseConfigured(),n8n:Boolean(config.enableN8n&&config.n8nUrl),liveMonitoring:true,browserTakeover:true});}));
app.get('/api/integrations/status',wrap(async(_req,res)=>{res.json({database:repo.databaseConfigured(),elevenlabs:Boolean(config.elevenLabsKey),cvortex:await cvortexReady(),n8n:Boolean(config.enableN8n&&config.n8nUrl),liveMonitoring:true,browserTakeover:true});}));
app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  console.error('[API]',error);
  if(error instanceof PublicError)res.status(error.statusCode).json({error:error.message});
  else res.status(500).json({error:'Não foi possível concluir a operação. Tente novamente.'});
});

const server=createServer(app);
const events=new CallEventsService();
server.on('upgrade',(req,socket,head)=>{events.upgrade(req,socket,head).catch(error=>{console.error('[WS]',error);socket.destroy();});});
server.listen(config.port,()=>console.info(`[API] listening on ${config.port}`));
