-- Automações: modelos de mensagem de WhatsApp e registro dos envios.
create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (char_length(name) between 2 and 80),
  when_to_use text not null default '' check (char_length(when_to_use) <= 300),
  body text not null check (char_length(body) between 2 and 1500),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references public.calls(id) on delete set null,
  template_slug text,
  patient_name text,
  phone text not null,
  body text not null,
  source text not null default 'ia' check (source in ('ia', 'teste')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index whatsapp_messages_created_idx on public.whatsapp_messages (created_at desc);
create index whatsapp_messages_call_idx on public.whatsapp_messages (call_id);

alter table public.message_templates enable row level security;
alter table public.whatsapp_messages enable row level security;
revoke all on public.message_templates, public.whatsapp_messages from anon, authenticated;
grant select, insert, update, delete on public.message_templates, public.whatsapp_messages to service_role;

create trigger message_templates_updated_at before update on public.message_templates
  for each row execute function public.voice_center_set_updated_at();

insert into public.message_templates (slug, name, when_to_use, body) values
  ('retorno',
   'Retorno / sem tempo agora',
   'Quando o paciente não pode falar agora e prefere receber por mensagem.',
   E'Olá, {nome}! Aqui é a Giovana, da Clínica Amor Saúde de Fernandópolis. 😊\nComo conversamos por telefone, estou passando para você ter o nosso contato. Quando for melhor para você, é só responder aqui que a gente continua.'),
  ('endereco',
   'Endereço da clínica',
   'Quando o paciente pedir o endereço ou como chegar.',
   E'{nome}, nosso endereço: Clínica Amor Saúde de Fernandópolis, Avenida dos Expedicionários Brasileiros, 706, Jardim América. Qualquer dúvida é só responder aqui! 😊');
