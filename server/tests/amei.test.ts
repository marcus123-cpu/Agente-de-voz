import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ameiFreeSlots, ameiPatientAppointments, setAmeiForTests } from '../src/amei.js';

function brDate(offset: number): { dmy: string; iso: string; ymd: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + offset * 86400000)).map(p => [p.type, p.value]));
  return { dmy: `${parts.day}/${parts.month}/${parts.year}`, iso: `${parts.year}-${parts.month}-${parts.day}`, ymd: `${parts.year}${parts.month}${parts.day}` };
}

test('AMEI: horários livres só trazem "Livre" do profissional certo e consultas só do telefone da ligação', async () => {
  const d3 = brDate(3), d5 = brDate(5);
  const requests: string[] = [];
  setAmeiForTests({
    async status() { return { browserOpen: true, loggedIn: true }; },
    async open() { /* nada */ },
    async put() { return null as never; },
    async get<T>(path: string): Promise<T> {
      requests.push(path);
      if (path === '/api/v1/especialidades') return [{ id: 7, descricao: 'Cardiologia' }, { id: 8, descricao: 'Dermatologia' }, { id: 9, descricao: 'Inativa', ativo: false }] as T;
      if (path === '/api/v1/profissionais/especialidade/7') return [{ id: 70, tratamento: 'Dr.', nome: 'Paulo', sobrenome: 'Lima' }] as T;
      if (path.startsWith('/api/v1/slots/list-slots-by-professional')) {
        const mk = (date: string, hour: string, status: string, prof = 70, spec = 7) => ({ status, date, formatedHour: hour, idProfessional: prof, specialtyId: spec });
        return [{ professional: { id: 70 }, hours: [mk(d5.dmy, '9:00', 'Livre'), mk(d3.dmy, '08:10', 'Livre'), mk(d3.dmy, '08:40', 'Agendado'), mk(d3.dmy, '09:10', 'Encaixe'), mk(d3.dmy, '10:00', 'Livre', 71), mk(d3.dmy, '11:00', 'Livre', 70, 8)] }] as T;
      }
      if (path === '/api/v1/status_appointments') return [{ value: 1, title: 'Agendado' }, { value: 2, title: 'Cancelado pelo paciente' }] as T;
      if (path.startsWith('/api/v1/appointments/confirm/status?')) {
        return { meta: { totalItems: 3 }, items: [
          { dataHoraInicio: `${d5.iso} 14:30:00`, profissionalNome: 'Dr. Paulo Lima', especialidade: 'Cardiologia', statusId: 1, pacienteNome: 'MARIA SOUZA', pacienteCelular: '(17) 99654-3210' },
          { dataHoraInicio: `${d3.iso} 10:00:00`, profissionalNome: 'Dra. Ana', especialidade: 'Dermatologia', statusId: 2, pacienteNome: 'MARIA SOUZA', pacienteCelular: '17996543210' },
          { dataHoraInicio: `${d3.iso} 11:00:00`, profissionalNome: 'Dr. X', especialidade: 'Clínico Geral', statusId: 1, pacienteNome: 'OUTRO PACIENTE', pacienteCelular: '17988887777' },
        ] } as T;
      }
      throw new Error('rota inesperada ' + path);
    },
  });

  const slots = await ameiFreeSlots({ especialidade: 'cardiologista' });
  assert.match(slots, /Cardiologia/);
  assert.match(slots, /Paulo Lima: 08:10/);
  assert.match(slots, /09:00/);
  assert.doesNotMatch(slots, /08:40|09:10|10:00|11:00/, 'ocupado, encaixe e outro profissional/especialidade não podem aparecer');
  assert.match(await ameiFreeSlots({ especialidade: 'xyz' }), /Não encontrei a especialidade/);
  assert.match(await ameiFreeSlots({ especialidade: 'cardio', profissional: 'Fulano' }), /Não encontrei "Fulano"/);

  const mine = await ameiPatientAppointments('+5517996543210');
  assert.match(mine, /Cardiologia com Dr\. Paulo Lima/);
  assert.match(mine, /MARIA|Maria|paciente: MARIA/i);
  assert.doesNotMatch(mine, /Dermatologia/, 'cancelada não aparece');
  assert.doesNotMatch(mine, /OUTRO|Clínico Geral/, 'consulta de outro telefone não aparece');
  assert.match(await ameiPatientAppointments('+5517911112222'), /Não encontrei consulta marcada/);
  setAmeiForTests({ status: async () => ({ browserOpen: false, loggedIn: false }), open: async () => undefined, put: async () => { throw new Error('x'); }, get: async () => { throw new Error('x'); } });
});

