import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amei.amorsaude.com.br'));
for (const path of process.argv.slice(2)) {
  const r = await page.evaluate(async p => { try { const x = await fetch(p, {credentials:"same-origin"}); return { s: x.status, t: (await x.text()).slice(0, 3500) }; } catch (e) { return { s: "ERR", t: String(e) + " @ " + location.href }; } }, path);
  console.log('###', path, r.s); console.log(r.t);
}
process.exit(0);
