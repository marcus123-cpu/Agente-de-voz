import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amorsaude.cvortex.com/'));
if (!page) throw new Error('A aba do cVortex não está aberta.');

const requests = new Map();
const sockets = new Map();
function route(value) {
  try { const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname}`; }
  catch { return '<invalid>'; }
}
page.on('response', response => {
  const request = response.request();
  const clean = route(request.url());
  const key = `${request.method()} ${clean}`;
  if (!requests.has(key)) requests.set(key, { method: request.method(), route: clean, status: response.status(), count: 0 });
  requests.get(key).count++;
});
page.on('websocket', ws => {
  const clean = route(ws.url());
  if (!sockets.has(clean)) sockets.set(clean, { route: clean, sent: 0, received: 0, jsonKeys: new Set() });
  const record = sockets.get(clean);
  for (const [event, field] of [['framesent', 'sent'], ['framereceived', 'received']]) {
    ws.on(event, frame => {
      record[field]++;
      try {
        const data = JSON.parse(frame.payload);
        if (data && typeof data === 'object' && !Array.isArray(data)) Object.keys(data).forEach(k => record.jsonKeys.add(k));
      } catch { /* Do not retain frame data. */ }
    });
  }
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
console.log(JSON.stringify({
  page: route(page.url()),
  requests: [...requests.values()].sort((a,b) => a.route.localeCompare(b.route)),
  sockets: [...sockets.values()].map(x => ({ route: x.route, sent: x.sent, received: x.received, jsonKeys: [...x.jsonKeys] })),
}, null, 2));
await browser.close();
