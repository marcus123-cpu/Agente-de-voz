import { chromium } from 'playwright';
import { join } from 'node:path';
import { homedir } from 'node:os';

const profile = join(homedir(), 'AppData', 'Local', 'Codex', 'cvortex-isolated-profile');
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: ['--remote-debugging-port=9223'],
});

const page = context.pages()[0] ?? await context.newPage();
await page.goto(process.env.CVORTEX_URL || 'https://amorsaude.cvortex.com/crm/csm/case', { waitUntil: 'domcontentloaded' });
console.log('cVortex aberto em perfil isolado. Faça o login na janela do navegador.');
await new Promise(resolve => context.on('close', resolve));
