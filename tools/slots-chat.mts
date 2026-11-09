import 'dotenv/config';
import WebSocket from 'ws';
import { ameiFreeSlots } from '../server/src/amei.ts';
const key = process.env.ELEVENLABS_API_KEY!, agent = process.env.ELEVENLABS_AGENT_ID!;
const turns = ['Alô.', 'Sim, sou eu.', 'Ainda não conheço, não.', 'Queria saber que dia tem clínico geral aí.', 'Pode ser o primeiro horário.'];
const vars = { patient_name: 'Marcus Paulo', contact_context: 'not_informed', saudacao: 'boa tarde', modelos_whatsapp: 'nenhum', agenda_amei: 'conectada', consulta_dia: '', consulta_hora: '', consulta_profissional: '', consulta_especialidade: '', consulta_valor: 'não informado' };
const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agent}`, { headers: { 'xi-api-key': key } });
const { signed_url } = await r.json() as { signed_url: string };
const ws = new WebSocket(signed_url);
let next = 0, idle: NodeJS.Timeout | null = null;
const speak = () => { if (next >= turns.length) { setTimeout(() => ws.close(), 2000); return; } const text = turns[next++]!; console.log('PACIENTE:', text); ws.send(JSON.stringify({ type: 'user_message', text })); };
ws.on('open', () => ws.send(JSON.stringify({ type: 'conversation_initiation_client_data', dynamic_variables: vars, conversation_config_override: { conversation: { text_only: true } } })));
ws.on('message', async d => {
  const m = JSON.parse(String(d));
  if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', event_id: m.ping_event.event_id }));
  if (m.type === 'agent_response') { console.log('GIOVANA:', m.agent_response_event.agent_response); if (idle) clearTimeout(idle); idle = setTimeout(speak, 1500); }
  if (m.type === 'client_tool_call') {
    const c = m.client_tool_call; console.log('FERRAMENTA:', c.tool_name, JSON.stringify(c.parameters));
    let result = 'ok';
    if (c.tool_name === 'consultar_horarios_agenda') { const t = Date.now(); result = await ameiFreeSlots({ especialidade: String(c.parameters.especialidade), profissional: c.parameters.profissional, dias: c.parameters.dias }); console.log(`  (AMEI respondeu em ${Date.now() - t} ms)\n  RESPOSTA DA AMEI: ${result.replace(/\n/g, ' | ')}`); }
    ws.send(JSON.stringify({ type: 'client_tool_result', tool_call_id: c.tool_call_id, result, is_error: false }));
    if (idle) clearTimeout(idle); idle = setTimeout(speak, 5000);
  }
});
ws.on('close', () => process.exit(0));
setTimeout(() => process.exit(0), 90000);
