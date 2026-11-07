# Plano de QA para substituir Twilio pelo fluxo local cVortex

Data: 06/11/2026. Revisão do código atual, sem alteração de backend/frontend e sem novas chamadas. Este plano trata o caminho cVortex como **ponte experimental no navegador**; as operações GraphQL/SIP internas do webphone não são contrato público de integração. Referência da prova de mídia: [QA dos experimentos](research-cvortex-qa.md).

## Dependências atuais que precisam sair ou ser separadas

| Área | Estado atual | Risco na migração |
| --- | --- | --- |
| Discagem | `startCall` exige `elevenlabsAgentId` e chama `/v1/convai/twilio/outbound-call` | O botão continuará bloqueado pela configuração Twilio/telefone ElevenLabs mesmo se cVortex estiver pronto. |
| Desligamento | `endCall` exige `twilioCallSid` e conclui após `calls.update(completed)` | O backend local não controla por si só a aba autenticada do webphone; um comando aceito não prova que a outra ponta desligou. |
| Estado | Webhook Twilio e polling a cada 5 s; `syncCall` busca pelo SID | Remover polling sem substituto deixa chamadas ativas indefinidamente; mapear eventos cVortex com origem e timestamp. |
| Monitoria | `CallMonitorService` inicia Twilio Media Stream `both_tracks`, decodifica µ-law 8 kHz e entrega duas faixas à UI | A PoC cVortex possui `receiver.track` e sender de saída; não comprovou duas faixas separadas nem um stream de monitoria independente. Não manter indicadores “Paciente/Giovana” sem prova de separação. |
| Banco | `calls.twilio_call_sid` e `elevenlabs_conversation_id`, ambos únicos; eventos em JSONB | Preservar registros antigos; criar campos próprios para `provider`, ID cVortex, ID de sessão local e correlação de evento. Nunca reutilizar `twilio_call_sid` como identificador cVortex. |
| Interface | `ready` exige `integrations.elevenlabs && integrations.twilio`; `in_progress` vira `AI_CONNECTED`; participantes mostram Giovana | Uma chamada cVortex com tom ou operador não deve aparecer como conversa de IA. Prontidão e rótulos devem refletir capacidades reais. |
| Teste existente | `persistence-fallback.test.ts` prova retenção em memória de SID Twilio após falha de atualização | Precisará de equivalente para ID cVortex e, sobretudo, recuperação depois de reinício do processo. |

## Invariantes para implementação

