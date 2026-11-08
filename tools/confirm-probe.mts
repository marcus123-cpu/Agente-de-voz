import 'dotenv/config';
import WebSocket from 'ws';
import { buildConfirmationPrompt, confirmationFirstMessage } from '../server/src/confirm-prompt.ts';

// Conversa em modo texto com o agente, usando o MESMO prompt e a MESMA primeira fala que o servidor envia nas ligações de confirmação.
const key = process.env.ELEVENLABS_API_KEY!, agent = process.env.ELEVENLABS_AGENT_ID!;
interface Scenario { turns: string[]; checks: Array<[string, (agentText: string[], tools: string[]) => boolean]> }
const noOldScript = (t: string[]) => !/filia|Cartão de TODOS|boas-vindas|conhece a nossa cl/i.test(t.join(' '));
const introOk = (t: string[]) => /Giovana da Clínica Amor Saúde de Fernandópolis/.test(t.join(' ')) && /Clínica médica/.test(t.join(' ')) && /(11|onze) de novembro/.test(t.join(' ')) && /(9 e 10|nove e dez)/.test(t.join(' ')) && /Ana Souza/.test(t.join(' ')) && /valor.*(90|noventa)/i.test(t.join(' '));
const noDataYet = (t: string[]) => !/Clínica médica|novembro|Ana Souza|(90|noventa) reais/i.test(t.join(' '));
const scenarios: Record<string, Scenario> = {
  paciente_confirma: { turns: ['Alô.', 'Sim, sou eu.', 'Pode confirmar sim.'], checks: [
    ['sem roteiro antigo', (t) => noOldScript(t)],
    ['apresenta consulta, valor, dia, hora e doutora', (t) => introOk(t.slice(1))],
    ['NÃO abre a apresentação com o nome do paciente', (t) => !/^(\[[a-z ]+\]\s*)?Maria/i.test(t[1] ?? '')],
    ['pergunta se pode confirmar a presença', (t) => /confirmar a sua presen/i.test(t.join(' '))],
    ['chamou registrar_confirmacao=confirmou', (_t, tools) => tools.some((x) => /"confirmou"/.test(x))],
  ] },
  paciente_cancela: { turns: ['Alô.', 'Sou eu.', 'Não, não vou conseguir ir.', 'Pode cancelar.'], checks: [
    ['sem roteiro antigo', (t) => noOldScript(t)],
    ['pergunta cancelar ou remarcar', (t) => /cancelar.*remarcar|remarcar.*cancelar/i.test(t.join(' '))],
    ['desmarcou com confirmação do paciente', (_t, tools) => tools.some((x) => /"desmarcou"/.test(x) && /"paciente_confirmou_cancelamento":true/.test(x))],
  ] },
  paciente_remarca: { turns: ['Alô?', 'Isso, sou eu.', 'Eu queria remarcar pra outro dia.'], checks: [
    ['chamou remarcar', (_t, tools) => tools.some((x) => /"remarcar"/.test(x))],
    ['passa para o Marcos', (t) => /chamar o Marcos/i.test(t.join(' '))],
    ['não desmarcou', (_t, tools) => !tools.some((x) => /"desmarcou"|"confirmou"/.test(x))],
  ] },
  parente_sim: { turns: ['Alô.', 'Não, não é.', 'Sou sim, sou a esposa dele.', 'Pode confirmar sim.'], checks: [
    ['sem roteiro antigo', (t) => noOldScript(t)],
    ['pergunta se é parente ANTES de dar dados', (t) => { const i = t.findIndex((x) => /parente/i.test(x)); return i > 0 && noDataYet(t.slice(0, i + 1).filter((x) => !/Ana Souza/.test(x))) && !/Ana Souza/.test(t.slice(0, i + 1).join(' ')); }],
    ['depois dá os dados completos', (t) => introOk(t.slice(1))],
    ['confirma a presença do paciente pelo nome (sem "dele")', (t) => /presença de Maria/i.test(t.join(' ')) && !/presença dele/i.test(t.join(' '))],
    ['chamou confirmou', (_t, tools) => tools.some((x) => /"confirmou"/.test(x))],
  ] },
  parente_nao: { turns: ['Alô.', 'Não, aqui não é ele.', 'Não, não conheço, número errado.'], checks: [
    ['pergunta se é parente', (t) => t.some((x) => /parente/i.test(x))],
    ['NÃO revela nenhum dado da consulta', (t) => noDataYet(t)],
    ['não chamou ferramenta de agenda', (_t, tools) => tools.length === 0],
  ] },
  parente_nao_pode_responder: { turns: ['Alô.', 'Não, não sou ele.', 'Sou irmão dele, mas ele não tá aqui e não sei de nada dessa consulta.'], checks: [
    ['NÃO revela dados da consulta', (t) => noDataYet(t)],
    ['não chamou ferramenta', (_t, tools) => tools.length === 0],
  ] },
};

