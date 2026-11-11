import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { classifyWhatsappReply } = await import('../src/services.js');

test('"sim" claro e curto confirma', () => {
  for (const text of ['Sim', 'sim!', 'Sim, confirmo', 'Confirmado', 'ok', 'Pode confirmar', 'Vou sim', 'Estarei lá', '👍', 'Tá bom, obrigada'])
    assert.equal(classifyWhatsappReply(text), 'yes', text);
});
test('negação, pedido de mudança ou dúvida nunca confirma', () => {
  for (const text of ['Não', 'Não vou conseguir', 'Quero remarcar', 'Preciso cancelar', 'Sim, mas posso trocar o dia?', 'Quem é?', 'Qual o valor?', 'Número errado', 'Sim não posso'])
    assert.equal(classifyWhatsappReply(text), 'other', text);
});
