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
import { openWhatsapp, whatsappStatus } from './whatsapp.js';
import { ameiStatus, ameiApplyOutcome, openAmei, ameiConfirmList, ameiConfirmOptions, ameiProfessionalsOf, ameiRecoveryStatusOf, startCampaignSearch, getCampaignSearch, type CampaignMode, type MissedSituations, AmeiError } from './amei.js';
import { connectElevenLabs, connectionDetails, disconnectElevenLabs } from './connections.js';
import { PublicError, startWhatsappReplyWatcher, startConfirmationCall, startTestConfirmationCall, startMissedCall, startWaitlistCall, startCardCall, startTestMissedCall, startTestWaitlistCall, startAutoConfirm, startCaptacaoAuto, decideBooking, stopCaptacaoAuto, captacaoAutoStatus, stopAutoConfirm, autoConfirmStatus, normalizePhone, sendTestWhatsapp, endCall, getCallAudio, getCallTranscript, getManagedCall, getManagedCallByConversationId, listManagedCalls, markCallAnswered, markCallVoicemail, saveResult, startCall, syncCall, takeoverCall, updateStatus } from './services.js';
import type { CallResult, ContactSource } from './types.js';

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
  const event=JSON.parse(req.body.toString('utf8')) as {type?:string;data?:{conversation_id?:string;analysis?:{transcript_summary?:string};failure_reason?:string;metadata?:{features_usage?:{voicemail_detection?:{used?:boolean}}}}};
  const conversationId=event.data?.conversation_id;
  if(conversationId) {
    const call=await getManagedCallByConversationId(conversationId);
    if(call) {
      if(event.type==='post_call_transcription') {
        const summary=event.data?.analysis?.transcript_summary;
        if(typeof summary==='string' && summary.trim()) await repo.updateCall(call.id,{summary:{transcript_summary:summary.slice(0,4000)}});
        if (!call.metadata?.human_takeover) {
          const voicemail=event.data?.metadata?.features_usage?.voicemail_detection?.used===true;
          await updateStatus(call,voicemail?'voicemail':'completed');
        }
      } else if(event.type==='call_initiation_failure') {
        const reason=event.data?.failure_reason;
        if (!call.metadata?.human_takeover) await updateStatus(call,reason==='busy'?'busy':reason==='no-answer'?'no_answer':'failed');
      }
    }
  }
  res.json({received:true});
}));

