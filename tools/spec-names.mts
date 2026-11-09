import { ameiConfirmOptions, ameiProfessionalsOf, ameiConfirmList } from '../server/src/amei.ts';
const opt = await ameiConfirmOptions();
console.log(opt.specialties.length, 'especialidades');
// popularidade real: consultas agendadas nos próximos 10 dias por especialidade
const d = (n: number) => new Date(Date.now() - 3 * 3600e3 + n * 86400000).toISOString().slice(0, 10);
const all = await ameiConfirmList({ dateInit: d(0), dateFinish: d(10) });
const count: Record<string, number> = {};
for (const r of all.rows) count[r.specialty] = (count[r.specialty] ?? 0) + 1;
console.log('agendadas (próx. 10 dias):', all.rows.length);
console.log(Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}:${v}`).join(' | '));
process.exit(0);
