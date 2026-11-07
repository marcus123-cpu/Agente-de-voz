# Pesquisa SIP, SDP e telefonia cVortex

Atualizado em 06/11/2026. Escopo deste relatório: documentação oficial e evidências técnicas já registradas em `docs/cvortex-integration-map.md`. Não houve acesso desta pesquisa à sessão autenticada, captura de frames crus, credenciais, SDP integral ou chamadas.

## Classificação da evidência

- **OFICIAL**: afirmação explícita na documentação da cVortex ou ElevenLabs.
- **OBSERVADA**: instrumentação anterior do webphone no tenant, descrita no mapa principal; valores de sessão e mídia não foram preservados.
- **HIPÓTESE**: interpretação do fluxo ou arquitetura a validar.

## Fluxo SIP observado no webphone

| Etapa | Evidência | Limite |
| --- | --- | --- |
| Sinalização | **OBSERVADA** conexão `wss://sip004.cvortex.com:8099/ws`; `REGISTER`, `OPTIONS` e respostas `SIP/2.0 200` na inicialização | WebSocket SIP da aplicação, sem contrato público de interconexão externa |
| Preparação da ligação de teste | **OBSERVADA** operação privada GraphQL `DirectAgentContact` antes de `INVITE` recebido pelo navegador | A ordem sugere orquestração de chamada pelo servidor, mas não demonstra a topologia completa das pernas |
| Estabelecimento da perna do navegador | **OBSERVADA** `INVITE` recebido com SDP de áudio → navegador enviou `100`, `180`, `200` com SDP → `ACK` recebido | O `180` foi resposta do **navegador à perna que o chamou**; não comprova por si só o estado de toque do telefone remoto |
| Término | **OBSERVADA** `HangupCall` privado → `BYE` recebido pelo navegador → `200` enviado | O botão desligou no teste; não há contrato público equivalente para backend |

Não foram observados `183`, `REFER`, `NOTIFY` ou `CANCEL` nessa chamada curta. **Não observado** não significa **ausente do produto**; transferência, falha, cancelamento e chamada recebida exigiriam testes próprios em números autorizados.

## SDP e codec

O `INVITE` e o `200` observados tinham `m=audio` e direção `sendrecv`, com PCMU/8000, PCMA/8000, Opus/48000 e telephone-event/8000 na negociação. Os nomes de atributos `rtpmap`, `fmtp`, `ptime`, `maxptime`, `ice-ufrag`, `ice-pwd`, `candidate`, `fingerprint` e `setup` indicam ICE e DTLS-SRTP/WebRTC; nenhum valor desses atributos foi registrado. A medição `getStats()` no navegador confirmou **PCMU/8 kHz** em `inbound-rtp` e `outbound-rtp`, com bytes e pacotes não nulos. Esses fatos se referem à perna do webphone. Não estabelecem codec do trunk PSTN nem a disponibilidade de RTP externo.

**HIPÓTESE:** o cVortex usa media server/B2BUA entre a perna WebRTC do agente e a chamada externa. O `INVITE` recebido após a mutation de discagem é compatível com isso, mas o outro lado da chamada não foi inspecionado; não tratar como topologia confirmada.

## Caminhos de discagem: colaborador versus cliente

