# Mapeamento estático do frontend do webphone cVortex

Investigação em 06/11/2026 de arquivos JavaScript servidos publicamente pela aplicação em `https://amorsaude.cvortex.com/crm/static/js/`. Esta análise **não** usou a sessão autenticada, não executou chamadas e não leu valores de credenciais. Arquivos minificados podem mudar a qualquer publicação; nomes de chunks e offsets são evidência da build examinada, não contrato de integração.

## Artefatos analisados

| Arquivo público | Tamanho | Conteúdo relevante |
| --- | ---: | --- |
| [`17.998419a4.chunk.js`](https://amorsaude.cvortex.com/crm/static/js/17.998419a4.chunk.js) | 1.840.236 B | Componente do webphone, operações GraphQL, criação de UserAgent, áudio, tracks |
| [`8.84aaa039.chunk.js`](https://amorsaude.cvortex.com/crm/static/js/8.84aaa039.chunk.js) | 775.479 B | Biblioteca SIP.js usada pelo UserAgent do webphone |
| [`2.00130cdd.chunk.js`](https://amorsaude.cvortex.com/crm/static/js/2.00130cdd.chunk.js) | 246.781 B | Outra cópia SIP.js em bundle carregado, aparentemente de caminho legado |
| [`main.5da7bf99.chunk.js`](https://amorsaude.cvortex.com/crm/static/js/main.5da7bf99.chunk.js) | 3.607.590 B | UI compartilhada, áudio de teste/configuração, desregistro de service worker |
| [`16.58b48672.chunk.js`](https://amorsaude.cvortex.com/crm/static/js/16.58b48672.chunk.js) | 4.570.483 B | Bibliotecas compartilhadas, incluindo WaveSurfer; não equivale ao pipeline da chamada |

Também foram inspecionados os chunks `13.368cc7f1`, `7.ecec3049` e o `ping-pong-worker.55f08ff1.worker.js`. URLs `.js.map` retornaram HTTP 200 com o HTML da SPA (fallback), **não** JSON de source map. Os JS examinados não incluem `sourceMappingURL`.

## Biblioteca SIP/WebRTC

**OBSERVADA no bundle:** o webphone cria um UserAgent de **SIP.js 0.21.1**. A função de construção em `17.998419a4.chunk.js` usa o módulo Webpack `1839`, que está em `8.84aaa039.chunk.js`; esse módulo contém `userAgentString:"SIP.js/0.21.1"`. A aplicação substitui o cabeçalho por `userAgentString:"cVortex WebPhone V1.5.3"`. A configuração inclui `transportOptions.server` com `wss://<host>:<port>/ws`, `contactParams.transport:"wss"` e `sessionDescriptionHandlerFactoryOptions` com constraints de áudio, vídeo desligado e ICE servers configuráveis. Nomes de campos SIP de autenticação aparecem no código, mas nenhum valor foi lido ou registrado.

Uma segunda cópia da biblioteca em `2.00130cdd.chunk.js` contém `SIP.js/0.16.1`. A referência do UserAgent do webphone testado aponta para a versão **0.21.1**. Não atribuir a cópia 0.16.1 à chamada ativa sem análise adicional de outros fluxos da SPA.

## Fluxo de áudio no componente

**OBSERVADO estaticamente em `17.998419a4.chunk.js`, próximo aos offsets 367.849–369.700:** quando a sessão SIP está `Established`, o componente acessa `session.sessionDescriptionHandler.peerConnection`.

```text
pc.getReceivers() → receiver.track(kind=audio)
  → new MediaStream + addTrack
  → <audio>.srcObject = stream
  → <audio>.play() → saída do navegador

pc.getSenders() → sender.track(kind=audio)
  → applyConstraints({autoGainControl:false})
  → stream local guardado no estado do componente
  → AudioContext/MediaStreamSource/Gain/MediaStreamDestination
  → sender.replaceTrack(track do destination)
  → WebRTC/SIP remoto
```

O componente renderiza um elemento `<audio>` via React e escolhe o dispositivo de saída com `setSinkId` quando disponível. `audioElement.volume` controla volume de reprodução local. O efeito de `micVolume` cria um `AudioContext`, conecta a track de microfone a `MediaStreamAudioSourceNode`, depois `GainNode` e `MediaStreamAudioDestinationNode`, e passa a track resultante a `sender.replaceTrack(...)`. **Isso é evidência direta de que o próprio frontend substitui a track enviada sem código de renegociação SIP explícito nesse trecho.** Não prova que uma track criada por nosso código funcione ou permaneça estável quando o React rerenderiza.

O componente também altera `.enabled` em tracks durante mute/hold/conferência. Um POC que troque o sender precisa guardar a referência original, verificar `sender.track` antes de restaurar e considerar que mudanças de volume/mute pela UI podem sobrescrever a track injetada.

`getReceivers()` e `getSenders()` são usados ainda por rotinas internas de diagnóstico de qualidade de conexão, que consultam `getStats()` e metadados de track. Isso pode ajudar a comparar métricas antes e depois de um POC sem registrar áudio.

### Globais condicionais

Na sessão estabelecida, o componente pode atribuir `window.currentCallSession` e `window.currentCallAudioElement`, **somente se** a prop `monitor` estiver ativa. A limpeza do efeito remove essas propriedades ao desmontar a chamada. Portanto, sua presença não é garantida; instrumentação por wrapper de `RTCPeerConnection` continua necessária como caminho geral. O bundle compartilhado (`main`) consulta `window.currentCallSession.sessionDescriptionHandler.peerConnection` para detectar receiver de áudio.

## Web Audio e teste de som

- A build contém `AudioContext`, `createMediaStreamSource`, `createMediaStreamDestination`, `createGain` e `createAnalyser` no componente de voz. O uso central para volume do microfone está descrito acima.
- `main.5da7bf99.chunk.js` contém um teste de saída que cria oscilador de **440 Hz**, GainNode e MediaStreamDestination, conecta a um elemento `Audio` e reproduz no dispositivo local. Isso prova que a UI já usa fonte sintética local para teste de áudio, mas **não** que essa fonte seja enviada ao telefone.
- Há código WaveSurfer em chunk compartilhado `16`; seu uso não foi atribuído ao caminho RTP da chamada.
- Não foram localizadas strings `AudioWorklet` ou `getDisplayMedia` nos chunks examinados. Não há prova de ausência em chunks não carregados.

## GraphQL e WebSockets (estático)

`17.998419a4.chunk.js` embute documentos GraphQL de voz. Abaixo, apenas nomes e função aparente, sem variáveis ou IDs reais:

| Tipo | Operações encontradas | Situação |
| --- | --- | --- |
| Query | `SipUserConfiguration`, `AvailableAgentsToDirectAgentContact`, `AvailableAgentsToTransferAsset` | Definidas na build; os dois primeiros também foram observados pelo agente principal em sessão |
| Mutation | `VoiceLogin`, `VoiceLogout`, `MakeCall`, `DirectAgentContact`, `HangupCall`, `RefuseCall`, `IgnoreCall`, `DirectTransfer`, `AssistedTransfer`, `ConfirmTransfer`, `InitiatedConference`, `MakeNewCallForConference`, `CancelNewCallForConference`, `SetWebPhoneStatus`, `SetDndRequest`, `SetUnDndRequest` | Definidas; execução de chamada/desligamento foi verificada separadamente em teste do tenant |
| Subscription | `Dialing`, `AnswerCall`, `Hangup`, `TransferActivated`, `BlindTransfer`, `AttendedTransfer`, `DeliveredAttendedTransfer`, `ConferenceActivated`, `ConferenceJoin`, `ConferenceLeave`, `VoiceLoginConfirmation`, `VoiceLogoutConfirmation`, `UserVoiceConfiguration`, `RequestSipRegister` | Definidas; subconjunto foi observado durante chamada pelo agente principal |

Essas operações usam `/api/crm/graphql` e `/api/crm/subscriptions` no ambiente autenticado. Elas pertencem à interface privada do produto, sem garantia de versão, escopo de servidor ou permissão de integração.

## Workers, service worker e estrutura da página

- `17.998419a4.chunk.js` instancia `ping-pong-worker.55f08ff1.worker.js`; o contexto próximo mostra transporte e polling de status/conexão. Não foi encontrada evidência de mídia RTP nesse worker.
- `main.5da7bf99.chunk.js` chama `navigator.serviceWorker.ready.then(registration => registration.unregister())`; não há evidência de service worker fazendo ponte de áudio nesta build.
- O componente do webphone é renderizado no React da SPA e cria `<audio>` no DOM da página. A análise estática sugere contexto principal, sem iframe necessário para o webphone; confirmar por inspeção runtime se houver futuras mudanças.
- Não foi identificada referência estática explícita a `SharedWorker` ou `AudioWorklet` nos chunks inspecionados.

## Implicação para a ponte experimental

O bundle mostra pontos funcionais para **ler uma track remota** (`receiver.track`) e **trocar a track enviada** (`sender.replaceTrack`). Um script no mesmo contexto JavaScript da página pode, em princípio, acessar esses objetos ao capturar a `RTCPeerConnection` ou, condicionalmente, por `window.currentCallSession`. Um content script isolado de extensão não compartilha automaticamente objetos JS da página; seria preciso uma ponte para o contexto principal. Isso é **HIPÓTESE de arquitetura**; somente o teste controlado em chamada autorizada pode provar que o áudio gerado chega ao telefone e que a track remota pode ser encaminhada ao nosso backend. Nenhuma dessas rotas privadas deve ser tratada como integração suportada de produção sem acordo com a cVortex.
