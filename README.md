# Central de Atendimento — cVortex + ElevenLabs

Painel local para o operador iniciar uma ligação pelo webphone cVortex, conectar a voz do agente ElevenLabs e assumir a conversa com o próprio microfone. O backend controla uma janela Chromium com perfil isolado via Playwright; o navegador transporta áudio WebRTC, e uma ponte WebSocket em `127.0.0.1` encaminha PCM16 ao agente. Não há dependência de telefonia Twilio no aplicativo.

## Estado do projeto

- **Comprovado em chamada de teste:** discagem e desligamento pela interface cVortex; acesso às tracks WebRTC; substituição reversível do microfone; áudio do telefone encaminhado ao servidor local; áudio da Giovana Teste recebido e encaminhado à track de saída; a ligação terminou e o microfone foi restaurado.
- **Comprovado pelo operador no telefone:** na chamada iniciada pelo painel novo, a Giovana Teste foi ouvida e respondeu à fala. O painel registrou `ai_connected`, ID de conversa e término `completed`.
- **Comprovado em chamada real em 06/11/2026:** após a nova ação Assumir, a ponte da IA foi fechada, a track original do microfone estava viva e habilitada, a ligação permaneceu ativa e o desligamento posterior foi confirmado. O operador confirmou que a voz da Giovana soou feminina e que ela parou de falar, mantendo a ligação até o desligamento. A audição da voz humana pelo microfone restaurado ainda precisa ser testada com uma segunda pessoa na linha.
- **Limite de suporte:** o controlador local usa a UI `Ligar para um Colaborador` e instrumenta o webphone. A cVortex não publicou um contrato de API de originação/áudio para este tenant; portanto, este fluxo é um **piloto local**, sujeito a mudanças da interface. Não usar para chamadas de pacientes reais até validar política do fornecedor, qualidade, consentimento e operação.

O [mapa de integração](docs/cvortex-integration-map.md), o [mapa de mídia](docs/cvortex-media-map.md) e a [prova de conceito](docs/cvortex-audio-bridge-poc.md) têm as evidências e limites. O teste ponta a ponta pelo painel foi realizado em 06/11/2026 com o número autorizado, sem chamadas a pacientes reais.

## Instalação local

1. Execute `npm install` na raiz.
2. Preencha `server/.env` a partir de [.env.example](.env.example): senha do operador, segredo de sessão, Supabase, `ELEVENLABS_API_KEY` e `ELEVENLABS_AGENT_ID`. Somente o backend lê essas chaves. Preencha `web/.env` com `VITE_API_BASE_URL=http://localhost:3001` e `VITE_DEMO_MODE=false`.
3. Aplique as migrações em `supabase/migrations/`. O projeto Supabase configurado neste workspace já recebeu a migração `cvortex_only` em 06/11/2026.
4. Execute `npm run dev` e abra `http://localhost:5173`. O navegador cVortex isolado precisa estar aberto e autenticado. Use `npm run cvortex:open` se a janela não abrir automaticamente.
5. No painel, selecione o cérebro com o ID do agente ElevenLabs correto. Cada cérebro usa seu próprio Agent ID; o `ELEVENLABS_AGENT_ID` do servidor serve apenas como compatibilidade para o cérebro inicial de captação.

Na área **Conexões**, use **Abrir perfil cVortex** para trazer a janela isolada à frente e entrar diretamente no webphone. O painel verifica se o login está ativo. A conexão ElevenLabs é feita por chave de API: é possível validar e substituir a chave existente ou removê-la. O valor salvo fica apenas em `server/.env` e não é retornado ao navegador. Entrar no site da ElevenLabs não substitui a chave de API do servidor.

## Captação e atendimento humano

Selecione **Captação de Pacientes**, informe nome e telefone e clique em ligar. Quando a pessoa demonstrar interesse, a Giovana avisa que chamará alguém da equipe. Clique em **Assumir ligação**: a ponte com a ElevenLabs é encerrada e a track original do microfone do webphone é restaurada, enquanto a ligação cVortex permanece ativa. Fale pelo microfone autorizado no navegador cVortex e use **Desligar** ao terminar. A nova voz feminina brasileira da Giovana e a instrução de captação estão registradas em [giovana-prompt.md](docs/giovana-prompt.md).

Em **Cérebros IA**, há opções iniciais inativas de Confirmação, Faltosos e Contexto personalizado; também é possível criar outras. Para fazer chamadas com cada uma, crie e configure um agente separado na ElevenLabs, vincule o Agent ID e ative o cérebro. O campo “Contexto planejado” fica salvo no sistema, mas não altera o prompt remoto automaticamente.

O material operacional enviado para a Clínica Amor Saúde Fernandópolis foi incorporado ao cérebro de Captação. A [cópia integral](docs/amor-saude-fernandopolis-base-mestra.md) e o [mapa do conhecimento](docs/amor-saude-knowledge-map.md) distinguem as referências históricas das informações que a Giovana pode usar na ligação.

O servidor só disca após clique do operador no painel. Não há discagem automática ao iniciar. Apenas uma chamada por vez é suportada neste piloto. Se o webphone estiver desconectado, o painel informa indisponibilidade. A aplicação guarda nome, número, estados e resultado no Supabase; áudio, transcrições e credenciais do webphone não são persistidos pela ponte.

## Comandos

```text
npm run dev       inicia backend e frontend
npm run cvortex:open  abre o perfil isolado do webphone
npm run typecheck verifica tipos
npm run build     compila o aplicativo
npm test -w server executa testes do backend sem discar
```

## Limites antes de uso operacional

- O fluxo `Ligar para um Colaborador` não comprova criação de caso, identificação de paciente, gravação, caller ID configurável ou roteamento de retorno.
- A URL de sessão do agente fica apenas no servidor; o navegador cVortex recebe PCM pela ponte local. A ponte depende de uma aba autenticada e do ciclo de vida da build cVortex.
- A tomada humana pelo mesmo webphone passou no teste de track, estado da chamada e continuidade percebida pelo operador; ainda falta confirmar por audição a voz do operador. Monitoria humana simultânea, transferência telefônica real e transcrição ao vivo não estão implementadas.
- Para substituir o piloto por integração suportada, solicitar à cVortex documentação/provisionamento de originação, status, desligamento e SIP trunk ou media stream bidirecional. Veja as [perguntas ao fornecedor](docs/cvortex-integration-map.md).