test('AMEI confirmação: só grava se a consulta for a mesma e estiver Agendado/Confirmado, e confere depois', async () => {
  const { ameiApplyOutcome, ameiAppointmentContext, ameiConfirmList, spokenClock, spokenLongDay } = await import('../src/amei.js');
  const tomorrow = brDate(1).iso;
  const puts: Array<{ path: string; body: unknown }> = [];
  let status = 2, date = tomorrow, time = '08:00', ignorePut = false, clinic: number | string = 1795;
  setAmeiForTests({
    async status() { return { browserOpen: true, loggedIn: true }; },
    async open() { /* nada */ },
    async put<T>(path: string, body: unknown): Promise<T> { puts.push({ path, body }); if (!ignorePut) status = (body as { statusId: number }).statusId; return null as T; },
    async get<T>(path: string): Promise<T> {
      if (path === '/api/v1/appointments/99900001') return { id: 99900001, clinica: clinic, data: date, horaInicio: time, statusAgendamento: status, pacienteId: { nome: 'PACIENTE', sobrenome: 'DE TESTE', celular: '17900000001' }, profissionalId: { id: 9, nome: 'ANA', sobrenome: 'EXEMPLO' }, especialidadeId: { id: 678, descricao: 'Psiquiatria' } } as T;
      if (path === '/api/v1/profissionais/especialidade/678') return [{ id: 9, tratamento: 'Dra.' }] as T;
      if (path === '/api/v1/canais/confirmacoes') return [{ id: 3, nome: 'WhatsApp' }, { id: 1, nome: 'Clínica' }] as T;
      if (path.startsWith('/api/v1/appointments/confirm/status?')) return { meta: { totalItems: 1 }, items: [{ agendamentoId: 99900001, dataHoraInicio: `${tomorrow} 08:00`, pacienteNome: 'RODRIGO', pacienteCelular: '17900000001', profissionalNome: 'ANA', status: 'Agendado', statusId: 2, especialidade: 'Psiquiatria', pacienteDataNascimento: '1988-01-01' }] } as T;
      throw new Error('rota inesperada ' + path);
    },
  });

  const ctx = await ameiAppointmentContext('99900001');
  assert.equal(ctx.patientName, 'Paciente de Teste');
  assert.equal(ctx.professional, 'Dra. Ana Exemplo');
  assert.equal(ctx.phone, '17900000001');
  const list = await ameiConfirmList({ dateInit: tomorrow, dateFinish: tomorrow });
  assert.equal(list.rows.length, 1);
  await assert.rejects(() => ameiConfirmList({ dateInit: '2026-11-11', dateFinish: '2026-10-01' }), /data fim/);
  await assert.rejects(() => ameiConfirmList({ dateInit: '2026-01-01', dateFinish: '2026-12-31' }), /31 dias/);
  assert.equal(spokenClock('08:00'), '8 horas da manhã');
  assert.equal(spokenClock('14:30'), '2 e meia da tarde');
  assert.equal(spokenClock('13:00'), '1 hora da tarde');
  assert.equal(spokenLongDay('2026-11-11'), 'quarta-feira, dia 11 de novembro');

  const expected = { appointmentId: '99900001', date: tomorrow, time: '08:00' };
  assert.match(await ameiApplyOutcome(expected, 'confirmou'), /confirmada/);
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.path, '/api/v1/change-appointment-status/99900001');
  assert.deepEqual(puts[0]!.body, { statusId: 16, observacao: 'Confirmado por ligação da assistente virtual Giovana (IA).', canalConfirmacaoId: 1 });
  assert.match(await ameiApplyOutcome(expected, 'confirmou'), /confirmada/);
  assert.equal(puts.length, 1, 'já confirmada: não grava de novo');

  assert.match(await ameiApplyOutcome(expected, 'desmarcou'), /desmarcada/);
  assert.equal((puts[1]!.body as { statusId: number }).statusId, 9);

  status = 2; time = '09:00';
  await assert.rejects(() => ameiApplyOutcome(expected, 'confirmou'), /mudou de dia ou horário/);
  time = '08:00'; status = 5;
  await assert.rejects(() => ameiApplyOutcome(expected, 'confirmou'), /não está mais como Agendado/);
  status = 2; clinic = 999;
  await assert.rejects(() => ameiApplyOutcome(expected, 'confirmou'), /não é da unidade/);
  clinic = 1795; status = 2; ignorePut = true;
  await assert.rejects(() => ameiApplyOutcome(expected, 'confirmou'), /não confirmou a alteração/);
  assert.equal(puts.length, 3, 'só a tentativa que passou nas verificações chegou a gravar');
  ignorePut = false; status = 5;
  await assert.rejects(() => ameiAppointmentContext('99900001'), /não está mais com status "Agendado"/);
  setAmeiForTests({ status: async () => ({ browserOpen: false, loggedIn: false }), open: async () => undefined, put: async () => { throw new Error('x'); }, get: async () => { throw new Error('x'); } });
});

