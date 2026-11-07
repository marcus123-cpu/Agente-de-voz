# Revisão independente das evidências cVortex

Data: 06/11/2026. Escopo: missão fornecida pelo usuário, relatórios [WebRTC](research-cvortex-webrtc.md), [SIP](research-cvortex-sip.md), [frontend](research-cvortex-frontend.md), [arquitetura](research-cvortex-architecture.md), [mapa de integração](cvortex-integration-map.md) e código dos dois experimentos. Esta revisão não acessou a sessão autenticada nem fez chamadas. Não contém credenciais, identificadores de chamada, números de telefone ou áudio.

## Veredito por afirmação

| Afirmação | Grau | Evidência e limite |
| --- | --- | --- |
| O webphone abre uma perna WebRTC bidirecional | **Testado** | Uma `RTCPeerConnection` conectada, transceiver `sendrecv`, sender e receiver de áudio, RTP de entrada e saída com bytes/pacotes não nulos; `getStats()` indicou `audio/PCMU` a 8 kHz nos dois sentidos. Refere-se à perna do navegador, não ao trunk PSTN. |
| A track enviada vem do microfone do navegador | **Testado** | O sender continha, por identidade de objeto, uma track retornada por `getUserMedia`. O script mudou `enabled` por 500 ms e restaurou. **Não houve confirmação remota específica de silêncio durante esse intervalo**; portanto, a prova de mute remoto permanece incompleta. |
| É possível obter a track recebida no contexto da página | **Testado** | `receiver.track` estava `live`; `new MediaStream([receiver.track])` alimentou `MediaStreamAudioSourceNode`. Isto comprova acesso ao objeto e ao pipeline, mas não identifica sozinho o conteúdo como fala da pessoa atendendo. |
| Um áudio sintético substitui o microfone e chega ao telefone | **Testado nesta chamada** | `sender.replaceTrack(testTrack)` resolveu, a conexão permaneceu `connected`, a track original foi restaurada; o usuário confirmou que ouviu claramente o tom. É a prova funcional mais forte da saída. O teste não mediu atraso, cortes ou retorno da voz do operador após a restauração. |
| Não ocorreu renegociação SIP/WebRTC | **Indício, não prova conclusiva** | O teste comparou `pc.signalingState` antes/depois. Uma renegociação completa poderia voltar a `stable` sem aparecer nessa comparação. Seria preciso registrar eventos de `negotiationneeded`, chamadas `setLocalDescription`/`setRemoteDescription` ou SIP offer/answer durante a janela. |
| Áudio da track remota foi enviado ao servidor local | **Testado em nível de transporte** | O browser registrou 81 blocos e 165.888 bytes PCM enviados por WS, e o servidor registrou os mesmos totais. A origem no código é `receiver.track → MediaStreamSource → ScriptProcessor → PCM16`. Os números comprovam fluxo de amostras, não que a frase falada pelo usuário estava audível/inteligível nelas; silêncio, ringback ou mistura também produziriam blocos. |
| Áudio retornado pelo servidor chegou ao telefone | **Testado nesta chamada** | Servidor enviou 150 blocos/96.000 bytes de tom PCM16, browser registrou recepção, converteu em `AudioBufferSourceNode`, ligou a `MediaStreamDestination` e fez `replaceTrack`; usuário falou e confirmou que ouviu o tom. |
| A ponte já integra ElevenLabs | **Não testado** | O servidor retornou um tom local, sem conexão ao WebSocket de agente, autenticação, conversão de formato de conversa ou controle de turnos ElevenLabs. |
| Existe API oficial de discagem/controle/mídia cVortex para este tenant | **Não confirmado** | A API pública documenta autenticação, casos, histórico e gravações posteriores. Os comandos GraphQL/SIP vistos pertencem ao webphone privado. A documentação consultada não estabelece contrato público para originar/desligar nem stream bidirecional ao vivo. |
| O teste representa chamada de paciente vinculada a caso | **Não testado** | A rota exercitada foi `Ligar para um Colaborador` com número externo autorizado. O manual da cVortex trata essa modalidade separadamente. Não extrapolar criação de caso, caller ID, gravação, fila ou estados de um atendimento normal. |

## Consistência entre relatórios

1. [WebRTC](research-cvortex-webrtc.md) é um plano elaborado **antes** dos ensaios; a tabela inicial ainda marca `replaceTrack` e voz remota como não testados. Atualizar ou rotular como histórico para evitar conflito com os resultados posteriores.
2. [Arquitetura](research-cvortex-architecture.md) já incorpora o primeiro tom, mas ainda chama a ponte WS local de “próxima PoC” e “não testada”. O segundo ensaio concluiu essa etapa em laboratório. A integração ElevenLabs continua futura.
3. [Mapa de integração](cvortex-integration-map.md) registra o primeiro teste de telefonia e RTP, mas ainda apresenta o acesso ao áudio ao vivo como pergunta pendente e não contém o resultado de `replaceTrack` nem do WS local. O mapa final precisa separar **capacidade técnica da página testada** de **interface de mídia suportada pelo fornecedor ainda desconhecida**.
4. O relatório de [frontend](research-cvortex-frontend.md) mostra que o próprio componente usa `sender.replaceTrack` para volume de microfone. Isso apoia a viabilidade técnica, mas também introduz disputa de controle: alterações de volume, mute, hold, rerender ou reconexão podem substituir a track da ponte sem aviso.
5. O relatório [SIP](research-cvortex-sip.md) distingue corretamente sinalização SIP do navegador, trunk contratável e chamada de colaborador. Manter essas distinções no mapa final.

