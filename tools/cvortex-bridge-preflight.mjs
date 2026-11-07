import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const browser = await chromium.connectOverCDP(process.env.CVORTEX_CDP_URL || 'http://127.0.0.1:9223');
const page = browser.contexts().flatMap(context => context.pages()).find(tab => tab.url().startsWith('https://amorsaude.cvortex.com/'));
if (!page) throw new Error('Aba cVortex autenticada não encontrada.');
const server = new WebSocketServer({ host: '127.0.0.1', port: 8768 });
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
let received = false;
server.on('connection', socket => socket.on('message', payload => { if (payload.toString() === 'preflight') received = true; socket.close(); }));
try {
  const opened = await page.evaluate(() => new Promise(resolve => {
    const socket = new WebSocket('ws://127.0.0.1:8768');
    const timer = setTimeout(() => { socket.close(); resolve(false); }, 3000);
    socket.onopen = () => { socket.send('preflight'); clearTimeout(timer); resolve(true); };
    socket.onerror = () => { clearTimeout(timer); resolve(false); };
  }));
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(JSON.stringify({ tenantUrl: page.url(), loopbackWebSocketOpened: opened, frameReceived: received }));
  if (!opened || !received) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  await browser.close();
}