1. **Uma ação, uma tentativa de discagem.** `POST /api/calls` deve ter chave de idempotência por intenção de chamada. Duplo clique, retry HTTP ou duas abas não podem gerar duas ligações. Timeout depois de enviar comando produz estado `unknown/pending_reconciliation`, não `failed` definitivo nem rediscagem automática.
2. **Registro antes do efeito externo.** Validar sessão, número, cérebro ativo e bloqueio `do_not_contact`; criar a intenção de chamada de forma durável antes de comandar cVortex. Se o banco estiver indisponível antes disso, não discar. Persistir ID de correlação antes de permitir outra tentativa.
3. **Confirmação por evidência.** `connecting` é intenção local; `ringing` só com evento de toque da perna de destino; `in_progress` só com resposta/estabelecimento confirmado; `completed` só com término confirmado pelo fornecedor/webphone. Mutation HTTP 200, SIP `180` do navegador ou desaparecimento de botão não bastam isoladamente para estados da ponta remota.
4. **Transições monotônicas e auditáveis.** Eventos atrasados, duplicados e fora de ordem não regridem chamada terminal. Guardar origem, tipo, horário recebido e ID externo sem tokens/payload completo. Estados `busy`, `no_answer`, `failed` e `canceled` dependem de causa real, não de inferência por timeout local.
5. **Controle restrito à chamada certa.** O comando de desligar deve exigir sessão autorizada, chamada ativa vinculada à aba/operador corretos, ID de correlação e confirmação do resultado. Não procurar “o botão Call End atual” se houver mais de uma sessão ou chamada. Um segundo comando de desligar deve ser idempotente.
6. **Áudio com dono e restauro.** Ao instalar a ponte, guardar `sender`, `originalTrack` e `originalEnabled`. Desinstalar no hangup, WS fechado, erro, navegação, troca de PC e cancelamento de IA. Restaurar a track exata e o estado de mute anterior; nunca forçar `enabled=true` cegamente. Se a track original terminou, relatar falha em vez de declarar restauro.
7. **Sem mídia ou segredos persistidos.** Apenas métricas agregadas e estados de controle vão para banco/log. PCM, SDP integral, ICE/TURN, cookies, tokens, credenciais SIP, URLs assinadas e transcrições pessoais não entram em eventos, erros ou histórico. O WS de áudio precisa autenticação por sessão/chamada, limite de tamanho e fila, e isolamento entre chamadas.
8. **Falha segura da mídia.** Se backend/WS/ElevenLabs cair, impedir áudio artificial preso ou microfone aberto inesperadamente. A política de fallback (restaurar operador, silenciar ou encerrar) deve ser explícita e testada. A chamada não deve continuar exibindo “IA em conversa” sem áudio de IA.
9. **Compatibilidade histórica.** Migration aditiva; registros Twilio antigos seguem legíveis no histórico. A remoção de dependências/campos só depois de verificar backup, migração e consultas. O webphone cVortex não deve receber credenciais de banco ou API ElevenLabs no navegador.
10. **Capacidade de produção separada de PoC.** Um teste funcional da ponte local não torna GraphQL privado, SIP WS ou `replaceTrack` interface suportada. O painel deve explicitar modo experimental até contrato oficial ou piloto operacional aprovado.

## Testes automatizados propostos

| Caso | Simulação | Aceite |
| --- | --- | --- |
| Validação antes da chamada | Número inválido, cérebro inativo, `do_not_contact`, banco fora | Nenhum comando de discagem enviado. |
| Idempotência | Duas requisições iguais simultâneas, resposta HTTP perdida, refresh da UI | Exatamente uma intenção e uma ação externa; mesmo ID retornado ou reconciliação explícita. |
| Timeout ambíguo | Controlador local aceita a discagem, mas não responde ao backend | Chamada permanece pendente e reconciliável; nenhuma segunda discagem automática. |
| Controle de desligar | Comando duplicado, chamada já encerrada, ID de outra sessão, ack sem evento de hangup | Sem controle cruzado; terminal só após confirmação; operação repetida não falha nem afeta outra chamada. |
| Eventos | `answer` antes de `dialing`, duplicatas, evento velho após terminal, WS reconecta | Sequência final correta, um único `answered_at`/`ended_at`, sem regressão ou automação duplicada. |
| Persistência | Falha de update após comando externo; reinício do backend antes do retry | ID/estado recuperável do banco ou por reconciliação; não perder chamada ativa nem rediscá-la. |
| Ponte de áudio | PCM válido/inválido, taxa incompatível, frames gigantes, fila cheia, WS fecha, sender recriado | Rejeição/limitação previsível, memória limitada, mic restaurado e sessão de áudio encerrada. |
| Isolamento | Duas chamadas/sessões e tentativa de usar token WS de outra chamada | Frames/comandos não vazam nem controlam chamada alheia. |
| Segurança HTTP/WS | Sem sessão, origem não permitida, token vencido, upgrade direto | 401/403; nenhum áudio, comando ou dado de chamada exposto. |
| Histórico | Linhas Twilio legadas e novas cVortex na mesma consulta | Ambos renderizam com provedor e IDs corretos; sem texto “IA conectada” para chamada sem IA. |

Esses testes devem usar um controlador cVortex falso e WS de mídia sintética; não executar chamadas pagas ou depender do tenant em CI. Testes reais ficam em uma suíte manual separada, com número autorizado.

## Testes manuais no tenant autorizado