## Limites técnicos e operacionais da PoC

- O `ScriptProcessorNode` usa blocos de 1.024 amostras a 16 kHz, cerca de 64 ms por callback. Não há timestamps, medição de latência, controle de jitter, limite de `WebSocket.bufferedAmount` ou descarte de blocos atrasados. A taxa de envio observada não mede a latência percebida.
- O servidor de demonstração aceita apenas loopback e confere `Origin`, mas não autentica por chamada. Isso é apropriado para o teste isolado, insuficiente para uma ponte de produção. Um cliente local pode definir `Origin` arbitrariamente. O protocolo também não identifica sessão, direção, formato ou sequência de frames.
- O código envia blocos de áudio do receiver continuamente, inclusive quando há silêncio ou tons. Não verifica energia, VAD, inteligibilidade, canal separado nem correspondência temporal da frase falada pelo usuário. A confirmação de voz inbound exige um ensaio controlado adicional com métrica efêmera e sem gravação, ou confirmação de transcrição temporária consentida, se for realmente necessária.
- O servidor dispara o tom após receber dez blocos, independentemente de fala. Logo, o fato de o usuário ter falado e ouvido tom não comprova causalidade entre a fala e a resposta. Comprova transporte bidirecional e playout remoto na mesma chamada.
- O sinal `tone-finished` marca o fim do envio pelo servidor, não o fim de reprodução no telefone. O browser pode fechar o `AudioContext` com áudio ainda enfileirado; a confirmação auditiva prova que ao menos parte chegou, não a duração integral dos 3 segundos nem ausência de corte.
- A restauração da track em `finally` foi observada nos dois testes, mas é **best effort** se a aba, o processo ou a rede falharem. O código ainda força `original.enabled = true`, que pode contrariar um estado de mute anterior. Um piloto precisaria preservar o valor original, supervisionar vida da sessão e falhar de modo audível e controlado.
- A checagem `ended` do script equivale ao desaparecimento do controle de desligar na UI. No primeiro teste o usuário confirmou término no telefone; no segundo a saída do script registra término, mas a resposta mais recente confirma fala e tom, não explicitamente a desconexão remota.
- O receiver, sender e `RTCPeerConnection` podem ser recriados após espera, transferência, conferência, troca de rede ou dispositivo. Nenhuma dessas transições foi exercitada. Um ponto de inserção estável requer reidentificação e tratamento de conflito com o código do webphone.
- Os scripts de laboratório mostram o mecanismo, mas não são um conector oficial; a rota GraphQL privada e credenciais SIP do webphone não devem ser copiadas para um backend durável.

## Lacunas prioritárias antes de usar no produto

1. **Fornecedor:** obter da cVortex/provedor contrato para API de discagem, desligamento e eventos, além de trunk SIP ou stream de mídia bidirecional. Confirmar direito do tenant, codec, transporte, segurança, IDs e suporte à transferência. Ausência na documentação pública é apenas ausência de evidência.
2. **Fluxo de caso:** testar, com contato de laboratório e caso de teste, a discagem normal do atendimento. Correlacionar IDs de UI, eventos, Voice History e eventual gravação sem armazenar conteúdo pessoal.
3. **Entrada de fala:** numa chamada atendida, medir no servidor local energia ou outra métrica agregada em memória durante janela de fala e silêncio conhecida. Registrar apenas métricas e tempos, sem amostras. Isso demonstraria que a track inbound transporta a voz do interlocutor.
4. **Robustez da ponte:** medir atraso ponta a ponta; manter filas limitadas, sincronização de chunks, detecção de desconexão, restauração do estado exato do microfone, comportamento em reload/hold/transfer e monitoria de estado da PeerConnection.
5. **ElevenLabs:** só após escolher o caminho suportado ou um piloto autorizado, testar WS assinado no backend, formato de áudio, fluxo de resposta, interrupção/barge-in, cancelamento e medição `speech_end → first_audio`.
6. **Telemetria de chamada:** confirmar semanticamente `dialing`, `answerCall`, `hangup`, estados busy/failed/no_answer, causa de término, replay/reconexão e webhook oficial. Os eventos privados do webphone não garantem entrega servidor a servidor.

## Conclusão

Os dois ensaios demonstram uma **ponte bidirecional funcional no contexto do navegador para uma chamada externa controlada**: amostras saíram da track WebRTC recebida até um servidor WS local, e um tom gerado nesse servidor voltou por `replaceTrack` e foi ouvido no telefone. Essa prova ainda não valida a fala de entrada por conteúdo, latência de conversa, integração ElevenLabs, chamada de caso/paciente ou suporte contratual da cVortex para produção. O próximo passo decisivo para o produto é obter a interface oficial de mídia/telefonia do fornecedor; a PoC no navegador é evidência de viabilidade técnica e referência de laboratório.
