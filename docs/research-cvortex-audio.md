# Pesquisa: áudio cVortex ↔ ElevenLabs

Pesquisa em fontes oficiais, 06/11/2026. Este arquivo cobre documentação pública; não inclui observações do tenant autenticado. **Documentado** indica afirmação explícita da fonte. **Inferência** indica hipótese de integração a validar com cVortex e o provedor de telefonia.

## O que a cVortex documenta

| Recurso | Evidência e limite |
| --- | --- |
| Canal de Voz | Ligações receptivas e ativas no ambiente cVortex; requer conta de provedor, número e configuração de canal. Gravações ficam disponíveis depois da chamada, em até 15 minutos, conforme processamento. [Canal de Voz](https://docs.cvortex.io/help/voz). |
| URA de voz | Workflow Studio oferece **Iniciar de Voz**, **Mensagem de Voz** (arquivo ou TTS), **Opções de Voz** (DTMF ou ASR), **Transferir Chamada** (fila, outra URA ou número externo), **Pergunta de Voz** e **Encerrar Chamada**. São funções de fluxo, não uma API publicada de streaming RTP. [Funções de Atendimento de Voz](https://docs.cvortex.io/help/funcoes-de-atendimento-de-voz-ura). |
| Entrada de voz no fluxo | **Pergunta de Voz** coleta dados por teclado ou ASR e guarda o resultado em variável; mensagem da pergunta pode ser TTS ou arquivo carregado. Isso documenta reconhecimento de respostas em pontos determinados do fluxo, sem promessa de conversa de áudio bidirecional aberta. [Pergunta de Voz](https://docs.cvortex.io/help/pergunta-de-voz). |
| TTS no fluxo | Texto fixo é sintetizado uma vez e reutilizado; binding dinâmico provoca nova geração de áudio em cada passagem e pode acrescentar latência. [Uso de TTS na URA](https://docs.cvortex.io/help/uso-de-tts-na-ura-cvortex-guia-de-otimizacao-e-boa). |
| Integração REST no fluxo | O Workflow Studio pode consultar API externa durante Atendimento por Voz. A espera da resposta pode produzir silêncio na chamada; a cVortex recomenda áudio de aguardo e fallback. Cada função Integração tem limite de 60 s. Isso é troca de dados, não transporte contínuo de áudio. [Integração](https://docs.cvortex.io/help/integracao), [Tempos limite](https://docs.cvortex.io/help/tempos-limite-das-integracoes). |
| Monitoria humana | Supervisor com permissão **Monitor Calls** pode clicar **Espiar** em Gerenciamento > Agentes e ouvir uma chamada; pode falar privadamente apenas ao agente. A documentação descreve função da interface, não endpoint de áudio ou API para monitoria externa. [Acompanhamento em Tempo Real](https://docs.cvortex.io/help/acompanhando-em-tempo-real-os-atendimento-de-voz-d). |
| Painel de voz | Há indicadores e lista de chamadas ativas/recentes em Gerenciamento > Monitoramento > Voz. Esse “tempo real” se refere ao painel operacional, sem prova de acesso programático à mídia. [Monitoramento de Voz](https://docs.cvortex.io/help/monitoramento-de-voz). |
| Gravações | A API lista gravações do caso e retorna URL de download assinada por registro. Ela fornece áudio **após** a chamada, sem acesso bidirecional ao fluxo ao vivo. [Canais e Mensagens](https://docs.cvortex.io/help/canais-e-mensagens). |
| Rede e SIP trunk | Os requisitos de estação citam `sip.cvortex.com` e `sip001`–`sip008.cvortex.com`, porta 8099/TCP, 3478–3481 TCP/UDP e faixa UDP 1000–65000. Listam G.711 e G.729 como codecs de voz, com codec acordado com a cVortex. A página diz que, **quando houver SIP trunk para voz**, a empresa deve disponibilizar IP público fixo. Isso confirma que SIP trunk é um cenário previsto pela cVortex, mas não que o tenant AmorSaúde tenha um trunk disponível para ElevenLabs ou possa controlá-lo. [Requisitos para estações de trabalho](https://docs.cvortex.io/help/requisitos-para-estacoes-de-trabalho). |
| Menção a ElevenLabs | O resumo de fevereiro de 2026 informa governança em integrações de IA “Gemini e ElevenLabs”; não explica neste resumo se é TTS, agentes conversacionais, mídia ao vivo ou recurso habilitado para cada tenant. A release de agosto informa seleção de engine TTS por URA. [Releases](https://docs.cvortex.io/help/releases). |

Não foi encontrada, nas páginas públicas consultadas, especificação de API cVortex para stream de áudio ao vivo, configuração de SIP trunk do cliente, WebRTC gateway externo ou handoff de mídia a ElevenLabs. Há menção condicional a SIP trunk nos requisitos de rede. Isso é **ausência de documentação pública de integração**, não demonstração de inexistência de recurso contratado.

## O que a ElevenLabs oferece

1. **SIP trunking para telefonia existente.** ElevenLabs documenta chamadas receptivas e ativas por trunk SIP conectado a PBX/provedor. Requer administração do trunk e compatibilidade de sinalização, transporte, autenticação e áudio. A mídia usa G.711 PCMU/PCMA em 8 kHz ou G.722 em 16 kHz; TLS 1.2+ e SRTP dependem de compatibilidade/configuração das duas pontas. [SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking).
2. **API oficial de saída pelo trunk SIP.** `POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call` aceita `agent_id`, `agent_phone_number_id`, `to_number` e opções como `conversation_initiation_client_data`. A resposta inclui `conversation_id` e `sip_call_id` que podem ser nulos. Ela só resolve o lado ElevenLabs; cVortex/provedor precisa fornecer um trunk compatível e permitir chamadas de saída por ele. [Outbound call via SIP trunk](https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call).
3. **WebSocket de conversação com áudio.** `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...` recebe áudio de entrada e devolve áudio de resposta. Para agente privado, o servidor obtém URL assinada usando a API key. É uma API para construir uma ponte de mídia, mas depende de uma fonte/sumidouro de áudio em tempo real no lado cVortex. [WebSocket](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets).
4. **Transferência pelo agente ElevenLabs.** A ferramenta `transfer_to_number` pode transferir chamadas SIP por `REFER` quando o trunk aceita esse método; transferências SIP não têm mensagem de aquecimento para o operador. Isso exige trunk SIP funcional e compatibilidade com REFER. [Transfer to number](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number).

## Avaliação de caminhos

| Caminho | Estado | Dependência decisiva |
| --- | --- | --- |
| cVortex URA + REST externo para decisões | **Documentado** | Configurar fluxo e integração no tenant; otimizar latência. Pode usar IA para decidir a próxima ação, mas não entrega áudio em fluxo contínuo à ElevenLabs. |
| cVortex/provedor → trunk SIP → ElevenLabs | **Inferência tecnicamente plausível, reforçada por menção condicional a trunk cVortex** | cVortex ou provedor deve autorizar/configurar trunk SIP interoperável, numeração, roteamento, autenticação e retorno de status/IDs. O webphone SIP e a menção genérica a SIP trunk não provam oferta desse trunk no tenant. Se o canal estiver em G.729, será preciso negociar G.711/G.722 ou transcodificar, pois a ElevenLabs não o lista entre os codecs SIP aceitos. |
| cVortex → ponte de mídia → WebSocket ElevenLabs | **Inferência dependente de interface não comprovada** | cVortex precisa oferecer streaming bidirecional oficial ou acesso aprovado ao RTP. WebSocket de sinalização do webphone e gravações tardias não bastam. |
| Monitoria via “Espiar” | **Documentado para humanos na UI** | Não há API pública documentada para ouvir por software, capturar dois canais de áudio ou assumir a chamada. |
| Gravação → análise ElevenLabs após chamada | **Documentado como possibilidade de obter arquivo depois** | Não atende conversação em tempo real nem monitoria ao vivo. |

## Perguntas técnicas objetivas para cVortex/provedor

1. O número/canal AmorSaúde pode ser roteado por trunk SIP do cliente a um SBC/host ElevenLabs, com chamadas ativas e receptivas? Quem administra o trunk e quais alterações contratuais são necessárias?
2. Há interface oficial de áudio bidirecional em tempo real por RTP/SRTP, SIP, WebRTC gateway ou media WebSocket? Qual o protocolo, codec, taxa, autenticação, latência e forma de iniciar/parar?
3. A integração ElevenLabs citada pela release de fevereiro é TTS, agentes de voz ou ambos? Está disponível no tenant AmorSaúde? Qual documentação técnica e configuração?
4. O recurso de monitoria **Espiar** tem interface programática autorizada? Fornece áudio do cliente e do agente em pistas separadas? Existe participação/assunção pela API?
5. Se usar SIP trunk, o lado cVortex aceita `REFER` para transferência, headers de correlação como `X-CALL-ID`, TLS/SRTP e G.711/G.722? Que IDs vinculam `sip_call_id`, `Call Id` cVortex e `Case Id`?

## Conclusão operacional

O teste decisivo para encaixar ElevenLabs **não** é apenas originar a ligação no webphone; é obter da cVortex/provedor uma interface de mídia ao vivo suportada. Entre as opções documentadas, o SIP trunk da ElevenLabs é o encaixe mais direto **se** cVortex ou o provedor disponibilizar um trunk interoperável. A API de gravações e a integração REST do Workflow Studio ajudam em etapas posteriores ou em fluxos de URA, mas não substituem esse contrato de mídia.
