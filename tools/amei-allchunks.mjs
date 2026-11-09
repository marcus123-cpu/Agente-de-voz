import { chromium } from 'playwright';
import fs from 'node:fs';
const dir = process.argv[2];
const rt = fs.readFileSync(fs.readdirSync(dir).map(f => dir + '/' + f).find(f => /runtime\./.test(f)), 'utf8');
const map = {}; for (const m of rt.matchAll(/(\d{3,5}):"([0-9a-f]{16})"/g)) map[m[1]] = m[2];
console.log('chunks no mapa:', Object.keys(map).length);
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = b.contexts()[0].pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'));
let n = 0;
for (const [id, hash] of Object.entries(map)) {
  const name = `${id}.${hash}.js`;
  if (fs.existsSync(dir + '/' + name)) continue;
  const t = await page.evaluate(async u => { const r = await fetch(u); return r.ok ? r.text() : ''; }, `/${name}`);
  if (t) { fs.writeFileSync(dir + '/' + name, t); n++; }
}
console.log('baixados agora:', n);
process.exit(0);
