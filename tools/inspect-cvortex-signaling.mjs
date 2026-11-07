import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amorsaude.cvortex.com/'));
if (!page) throw new Error('A aba do cVortex não está aberta.');

const graphql = new Set();
const sip = new Set();
const subscriptions = new Set();

page.on('request', request => {
  if (!request.url().endsWith('/api/crm/graphql')) return;
  try {
    const body = request.postDataJSON();
    const entries = Array.isArray(body) ? body : [body];
    for (const item of entries) {
      if (item?.operationName) graphql.add(item.operationName);
      else if (item?.query) {
        const match = item.query.match(/\b(query|mutation|subscription)\s+(\w+)/);
        if (match) graphql.add(`${match[1]} ${match[2]}`);
      }
    }
  } catch { /* Ignore request values. */ }
});
page.on('websocket', ws => {
  if (ws.url().includes('sip004.cvortex.com')) {
    for (const event of ['framesent', 'framereceived']) ws.on(event, frame => {
      const raw = String(frame.payload);
      const first = raw.split(/\r?\n/, 1)[0];
      if (/^(REGISTER|INVITE|ACK|BYE|CANCEL|OPTIONS|SUBSCRIBE|NOTIFY|SIP\/2\.0)/.test(first)) {
        const method = first.startsWith('SIP/2.0') ? first.replace(/^(SIP\/2\.0\s+\d+).*/, '$1') : first.split(' ', 1)[0];
        sip.add(`${event}: ${method}`);
      } else sip.add(`${event}: ${frame.payload instanceof Buffer ? 'binary' : 'other text'}`);
    });
  }
  if (ws.url().includes('/api/crm/subscriptions')) {
    for (const event of ['framesent', 'framereceived']) ws.on(event, frame => {
      try {
        const body = JSON.parse(frame.payload);
        if (body.type) subscriptions.add(`${event}: ${body.type}`);
      } catch { /* Ignore values. */ }
    });
  }
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const toolbar = await page.locator('body *').evaluateAll(elements => elements
  .filter(el => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.top < 75 && (el.getAttribute('title') || el.getAttribute('aria-label'));
  })
  .map(el => ({ tag: el.tagName, title: el.getAttribute('title'), ariaLabel: el.getAttribute('aria-label'), disabled: el.hasAttribute('disabled') }))
  .slice(0, 60));
console.log(JSON.stringify({ graphqlOperations: [...graphql].sort(), sipMessages: [...sip].sort(), subscriptionTypes: [...subscriptions].sort(), toolbar }, null, 2));
await browser.close();
