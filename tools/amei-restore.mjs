import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
for (const p of b.contexts()[0].pages().filter(p => p.url().startsWith('https://id.amorsaude.com.br'))) { await p.goto('https://amei.amorsaude.com.br/home', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500); console.log('->', p.url().slice(0, 50)); }
process.exit(0);
