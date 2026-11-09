import { ameiConfirmList, ameiAppointmentContext } from '../server/src/amei.ts';
const all = await ameiConfirmList({ dateInit: '2026-11-11', dateFinish: '2026-11-11' });
const rows = all.rows.filter(r => /marcus/i.test(r.patientName) || r.time === '09:10');
for (const r of rows) console.log(r.appointmentId, r.time, r.patientName, '|', r.status, '| tel', r.phone.slice(0,4)+'***'+r.phone.slice(-2), r.phone.length);
for (const r of rows.filter(r => /marcus/i.test(r.patientName))) {
  try { const c = await ameiAppointmentContext(r.appointmentId); console.log('contexto OK', c.patientName, c.professional); } catch (e) { console.log('ERRO contexto:', (e as Error).message); }
}
process.exit(0);
