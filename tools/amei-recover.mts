import { chromium } from 'playwright';
import { ameiStatus, ameiConfirmList } from '../server/src/amei.ts';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const pages = b.contexts()[0]!.pages().filter(p => p.url().startsWith('https://amei.amorsaude.com.br') || p.url().startsWith('https://id.amorsaude.com.br'));
const page = pages[0]!;
// Simula a aba perdida no login (sem apagar cookies nem sair da conta).
for (const extra of pages.slice(1)) await extra.goto('https://id.amorsaude.com.br/login?client_id=66vd7vbnisl2v1ekfori5qktiu&redirect_uri=https%3A%2F%2Famei.amorsaude.com.br%2Fcallback&response_type=code&scope=email+openid+profile', { waitUntil: 'domcontentloaded' });
await page.goto('https://id.amorsaude.com.br/login?client_id=66vd7vbnisl2v1ekfori5qktiu&redirect_uri=https%3A%2F%2Famei.amorsaude.com.br%2Fcallback&response_type=code&scope=email+openid+profile', { waitUntil: 'domcontentloaded' });
console.log('aba agora em:', page.url().slice(0, 60));
const t = Date.now();
console.log('status:', JSON.stringify(await ameiStatus()), `(${Date.now() - t} ms)`);
console.log('abas depois:', pages.map(p => p.url().slice(0, 50)).join(' | '));
console.log('lista:', (await ameiConfirmList({ dateInit: '2026-11-11', dateFinish: '2026-11-11' })).rows.length);
process.exit(0);
