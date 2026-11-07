import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { cvortexConnectionStatus } from './cvortex-provider.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));

async function checkElevenLabsKey(key: string): Promise<boolean | null> {
  if (!key) return false;
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(7000),
    });
    if (response.ok) return true;
    if (response.status === 401 || response.status === 403) return false;
    return null;
  } catch { return null; }
}

export async function connectionDetails() {
  const [cvortex, keyValid] = await Promise.all([cvortexConnectionStatus(), checkElevenLabsKey(config.elevenLabsKey)]);
  return {
    cvortex,
    elevenlabs: { keyConfigured: Boolean(config.elevenLabsKey), keyValid, agentId: config.elevenLabsAgentId || null },
  };
}

async function persistKey(key: string): Promise<void> {
  let content = '';
  try { content = await readFile(envPath, 'utf8'); } catch { /* Local setup may have no .env yet. */ }
  const line = `ELEVENLABS_API_KEY=${key}`;
  const updated = /^ELEVENLABS_API_KEY=.*$/m.test(content)
    ? content.replace(/^ELEVENLABS_API_KEY=.*$/m, line)
    : `${content.trimEnd()}\n${line}\n`;
  const temp = `${envPath}.tmp`;
  await writeFile(temp, updated, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, envPath);
  config.elevenLabsKey = key;
}

export async function connectElevenLabs(key: string): Promise<void> {
  const clean = key.trim();
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(clean)) throw new Error('Formato da chave ElevenLabs inválido.');
  const valid = await checkElevenLabsKey(clean);
  if (valid === false) throw new Error('A ElevenLabs recusou a chave informada.');
  if (valid === null) throw new Error('Não foi possível validar a chave na ElevenLabs agora.');
  await persistKey(clean);
}

export async function disconnectElevenLabs(): Promise<void> {
  await persistKey('');
}