app.use('/api',requireSession);
app.post('/api/contacts/import',express.json({limit:'2mb'}),wrap(async(req,res)=>{
  const {rows}=req.body as {rows?:unknown};
  if(!Array.isArray(rows)||rows.length===0||rows.length>5000)throw new PublicError(400,'Envie de 1 a 5000 linhas.');
  const valid=new Map<string,{name:string;phone:string;source:ContactSource}>();const invalid:{line:number;reason:string}[]=[];
  rows.forEach((row:unknown,index:number)=>{
    const r=row as {name?:unknown;phone?:unknown};
    try{if(typeof r?.phone!=='string')throw new Error('sem telefone');const phone=normalizePhone(r.phone);const name=typeof r.name==='string'&&r.name.trim()?cleanName(r.name):'Sem nome';valid.set(phone,{name,phone,source:'planilha'});}
    catch{invalid.push({line:index+1,reason:'telefone ou nome inválido'});}
  });
  const imported=await repo.importContacts([...valid.values()]);
  res.json({imported,duplicates:valid.size-imported,invalid:invalid.slice(0,50),invalidCount:invalid.length});
}));
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
const contactSources=['manual','planilha','cartao_de_todos','ligacao'] as const;
function cleanName(value:unknown):string { const name=typeof value==='string'?value.trim().replace(/\s+/g,' '):''; if(!name||name.length>120)throw new PublicError(400,'Informe um nome de até 120 caracteres.'); return name; }
function cleanSource(value:unknown,fallback:ContactSource='manual'):ContactSource { if(value===undefined)return fallback; if(typeof value==='string'&&(contactSources as readonly string[]).includes(value))return value as ContactSource; throw new PublicError(400,'Origem inválida.'); }
app.get('/api/contacts',wrap(async(_req,res)=>{res.json({contacts:await repo.listContacts()});}));
app.post('/api/contacts',wrap(async(req,res)=>{
  const {name,phone,source,notes}=req.body as {name?:unknown;phone?:unknown;source?:unknown;notes?:unknown};
  if(typeof phone!=='string')throw new PublicError(400,'Informe o telefone.');
  if(notes!==undefined&&notes!==null&&(typeof notes!=='string'||notes.length>4000))throw new PublicError(400,'Observação muito longa (máx. 4000).');
  try{res.status(201).json({contact:await repo.createContact({name:cleanName(name),phone:normalizePhone(phone),source:cleanSource(source),notes:typeof notes==='string'&&notes.trim()?notes.trim():null})});}
  catch(e){if(e instanceof Error&&e.message==='DUPLICADO')throw new PublicError(409,'Esse telefone já está nos contatos.');throw e;}
}));
app.patch('/api/contacts/:id',wrap(async(req,res)=>{
  const body=req.body as {name?:unknown;phone?:unknown;notes?:unknown;doNotContact?:unknown};
  const changes:Record<string,unknown>={};
  if(body.name!==undefined)changes.name=cleanName(body.name);
  if(body.phone!==undefined){if(typeof body.phone!=='string')throw new PublicError(400,'Telefone inválido.');changes.phone=normalizePhone(body.phone);}
  if(body.notes!==undefined){if(body.notes!==null&&(typeof body.notes!=='string'||body.notes.length>4000))throw new PublicError(400,'Observação inválida.');changes.notes=typeof body.notes==='string'&&body.notes.trim()?body.notes.trim():null;}
  if(body.doNotContact!==undefined){if(typeof body.doNotContact!=='boolean')throw new PublicError(400,'Valor inválido.');changes.do_not_contact=body.doNotContact;}
  if(!Object.keys(changes).length)throw new PublicError(400,'Nada para alterar.');
  res.json({contact:await repo.updateContact(idParam(req),changes)});
}));
app.delete('/api/contacts/:id',wrap(async(req,res)=>{await repo.deleteContact(idParam(req));res.json({deleted:true});}));
function slugify(value:string):string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40); }
function cleanTemplateText(value:unknown,label:string,min:number,max:number):string { const text=typeof value==='string'?value.replace(/\r\n/g,'\n').trim():''; if(text.length<min||text.length>max)throw new PublicError(400,`${label}: use de ${min} a ${max} caracteres.`); return text; }
app.get('/api/automations/templates',wrap(async(_req,res)=>{res.json({templates:await repo.listTemplates()});}));
app.post('/api/automations/templates',wrap(async(req,res)=>{
  const b=req.body as {name?:unknown;whenToUse?:unknown;body?:unknown;isActive?:unknown};
  const name=cleanTemplateText(b.name,'Nome',2,80);
  const slug=slugify(name); if(slug.length<2)throw new PublicError(400,'Nome inválido.');
  try{res.status(201).json({template:await repo.createTemplate({slug,name,when_to_use:b.whenToUse===undefined||b.whenToUse===''?'':cleanTemplateText(b.whenToUse,'Quando usar',0,300),body:cleanTemplateText(b.body,'Mensagem',2,1500),is_active:b.isActive!==false})});}
  catch(e){if(e instanceof Error&&e.message==='DUPLICADO')throw new PublicError(409,'Já existe um modelo com esse nome.');throw e;}
}));
app.patch('/api/automations/templates/:id',wrap(async(req,res)=>{
  const b=req.body as {name?:unknown;whenToUse?:unknown;body?:unknown;isActive?:unknown};
  const changes:Record<string,unknown>={};
  if(b.name!==undefined)changes.name=cleanTemplateText(b.name,'Nome',2,80);
  if(b.whenToUse!==undefined)changes.when_to_use=b.whenToUse===''?'':cleanTemplateText(b.whenToUse,'Quando usar',0,300);
  if(b.body!==undefined)changes.body=cleanTemplateText(b.body,'Mensagem',2,1500);
  if(b.isActive!==undefined){if(typeof b.isActive!=='boolean')throw new PublicError(400,'Valor inválido.');changes.is_active=b.isActive;}
  if(!Object.keys(changes).length)throw new PublicError(400,'Nada para alterar.');
  res.json({template:await repo.updateTemplate(idParam(req),changes)});
}));
app.delete('/api/automations/templates/:id',wrap(async(req,res)=>{await repo.deleteTemplate(idParam(req));res.json({deleted:true});}));
app.get('/api/whatsapp/status',wrap(async(_req,res)=>{res.json(await whatsappStatus());}));
app.get('/api/amei/status',wrap(async(_req,res)=>{res.json(await ameiStatus());}));
const amei=<T,>(load:()=>Promise<T>)=>load().catch((error:unknown)=>{throw error instanceof AmeiError?new PublicError(503,error.message):error;});
const queryText=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()?value.trim().slice(0,40):undefined;
app.get('/api/amei/confirm/options',wrap(async(_req,res)=>{res.json(await amei(()=>ameiConfirmOptions()));}));
app.get('/api/amei/confirm/professionals',wrap(async(req,res)=>{res.json({professionals:await amei(()=>ameiProfessionalsOf(queryText(req.query.specialtyId)??''))});}));
app.get('/api/amei/confirm/list',wrap(async(req,res)=>{
  const statusId=Number(queryText(req.query.statusId));
  res.json(await amei(()=>ameiConfirmList({dateInit:queryText(req.query.dateInit)??'',dateFinish:queryText(req.query.dateFinish)??'',statusId:Number.isInteger(statusId)&&(statusId>0||statusId===-1)?statusId:undefined,specialtyId:queryText(req.query.specialtyId),professionalId:queryText(req.query.professionalId)})));
}));
app.get('/api/amei/confirm/recovery/:id',wrap(async(req,res)=>{res.json(await amei(()=>ameiRecoveryStatusOf(idParam(req))));}));
app.post('/api/amei/captacao/search',wrap(async(req,res)=>{
  const b=req.body as {mode?:string;specialtyId?:string;professionalId?:string;monthFrom?:string;monthTo?:string;dateFrom?:string;dateTo?:string;situations?:string;cardFilter?:string};
  const jobId=await amei(()=>Promise.resolve(startCampaignSearch({mode:b.mode as CampaignMode,specialtyId:String(b.specialtyId??''),professionalId:b.professionalId,monthFrom:b.monthFrom||undefined,monthTo:b.monthTo||undefined,dateFrom:b.dateFrom||undefined,dateTo:b.dateTo||undefined,situations:(b.situations||undefined) as MissedSituations|undefined,cardFilter:(b.cardFilter||undefined) as 'todos'|'sem_cartao'|undefined})));
  res.status(201).json({jobId});
}));
app.get('/api/amei/captacao/search/:jobId',wrap(async(req,res)=>{res.json(await amei(()=>Promise.resolve(getCampaignSearch(req.params.jobId!))));}));
app.post('/api/amei/confirm/call',wrap(async(req,res)=>{
  const {brainId,appointmentId}=req.body as {brainId?:string;appointmentId?:string};
  if(!brainId||!appointmentId)throw new PublicError(400,'Informe a consulta.');
  const call=await startConfirmationCall(brainId,String(appointmentId));res.status(201).json({success:true,call});
}));
app.post('/api/amei/confirm/manual',wrap(async(req,res)=>{
  const {appointmentId,date,time}=req.body as {appointmentId?:unknown;date?:unknown;time?:unknown};
  if(typeof appointmentId!=='string'||!/^\d{1,12}$/.test(appointmentId)||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||typeof time!=='string'||!/^\d{2}:\d{2}$/.test(time))throw new PublicError(400,'Consulta inválida.');
  try{res.json({success:true,message:await ameiApplyOutcome({appointmentId,date,time},'confirmou','manual')});}
  catch(error){if(error instanceof AmeiError)throw new PublicError(409,error.message);throw error;}
}));
app.post('/api/amei/confirm/auto/start',wrap(async(req,res)=>{
  const b=req.body as {brainId?:string;dateInit?:string;dateFinish?:string;specialtyId?:string;professionalId?:string;startFromAppointmentId?:string;startFromDirection?:'up'|'down'};
  if(!b.brainId||!b.dateInit||!b.dateFinish)throw new PublicError(400,'Informe cérebro e período.');
  const startFrom=b.startFromAppointmentId&&(b.startFromDirection==='up'||b.startFromDirection==='down')?{appointmentId:b.startFromAppointmentId,direction:b.startFromDirection}:undefined;
  startAutoConfirm(b.brainId,{dateInit:b.dateInit,dateFinish:b.dateFinish,specialtyId:b.specialtyId,professionalId:b.professionalId},startFrom);
  res.status(201).json(autoConfirmStatus());
}));
app.post('/api/amei/captacao/auto/start',wrap(async(req,res)=>{
  const b=req.body as {brainId?:string;jobId?:string;startFromId?:string;startFromDirection?:'up'|'down'};
  if(!b.brainId||!b.jobId)throw new PublicError(400,'Informe cérebro e busca.');
  const startFrom=b.startFromId&&(b.startFromDirection==='up'||b.startFromDirection==='down')?{id:b.startFromId,direction:b.startFromDirection}:undefined;
  startCaptacaoAuto(b.brainId,b.jobId,startFrom);
  res.status(201).json(captacaoAutoStatus());
}));
app.post('/api/amei/captacao/auto/stop',wrap(async(_req,res)=>{stopCaptacaoAuto();res.json(captacaoAutoStatus());}));
app.get('/api/amei/captacao/auto/status',wrap(async(_req,res)=>{res.json(captacaoAutoStatus());}));
app.post('/api/amei/confirm/auto/stop',wrap(async(_req,res)=>{stopAutoConfirm();res.json(autoConfirmStatus());}));
app.get('/api/amei/confirm/auto/status',wrap(async(_req,res)=>{res.json(autoConfirmStatus());}));
app.post('/api/amei/missed/call',wrap(async(req,res)=>{
  const {brainId,appointmentId}=req.body as {brainId?:string;appointmentId?:string};
  if(!brainId||!appointmentId)throw new PublicError(400,'Informe a consulta.');
  const call=await startMissedCall(brainId,String(appointmentId));res.status(201).json({success:true,call});
}));
app.post('/api/amei/captacao/cartao/call',wrap(async(req,res)=>{
  const {brainId,appointmentId}=req.body as {brainId?:string;appointmentId?:string};
  if(!brainId||!appointmentId)throw new PublicError(400,'Informe a consulta.');
  const call=await startCardCall(brainId,String(appointmentId));res.status(201).json({success:true,call});
}));
app.post('/api/amei/captacao/call',wrap(async(req,res)=>{
  const {brainId,waitlistId}=req.body as {brainId?:string;waitlistId?:string};
  if(!brainId||!waitlistId)throw new PublicError(400,'Informe a entrada da lista de espera.');
  const call=await startWaitlistCall(brainId,String(waitlistId));res.status(201).json({success:true,call});
}));
app.post('/api/amei/confirm/test',wrap(async(req,res)=>{
  const b=req.body as {kind?:string;situation?:string;brainId?:string;phone?:string;patientName?:string;professional?:string;specialty?:string;date?:string;time?:string;valor?:string};
  if(!b.brainId)throw new PublicError(400,'Selecione um cérebro.');
  if(b.kind==='missed'){const call=await startTestMissedCall(b.brainId,{phone:String(b.phone??''),patientName:String(b.patientName??''),professional:String(b.professional??''),specialty:String(b.specialty??''),date:String(b.date??''),time:String(b.time??''),situation:String(b.situation??'faltou')});res.status(201).json({success:true,call});return;}
  if(b.kind==='waitlist'){const call=await startTestWaitlistCall(b.brainId,{phone:String(b.phone??''),patientName:String(b.patientName??''),specialty:String(b.specialty??''),professional:b.professional?String(b.professional):undefined});res.status(201).json({success:true,call});return;}
  const call=await startTestConfirmationCall(b.brainId,{phone:String(b.phone??''),patientName:String(b.patientName??''),professional:String(b.professional??''),specialty:String(b.specialty??''),date:String(b.date??''),time:String(b.time??''),valor:b.valor==null?undefined:String(b.valor)});
  res.status(201).json({success:true,call});
}));
app.post('/api/amei/open',wrap(async(_req,res)=>{try{await openAmei();res.json({opening:true});}catch(e){throw new PublicError(503,e instanceof Error?e.message:'Não foi possível abrir a AMEI.');}}));
app.post('/api/whatsapp/open',wrap(async(_req,res)=>{await openWhatsapp();res.json({opening:true});}));
app.get('/api/whatsapp/messages',wrap(async(_req,res)=>{res.json({messages:await repo.listMessages(100)});}));
app.post('/api/whatsapp/test',wrap(async(req,res)=>{
  const {templateId,phone}=req.body as {templateId?:unknown;phone?:unknown};
  if(typeof templateId!=='string'||typeof phone!=='string')throw new PublicError(400,'Informe o modelo e o telefone.');
  await sendTestWhatsapp(phone,templateId);res.json({queued:true});
}));
app.get('/api/calls',wrap(async(_req,res)=>{res.json({calls:await listManagedCalls()});}));
app.post('/api/calls',wrap(async(req,res)=>{
  const {brainId,patientName,phone,contactContext='not_informed'}=req.body as {brainId?:string;patientName?:string;phone?:string;contactContext?:'not_informed'|'recent_card_member'};
  if(typeof brainId!=='string'||typeof patientName!=='string'||typeof phone!=='string')throw new PublicError(400,'Informe cérebro, nome e telefone.');
  if(contactContext!=='not_informed'&&contactContext!=='recent_card_member')throw new PublicError(400,'Origem do contato inválida. Confirmações de consulta são feitas pela tela Confirmar agenda.');
  const call=await startCall(brainId,patientName,phone,contactContext);res.status(201).json({success:true,call});
}));
app.get('/api/calls/:id',wrap(async(req,res)=>{res.json({call:await syncCall(requireCall(await getManagedCall(idParam(req))))});}));
app.get('/api/calls/:id/transcript',wrap(async(req,res)=>{res.json(await getCallTranscript(requireCall(await getManagedCall(idParam(req)))));}));
app.get('/api/calls/:id/audio',wrap(async(req,res)=>{
  const {buffer,contentType}=await getCallAudio(requireCall(await getManagedCall(idParam(req))));
  res.setHeader('Content-Type',contentType);
  res.setHeader('Content-Length',String(buffer.length));
  res.send(buffer);
}));
app.post('/api/calls/:id/end',wrap(async(req,res)=>{res.json({call:await endCall(requireCall(await getManagedCall(idParam(req))))});}));
app.post('/api/calls/:id/takeover',wrap(async(req,res)=>{res.json({call:await takeoverCall(requireCall(await getManagedCall(idParam(req))))});}));
app.post('/api/calls/:id/answered',wrap(async(req,res)=>{await markCallAnswered(requireCall(await getManagedCall(idParam(req))));res.json({success:true});}));
app.post('/api/calls/:id/booking',wrap(async(req,res)=>{
  const {decision}=req.body as {decision?:string};
  if(decision!=='approve'&&decision!=='reject')throw new PublicError(400,'Decisão inválida.');
  requireCall(await getManagedCall(idParam(req)));
  decideBooking(idParam(req),decision);res.json({success:true});
}));
app.post('/api/calls/:id/voicemail',wrap(async(req,res)=>{res.json({call:await markCallVoicemail(requireCall(await getManagedCall(idParam(req))))});}));
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
server.listen(config.port,()=>{console.info(`[API] listening on ${config.port}`);startWhatsappReplyWatcher();});