test('AMEI aquecimento: depois de aquecer, a consulta sai do cache; refresh força nova leitura', async () => {
  const { ameiWarmCache, ameiFreeSlots } = await import('../src/amei.js');
  process.env.AMEI_WARM_SPECIALTIES = 'Cardiologia, Inexistente';
  let slotReads = 0;
  const day = brDate(2).dmy;
  setAmeiForTests({
    async status() { return { browserOpen: true, loggedIn: true }; },
    async open() { /* nada */ },
    async put() { return null as never; },
    async get<T>(path: string): Promise<T> {
      if (path === '/api/v1/especialidades') return [{ id: 7, descricao: 'Cardiologia' }] as T;
      if (path === '/api/v1/profissionais/especialidade/7') return [{ id: 70, tratamento: 'Dr.', nome: 'Paulo', sobrenome: 'Lima' }] as T;
      if (path.startsWith('/api/v1/slots/list-slots-by-professional')) { slotReads++; return [{ professional: { id: 70 }, hours: [{ status: 'Livre', date: day, formatedHour: '08:10', idProfessional: 70, specialtyId: 7 }] }] as T; }
      throw new Error('rota inesperada ' + path);
    },
  });
  await ameiWarmCache();
  assert.equal(slotReads, 1, 'o aquecimento leu a agenda de Cardiologia (e ignorou a especialidade inexistente)');
  assert.match(await ameiFreeSlots({ especialidade: 'cardiologista' }), /08:10/);
  assert.equal(slotReads, 1, 'a pergunta do paciente saiu do cache, sem nova leitura na AMEI');
  await ameiFreeSlots({ especialidade: 'cardiologia', refresh: true });
  assert.equal(slotReads, 2, 'refresh força nova leitura');
  delete process.env.AMEI_WARM_SPECIALTIES;
  setAmeiForTests({ status: async () => ({ browserOpen: false, loggedIn: false }), open: async () => undefined, put: async () => { throw new Error('x'); }, get: async () => { throw new Error('x'); } });
});
