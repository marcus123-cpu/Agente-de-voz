# Análise WebRTC do webphone cVortex

Data: 06/11/2026. Escopo deste relatório: análise das evidências já obtidas e desenho do experimento seguro. **Não houve novo acesso à sessão autenticada nem chamada por este subagente.** Os rótulos abaixo indicam o grau da evidência.

## Evidência existente

| Achado | Estado | Base |
| --- | --- | --- |
| Página cria `RTCPeerConnection` e solicita `getUserMedia` com áudio | OBSERVADA | Instrumentação anterior registrada no [mapa principal](cvortex-integration-map.md) |
| Na chamada, uma conexão passou a `connected`, recebeu `offer`, enviou `answer` e teve um sender e um receiver de áudio | OBSERVADA | Instrumentação anterior |
| Um candidato `relay` e servidor `turn:` apareceram; SDP tinha `m=audio` e `sendrecv` | OBSERVADA | Instrumentação anterior, somente metadados |
| `getStats()` mostrou RTP de entrada e saída com bytes/pacotes não nulos e `audio/PCMU` 8 kHz nos dois sentidos | TESTADA | Chamada curta anterior |
| O receiver contém fala de paciente atendido, e o sender corresponde ao microfone ouvido no telefone | AINDA NÃO TESTADO | A chamada curta pode conter ringback/URA; faltou confirmação de fala e teste de troca |
| `sender.replaceTrack()` substitui áudio do microfone sem renegociação nesta implementação | AINDA NÃO TESTADO | Capacidade da API WebRTC, dependente de ensaio no tenant |

