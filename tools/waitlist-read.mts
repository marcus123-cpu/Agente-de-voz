import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = b.contexts()[0]!.pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'))!;
const t = Date.now();
const all = await page.evaluate(async () => { const out: Array<{ pacienteId?: { id?: number }; especialidadeId?: { id?: number }; statusId?: { description?: string } }> = []; let total = 1e9; for (let p = 1; p <= 40 && out.length < total; p++) { const d = await (await fetch(`/api/v1/lista-espera?page=${p}&limit=100`, { credentials: 'same-origin' })).json(); if (!d.items?.length) break; total = d.meta.totalItems; out.push(...d.items); if (p * 100 >= total) break; } return { n: out.length, total, pend: out.filter(i => i.statusId?.description === 'pendente').length, distinctPatients: new Set(out.map(i => i.pacienteId?.id)).size }; });
console.log('lista de espera completa:', JSON.stringify(all), `${Date.now() - t} ms`);
process.exit(0);
