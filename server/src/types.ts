export type CallStatus = 'idle' | 'connecting' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled' | 'voicemail';
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
  transcript: TranscriptTurn[] | null; flagged: boolean; flagReason: string | null;
}
export interface TranscriptTurn { role: 'agent' | 'patient'; message: string; timeInCallSecs: number }

export type ContactSource = 'manual' | 'planilha' | 'cartao_de_todos' | 'ligacao';
export interface Contact {
  id: string; name: string; phone: string; doNotContact: boolean; source: ContactSource;
  notes: string | null; createdAt: string; lastCallAt: string | null; lastResult: CallResult | null; callCount: number;
}

export interface MessageTemplate { id: string; slug: string; name: string; whenToUse: string; body: string; isActive: boolean }
export interface WhatsappMessage {
  id: string; callId: string | null; templateSlug: string | null; patientName: string | null; phone: string; body: string;
  source: 'ia' | 'teste'; status: 'queued' | 'sent' | 'failed'; error: string | null; createdAt: string; sentAt: string | null;
}
