import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'));
const src = await page.evaluate(async () => {
  const urls = [...document.scripts].map(s => s.src).filter(u => u.startsWith(location.origin));
  const out = {};
  for (const u of urls) out[u] = await (await fetch(u)).text();
  // chunks lazy: pega os nomes do runtime
  const rt = out[urls.find(u=>u.includes('runtime'))] || '';
  return out;
});
const dir = process.argv[2];
for (const [u, t] of Object.entries(src)) { fs.writeFileSync(dir + '/' + u.split('/').pop(), t); console.log(u.split('/').pop(), t.length); }
process.exit(0);
