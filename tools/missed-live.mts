import { ameiConfirmList, ameiConfirmOptions, ameiMissedContext, STATUS_FALTOSOS } from '../server/src/amei.ts';
import { chromium } from 'playwright';
const opt = await ameiConfirmOptions();
console.log('opções de status:', opt.statuses.map(s => `${s.id}:${s.name}`).join(' | '));
for (const [a, b] of [['2026-11-05', '2026-11-07']]) {
  const f = await ameiConfirmList({ dateInit: a, dateFinish: b, statusId: STATUS_FALTOSOS });
  const by: Record<string, number> = {}; for (const r of f.rows) by[r.status] = (by[r.status] ?? 0) + 1;
  console.log(`faltosos ${a}..${b}:`, f.rows.length, JSON.stringify(by));
  const sp: Record<string, number> = {}; for (const r of f.rows) sp[r.specialty] = (sp[r.specialty] ?? 0) + 1;
  console.log('  por especialidade:', JSON.stringify(sp));
  const only9 = await ameiConfirmList({ dateInit: a, dateFinish: b, statusId: 9 });
  console.log('  só desmarcados pelo paciente (9):', only9.rows.length);
  const futureTry = await ameiConfirmList({ dateInit: '2026-11-11', dateFinish: '2026-11-11', statusId: STATUS_FALTOSOS });
  console.log('  faltosos em dia futuro (deve ser 0):', futureTry.rows.length);
  const row = f.rows.find(r => r.statusId === 17) ?? f.rows[0];
  if (row) {
    const ctx = await ameiMissedContext(row.appointmentId);
    console.log('  contexto:', JSON.stringify({ ...ctx, patientName: ctx.patientName.split(' ')[0] + ' …', phone: '***', professional: ctx.professional.split(' ').slice(0, 2).join(' ') + ' …' }));
    const b2 = await chromium.connectOverCDP('http://127.0.0.1:9223');
    const page = b2.contexts()[0]!.pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'))!;
    const res = await page.evaluate(async (id) => {
      const d = await (await fetch('/api/v1/appointments/' + id, { credentials: 'same-origin' })).json();
      const cpf = String(d.pacienteId?.cpf ?? '').replace(/\D/g, '');
      const w = await (await fetch('/api/v1/lista-espera?pacientenomeoucpf=' + cpf + '&page=1&limit=50', { credentials: 'same-origin' })).json();
      return { cpfLen: cpf.length, itens: (w.items ?? []).length, total: w.meta?.totalItems, todosDoMesmoPaciente: (w.items ?? []).every((i: { pacienteId?: { id?: number } }) => i.pacienteId?.id === d.pacienteId?.id) };
    }, row.appointmentId);
    console.log('  busca por CPF na lista de espera:', JSON.stringify(res));
  }
}
process.exit(0);
