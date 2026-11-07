import type { Brain, Call, ConnectionDetails, IntegrationStatus, Result } from './types'

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
  saveResult: (id: string, result: Result, note: string) => request<unknown>(`/api/calls/${id}/result`, { method: 'PATCH', body: JSON.stringify({ result, note }) }),
  integrations: () => request<IntegrationStatus>('/api/settings/status'),
  connections: () => request<ConnectionDetails>('/api/connections'),
  openCvortex: () => request<{ opening: boolean }>('/api/connections/cvortex/open', { method: 'POST' }),
  connectElevenLabs: (apiKey: string) => request<ConnectionDetails>('/api/connections/elevenlabs', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  disconnectElevenLabs: () => request<ConnectionDetails>('/api/connections/elevenlabs', { method: 'DELETE' }),
  session: () => request<{ authenticated: boolean }>('/api/auth/session'),
  login: (password: string) => request<unknown>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),
}
