# Automação opcional após a chamada

O backend envia um `POST` para `N8N_WEBHOOK_CALL_COMPLETED_URL` somente após a chamada chegar a um estado terminal. O n8n não participa da telefonia nem recebe áudio. A ausência ou falha do webhook não impede a ligação nem altera seu resultado.

Exemplo de payload:

```json
{
  "event": "call.completed",
  "call_id": "uuid",
  "patient_name": "José",
  "phone": "+5517999999999",
  "brain": "patient-acquisition",
  "status": "completed",
  "result": "interested",
  "transfer_requested": false,
  "summary": null
}
```

`summary` pode ser nulo e `result` será `unknown` até haver classificação verificada ou revisão do operador. Não deduza resultado com base apenas no término da chamada.

Workflow sugerido no n8n:

1. **Webhook** recebe o evento e verifica `event === "call.completed"`.
2. **Switch** em `result`.
3. `interested`: atualizar o lead e notificar o operador para agendamento.
4. `callback`: criar tarefa de retorno.
5. `do_not_contact`: marcar o contato como bloqueado em sistemas downstream.
6. `not_interested` ou `unknown`: registrar sem nova abordagem automática.

Configure o webhook com URL secreta, limite de acesso no n8n e política de retenção compatível com dados pessoais. Evite enviar conteúdo clínico ou transcrição desnecessária. Trate eventos repetidos de modo idempotente usando `call_id` como chave. O backend deve aplicar timeout curto e registrar falhas sem incluir telefone completo ou payload sensível nos logs.
