import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'));
const d = await page.evaluate(async id => (await fetch('/api/v1/appointments/' + id, { credentials: 'same-origin' })).json(), process.argv[2]);
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o?.[k]]));
console.log(JSON.stringify({ top: Object.keys(d), paciente: pick(d.pacienteId, ['id','nome','sobrenome','nomeSocial','celular','telefone','cpf']), prof: pick(d.profissionalId, ['id','nome','sobrenome','tratamento','sexo','genero']), esp: pick(d.especialidadeId, ['id','descricao']), clinica: d.clinica, status: d.statusAgendamento }, null, 1));
process.exit(0);
