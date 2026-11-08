import { chromium, type Browser, type Page } from 'playwright';

/**
 * Integração SOMENTE LEITURA com a AMEI (agenda da clínica de Fernandópolis).
 * Usa a sessão já logada numa aba do mesmo navegador do cVortex (CDP 9223): as chamadas da API
 * saem de dentro da página, então nenhuma senha ou cookie é lido, guardado ou exibido.
 */
const CDP_URL = process.env.CVORTEX_CDP_URL || 'http://127.0.0.1:9223';
const AMEI_ORIGIN = 'https://amei.amorsaude.com.br';
const CLINIC_ID = '1795'; // AmorSaúde Fernandópolis
const TZ = 'America/Sao_Paulo';

export interface AmeiStatus { browserOpen: boolean; loggedIn: boolean; user?: string }
export class AmeiError extends Error {}
/** A AMEI respondeu 401/403: a sessão da aba venceu (tentamos renovar sozinhos antes de avisar). */
class AmeiAuthError extends AmeiError {}

const norm = (value: unknown): string => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const digits = (value: unknown): string => String(value ?? '').replace(/\D/g, '');

/** Data e hora de agora em Brasília, no formato AAAA-MM-DD e HH:MM. */
function nowBr(offsetDays = 0): { date: string; time: string } {
  const at = new Date(Date.now() + offsetDays * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function spoken(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${weekday} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}
const toIso = (value: unknown): string | null => {
  const text = String(value ?? '');
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
};
const toHour = (value: unknown): string | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
};

/** A AMEI deixa de responder se a aba ficar parada: recarregamos a aba a cada poucos minutos (F5 automático). */
const KEEPALIVE_MS = Math.max(60_000, Number(process.env.AMEI_KEEPALIVE_MS) || 120_000);

class AmeiProvider {
  private browser: Browser | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private inFlight = 0;

  private lastRefresh = 0;

  constructor() { this.startKeepAlive(); }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => { void this.refresh(false); }, KEEPALIVE_MS);
    this.keepAliveTimer.unref();
  }

  /**
   * Recarrega a aba da AMEI (F5) para a sessão não vencer, como faz o bot antigo: recarrega a página e, se cair
   * no login, abre a Home para o SSO renovar sozinho. Consultas esperam o fim da recarga.
   * `force` ignora consultas em andamento (usado depois de um 401).
   */
  private async refresh(force: boolean): Promise<void> {
    if (this.refreshing) { await this.refreshing; return; }
    if (!force && this.inFlight > 0) return;
    this.refreshing = (async () => {
      try {
        const page = await this.findPage(false);
        if (!page) return;
        if (page.url().startsWith(AMEI_ORIGIN)) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!page.url().startsWith(AMEI_ORIGIN)) await page.goto(`${AMEI_ORIGIN}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (page.url().startsWith(AMEI_ORIGIN)) await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
        this.lastRefresh = Date.now();
      } catch (error) { console.error('[AMEI] recarga automática falhou:', error instanceof Error ? error.message : error); }
      finally { this.refreshing = null; }
    })();
    await this.refreshing;
  }

  /** Antes de usar a AMEI, garante que a aba foi recarregada há menos de um intervalo. */
  private async ensureFresh(): Promise<void> {
    if (this.refreshing) { await this.refreshing; return; }
    if (Date.now() - this.lastRefresh > KEEPALIVE_MS) await this.refresh(false);
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser?.isConnected()) this.browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
    return this.browser;
  }

  private async findPage(create: boolean): Promise<Page | null> {
    const browser = await this.getBrowser();
    const context = browser.contexts()[0];
    if (!context) return null;
    const candidates = context.pages().filter(p => !p.isClosed() && (p.url().startsWith(AMEI_ORIGIN) || p.url().startsWith('https://id.amorsaude.com.br')));
    const existing = candidates.find(p => p.url().startsWith(AMEI_ORIGIN)) ?? candidates[0];
    if (existing || !create) return existing ?? null;
    const page = await context.newPage();
    await page.goto(AMEI_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return page;
  }

  /** GET na API da AMEI dentro da página logada. */
  async get<T = unknown>(path: string): Promise<T> {
    await this.ensureFresh();
    this.inFlight += 1;
    try { return await this.getNow<T>(path); }
    catch (error) {
      if (!(error instanceof AmeiAuthError)) throw error;
      this.inFlight -= 1; await this.refresh(true); this.inFlight += 1;   // sessão venceu: renova e tenta uma vez de novo
      return await this.getNow<T>(path);
    }
    finally { this.inFlight -= 1; }
  }

  private async getNow<T>(path: string): Promise<T> {
    let page: Page | null;
    try { page = await this.findPage(false); } catch { throw new AmeiError('O navegador do cVortex está fechado. Abra-o e entre na AMEI.'); }
    if (page && !page.url().startsWith(AMEI_ORIGIN)) throw new AmeiAuthError('A sessão da AMEI expirou. Entre de novo pela aba Automações.');
    if (!page) throw new AmeiError('A AMEI não está conectada. Entre na AMEI pela aba Automações.');
    const result = await page.evaluate(async (url: string) => {
      try {
        const response = await fetch(url, { method: 'GET', credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
        if (response.status === 401 || response.status === 403) return { error: 'auth' as const };
        if (!response.ok) return { error: 'http' as const, status: response.status };
        return { data: await response.json() as unknown };
      } catch { return { error: 'network' as const }; }
    }, path);
    if ('error' in result) {
      if (result.error === 'auth') throw new AmeiAuthError('A sessão da AMEI expirou. Entre de novo pela aba Automações.');
      throw new AmeiError('A AMEI não respondeu agora.');
    }
    return result.data as T;
  }

  /** PUT na API da AMEI dentro da página logada (usado só pela confirmação de consultas). */
  async put<T = unknown>(path: string, body: unknown): Promise<T> { return this.write<T>('PUT', path, body); }
  async post<T = unknown>(path: string, body: unknown): Promise<T> { return this.write<T>('POST', path, body); }

  private async write<T>(method: 'PUT' | 'POST', path: string, body: unknown): Promise<T> {
    await this.ensureFresh();
    this.inFlight += 1;
    try { return await this.putNow<T>(method, path, body); }
    catch (error) {
      if (!(error instanceof AmeiAuthError)) throw error;
      this.inFlight -= 1; await this.refresh(true); this.inFlight += 1;
      return await this.putNow<T>(method, path, body);
    }
    finally { this.inFlight -= 1; }
  }

  private async putNow<T>(method: 'PUT' | 'POST', path: string, body: unknown): Promise<T> {
    let page: Page | null;
    try { page = await this.findPage(false); } catch { throw new AmeiError('O navegador do cVortex está fechado. Abra-o e entre na AMEI.'); }
    if (page && !page.url().startsWith(AMEI_ORIGIN)) throw new AmeiAuthError('A sessão da AMEI expirou. Entre de novo pela aba Automações.');
    if (!page) throw new AmeiError('A AMEI não está conectada. Entre na AMEI pela aba Automações.');
    const result = await page.evaluate(async ({ url, payload, verb }: { url: string; payload: unknown; verb: string }) => {
      try {
        const response = await fetch(url, { method: verb, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
        if (response.status === 401 || response.status === 403) return { error: 'auth' as const };
        const text = await response.text();
        let data: unknown = null;
        try { data = JSON.parse(text); } catch { /* resposta sem JSON */ }
        if (!response.ok) return { error: 'http' as const, status: response.status, message: (data as { mensagem?: string; message?: string } | null)?.mensagem ?? (data as { message?: string } | null)?.message };
        return { data };
      } catch { return { error: 'network' as const }; }
    }, { url: path, payload: body, verb: method });
    if ('error' in result) {
      if (result.error === 'auth') throw new AmeiAuthError('A sessão da AMEI expirou. Entre de novo pela aba Automações.');
      if (result.error === 'http') throw new AmeiError(`A AMEI recusou a alteração${result.message ? `: ${result.message}` : ` (HTTP ${result.status})`}.`);
      throw new AmeiError('A AMEI não respondeu agora.');
    }
    return result.data as T;
  }

  async status(): Promise<AmeiStatus> {
    try {
      let page = await this.findPage(false);
      if (!page) return { browserOpen: true, loggedIn: false };
      if (!page.url().startsWith(AMEI_ORIGIN)) {   // aba parada no login: tenta renovar pela Home (SSO) antes de dizer que caiu
        await this.refresh(true);
        page = await this.findPage(false);
        if (!page || !page.url().startsWith(AMEI_ORIGIN)) return { browserOpen: true, loggedIn: false };
      }
      const info = await this.get<{ userinfo?: { fullName?: string }; tokenInfo?: { fullName?: string } }>('/api/v1/user/current-user-info');
      return { browserOpen: true, loggedIn: true, user: info.userinfo?.fullName ?? info.tokenInfo?.fullName };
    } catch (error) {
      if (error instanceof AmeiError && /expirou|não está conectada/.test(error.message)) return { browserOpen: true, loggedIn: false };
      return { browserOpen: false, loggedIn: false };
    }
  }

  async open(): Promise<void> {
    let page: Page | null;
    try { page = await this.findPage(true); } catch { throw new AmeiError('Abra o navegador do cVortex primeiro (botão Abrir cVortex) e tente de novo.'); }
    await page?.bringToFront();
  }
}

export interface AmeiAdapter { status(): Promise<AmeiStatus>; open(): Promise<void>; get<T = unknown>(path: string): Promise<T>; put<T = unknown>(path: string, body: unknown): Promise<T>; post<T = unknown>(path: string, body: unknown): Promise<T> }
let adapter: AmeiAdapter = new AmeiProvider();
export function setAmeiForTests(value: AmeiAdapter): void { adapter = value; cache.clear(); }
export const ameiStatus = (): Promise<AmeiStatus> => adapter.status();
export const openAmei = (): Promise<void> => adapter.open();

// ─── Cache curto: a AMEI é lenta e a ligação tem poucos segundos de paciência ─────────────────────
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const MINUTE = 60_000;

interface Specialty { id: number | string; nome: string }
interface Professional { id: number | string; nome: string }

async function specialties(): Promise<Specialty[]> {
  return cached('esp', 30 * MINUTE, async () => {
    const data = await adapter.get<Array<{ id: number | string; descricao?: string; ativo?: boolean }>>('/api/v1/especialidades');
    if (!Array.isArray(data)) throw new AmeiError('A AMEI devolveu as especialidades num formato inesperado.');
    return data.filter(e => e.ativo !== false && e.descricao?.trim()).map(e => ({ id: e.id, nome: String(e.descricao).trim() }));
  });
}
async function professionals(specialtyId: number | string): Promise<Professional[]> {
  return cached(`prof:${specialtyId}`, 30 * MINUTE, async () => {
    const data = await adapter.get<Array<{ id: number | string; tratamento?: string; nome?: string; sobrenome?: string; ativo?: boolean }>>(`/api/v1/profissionais/especialidade/${specialtyId}`);
    if (!Array.isArray(data)) throw new AmeiError('A AMEI devolveu os profissionais num formato inesperado.');
    return data.filter(p => p.ativo !== false).map(p => ({ id: p.id, nome: [p.tratamento, p.nome, p.sobrenome].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim() })).filter(p => p.nome);
  });
}

/** Escolhe a especialidade pelo que o paciente disse ("cardio", "dermatologista"...). */
function matchSpecialty(list: Specialty[], wanted: string): Specialty | null {
  const q = norm(wanted).replace(/^(consulta|medico|medica|dr|dra)\s+(de |em |com )?/, '');
  if (!q) return null;
  const stem = (s: string) => s.replace(/(logista|logia|logico|logica|iatra|iatria|ista)$/, '');
  const scored = list.map(item => {
    const name = norm(item.nome);
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q) || q.startsWith(name)) score = 80;
    else if (name.includes(q) || q.includes(name)) score = 60;
    else if (stem(q).length >= 4 && (name.includes(stem(q)) || stem(name).startsWith(stem(q).slice(0, 5)))) score = 40;
    return { item, score };
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.item ?? null;
}

interface FreeSlot { date: string; time: string; professional: string }

/** Horários livres, em ordem, da especialidade (e profissional, se pedido) nos próximos dias. */
export async function ameiFreeSlots(opts: { especialidade: string; profissional?: string; dias?: number; refresh?: boolean }): Promise<string> {
  const list = await specialties();
  const specialty = matchSpecialty(list, opts.especialidade);
  if (!specialty) return `Não encontrei a especialidade "${opts.especialidade}" na agenda. Diga que a equipe confere e retorna.`;
  let team = await professionals(specialty.id);
  if (opts.profissional) {
    const wanted = norm(opts.profissional).replace(/^(dr|dra|doutor|doutora)\.?\s+/, '');
    const filtered = team.filter(p => norm(p.nome).includes(wanted));
    if (!filtered.length) return `Não encontrei "${opts.profissional}" em ${specialty.nome}. Profissionais: ${team.slice(0, 8).map(p => p.nome).join(', ') || 'nenhum cadastrado'}.`;
    team = filtered;
  }
  if (!team.length) return `Não há profissionais de ${specialty.nome} na agenda agora.`;
  team = team.slice(0, 10);

  const days = Math.min(30, Math.max(1, Math.round(Number(opts.dias) || 14)));
  const today = nowBr();
  const initialDate = today.date;
  const finalDate = nowBr(days).date;
  if (opts.refresh) for (const k of [...cache.keys()]) if (k.startsWith(`slots:${specialty.id}:`)) cache.delete(k);
  const key = `slots:${specialty.id}:${team.map(p => p.id).join(',')}:${initialDate}:${days}`;
  const free = await cached(key, 2 * MINUTE, async () => {
    const out: FreeSlot[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < team.length) {
        const professional = team[cursor++]!;
        const qs = new URLSearchParams({ idClinic: CLINIC_ID, idSpecialty: String(specialty.id), idProfessional: String(professional.id), initialDate: initialDate.replaceAll('-', ''), finalDate: finalDate.replaceAll('-', ''), initialHour: '00:00', endHour: '23:59', fetchPolicy: 'network-only', cancelledAppointments: 'false' });
        const data = await adapter.get<Array<{ hours?: Array<{ status?: string; date?: string; formatedHour?: string; idProfessional?: number | string; specialtyId?: number | string }> }>>(`/api/v1/slots/list-slots-by-professional?${qs}`);
        if (!Array.isArray(data)) throw new AmeiError('A AMEI devolveu os horários num formato inesperado.');
        for (const entry of data) for (const hour of entry.hours ?? []) {
          if (norm(hour.status) !== 'livre') continue;
          if (String(hour.idProfessional) !== String(professional.id) || String(hour.specialtyId) !== String(specialty.id)) continue;
          const date = toIso(hour.date), time = toHour(hour.formatedHour);
          if (date && time) out.push({ date, time, professional: professional.nome });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, team.length) }, worker));
    return out;
  });

  // Hoje só vale quem ainda está a mais de 1 hora de distância.
  const [nh, nm] = today.time.split(':').map(Number) as [number, number];
  const limit = `${String(Math.floor((nh * 60 + nm + 60) / 60) % 24).padStart(2, '0')}:${String((nm) % 60).padStart(2, '0')}`;
  const upcoming = free.filter(slot => slot.date > today.date || (slot.date === today.date && slot.time >= limit))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (!upcoming.length) return `Sem horários livres de ${specialty.nome} nos próximos ${days} dias. Diga que a equipe retorna assim que abrir vaga, e registre o interesse.`;

  const first = upcoming.slice(0, 8);
  const byDay = new Map<string, FreeSlot[]>();
  for (const slot of first) { const k = `${slot.date}|${slot.professional}`; byDay.set(k, [...(byDay.get(k) ?? []), slot]); }
  const lines = [...byDay.entries()].map(([k, slots]) => `- ${spoken(k.split('|')[0]!)} com ${slots[0]!.professional}: ${slots.map(s => s.time).join(', ')}`);
  return `Horários livres de ${specialty.nome} (próximos disponíveis, não agende; ofereça no máximo 2 ou 3 e registre a escolha para a equipe confirmar):\n${lines.join('\n')}`;
}

// ─── Consultas do paciente (confirmação) ─────────────────────────────────────────────────────────
interface AppointmentRow { date: string; time: string; professional: string; specialty: string; status: string; name: string; phone: string }

async function upcomingAppointments(): Promise<AppointmentRow[]> {
  const today = nowBr().date;
  return cached(`appts:${today}`, 3 * MINUTE, async () => {
    const statuses = await adapter.get<Array<{ value: number; title: string }>>('/api/v1/status_appointments');
    if (!Array.isArray(statuses) || !statuses.length) throw new AmeiError('A AMEI não devolveu os status das consultas.');
    const titles = new Map(statuses.map(s => [Number(s.value), String(s.title)]));
    const rows: AppointmentRow[] = [];
    let total: number | null = null;
    for (let page = 1; page <= 30; page++) {
      const qs = new URLSearchParams({ dateInit: today.replaceAll('-', ''), dateFinish: nowBr(60).date.replaceAll('-', ''), unitId: CLINIC_ID, page: String(page), limit: '100' });
      for (const s of statuses) qs.append('statusAppointmentId', String(s.value));
      const data = await adapter.get<{ items?: Array<Record<string, unknown>>; meta?: { totalItems?: number } }>(`/api/v1/appointments/confirm/status?${qs}`);
      if (!Array.isArray(data.items) || !Number.isInteger(data.meta?.totalItems)) throw new AmeiError('A AMEI devolveu as consultas num formato inesperado.');
      total = data.meta!.totalItems!;
      for (const item of data.items) {
        const [day, hour] = String(item.dataHoraInicio ?? '').split(/[ T]/);
        const date = toIso(day), time = toHour(hour);
        if (!date || !time) continue;
        rows.push({ date, time, professional: String(item.profissionalNome ?? '').trim(), specialty: String(item.especialidade ?? '').trim(), status: titles.get(Number(item.statusId)) ?? '', name: String(item.pacienteNome ?? '').trim(), phone: digits(item.pacienteCelular) });
      }
      if (rows.length >= total || !data.items.length) break;
    }
    return rows;
  });
}
const samePhone = (a: string, b: string): boolean => {
  const x = digits(a).replace(/^55/, ''), y = digits(b).replace(/^55/, '');
  return x.length >= 10 && y.length >= 10 && x.slice(0, 2) === y.slice(0, 2) && x.slice(-8) === y.slice(-8);
};

/** Próximas consultas ligadas ao telefone da ligação (já como texto para a Giovana falar). */
export async function ameiPatientAppointments(phone: string): Promise<string> {
  const rows = (await upcomingAppointments()).filter(r => samePhone(r.phone, phone))
    .filter(r => !/cancel|desmarc|nao compareceu|faltou|expirad/.test(norm(r.status)))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (!rows.length) return 'Não encontrei consulta marcada para este telefone nos próximos 60 dias. Pergunte se a consulta foi marcada em outro número e, se for o caso, diga que a equipe confere.';
  const lines = rows.slice(0, 4).map(r => `- ${spoken(r.date)} às ${r.time}, ${r.specialty || 'consulta'}${r.professional ? ` com ${r.professional}` : ''} (paciente: ${r.name.split(' ')[0] ?? 'não informado'}; situação na agenda: ${r.status || 'sem status'})`);
  return `Consultas encontradas para este telefone. Confirme o primeiro nome do paciente antes de dar detalhes. Você não altera a agenda: se o paciente confirmar, cancelar ou remarcar, registre com salvar_informacao_contato e diga que a equipe atualiza.\n${lines.join('\n')}`;
}

// ─── Tela "Confirmar agendamento" (lista em tempo real) ──────────────────────────────────────────
export interface ConfirmRow {
  appointmentId: string; date: string; time: string; patientName: string; patientSocial: string; age: number | null;
  phone: string; professional: string; specialty: string; procedure: string; value: string; status: string; statusId: number; channel: string; note: string;
}
export interface ConfirmFilters { dateInit: string; dateFinish: string; statusId?: number; specialtyId?: string; professionalId?: string }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function ageOf(birth: unknown): number | null {
  const iso = toIso(birth);
  if (!iso) return null;
  const today = nowBr().date;
  const years = Number(today.slice(0, 4)) - Number(iso.slice(0, 4)) - (today.slice(5) < iso.slice(5) ? 1 : 0);
  return years >= 0 && years < 130 ? years : null;
}

/** Filtros da tela da AMEI: áreas de atuação e status. */
export async function ameiConfirmOptions(): Promise<{ specialties: Array<{ id: string; name: string }>; statuses: Array<{ id: number; name: string }> }> {
  const [list, statuses] = await Promise.all([
    specialties(),
    cached('statuses', 30 * MINUTE, () => adapter.get<Array<{ value: number; title: string }>>('/api/v1/status_appointments')),
  ]);
  const wanted = new Set([2, 16, 9, 8, 17, 18, 5, 3]);
  return {
    specialties: list.map(item => ({ id: String(item.id), name: item.nome })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    statuses: [{ id: STATUS_FALTOSOS, name: 'Faltosos (não compareceu, desmarcou ou cancelado)' }, ...(Array.isArray(statuses) ? statuses : []).filter(item => wanted.has(Number(item.value))).map(item => ({ id: Number(item.value), name: String(item.title) }))],
  };
}
export async function ameiProfessionalsOf(specialtyId: string): Promise<Array<{ id: string; name: string }>> {
  if (!/^\d{1,10}$/.test(specialtyId)) throw new AmeiError('Área de atuação inválida.');
  return (await professionals(specialtyId)).map(item => ({ id: String(item.id), name: item.nome }));
}

/** Consultas do período, como a tela "Confirmar agendamento" da AMEI (ao vivo, sem cache). */
export async function ameiConfirmList(filters: ConfirmFilters): Promise<{ rows: ConfirmRow[]; total: number }> {
  if (!ISO_DAY.test(filters.dateInit) || !ISO_DAY.test(filters.dateFinish)) throw new AmeiError('Informe data início e data fim válidas.');
  if (filters.dateFinish < filters.dateInit) throw new AmeiError('A data fim não pode ser antes da data início.');
  if ((Date.parse(filters.dateFinish) - Date.parse(filters.dateInit)) / 86400000 > 31) throw new AmeiError('Escolha no máximo 31 dias por pesquisa.');
  const statusId = Number.isInteger(filters.statusId) ? Number(filters.statusId) : 2;
  const statusIds = statusId === STATUS_FALTOSOS ? MISSED_STATUSES : [statusId];
  const rows: ConfirmRow[] = [];
  let total = 0;
  for (let page = 1; page <= 30; page++) {
    const qs = new URLSearchParams({ dateInit: filters.dateInit.replaceAll('-', ''), dateFinish: filters.dateFinish.replaceAll('-', ''), unitId: CLINIC_ID, page: String(page), limit: '100' });
    for (const id of statusIds) qs.append('statusAppointmentId', String(id));
    if (filters.specialtyId && /^\d{1,10}$/.test(filters.specialtyId)) qs.set('specialtyId', filters.specialtyId);
    if (filters.professionalId && /^\d{1,10}$/.test(filters.professionalId)) qs.set('professionalId', filters.professionalId);
    const data = await adapter.get<{ items?: Array<Record<string, unknown>>; meta?: { totalItems?: number } }>(`/api/v1/appointments/confirm/status?${qs}`);
    if (!Array.isArray(data.items) || !Number.isInteger(data.meta?.totalItems)) throw new AmeiError('A AMEI devolveu a lista num formato inesperado.');
    total = data.meta!.totalItems!;
    for (const item of data.items) {
      const [day, hour] = String(item.dataHoraInicio ?? '').split(/[ T]/);
      const date = toIso(day), time = toHour(hour);
      if (!date || !time || !item.agendamentoId) continue;
      rows.push({
        appointmentId: String(item.agendamentoId), date, time, patientName: String(item.pacienteNome ?? '').trim(), patientSocial: String(item.pacienteSocial ?? '').trim(),
        age: ageOf(item.pacienteDataNascimento), phone: digits(item.pacienteCelular), professional: String(item.profissionalNome ?? '').trim(), specialty: String(item.especialidade ?? '').trim(),
        procedure: String(item.procedimento ?? '').trim(), value: String(item.valor ?? '').trim(), status: String(item.status ?? ''), statusId: Number(item.statusId), channel: String(item.canalConfirmacao ?? ''), note: String(item.observacao ?? '').trim(),
      });
    }
    if (rows.length >= total || !data.items.length) break;
  }
  if (statusId === STATUS_FALTOSOS) { const now = nowBr(); const past = rows.filter(r => `${r.date} ${r.time}` <= `${now.date} ${now.time}`); rows.length = 0; rows.push(...past); total = rows.length; }
  rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.patientName.localeCompare(b.patientName, 'pt-BR'));
  return { rows, total };
}

// ─── Contexto de uma consulta (para a ligação de confirmação) ───────────────────────────────────
export interface AppointmentContext { appointmentId: string; date: string; time: string; patientName: string; phone: string; professional: string; specialty: string; statusId: number; /** valor da consulta na AMEI, ex.: "102" */ valor?: string; /** ligação de teste: nada é gravado na AMEI */ test?: boolean; /** confirm = consulta a confirmar; missed = consulta perdida (faltoso) */ kind?: 'confirm' | 'missed'; patientId?: string; specialtyId?: string; professionalId?: string }
const STATUS_AGENDADO = 2, STATUS_CONFIRMADO = 16, STATUS_DESMARCADO_PACIENTE = 9;
const titleCase = (value: string): string => value.toLocaleLowerCase('pt-BR').replace(/(^|\s)(\p{L})/gu, (_m, space: string, letter: string) => space + letter.toLocaleUpperCase('pt-BR')).replace(/\s(Da|De|Do|Das|Dos|E)(?=\s)/g, m => m.toLowerCase());

interface AppointmentDetail {
  id: number | string; clinica: number | string; data: string; horaInicio: string; statusAgendamento: number; valorTotal?: number | string;
  pacienteId?: { id?: number | string; nome?: string; sobrenome?: string; celular?: string };
  profissionalId?: { id?: number | string; nome?: string; sobrenome?: string };
  especialidadeId?: { id?: number | string; descricao?: string };
}
async function appointmentDetail(appointmentId: string): Promise<AppointmentDetail> {
  if (!/^\d{1,12}$/.test(appointmentId)) throw new AmeiError('Consulta inválida.');
  const detail = await adapter.get<AppointmentDetail>(`/api/v1/appointments/${appointmentId}`);
  if (!detail || String(detail.id) !== appointmentId) throw new AmeiError('A AMEI não devolveu essa consulta.');
  if (String(detail.clinica) !== CLINIC_ID) throw new AmeiError('Essa consulta não é da unidade de Fernandópolis.');
  return detail;
}
async function professionalTitles(specialtyId: unknown): Promise<Map<string, string>> {
  if (specialtyId == null) return new Map();
  return cached(`titles:${specialtyId}`, 30 * MINUTE, async () => {
    const data = await adapter.get<Array<{ id: number | string; tratamento?: string }>>(`/api/v1/profissionais/especialidade/${specialtyId}`);
    return new Map((Array.isArray(data) ? data : []).map(item => [String(item.id), String(item.tratamento ?? '').trim()]));
  });
}

/** Lê a consulta direto da AMEI (nunca confia no que o navegador mandou) e monta o contexto da ligação. */
export async function ameiAppointmentContext(appointmentId: string): Promise<AppointmentContext> {
  const detail = await appointmentDetail(appointmentId);
  const date = toIso(detail.data), time = toHour(detail.horaInicio);
  if (!date || !time) throw new AmeiError('A AMEI devolveu data ou hora inválidas.');
  if (Number(detail.statusAgendamento) !== STATUS_AGENDADO) throw new AmeiError('Essa consulta não está mais com status "Agendado"; atualize a lista.');
  const now = nowBr();
  if (`${date} ${time}` < `${now.date} ${now.time}`) throw new AmeiError('Essa consulta já passou.');
  const patientName = [detail.pacienteId?.nome, detail.pacienteId?.sobrenome].filter(Boolean).join(' ').trim();
  const phone = digits(detail.pacienteId?.celular);
  if (!patientName || phone.length < 10) throw new AmeiError('A consulta está sem nome ou celular do paciente.');
  let title = '';
  try { title = (await professionalTitles(detail.especialidadeId?.id)).get(String(detail.profissionalId?.id)) ?? ''; } catch { /* sem tratamento: fala só o nome */ }
  const professional = [title, titleCase([detail.profissionalId?.nome, detail.profissionalId?.sobrenome].filter(Boolean).join(' '))].filter(Boolean).join(' ').trim();
  return { appointmentId, date, time, patientName: titleCase(patientName), phone, professional, specialty: String(detail.especialidadeId?.descricao ?? '').trim(), statusId: Number(detail.statusAgendamento), valor: detail.valorTotal != null && Number(detail.valorTotal) > 0 ? String(detail.valorTotal) : undefined };
}

/** Fala natural para a Giovana: "quarta-feira, dia 11 de novembro" e "8 horas da manhã". */
export function spokenLongDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(at);
  const month = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(at);
  return `${weekday}, dia ${d} de ${month}`;
}
export function spokenClock(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const period = h < 12 ? 'da manhã' : h < 18 ? 'da tarde' : 'da noite';
  const hour12 = h > 12 ? h - 12 : h;
  const base = m === 0 ? `${hour12} ${hour12 === 1 ? 'hora' : 'horas'}` : m === 30 ? `${hour12} e meia` : `${hour12} e ${m}`;
  return `${base} ${period}`;
}

// ─── Gravação: confirmar ou desmarcar (única escrita na AMEI) ───────────────────────────────────
export type ConfirmOutcome = 'confirmou' | 'desmarcou';
const OUTCOMES: Record<ConfirmOutcome, { statusId: number; note: string; done: string }> = {
  confirmou: { statusId: STATUS_CONFIRMADO, note: 'Confirmado por ligação da assistente virtual Giovana (IA).', done: 'Consulta confirmada na agenda.' },
  desmarcou: { statusId: STATUS_DESMARCADO_PACIENTE, note: 'Desmarcado pelo paciente em ligação da assistente virtual Giovana (IA).', done: 'Consulta desmarcada na agenda.' },
};

/**
 * Muda o status da consulta desta ligação. Só altera se, NA HORA, a AMEI ainda mostrar a mesma consulta
 * (unidade, dia e hora) com status Agendado ou Confirmado; depois confere se a mudança pegou.
 */
export async function ameiApplyOutcome(expected: { appointmentId: string; date: string; time: string }, outcome: ConfirmOutcome): Promise<string> {
  const rule = OUTCOMES[outcome];
  const detail = await appointmentDetail(expected.appointmentId);
  if (toIso(detail.data) !== expected.date || toHour(detail.horaInicio) !== expected.time) throw new AmeiError('A consulta mudou de dia ou horário na AMEI; não alterei nada.');
  const current = Number(detail.statusAgendamento);
  if (current === rule.statusId) return rule.done;
  if (current !== STATUS_AGENDADO && current !== STATUS_CONFIRMADO) throw new AmeiError('A consulta não está mais como Agendado ou Confirmado na AMEI; não alterei nada.');
  const channels = await cached('canais', 30 * MINUTE, () => adapter.get<Array<{ id: number; nome: string }>>('/api/v1/canais/confirmacoes'));
  const channel = (Array.isArray(channels) ? channels : []).find(c => norm(c.nome) === 'clinica') ?? channels?.[0];
  if (!channel) throw new AmeiError('A AMEI não devolveu os canais de confirmação.');
  await adapter.put(`/api/v1/change-appointment-status/${expected.appointmentId}`, { statusId: rule.statusId, observacao: rule.note, canalConfirmacaoId: channel.id });
  const after = await appointmentDetail(expected.appointmentId);
  if (Number(after.statusAgendamento) !== rule.statusId) throw new AmeiError('A AMEI não confirmou a alteração; confira a consulta manualmente.');
  for (const key of [...cache.keys()]) if (key.startsWith('appts:')) cache.delete(key);
  return rule.done;
}

/** Valor em reais para falar: "102" -> "102 reais"; "72.5" -> "72 reais e 50 centavos". */
export function spokenMoney(raw: string): string {
  const amount = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) return '';
  const reais = Math.floor(amount), cents = Math.round((amount - reais) * 100);
  return `${reais} ${reais === 1 ? 'real' : 'reais'}${cents ? ` e ${cents} centavos` : ''}`;
}

// ─── Aquecimento: deixa pronta a agenda das especialidades mais procuradas durante uma ligação ───
/** Mais pedidas na clínica (demanda real dos próximos dias + as que os pacientes costumam perguntar). Ajustável por AMEI_WARM_SPECIALTIES. */
const WARM_DEFAULT = ['Clínica médica', 'Psicologia', 'Dermatologia', 'Psiquiatria', 'Oftalmologia', 'Cardiologia', 'Ortopedia e traumatologia', 'Nutrição', 'Gastroenterologia', 'Endocrinologia', 'Ginecologia', 'Pediatria', 'Urologia', 'Otorrinolaringologia', 'Angiologia'];
const warmList = (): string[] => (process.env.AMEI_WARM_SPECIALTIES ? process.env.AMEI_WARM_SPECIALTIES.split(',').map(x => x.trim()).filter(Boolean) : WARM_DEFAULT);
let warming: Promise<void> | null = null;

/** Consulta e guarda em cache os horários das especialidades mais procuradas. Falhas são ignoradas (a consulta na hora continua valendo). */
export function ameiWarmCache(): Promise<void> {
  if (warming) return warming;
  warming = (async () => {
    try {
      if (!(await adapter.status()).loggedIn) return;
      const names = warmList();
      let cursor = 0;
      const worker = async () => { while (cursor < names.length) { const name = names[cursor++]!; try { await ameiFreeSlots({ especialidade: name, refresh: true }); } catch { /* segue para a próxima */ } } };
      await Promise.all(Array.from({ length: 3 }, worker));
    } catch { /* aquecimento nunca atrapalha a ligação */ }
    finally { warming = null; }
  })();
  return warming;
}

/** Aquece agora e a cada 100 s enquanto a ligação durar (o cache vale 2 min). Devolve a função que para o aquecimento. */
export function startAmeiWarming(): () => void {
  void ameiWarmCache();
  const timer = setInterval(() => { void ameiWarmCache(); }, 100_000);
  timer.unref();
  const limit = setTimeout(() => clearInterval(timer), 30 * 60_000);
  limit.unref();
  return () => { clearInterval(timer); clearTimeout(limit); };
}

// ─── Faltosos: consulta perdida (não compareceu, desmarcou ou cancelada) ─────────────────────────
export const STATUS_FALTOSOS = -1;
const MISSED_STATUSES = [3, 9, 17]; // Cancelado, Desmarcado pelo paciente, Não compareceu
export type MissedSituation = 'faltou' | 'desmarcou' | 'cancelada';
export const missedSituationOf = (statusId: number): MissedSituation => statusId === 17 ? 'faltou' : statusId === 9 ? 'desmarcou' : 'cancelada';

/** Lê a consulta perdida direto da AMEI e monta o contexto da ligação de recuperação (sem CPF: ele só é lido na hora de gravar). */
export async function ameiMissedContext(appointmentId: string): Promise<AppointmentContext> {
  const detail = await appointmentDetail(appointmentId);
  const date = toIso(detail.data), time = toHour(detail.horaInicio);
  if (!date || !time) throw new AmeiError('A AMEI devolveu data ou hora inválidas.');
  const statusId = Number(detail.statusAgendamento);
  if (!MISSED_STATUSES.includes(statusId)) throw new AmeiError('Essa consulta não está mais como não compareceu, desmarcada ou cancelada; atualize a lista.');
  const now = nowBr();
  if (statusId === 17 && `${date} ${time}` > `${now.date} ${now.time}`) throw new AmeiError('Essa consulta ainda não aconteceu.');
  const patientName = [detail.pacienteId?.nome, detail.pacienteId?.sobrenome].filter(Boolean).join(' ').trim();
  const phone = digits(detail.pacienteId?.celular);
  if (!patientName || phone.length < 10) throw new AmeiError('A consulta está sem nome ou celular do paciente.');
  if (!detail.pacienteId?.id || !detail.especialidadeId?.id) throw new AmeiError('A consulta está sem paciente ou especialidade na AMEI.');
  let title = '';
  try { title = (await professionalTitles(detail.especialidadeId.id)).get(String(detail.profissionalId?.id)) ?? ''; } catch { /* sem tratamento */ }
  const professional = [title, titleCase([detail.profissionalId?.nome, detail.profissionalId?.sobrenome].filter(Boolean).join(' '))].filter(Boolean).join(' ').trim();
  return {
    appointmentId, date, time, patientName: titleCase(patientName), phone, professional, specialty: String(detail.especialidadeId.descricao ?? '').trim(), statusId,
    valor: detail.valorTotal != null && Number(detail.valorTotal) > 0 ? String(detail.valorTotal) : undefined,
    kind: 'missed', patientId: String(detail.pacienteId.id), specialtyId: String(detail.especialidadeId.id), professionalId: detail.profissionalId?.id != null ? String(detail.profissionalId.id) : undefined,
  };
}

// ─── Lista de espera (única outra escrita na AMEI além de confirmar/desmarcar) ──────────────────
interface WaitlistItem { id: number; pacienteId?: { id?: number }; especialidadeId?: { id?: number }; statusId?: { description?: string } }
/** Lista de espera inteira (a busca por CPF da AMEI não filtra de verdade), filtrada aqui pelo paciente. */
async function waitlistOf(patientId: string): Promise<WaitlistItem[]> {
  const found: WaitlistItem[] = [];
  let total = Infinity;
  for (let page = 1; page <= 40 && found.length < total; page++) {
    const data = await adapter.get<{ items?: WaitlistItem[]; meta?: { totalItems?: number } }>(`/api/v1/lista-espera?page=${page}&limit=100`);
    if (!Array.isArray(data?.items)) throw new AmeiError('A AMEI devolveu a lista de espera num formato inesperado.');
    if (!data.items.length) break;
    total = Number.isInteger(data.meta?.totalItems) ? data.meta!.totalItems! : data.items.length;
    found.push(...data.items.filter(item => String(item.pacienteId?.id) === patientId));
    if (page * 100 >= total) break;
  }
  return found;
}
const isPendingFor = (item: WaitlistItem, patientId: string, specialtyId: string): boolean =>
  String(item.pacienteId?.id) === patientId && String(item.especialidadeId?.id) === specialtyId && norm(item.statusId?.description) === 'pendente';

/**
 * Coloca o paciente da consulta perdida na lista de espera da AMEI (CPF, paciente, especialidade, profissional e observação).
 * Não duplica: se ele já está pendente na mesma especialidade, devolve sucesso sem gravar. Confere depois de gravar.
 */
export async function ameiAddToWaitlist(ctx: AppointmentContext, reason: string): Promise<string> {
  if (ctx.kind !== 'missed' || !ctx.patientId || !ctx.specialtyId) throw new AmeiError('Esta ligação não tem uma consulta perdida para colocar na lista de espera.');
  const detail = await appointmentDetail(ctx.appointmentId) as AppointmentDetail & { pacienteId?: { id?: number | string; cpf?: string } };
  if (String(detail.pacienteId?.id) !== ctx.patientId || String(detail.especialidadeId?.id) !== ctx.specialtyId) throw new AmeiError('A consulta mudou de paciente ou especialidade na AMEI; não alterei nada.');
  return addToWaitlist({ cpf: digits(detail.pacienteId?.cpf), patientId: ctx.patientId, specialtyId: ctx.specialtyId, professionalId: ctx.professionalId, reason });
}

/** Núcleo da inclusão na lista de espera: valida o CPF, não duplica, grava e confere depois. */
export async function addToWaitlist(input: { cpf: string; patientId: string; specialtyId: string; professionalId?: string; reason: string }): Promise<string> {
  const cpf = digits(input.cpf);
  if (cpf.length !== 11) throw new AmeiError('O paciente está sem CPF válido na AMEI; a equipe precisa incluir na lista de espera.');
  if ((await waitlistOf(input.patientId)).some(item => isPendingFor(item, input.patientId, input.specialtyId))) return 'Paciente já estava na lista de espera dessa especialidade.';
  const note = `Assistente virtual Giovana (IA): ${input.reason.replace(/\s+/g, ' ').trim()}`.slice(0, 250);
  await adapter.post('/api/v1/lista-espera', { cpf, pacienteId: Number(input.patientId), especialidadeId: Number(input.specialtyId), profissionalId: input.professionalId ? Number(input.professionalId) : '', observacoes: note });
  if (!(await waitlistOf(input.patientId)).some(item => isPendingFor(item, input.patientId, input.specialtyId))) throw new AmeiError('A AMEI não confirmou a inclusão na lista de espera; confira manualmente.');
  return 'Paciente colocado na lista de espera.';
}
