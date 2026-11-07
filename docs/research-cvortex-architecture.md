# Arquitetura da ponte de áudio cVortex ↔ ElevenLabs

Atualizado em 06/11/2026. Escopo: comparação de arquiteturas a partir da documentação oficial e dos testes controlados conduzidos no tenant AmorSaúde. Este relatório não acessou a sessão autenticada. **OFICIAL** = contrato publicado pelo fornecedor; **TESTADA** = experimento no tenant; **OBSERVADA** = inspeção sem prova funcional completa; **HIPÓTESE** = caminho ainda sem ensaio ou contrato.

## Prova técnica disponível

**TESTADA no navegador, em chamada para número autorizado:** a conexão ativa tinha sender de áudio associado por identidade de objeto à track de `getUserMedia`, receiver de áudio `live`, transceiver `sendrecv` e RTP PCMU/8 kHz nos dois sentidos. `new MediaStream([receiver.track])` alimentou um `MediaStreamAudioSourceNode` em memória, sem gravação ou transmissão externa. Um `AudioContext → OscillatorNode → GainNode → MediaStreamAudioDestinationNode` gerou uma track de teste; `sender.replaceTrack(testTrack)` resolveu, a conexão permaneceu `connected`, não houve renegociação observada e o sender voltou à track original. **O usuário confirmou que ouviu claramente o tom no telefone.** A prova é da perna WebRTC do webphone e do áudio artificial entregue ao número de teste, não de um produto de integração suportado.

O teste de leitura da track remota demonstrou acesso programático ao objeto e um pipeline Web Audio em memória. Para afirmar que o conteúdo recebido é fala da pessoa atendendo, ainda convém uma chamada com a pessoa dizendo uma frase de teste, correlacionada a energia/RTP sem gravar amostras. O retorno de áudio do cVortex pode carregar ringback, URA ou voz, conforme a fase da ligação.

## Comparação de caminhos

