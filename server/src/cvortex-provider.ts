/**
 * Browser bridge proof of concept for the authorised cVortex tenant.
 * It uses the visible webphone UI and a loopback-only audio WebSocket. It does
 * not call private GraphQL operations directly or read browser credentials.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page, type WebSocket as PlaywrightWebSocket } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';
import { config } from './config.js';
import type { CallStatus } from './types.js';
import { SELF_TALK_PATTERNS } from './self-talk-patterns.js';

const TENANT_PAGE = config.cvortexUrl;
const TENANT_ORIGIN = new URL(TENANT_PAGE).origin;
const CDP_URL = config.cvortexCdpUrl;
const BRIDGE_PORT = config.cvortexBridgePort;
const MAX_BUFFERED = 512_000;
const PC_WAIT_MS = 20_000;

export class CvortexAmbiguousStartError extends Error {
  readonly ambiguousStart = true;
  constructor(message = 'A discagem pode ter sido aceita, mas a confirmação não chegou.') { super(message); this.name = 'CvortexAmbiguousStartError'; }
}

export interface CvortexStartOptions {
  callId: string;
  phone: string;
  patientName: string;
  contactContext: 'not_informed' | 'recent_card_member' | 'appointment_confirmation' | 'missed_appointment' | 'waitlist_capture';
  agentId: string;
  /** Modelos de WhatsApp que a IA pode enviar (vira a variável {{modelos_whatsapp}} do prompt). */
  whatsappModels?: string;
  /** 'conectada' ou 'indisponivel (...)': vira a variável {{agenda_amei}} do prompt. */
  ameiAgenda?: string;
  /** Variáveis extras do prompt (ex.: dados da consulta a confirmar); sobrescrevem as padrão. */
  extraVariables?: Record<string, string>;
  /** Substitui o prompt do agente só nesta ligação (ex.: confirmação de consulta). */
  promptOverride?: string;
  /** Substitui a primeira fala do agente só nesta ligação. */
  firstMessageOverride?: string;
  onStatus?: (status: CallStatus) => void | Promise<void>;
  onAgentConnected?: () => void | Promise<void>;
  onConversationId?: (conversationId: string) => void | Promise<void>;
  onEnded?: (status: CallStatus) => void | Promise<void>;
  /** Escuta ao vivo (PCM16 16 kHz mono). Chamado de forma síncrona e barata. */
  onAudio?: (source: 'patient' | 'agent', pcm: Buffer) => void;
  onText?: (role: 'patient' | 'agent', text: string, correction?: boolean) => void;
  /** Ferramentas que a IA aciona durante a ligação (client tools da ElevenLabs). Retorna o texto que a IA recebe de volta. */
  onToolCall?: (name: string, parameters: Record<string, unknown>) => Promise<string>;
  onFlush?: () => void;
}

interface Session {
  options: CvortexStartOptions;
  page: Page;
  nonce: Buffer;
  server: WebSocketServer | null;
  browserSocket: WebSocket | null;
  agentSocket: WebSocket | null;
  accepted: boolean;
  mediaReady: boolean;
  ended: boolean;
  ending: boolean;
  takenOver: boolean;
  conversationId: string | null;
  inputFormat: string | null;
  outputFormat: string | null;
  startedAt: number;
  callControlSeen: boolean;
  missingCallControlTicks: number;
  monitor: ReturnType<typeof setInterval> | null;
  mediaTimer: ReturnType<typeof setTimeout> | null;
  // A ponte WebRTC autentica (e manda {type:'start'}) ainda durante o toque, porque o PeerConnection do
  // webphone já fica "connected" com ringback fluindo antes de alguém atender de verdade — por isso NÃO
  // basta esse sinal pra conectar a Giovana. Só chamamos a ElevenLabs quando este E patientConnected (abaixo)
  // forem true (ver tryConnectAgent).
  bridgeReady: boolean;
  // Confirmado via DOM real do webphone (ver watchPatientConnected): a barra do cVortex troca o texto
  // "chamando..." por um cronômetro HH:MM:SS só quando a chamada conecta de verdade (atendida, inclusive
  // caixa postal/URA — não dá pra distinguir isso só por aqui). Esse é o sinal de atendimento real que faltava.
  patientConnected: boolean;
  connectWatcher: ReturnType<typeof setInterval> | null;
  // Áudio do paciente chegado antes da ponte/agente ficarem prontos (ex.: ele já diz "alô" no instante
  // em que atende). Sem isso esse trecho é descartado e a primeira fala chega cortada para a Giovana.
  pendingPatientAudio: Buffer[];
  pendingPatientAudioBytes: number;
  // Se o paciente chegou a dizer alguma palavra de verdade reconhecida (não "...", ruído ou vazio).
  // Usado pra decidir, quando a ligação acaba sozinha (ninguém mais no controle do webphone), se foi
  // "não atendeu" (nunca ouvimos nada) ou "completed" normal (teve conversa de verdade).
  patientSaidSomething: boolean;
  // Rede de segurança estrutural: investigação confirmou (transcrições reais) que ela às vezes ainda gera
  // a fala proibida de "autoconversa" (ex.: "tem alguém aí?") mesmo com toda a instrução de prompt — parece
  // reengajamento forçado pelo motor de turno da ElevenLabs, não desobediência ao prompt. Setado true assim
  // que o TEXTO da fala bate nos padrões proibidos (chega antes do áudio da TTS); enquanto true, o áudio
  // correspondente é tocado só pra escuta/revisão interna (onAudio), nunca mandado pro paciente de verdade.
  suppressAgentAudio: boolean;
}
// ~4s de áudio pcm_16000 mono (16000 amostras/s * 2 bytes). Suficiente para um "alô" ou "oi" não se perder
// enquanto a ponte/agente terminam de ficar prontos, sem acumular áudio indefinidamente se travar.
const MAX_PENDING_PATIENT_AUDIO = 128_000;

