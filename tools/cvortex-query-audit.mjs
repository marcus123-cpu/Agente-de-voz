import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amorsaude.cvortex.com/'));
if (!page) throw new Error('A aba do cVortex não está aberta.');
const assets = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(x => /\/crm\/static\/js\/.*\.js$/.test(x)));
const names = /Voice|Sip|Call|Transfer|Conference|WebPhone|AgentContact|Hangup|Hold|Break|Queue|Status|Dialing|Ringing|Dnd|Pause|Accept|Refuse|Ignore/i;
const found = new Map();
for (const url of [...new Set(assets)]) {
  const response = await page.request.get(url);
  if (!response.ok()) continue;
  const body = await response.text();
  for (const match of body.matchAll(/"((?:mutation|subscription|query)\s+[A-Za-z][^"\r\n]*)"/g)) {
    try {
      const document = JSON.parse(match[0]);
      const header = document.match(/^(mutation|subscription|query)\s+(\w+)/);
      if (header && names.test(header[2])) found.set(`${header[1]} ${header[2]}`, document);
    } catch { /* Ignore non-GraphQL strings. */ }
  }
}
console.log(JSON.stringify([...found].sort((a,b) => a[0].localeCompare(b[0])).map(([operation, document]) => ({ operation, document })), null, 2));
await browser.close();
