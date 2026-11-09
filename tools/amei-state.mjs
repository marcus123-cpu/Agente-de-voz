import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
for (const p of b.contexts()[0].pages()) console.log(p.url().slice(0, 140));
const page = b.contexts()[0].pages().find(p => /amorsaude\.com\.br/.test(p.url()) && !/cvortex/.test(p.url()));
if (page) { console.log('title:', await page.title()); console.log('body:', (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\s+/g,' ')); }
process.exit(0);
