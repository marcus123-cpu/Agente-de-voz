export type CallStatus = 'idle' | 'connecting' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled';
export type CallResult = 'interested' | 'not_interested' | 'callback' | 'do_not_contact' | 'unknown';

export interface Brain {
  id: string; name: string; slug: string; description: string | null; objective: string | null;
  systemPrompt: string | null; elevenlabsAgentId: string | null; voiceName: string | null; isActive: boolean;
}
export interface Call {
  id: string; brainId: string; patientName: string; phone: string; status: CallStatus;
  provider: 'cvortex'; cvortexCallId: string | null; elevenlabsConversationId: string | null;
  startedAt: string | null; answeredAt: string | null; endedAt: string | null;
  durationSeconds: number | null; result: CallResult | null; transferRequested: boolean;
  summary: Record<string, unknown> | null; metadata: Record<string, unknown> | null; createdAt: string;
}
