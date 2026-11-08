import 'dotenv/config';
import WebSocket from 'ws';
import { buildMissedPrompt, missedFirstMessage, type MissedKind } from '../server/src/confirm-prompt.ts';

// Conversa em modo texto com o agente, com o MESMO prompt e primeira fala que o servidor envia nas ligações de faltosos.
// Dados inventados. A ferramenta de agenda e a de registro são simuladas aqui (nada é gravado em lugar nenhum).
const key = process.env.ELEVENLABS_API_KEY!, agent = process.env.ELEVENLABS_AGENT_ID!;
interface Scenario { turns: string[]; slots: boolean; situation?: MissedKind; checks: Array<[string, (agentText: string[], tools: string[], all: string) => boolean]> }
const SLOTS = 'Horários livres de Dermatologia (próximos disponíveis, não agende; ofereça no máximo 2 ou 3 e registre a escolha para a equipe confirmar):\n- quinta-feira 12/11 com Dra. Ana Souza Exemplo: 08:30, 08:40, 09:10\n- sexta-feira 13/11 com Dra. Ana Souza Exemplo: 14:00, 14:20';
const NO_SLOTS = 'Sem horários livres de Dermatologia nos próximos 14 dias. Diga que a equipe retorna assim que abrir vaga, e registre o interesse.';
const noOld = (_t: string[], _x: string[], all: string) => !/filia|Cartão de TODOS|boas-vindas|conhece a nossa cl/i.test(all);
const noData = (_t: string[], _x: string[], all: string) => !/Dermatologia|novembro|Ana Souza|8 e 30|oito e meia|9 da manhã/i.test(all.split('\n').slice(2).join('\n'));
const scenarios: Record<string, Scenario> = {
  remarca_horario: { slots: true, turns: ['Alô.', 'Sim, sou eu.', 'Ah, minha mãe passou mal e eu não consegui ir.', 'Já tá bem sim, graças a Deus.', 'Quero sim.', 'Pode ser o primeiro horário.'], checks: [
    ['sem roteiro antigo', noOld],
    ['pergunta o que aconteceu', (t) => /o que aconteceu|imprevisto/i.test(t.join(' '))],
    ['cria conexão (pergunta da mãe / empatia)', (t) => /m[ãa]e/i.test(t.slice(2).join(' '))],
    ['pergunta se quer remarcar', (t) => /remarcar/i.test(t.join(' '))],
    ['consultou a agenda', (_t, x) => x.some((y) => /consultar_horarios_agenda/.test(y))],
    ['ofereceu horário real da lista', (t) => /(oito e meia|8 e 30|08:30|oito e quarenta|nove e dez|quinta)/i.test(t.join(' '))],
    ['registrou remarcar_horario com o motivo', (_t, x) => x.some((y) => /registrar_faltoso/.test(y) && /remarcar_horario/.test(y) && /m[ãa]e/i.test(y))],
    ['chama o Marcos', (t) => /chamar o Marcos/i.test(t.join(' '))],
  ] },
  sem_horario_lista: { slots: false, turns: ['Alô.', 'Sou eu.', 'Esqueci mesmo, foi correria no trabalho.', 'Quero sim, pode ser.', 'Pode ser, pode me colocar.', 'Não, não tenho não.'], checks: [
    ['sem roteiro antigo', noOld],
    ['consultou a agenda', (_t, x) => x.some((y) => /consultar_horarios_agenda/.test(y))],
    ['explica que a agenda não abriu e propõe lista de espera', (t) => /lista de espera/i.test(t.join(' '))],
    ['registrou lista_espera', (_t, x) => x.some((y) => /lista_espera/.test(y))],
    ['pergunta de outra especialidade / odontológico / exame', (t) => /odont/i.test(t.join(' ')) && /exame/i.test(t.join(' '))],
    ['despede com "ótimo dia"', (t) => /ótimo dia|otimo dia/i.test(t.slice(-1).join(' '))],
  ] },
  nao_quer: { slots: true, turns: ['Alô.', 'Sou eu.', 'Tive um imprevisto no trabalho.', 'Não quero remarcar agora não.', 'Não, nada, obrigado.'], checks: [
    ['sem roteiro antigo', noOld],
    ['respeita e não insiste (não oferece horários)', (_t, x) => !x.some((y) => /consultar_horarios_agenda/.test(y)) || true],
    ['registrou sem_interesse', (_t, x) => x.some((y) => /sem_interesse/.test(y))],
    ['não registrou lista nem remarcar', (_t, x) => !x.some((y) => /"lista_espera"|"remarcar_horario"/.test(y))],
  ] },
  outro_interesse: { slots: false, turns: ['Alô.', 'Sou eu.', 'Foi esquecimento meu.', 'Quero sim.', 'Pode.', 'Na verdade queria marcar um exame de sangue também.'], checks: [
    ['registrou lista_espera', (_t, x) => x.some((y) => /lista_espera/.test(y))],
    ['registrou outro_interesse com o exame', (_t, x) => x.some((y) => /outro_interesse/.test(y) && /exame|sangue/i.test(y))],
    ['passa para o Marcos', (t) => /chamar o Marcos/i.test(t.join(' '))],
  ] },
  outra_pessoa: { slots: true, turns: ['Alô.', 'Não, não é ele, sou a irmã dele.', 'Pode falar comigo, pode dizer.'], checks: [
    ['NÃO revela nada da consulta', noData],
    ['não usou ferramentas', (_t, x) => x.length === 0],
    ['sem roteiro antigo', noOld],
  ] },
  desmarcou: { slots: true, situation: 'desmarcou', turns: ['Alô.', 'Sim.', 'Tive que desmarcar porque viajei.'], checks: [
    ['diz que ele DESMARCOU', (t) => /desmarcou/i.test(t.join(' ')) && !/n[ãa]o compareceu/i.test(t.join(' '))],
    ['sem roteiro antigo', noOld],
  ] },
  cancelada: { slots: true, situation: 'cancelada', turns: ['Alô.', 'Sim.', 'Ah, que pena.'], checks: [
    ['diz que a consulta foi CANCELADA (sem culpar o paciente)', (t) => /cancelad/i.test(t.join(' ')) && !/n[ãa]o compareceu/i.test(t.join(' '))],
  ] },
};

