// Abre o login da AMEI numa aba do mesmo navegador do cVortex (CDP 9223). O login é manual.
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP(process.env.CVORTEX_CDP_URL || 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
let page = context.pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'));
if (!page) { page = await context.newPage(); await page.goto('https://amei.amorsaude.com.br', { waitUntil: 'domcontentloaded' }); }
await page.bringToFront();
console.log('AMEI aberta:', page.url());
process.exit(0);
