export type CallStatus = 'idle' | 'connecting' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled' | 'voicemail'
export interface CallTranscriptTurn { role: 'patient' | 'agent'; message: string; timeInCallSecs: number }
export interface CallTranscript { transcript: CallTranscriptTurn[]; hasAudio: boolean; terminationReason: string | null; callSuccessful: string | null }
export type CallPhase = 'IDLE' | 'DIALING' | 'RINGING' | 'IN_PROGRESS' | 'ENDED' | 'ERROR'
export interface Brain { id: string; name: string; slug: string; description: string | null; objective: string | null; systemPrompt: string | null; elevenlabsAgentId: string | null; voiceName: string | null; isActive: boolean }
export interface Call { id: string; brainId: string; patientName: string; phone: string; status: CallStatus; provider?: 'cvortex'; cvortexCallId?: string | null; elevenlabsConversationId?: string | null; startedAt?: string | null; answeredAt?: string | null; endedAt?: string | null; durationSeconds?: number | null; result?: string | null; transferRequested?: boolean; summary?: Record<string, unknown> | null; metadata?: Record<string,unknown> | null; createdAt?: string; flagged?: boolean; flagReason?: string | null }
export interface IntegrationStatus { cvortex: boolean; elevenlabs: boolean; database: boolean; n8n: boolean; liveMonitoring: boolean; browserTakeover: boolean }
export interface ConnectionDetails { cvortex: { browserOpen: boolean; loggedIn: boolean; activeCall: boolean }; elevenlabs: { keyConfigured: boolean; keyValid: boolean | null; agentId: string | null } }
export type Result = 'interested' | 'not_interested' | 'callback' | 'do_not_contact' | 'unknown'

export interface Contact { id: string; name: string; phone: string; doNotContact: boolean; source: 'manual' | 'planilha' | 'cartao_de_todos' | 'ligacao'; notes: string | null; createdAt: string; lastCallAt: string | null; lastResult: Result | null; callCount: number }
export interface ImportReport { imported: number; duplicates: number; invalid: { line: number; reason: string }[]; invalidCount: number }
export interface MessageTemplate { id: string; slug: string; name: string; whenToUse: string; body: string; isActive: boolean }
export interface WhatsappMessage { id: string; callId: string | null; templateSlug: string | null; patientName: string | null; phone: string; body: string; source: 'ia' | 'teste'; status: 'queued' | 'sent' | 'failed'; error: string | null; createdAt: string; sentAt: string | null }
export interface ConfirmRow { appointmentId: string; date: string; time: string; patientName: string; patientSocial: string; age: number | null; phone: string; professional: string; specialty: string; procedure: string; value: string; status: string; statusId: number; channel: string; note: string }
export type RecoveryStatus = 'reagendado' | 'recuperado' | 'outra_especialidade' | 'nova_falta' | 'reagendamento_cancelado' | 'pendente' | 'conferir'
export interface AvailabilitySummary { count: number; next: Array<{ date: string; time: string; professional: string }>; professionalOnly: boolean }
export interface RecoveryInfo { status: RecoveryStatus; label: string; next?: { date: string; time: string; specialty: string }; availability?: AvailabilitySummary }
export interface ConfirmOptions { specialties: { id: string; name: string }[]; statuses: { id: number; name: string }[] }
export interface AutoConfirmStatus { active: boolean; current: string | null; currentCallId: string | null; remaining: number; calledCount: number; lastError: string | null; startedAt: string | null }
export interface ReactivationSummary { total: number; notCalledYet: number; called: number; answered: number; noAnswer: number; voicemail: number; interested: number; notInterested: number; unclassified: number }
export type CampaignMode = 'faltosos' | 'lista_espera' | 'cartao'
export interface CampaignRow {
  id: string; mode: CampaignMode; patientId: string; patientName: string; phone: string;
  specialty: string; specialtyId: string; professional?: string; professionalId?: string;
  originDate: string; situation?: 'faltou' | 'desmarcou' | 'cancelada';
  recoveryStatus: RecoveryStatus; availability?: AvailabilitySummary;
  cardStatus?: 'ativo' | 'devendo' | 'sem_cartao' | 'nao_conferido';
  /** modo 'cartao': valor pago como particular */
  value?: string;
}
export interface CampaignJobStatus { jobId: string; status: 'running' | 'done' | 'error'; checked: number; total: number; found: number; results: CampaignRow[]; truncated: boolean; error?: string }
export interface AmeiStatus { browserOpen: boolean; loggedIn: boolean; user?: string }
export interface WhatsappStatus { browserOpen: boolean; loggedIn: boolean; qrVisible: boolean; busy: boolean }
