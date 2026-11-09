import { ameiFreeSlots, ameiWarmCache } from '../server/src/amei.ts';
const names = ['clínico geral', 'psicologia', 'dermatologista', 'psiquiatria', 'oftalmologia', 'ortopedia', 'nutrição', 'cardiologia', 'angiologia'];
let t = Date.now();
await ameiFreeSlots({ especialidade: 'Psicologia', refresh: true });
console.log('SEM aquecimento (1 especialidade, a frio):', Date.now() - t, 'ms');
t = Date.now(); await ameiWarmCache(); console.log('aquecimento de todas:', Date.now() - t, 'ms');
for (const n of names) { t = Date.now(); const out = await ameiFreeSlots({ especialidade: n }); console.log(`${n.padEnd(15)} ${String(Date.now() - t).padStart(5)} ms | ${out.split('\n')[0]!.slice(0, 70)}`); }
process.exit(0);
