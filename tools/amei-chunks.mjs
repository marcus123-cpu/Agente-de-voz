import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'));
const dir = process.argv[2];
const urls = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(n => /amei\.amorsaude\.com\.br\/.*\.js$/.test(n)));
const uniq = [...new Set(urls)];
console.log(uniq.length, 'js');
for (const u of uniq) {
  const name = u.split('/').pop();
  if (fs.existsSync(dir + '/' + name)) continue;
  const t = await page.evaluate(async x => (await fetch(x)).text(), u);
  fs.writeFileSync(dir + '/' + name, t); console.log(name, t.length);
}
process.exit(0);
