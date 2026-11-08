import { chromium } from 'playwright';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Navegador isolado só para o WhatsApp Web da clínica (separado do cVortex).
const profile = join(homedir(), 'AppData', 'Local', 'AgenteDeVoz', 'whatsapp-profile');
const port = process.env.WHATSAPP_CDP_PORT || '9224';
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: [`--remote-debugging-port=${port}`],
});

const page = context.pages()[0] ?? await context.newPage();
await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded' });
console.log('WhatsApp Web aberto em perfil isolado. Leia o QR code com o celular (uma vez).');
await new Promise(resolve => context.on('close', resolve));