1. Discagem externa pelo caminho **Ligar para um Colaborador**: confirmar telefone tocando, resposta, duração e término, com uma única chamada. Registrar apenas tempos e estados filtrados.
2. Testar separadamente uma chamada associada a caso de laboratório. Confirmar que operação, IDs, caller ID, Voice History e eventos correspondem; não assumir equivalência com a chamada de colaborador.
3. Durante chamada atendida, medir energia agregada da track inbound nas janelas de fala/silêncio do titular. Não gravar amostras. Confirmar também que a saída da ponte chega ao telefone e que o microfone volta ao nível/mute original.
4. Interromper WS, recarregar aba, trocar dispositivo e encerrar enquanto o bridge transmite; verificar a política de fallback, nenhuma track órfã e estado do painel consistente.
5. Se produto incluir espera, transferência, conferência, monitoria ou “assumir”, ensaiar cada transição com participantes autorizados. Reidentificar PC/sender/receiver e verificar que ninguém ouve áudio indevido.
6. Repetir o ciclo após reiniciar backend e navegador; verificar reconciliação da chamada ativa e persistência do resultado manual/`do_not_contact`.

## Achados concretos do código atual

- `server/src/services.ts`: falha de API após criar registro marca `failed`; no fluxo cVortex local, um timeout pode ocorrer **depois** de a discagem ser aceita. O fallback `volatileCalls` só vive no processo; atualização adiada se perde no crash.
- `server/src/services.ts`: `updateStatus` impede regressão após terminal, mas não define transições válidas antes disso. Um evento atrasado pode regredir `in_progress → ringing`. `deliverAutomation` é disparado sem aguardar e sem outbox; entrega pode ser duplicada ou perdida em falha/reinício.
- `server/src/index.ts`: o polling de chamadas e webhooks são específicos da Twilio; a rota `/api/calls/:id` chama `syncCall`, portanto um novo provedor precisa de estratégia explícita para estado. O status de integração e prontidão da UI também são específicos de Twilio/telefone ElevenLabs.
- `server/src/monitor.ts`: a monitoria pressupõe `both_tracks`, formato µ-law 8 kHz e assinatura Twilio. A PoC cVortex tem uma track remota sem prova de separação. Reutilizar o protocolo sem alterar semântica produziria indicadores enganosos.
- `web/src/App.tsx`: `in_progress` aparece como `AI_CONNECTED` e o participante “Giovana” como em conversa. A etapa cVortex inicial é telefonia/ponte local; só mostrar IA quando um agente ElevenLabs realmente estiver conectado e produzindo áudio.
- `server/src/index.ts`: `sameOrigin` rejeita origem divergente, mas aceita requisição mutável **sem** cabeçalho `Origin`. Para o novo canal de controle, testar autenticação de sessão, CSRF e autorização por chamada além de CORS. O WS existente exige Origin exato e cookie; o WS de mídia precisa credencial curta vinculada à chamada.
- `supabase/migrations/20261106162717_initial_voice_center.sql`: `calls` liga toda chamada a um cérebro; manter esse vínculo na fase 1 exige definição clara de que “cérebro selecionado” não significa IA ativa. A migration inicial contém IDs/descrições de agente, mas a migração cVortex pode ser aditiva.

## Portões de aceite

**Fase 1, telefonia cVortex local:** chamada única pelo painel, estados comprovados, desligamento remoto confirmado, histórico e `do_not_contact` persistentes após refresh/restart. Nenhuma dependência Twilio em runtime ou texto da UI. Registrar que a operação usa um adaptador experimental se ainda depender da sessão do webphone.

**Fase 2, ponte IA:** fala inbound validada, áudio ElevenLabs retornado ao telefone, latência medida, interrupção funcionando, restauração da track em falhas e documentação de limites. Não aprovar com tom local apenas.

**Produção:** contrato de mídia/telefonia suportado pela cVortex ou aceite explícito do piloto experimental, autenticação/observabilidade/reconciliação operacionais e testes de falhas reais concluídos.
