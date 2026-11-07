# Mapa de integração cVortex

Atualizado em 06/11/2026. Este mapa distingue **documentação oficial**, **observação autenticada no tenant** e **hipótese ainda não validada**. Foram registrados nomes de operações e campos, sem valores de credenciais, sessão, chamada, áudio, SDP/ICE ou dados pessoais.

## Situação da investigação

- A documentação pública foi revisada em detalhe. Os levantamentos completos estão em [API oficial](research-cvortex-api.md), [áudio e ElevenLabs](research-cvortex-audio.md) e [impacto no projeto](research-cvortex-repo.md). O [mapa de mídia](cvortex-media-map.md) e a [prova de conceito da ponte](cvortex-audio-bridge-poc.md) registram os testes posteriores.
- O Playwright foi instalado no projeto. Uma janela Chromium com perfil próprio foi usada em `https://amorsaude.cvortex.com/crm/csm/case` para login manual e inspeção; foi fechada após os testes, preservando o perfil local isolado.
- A inspeção autenticada foi feita no tenant AmorSaúde com um perfil isolado. Foi realizada uma chamada de teste para número autorizado pelo operador e encerrada pelo botão do webphone. O painel mostrou cronômetro em andamento e depois voltou ao estado sem chamada. O operador confirmou que o celular tocou e que a chamada terminou ao desligar.
- Foram realizados testes adicionais, todos encerrados pela interface. Eles confirmaram as operações internas `DirectAgentContact`/`HangupCall`, assinaturas GraphQL, sinalização SIP e tráfego WebRTC/RTP. A comprovação de toque no aparelho ocorreu no primeiro teste; os testes instrumentados mediram o lado do navegador.
- Testes posteriores confirmaram acesso a `receiver.track`, substituição e restauração de `sender.track` e uma ponte WebSocket local bidirecional. O operador confirmou dois tons no telefone. A tentativa com ElevenLabs parou em HTTP 401 ao pedir URL assinada com a chave local, antes de abrir a sessão ou enviar áudio.
- Após criar a **Giovana Teste** na conta da chave local, a URL assinada passou a funcionar. Em 06/11/2026, a chamada iniciada pelo painel local conectou cVortex ↔ ElevenLabs; o operador confirmou que ouviu a Giovana e ela respondeu. O registro recebeu ID de conversa e terminou como `completed`. Isto valida o **piloto local instrumentado**, não uma API de telefonia oficialmente suportada pela cVortex. Ver [aceite ponta a ponta](cvortex-audio-bridge-poc.md).
- O código atual do projeto inicia chamadas pela integração ElevenLabs + Twilio (`server/src/providers.ts` e `server/src/services.ts`). Não há conector cVortex implementado ou testado no nosso painel.

| Capacidade | API oficial | Webphone do tenant | Decisão para o projeto |
| --- | --- | --- | --- |
| Autenticação | `/v1/auth/` e Bearer documentados; TTL/refresh desconhecidos | Login de sessão e `VoiceLogin` privados observados | Solicitar credenciais próprias da API |
| Originar/desligar | Sem contrato público localizado | `DirectAgentContact` e `HangupCall` funcionaram no teste | Aguardar contrato oficial para backend |
| Status | Histórico e contadores agregados documentados | `dialing`, `answerCall`, `hangup` observados via WS privado | Confirmar semântica e entrega servidor a servidor |
| Áudio ao vivo | Sem interface pública localizada | WebRTC bidirecional PCMU/8 kHz confirmado | Confirmar trunk SIP ou media stream oficial |
| Gravação | Listagem e URL de download após ligação | Não verificada para a chamada de colaborador | Útil só para histórico |

## 1. Autenticação oficial

