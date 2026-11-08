import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const CDP_URL = process.env.WHATSAPP_CDP_URL || 'http://127.0.0.1:9224';
const WA_ORIGIN = 'https://web.whatsapp.com';

export interface WhatsappStatus { browserOpen: boolean; loggedIn: boolean; qrVisible: boolean; busy: boolean }
export class WhatsappSendError extends Error {}

class WhatsappProvider {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private launching = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  private launch(): void {
    if (this.launching) return;
    this.launching = true;
    const script = fileURLToPath(new URL('../../tools/whatsapp-browser.mjs', import.meta.url));
    try {
      const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', error => { this.launching = false; console.error('[WHATSAPP] navegador não iniciou:', error.message); });
      child.on('exit', () => { this.launching = false; });
      child.unref();
    } catch (error) { this.launching = false; console.error('[WHATSAPP] navegador não iniciou:', error); }
  }

  private async getPage(): Promise<Page> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
      this.page = null;
    }
    if (this.page && !this.page.isClosed()) return this.page;
    const pages = this.browser.contexts().flatMap(context => context.pages());
    const page = pages.find(candidate => candidate.url().startsWith(WA_ORIGIN)) ?? pages[0];
    if (!page) throw new WhatsappSendError('Abra o WhatsApp Web no perfil isolado.');
    page.on('dialog', dialog => { void dialog.accept().catch(() => undefined); });
    this.page = page;
    return page;
  }

  async status(): Promise<WhatsappStatus> {
    try {
      const page = await this.getPage();
      if (!page.url().startsWith(WA_ORIGIN)) return { browserOpen: true, loggedIn: false, qrVisible: false, busy: this.pending > 0 };
      const loggedIn = await page.locator('#pane-side').count() > 0;
      const qrVisible = !loggedIn && await page.locator('canvas').count() > 0;
      return { browserOpen: true, loggedIn, qrVisible, busy: this.pending > 0 };
    } catch {
      return { browserOpen: false, loggedIn: false, qrVisible: false, busy: false };
    }
  }

  async open(): Promise<void> {
    try { const page = await this.getPage(); await page.bringToFront(); } catch { this.launch(); }
  }

  /** Envia um texto para um número (E.164) e só retorna quando o WhatsApp confirmou o envio. Um envio por vez. */
  send(phone: string, text: string): Promise<void> {
    this.pending += 1;
    const run = this.chain.then(() => this.sendNow(phone, text));
    this.chain = run.catch(() => undefined).finally(() => { this.pending -= 1; });
    return run;
  }

  private async sendNow(phone: string, text: string): Promise<void> {
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(digits)) throw new WhatsappSendError('Número inválido.');
    let page: Page;
    try { page = await this.getPage(); } catch { this.launch(); throw new WhatsappSendError('WhatsApp Web fechado. Abra pela aba Automações e leia o QR code.'); }
    await page.goto(`${WA_ORIGIN}/send?phone=${digits}&text=${encodeURIComponent(text)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const composer = page.locator('footer div[contenteditable="true"]').first();
    const invalid = page.getByText(/inválido|invalid/i).first();
    const login = page.locator('canvas').first();
    const outcome = await Promise.race([
      composer.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'ok' as const),
      invalid.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'invalid' as const),
      login.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'login' as const),
    ]).catch(() => 'timeout' as const);
    if (outcome === 'login') throw new WhatsappSendError('WhatsApp Web não está conectado (leia o QR code).');
    if (outcome === 'invalid') throw new WhatsappSendError('Esse número não tem WhatsApp.');
    if (outcome !== 'ok') throw new WhatsappSendError('O WhatsApp Web demorou demais para abrir a conversa.');
    const before = await page.locator('div.message-out').count();
    await composer.press('Enter');
    try {
      await page.waitForFunction((count: number) => document.querySelectorAll('div.message-out').length > count, before, { timeout: 15000 });
    } catch { throw new WhatsappSendError('Não consegui confirmar o envio da mensagem.'); }
  }
}

export interface WhatsappAdapter { status(): Promise<WhatsappStatus>; open(): Promise<void>; send(phone: string, text: string): Promise<void> }
let adapter: WhatsappAdapter = new WhatsappProvider();
export function setWhatsappForTests(value: WhatsappAdapter): void { adapter = value; }
export const whatsappStatus = (): Promise<WhatsappStatus> => adapter.status();
export const openWhatsapp = (): Promise<void> => adapter.open();
export const sendWhatsapp = (phone: string, text: string): Promise<void> => adapter.send(phone, text);
