-- Modelo de WhatsApp enviado automaticamente quando uma ligação de confirmação de consulta não é
-- atendida (caixa postal / não atendeu). Placeholders no padrão {{chave}}, preenchidos pelo servidor
-- (não usa o {nome} de uma palavra só dos modelos que a Giovana escolhe durante a ligação).
insert into public.message_templates (slug, name, when_to_use, body, is_active)
values (
  'confirmacao_nao_atendeu',
  'Confirmação automática (não atendeu)',
  'Enviado sozinho pelo sistema quando a ligação de confirmação cai em caixa postal ou ninguém atende.',
  'Olá, *{{nome_paciente}}*! Tudo bem? 😊💙

Aqui é da *Clínica Amor Saúde de Fernandópolis!*

Estamos entrando em contato para confirmar sua consulta:

📋 *Dados do agendamento:*
👨‍⚕️ *Profissional:* {{nome_profissional}}
🩺 *Especialidade:* {{especialidade}}
📅 *Data:* {{data_consulta}}
🕒 *Horário:* {{horario_consulta}}

*Você poderá comparecer à consulta?*

✅ *SIM* — Confirmo minha presença.
❌ *NÃO* — Não poderei comparecer.

Pedimos que responda para que possamos organizar nossa agenda.

Aguardamos sua confirmação! 💙',
  true
)
on conflict (slug) do nothing;