`RTCRtpSender` codifica e transmite uma track, enquanto `RTCRtpReceiver` disponibiliza a track de entrada. `getTransceivers()` correlaciona sender e receiver pelo mesmo `mid` e `currentDirection`. [Introdução ao RTP](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Intro_to_RTP), [especificação WebRTC](https://www.w3.org/TR/webrtc/).

## Seleção da conexão de mídia

Criar um registro local em memória para cada `RTCPeerConnection` no construtor, antes de recarregar a página. Para cada uma, coletar somente:

- índice local, horário relativo, `connectionState`, `iceConnectionState`, `signalingState`;
- número de senders, receivers e transceivers; `kind`, `enabled`, `readyState` e `muted` das tracks; `direction`, `currentDirection` e `mid`;
- de `getStats()`, apenas `inbound-rtp`/`outbound-rtp` de áudio, bytes/pacotes, jitter, perda, RTT e `codec.mimeType`/`clockRate`/`channels`;
- tipo de candidato (`host`, `srflx`, `relay`) e esquema do servidor ICE (`stun`, `turn`, `turns`), sem URL, IP ou credencial.

Selecionar a conexão **ativa** por `connectionState === 'connected'` e crescimento de bytes de áudio em duas medições separadas, não pela posição no array. As conexões criadas na inicialização sem tráfego podem ser descartadas. `getStats()` retorna relatórios tipados; não despejar o objeto inteiro, que pode incluir IPs, SSRCs e IDs. [getStats](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats), [inbound RTP stats](https://developer.mozilla.org/en-US/docs/Web/API/RTCInboundRtpStreamStats).

## Prova de acesso ao áudio remoto

Na chamada **atendida** pelo número de teste, localizar `pc.getReceivers().find(r => r.track?.kind === 'audio')`. Inspecionar o estado da track e criar `new MediaStream([receiver.track])` **em memória**, sem elemento de gravação, `MediaRecorder`, arquivo ou transmissão. Para demonstrar uma cópia que não altera a saída do webphone, usar `const clone = receiver.track.clone(); const stream = new MediaStream([clone])`, comprovar que tem uma faixa de áudio viva e chamar `clone.stop()` após a inspeção. A API `MediaStream.clone()` cria tracks clonadas. [MediaStream.clone](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream/clone).

Esse teste comprova capacidade de leitura da track no contexto da página. Para afirmar que é **voz do paciente**, pedir à pessoa no telefone que atenda e diga uma frase curta; correlacionar com crescimento de `inbound-rtp` e, se necessário, medição de energia em memória sem armazenar amostras. Não inferir voz do paciente de bytes RTP durante toque.

## Prova de saída e troca da track

Selecionar o sender de áudio da conexão ativa por `pc.getSenders()` e comparar a track com a faixa retornada por `getUserMedia` capturada na instrumentação. A identidade por referência de objeto é mais segura que ID textual. Registrar apenas `enabled`, `readyState` e `kind`. Se houver mais de um sender de áudio, usar crescimento de `outbound-rtp` e o `mid` do transceiver para desambiguar.

**Teste reversível de silêncio:** preservar `const previous = track.enabled`; definir `track.enabled = false` por cerca de 1 s; restaurar `previous` em `finally`. O telefone remoto deve confirmar a perda temporária de som, não apenas o estado local. Se a aplicação sobrescrever `enabled`, registrar o fato e não insistir.

**Teste principal:** gerar tom baixo e curto com `AudioContext → OscillatorNode → GainNode → MediaStreamAudioDestinationNode`, obter `destination.stream.getAudioTracks()[0]`, chamar `await sender.replaceTrack(testTrack)` e restaurar `await sender.replaceTrack(originalTrack)` em `finally`. Não usar arquivo, ElevenLabs ou dados do paciente. `replaceTrack` tenta mudar a fonte sem renegociar; pode falhar se a track exigir condições fora da negociação, inclusive contagem diferente de canais. [RTCRtpSender.replaceTrack](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack), [especificação WebRTC](https://www.w3.org/TR/webrtc/), [MediaStreamAudioDestinationNode](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioDestinationNode/MediaStreamAudioDestinationNode).

Pseudocódigo mínimo para executar **somente após identificar e guardar sender/track na página**:

```js
const original = sender.track;
const audio = new AudioContext();
const dest = audio.createMediaStreamDestination();
dest.channelCount = 1;
const osc = audio.createOscillator();
const gain = audio.createGain();
osc.frequency.value = 440;
gain.gain.value = 0.02;
osc.connect(gain).connect(dest);
const testTrack = dest.stream.getAudioTracks()[0];

try {
  await audio.resume();
  if (audio.state !== 'running') throw new Error('AudioContext suspenso');
  osc.start();
  await sender.replaceTrack(testTrack);
  // Pedir confirmação ao telefone remoto durante uma janela curta.
  // Medir RTP e estados; nunca copiar amostras.
} finally {
  await sender.replaceTrack(original);
  osc.stop();
  testTrack.stop();
  await audio.close();
}
```

O `finally` também precisa cobrir timeout, desconexão e erro de `replaceTrack`; o operador deve manter o botão de desligar disponível. Confirmar depois se `sender.track === original`, `pc.connectionState` e codec/bytes em `outbound-rtp`. Uma resolução bem-sucedida de `replaceTrack()` **não** prova, sozinha, que o telefone remoto ouviu o tom.

## Instrumentação segura sugerida

Na página de teste, `page.addInitScript()` antes de `reload()` pode substituir `window.RTCPeerConnection` por `Proxy` que delega ao construtor original e mantém cada instância em `window.__cvProbe.pcs`. Envolver `getUserMedia` para relacionar as tracks retornadas aos senders por referência. Guardar o registry apenas em memória da aba; devolver ao processo Playwright somente resumo filtrado. Não registrar `constraints.deviceId`, SDP, ICE completo, `getConfiguration().iceServers`, headers SIP, nomes de dispositivos ou áudio.

Para inspecionar `addTrack`, `replaceTrack`, `setLocalDescription` e `setRemoteDescription`, envolver métodos na instância e registrar somente o nome, `track.kind`, tipo de descrição (`offer`/`answer`) e tempo relativo. Não alterar o retorno nem lançar erro extra. A instrumentação pode ser detectada pelo aplicativo ou mudar timing; qualquer comportamento anômalo torna o teste inconclusivo. Fechar a página/processo remove os wrappers.

## Critérios de resultado

| Pergunta | Evidência necessária |
| --- | --- |
| Track de entrada acessível? | `receiver.track.kind === 'audio'`, `readyState === 'live'`, `MediaStream`/clone criado no contexto da página |
| Track enviada identificada? | Sender da conexão ativa associado à track de `getUserMedia`, `outbound-rtp` crescente |
| `replaceTrack` funcional? | Promise resolve, sender passa a apontar para track sintética, conexão/codec persistem, sem novo offer/answer |
| Telefone ouviu? | Confirmação explícita da pessoa atendendo + janela de tom alinhada com `outbound-rtp`; sem isso, apenas capacidade local |
| Restauro seguro? | Sender volta à track original, estado `connected` e voz do operador retorna; recursos sintéticos encerrados |

Se esses itens passarem, há **prova técnica no navegador** de uma ponte de áudio. Ainda não haverá garantia de integração suportada: injeção no frontend depende do layout/código cVortex, da sessão do operador, de permissões do navegador e da estabilidade do fornecedor. O trunk SIP ou media stream oficial continuam sendo opções superiores para produção quando disponíveis.
