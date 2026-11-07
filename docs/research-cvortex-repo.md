# Revisão do projeto para integração cVortex

Revisão estática em 06/11/2026. Este documento descreve o código existente e o que seria necessário alterar **depois** de confirmar os contratos suportados da cVortex. Não valida telefonia cVortex nem áudio em tempo real.

## Resumo da arquitetura atual

O painel React chama o Express (`POST /api/calls`) para iniciar uma ligação. O serviço valida telefone, cérebro e bloqueio de contato, grava uma linha `calls`, chama a API **ElevenLabs outbound Twilio**, recebe `conversation_id` e `callSid`, consulta/encerra pelo SDK Twilio e atualiza status por webhook Twilio/ElevenLabs e polling. O monitoramento abre um Media Stream **Twilio** e retransmite PCM para o navegador. Referências: `web/src/api.ts:28`, `server/src/index.ts:85`, `server/src/services.ts:78`, `server/src/providers.ts:25`, `server/src/monitor.ts:60`.

O teste real anterior no cVortex ocorreu no webphone do fornecedor e **não** exercitou este painel, backend, Supabase, ElevenLabs ou Twilio. Logo, nenhuma chamada cVortex está registrada automaticamente em `calls` por este código.

## Pontos exatos de adaptação

| Componente | Acoplamento atual | Alteração exigida para cVortex |
| --- | --- | --- |
| `server/src/config.ts:5` | Variáveis ElevenLabs, Twilio e `monitoringConfigured()` exige Twilio | Configuração cVortex no servidor: tenant, credencial **oficial da API**, token/expiração, canal/BU/número de saída, endpoints/webhooks suportados. Não usar cookie do perfil Playwright. |
| `server/src/providers.ts:13` | `normalizeStatus` traduz status Twilio | Criar tradutor cVortex apenas após obter estados documentados ou capturados de contrato suportado; conservar estado bruto com origem/timestamp para auditoria. |
| `server/src/providers.ts:25` | `startElevenLabsCall()` origina via ElevenLabs/Twilio | Um `CvortexVoiceProvider.startCall` deve usar API oficial de originação se existir. `DirectAgentContact` visto no webphone é operação interna, não contrato estável. |
| `server/src/providers.ts:36` | `fetchTwilioCall()`, `endTwilioCall()` exigem `callSid` | Consultar/encerrar pela API cVortex suportada e pelo ID da chamada cVortex. Não reutilizar `callSid` como se fosse um ID genérico. |
| `server/src/services.ts:78` | `startCall()` exige `elevenlabsAgentId`, salva IDs ElevenLabs/Twilio | Separar escolha da rota telefônica da escolha do cérebro; salvar `provider`, `cvortex_call_id`, `cvortex_case_id`, ID externo opcional e identificador de correlação. O cérebro/IA pode ser adicionado numa fase posterior. |
| `server/src/services.ts:133` | `syncCall()` consulta Twilio; `endCall()` falha sem `twilioCallSid` | Delegar ao provedor escolhido; se a cVortex não oferecer consulta/encerramento oficial, não apresentar o painel como capaz de controlar a chamada. |
| `server/src/index.ts:37` | Webhook Twilio assinado e webhook ElevenLabs | Acrescentar receptor cVortex somente com especificação de assinatura/autenticação, IDs, ordem e política de repetição. Não aceitar eventos do WebSocket privado do navegador como webhook de servidor. |
| `server/src/index.ts:113` | Polling a cada 5 s de todas as chamadas ativas via Twilio | Substituir por eventos oficiais ou consulta cVortex suportada. Respeitar o limite agregado de 10 req/s por tenant da API cVortex; polling por chamada sem controle pode exceder. |
| `server/src/monitor.ts:40` | Exige `callSid`; valida assinatura Twilio e formato μ-law 8 kHz | O monitor atual não funciona com uma chamada cVortex. Precisa de interface de mídia cVortex/provedor explicitamente suportada, autenticação própria e formato real de áudio. |
| `web/src/App.tsx:41,84` | "Pronto para ligar" requer ElevenLabs + Twilio + DB | Expor estado da rota cVortex separadamente. Não bloquear chamada cVortex por credenciais Twilio ausentes; não mostrar "online" por login no webphone apenas. |
| `web/src/App.tsx:112,117` | Painel exibe Giovana como participante, mostra monitor Twilio e IDs Twilio/ElevenLabs | Na fase 1, mostrar chamada cVortex e IDs pertinentes, sem alegar que IA está conectada ou que monitoria funciona. |
| `web/src/monitor.tsx:46` | Player espera `monitor.ready` PCM s16le 8 kHz com dois tracks | Só reutilizar quando houver gateway de mídia suportado e comprovada separação dos tracks. |
| `web/src/types.ts:4` e `server/src/types.ts:8` | `Call` inclui IDs de fornecedores específicos | Adicionar `provider` e IDs cVortex com tipos explícitos; manter IDs existentes opcionais para registros antigos. |
| `server/src/repository.ts:10` | Seleção e busca por `twilio_call_sid`/`elevenlabs_conversation_id` | Persistir e buscar por ID da chamada cVortex e, se houver, `Case Id`; índices únicos compostos com `provider` quando apropriado. |
| `supabase/migrations/20261106162717_initial_voice_center.sql:26` | Tabela `calls` só prevê IDs Twilio/ElevenLabs | Nova migration aditiva para IDs cVortex, provedor e eventos brutos mínimos. Não reescrever migration já aplicada nem apagar histórico. |

