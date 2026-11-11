import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCardPitchPrompt, cardReferencePrice } from '../src/confirm-prompt.js';

test('prompt do Cartão de TODOS traz os dados e compara o valor só quando há economia', () => {
  const base = { patientName: 'Maria', day: 'quinta-feira, dia 5 de novembro', time: '9 e 10 da manhã', professional: 'Dr. João', specialty: 'Dermatologia', paid: '102 reais', cardPrice: '40 reais', greeting: 'boa tarde' };
  const withSaving = buildCardPitchPrompt({ ...base, saving: true });
  assert.match(withSaving, /pelo particular, no valor de 102 reais/);
  assert.match(withSaving, /teria saído por 40 reais/);
  assert.match(withSaving, /registrar_faltoso com resultado="outro_interesse" e interesse="Cartão de TODOS"/);
  const without = buildCardPitchPrompt({ ...base, paid: '40 reais', saving: false });
  assert.doesNotMatch(without, /teria saído por/);
});
test('preço de referência do cartão por especialidade', () => {
  assert.equal(cardReferencePrice('Clínico Geral'), 30);
  assert.equal(cardReferencePrice('Cardiologia'), 72);
  assert.equal(cardReferencePrice('Dermatologia'), 40);
});

import { buildMissedPrompt, buildWaitlistPrompt } from '../src/confirm-prompt.js';
test('prompts de faltoso e lista de espera só falam em agendar_consulta quando há liberação', () => {
  const missed = { patientName: 'Maria', day: 'quinta-feira, dia 5 de novembro', time: '9 horas da manhã', professional: 'Dr. João', specialty: 'Clínica médica', situation: 'faltou' as const, greeting: 'bom dia' };
  assert.match(buildMissedPrompt({ ...missed, bookable: 'Clínico Geral (Clínica médica)' }), /chame agendar_consulta/);
  assert.doesNotMatch(buildMissedPrompt(missed), /agendar_consulta/);
  const waitlist = { patientName: 'Maria', specialty: 'Clínica médica', greeting: 'bom dia' };
  assert.match(buildWaitlistPrompt({ ...waitlist, bookable: 'Clínico Geral' }), /chame agendar_consulta/);
  assert.doesNotMatch(buildWaitlistPrompt(waitlist), /agendar_consulta/);
});
