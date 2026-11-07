/**
 * Escuta ao vivo para o operador autenticado. O áudio passa apenas em memória:
 * nada é gravado nem persistido. Sem ouvintes, publicar não custa nada.
 */
export type LiveSource = 'patient' | 'agent';
export type LiveEvent =
  | { kind: 'audio'; source: LiveSource; pcm: Buffer }
  | { kind: 'text'; role: LiveSource; text: string; correction?: boolean }
  | { kind: 'flush' };
type Listener = (event: LiveEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeLive(callId: string, listener: Listener): () => void {
  const set = listeners.get(callId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(callId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(callId);
  };
}

export function publishLive(callId: string, event: LiveEvent): void {
  const set = listeners.get(callId);
  if (!set) return;
  for (const listener of set) {
    try { listener(event); } catch (error) { console.error('[LIVE] listener failed', error); }
  }
}

export function hasLiveListeners(callId: string): boolean {
  return Boolean(listeners.get(callId)?.size);
}
