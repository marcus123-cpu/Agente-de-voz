import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = b.contexts()[0]!.pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'))!;
const get = (path: string) => page.evaluate(async (u) => (await fetch(u, { credentials: 'same-origin' })).json(), path);
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const esp = (await get('/api/v1/especialidades')) as Array<{ id: number; descricao: string; ativo?: boolean }>;
const matches = esp.filter(e => /clinic|clinico|geral|familia|medic/.test(norm(e.descricao)));
console.log('especialidades parecidas:', matches.map(e => `${e.id}:${e.descricao}${e.ativo === false ? '(inativa)' : ''}`).join(' | '));
const today = new Date(Date.now() - 3 * 3600e3);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
const fin = new Date(today.getTime() + 14 * 86400000);
for (const e of matches.filter(e => /clinica medica|medicina de familia|clinico/.test(norm(e.descricao)))) {
  const profs = (await get(`/api/v1/profissionais/especialidade/${e.id}`)) as Array<{ id: number; nome: string; sobrenome: string; ativo?: boolean }>;
  console.log(`\n== ${e.descricao} (${e.id}): ${profs.length} profissional(is):`, profs.map(p => `${p.nome} ${p.sobrenome} #${p.id}${p.ativo === false ? ' (inativo)' : ''}`).join(' | '));
  for (const p of profs) {
    const qs = new URLSearchParams({ idClinic: '1795', idSpecialty: String(e.id), idProfessional: String(p.id), initialDate: ymd(today), finalDate: ymd(fin), initialHour: '00:00', endHour: '23:59', fetchPolicy: 'network-only', cancelledAppointments: 'false' });
    const data = (await get(`/api/v1/slots/list-slots-by-professional?${qs}`)) as Array<{ hours?: Array<{ status: string; date: string; formatedHour: string }> }>;
    const hours = data.flatMap(d => d.hours ?? []);
    const byDay: Record<string, Record<string, number>> = {};
    for (const h of hours) { (byDay[h.date] ??= {})[h.status] = (byDay[h.date]![h.status] ?? 0) + 1; }
    console.log(`  ${p.nome} ${p.sobrenome}: ${hours.length} horários no período`, JSON.stringify(byDay));
  }
}
process.exit(0);
