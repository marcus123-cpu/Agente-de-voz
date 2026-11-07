# Pesquisa: API oficial cVortex

Consulta em 06/11/2026. Este relatório trata somente da documentação pública oficial. **Não** usa a sessão autenticada do tenant. Uma rota interna vista no navegador não se torna API suportada por aparecer aqui.

## Autenticação e limites

| Tema | Confirmado na documentação | O que falta |
| --- | --- | --- |
| Login | `POST https://api.cvortex.com/v1/auth/`, corpo JSON com `username` no formato `{identificador_do_tenant}\\{username}` e `password` | Resposta de exemplo, nome do campo do token, TTL, refresh e escopos |
| Autorização | `Authorization: Bearer <token>`; JSON de entrada e saída | Granularidade das permissões de voz |
| Operação | 10 requisições/s **agregadas por tenant**, HTTP 429 ao exceder; timeout máximo da API de 60 s; datas UTC/GMT-0 em milissegundos | Cabeçalhos de rate limit, política de retry, idempotência |

Fonte: [Autenticação e Segurança](https://docs.cvortex.io/help/autenticacao-e-seguranca). A [visão geral da API](https://docs.cvortex.io/help/api-cvortex) diz para solicitar credenciais da API ao suporte cVortex e não reutilizar a senha do navegador.

## Voz: capacidades publicadas

- O [Canal de Voz](https://docs.cvortex.io/help/voz) suporta ligações recebidas e efetuadas pela plataforma, depende de conta do provedor, número, unidade de negócio e tipo de caso. O número configurado no canal é usado para chamadas ativas e receptivas.
- A página [Canais e Mensagens](https://docs.cvortex.io/help/canais-e-mensagens) publica `GET /v1/case/{caseId}/voice-records` para listar gravações de um caso. Resposta de exemplo: `messageHistoryId`, `way`, `channel: VOICE`, `duration`, `callDate`.
- A mesma página publica `GET /v1/voice-records/{recordId}`, que retorna `attachmentUrl` assinado e expirável. A [página do canal](https://docs.cvortex.io/help/voz) informa até 15 minutos para disponibilização das gravações. São registros após a chamada, não streaming de áudio ao vivo.
- [Voice History](https://docs.cvortex.io/help/visao-geral-entidade-voice-history) documenta `Call Id`, `External Id`, `Parent Call Id`, `Way`, ANI (caller ID), DID/DNIS, `Exten`, `Dial Type`, timestamps de início/atendimento/bridge/fim, `Hangup Cause`, `End Reason`, transferência e `MessageId Recording`. É entidade analítica/histórica; sua página não publica endpoint REST nem webhook de evento em tempo real.

**Não localizados no catálogo público da API:** endpoint para iniciar ligação, atender, desligar, mute, espera, transferência de chamada ativa, seleção de caller ID, consulta individual de chamada ativa, media stream, SIP trunk/registrar, WebRTC gateway, webhooks de estados da chamada. Isso não prova que o produto ou contrato não ofereça essas capacidades; exige especificação do fornecedor. A [visão geral da API](https://docs.cvortex.io/help/api-cvortex) enumera explicitamente as áreas publicadas e menciona consulta de interações de voz, não originação ou controle telefônico.

## Casos e workflows: úteis para correlação, não equivalem a controle de ligação

| Endpoint oficial | Uso documentado |
| --- | --- |
| `GET /v1/case/{id}` | Busca caso por UUID, com canal, contato, responsável e status do **caso** |
| `GET /v1/case/business/{id}` | Busca pelo ID numérico de negócio |
| `GET /v1/cases/search` e `GET /v1/cases/count` | Busca/contagem v1 com filtros de BU, status, fila, contato e período |
| `POST /v2/cases/search` e `POST /v2/cases/search/count` | Busca/contagem v2 com filtros avançados e intervalo de datas |
| `PUT /v1/case/assign` | Atribui responsável ou devolve o **caso** ao motor de distribuição |
| `PUT /v1/case/change-status` | Muda status do **caso**, não o estado telefônico |
| `GET /v1/workflow-executions/actions/{statusId}/{caseTypeId}` | Lista ações de fluxo aplicáveis |
| `POST /v1/workflow-executions` | Executa ação de workflow em caso com `actionId`, `caseId`, `caseTypeId`, `statusFunctionId`, `formRequestList`; retorna `workflowExecutionsRequest` |
| `POST /v1/wos/chatbot/start` | Transfere atendimento de **chat** aberto para bot; a documentação exige canal de chat ativo |

Fontes: [Gestão de Casos](https://docs.cvortex.io/help/gestao-de-casos), [Fluxos de Atendimento, Questionários e Workflows](https://docs.cvortex.io/help/fluxos-de-atendimento-questionarios-e-workflows). Portanto, `caseStatus` e `workflowExecutionsRequest` não devem ser apresentados como `ringing`/`answered` nem como `Call Id`.

## Filas e usuários

`GET https://api.cvortex.com/v1/dashboard/resume?distributionRuleId={ID}` (ou `distributionRuleName`) devolve contadores agregados em tempo real: `agentsAvailableVoice`, `agentsBusyVoice`, `agentsTalking`, `inAttendanceVoice`, `inQueueVoice`, além dos de chat. Não devolve estado individual ou mídia de chamada. [Dashboard e Filas](https://docs.cvortex.io/help/dashboard-e-filas).

`GET /v1/users/search` lista usuários, e `GET /v1/users/count` conta; há ainda `POST /v1/users/{id}/activate` e `/inactivate`. São operações administrativas, não login de ramal/atender/desligar. [Usuários](https://docs.cvortex.io/help/usuarios).

## Integração e gatilhos

A função [Integração](https://docs.cvortex.io/help/integracao) do Workflow Studio suporta SQL, SOAP e REST externo em fluxos de atendimento humano, digital e **por voz**. A [release de agosto de 2026](https://docs.cvortex.io/help/2026-agosto) anuncia início de workflow por webhook HTTP externo, mas não publica nessa página URL, autenticação, payload ou garantia de que o gatilho possa originar chamada. A [lista de funções da URA](https://docs.cvortex.io/help/funcoes-do-workflow) contém `Iniciar de Voz`, `Mensagem de Voz`, `Opções de Voz`, `Transferir Chamada`, `Pergunta de Voz` e `Encerrar Chamada`; são nós do construtor de fluxo, não API REST pública.

A [release de fevereiro de 2026](https://docs.cvortex.io/help/releases) cita governança de integrações Gemini/ElevenLabs, sem contrato público de mídia, callbacks ou configuração para este tenant.

## Perguntas objetivas ao suporte

1. Enviar contrato OpenAPI/Postman oficial para chamadas ativas, consulta de estado, desligar, transferir, mute/hold e webhooks com `Call Id`.
2. Enviar exemplo de resposta do `/v1/auth/`, TTL, refresh (se houver), escopos e credenciais próprias de API para o tenant.
3. Explicar ligação entre `Call Id` de Voice History, `Case Id`, `messageHistoryId` de gravação e eventual ID do provedor.
4. Confirmar se o webhook de início do Workflow Studio pode originar chamada; se puder, fornecer URL de gatilho, schema, autenticação, idempotência, resposta e limites.
5. Detalhar interface **suportada** de áudio bidirecional com ElevenLabs, ou integração nativa habilitável no tenant.
