export type CallStatus = 'idle' | 'connecting' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled'
export type CallPhase = 'IDLE' | 'DIALING' | 'RINGING' | 'IN_PROGRESS' | 'ENDED' | 'ERROR'
export interface Brain { id: string; name: string; slug: string; description: string | null; objective: string | null; systemPrompt: string | null; elevenlabsAgentId: string | null; voiceName: string | null; isActive: boolean }
export interface Call { id: string; brainId: string; patientName: string; phone: string; status: CallStatus; provider?: 'cvortex'; cvortexCallId?: string | null; elevenlabsConversationId?: string | null; startedAt?: string | null; answeredAt?: string | null; endedAt?: string | null; durationSeconds?: number | null; result?: string | null; transferRequested?: boolean; summary?: Record<string, unknown> | null; metadata?: Record<string,unknown> | null; createdAt?: string }
export interface IntegrationStatus { cvortex: boolean; elevenlabs: boolean; database: boolean; n8n: boolean; liveMonitoring: boolean; browserTakeover: boolean }
export interface ConnectionDetails { cvortex: { browserOpen: boolean; loggedIn: boolean; activeCall: boolean }; elevenlabs: { keyConfigured: boolean; keyValid: boolean | null; agentId: string | null } }
export type Result = 'interested' | 'not_interested' | 'callback' | 'do_not_contact' | 'unknown'
