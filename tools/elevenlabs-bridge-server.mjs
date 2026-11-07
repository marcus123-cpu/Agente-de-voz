import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';
import WebSocket, { WebSocketServer } from 'ws';

const env = dotenv.parse(readFileSync(new URL('../server/.env', import.meta.url)));
const apiKey = env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID ?? env.ELEVENLABS_AGENT_ID;
const testName = process.env.CVORTEX_TEST_NAME;
if (!apiKey) throw new Error('ElevenLabs API key não configurada.');
if (!agentId) throw new Error('ELEVENLABS_AGENT_ID não configurado.');
const wss = new WebSocketServer({ host:'127.0.0.1', port:8767, verifyClient: ({ origin }) => origin === 'https://amorsaude.cvortex.com' });
const metrics = { browserFramesIn:0, browserBytesIn:0, agentAudioFramesOut:0, agentAudioBytesOut:0, agentEvents:{}, agentOutputFormat:null, userInputFormat:null, firstAgentAudioMs:null, firstUserTranscriptMs:null, agentReplyAfterTranscriptMs:null, error:null };

wss.on('connection', browser => {
  let agent;
  let startedAt;
  let firstTranscriptAt;
  browser.on('message', async (payload, isBinary) => {
    if (isBinary) {
      metrics.browserFramesIn++;
      metrics.browserBytesIn += payload.length;
      if (agent?.readyState === WebSocket.OPEN && metrics.userInputFormat === 'pcm_16000') {
        agent.send(JSON.stringify({ user_audio_chunk: Buffer.from(payload).toString('base64') }));
      }
      return;
    }
    let control;
    try { control = JSON.parse(payload.toString()); } catch { return; }
    if (control.type !== 'start' || agent) return;
    try {
      const auth = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, { headers:{ 'xi-api-key':apiKey }, signal:AbortSignal.timeout(10000) });
      if (!auth.ok) throw new Error(`SignedUrlHTTP${auth.status}`);
      const { signed_url: signedUrl } = await auth.json();
      if (!signedUrl?.startsWith('wss://api.elevenlabs.io/')) throw new Error('InvalidSignedUrl');
      startedAt = performance.now();
      agent = new WebSocket(signedUrl);
      agent.on('open', () => {
        agent.send(JSON.stringify({ type:'conversation_initiation_client_data', dynamic_variables: testName ? { patient_name:testName } : {} }));
        browser.send(JSON.stringify({ type:'agent-connected' }));
      });
      agent.on('message', data => {
        let item;
        try { item = JSON.parse(data.toString()); } catch { return; }
        metrics.agentEvents[item.type] = (metrics.agentEvents[item.type] ?? 0) + 1;
        if (item.type === 'conversation_initiation_metadata') {
          metrics.agentOutputFormat = item.conversation_initiation_metadata_event?.agent_output_audio_format ?? null;
          metrics.userInputFormat = item.conversation_initiation_metadata_event?.user_input_audio_format ?? null;
          browser.send(JSON.stringify({ type:'format', output:metrics.agentOutputFormat, input:metrics.userInputFormat }));
        }
        if (item.type === 'ping' && item.ping_event?.event_id != null) agent.send(JSON.stringify({ type:'pong', event_id:item.ping_event.event_id }));
        if (item.type === 'user_transcript') {
          firstTranscriptAt ??= performance.now();
          metrics.firstUserTranscriptMs ??= Math.round(firstTranscriptAt-startedAt);
        }
        if (item.type === 'audio' && item.audio_event?.audio_base_64) {
          const raw = Buffer.from(item.audio_event.audio_base_64, 'base64');
          metrics.agentAudioFramesOut++;
          metrics.agentAudioBytesOut += raw.length;
          metrics.firstAgentAudioMs ??= Math.round(performance.now()-startedAt);
          if (firstTranscriptAt && metrics.agentReplyAfterTranscriptMs == null) metrics.agentReplyAfterTranscriptMs = Math.round(performance.now()-firstTranscriptAt);
          if (browser.readyState === WebSocket.OPEN) browser.send(raw, { binary:true });
        }
      });
      agent.on('error', error => { metrics.error = error?.name ?? 'AgentWebSocketError'; });
      agent.on('close', code => { if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type:'agent-closed', code })); });
    } catch(error) {
      metrics.error = error?.message ?? 'AgentConnectionError';
      if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type:'error', reason:metrics.error }));
    }
  });
  browser.on('close', () => {
    if (agent?.readyState === WebSocket.OPEN) agent.close();
    console.log(JSON.stringify(metrics));
    wss.close();
  });
});
console.log('ElevenLabs bridge ready on 127.0.0.1:8767');