const only = process.argv[2];
const vars = { patient_name: 'Maria Silva', contact_context: 'appointment_confirmation', saudacao: 'boa noite', modelos_whatsapp: 'nenhum', agenda_amei: 'conectada', consulta_dia: 'quarta-feira, dia 11 de novembro', consulta_hora: '9 e 10 da manhã', consulta_profissional: 'Dra. Ana Souza Exemplo', consulta_especialidade: 'Clínica médica', consulta_valor: '90 reais' };
const prompt = buildConfirmationPrompt({ patientName: 'Maria Silva', day: vars.consulta_dia, time: vars.consulta_hora, professional: vars.consulta_profissional, specialty: vars.consulta_especialidade, value: vars.consulta_valor, greeting: 'boa noite' });
const firstMessage = confirmationFirstMessage('boa noite', 'Maria Silva');

async function run(name: string, s: Scenario): Promise<boolean> {
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agent}`, { headers: { 'xi-api-key': key } });
  const { signed_url } = await r.json() as { signed_url: string };
  const log: string[] = [], agentText: string[] = [], tools: string[] = [];
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(signed_url);
    let next = 0, idle: NodeJS.Timeout | null = null;
    const speakNext = () => { if (next >= s.turns.length) { setTimeout(() => ws.close(), 2500); return; } const text = s.turns[next++]!; log.push('PACIENTE: ' + text); ws.send(JSON.stringify({ type: 'user_message', text })); };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'conversation_initiation_client_data', dynamic_variables: vars, conversation_config_override: { conversation: { text_only: true }, agent: { first_message: firstMessage, prompt: { prompt } } } })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', event_id: m.ping_event.event_id }));
      if (m.type === 'agent_response') { const t = String(m.agent_response_event.agent_response); agentText.push(t); log.push('GIOVANA: ' + t); if (idle) clearTimeout(idle); idle = setTimeout(speakNext, 1500); }
      if (m.type === 'client_tool_call') {
        const c = m.client_tool_call; tools.push(`${c.tool_name} ${JSON.stringify(c.parameters)}`); log.push(`FERRAMENTA: ${c.tool_name} ${JSON.stringify(c.parameters)}`);
        const result = c.tool_name === 'registrar_confirmacao' ? (c.parameters.resultado === 'remarcar' ? 'Registrado que o paciente quer remarcar. Faça agora a passagem para o Marcos e NÃO encerre a ligação.' : 'Consulta atualizada na agenda. Agradeça com carinho e encerre a ligação com a ferramenta end_call.') : 'ok';
        ws.send(JSON.stringify({ type: 'client_tool_result', tool_call_id: c.tool_call_id, result, is_error: false }));
        if (idle) clearTimeout(idle); idle = setTimeout(speakNext, 4000);
      }
    });
    ws.on('close', () => resolve());
    setTimeout(() => { try { ws.close(); } catch { /* já fechado */ } resolve(); }, 70000);
  });
  console.log(`\n=== ${name}`); console.log(log.join('\n'));
  let ok = true;
  for (const [label, check] of s.checks) { const pass = check(agentText, tools); if (!pass) ok = false; console.log(`${pass ? '  ✔' : '  ✖'} ${label}`); }
  return ok;
}

const names = only ? [only] : Object.keys(scenarios);
const results = await Promise.all(names.map((n) => run(n, scenarios[n]!)));
console.log(`\nRESULTADO: ${results.filter(Boolean).length}/${results.length} cenários ok`);
process.exit(results.every(Boolean) ? 0 : 1);
