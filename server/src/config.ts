import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3001),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  operatorPassword: process.env.OPERATOR_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsAgentId: process.env.ELEVENLABS_AGENT_ID || '',
  elevenLabsWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || '',
  cvortexUrl: process.env.CVORTEX_URL || 'https://amorsaude.cvortex.com/crm/csm/case',
  cvortexCdpUrl: process.env.CVORTEX_CDP_URL || 'http://127.0.0.1:9223',
  cvortexBridgePort: Number(process.env.CVORTEX_BRIDGE_PORT || 8767),
  n8nUrl: process.env.N8N_WEBHOOK_CALL_COMPLETED_URL || '',
  enableN8n: process.env.ENABLE_N8N === 'true',
  browserTakeover: false,
  production: process.env.NODE_ENV === 'production',
};
