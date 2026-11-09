import { ameiFreeSlots, ameiConfirmOptions, ameiProfessionalsOf } from '../server/src/amei.ts';
for (const q of ['clínico geral', 'clinica medica', 'cardiologia']) {
  const t = Date.now();
  const out = await ameiFreeSlots({ especialidade: q });
  console.log(`\n### "${q}" (${Date.now() - t} ms)\n${out}`);
}
const opt = await ameiConfirmOptions();
console.log('\nespecialidades com "clin":', opt.specialties.filter(s => /clin|geral|medic/i.test(s.name)).map(s => `${s.id}:${s.name}`).join(' | '));
process.exit(0);
