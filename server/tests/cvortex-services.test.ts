import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

test('serviço cVortex: estados monotônicos, persistência adiada e discagem ambígua', async () => {
  const brainId = '11111111-1111-4111-8111-111111111111';
  const rows = new Map<string, Record<string, unknown>>();
  const events: { call_id: string; event_type: string }[] = [];
  let nextId = 1;
  let failUpdates = false;
  let startCount = 0;
  let lastContactContext = '';
  let endCount = 0;
  let takeoverCount = 0;
  let ambiguous = false;
  let confirmEnded: (() => void) | null = null;
  let connectAgent: (() => void) | null = null;

  const db = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const path = req.url || '';
    if (path.startsWith('/rest/v1/brains')) {
      res.end(JSON.stringify({ id: brainId, name: 'Captação', slug: 'patient-acquisition', description: null, objective: null, system_prompt: null, elevenlabs_agent_id: 'agent_test', voice_name: null, is_active: true }));
      return;
    }
    if (path.startsWith('/rest/v1/contacts')) { res.end('null'); return; }
    if (path.startsWith('/rest/v1/call_events') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { events.push(JSON.parse(body)); res.statusCode = 201; res.end('{}'); });
      return;
    }
    if (path.startsWith('/rest/v1/calls') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const id = `22222222-2222-4222-8222-${String(nextId++).padStart(12, '0')}`;
        const values = JSON.parse(body);
        const row = { id, ...values, cvortex_call_id: null, elevenlabs_conversation_id: null, answered_at: null, ended_at: null, duration_seconds: null, transfer_requested: false, summary: null, metadata: values.metadata ?? {}, created_at: new Date().toISOString() };
        rows.set(id, row);
        res.statusCode = 201;
        res.end(JSON.stringify(row));
      });
      return;
    }
    if (path.startsWith('/rest/v1/calls') && req.method === 'PATCH') {
      if (failUpdates) { res.statusCode = 503; res.end(JSON.stringify({ message: 'database temporarily unavailable' })); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const id = new URL(req.url!, 'http://localhost').searchParams.get('id')?.replace('eq.', '') || '';
        const row = rows.get(id);
        if (!row) { res.statusCode = 404; res.end('{}'); return; }
        Object.assign(row, JSON.parse(body));
        res.end(JSON.stringify(row));
      });
      return;
    }
    if (path.startsWith('/rest/v1/calls') && req.method === 'GET') {
      const id = new URL(req.url!, 'http://localhost').searchParams.get('id')?.replace('eq.', '');
      res.end(JSON.stringify(id ? rows.get(id) || null : [...rows.values()]));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  db.listen(0, '127.0.0.1');
  await once(db, 'listening');
  const address = db.address();
  if (!address || typeof address === 'string') throw new Error('mock database has no port');
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_test';
  process.env.ELEVENLABS_API_KEY = 'key_test';
  process.env.ELEVENLABS_AGENT_ID = 'agent_test';
  process.env.ENABLE_N8N = 'false';

  try {
    const service = await import('../src/services.js');
    const { CvortexAmbiguousStartError, setCvortexProviderForTests } = await import('../src/cvortex-provider.js');
    (await import('../src/whatsapp.js')).setWhatsappForTests({ status: async () => ({ browserOpen: false, loggedIn: false, qrVisible: false, busy: false }), open: async () => undefined, send: async () => undefined });
    (await import('../src/amei.js')).setAmeiForTests({ status: async () => ({ browserOpen: false, loggedIn: false }), open: async () => undefined, put: async () => { throw new Error('AMEI fora do teste'); }, get: async () => { throw new Error('AMEI fora do teste'); } });
    setCvortexProviderForTests({
      ready: async () => true,
      start: async options => { startCount++; lastContactContext = options.contactContext; if (ambiguous) throw new CvortexAmbiguousStartError(); confirmEnded = () => { void options.onEnded?.('completed'); }; connectAgent = () => { void options.onAgentConnected?.(); }; },
      end: async () => { endCount++; },
      takeover: async () => { takeoverCount++; },
    });

    await test('eventos atrasados não regridem estado e terminal não reabre', async () => {
      const call = await service.startCall(brainId, 'Teste', '+5517996543210');
      assert.equal(startCount, 1);
      assert.equal(call.provider, 'cvortex');
      assert.equal(call.status, 'connecting');
      await service.updateStatus(call, 'in_progress');
      assert.equal((await service.getManagedCall(call.id))?.status, 'in_progress');
      assert.ok((await service.getManagedCall(call.id))?.answeredAt);
      await service.updateStatus(call, 'ringing');
      assert.equal((await service.getManagedCall(call.id))?.status, 'in_progress');
      await service.updateStatus(call, 'completed');
      const ended = await service.getManagedCall(call.id);
      assert.equal(ended?.status, 'completed');
      assert.ok(ended?.endedAt);
      await service.updateStatus(call, 'in_progress');
      await service.updateStatus(call, 'failed');
      assert.equal((await service.getManagedCall(call.id))?.status, 'completed');
      assert.equal(events.filter(event => event.call_id === call.id && event.event_type === 'call.status').length, 2);
    });

    await test('atualização falha após discagem: mantém estado em memória e persiste sem rediscagem', async () => {
      const call = await service.startCall(brainId, 'Teste', '+5517996543210');
      const count = startCount;
      failUpdates = true;
      const live = await service.updateStatus(call, 'in_progress');
      assert.equal(live.status, 'in_progress');
      assert.equal((await service.getManagedCall(call.id))?.status, 'in_progress');
      assert.equal(rows.get(call.id)?.status, 'connecting');
      failUpdates = false;
      await new Promise(resolve => setTimeout(resolve, 5200));
      assert.equal(rows.get(call.id)?.status, 'in_progress');
      assert.equal(startCount, count);
    });

    await test('ack de desligar não fabrica término; evento confirmado conclui uma vez', async () => {
      const call = await service.startCall(brainId, 'Teste', '+5517996543210');
      const afterAck = await service.endCall(call);
      assert.equal(afterAck.status, 'connecting');
      assert.equal(endCount, 1);
      assert.ok(confirmEnded);
      confirmEnded();
      for (let i = 0; i < 20 && (await service.getManagedCall(call.id))?.status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const ended = await service.getManagedCall(call.id);
      assert.equal(ended?.status, 'completed');
      assert.ok(ended?.endedAt);
      await service.endCall(ended!);
      assert.equal(endCount, 1);
    });

    await test('assumir desliga a IA sem encerrar a ligação', async () => {
      const call = await service.startCall(brainId, 'Teste', '+5517996543210');
      await service.updateStatus(call, 'in_progress');
      connectAgent?.();
      for (let i = 0; i < 20 && (await service.getManagedCall(call.id))?.metadata?.ai_connected !== true; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const connected = await service.getManagedCall(call.id);
      assert.equal(connected?.metadata?.ai_connected, true);
      const previousEnds = endCount;
      const taken = await service.takeoverCall(connected!);
      assert.equal(taken.status, 'in_progress');
      assert.equal(taken.metadata?.human_takeover, true);
      assert.equal(taken.metadata?.ai_connected, false);
      assert.equal(endCount, previousEnds);
      assert.equal(takeoverCount, 1);
      await service.takeoverCall(taken);
      assert.equal(takeoverCount, 1);
    });

    await test('timeout ambíguo não marca failed nem tenta nova discagem', async () => {
      ambiguous = true;
      const count = startCount;
      const previousEnds = endCount;
      await assert.rejects(service.startCall(brainId, 'Teste', '+5517996543210'), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 503);
        return true;
      });
      assert.equal(startCount, count + 1);
      const latest = [...rows.values()].at(-1)!;
      const id = String(latest.id);
      const call = await service.getManagedCall(id);
      assert.equal(call?.status, 'connecting');
      assert.equal(call?.metadata?.start_uncertain, true);
      assert.equal(endCount, previousEnds);
    });

    await test('origem confirmada segue até a ponte de áudio', async () => {
      ambiguous = false;
      const call = await service.startCall(brainId, 'Teste', '+5517996543210', 'recent_card_member');
      assert.equal(lastContactContext, 'recent_card_member');
      assert.equal(call.metadata?.contact_context, 'recent_card_member');
    });
  } finally {
    db.close();
  }
});