**Documentado:** `POST https://api.cvortex.com/v1/auth/` com JSON `{"username":"{subdominio_tenant}\\{username}","password":"..."}`. As demais chamadas usam `Authorization: Bearer <token>` e `Content-Type: application/json`. A documentação informa limite agregado de 10 requisições por segundo por tenant e tempo máximo de resposta de 60 s. [Autenticação e Segurança](https://docs.cvortex.io/help/autenticacao-e-seguranca).

**Pendente:** formato real da resposta, nome do campo do token, duração/expiração, refresh e permissões necessárias. A documentação pública consultada não especifica esses itens. As credenciais da API devem ser solicitadas ao suporte cVortex; a própria documentação diz que são diferentes das credenciais de login no navegador. [Visão geral da API](https://docs.cvortex.io/help/api-cvortex).

**Observação do tenant:** o login do navegador e o `VoiceLogin` interno do webphone são caminhos distintos do `/v1/auth/` público. O `VoiceLogin` observado envia campos `exten`, `password`, `user`, `digitalId`, `providerAccountKey` e `serverDigital` à API privada do CRM. Nenhum valor foi guardado. Isso não esclarece TTL ou refresh do token **oficial** e não deve ser reutilizado no backend.

## 2. Iniciar ligação

**Documentado:** a plataforma permite ligações ativas no canal Voz, com um número configurado para a unidade de negócio. O canal depende de conta de provedor de voz, número e tipo de caso. [Canal de Voz](https://docs.cvortex.io/help/voz).

**Não confirmado:** endpoint público para iniciar ligação, método, telefone de destino, ramal/usuário, caller ID selecionável, ID da chamada e payload/resposta. O índice da API pública enumera casos, workflow, histórico de interações e gravações, mas não descreve uma API de originação de chamadas. Isso é ausência na documentação examinada, não prova de inexistência no produto. [Visão geral da API](https://docs.cvortex.io/help/api-cvortex).

**Observado no webphone do tenant:** o menu `Ligar para um Colaborador` abre um campo `Digite apenas números` e um botão verde `Ligar para o número`. A chamada de teste acionou a operação GraphQL privada `DirectAgentContact` em `POST https://amorsaude.cvortex.com/api/crm/graphql`; o painel mostrou cronômetro ativo. Payload e resposta não foram preservados por conterem dados de sessão/chamada. Esse caminho é evidência de funcionamento na interface, não contrato de API para o backend.

**Detalhe técnico da operação observada, sem valores:** `DirectAgentContact` recebeu `mutDirectAgentContact` com campos `exten`, `destinyNumber`, `digitalId`, `serverDigital`, `context`. Respondeu HTTP 200 com `data.directAgentContact` booleano. A resposta imediata não fornece `Call Id` diretamente. O ID apareceu em eventos de assinatura posteriores. A operação `MakeCall` também existe no bundle do webphone, mas **não** foi exercitada. A rota `Ligar para um Colaborador` pode ter semântica diferente da discagem de um paciente vinculada a caso; o teste não provou criação de caso, gravação ou seleção de caller ID.

**Distinção importante:** o `POST /v1/workflow-executions` executa uma ação de workflow sobre um caso; a documentação não afirma que ele origina chamadas. O início de workflow por webhook, lançado em agosto de 2026, também não comprova discagem telefônica. [Fluxos e Workflows](https://docs.cvortex.io/help/fluxos-de-atendimento-questionarios-e-workflows), [release de agosto](https://docs.cvortex.io/help/2026-agosto).

## 3. Controle da chamada

| Ação | Situação |
| --- | --- |
| Atender/recusar/ignorar | Interface e mutations privadas `RefuseCall`/`IgnoreCall`; `AnswerCall` aparece como assinatura. Recebimento real não foi testado. API suportada pendente. |
| Desligar | Botão `Call End` e mutation privada `HangupCall` usados. Input `cause`, `codeCause`, `thirdPartyId`, `callId`, `digitalId`, `serverDigital`, `externalId`; retorno HTTP 200 com booleano. API suportada pendente. |
| Transferir/conferência | Interface mostra transferência; bundle contém `DirectTransfer`, `AssistedTransfer`, `ConfirmTransfer`, `InitiatedConference`, `MakeNewCallForConference` e `CancelNewCallForConference`. Não testadas. URA documenta **Transferir Chamada**. |
| Pausar agente | Botão `Pausa`; bundle contém `SetDndRequest` e `SetUnDndRequest`. Não testado. Não confundir pausa de recebimento com pausa de uma chamada. |
| Mute/espera | Controles `Mic` e `Colocar a Chamada em Espera` visíveis. Nenhum endpoint público ou mutation de hold/mute foi confirmado; podem ser ações SIP/WebRTC locais. Não testados. |

As funções **Iniciar de Voz**, **Transferir Chamada** e **Encerrar Chamada** são blocos do Workflow Studio, não endpoints de telefonia publicados. [Funções do Workflow](https://docs.cvortex.io/help/funcoes-do-workflow).

## 4. Eventos e status

**Documentado:** a entidade analítica Voice History inclui `Call Id`, `External Id`, `Way`, `Ani`, `Did`, `Exten`, datas de início, atendimento e fim, `Hangup Cause`, `End Reason` e campos de transferência. Isso oferece dados históricos para correlação, mas não comprova webhooks de `ringing`, `answered`, `talking`, `completed`, `failed`, `busy` ou `no_answer` em tempo real. [Voice History](https://docs.cvortex.io/help/visao-geral-entidade-voice-history).

**Observado no tenant:** o WS GraphQL assina `Dialing`, `AnswerCall`, `Hangup`, `TransferActivated`, `BlindTransfer`, `AttendedTransfer`, `ConferenceActivated`, `ConferenceJoin`, `ConferenceLeave`, `VoiceLoginConfirmation` e outros. Durante teste foram recebidos `dialing`, `answerCall` e `hangup`. Os campos comuns incluem `callId`, `digitalId`, `exten`, `serverDigital`, `externalId`, timestamps e dados de auditoria; `hangup` também inclui `cause` e `codeCause`. `dialing` inclui destino/ramal e `answerCall` inclui `callWay`, `queueId` e `uui`. Nenhum valor foi salvo. É um stream **privado de sessão do webphone**, não webhook de servidor. O `callId` da assinatura é candidato à correlação com Voice History, ainda não comparado com registro histórico.

**Pendente:** semântica exata de cada evento para a perna do agente e a do destinatário, ordem/latência, IDs nas transferências, eventos de `busy`, `failed` e `no_answer`, reconexão/replay e contrato oficial de entrega. O SIP `180 Ringing` visto era resposta do navegador ao `INVITE` recebido; não pode ser apresentado como prova isolada de que o telefone de destino tocou.

**Observado na UI:** cronômetro durante a chamada e remoção do controle `Call End` após desligar. Não existe ainda mapeamento validado para todos os estados de negócio `ringing`, `answered`, `talking`, `completed`, `failed`, `busy` e `no_answer`.

## 5. WebSocket, WebRTC e SIP

**Observado após login:** `wss://amorsaude.cvortex.com/api/crm/subscriptions` transporta mensagens GraphQL WS (`connection_init`, `start`, `data`, `ka`, `stop`); `wss://amorsaude.cvortex.com/api/crm/ping-pong` mantém conexão; `wss://sip004.cvortex.com:8099/ws` transporta sinalização SIP. Foram vistos `REGISTER`, `OPTIONS` e respostas `SIP/2.0 200`, sem armazenar headers ou credenciais. O GraphQL HTTP usa `POST https://amorsaude.cvortex.com/api/crm/graphql` e, na inicialização do webphone, apareceram operações `SipUserConfiguration`, `VoiceLogin` e `SetWebPhoneStatus`. Essas rotas são internas da interface, não endpoints oficiais documentados para integração.

**Observado na abertura do webphone:** a inicialização criou `RTCPeerConnection` e solicitou `getUserMedia` com áudio, sem vídeo. Essas conexões iniciais não transportaram áudio no teste. Uma tentativa intermediária de iniciar nova chamada após recarga falhou antes da discagem; a chamada instrumentada seguinte foi concluída normalmente e forneceu os dados abaixo.

**Observado em chamada instrumentada:** o WS SIP recebeu `INVITE` com SDP, respondeu `100`, `180`, `200` com SDP, recebeu `ACK`; ao término recebeu `BYE` e respondeu `200`. O SDP continha `m=audio`, `sendrecv`, `rtpmap`, `fmtp`, `ice-ufrag`, `ice-pwd`, `candidate`, `fingerprint` e `setup`; nenhum valor sensível foi retido. A oferta e resposta listaram PCMU/8000, PCMA/8000, Opus/48000 e telephone-event/8000. Uma conexão WebRTC do teste recebeu oferta, enviou resposta e passou a `connected`, com um sender e um receiver de áudio, um servidor `turn:` configurado e candidatos `host` e `relay`. Os primeiros peer connections criados na inicialização não tinham ICE servers explícitos e não transportaram áudio observado.

**Documentado pela cVortex:** o [guia de estações de trabalho](https://docs.cvortex.io/help/requisitos-para-estacoes-de-trabalho) menciona cenário de SIP trunk condicionado a IP público fixo, hosts `sip.cvortex.com`/`sip001`–`sip008`, porta 8099/TCP e codecs G.711/G.729. Essa menção de infraestrutura não concede acesso a trunk para este tenant. A compatibilidade com ElevenLabs depende de provisionamento e roteamento pelo fornecedor. O WS SIP do navegador não concede credenciais ou acesso suportado para registrar um cliente SIP externo.

**Pendente:** identidade/URL do registrar e trunk contratado, políticas de autenticação, TLS/SRTP, correlação SIP↔`Call Id`, se o trunk permite originação automatizada e se admite `REFER`. Não copiar cookies, tokens, passwords SIP, SDP integral ou parâmetros ICE.

## 6. Áudio

**Documentado:** a API fornece gravações **após** a ligação: `GET /v1/case/{caseId}/voice-records` retorna `messageHistoryId`, direção, duração e data; `GET /v1/voice-records/{recordId}` retorna URL assinada de download. A documentação do canal Voz prevê disponibilização das gravações em até 15 minutos. Isso não serve como áudio bidirecional em tempo real para ElevenLabs. [Canais e Mensagens](https://docs.cvortex.io/help/canais-e-mensagens), [Canal de Voz](https://docs.cvortex.io/help/voz).

**Pergunta central pendente:** a cVortex ou o provedor de voz contratado oferece media stream, SIP trunk, WebRTC gateway ou outra interface **suportada** que entregue o áudio do paciente e aceite o áudio de volta da IA? É preciso confirmar fluxo, codec, amostragem, autenticação, latência, IDs de correlação e autorização contratual com a cVortex. Não inferir acesso à mídia em tempo real a partir da gravação ou do WebSocket de sinalização.

**Medição no navegador:** `getStats()` mostrou RTP `inbound-rtp` e `outbound-rtp` de áudio com pacotes/bytes não nulos; o codec **negociado** nos dois sentidos era `audio/PCMU` a 8 kHz. Isso comprova que o webphone recebe áudio da rede e envia áudio do microfone por WebRTC. A chamada curta não comprovou uma conversa com a pessoa atendendo, nem separação entre voz do destinatário, ringback e áudio de URA na faixa recebida. Também não autoriza usar o TURN/SIP interno como ponte externa.

**PoC posterior:** uma chamada atendida permitiu conectar `receiver.track` a Web Audio e transmitir 81 blocos PCM pelo WebSocket local. O servidor devolveu 150 blocos de tom, convertidos em track para `sender.replaceTrack()`. O operador falou e ouviu o tom. A frase não foi gravada ou transcrita, portanto sua inteligibilidade no servidor não foi comprovada. O microfone foi restaurado e a ligação encerrada. Ver [evidências e limites](cvortex-audio-bridge-poc.md).

**Opções documentadas do lado ElevenLabs:** trunk SIP para telefonia existente e `POST /v1/convai/sip-trunk/outbound-call`, ou WebSocket de conversa com áudio. O trunk aceita G.711 PCMU/PCMA em 8 kHz e G.722 em 16 kHz; a mídia do webphone observada usa PCMU/8 kHz. O encaixe SIP é tecnicamente plausível **se** a cVortex/provedor disponibilizar trunk interoperável ao tenant; o WebSocket ElevenLabs exige um stream bidirecional oficial da cVortex. [SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [API de chamada via SIP](https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call), [WebSocket ElevenLabs](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets).

**Monitoria:** a cVortex documenta `Espiar` para supervisor com permissão `Monitor Calls` na interface, sem API pública de áudio. [Acompanhamento em tempo real](https://docs.cvortex.io/help/acompanhando-em-tempo-real-os-atendimento-de-voz-d).

**Pista:** a release de fevereiro de 2026 menciona governança de integrações de IA, incluindo ElevenLabs, sem publicar nesta página o mecanismo de mídia ou configuração para este tenant. [Releases](https://docs.cvortex.io/help/releases).

## 7. Integrações e workflows

A função Integração do Workflow Studio pode chamar REST externo e está disponível em Atendimento por Voz. O início por webhook permite que um sistema externo dispare um workflow. Esses recursos podem transportar dados e decisões, mas não comprovam transporte de áudio nem ligação ativa. [Integração](https://docs.cvortex.io/help/integracao), [release de agosto](https://docs.cvortex.io/help/2026-agosto).

**Outros dados oficiais úteis:** `GET /v1/dashboard/resume` oferece contadores agregados de agentes/atendimentos de voz, sem estado de chamada individual. `GET /v1/case/{id}` e buscas de casos podem correlacionar atendimento e contato, mas status de caso não é status telefônico. `POST /v1/workflow-executions` retorna um ID de execução do workflow, não `Call Id`. [Dashboard e Filas](https://docs.cvortex.io/help/dashboard-e-filas), [Gestão de Casos](https://docs.cvortex.io/help/gestao-de-casos), [Fluxos e Workflows](https://docs.cvortex.io/help/fluxos-de-atendimento-questionarios-e-workflows).

## 8. Primeiro teste proposto

1. Obter da cVortex a especificação suportada para originar chamada e encerrá-la, além de credenciais próprias da API e escopo necessário.
2. Confirmar número/canal de saída e usar um número de teste controlado pelo operador. O teste pela interface foi executado e o recebimento no celular foi confirmado.
3. Implementar adaptador cVortex no backend, sem credenciais no frontend. Guardar IDs de chamada e caso separadamente; converter status apenas quando houver evento ou resposta real.
4. Testar `LIGAR PELO CVORTEX` → telefone toca → `Chamando` → `Em ligação` → `DESLIGAR` → término confirmado. Não considerar o teste concluído só porque a requisição HTTP respondeu com sucesso.
5. Só depois avaliar ponte de áudio com ElevenLabs, monitoria e tomada de chamada, cada uma dependente de interface suportada.

## Questões para o suporte cVortex

1. Há API oficial para originar, consultar estado e desligar ligação? Solicitar método, URL, payload, resposta, erros, limites e versão.
2. Há webhook ou stream oficial de estados (`ringing`, atendimento, conexão, término e causa) com `Call Id`? Como autenticar e correlacionar com `Case Id`?
3. Qual o TTL do access token, há refresh token, e quais permissões são exigidas para voz?
4. Há interface oficial bidirecional de áudio ao vivo para integração com ElevenLabs? Codec, taxa, latência, transporte e política de acesso?
5. A integração ElevenLabs citada nas releases está disponível para este tenant? Como é configurada e que recursos cobre?
6. Um workflow iniciado por webhook pode iniciar uma chamada ativa? Se sim, qual função, configuração e identificador retornado?
7. O tenant AmorSaúde pode usar um trunk SIP para ElevenLabs ou um stream de mídia bidirecional? Qual número/canal, SBC, autenticação, codecs e correlação de IDs? O `sip004` visto no webphone é apenas servidor do cliente navegador ou também um ponto de interconexão contratável?
8. Há forma oficial de monitorar/assumir ligação fora da interface `Espiar`? O recurso entrega faixas separadas para agente e cliente?

## 9. Impacto no projeto atual

O teste do webphone **não passou** pelo aplicativo local. Hoje `server/src/providers.ts` origina e encerra via ElevenLabs/Twilio, `server/src/services.ts` exige `elevenlabsAgentId` e `twilioCallSid`, `server/src/monitor.ts` depende de Twilio Media Streams, o banco armazena IDs Twilio/ElevenLabs e a UI só libera discagem quando essa pilha está configurada. A revisão arquivo a arquivo está em [research-cvortex-repo.md](research-cvortex-repo.md).

Quando houver contrato oficial cVortex, a fase 1 requer um adaptador de voz no servidor, credenciais **próprias da API** em secret store, migração aditiva para `provider`, `cvortex_call_id` e `cvortex_case_id`, mapeamento de eventos com origem e horário e tratamento de 401/429/timeout. A interface deve mostrar somente estados de telefonia confirmados. Um timeout no comando de discagem não autoriza rediscagem automática, pois a primeira chamada pode ter sido aceita sem resposta HTTP. O polling atual por chamada no Twilio não deve ser copiado sem respeitar 10 req/s agregadas do tenant.

Os controles de IA, monitoria ao vivo e assumir chamada dependem de uma ponte de mídia e controle suportados. As gravações pós-chamada não os habilitam. Há ainda uma divergência local: `docs/architecture.md` cita rotas HTTP `POST/DELETE /api/calls/:id/monitor`, enquanto o código inicia/para monitoria ao abrir/fechar o WS `/ws/calls/:id/monitor`; isso deve ser corrigido ao redesenhar a rota cVortex.
