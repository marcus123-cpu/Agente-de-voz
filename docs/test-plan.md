# Plano de aceite — piloto cVortex + ElevenLabs

Use somente um telefone cujo titular tenha autorizado a chamada. O webphone deve estar autenticado no perfil isolado. Não registre áudio, conteúdo de transcrição ou credenciais no teste. Marque como aprovado apenas o que foi confirmado no telefone e no painel.

## Verificação sem chamada

1. `npm run typecheck`, `npm run build` e `npm test -w server` passam.
2. `GET /api/integrations/status` mostra cVortex, ElevenLabs e banco disponíveis, sem revelar segredos. Sem login de operador, rotas operacionais e WS de eventos retornam acesso negado.
3. Número inválido, cérebro inativo e contato `do_not_contact` são rejeitados antes da discagem. Um clique não gera duas chamadas.
4. Sem aba cVortex autenticada, o painel indica indisponibilidade; abrir a aba e autenticar muda a prontidão.

## Ligação autorizada

1. Informe nome e número de teste no painel, clique **Ligar** uma vez. Confirme toque no telefone e registro `connecting` sem duplicação.
2. Atenda e fale uma frase. Confirme se a Giovana é audível, responde à frase e não há eco excessivo. Verifique no painel que `ai_connected` só aparece após a ponte efetiva.
3. Clique **Desligar**. Confirme término no telefone, remoção do controle de chamada no webphone, estado terminal no painel e restauração do microfone original.
4. Recarregue o painel. Confirme histórico e resultado manual persistidos; o ID de conversa é salvo quando fornecido pela ElevenLabs.

## Falhas controladas

- Interromper WS local/ElevenLabs deve restaurar a track e permitir desligamento; não deixar ligação invisível ou sem controle.
- Se a resposta da discagem se perder após clique, marcar início incerto e orientar conferência no webphone; não rediscá-lo automaticamente.
- Encerramento só vira `completed` após confirmação visual/evento do webphone; status atrasado não pode reabrir chamada terminal.
- Desconectar o banco antes da discagem impede a chamada; falha posterior de persistência mantém o estado temporário e tenta sincronizar sem discar novamente.
- Um logout ou fechamento do navegador durante chamada deve informar falha e liberar recursos locais.

O [plano detalhado de QA](cvortex-local-migration-qa-plan.md) cobre idempotência, segurança do WS, eventos fora de ordem, persistência e recuperação. Em 06/11/2026, a ligação pelo **painel** ao número autorizado passou: o telefone tocou, a Giovana foi ouvida e respondeu, `ai_connected` e ID de conversa foram registrados, e o término persistiu como `completed`. Cenários de falha, latência, monitoria e transferência permanecem sem aceite operacional.
