# Mapa de mídia e telefonia do webphone cVortex

Data: 06/11/2026. Tenant de teste: AmorSaúde. **OFICIAL** = documentação do fornecedor; **OBSERVADA** = inspeção da build/sessão; **TESTADA** = chamada controlada; **HIPÓTESE** = depende de teste ou contrato. Os testes chamaram somente o número fornecido pelo operador. Nenhum áudio, SDP completo, cookie, token, senha SIP/TURN, IP privado ou identificador de chamada foi salvo.

## Visão geral e limite da prova

```text
Telefone de teste ↔ telefonia cVortex ↔ SIP/WebRTC do webphone
                                           ├─ receiver.track → <audio> do navegador
                                           └─ sender.track ← microfone ou track sintética

PoC local TESTADA:
receiver.track → Web Audio → WS local → servidor local (contagem, sem gravação)
servidor local → PCM de tom → WS local → Web Audio → sender.replaceTrack() → telefone
```

**TESTADA:** a pessoa no telefone falou e ouviu o tom gerado pelo servidor local. O browser enviou 81 blocos/165.888 bytes ao WS local, recebeu 150 blocos/96.000 bytes de PCM de teste, manteve a PeerConnection `connected`, restaurou o microfone e encerrou a chamada. Isso prova um caminho bidirecional **dentro de uma sessão de webphone instrumentada**. Não comprova interface de integração estável/suportada pela cVortex nem ligação de paciente vinculada a caso.

## PeerConnections, senders, receivers e tracks

| Item | Resultado | Classe |
| --- | --- | --- |
| Seleção da PC ativa | `connectionState=connected`, `iceConnectionState=connected`, `signalingState=stable`; outras PCs da inicialização não tinham RTP ativo | TESTADA |
| Transceiver de áudio | 1, `mid=0`, `direction=currentDirection=sendrecv` | TESTADA |
| Sender | 1 track `audio`, `enabled=true`, `readyState=live`; identidade de objeto igual à track de `getUserMedia` | TESTADA |
| Receiver | 1 track `audio`, `enabled=true`, `readyState=live`; `new MediaStream([receiver.track])` alimentou `MediaStreamAudioSourceNode` em memória | TESTADA |
| Troca de track | `sender.replaceTrack(track sintética)` resolveu; `sender.track` apontou para a track nova; PC permaneceu `connected`; microfone original restaurado. `signalingState` estava `stable` nas duas amostras, sem captura contínua para excluir renegociação transitória | TESTADA |
| Mute reversível | `originalMic.enabled=false` por 0,5 s e restauração para `true` | TESTADA localmente; efeito auditivo do mute não confirmado |

As IDs das tracks ficaram apenas em memória; não foram impressas. O teste de receiver prova acesso à faixa recebida no contexto da página. A confirmação de que ela carregava **fala específica** do interlocutor é indireta: a pessoa falou durante a PoC e blocos foram enviados pelo pipeline, mas não foram feitas análise de energia/VAD nem escuta/gravação do conteúdo. Conforme o estágio da ligação, a faixa pode também transportar ringback ou URA.

