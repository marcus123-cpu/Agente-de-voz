import { WebSocketServer } from 'ws';

const port = 8765;
const wss = new WebSocketServer({ host: '127.0.0.1', port, verifyClient: ({ origin }) => origin === 'https://amorsaude.cvortex.com' });
let inboundFrames = 0;
let inboundBytes = 0;
let outboundFrames = 0;
let toneStarted = false;
let sampleIndex = 0;

wss.on('connection', socket => {
  socket.on('message', (payload, isBinary) => {
    if (!isBinary) return;
    inboundFrames++;
    inboundBytes += payload.length;
    if (toneStarted || inboundFrames < 10) return;
    toneStarted = true;
    const timer = setInterval(() => {
      if (socket.readyState !== socket.OPEN || outboundFrames >= 150) {
        clearInterval(timer);
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'tone-finished' }));
        return;
      }
      const pcm = Buffer.alloc(640);
      for (let i=0; i<320; i++) {
        const value = Math.round(Math.sin(2*Math.PI*523*(sampleIndex++/16000))*2200);
        pcm.writeInt16LE(value, i*2);
      }
      socket.send(pcm, { binary: true });
      outboundFrames++;
    }, 20);
  });
  socket.on('close', () => {
    console.log(JSON.stringify({ inboundFrames, inboundBytes, outboundFrames }));
    wss.close();
  });
});
console.log(`Local audio bridge listening on ws://127.0.0.1:${port}`);
