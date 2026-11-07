import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
const env = dotenv.parse(readFileSync('server/.env'));
const headers = { 'xi-api-key': env.ELEVENLABS_API_KEY };
const agentId = env.ELEVENLABS_AGENT_ID;
const branchId = 'agtbrch_2401m6skckk2fj2rdhfc3htf3j05';
const [agentResponse, voicesResponse] = await Promise.all([
  fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}?branch_id=${branchId}`, { headers }),
  fetch('https://api.elevenlabs.io/v2/voices?gender=female&language=pt&page_size=100&include_live_moderated=false', { headers }),
]);
const agent = await agentResponse.json();
const voices = await voicesResponse.json();
console.log(JSON.stringify({
  agentStatus: agentResponse.status,
  voicesStatus: voicesResponse.status,
  current: { name: agent.name, voiceId: agent.conversation_config?.tts?.voice_id, model: agent.conversation_config?.tts?.model_id, language: agent.conversation_config?.agent?.language, firstMessage: agent.conversation_config?.agent?.first_message, prompt: agent.conversation_config?.agent?.prompt?.prompt, workflow: Boolean(agent.workflow) },
  voiceCount: voices.voices?.length,
  voices: voices.voices?.slice(0, 20).map(v => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels, fineTuning: v.fine_tuning?.language, preview: Boolean(v.preview_url) })),
  detail: voices.detail,
  workflowNodes: agent.workflow?.nodes?.map(n => ({ id: n.id, type: n.type, label: n.label, prompt: n.data?.prompt?.prompt || n.data?.prompt || null, overrideAgent: n.data?.override_agent || null })),
}, null, 2));
