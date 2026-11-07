import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { hasSession } from './auth.js';
import { getManagedCall, onCallChange } from './services.js';
import { subscribeLive } from './live.js';

function reject(socket: Duplex, code: number) {
  socket.write(`HTTP/1.1 ${code} Unauthorized\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Authenticated operator status events. Media never passes through this socket. */
export class CallEventsService {
  private readonly eventsWs = new WebSocketServer({ noServer: true });

  private readonly listenWs = new WebSocketServer({ noServer: true });

  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
    const match = path.match(/^\/ws\/calls\/([0-9a-f-]{36})\/(events|listen)$/);
    if (!match || req.headers.origin !== config.frontendUrl || !hasSession(req.headers.cookie)) {
      reject(socket, 401);
      return;
    }
    const call = await getManagedCall(match[1]!);
    if (!call) { reject(socket, 404); return; }
    if (match[2] === 'listen') this.listenWs.handleUpgrade(req, socket, head, ws => this.addListener(call.id, ws));
    else this.eventsWs.handleUpgrade(req, socket, head, ws => this.addEvents(call.id, ws));
  }

  /**
   * Escuta ao vivo: quadros binários = 1 byte de origem (1 paciente, 2 Giovana)
   * + PCM16 little-endian 16 kHz mono; quadros de texto = JSON (transcrição/flush).
   * Nada é gravado. Se o painel ficar para trás, o áudio é descartado.
   */
  private addListener(callId: string, ws: WebSocket): void {
    const MAX_BACKLOG = 512_000;
    const unsubscribeLive = subscribeLive(callId, event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (event.kind === 'audio') {
        if (ws.bufferedAmount > MAX_BACKLOG) return;
        ws.send(Buffer.concat([Buffer.from([event.source === 'patient' ? 1 : 2]), event.pcm]), { binary: true });
      } else if (event.kind === 'text') {
        ws.send(JSON.stringify({ type: 'text', role: event.role, text: event.text.slice(0, 2000), correction: event.correction === true }));
      } else {
        ws.send(JSON.stringify({ type: 'flush' }));
      }
    });
    const unsubscribeCall = onCallChange(callId, call => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'call.status', status: call.status, takeover: call.metadata?.human_takeover === true }));
      if (['completed', 'failed', 'busy', 'no_answer', 'canceled'].includes(call.status)) ws.close(1000, 'call ended');
    });
    ws.on('message', () => { /* o painel só escuta; entradas são ignoradas */ });
    ws.on('close', () => { unsubscribeLive(); unsubscribeCall(); });
    ws.on('error', () => { unsubscribeLive(); unsubscribeCall(); });
  }

  private addEvents(callId: string, ws: WebSocket): void {
    void getManagedCall(callId).then(call => {
      if (call && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'call.status', call }));
    });
    const unsubscribe = onCallChange(callId, call => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'call.status', call }));
      if (['completed', 'failed', 'busy', 'no_answer', 'canceled'].includes(call.status)) ws.close(1000, 'call ended');
    });
    ws.on('close', unsubscribe);
  }
}