function fire(callback: (() => void | Promise<void>) | undefined): void {
  if (!callback) return;
  Promise.resolve().then(callback).catch(error => console.error('[CVORTEX] callback failed', error));
}
/** Pronto para mandar áudio do paciente pra Giovana (ponte e agente ElevenLabs já alinhados). */
function patientAudioReady(session: Session): boolean {
  return session.mediaReady && session.inputFormat === 'pcm_16000' && session.agentSocket?.readyState === WebSocket.OPEN;
}
/** Manda um chunk de áudio do paciente pra Giovana (ou guarda, se ela ainda não está pronta pra ouvir). */
function sendPatientAudio(session: Session, chunk: Buffer): void {
  // Sempre tenta esvaziar o que ficou pendente ANTES deste chunk, pra manter a ordem e pra um pico de
  // backpressure no meio da ligação (ex.: bufferedAmount passou de MAX_BUFFERED por um instante) não deixar
  // a fala do paciente ("sim", "tá ligado?") perdida pra sempre — sem isso ela só era esvaziada no começo
  // da ligação (media-ready/conversation_initiation_metadata) e nunca mais, então a Giovana simplesmente
  // nunca recebia aquele trecho e ficava muda até o paciente falar de novo.
  if (patientAudioReady(session)) flushPendingPatientAudio(session);
  if (patientAudioReady(session) && session.agentSocket!.bufferedAmount < MAX_BUFFERED) {
    session.agentSocket!.send(JSON.stringify({ user_audio_chunk: chunk.toString('base64') }));
  } else if (!session.ended && !session.ending) {
    session.pendingPatientAudio.push(chunk);
    session.pendingPatientAudioBytes += chunk.length;
    while (session.pendingPatientAudioBytes > MAX_PENDING_PATIENT_AUDIO && session.pendingPatientAudio.length > 1) {
      const dropped = session.pendingPatientAudio.shift()!;
      session.pendingPatientAudioBytes -= dropped.length;
    }
  }
  try { session.options.onAudio?.('patient', chunk); } catch { /* escuta nunca derruba a ligação */ }
}
/** Chamado quando a ponte e o agente ficam prontos: esvazia o que o paciente já tinha falado, na ordem. */
function flushPendingPatientAudio(session: Session): void {
  if (!patientAudioReady(session) || !session.pendingPatientAudio.length) return;
  const pending = session.pendingPatientAudio;
  session.pendingPatientAudio = []; session.pendingPatientAudioBytes = 0;
  for (const chunk of pending) {
    if (!patientAudioReady(session) || session.agentSocket!.bufferedAmount >= MAX_BUFFERED) break;
    session.agentSocket!.send(JSON.stringify({ user_audio_chunk: chunk.toString('base64') }));
  }
}
function fireStatus(session: Session, status: CallStatus): void { fire(() => session.options.onStatus?.(status)); }
/** Saudação conforme o horário de Brasília, usada na abertura da Giovana. */
export function greetingForNow(now: Date = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' }).format(now)) % 24;
  return hour >= 5 && hour < 12 ? 'bom dia' : hour < 18 && hour >= 12 ? 'boa tarde' : 'boa noite';
}

function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
  if (!/^\d{10,11}$/.test(local)) throw new Error('Número brasileiro inválido para o webphone.');
  return local;
}
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

class CvortexBrowserProvider {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private instrumented = false;
  private active: Session | null = null;
  private browserLaunchRequested = false;
  private lastBrowserLaunchAttempt = 0;

  async connectionStatus(): Promise<{ browserOpen: boolean; loggedIn: boolean; activeCall: boolean }> {
    try {
      const page = await this.getPage();
      const loggedIn = await page.getByRole('button', { name: 'Pausa' }).count() > 0;
      return { browserOpen: true, loggedIn, activeCall: Boolean(this.active && !this.active.ended) || await page.locator('svg[aria-label="Call End"]').count() > 0 };
    } catch {
      return { browserOpen: Boolean(this.browser?.isConnected()), loggedIn: false, activeCall: Boolean(this.active && !this.active.ended) };
    }
  }

  async openBrowser(): Promise<void> {
    try {
      const page = await this.getPage();
      await page.bringToFront();
    } catch {
      this.launchBrowser();
    }
  }

  async ready(): Promise<boolean> {
    // Só checa o status; não tenta abrir o navegador sozinho (isso é feito só pelo botão "Abrir cVortex",
    // via openBrowser). O painel chama isso a cada poucos segundos, então uma tentativa automática aqui
    // vira um loop de tentativas falhando sem parar sempre que o Chrome não está pronto.
    try {
      const page = await this.getPage();
      if (page.isClosed() || !page.url().startsWith(TENANT_ORIGIN)) return false;
      const hasToolbar = await page.getByRole('button', { name: 'Pausa' }).count() > 0;
      const hasActiveCall = await page.locator('svg[aria-label="Call End"]').count() > 0;
      return hasToolbar && !hasActiveCall && !this.active;
    } catch {
      return false;
    }
  }

  private launchBrowser(): void {
    if (this.browserLaunchRequested) return;
    // Evita tentar de novo em loop (ex.: o painel fica checando a conexão a cada poucos segundos):
    // só tenta de novo depois de um tempo, mesmo que a tentativa anterior já tenha terminado.
    if (Date.now() - this.lastBrowserLaunchAttempt < 20_000) return;
    this.lastBrowserLaunchAttempt = Date.now();
    this.browserLaunchRequested = true;
    const script = fileURLToPath(new URL('../../tools/cvortex-browser.mjs', import.meta.url));
    try {
      const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', error => { this.browserLaunchRequested = false; console.error('[CVORTEX] navegador não iniciou:', error.message); });
      child.on('exit', code => { this.browserLaunchRequested = false; if (code) console.error('[CVORTEX] navegador não iniciou (código', code, '):', stderr.trim() || 'sem detalhes'); });
      child.unref();
    } catch (error) {
      this.browserLaunchRequested = false;
      console.error('[CVORTEX] navegador não iniciou:', error);
    }
  }

