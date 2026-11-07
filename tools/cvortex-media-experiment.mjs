import { chromium } from 'playwright';

const phone = process.argv[2];
if (!/^\d{10,11}$/.test(phone ?? '')) throw new Error('Número de teste inválido.');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://amorsaude.cvortex.com/'));
if (!page) throw new Error('A aba cVortex não está aberta.');
const result = { started: false, ended: false, phases: [], webrtc: null, audioElements: null, stats: null, test: null };
await page.addInitScript(() => {
  window.__mediaProbe = { pcs: [], gum: [] };
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(NativePC, {
    construct(target, args) {
      const pc = Reflect.construct(target, args);
      window.__mediaProbe.pcs.push({ pc, createdAt: performance.now() });
      return pc;
    },
  });
  if (navigator.mediaDevices?.getUserMedia) {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      window.__mediaProbe.gum.push({ stream, at: performance.now(), audio: Boolean(constraints?.audio), video: Boolean(constraints?.video) });
      return stream;
    };
  }
});
try {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.locator('svg[aria-label="Navigation Menu Vertical"]').first().click();
  await page.getByText('Ligar para um Colaborador', { exact: true }).click();
  await page.getByPlaceholder('Digite apenas números').fill(phone);
  await page.locator('button[title="Ligar para o número"]').last().click();
  result.started = true;
  result.phases.push('discagem');
  await page.waitForTimeout(8000);
  const pre = await page.evaluate(async () => {
    const pcs = window.__mediaProbe?.pcs ?? [];
    const pc = pcs.map(x => x.pc).find(x => x.connectionState === 'connected' && x.getSenders().some(s => s.track?.kind === 'audio'));
    if (!pc) return { found: false, count: pcs.length };
    window.__activePc = pc;
    const senders = pc.getSenders().filter(x => x.track?.kind === 'audio');
    const receivers = pc.getReceivers().filter(x => x.track?.kind === 'audio');
    const transceivers = pc.getTransceivers().map(x => ({ mid: x.mid, direction: x.direction, currentDirection: x.currentDirection, senderKind: x.sender.track?.kind ?? null, receiverKind: x.receiver.track?.kind ?? null }));
    const originalMic = senders[0]?.track;
    window.__originalMic = originalMic;
    window.__activeSender = senders[0];
    const remote = receivers[0]?.track;
    let pipelinePossible = false;
    if (remote) {
      const copy = new MediaStream([remote]);
      const context = new AudioContext();
      const source = context.createMediaStreamSource(copy);
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(sink);
      pipelinePossible = copy.getAudioTracks().length === 1 && Boolean(source);
      await context.close();
    }
    const audioElements = [...document.querySelectorAll('audio')].map(el => ({ hasSrcObject: Boolean(el.srcObject), srcObjectType: el.srcObject?.constructor?.name ?? null, tracks: el.srcObject instanceof MediaStream ? el.srcObject.getTracks().map(t => t.kind) : [], muted: el.muted, volume: el.volume, autoplay: el.autoplay, paused: el.paused }));
    const gumTracks = window.__mediaProbe.gum.flatMap(x => x.stream.getAudioTracks());
    const stats = await pc.getStats();
    const rtp = [...stats.values()].filter(x => ['inbound-rtp','outbound-rtp'].includes(x.type) && x.kind === 'audio').map(x => ({ direction: x.type, packets: x.packetsReceived ?? x.packetsSent ?? 0, bytes: x.bytesReceived ?? x.bytesSent ?? 0, jitter: x.jitter ?? null, packetsLost: x.packetsLost ?? null, codec: stats.get(x.codecId)?.mimeType ?? null, clockRate: stats.get(x.codecId)?.clockRate ?? null, channels: stats.get(x.codecId)?.channels ?? null }));
    return { found: true, count: pcs.length, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, signalingState: pc.signalingState, senders: senders.map(s => ({ kind:s.track.kind, enabled:s.track.enabled, readyState:s.track.readyState, fromGetUserMedia:gumTracks.includes(s.track) })), receivers: receivers.map(r => ({ kind:r.track.kind, enabled:r.track.enabled, readyState:r.track.readyState })), transceivers, pipelinePossible, audioElements, rtp };
  });
  result.webrtc = pre;
  result.phases.push('tracks-inspecionadas');
  if (!pre.found || !pre.senders.length || !pre.receivers.length) throw new Error('Sender ou receiver de áudio não identificado.');
  result.test = await page.evaluate(async () => {
    const sender = window.__activeSender;
    const mic = window.__originalMic;
    const pc = window.__activePc;
    const initialMicEnabled = mic.enabled;
    const report = { muteReversible: false, replaceSucceeded: false, audioContextState: null, replacementKind: null, connectionDuringReplacement: null, restored: false, renegotiationObserved: false, error: null };
    const initialSignaling = pc.signalingState;
    let audioContext;
    try {
      mic.enabled = false;
      await new Promise(resolve => setTimeout(resolve, 500));
      mic.enabled = initialMicEnabled;
      report.muteReversible = mic.enabled === initialMicEnabled;
      audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.type = 'sine';
      oscillator.frequency.value = 440;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(destination);
      await audioContext.resume();
      report.audioContextState = audioContext.state;
      const testTrack = destination.stream.getAudioTracks()[0];
      report.replacementKind = testTrack.kind;
      oscillator.start();
      await sender.replaceTrack(testTrack);
      report.replaceSucceeded = sender.track === testTrack;
      await new Promise(resolve => setTimeout(resolve, 3500));
      report.connectionDuringReplacement = pc.connectionState;
      report.renegotiationObserved = pc.signalingState !== initialSignaling;
      await sender.replaceTrack(mic);
      report.restored = sender.track === mic && mic.enabled === initialMicEnabled;
      oscillator.stop();
    } catch (error) {
      report.error = String(error?.name ?? 'Error');
      try { if (sender?.track !== mic) await sender.replaceTrack(mic); mic.enabled = initialMicEnabled; report.restored = sender.track === mic; } catch { /* best effort */ }
    } finally {
      if (audioContext) await audioContext.close();
    }
    return report;
  });
  result.phases.push('replace-track-concluido');
  result.stats = await page.evaluate(async () => {
    const stats = await window.__activePc.getStats();
    return [...stats.values()].filter(x => ['inbound-rtp','outbound-rtp'].includes(x.type) && x.kind === 'audio').map(x => ({ direction:x.type, packets:x.packetsReceived ?? x.packetsSent ?? 0, bytes:x.bytesReceived ?? x.bytesSent ?? 0, codec:stats.get(x.codecId)?.mimeType ?? null, clockRate:stats.get(x.codecId)?.clockRate ?? null }));
  });
} finally {
  try {
    await page.evaluate(async () => { if (window.__activeSender && window.__originalMic && window.__activeSender.track !== window.__originalMic) await window.__activeSender.replaceTrack(window.__originalMic); if (window.__originalMic) window.__originalMic.enabled = true; });
  } catch { /* best effort */ }
  const hangup = page.locator('svg[aria-label="Call End"]');
  if (result.started && await hangup.count() === 1) {
    await hangup.click();
    await page.waitForTimeout(1200);
    result.ended = await hangup.count() === 0;
  }
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