## Fluxo recomendado para a primeira fase

1. Backend recebe `{patientName, phone}` do painel e valida E.164/`do_not_contact` como já faz `server/src/services.ts:78`.
2. Backend registra a tentativa antes de pedir a ligação, preservando `call.id` interno como chave principal.
3. Adaptador chama **somente** o método de originação suportado pela cVortex, armazena resposta e IDs. Definir comportamento para timeout/erro sem rediscagem cega: a chamada pode ter sido aceita mesmo se a resposta se perdeu.
4. Atualizar `ringing`, `in_progress` e terminal por evento/consulta oficial; guardar ID e horário de origem para evitar regressões e duplicações. `server/src/services.ts:98` já bloqueia atualização de estados finais, mas a taxonomia cVortex ainda não foi confirmada.
5. Encerrar por método oficial e confirmar fim por evento/consulta; o retorno HTTP sozinho não deve marcar `completed` se a API apenas aceitou o pedido.
6. Mostrar no painel o estado efetivamente comprovado. Não mostrar "Giovana falando", "Ouvir ao vivo" ou "Assumir" na rota cVortex até existir integração de IA e mídia validada.

## Segurança e dados

- `server/src/auth.ts` usa cookie de operador HttpOnly e segredo HMAC; rotas operacionais passam por `requireSession` em `server/src/index.ts:75`. A API cVortex deve ficar **atrás** desse backend. Credenciais de API e refresh ficam em variáveis/secret store do servidor, nunca em `VITE_`, `localStorage`, URL ou no repositório.
- O login do webphone e o token de sessão observados no navegador não são as credenciais oficiais da API. O perfil Playwright é apenas para pesquisa manual.
- `server/src/repository.ts` usa service role do Supabase no servidor; a migration habilita RLS e revoga acesso de `anon`/`authenticated`. Manter essa fronteira ao adicionar campos cVortex.
- As tabelas armazenam nome e telefone. Eventos devem guardar somente estado/IDs/horário necessários, sem SIP Authorization, SDP, ICE credentials, cookies, payload de áudio ou URLs assinadas de gravação. A tabela `call_events` aceita JSON genérico (`server/src/repository.ts:25`), portanto a filtragem deve ocorrer antes da gravação.
- API oficial publica limite de 10 req/s por tenant. O polling global de `server/src/index.ts:113` precisará de fila/backoff se permanecer.

## Monitoramento e áudio

`server/src/monitor.ts` é implementado especificamente para Twilio Media Streams: valida `x-twilio-signature`, confirma `callSid` e `accountSid`, exige `audio/x-mulaw` 8 kHz, converte em PCM e entrega aos supervisores por `/ws/calls/:id/monitor`. A presença de SIP/WebRTC no webphone cVortex não torna esse serviço compatível. Sem uma interface de mídia oficial, a fase 2 não deve ligar esse controle no frontend.

As gravações cVortex documentadas são recuperadas **após** a chamada. Podem ajudar histórico/auditoria, mas não substituem áudio ao vivo para ElevenLabs ou supervisão. A futura arquitetura de áudio requer confirmação de transporte, codec, direção, latência, IDs e autenticação. Também é preciso confirmar se a integração de IA da própria cVortex atende ao objetivo antes de criar uma ponte externa.

## Testes mínimos quando houver contrato oficial

1. Teste do adaptador com resposta de sucesso/erro/timeout e ID de correlação; garantir uma única tentativa de discagem por clique e evitar rediscagem após timeout ambíguo.
2. Teste de mapeamento de status cVortex com eventos fora de ordem, duplicados e terminais; não inventar `answered_at`.
3. Teste HTTP do painel: chama número autorizado, toca no celular, estado acompanha e comando desligar termina de fato. Confirmar no aparelho e na API cVortex.
4. Teste de bloqueio `do_not_contact`, credencial ausente/expirada, 401/429, backoff e limite por tenant.
5. Teste de persistência/correlação entre `call.id` interno, `Call Id` cVortex e `Case Id` quando houver; proteger dados pessoais em logs.
6. Teste de áudio e monitoria em etapa separada, somente depois de obter interface oficial de mídia. O teste existente `server/tests/persistence-fallback.test.ts` cobre falha de persistência após chamada ElevenLabs/Twilio, não uma chamada cVortex.

## Divergência documental local

`docs/architecture.md` descreve `POST /api/calls/:id/monitor` e `DELETE /api/calls/:id/monitor`. O código atual inicia e para o monitoramento com a conexão/desconexão do WebSocket `/ws/calls/:id/monitor` em `server/src/monitor.ts`; não há essas rotas HTTP em `server/src/index.ts`. Atualizar o documento quando a arquitetura de monitoramento for decidida.