| Caminho | Estado e evidência | Estabilidade/manutenção | Latência e segurança | Pré-requisito decisivo |
| --- | --- | --- | --- | --- |
| **A. Ponte no contexto da página**: `receiver.track → Web Audio → WS próprio → ElevenLabs → track sintética → replaceTrack` | **TESTADA EM PARTES**: acesso ao receiver, criação de track e envio de tom ao telefone confirmados pelo usuário; WS local no tenant transportou frames no experimento e no preflight sem chamada. A conversa completa com agente ElevenLabs ainda não foi validada pelo usuário. | Dependência forte do ciclo de vida e de mudanças do webphone, da sessão e do navegador do operador. Wrappers precisam entrar antes da criação da PeerConnection. | Acrescenta navegador, bridge e ElevenLabs ao caminho. Exige buffer de baixa latência, resample, autenticação do WS e restauro imediato do microfone em falha. Nenhum número de latência foi medido. | Confirmar conversa bidirecional, interrupção e encerramento em chamada real. |
| **B. Extensão interna Chrome** | **HIPÓTESE** de empacotamento da ponte A. A API Chrome permite script no mundo `MAIN`, compartilhado com o JavaScript da página; content script padrão fica isolado. [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting), [content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts). | Exige distribuição, atualização e permissões da extensão; ainda depende do frontend cVortex e do navegador do agente. Pode tornar a injeção precoce e o desligamento explícito mais administráveis. | Acrescenta ponte entre mundo da página e extensão/backend. Restringir host permissions ao tenant e não copiar tokens, cookies, SIP/SDP ou áudio para logs. | Aprovação organizacional para instalar extensão, implementação com `world: "MAIN"` e permissão de host. Não implementada. |
| **C. Userscript/injeção controlada** | **TESTADA apenas como instrumentação de laboratório** via Playwright `addInitScript`; não há userscript persistente. | Baixa previsibilidade para produção: início da instrumentação, atualizações de bundle, reload, sessão e política do navegador. | Mesmo caminho de mídia da ponte A, com operação e auditoria mais difíceis. | Uso restrito ao laboratório interno; não contornar CSP/autenticação nem criar persistência oculta. |
| **D. cVortex/provedor ↔ SIP trunk ↔ ElevenLabs** | **OFICIAL no lado ElevenLabs**; cVortex menciona SIP trunk como cenário condicional e exige IP público fixo. **HIPÓTESE para este tenant**. A interseção de codecs inclui G.711 PCMU/PCMA. [cVortex](https://docs.cvortex.io/help/requisitos-para-estacoes-de-trabalho), [ElevenLabs](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking). | Potencialmente melhor para produção por evitar dependência do frontend e da sessão do operador, desde que fornecedor configure e suporte roteamento, número e SBC. | Menos saltos de aplicação no navegador, mas latência real depende do trunk, região, codec e ElevenLabs; medir. Requer autenticação SIP, TLS/SRTP/ACL conforme contrato. | cVortex/provedor disponibilizar trunk interoperável, chamadas ativas/receptivas, correlação de IDs e eventual `REFER` para transferência. |
| **E. Media stream oficial cVortex/provedor → bridge → ElevenLabs** | **HIPÓTESE**: não localizado contrato público de stream bidirecional no material consultado. | Poderia ser estável e independente de navegador se versionado e suportado; implementação própria de bridge continuaria necessária. | Exige transcodificação, buffers, controle de fluxo, autenticação, redirecionamento de mídia e política de falha. Medir latência ponta a ponta. | Contrato de mídia bidirecional com codec, formato, IDs, autenticação, eventos e autorização do fornecedor. |

As [gravações da API cVortex](https://docs.cvortex.io/help/canais-e-mensagens) só ficam disponíveis depois da ligação e não constituem caminho E. A função REST do Workflow Studio serve para dados/decisões, não para transportar pacotes de áudio em tempo real; n8n deve permanecer fora do caminho de mídia.

## Ponte A: dados e controle necessários

```text
RTP remoto → RTCRtpReceiver.track → cópia MediaStream/Web Audio
  → encoder/resampler → WebSocket autenticado do nosso backend
  → ElevenLabs Agent WebSocket
  → chunks de áudio → jitter buffer/decoder/Web Audio
  → MediaStreamAudioDestinationNode.stream.getAudioTracks()[0]
  → RTCRtpSender.replaceTrack(track da IA) → RTP cVortex → telefone
```

O [WebSocket de agentes da ElevenLabs](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets) aceita áudio de entrada e emite áudio de resposta em tempo real; para agente privado, o backend deve obter URL assinada, sem expor API key no navegador. É preciso adaptar formato/taxa da track Web Audio ao formato negociado na conversa ElevenLabs, enfileirar chunks de saída e cancelar/limpar a fila em interrupção. A ElevenLabs recomenda buffering adaptativo e jitter buffer; isso não fornece métricas de latência para este cenário.

O código no contexto da página precisa manter referências locais a `pc`, `receiver`, `sender` e track original. Um aplicativo em outra origem não lê diretamente esses objetos por isolamento do navegador. O content script comum de extensão também é isolado; `chrome.scripting` com mundo `MAIN` é o mecanismo documentado para executar código no mesmo ambiente JavaScript da página. Toda comunicação com nosso backend deve ter autenticação curta, limite por chamada e desligamento visível. A track original deve ser restaurada em `finally`, desconexão do WS, fim de chamada e navegação. [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting), [isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [replaceTrack](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack).

**Lacuna de produção:** não há garantia da cVortex de que instrumentar/substituir tracks de seu webphone seja uma interface suportada. O sucesso local não autoriza depender de `VoiceLogin`, SIP WS ou GraphQL privados como API do servidor. A ponte no navegador é um caminho de laboratório ou piloto controlado até haver acordo de suporte e segurança.

## Sequência de provas de conceito

1. **Concluída:** chamada controlada, sender/receiver identificados, track remota acessível em memória, `replaceTrack` com tom local, restauro e confirmação auditiva no telefone. Nenhum áudio foi armazenado.
2. **Parcialmente concluída:** o WS local abriu a partir da página cVortex e transmitiu frames em experimento; o preflight sem chamada também confirmou abertura e recebimento de um frame. O provider de backend já monta caminho PCM com `ScriptProcessor` e track de saída, mas não houve ainda validação auditiva de uma conversa completa com agente.
3. **Próxima PoC em chamada:** validar o agente ElevenLabs com URL assinada obtida no backend. Medir do fim da fala no telefone até o primeiro pacote de áudio da IA, além de interrupção/barge-in, jitter e perda. Não incluir n8n no áudio.
4. **Em paralelo, solução suportada:** pedir à cVortex/provedor especificação de trunk SIP ou media stream oficial e testar em canal/número de laboratório. Se disponível, comparar com a ponte no navegador por confiabilidade, latência real, controle, auditoria, custo e manutenção antes de escolher produção.

## Perguntas que permanecem

- A track remota contém voz do interlocutor atendido em toda a chamada ou uma mistura com URA/ringback? Há separação de faixas para monitoria?
- O webphone troca PeerConnection/sender após hold, transferência, conferência ou reconexão? A instrumentação deve reidentificar a conexão em cada transição.
- O usuário precisa manter sessão, guia e microfone ativos para a ponte A/B? O que acontece ao suspender a guia, perder dispositivo ou trocar de rede?
- A cVortex oferece canal de mídia ou trunk contratualmente suportado para o tenant? Quais números, métodos SIP, codecs, TLS/SRTP, IDs e eventos?
- `REFER` para transferir de ElevenLabs a um operador é aceito pelo trunk cVortex? [ElevenLabs transfer to number](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number).
