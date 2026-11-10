import type { Brain, Call, CallTranscript, ConnectionDetails, Contact, ImportReport, IntegrationStatus, MessageTemplate, Result, WhatsappMessage, WhatsappStatus, AmeiStatus, ConfirmOptions, ConfirmRow, RecoveryInfo, CampaignMode, CampaignJobStatus, AutoConfirmStatus } from './types'

export const apiBase = import.meta.env.VITE_API_BASE_URL || ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...init?.headers }, ...init })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `Erro HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

function unpackList<T>(value: T[] | { data?: T[]; brains?: T[]; calls?: T[] }): T[] {
  if (Array.isArray(value)) return value
  return value.data || value.brains || value.calls || []
}

export const api = {
  brains: async () => unpackList(await request<Brain[] | { brains: Brain[] }>('/api/brains')),
  createBrain: async (values: Partial<Brain>) => (await request<{ brain: Brain }>('/api/brains', { method: 'POST', body: JSON.stringify(values) })).brain,
  updateBrain: async (id: string, patch: Partial<Brain>) => (await request<{ brain: Brain }>(`/api/brains/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).brain,
  calls: async () => unpackList(await request<Call[] | { calls: Call[] }>('/api/calls')),
  call: async (id: string) => {
    const value = await request<Call | { call: Call }>(`/api/calls/${id}`)
    return 'call' in value ? value.call : value
  },
  startCall: async (brainId: string, patientName: string, phone: string, contactContext: 'not_informed' | 'recent_card_member') => {
    const value = await request<{ success: true; call: Call } | Call>('/api/calls', { method: 'POST', body: JSON.stringify({ brainId, patientName, phone, contactContext }) })
    return 'call' in value ? value.call : value
  },
  endCall: (id: string) => request<unknown>(`/api/calls/${id}/end`, { method: 'POST' }),
  takeoverCall: async (id: string) => (await request<{ call: Call }>(`/api/calls/${id}/takeover`, { method: 'POST' })).call,
  markCallAnswered: (id: string) => request<unknown>(`/api/calls/${id}/answered`, { method: 'POST' }),
  markCallVoicemail: async (id: string) => (await request<{ call: Call }>(`/api/calls/${id}/voicemail`, { method: 'POST' })).call,
  saveResult: (id: string, result: Result, note: string) => request<unknown>(`/api/calls/${id}/result`, { method: 'PATCH', body: JSON.stringify({ result, note }) }),
  callTranscript: (id: string) => request<CallTranscript>(`/api/calls/${id}/transcript`),
  callAudioUrl: (id: string) => `${apiBase}/api/calls/${id}/audio`,
  integrations: () => request<IntegrationStatus>('/api/settings/status'),
  connections: () => request<ConnectionDetails>('/api/connections'),
  openCvortex: () => request<{ opening: boolean }>('/api/connections/cvortex/open', { method: 'POST' }),
  connectElevenLabs: (apiKey: string) => request<ConnectionDetails>('/api/connections/elevenlabs', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  disconnectElevenLabs: () => request<ConnectionDetails>('/api/connections/elevenlabs', { method: 'DELETE' }),
  contacts: async () => (await request<{ contacts: Contact[] }>('/api/contacts')).contacts,
  createContact: async (values: { name: string; phone: string; notes: string | null }) => (await request<{ contact: Contact }>('/api/contacts', { method: 'POST', body: JSON.stringify(values) })).contact,
  updateContact: async (id: string, patch: { name?: string; phone?: string; notes?: string | null; doNotContact?: boolean }) => (await request<{ contact: Contact }>(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).contact,
  deleteContact: (id: string) => request<unknown>(`/api/contacts/${id}`, { method: 'DELETE' }),
  importContacts: (rows: { name: string; phone: string }[]) => request<ImportReport>('/api/contacts/import', { method: 'POST', body: JSON.stringify({ rows }) }),
  templates: async () => (await request<{ templates: MessageTemplate[] }>('/api/automations/templates')).templates,
  createTemplate: async (values: { name: string; whenToUse: string; body: string; isActive: boolean }) => (await request<{ template: MessageTemplate }>('/api/automations/templates', { method: 'POST', body: JSON.stringify(values) })).template,
  updateTemplate: async (id: string, patch: { name?: string; whenToUse?: string; body?: string; isActive?: boolean }) => (await request<{ template: MessageTemplate }>(`/api/automations/templates/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).template,
  deleteTemplate: (id: string) => request<unknown>(`/api/automations/templates/${id}`, { method: 'DELETE' }),
  whatsappStatus: () => request<WhatsappStatus>('/api/whatsapp/status'),
  confirmOptions: () => request<ConfirmOptions>('/api/amei/confirm/options'),
  confirmProfessionals: async (specialtyId: string) => (await request<{ professionals: { id: string; name: string }[] }>(`/api/amei/confirm/professionals?specialtyId=${encodeURIComponent(specialtyId)}`)).professionals,
  confirmList: (filters: { dateInit: string; dateFinish: string; statusId: number; specialtyId?: string; professionalId?: string }) => {
    const query = new URLSearchParams({ dateInit: filters.dateInit, dateFinish: filters.dateFinish, statusId: String(filters.statusId) })
    if (filters.specialtyId) query.set('specialtyId', filters.specialtyId)
    if (filters.professionalId) query.set('professionalId', filters.professionalId)
    return request<{ rows: ConfirmRow[]; total: number }>(`/api/amei/confirm/list?${query}`)
  },
  confirmCall: async (brainId: string, appointmentId: string) => (await request<{ success: true; call: Call }>('/api/amei/confirm/call', { method: 'POST', body: JSON.stringify({ brainId, appointmentId }) })).call,
  startAutoConfirm: (filters: { brainId: string; dateInit: string; dateFinish: string; specialtyId?: string; professionalId?: string; startFromAppointmentId?: string; startFromDirection?: 'up' | 'down' }) => request<AutoConfirmStatus>('/api/amei/confirm/auto/start', { method: 'POST', body: JSON.stringify(filters) }),
  stopAutoConfirm: () => request<AutoConfirmStatus>('/api/amei/confirm/auto/stop', { method: 'POST' }),
  autoConfirmStatus: () => request<AutoConfirmStatus>('/api/amei/confirm/auto/status'),
  confirmRecovery: (appointmentId: string) => request<RecoveryInfo>(`/api/amei/confirm/recovery/${appointmentId}`),
  confirmTest: async (brainId: string, body: { kind?: 'confirm' | 'missed' | 'waitlist'; situation?: string; phone: string; patientName: string; professional?: string; specialty: string; date?: string; time?: string; valor?: string }) => (await request<{ success: true; call: Call }>('/api/amei/confirm/test', { method: 'POST', body: JSON.stringify({ brainId, ...body }) })).call,
  missedCall: async (brainId: string, appointmentId: string) => (await request<{ success: true; call: Call }>('/api/amei/missed/call', { method: 'POST', body: JSON.stringify({ brainId, appointmentId }) })).call,
  waitlistCall: async (brainId: string, waitlistId: string) => (await request<{ success: true; call: Call }>('/api/amei/captacao/call', { method: 'POST', body: JSON.stringify({ brainId, waitlistId }) })).call,
  startCampaignSearch: (filters: { mode: CampaignMode; specialtyId: string; professionalId?: string; monthFrom: string; monthTo: string }) => request<{ jobId: string }>('/api/amei/captacao/search', { method: 'POST', body: JSON.stringify(filters) }),
  campaignSearchStatus: (jobId: string) => request<CampaignJobStatus>(`/api/amei/captacao/search/${jobId}`),
  ameiStatus: () => request<AmeiStatus>('/api/amei/status'),
  openAmei: () => request<{ opening: boolean }>('/api/amei/open', { method: 'POST' }),
  openWhatsapp: () => request<{ opening: boolean }>('/api/whatsapp/open', { method: 'POST' }),
  whatsappMessages: async () => (await request<{ messages: WhatsappMessage[] }>('/api/whatsapp/messages')).messages,
  testWhatsapp: (templateId: string, phone: string) => request<{ queued: boolean }>('/api/whatsapp/test', { method: 'POST', body: JSON.stringify({ templateId, phone }) }),
  session: () => request<{ authenticated: boolean }>('/api/auth/session'),
  login: (password: string) => request<unknown>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),
}
