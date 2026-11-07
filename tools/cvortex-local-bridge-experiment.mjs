import { chromium } from 'playwright';

const phone = process.argv[2];
if (!/^\d{10,11}$/.test(phone ?? '')) throw new Error('Número de teste inválido.');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amorsaude.cvortex.com/'));
if (!page) throw new Error('A aba cVortex não está aberta.');
const result = { started:false, ended:false, bridge:null, error:null };
await page.addInitScript(() => {
  window.__bridgePcs = [];
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(NativePC, { construct(target,args) { const pc = Reflect.construct(target,args); window.__bridgePcs.push(pc); return pc; } });
});
try {
  await page.reload({ waitUntil:'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.locator('svg[aria-label="Navigation Menu Vertical"]').first().click();
  await page.getByText('Ligar para um Colaborador', { exact:true }).click();
  await page.getByPlaceholder('Digite apenas números').fill(phone);
  await page.locator('button[title="Ligar para o número"]').last().click();
  result.started = true;
  await page.waitForTimeout(8000);
  result.bridge = await page.evaluate(async () => {
    const pc = window.__bridgePcs.find(p => p.connectionState === 'connected' && p.getSenders().some(s => s.track?.kind === 'audio'));
    if (!pc) throw new Error('NoConnectedPeerConnection');
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    const receiver = pc.getReceivers().find(r => r.track?.kind === 'audio');
    if (!sender || !receiver) throw new Error('MissingAudioTrack');
    const original = sender.track;
    const report = { wsOpened:false, framesToServer:0, bytesToServer:0, framesFromServer:0, bytesFromServer:0, toneFinished:false, receiverLive:receiver.track.readyState === 'live', replaced:false, restored:false, connectionAtEnd:null, error:null };
    let ws, context, processor, source, output, gain;
    try {
      ws = new WebSocket('ws://127.0.0.1:8765');
      ws.binaryType = 'arraybuffer';
      await new Promise((resolve,reject) => { ws.onopen=resolve; ws.onerror=()=>reject(new Error('WebSocketOpenFailed')); setTimeout(()=>reject(new Error('WebSocketOpenTimeout')),5000); });
      report.wsOpened = true;
      context = new AudioContext({ sampleRate:16000 });
      await context.resume();
      source = context.createMediaStreamSource(new MediaStream([receiver.track]));
      processor = context.createScriptProcessor(1024,1,1);
      gain = context.createGain();
      gain.gain.value = 0;
      source.connect(processor).connect(gain).connect(context.destination);
      processor.onaudioprocess = event => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const floats = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(floats.length);
        for (let i=0; i<floats.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(floats[i]*32767)));
        ws.send(pcm.buffer);
        report.framesToServer++;
        report.bytesToServer += pcm.byteLength;
      };
      output = context.createMediaStreamDestination();
      let nextTime = context.currentTime + 0.15;
      const finished = new Promise(resolve => {
        ws.onmessage = event => {
          if (typeof event.data === 'string') {
            try { if (JSON.parse(event.data).type === 'tone-finished') { report.toneFinished=true; resolve(); } } catch {}
            return;
          }
          const pcm = new Int16Array(event.data);
          const buffer = context.createBuffer(1,pcm.length,16000);
          const samples = buffer.getChannelData(0);
          for (let i=0; i<pcm.length; i++) samples[i] = pcm[i]/32768;
          const node = context.createBufferSource();
          node.buffer = buffer;
          node.connect(output);
          node.start(nextTime);
          nextTime += buffer.duration;
          report.framesFromServer++;
          report.bytesFromServer += event.data.byteLength;
        };
      });
      await sender.replaceTrack(output.stream.getAudioTracks()[0]);
      report.replaced = true;
      await Promise.race([finished, new Promise(resolve=>setTimeout(resolve,8000))]);
      report.connectionAtEnd = pc.connectionState;
    } catch (error) { report.error = String(error?.name ?? 'Error') + ':' + String(error?.message ?? ''); }
    finally {
      try { if (sender.track !== original) await sender.replaceTrack(original); report.restored = sender.track === original; } catch {}
      try { processor?.disconnect(); source?.disconnect(); gain?.disconnect(); output?.disconnect(); } catch {}
      try { ws?.close(); } catch {}
      try { await context?.close(); } catch {}
    }
    return report;
  });
} catch(error) { result.error = String(error?.name ?? 'Error') + ':' + String(error?.message ?? ''); }
finally {
  const hangup = page.locator('svg[aria-label="Call End"]');
  if (result.started && await hangup.count() === 1) { await hangup.click(); await page.waitForTimeout(1200); result.ended = await hangup.count() === 0; }
  console.log(JSON.stringify(result,null,2));
  await browser.close();
}