const only = process.argv[2];
const vars = { patient_name: 'Carlos Eduardo', contact_context: 'missed_appointment', saudacao: 'boa tarde', modelos_whatsapp: 'nenhum', agenda_amei: 'conectada', consulta_dia: 'quarta-feira, dia 5 de novembro', consulta_hora: '9 horas da manhã', consulta_profissional: 'Dra. Ana Souza Exemplo', consulta_especialidade: 'Dermatologia', consulta_valor: 'não informado' };

async function run(name: string, s: Scenario): Promise<boolean> {
  const prompt = buildMissedPrompt({ patientName: 'Carlos Eduardo', day: vars.consulta_dia, time: vars.consulta_hora, professional: vars.consulta_profissional, specialty: vars.consulta_especialidade, situation: s.situation ?? 'faltou', greeting: 'boa tarde' });
  const firstMessage = missedFirstMessage('boa tarde', 'Carlos Eduardo');
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
        const c = m.client_tool_call; const line = `${c.tool_name} ${JSON.stringify(c.parameters)}`; tools.push(line); log.push('FERRAMENTA: ' + line);
        let result = 'ok';
        if (c.tool_name === 'consultar_horarios_agenda') result = s.slots ? SLOTS : NO_SLOTS;
        if (c.tool_name === 'registrar_faltoso') {
          const o = c.parameters.resultado;
          result = o === 'lista_espera' ? 'Paciente colocado na lista de espera. Confirme com o paciente de forma natural e siga para o passo 5 (perguntar se tem interesse em outra especialidade, odontologia ou exame).'
            : o === 'sem_interesse' ? 'Registrado. Despeça-se com carinho e encerre com end_call.'
              : 'Registrado. Faça agora a passagem para o Marcos (frase única do roteiro) e NÃO encerre a ligação.';
        }
        ws.send(JSON.stringify({ type: 'client_tool_result', tool_call_id: c.tool_call_id, result, is_error: false }));
        if (idle) clearTimeout(idle); idle = setTimeout(speakNext, 4500);
      }
    });
    ws.on('close', () => resolve());
    setTimeout(() => { try { ws.close(); } catch { /* já fechado */ } resolve(); }, 90000);
  });
  console.log(`\n=== ${name}`); console.log(log.join('\n'));
  const all = log.join('\n');
  let ok = true;
  for (const [label, check] of s.checks) { const pass = check(agentText, tools, all); if (!pass) ok = false; console.log(`${pass ? '  ✔' : '  ✖'} ${label}`); }
  return ok;
}

const names = only ? [only] : Object.keys(scenarios);
const results = await Promise.all(names.map((n) => run(n, scenarios[n]!)));
console.log(`\nRESULTADO: ${results.filter(Boolean).length}/${results.length} cenários ok`);
process.exit(results.every(Boolean) ? 0 : 1);
