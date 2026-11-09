import { ameiConfirmList, ameiConfirmOptions, ameiProfessionalsOf, ameiAppointmentContext, spokenLongDay, spokenClock } from '../server/src/amei.ts';
const opt = await ameiConfirmOptions();
console.log('especialidades', opt.specialties.length, '| status', opt.statuses.map(s => `${s.id}:${s.name}`).join(', '));
const all = await ameiConfirmList({ dateInit: '2026-11-11', dateFinish: '2026-11-11' });
console.log('dia 11 ->', all.rows.length, 'linhas, total AMEI', all.total);
console.log('amostra:', JSON.stringify({ ...all.rows[0], phone: all.rows[0]!.phone.slice(0, 4) + '*****' }));
const psi = opt.specialties.find(s => /psiquiatr/i.test(s.name));
if (psi) {
  const profs = await ameiProfessionalsOf(psi.id);
  const f = await ameiConfirmList({ dateInit: '2026-11-11', dateFinish: '2026-11-11', specialtyId: psi.id });
  console.log('psiquiatria', psi.id, 'profs:', profs.map(p => p.name).join(' | '), '| linhas:', f.rows.length, f.rows.map(r => r.patientName.split(' ')[0]).join(','));
}
const none = await ameiConfirmList({ dateInit: '2026-11-10', dateFinish: '2026-11-10' });
console.log('dia 10 ->', none.rows.length);
const row = all.rows.find(r => /Rodrigo/i.test(r.patientName));
if (row) {
  const ctx = await ameiAppointmentContext(row.appointmentId);
  console.log('contexto:', JSON.stringify({ ...ctx, phone: '***' }), '|', spokenLongDay(ctx.date), '|', spokenClock(ctx.time));
}
process.exit(0);