  private async getPage(): Promise<Page> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
      this.instrumented = false;
      this.page = null;
    }
    if (this.page && !this.page.isClosed()) return this.page;
    const matches = this.browser.contexts().flatMap(context => context.pages()).filter(page => page.url().startsWith(TENANT_ORIGIN));
    if (matches.length !== 1) throw new Error('Abra exatamente uma aba autenticada do cVortex no perfil isolado.');
    this.page = matches[0]!;
    return this.page;
  }

  private async instrument(page: Page): Promise<void> {
    if (this.instrumented) return;
    await page.addInitScript(() => {
      const w = window as any;
      if (w.__cvBrowserPcs) return;
      w.__cvBrowserPcs = [];
      const NativePC = window.RTCPeerConnection;
      w.RTCPeerConnection = new Proxy(NativePC, {
        construct(target, args) {
          const pc = Reflect.construct(target, args) as RTCPeerConnection;
          w.__cvBrowserPcs.push(pc);
          return pc;
        },
      });
    });
    page.on('websocket', socket => this.observeSocket(socket));
    page.on('close', () => { const session = this.active; if (session && !session.ended) void this.bridgeFailed(session, new Error('A aba do webphone foi fechada.')); });
    this.instrumented = true;
  }

  private observeSocket(socket: PlaywrightWebSocket): void {
    if (!socket.url().startsWith(`${TENANT_ORIGIN.replace('https:', 'wss:')}/api/crm/subscriptions`)) return;
    socket.on('framereceived', frame => {
      let message: any;
      try { message = JSON.parse(String(frame.payload)); } catch { return; }
      const data = message?.payload?.data;
      if (!data || !this.active || this.active.ended) return;
      if (data.hangup) console.info('[CVORTEX] hangup sinalizado; aguardando confirmação no webphone', this.active.options.callId);
      // Dialing/answerCall can refer to the agent leg. Do not promote them to
      // patient ringing/answered status without a vendor contract.
    });
  }

  private async openCallMenu(page: Page): Promise<void> {
    const item = page.getByText('Ligar para um Colaborador', { exact: true });
    if (await item.isVisible()) return;
    const buttons = page.locator('svg[aria-label="Navigation Menu Vertical"]');
    const count = await buttons.count();
    for (let index = 0; index < count; index++) {
      await page.keyboard.press('Escape');
      await buttons.nth(index).click({ timeout: 5000 });
      try { await item.waitFor({ state: 'visible', timeout: 2000 }); return; }
      catch { /* this icon opened a different menu */ }
    }
    throw new Error('Menu de ligação do webphone não encontrado.');
  }

  async start(options: CvortexStartOptions): Promise<void> {
    if (this.active && !this.active.ended) throw new Error('O webphone já possui uma chamada controlada por este processo.');
    if (!options.callId || !options.agentId || !options.patientName.trim()) throw new Error('Dados da chamada incompletos.');
    const digits = phoneDigits(options.phone);
    const page = await this.getPage();
    if (await page.locator('svg[aria-label="Call End"]').count()) throw new Error('Há uma chamada ativa no webphone.');
    await this.instrument(page);
    const session: Session = { options, page, nonce: randomBytes(32), server: null, browserSocket: null, agentSocket: null, accepted: false, mediaReady: false, ended: false, ending: false, takenOver: false, callControlSeen: false, missingCallControlTicks: 0, monitor: null, mediaTimer: null, conversationId: null, inputFormat: null, outputFormat: null, startedAt: Date.now(), pendingPatientAudio: [], pendingPatientAudioBytes: 0, patientSaidSomething: false, suppressAgentAudio: false, bridgeReady: false, patientConnected: false, connectWatcher: null };
    this.active = session;
    fireStatus(session, 'connecting');
    let clicked = false;
    let rejected = false;
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Pausa' }).waitFor({ state: 'visible', timeout: 15_000 });
      // The voice menu appears after the toolbar while SIP registration is still initializing.
      await page.waitForTimeout(5000);
      if (await page.locator('svg[aria-label="Call End"]').count()) throw new Error('Há uma chamada ativa no webphone.');
      await this.openCallMenu(page);
      await page.getByText('Ligar para um Colaborador', { exact: true }).click({ timeout: 8000 });
      await page.getByPlaceholder('Digite apenas números').fill(digits);
      clicked = true;
      const [response] = await Promise.all([
        page.waitForResponse(response => {
          if (!response.url().endsWith('/api/crm/graphql')) return false;
          try { return response.request().postDataJSON()?.operationName === 'DirectAgentContact'; } catch { return false; }
        }, { timeout: 12_000 }),
        page.locator('button[title="Ligar para o número"]').last().click(),
      ]);
      const body = await response.json() as { data?: { directAgentContact?: boolean }; errors?: unknown[] };
      if (!response.ok() || body.errors?.length || body.data?.directAgentContact !== true) {
        rejected = true;
        throw new Error('O webphone recusou a discagem.');
      }
      session.accepted = true;
      this.monitorCall(session);
      this.watchPatientConnected(session);
      void this.startBridge(session).catch(error => this.bridgeFailed(session, error));
    } catch (error) {
      if (clicked && !rejected) {
        // A click may have reached cVortex even if the response was lost.
        // Keep the session so the caller can request an explicit hangup.
        throw new CvortexAmbiguousStartError();
      }
      this.active = null;
      fireStatus(session, 'failed');
      throw error;
    }
  }

  private monitorCall(session: Session): void {
    session.monitor = setInterval(() => {
      if (session.ended || session.ending) return;
      void session.page.locator('svg[aria-label="Call End"]').count().then(count => {
        if (count > 0) { session.callControlSeen = true; session.missingCallControlTicks = 0; }
        else if (session.callControlSeen && !session.ended && !session.ending) {
          session.missingCallControlTicks++;
          if (session.missingCallControlTicks >= 3) {
            console.info('[CVORTEX] controle ausente por 3 verificações; chamada encerrada', session.options.callId);
            // Ninguém mexeu em nada (nem operador nem Giovana). Se o paciente falou de verdade em algum
            // momento, foi uma conversa normal que simplesmente não foi encerrada via end_call. Se nunca
            // falou, tem duas possibilidades: nunca chegou a conectar (silêncio = "não atendeu" de
            // verdade) ou conectou (cronômetro do webphone confirmou) mas ficou tudo em silêncio do lado
            // de lá — isso É caixa postal/URA muda, mesmo sem a Giovana ter reconhecido o padrão de voz.
            // As duas últimas já disparam o WhatsApp de confirmação sozinhas.
            void this.finish(session, session.patientSaidSomething ? 'completed' : session.patientConnected ? 'voicemail' : 'no_answer');
          }
        }
      }).catch(() => undefined);
    }, 1000);
    session.monitor.unref?.();
  }

  /**
   * Detecta atendimento real pela própria UI do webphone: a barra ao lado do botão de desligar mostra
   * "chamando..." durante o toque e troca para um cronômetro HH:MM:SS só quando a chamada conecta de
   * verdade (confirmado com ligação real em 2026-11-10). Usa o PADRÃO do texto (regex), não nomes de
   * classe CSS do cVortex (MUI/styled-components gera hashes que mudam a cada build deles).
   * Limitação aceita por ora: caixa postal/URA também faz esse cronômetro aparecer (o cVortex não
   * distingue isso na UI) — segue coberta pelo botão manual "Caixa postal" e pela detecção de texto
   * de voicemail_detection já existentes.
   */
  private watchPatientConnected(session: Session): void {
    session.connectWatcher = setInterval(() => {
      if (session.patientConnected || session.ended || session.ending) { if (session.connectWatcher) clearInterval(session.connectWatcher); return; }
      void session.page.evaluate(() => {
        const icon = document.querySelector('svg[aria-label="Call End"]');
        if (!icon) return null;
        let el: Element | null = icon;
        for (let i = 0; i < 7 && el; i++) el = el.parentElement;
        return el ? el.textContent : null;
      }).then(text => {
        if (session.patientConnected || !text) return;
        if (/\d{1,2}:\d{2}:\d{2}/.test(text)) {
          session.patientConnected = true;
          if (session.connectWatcher) clearInterval(session.connectWatcher);
          console.info('[CVORTEX] atendimento real confirmado pelo cronômetro do webphone', session.options.callId);
          this.tryConnectAgent(session);
        }
      }).catch(() => undefined);
    }, 400);
    session.connectWatcher.unref?.();
  }

  /** Só conecta a Giovana quando a ponte de áudio JÁ autenticou E o cVortex confirmou atendimento real. */
  private tryConnectAgent(session: Session): void {
    if (!session.bridgeReady || !session.patientConnected || session.agentSocket || session.ended || session.takenOver) return;
    session.mediaTimer = setTimeout(() => {
      if (!session.mediaReady && !session.ending && !session.ended) void this.bridgeFailed(session, new Error('A ponte de áudio não ficou pronta dentro do prazo.'));
    }, 20_000);
    session.mediaTimer.unref?.();
    void this.connectAgent(session).catch(error => this.bridgeFailed(session, error));
  }

  private async startBridge(session: Session): Promise<void> {
    const { page } = session;
    await page.waitForFunction(() => {
      const pcs: RTCPeerConnection[] = (window as any).__cvBrowserPcs ?? [];
      return pcs.some(pc => pc.connectionState === 'connected' && pc.getSenders().some(sender => sender.track?.kind === 'audio') && pc.getReceivers().some(receiver => receiver.track?.kind === 'audio'));
    }, undefined, { timeout: PC_WAIT_MS });
    if (session.ended) return;
    const server = new WebSocketServer({ host: '127.0.0.1', port: BRIDGE_PORT, verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => origin === TENANT_ORIGIN && isLoopback(req.socket.remoteAddress) });
    session.server = server;
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    server.on('connection', socket => this.acceptBrowserSocket(session, socket));
    const browserBridge = async ({ port, nonce }: { port: number; nonce: string }) => {
      const w = window as any;
      const pcs: RTCPeerConnection[] = w.__cvBrowserPcs ?? [];
      const pc = pcs.find(value => value.connectionState === 'connected' && value.getSenders().some(sender => sender.track?.kind === 'audio') && value.getReceivers().some(receiver => receiver.track?.kind === 'audio'));
      if (!pc) throw new Error('PeerConnection de áudio ausente.');
      const sender = pc.getSenders().find(value => value.track?.kind === 'audio')!;
      const receiver = pc.getReceivers().find(value => value.track?.kind === 'audio')!;
      const microphone = sender.track!;
      const microphoneWasEnabled = microphone.enabled;
      const context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      const source = context.createMediaStreamSource(new MediaStream([receiver.track]));
      const processor = context.createScriptProcessor(1024, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(processor).connect(silent).connect(context.destination);
      const output = context.createMediaStreamDestination();
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.binaryType = 'arraybuffer';
      let authenticated = false;
      let sending = false;
      let nextTime = context.currentTime + 0.18;
      const scheduled = new Set<AudioBufferSourceNode>();
      // Silencia o áudio local do webphone (o painel já toca a conversa) para não duplicar no fone.
      // A ponte lê a trilha WebRTC direto, então o mute dos elementos não afeta a captura.
      const touched = new Set<HTMLMediaElement>();
      const muteLocal = () => { document.querySelectorAll('audio,video').forEach(el => { const media = el as HTMLMediaElement; if (!media.muted) { media.muted = true; touched.add(media); } }); };
      muteLocal();
      const muteTimer = setInterval(muteLocal, 500);
      const unmuteLocal = () => { clearInterval(muteTimer); touched.forEach(media => { try { media.muted = false; } catch { /* removido */ } }); touched.clear(); };
      const restore = async () => {
        if (w.__cvActiveBridge?.socket !== socket) { unmuteLocal(); return sender.track === microphone; }
        unmuteLocal();
        try { if (sender.track !== microphone) await sender.replaceTrack(microphone); microphone.enabled = microphoneWasEnabled; } catch { return false; }
        if (sender.track !== microphone) return false;
        w.__cvActiveBridge = null;
        for (const node of scheduled) { try { node.stop(); } catch { /* already ended */ } }
        processor.disconnect(); source.disconnect(); silent.disconnect(); output.disconnect();
        try { socket.close(); } catch { /* already closed */ }
        await context.close();
        return true;
      };
      w.__cvActiveBridge = { socket, restore };
      // Antes, tentávamos adivinhar "o paciente atendeu" analisando volume/frequência do áudio recebido
      // (distinguir tom de chamada de fala) — um heurístico caseiro que ou demorava demais, ou disparava
      // com ruído da linha. Agora conectamos a Giovana assim que a ponte autentica, mas com first_message
      // vazio: ela fica muda e só fala depois que o reconhecimento de voz de verdade da ElevenLabs (bem
      // mais confiável) perceber a pessoa falando (ex. "alô"). Ela também nunca fala sozinha porque o
      // prompt da ligação já instrui "espere a pessoa falar primeiro".
      let gateOpen = false;
      const openGate = () => {
        if (gateOpen) return;
        gateOpen = true;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'start' }));
      };
      processor.onaudioprocess = event => {
        if (!authenticated || !sending || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512000) return;
        const samples = event.inputBuffer.getChannelData(0);
        const inputRate = context.sampleRate;
        const length = Math.max(1, Math.floor(samples.length * 16000 / inputRate));
        const pcm = new Int16Array(length);
        for (let index = 0; index < length; index++) {
          const position = index * inputRate / 16000;
          const left = Math.floor(position);
          const fraction = position - left;
          const sample = (samples[left] ?? 0) * (1 - fraction) + (samples[Math.min(left + 1, samples.length - 1)] ?? 0) * fraction;
          pcm[index] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
        }
        socket.send(pcm.buffer);
      };
      socket.onmessage = async event => {
        if (typeof event.data === 'string') {
          let control: { type?: string };
          try { control = JSON.parse(event.data) as { type?: string }; } catch { return; }
          if (control.type === 'hello-ok') { authenticated = true; openGate(); }
          if (control.type === 'agent-ready') {
            try {
              await sender.replaceTrack(output.stream.getAudioTracks()[0]!);
              sending = true;
              socket.send(JSON.stringify({ type: 'media-ready' }));
            } catch { socket.send(JSON.stringify({ type: 'media-error' })); await restore(); }
          }
          if (control.type === 'interruption') {
            for (const node of scheduled) { try { node.stop(); } catch { /* already ended */ } }
            scheduled.clear(); nextTime = context.currentTime + 0.18;
          }
          if (control.type === 'stop' || control.type === 'error') await restore();
          return;
        }
        if (!sending || !(event.data instanceof ArrayBuffer)) return;
        const pcm = new Int16Array(event.data);
        const buffer = context.createBuffer(1, pcm.length, 16000);
        const floats = buffer.getChannelData(0);
        for (let index = 0; index < pcm.length; index++) floats[index] = pcm[index]! / 32768;
        const node = context.createBufferSource();
        node.buffer = buffer; node.connect(output);
        node.onended = () => scheduled.delete(node);
        scheduled.add(node);
        // ElevenLabs can deliver a whole phrase faster than real time. Keep
        // every chunk queued; dropping chunks here cuts words mid-sentence.
        // Re-prime only after a genuine underrun to absorb network jitter.
        nextTime = Math.max(nextTime, context.currentTime + 0.18);
        node.start(nextTime); nextTime += buffer.duration;
      };
      socket.onclose = () => { void restore(); };
      const opened = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 5000);
        socket.onopen = () => { clearTimeout(timer); socket.send(JSON.stringify({ type: 'hello', nonce })); resolve(true); };
        socket.onerror = () => { clearTimeout(timer); resolve(false); };
      });
      if (!opened) { await restore(); throw new Error('WebSocket loopback indisponível.'); }
      return { opened: true, sampleRate: context.sampleRate, senderKind: sender.track?.kind, receiverKind: receiver.track.kind };
    };
    // tsx/esbuild annotates nested browser functions with __name. Keep that
    // helper scoped to this evaluated expression rather than touching window.
    const browserScript = `(() => { const __name = (fn) => fn; return (${browserBridge.toString()})(${JSON.stringify({ port: BRIDGE_PORT, nonce: session.nonce.toString('hex') })}); })()`;
    const report = await page.evaluate(browserScript) as { opened: boolean; sampleRate: number; senderKind?: string; receiverKind?: string };
    if (!report.opened || report.senderKind !== 'audio' || report.receiverKind !== 'audio') throw new Error('Mídia do webphone indisponível.');
  }

  private acceptBrowserSocket(session: Session, socket: WebSocket): void {
    if (session.browserSocket || session.ended) { socket.close(1008); return; }
    session.browserSocket = socket;
    let authenticated = false;
    socket.on('message', (payload, binary) => {
      if (session.ended || session.takenOver) return;
      if (!authenticated) {
        if (binary) { socket.close(1008); return; }
        let hello: { type?: string; nonce?: string } = {};
        try { hello = JSON.parse(payload.toString()) as typeof hello; } catch { socket.close(1008); return; }
        const provided = typeof hello.nonce === 'string' && /^[0-9a-f]{64}$/.test(hello.nonce) ? Buffer.from(hello.nonce, 'hex') : Buffer.alloc(32);
        if (hello.type !== 'hello' || !timingSafeEqual(provided, session.nonce)) { socket.close(1008); return; }
        authenticated = true;
        socket.send(JSON.stringify({ type: 'hello-ok' }));
        return;
      }
      if (binary) {
        sendPatientAudio(session, Buffer.from(payload as Buffer));
        return;
      }
      let message: { type?: string } = {};
      try { message = JSON.parse(payload.toString()) as typeof message; } catch { return; }
      if (message.type === 'start' && !session.takenOver) {
        // A ponte WebRTC autentica aqui ainda durante o toque (ringback já conectou o PeerConnection).
        // NÃO liga a Giovana ainda — só quando watchPatientConnected confirmar atendimento real (ver tryConnectAgent).
        console.info('[CVORTEX] ponte de áudio pronta; aguardando confirmação de atendimento real antes de conectar a Giovana', session.options.callId);
        session.bridgeReady = true;
        this.tryConnectAgent(session);
      }
      if (message.type === 'media-ready') {
        session.mediaReady = true;
        if (session.mediaTimer) clearTimeout(session.mediaTimer);
        fire(() => session.options.onAgentConnected?.());
        fireStatus(session, 'in_progress');
        flushPendingPatientAudio(session);
      }
      if (message.type === 'media-error') void this.bridgeFailed(session, new Error('Não foi possível trocar a track de saída.'));
    });
    socket.on('close', () => { if (!session.ending && !session.ended && !session.takenOver) void this.bridgeFailed(session, new Error('Ponte de áudio desconectada.')); });
  }

  private async connectAgent(session: Session): Promise<void> {
    if (session.agentSocket || session.ended) return;
    if (!config.elevenLabsKey) throw new Error('ElevenLabs API key ausente.');
    const auth = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(session.options.agentId)}`, {
      headers: { 'xi-api-key': config.elevenLabsKey }, signal: AbortSignal.timeout(10_000),
    });
    if (!auth.ok) throw new Error(`ElevenLabs signed URL HTTP ${auth.status}`);
    const data = await auth.json() as { signed_url?: string };
    if (!data.signed_url?.startsWith('wss://api.elevenlabs.io/')) throw new Error('URL assinada ElevenLabs inválida.');
    const agent = new WebSocket(data.signed_url);
    session.agentSocket = agent;
    agent.on('open', () => {
      // prompt e first_message são independentes: mesmo sem roteiro específico (ligação manual/
      // captação geral), ainda mandamos first_message="" para ela esperar a pessoa falar primeiro.
      const agentOverride: Record<string, unknown> = {};
      if (session.options.promptOverride) agentOverride.prompt = { prompt: session.options.promptOverride };
      if (session.options.firstMessageOverride !== undefined) agentOverride.first_message = session.options.firstMessageOverride;
      else agentOverride.first_message = '';
      agent.send(JSON.stringify({ type: 'conversation_initiation_client_data', dynamic_variables: { patient_name: session.options.patientName, contact_context: session.options.contactContext, saudacao: greetingForNow(), modelos_whatsapp: session.options.whatsappModels ?? 'nenhum', agenda_amei: session.options.ameiAgenda ?? 'indisponivel', ...(session.options.extraVariables ?? {}) }, conversation_config_override: { agent: agentOverride } }));
    });
    agent.on('message', payload => {
      let message: any;
      try { message = JSON.parse(payload.toString()); } catch { return; }
      if (message.type === 'conversation_initiation_metadata') {
        session.inputFormat = message.conversation_initiation_metadata_event?.user_input_audio_format ?? null;
        session.outputFormat = message.conversation_initiation_metadata_event?.agent_output_audio_format ?? null;
        session.conversationId = message.conversation_initiation_metadata_event?.conversation_id ?? null;
        if (session.conversationId) fire(() => session.options.onConversationId?.(session.conversationId!));
        if (session.inputFormat !== 'pcm_16000' || session.outputFormat !== 'pcm_16000') { void this.bridgeFailed(session, new Error('Formato de áudio ElevenLabs não suportado nesta PoC.')); return; }
        if (session.browserSocket?.readyState === WebSocket.OPEN) session.browserSocket.send(JSON.stringify({ type: 'agent-ready' }));
        flushPendingPatientAudio(session);
      }
      if (message.type === 'ping' && message.ping_event?.event_id != null && agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ type: 'pong', event_id: message.ping_event.event_id }));
      if (message.type === 'client_tool_call' && message.client_tool_call?.tool_call_id) {
        const call = message.client_tool_call as { tool_name?: string; tool_call_id: string; parameters?: Record<string, unknown> };
        const reply = (result: string, isError: boolean) => { if (agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ type: 'client_tool_result', tool_call_id: call.tool_call_id, result, is_error: isError })); };
        const handle = session.options.onToolCall;
        if (!handle) reply('Ferramenta indisponível.', true);
        else void Promise.race([handle(String(call.tool_name ?? ''), call.parameters ?? {}), new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), /^(consultar|registrar)_/.test(String(call.tool_name ?? '')) ? 15000 : 4000))])
          .then(result => reply(result, false)).catch(() => reply('Não foi possível salvar agora; siga a conversa normalmente.', true));
      }
      if (message.type === 'interruption') {
        try { session.options.onFlush?.(); } catch { /* escuta nunca derruba a ligação */ }
        if (session.browserSocket?.readyState === WebSocket.OPEN) session.browserSocket.send(JSON.stringify({ type: 'interruption' }));
      }
      if (message.type === 'audio' && message.audio_event?.audio_base_64 && session.outputFormat === 'pcm_16000') {
        const pcm = Buffer.from(message.audio_event.audio_base_64, 'base64');
        // Rede de segurança: se o texto desta fala já bateu em SELF_TALK_PATTERNS (visto no agent_response,
        // que chega antes do áudio da TTS), o paciente nunca ouve — só fica registrado pra escuta/revisão.
        if (!session.suppressAgentAudio && session.browserSocket?.readyState === WebSocket.OPEN) session.browserSocket.send(pcm, { binary: true });
        try { session.options.onAudio?.('agent', pcm); } catch { /* escuta nunca derruba a ligação */ }
      }
      try {
        if (message.type === 'user_transcript' && message.user_transcription_event?.user_transcript) {
          const patientText = String(message.user_transcription_event.user_transcript);
          // Mesmo critério do roteiro: só conta como "o paciente falou de verdade" quando tem letras de
          // verdade (não é "...", ruído ou vazio) — usado pra classificar sozinho "não atendeu" depois.
          if (/\p{L}{2,}/u.test(patientText)) session.patientSaidSomething = true;
          session.options.onText?.('patient', patientText);
        }
        if (message.type === 'agent_response' && message.agent_response_event?.agent_response) {
          const agentText = String(message.agent_response_event.agent_response);
          // Regra estrutural (pega qualquer frase nova que a gente nunca viu, não só as já catalogadas):
          // antes do paciente ter dito uma palavra de verdade nesta ligação, ela só pode ficar muda ou
          // dizer um "Alô?" bem curto (ver roteiro). Qualquer coisa mais longa que isso nessa fase já é
          // errado por definição, não importa a frase exata — não depende de reconhecer o texto específico.
          const tooLongBeforeRealSpeech = !session.patientSaidSomething && agentText.trim().split(/\s+/).filter(Boolean).length > 6;
          // Reseta a cada fala nova: só suprime o áudio DESTA fala proibida, nunca a próxima.
          session.suppressAgentAudio = tooLongBeforeRealSpeech || SELF_TALK_PATTERNS.some(pattern => pattern.test(agentText));
          if (session.suppressAgentAudio) console.info('[CVORTEX] fala proibida detectada; áudio não vai pro paciente', session.options.callId, tooLongBeforeRealSpeech ? '(fala longa antes de ouvir o paciente)' : '(bateu num padrão conhecido)', JSON.stringify(agentText));
          // A Giovana deve chamar a ferramenta voicemail_detection assim que reconhecer uma gravação/URA.
          // A ElevenLabs registra isso como se fosse uma "fala" com o nome da ferramenta — detecta isso
          // aqui pra encerrar sozinho e já marcar a ligação como caixa postal (dispara o WhatsApp sozinho),
          // sem precisar que o operador clique no botão manual. Best-effort: se a forma de registrar mudar
          // na ElevenLabs, isso só deixa de disparar — o botão manual continua funcionando do mesmo jeito.
          if (/voicemail_detection/i.test(agentText) && !session.ending && !session.ended) {
            console.info('[CVORTEX] voicemail_detection detectado; encerrando e marcando caixa postal', session.options.callId);
            void this.end(session.options.callId, 'voicemail').catch(error => console.error('[CVORTEX] encerramento automático de caixa postal falhou:', error));
          }
          session.options.onText?.('agent', agentText);
        }
        if (message.type === 'agent_response_correction' && message.agent_response_correction_event?.corrected_agent_response) session.options.onText?.('agent', String(message.agent_response_correction_event.corrected_agent_response), true);
      } catch { /* escuta nunca derruba a ligação */ }
    });
    agent.on('error', () => { if (!session.ending && !session.ended && !session.takenOver) void this.bridgeFailed(session, new Error('WebSocket ElevenLabs falhou.')); });
    agent.on('close', code => {
      if (session.ending || session.ended || session.takenOver) return;
      // Giovana encerra a ligação com a ferramenta end_call dela mesma: a ElevenLabs fecha esse socket
      // de forma normal (code 1000) quando isso acontece, antes de qualquer coisa dar errado. Sem
      // distinguir isso, toda ligação que terminou do jeito certo ficava marcada como "falhou".
      // Se ela encerrou sem NUNCA ter ouvido uma palavra de verdade do paciente (ligação toda muda —
      // caixa postal/URA que ela não chegou a reconhecer como tal, ou silêncio puro do início ao fim),
      // isso é caixa postal de verdade, não uma conversa "completed" — e só assim o WhatsApp de
      // confirmação dispara sozinho (ver updateStatusUnlocked em services.ts).
      if (code === 1000) {
        void this.end(session.options.callId, session.patientSaidSomething ? 'completed' : 'voicemail').catch(error => {
          console.error('[CVORTEX] encerramento normal não confirmado:', error);
          void this.bridgeFailed(session, error instanceof Error ? error : new Error('Encerramento não confirmado.'));
        });
      } else {
        void this.bridgeFailed(session, new Error(`WebSocket ElevenLabs fechou (code ${code}).`));
      }
    });
  }

  private async bridgeFailed(session: Session, error: unknown): Promise<void> {
    if (session.ending || session.ended || session.takenOver) return;
    console.error('[CVORTEX] audio bridge failed:', error instanceof Error ? error.message : 'unknown');
    await this.end(session.options.callId, 'failed').catch(hangupError => {
      console.error('[CVORTEX] término da chamada não confirmado:', hangupError);
      session.ending = false;
    });
  }

  async end(callId: string, terminal: CallStatus = 'completed'): Promise<void> {
    const session = this.active;
    if (!session || session.options.callId !== callId || session.ended) return;
    if (session.ending) return;
    session.ending = true;
    try {
      await this.stopBridge(session);
      const hangup = session.page.locator('svg[aria-label="Call End"]');
      if (await hangup.count() === 1) {
        session.callControlSeen = true;
        await hangup.click();
        await hangup.waitFor({ state: 'detached', timeout: 10_000 });
        await this.finish(session, terminal);
      } else if (session.callControlSeen) {
        // The active call control was previously visible and has disappeared.
        await this.finish(session, terminal);
      } else {
        throw new Error('A ligação ainda não está visível no webphone; término não confirmado.');
      }
    } catch (error) {
      session.ending = false;
      throw error;
    }
  }

  /** Botão "Atendeu": o cVortex não tem como avisar com certeza quando a pessoa atendeu de verdade (sem
   * contrato com o fornecedor), então quando o operador PERCEBE que atendeu mas a Giovana ainda está muda
   * (esperando "palavras de verdade" que o reconhecimento de voz não pegou), isso simula a pessoa tendo dito
   * "alô" — ela reage e segue o roteiro normal a partir daí, do mesmo jeito que reagiria a um "alô" real. */
  async markAnswered(callId: string): Promise<void> {
    const session = this.active;
    if (!session || session.options.callId !== callId || session.ended || session.ending) throw new Error('Ligação ativa não encontrada no webphone.');
    if (session.agentSocket?.readyState !== WebSocket.OPEN) throw new Error('A Giovana ainda não está conectada nesta ligação.');
    session.agentSocket.send(JSON.stringify({ type: 'user_message', text: 'Alô' }));
  }

  async takeover(callId: string): Promise<void> {
    const session = this.active;
    if (!session || session.options.callId !== callId || session.ended || session.ending) throw new Error('Ligação ativa não encontrada no webphone.');
    if (session.takenOver) return;
    if (!session.mediaReady || await session.page.locator('svg[aria-label="Call End"]').count() !== 1) throw new Error('A ligação ainda não está pronta para assumir.');
    // restore() closes the bridge socket in the page; the server's close/error
    // handlers treat that as a bridge failure and hang up unless takenOver is
    // already set. Mark it first and roll back if the restore fails.
    session.takenOver = true;
    session.missingCallControlTicks = 0;
    let restored = false;
    try {
      restored = await session.page.evaluate(async () => {
        const bridge = (window as any).__cvActiveBridge;
        return bridge?.restore ? await bridge.restore() : false;
      });
    } catch { restored = false; }
    if (!restored) {
      session.takenOver = false;
      throw new Error('Não foi possível restaurar o microfone do webphone.');
    }
    await this.stopBridge(session);
    console.info('[CVORTEX] microfone restaurado após Assumir', callId);
  }

  private async stopBridge(session: Session): Promise<void> {
    try { if (session.browserSocket?.readyState === WebSocket.OPEN) session.browserSocket.send(JSON.stringify({ type: 'stop' })); } catch { /* socket already closed */ }
    try { await session.page.evaluate(async () => { const bridge = (window as any).__cvActiveBridge; if (bridge?.restore) await bridge.restore(); }); } catch { /* page may have closed */ }
    try { session.browserSocket?.close(); } catch { /* already closed */ }
    try { session.agentSocket?.close(); } catch { /* already closed */ }
    if (session.server) {
      const server = session.server;
      await Promise.race([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => setTimeout(() => { for (const client of server.clients) client.terminate(); resolve(); }, 1500)),
      ]);
    }
    session.server = null;
  }

  private async finish(session: Session, status: CallStatus): Promise<void> {
    if (session.ended) return;
    session.ended = true;
    session.ending = true;
    if (session.monitor) clearInterval(session.monitor);
    if (session.connectWatcher) clearInterval(session.connectWatcher);
    if (session.mediaTimer) clearTimeout(session.mediaTimer);
    await this.stopBridge(session);
    if (this.active === session) this.active = null;
    fireStatus(session, status);
    fire(() => session.options.onEnded?.(status));
  }
}

export interface CvortexProviderAdapter {
  ready(): Promise<boolean>;
  start(options: CvortexStartOptions): Promise<void>;
  end(callId: string): Promise<void>;
  takeover(callId: string): Promise<void>;
  markAnswered(callId: string): Promise<void>;
  connectionStatus?(): Promise<{ browserOpen: boolean; loggedIn: boolean; activeCall: boolean }>;
  openBrowser?(): Promise<void>;
}
let provider: CvortexProviderAdapter = new CvortexBrowserProvider();
/** Test-only seam; callers in the API use the exports below. */
export function setCvortexProviderForTests(adapter: CvortexProviderAdapter): void { provider = adapter; }
export const cvortexReady = (): Promise<boolean> => provider.ready();
export const startCvortexCall = (options: CvortexStartOptions): Promise<void> => provider.start(options);
export const endCvortexCall = (callId: string): Promise<void> => provider.end(callId);
export const takeoverCvortexCall = (callId: string): Promise<void> => provider.takeover(callId);
export const markCvortexCallAnswered = (callId: string): Promise<void> => provider.markAnswered(callId);
export const cvortexConnectionStatus = (): Promise<{ browserOpen: boolean; loggedIn: boolean; activeCall: boolean }> => provider.connectionStatus?.() ?? Promise.resolve({ browserOpen: false, loggedIn: false, activeCall: false });
export const openCvortexBrowser = (): Promise<void> => provider.openBrowser?.() ?? Promise.reject(new Error('Abertura do navegador indisponível.'));