A [release oficial de outubro de 2024](https://docs.cvortex.io/help/2024-outubro) afirma que **Ligar para um Colaborador** permite selecionar colaborador interno/externo ou digitar número, mesmo sem caso. A gravação dessa modalidade é configurável por unidade de negócio e fica desligada por padrão. Foi precisamente esse menu que acionou `DirectAgentContact` nos testes anteriores. Portanto, o teste confirma chamada externa a número controlado, **não** a criação de um caso de paciente, o caminho de gravação de caso ou o endpoint de discagem do fluxo de atendimento.

O [manual oficial do Webphone](https://docs.cvortex.io/help/webphone-1) documenta outro caminho: teclado virtual → `Discar`, ou escolha do contato telefônico de uma pessoa no atendimento → `Ligar`. A [documentação do Cabeçalho Central](https://docs.cvortex.io/help/cabecalho-central) também descreve o atalho de voz vinculado ao cliente em tela. O bundle contém mutation privada `MakeCall`, ainda não exercitada. É plausível que essa mutation participe da discagem normal, mas a relação precisa ser verificada em um **caso de teste**, sem chamar paciente real.

## Transferência, espera e conferência

O [manual do Webphone](https://docs.cvortex.io/help/webphone-1) confirma funcionalmente:

- **Espera**: cliente aguarda ouvindo música predefinida.
- **Transferência direta**: encaminha a ligação sem consulta prévia.
- **Transferência consultiva**: consulta destinatário antes da conclusão.
- **Conferência**: acrescenta participante à ligação; interface mostra cartões `Em Espera`, `Em Ligação` ou `Em conferência`.
- **Mute**: controle de microfone; o manual não especifica se desabilita track local, altera sender ou usa sinalização SIP.

**OBSERVADA no bundle/assinaturas**, sem execução de transferência: mutations privadas `DirectTransfer`, `AssistedTransfer`, `ConfirmTransfer`, `InitiatedConference`, `MakeNewCallForConference`, `CancelNewCallForConference`; assinaturas `BlindTransfer`, `AttendedTransfer`, `DeliveredAttendedTransfer`, `TransferActivated`, `ConferenceActivated`, `ConferenceJoin`, `ConferenceLeave`. Nomes de operação não demonstram qual método SIP é emitido. **REFER, Replaces e Join permanecem não verificados.** A transferência pode ser controlada integralmente pelo backend do fornecedor e não aparecer como `REFER` na perna do navegador.

A [URA cVortex](https://docs.cvortex.io/help/funcoes-do-workflow) também possui bloco `Transferir Chamada`, mas isso é função de fluxo, distinta do controle manual do webphone.

## Discador automático e estados

O [tutorial do discador automático](https://docs.cvortex.io/help/acompanhando-o-funcionamento-do-seu-discador) descreve o campo **Queue Status** do caso com `WAITING_FOR_DIALER`, `CONTACT_NUMBER_NOT_FOUND`, `PREPARE_FOR_DIAL`, `DIALING`, `NOT_ANSWER`, `IN_ATTENDANCE` e `HANGUP`. Essa taxonomia pertence à URA reversa/discador automático associado a casos. Não se deve aplicá-la automaticamente à chamada `DirectAgentContact` de colaborador nem tratá-la como webhook de telefonia.

A entidade analítica [Case Information](https://docs.cvortex.io/help/visao-geral-case-information) possui `Outbound Calls Count`, `Ringing time`, `First Talking`, `First voice way`, `Is Talking`, `Talking now time`, `Talking start time`, `Talking time` e `Voice duration complete`. Esses campos podem ajudar a validar uma chamada de atendimento associada a caso, mas a página não estabelece sua disponibilidade por webhook ou a latência de atualização. [Voice History](https://docs.cvortex.io/help/visao-geral-entidade-voice-history) acrescenta `Call Id`, `External Id`, `Parent Call Id`, `Transfer To/Type`, `Hangup Cause`, `Provider Account Key`, `Server Digital` e marcadores de evento SIP. Correlacionar ambos requer IDs reais em um caso de teste.

## SIP trunk e ElevenLabs

A [cVortex lista requisitos de conectividade](https://docs.cvortex.io/help/requisitos-para-estacoes-de-trabalho): `sip.cvortex.com` e `sip001`–`sip008.cvortex.com`, 8099/TCP, 3478–3481 TCP/UDP, faixa UDP 1000–65000, codecs G.711/G.729 e IP público fixo **quando houver SIP trunk para voz**. O texto não publica configuração de trunk, URI de registro, autenticação, ACL, TLS/SRTP, roteamento ou autorização do tenant AmorSaúde para conectar outra plataforma. O host `sip004` do WS observado é compatível com a lista de rede, mas isso não o transforma em trunk reutilizável.

A [ElevenLabs documenta trunk SIP](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking) com PCMU/PCMA (G.711) ou G.722, conexão TLS e SRTP conforme configuração. G.729 não está entre os codecs SIP aceitos por essa documentação. Logo, há interseção de codec em **G.711**, mas a conexão cVortex ↔ ElevenLabs só será viável com trunk/roteamento autorizado, números e IDs de correlação. A [API outbound SIP](https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call) é do lado ElevenLabs e não habilita, sozinha, a telefonia cVortex.

Para transferência da IA a uma pessoa, a [ElevenLabs usa SIP REFER](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number) quando o trunk permite esse método. Isso **não** prova que o trunk cVortex o permita; confirmar com o fornecedor e ensaiar em ambiente autorizado.

## Perguntas de protocolo para o fornecedor

1. A conta AmorSaúde possui SIP trunk de cliente disponível para interconexão, ou apenas webphone e trunk operado internamente pela cVortex? Quem controla roteamento e SBC?
2. Para chamadas ativas e receptivas, que métodos, transporte e codecs são suportados: `INVITE`, `BYE`, `REFER`, `NOTIFY`, `Replaces`, `Join`, TLS, SRTP e PCMU/PCMA/G.722?
3. A transferência direta/consultiva do webphone gera `REFER` na perna do agente ou é orquestrada no backend? O mesmo vale para espera e conferência.
4. Quais IDs correlacionam `Call Id`, `Case Id`, `digitalId`, `externalId`, SIP `Call-ID`, gravação e eventual `sip_call_id` ElevenLabs? São estáveis entre transferências?
5. Há trunk ou media fork oficial que permita áudio **bidirecional** de uma chamada cVortex já ativa, com política de autorização e codec documentados?
