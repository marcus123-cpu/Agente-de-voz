# Prova de conceito da ponte de áudio cVortex

Data: 06/11/2026. Execução em tenant autorizado AmorSaúde, somente no número de teste fornecido pelo operador. **TESTADA** marca resultado observado em chamada; **HIPÓTESE** marca etapa sem prova. Nenhum áudio, transcrição, SDP, token, cookie ou credencial SIP/TURN foi gravado. Os contadores abaixo são métricas, não conteúdo.

## Hipótese

Uma `RTCPeerConnection` ativa do webphone entrega áudio remoto em `receiver.track` e envia a track de `sender`. No contexto da página, `receiver.track` pode alimentar Web Audio e um WebSocket local; uma track gerada pelo nosso sistema pode substituir temporariamente a do microfone com `sender.replaceTrack()`.

```text
Telefone ↔ cVortex ↔ WebRTC do navegador
                         ├─ receiver.track → WS local → nosso servidor
                         └─ sender.track   ← WS local ← nosso servidor
```

Essa PoC verifica o mecanismo de mídia, não uma API oficial nem a adequação para produção. O caminho usado para ligar foi **Ligar para um Colaborador**, que a [cVortex documenta como modalidade independente de caso](https://docs.cvortex.io/help/2024-outubro). Não foram testadas chamadas de paciente, caso, gravação, transferência ou monitoria.

## Teste 1 — track local sintética

1. Instrumentação temporária via Playwright `addInitScript` registrou PCs e streams de `getUserMedia` apenas em memória da aba.
2. Após ligação atendida, a PC ativa estava `connected`; 1 sender de áudio vinha da track `getUserMedia`; 1 receiver de áudio estava `live`; o transceiver `mid=0` era `sendrecv`.
3. O receiver alimentou `new MediaStream([receiver.track])` e `MediaStreamAudioSourceNode` em memória. Havia também `<audio>.srcObject` com `MediaStream` de áudio, `muted=false`, `paused=false`.
4. `AudioContext → OscillatorNode(440 Hz) → GainNode(0,08) → MediaStreamAudioDestinationNode` criou uma track local. `await sender.replaceTrack(testTrack)` resolveu; o sender apontou à track nova e a PC permaneceu `connected`.
5. Depois de ~3,5 s, `await sender.replaceTrack(originalMicTrack)` restaurou o microfone. A chamada foi encerrada pela UI.

**Resultado TESTADO:** o operador confirmou que ouviu claramente o tom no telefone. `getStats()` mostrou PCMU/8 kHz mono e pacotes RTP nos dois sentidos. A comparação de `signalingState` antes/depois ficou `stable`, mas **não exclui uma renegociação transitória**; o teste não capturou todos os eventos de oferta/resposta durante a troca. `originalMic.enabled` era `true` antes do teste e voltou a `true`; para uso geral, preservar o estado anterior em vez de forçar `true`.

Trecho mínimo do mecanismo exercitado:

```js
const pc = peerConnections.find(pc => pc.connectionState === 'connected');
const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
const receiver = pc.getReceivers().find(r => r.track?.kind === 'audio');
const original = sender.track;
const context = new AudioContext();
const destination = context.createMediaStreamDestination();
const oscillator = context.createOscillator();
const gain = context.createGain();
oscillator.frequency.value = 440;
gain.gain.value = 0.08;
oscillator.connect(gain).connect(destination);
try {
  await context.resume();
  oscillator.start();
  await sender.replaceTrack(destination.stream.getAudioTracks()[0]);
  // Janela curta de teste; confirmação auditiva pelo telefone remoto.
} finally {
  await sender.replaceTrack(original);
  oscillator.stop();
  await context.close();
}
```

## Teste 2 — WebSocket local bidirecional

O servidor temporário `tools/local-audio-bridge-server.mjs` escutou apenas em `127.0.0.1:8765` e aceitou origem `https://amorsaude.cvortex.com`. O browser conectou `receiver.track → MediaStreamAudioSourceNode → ScriptProcessorNode`, converteu amostras efêmeras para PCM16/16 kHz e enviou frames binários pelo WS. O servidor **contou e descartou** o áudio recebido; após 10 frames, gerou um tom de 523 Hz em PCM16/16 kHz e retornou 150 frames. O browser enfileirou esses frames em `AudioBufferSourceNode → MediaStreamAudioDestinationNode` e trocou o sender para a track de saída. Ao fim, restaurou o microfone e encerrou a chamada.

| Medida | Resultado |
| --- | ---: |
| Frames enviados do receiver ao servidor local | 81 |
| Bytes enviados do receiver ao servidor local | 165.888 |
| Frames de tom recebidos do servidor | 150 |
| Bytes de tom recebidos | 96.000 |
| Estado da PC no fim da substituição | `connected` |
| Sender restaurado e chamada encerrada | Sim |

**Resultado TESTADO:** o operador falou durante a chamada e confirmou que ouviu o tom devolvido pelo servidor local. Isso demonstra que amostras da faixa remota atravessaram o WS local sem interromper a chamada e que áudio gerado fora do navegador retornou ao telefone. Os contadores não provam, isoladamente, a inteligibilidade ou causalidade da frase falada; não houve gravação, transcrição ou medição de energia/VAD. `tone-finished` marcou o fim do envio pelo servidor, não necessariamente o último sample reproduzido no telefone. Latência e backpressure não foram medidos.

O `ScriptProcessorNode` e o WS com apenas validação de Origin/loopback são de laboratório. Origin não substitui autenticação. Para piloto, usar URL/sessão curta, associação explícita à chamada, controle de acesso, rate limit, WS seguro conforme topologia, `AudioWorklet` e fila com limites de atraso. Ao falhar WS/IA, restaurar a track de microfone e manter o botão de desligar acessível.

## Teste 3 — ElevenLabs

**TENTADO, NÃO VALIDADO.** O agente existente **Giovana — Captação de Pacientes** foi localizado na conexão ElevenLabs; sua configuração declara entrada e saída `pcm_16000`. O código de laboratório `tools/elevenlabs-bridge-server.mjs` deixa a API key somente no servidor e pede a [URL assinada oficial](https://elevenlabs.io/docs/api-reference/conversations/get-signed-url). Durante uma chamada controlada, a chave atualmente presente em `server/.env` recebeu **HTTP 401** nessa requisição. Nenhum WebSocket ElevenLabs foi aberto e **nenhum áudio foi enviado à ElevenLabs**. A track do microfone foi restaurada e a chamada encerrada. O login da conexão ElevenLabs e a chave local podem pertencer a contextos diferentes; é necessário configurar uma chave válida e autorizada para esse agente antes de repetir.

O [protocolo oficial de agente por WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) aceita `user_audio_chunk` em base64 e emite `audio_event.audio_base_64`; o servidor deve ler `conversation_initiation_metadata` para confirmar formato de entrada/saída a cada sessão. Essa compatibilidade de protocolo é **OFICIAL**, mas a ponte cVortex→Giovana→telefone permanece **HIPÓTESE** até um teste bem-sucedido. Não incluir n8n no caminho de mídia.

Para repetir apenas após corrigir a credencial, configurar `ELEVENLABS_AGENT_ID` no ambiente do servidor (ou em `server/.env`); `CVORTEX_TEST_NAME` é opcional para a variável `patient_name`. O script de laboratório não contém mais ID de agente ou nome pessoal fixo. Cada execução que disca exige um número de teste autorizado e a pessoa pronta para atender.

**Verificação posterior, sem chamada nem áudio (06/11/2026):** a chave local foi corrigida e `GET /v1/user` retornou HTTP 200. Porém, `GET /v1/convai/agents` retornou uma lista vazia e a solicitação de URL assinada para a Giovana retornou HTTP 404 `document_not_found`. Assim, a autenticação da chave está resolvida, mas essa chave ainda não dá acesso ao agente identificado pela conexão ElevenLabs do Codex. Confirmar conta/workspace e acesso ao agente antes de qualquer nova chamada.

**Resolução posterior, ainda sem chamada nem áudio (06/11/2026):** o operador criou **Giovana Teste** na conta da chave local. `GET /v1/convai/agents` encontrou o novo agente; `GET /v1/convai/conversation/get-signed-url` retornou HTTP 200 com URL `wss://` válida (valor não registrado). `server/.env` passou a apontar ao ID do novo agente. A configuração de idioma inicialmente estava `en`; foi atualizada a `pt` e verificada por resposta HTTP 200. Entrada e saída declaradas: `pcm_16000`. Naquele momento, a conversa via WebSocket e a ponte telefônica com o novo agente ainda não tinham sido testadas.

**Teste posterior em chamada controlada (06/11/2026):** após autorização para ligar ao número de teste, a ponte cVortex ↔ WS local ↔ Giovana Teste abriu. A ligação iniciou e encerrou pela UI; a PeerConnection permaneceu `connected` durante a ponte; `sender.replaceTrack()` foi aplicado e depois restaurado ao microfone original. O browser enviou 331 frames/677.888 bytes PCM16 ao servidor local e recebeu 19 frames/501.760 bytes de áudio do agente. O servidor confirmou formatos `pcm_16000` em ambos os sentidos, 1 evento de metadata, 19 eventos de áudio, 3 respostas do agente e 2 eventos de transcrição do usuário. Nenhum conteúdo de áudio ou transcrição foi salvo. A primeira resposta de áudio chegou ao servidor ~777 ms após abrir o WS do agente, mas isso **não mede** a latência de resposta à fala do usuário. O script reportou `error=null`. O operador pediu para encerrar antes de confirmar o que ouviu; portanto, a reprodução audível da voz da Giovana no telefone **não foi confirmada**. Os números provam fluxo técnico e retorno de frames até a track substituta, não percepção acústica ou qualidade da conversa.

**Aceite posterior pelo painel novo (06/11/2026):** o operador autorizou outra chamada ao mesmo número. `POST /api/calls` retornou 201, o registro passou de `connecting` a `in_progress` com `metadata.ai_connected=true` e ID de conversa ElevenLabs. `POST /api/calls/:id/end` acionou a UI; o registro persistiu como `completed` com `ended_at`. O operador confirmou **“Ouvi e ela respondeu”** no telefone. Duas tentativas anteriores falharam antes do clique de discagem por seletor de menu; foram corrigidas. Uma chamada intermediária conectou e encerrou, mas a ponte falhou por um auxiliar de compilação (`__name`) no contexto da página; o script foi corrigido e o teste seguinte passou. Nenhuma chamada a paciente real foi feita. A prova demonstra o piloto local ponta a ponta, ainda sem contrato oficial da cVortex, teste de carga ou medição de latência por turno.

## Limitações, segurança e próximo passo

- A PoC roda no contexto da página cVortex; uma aplicação em outra origem não obtém essas tracks diretamente. Extensão em mundo `MAIN`/userscript são hipóteses de empacotamento, não implementações testadas. O bundle cVortex pode substituir o sender por conta própria ao mudar volume, mute, espera, transferência ou reconexão.
- Não houve teste de `replaceTrack` durante hold, transferência, conferência, troca de dispositivo, reload, desconexão ou monitoria `Espiar`.
- Não foi medido `speech_end_timestamp → ai_audio_first_packet_timestamp`, jitter buffer nem barge-in. O teste ElevenLabs não chegou à etapa de áudio.
- A ponte usa operações privadas do webphone apenas para discar/desligar pela UI. Para produção, confirmar com a cVortex uma API de chamada e trunk SIP/media stream suportados, além de política de uso da ponte de navegador.
- Repetir o teste 3 somente após uma chave ElevenLabs válida para o agente de teste; manter key e URL assinada exclusivamente no servidor, registrar apenas métricas e restaurar o microfone em toda falha.

Ver também [mapa completo de mídia](cvortex-media-map.md), [mapa de integração](cvortex-integration-map.md) e [revisão de QA](research-cvortex-qa.md).
