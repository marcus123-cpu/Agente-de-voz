import test from 'node:test';
import assert from 'node:assert/strict';
import { hasLiveListeners, publishLive, subscribeLive, type LiveEvent } from '../src/live.js';

test('escuta ao vivo: entrega só a quem ouve aquela ligação e limpa ao sair', () => {
  const received: LiveEvent[] = [];
  const other: LiveEvent[] = [];
  const stop = subscribeLive('call-a', event => received.push(event));
  const stopOther = subscribeLive('call-b', event => other.push(event));
  assert.equal(hasLiveListeners('call-a'), true);

  publishLive('call-a', { kind: 'audio', source: 'patient', pcm: Buffer.from([1, 2, 3, 4]) });
  publishLive('call-a', { kind: 'text', role: 'agent', text: 'Olá' });
  publishLive('call-a', { kind: 'flush' });
  assert.equal(received.length, 3);
  assert.equal(other.length, 0);

  stop();
  assert.equal(hasLiveListeners('call-a'), false);
  publishLive('call-a', { kind: 'flush' });
  assert.equal(received.length, 3);
  stopOther();
});

test('escuta ao vivo: um ouvinte com erro não afeta os outros nem a ligação', () => {
  const ok: LiveEvent[] = [];
  const stopBad = subscribeLive('call-c', () => { throw new Error('painel quebrou'); });
  const stopOk = subscribeLive('call-c', event => ok.push(event));
  assert.doesNotThrow(() => publishLive('call-c', { kind: 'flush' }));
  assert.equal(ok.length, 1);
  stopBad();
  stopOk();
});

test('escuta ao vivo: publicar sem ouvintes é inofensivo', () => {
  assert.doesNotThrow(() => publishLive('ninguem-ouve', { kind: 'audio', source: 'agent', pcm: Buffer.alloc(320) }));
});
