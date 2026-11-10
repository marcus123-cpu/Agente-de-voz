/**
 * Frases que o roteiro proíbe explicitamente ela gerar sozinha durante silêncio/ruído (ver TONE_BLOCK em
 * confirm-prompt.ts). Compartilhado entre services.ts (sinalização pós-ligação pra revisão) e
 * cvortex-provider.ts (corta o áudio na hora pro paciente nunca ouvir, mesmo que o modelo gere o texto).
 * Confirmado com transcrições reais (fork de investigação, 2026-11-10): o padrão de verdade é sempre a
 * frase longa aparecendo ~2s depois de um único turno de ruído "..." — nunca o "Alô?" curto permitido.
 */
export const SELF_TALK_PATTERNS = [
  /tem alguém aí/i,
  /voc[eê] (ainda est[aá]|consegue me ouvir)/i,
  /telefone (está|continua) tocando/i,
  /a ligação caiu/i,
  /vou desligar/i,
  /não estou conseguindo te? ?ouvir/i,
];