O frontend da build examinada usa `session.sessionDescriptionHandler.peerConnection`, `pc.getReceivers()` e `pc.getSenders()`. Quando a sessão está estabelecida, ele conecta `receiver.track` a `MediaStream` e a um elemento `<audio>`, e usa `AudioContext → MediaStreamAudioSourceNode → GainNode → MediaStreamAudioDestinationNode → sender.replaceTrack()` para volume do microfone. Isso foi identificado no [chunk do webphone](https://amorsaude.cvortex.com/crm/static/js/17.998419a4.chunk.js) e detalhado em [pesquisa de frontend](research-cvortex-frontend.md). Assim, nosso experimento utiliza uma operação que o próprio frontend já usa, sem assumir que ela seja uma API pública.

## Elemento de áudio e Web Audio

**TESTADA:** durante chamada ativa havia um `<audio>` com `srcObject` do tipo `MediaStream` contendo uma track `audio`; `muted=false`, `volume=1`, `paused=false`. O browser renderizava o áudio remoto nesse elemento. O script de laboratório criou um segundo pipeline Web Audio para a track recebida sem alterar essa reprodução. Uma fonte `OscillatorNode → GainNode → MediaStreamAudioDestinationNode` substituiu o sender por 3,5 s; o telefone ouviu o tom. Na PoC WS, o browser usou `ScriptProcessorNode` apenas como encoder PCM temporário, e buffers de retorno alimentaram outro `MediaStreamAudioDestinationNode`. O `ScriptProcessorNode` é adequado apenas ao laboratório; para uma implementação durável, avaliar `AudioWorklet` e controle explícito de buffers/latência.

`getUserMedia` foi chamado com áudio e sem vídeo. A track retornada alimentava o sender ativo por identidade de objeto. `getDisplayMedia` e `AudioWorklet` não foram identificados nos chunks examinados; isso não prova ausência em futuras builds.

## Codec, SDP, ICE e métricas

**OBSERVADA:** `INVITE`/`200` SIP tinham `m=audio`, `sendrecv`, atributos ICE, candidatos e fingerprint DTLS; a oferta/resposta listaram PCMU/8000, PCMA/8000, Opus/48000 e telephone-event/8000. Nenhum valor de SDP/ICE foi preservado. A PC de chamada recebeu oferta, enviou resposta, usou um servidor com esquema `turn:` e candidatos `host`/`relay`.

**TESTADA por `getStats()`:** o codec efetivo era `audio/PCMU`, 8 kHz, 1 canal, nos relatórios `inbound-rtp` e `outbound-rtp`. Em uma amostra, entrada: 300 pacotes/48.000 bytes, jitter 0, perda 0; saída: 310 pacotes/49.600 bytes. Em outra chamada os contadores também cresceram nos dois sentidos. RTT não foi registrado nessa coleta; não há medição de latência ponta a ponta de IA. Esses números são da **perna WebRTC do navegador**, não do trunk/PSTN.

## SIP e WebSockets

| Conexão | Protocolo/função observada | Mídia? |
| --- | --- | --- |
| `wss://sip004.cvortex.com:8099/ws` | SIP textual: `REGISTER`, `OPTIONS`, `INVITE` com SDP, respostas `100/180/200`, `ACK`, `BYE` | Sinalização; RTP via WebRTC separado |
| `wss://amorsaude.cvortex.com/api/crm/subscriptions` | GraphQL WS: `connection_init`, `start`, `data`, `ka`, `stop`; eventos de voz | Eventos/sinalização, não áudio observado |
| `wss://amorsaude.cvortex.com/api/crm/ping-pong` | Keepalive/conexão | Não identificado como mídia |
| `wss://ws2.productfruits.com/v1` | Serviço de ajuda/telemetria da página | Sem papel de telefonia identificado |
| `ws://127.0.0.1:8765` | **Nosso** WS temporário: PCM16 binário da track remota e PCM16 de tom de volta | Sim, somente PoC local |

**OBSERVADA na chamada:** `DirectAgentContact` via GraphQL precedeu `INVITE` **recebido** pelo webphone; o browser respondeu `100`, `180`, `200` com SDP e recebeu `ACK`. O desligamento via `HangupCall` precedeu `BYE` recebido e `200` enviado. O `180` confirma a perna SIP do navegador, não o toque no telefone remoto por si só; o toque no telefone foi confirmado pelo operador em teste separado. Não se observaram `REFER`, `Replaces`, `Join`, `183`, `NOTIFY` ou `CANCEL` nesta chamada. Transferência, conferência e falha exigem cenários próprios. Ver [pesquisa SIP](research-cvortex-sip.md).

Não foram observados frames binários de mídia nos WS do fornecedor durante a captura; a mídia fluiu por WebRTC/RTP. Isso não exclui outros fluxos em outros modos ou builds.

## Biblioteca, frontend, workers e contexto

**OBSERVADA no bundle:** o UserAgent da chamada usa **SIP.js 0.21.1** (módulo 1839 do [chunk 8](https://amorsaude.cvortex.com/crm/static/js/8.84aaa039.chunk.js)); outra cópia SIP.js 0.16.1 está em chunk 2, sem prova de uso na chamada testada. A aplicação substitui o User-Agent por `cVortex WebPhone V1.5.3`. O [chunk 17](https://amorsaude.cvortex.com/crm/static/js/17.998419a4.chunk.js) contém o componente de voz e GraphQL. Os arquivos `.js.map` consultados retornaram HTML fallback da SPA, não source maps válidos. Arquivos minificados/hash podem mudar a cada build.

**OBSERVADA:** webphone e `<audio>` estão na SPA React principal; nenhum iframe ou shadow DOM foi necessário para acessar as tracks no teste. O `ping-pong-worker` participa de status/keepalive, sem mídia RTP identificada. O bundle chama `serviceWorker.unregister()`. Não foi identificada participação de `SharedWorker` ou `AudioWorklet` nos chunks examinados. As globais `window.currentCallSession` e `window.currentCallAudioElement` aparecem condicionalmente quando a prop `monitor` está ativa; não foram usadas como dependência da PoC. A instrumentação interceptou o construtor `RTCPeerConnection` antes da criação da sessão.

## GraphQL de voz: interface privada do webphone

Todas usam `POST https://amorsaude.cvortex.com/api/crm/graphql` ou o WS `/api/crm/subscriptions` na sessão do navegador. Nomes/formatos abaixo são **OBSERVADOS**, não contrato público para servidores. Nenhum valor de variável foi guardado.

| Tipo | Operação | Input/output de interesse | Exercitada? |
| --- | --- | --- | --- |
| Mutation | `DirectAgentContact` | `exten`, `destinyNumber`, `digitalId`, `serverDigital`, `context`; resposta `data.directAgentContact` booleana | Sim, chamada ao número de teste |
| Mutation | `HangupCall` | `cause`, `codeCause`, `thirdPartyId`, `callId`, `digitalId`, `serverDigital`, `externalId`; resposta booleana | Sim |
| Mutation | `VoiceLogin`, `SetWebPhoneStatus` | configuração/estado do agente; campos de senha foram vistos **somente pelo nome** | Inicialização, sem valores preservados |
| Mutation | `MakeCall`, `RefuseCall`, `IgnoreCall`, `DirectTransfer`, `AssistedTransfer`, `ConfirmTransfer`, `InitiatedConference`, `MakeNewCallForConference`, `CancelNewCallForConference`, `SetDndRequest`, `SetUnDndRequest` | Documentos estáticos presentes no bundle; campos da maioria não exercitados | Não |
| Subscription | `Dialing` | `callId`, destino/ramal, `digitalId`, `externalId`, timestamps | Sim |
| Subscription | `AnswerCall` | `callId`, `callWay`, `queueId`, `uui`, `digitalId`, `externalId`, timestamps | Sim |
| Subscription | `Hangup` | `callId`, `cause`, `codeCause`, `digitalId`, `externalId`, timestamps | Sim |
| Subscription | `TransferActivated`, `BlindTransfer`, `AttendedTransfer`, `DeliveredAttendedTransfer`, `ConferenceActivated`, `ConferenceJoin`, `ConferenceLeave`, `VoiceLoginConfirmation`, `RequestSipRegister`, `UserVoiceConfiguration` | Definidas/assinadas; transferência/conferência não executadas | Parcial |

O `DirectAgentContact` retornou HTTP 200 com booleano, sem `Call Id` imediato. O `callId` surgiu nas assinaturas. A [release de outubro de 2024](https://docs.cvortex.io/help/2024-outubro) identifica “Ligar para um Colaborador” como modalidade que funciona sem caso e tem gravação desabilitada por padrão. O [manual do Webphone](https://docs.cvortex.io/help/webphone-1) mostra uma discagem de cliente/caso distinta. Logo, **não atribuir** os resultados da PoC ao fluxo de paciente/caso ou à API oficial de originação. O mapa de endpoints oficiais está em [cvortex-integration-map.md](cvortex-integration-map.md).

## Transferência, conferência e monitoria

**OFICIAL:** o manual do webphone documenta mute, espera, transferência direta/consultiva e conferência. A interface do tenant expôs controles, mas essas ações não foram executadas. Mutations/assinaturas privadas existem, porém não indicam se a perna do navegador usa `REFER`, `Replaces` ou uma orquestração do backend. [Manual Webphone](https://docs.cvortex.io/help/webphone-1).

**OFICIAL:** supervisor com permissão `Monitor Calls` pode usar **Espiar** e falar privadamente ao agente na interface. Não testado aqui, pois não houve chamada de terceiro autorizada para monitoria; não foi identificado endpoint público de stream de supervisor. [Acompanhamento em tempo real](https://docs.cvortex.io/help/acompanhando-em-tempo-real-os-atendimento-de-voz-d).

## Interface suportada e caminhos de integração

**OFICIAL:** cVortex publica `/v1/auth/`, endpoints de casos/workflow e gravações após chamada; não foi localizado contrato público de áudio bidirecional, originação ou hangup. O [guia de estações](https://docs.cvortex.io/help/requisitos-para-estacoes-de-trabalho) menciona SIP trunk condicional com IP público fixo. **HIPÓTESE:** trunk ou media stream podem ser provisionados para o tenant via fornecedor; a presença do WS SIP do webphone não dá esse direito nem documentação operacional. [Pesquisa da API](research-cvortex-api.md), [pesquisa de áudio](research-cvortex-audio.md).

**TESTADA em laboratório:** ponte na página instrumentada. Um sistema em outra origem não acessa `RTCPeerConnection` da aba cVortex diretamente. Extensão Chrome com script em mundo `MAIN` ou userscript controlado poderiam empacotar a PoC, mas não foram implementados. Dependem da build, sessão, navegador e ciclo de vida do webphone; não são uma interface garantida de produção. [Pesquisa de arquitetura](research-cvortex-architecture.md).

## Cinco respostas finais

| Pergunta | Resposta | Evidência e limite |
| --- | --- | --- |
| 1. Acessar em tempo real a faixa que cVortex entrega ao navegador? | **SIM** | `receiver.track` vivo, `MediaStream`/Web Audio criado; a identificação de conteúdo específico como fala da pessoa é indireta, sem captura de conteúdo. |
| 2. Criar cópia para nosso sistema sem interromper a chamada? | **SIM** no teste local | 81 blocos enviados via WS local enquanto `<audio>` original continuou ativo e PC conectada. Sem gravação. |
| 3. Substituir temporariamente o microfone por track própria? | **SIM** | `sender.replaceTrack` com track sintética e depois com mic original; a captura não exclui renegociação transitória. |
| 4. Telefone remoto recebeu esse áudio? | **SIM** | Operador confirmou tom local e tom de retorno do servidor local no telefone de teste. |
| 5. cVortex ↔ bridge ↔ ElevenLabs é tecnicamente viável? | **PARCIAL** | Ponte local bidirecional comprovada; conexão ElevenLabs, latência/barge-in e suporte/estabilidade da cVortex ainda não testados. |

## Matriz funcional

| Função | Encontrada? | Mecanismo | Testada? | Utilizável? |
| --- | --- | --- | --- | --- |
| Iniciar chamada | Sim | UI → `DirectAgentContact` privado | Sim, colaborador/número externo | Só na UI; API oficial pendente |
| Encerrar | Sim | UI → `HangupCall` privado → SIP BYE | Sim | Só na UI; API oficial pendente |
| Estado | Parcial | GraphQL subscriptions `dialing`/`answerCall`/`hangup` | Sim, subconjunto | Privado; sem contrato servidor |
| Áudio recebido | Sim | `RTCRtpReceiver.track` → `<audio>` e WS local | Sim | PoC no navegador |
| Áudio enviado | Sim | `getUserMedia` → sender; PoC sintética → sender | Sim | PoC no navegador |
| `replaceTrack` | Sim | `RTCRtpSender.replaceTrack` | Sim, dois testes auditivos | PoC no navegador |
| Monitorar | Sim na UI | `Espiar`, permissão `Monitor Calls` | Não | API externa não comprovada |
| Transferir | Sim na UI | mutations/assinaturas privadas; URA documentada | Não | API externa não comprovada |
| Conferência | Sim na UI | mutations/assinaturas privadas | Não | API externa não comprovada |
| SIP trunk | Condicional na documentação | Infraestrutura/roteamento do fornecedor | Não no tenant | Depende de cVortex/provedor |
| Media stream oficial | Não localizado | — | Não | Depende de cVortex/provedor |

## Limitações e próximo passo

Não testamos paciente real, caso de atendimento, transferência, conferência, monitoria, falha/busy/no-answer, manutenção de `replaceTrack` após hold/reconexão nem RTT de IA. A conexão ElevenLabs foi tentada, mas a chave inicial recebeu HTTP 401 antes da abertura do WebSocket e do envio de áudio. Uma chave corrigida autenticou em `/v1/user` (HTTP 200), porém listou zero agentes e a URL assinada da Giovana de outra conta retornou 404 `document_not_found`. A prova local não garante que a cVortex suporte scripts de terceiros na página ou permita uso em produção. O próximo passo técnico é testar o novo agente com URL assinada gerada no backend; em paralelo, solicitar à cVortex contrato de SIP trunk/media stream e API oficial de chamada. n8n fica fora do caminho de áudio.

**Atualização:** o operador criou posteriormente um novo agente **Giovana Teste** na conta da chave local. A URL assinada desse novo agente foi obtida (HTTP 200), com `pcm_16000` de entrada/saída e idioma `pt` configurado. Não houve nova chamada nem sessão de conversa; a resposta 5 permanece **PARCIAL** até a ponte cVortex ↔ ElevenLabs ↔ telefone funcionar em uma ligação controlada. Ver [registro da PoC](cvortex-audio-bridge-poc.md).

**Teste posterior em chamada:** o novo agente conectou via WebSocket. Foram enviados 331 frames/677.888 bytes da track recebida pelo webphone e retornaram 19 frames/501.760 bytes de áudio da Giovana até a track substituta do sender. A PC permaneceu conectada, o microfone foi restaurado e a ligação encerrada. Houve 2 eventos de transcrição do usuário, sem persistência do conteúdo. Não houve confirmação auditiva do operador sobre ouvir a Giovana no telefone. A resposta 5 avança para **SIM para o fluxo técnico até a track enviada; PARCIAL para voz percebida, latência e uso estável**, conforme [PoC](cvortex-audio-bridge-poc.md).

**Aceite pelo painel local:** em outra chamada ao número autorizado, o operador confirmou que ouviu a Giovana e ela respondeu. O painel registrou `ai_connected`, ID da conversa e estado `completed` após desligar. Assim, a resposta 5 é **SIM para a viabilidade técnica e a percepção auditiva no piloto local**; continuam pendentes interface oficialmente suportada pela cVortex, estabilidade em outros cenários, qualidade e latência medidas. [Detalhes do aceite](cvortex-audio-bridge-poc.md).
