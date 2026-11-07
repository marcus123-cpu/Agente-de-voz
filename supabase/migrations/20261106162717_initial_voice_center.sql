-- Internal voice center. Browser access goes through the Express API only.
create table public.brains (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text not null default '',
  objective text not null default '',
  system_prompt text not null default '',
  elevenlabs_agent_id text,
  voice_name text,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null unique,
  do_not_contact boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_phone_e164 check (phone ~ '^[+][1-9][0-9]{7,14}$')
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  brain_id uuid not null references public.brains(id) on delete restrict,
  patient_name text not null,
  phone text not null,
  status text not null default 'connecting'
    check (status in ('idle','connecting','ringing','in_progress','completed','failed','busy','no_answer','canceled')),
  twilio_call_sid text unique,
  elevenlabs_conversation_id text unique,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  result text not null default 'unknown'
    check (result in ('interested','not_interested','callback','do_not_contact','unknown')),
  transfer_requested boolean not null default false,
  summary jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calls_phone_e164 check (phone ~ '^[+][1-9][0-9]{7,14}$')
);

create table public.call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index calls_created_at_idx on public.calls (created_at desc);
create index calls_brain_created_at_idx on public.calls (brain_id, created_at desc);
create index calls_phone_idx on public.calls (phone);
create index call_events_call_created_at_idx on public.call_events (call_id, created_at);

-- The API uses the service role. No anon/authenticated policy is granted.
alter table public.brains enable row level security;
alter table public.contacts enable row level security;
alter table public.calls enable row level security;
alter table public.call_events enable row level security;
revoke all on public.brains, public.contacts, public.calls, public.call_events from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on public.brains, public.contacts, public.calls, public.call_events to service_role;

create function public.voice_center_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.voice_center_set_updated_at() from public, anon, authenticated;
create trigger brains_updated_at before update on public.brains
  for each row execute function public.voice_center_set_updated_at();
create trigger contacts_updated_at before update on public.contacts
  for each row execute function public.voice_center_set_updated_at();
create trigger calls_updated_at before update on public.calls
  for each row execute function public.voice_center_set_updated_at();

insert into public.brains
  (name, slug, description, objective, system_prompt, elevenlabs_agent_id, voice_name, is_active)
values
  (
    'Captação de Pacientes',
    'patient-acquisition',
    'Agente responsável por entrar em contato com potenciais pacientes, apresentar a clínica, entender necessidades, esclarecer dúvidas permitidas e identificar interesse em agendamento.',
    'Conversar com novos pacientes e identificar interesse em agendamento.',
    $prompt$Você é Giovana, assistente virtual de atendimento da clínica. Sua função nesta conversa é realizar uma abordagem inicial de captação. Você está falando por telefone com {{patient_name}}.

Converse como uma atendente brasileira real: natural, simpática, profissional e cordial. Use frases curtas, faça pequenas pausas, não fale rápido demais e respeite interrupções. Não pareça ler um roteiro.

Primeiro confirme educadamente se está falando com {{patient_name}}. Depois se apresente e explique de forma simples o motivo do contato. Entenda se há interesse nos serviços da clínica, sem pressionar.

Não invente preços, horários, disponibilidade ou especialidades. Quando não souber alguma informação, diga que um atendente poderá confirmar. Nunca dê diagnóstico médico, recomende medicamentos ou afirme condições clínicas. Sua função é exclusivamente atendimento e captação.

Se o paciente demonstrar interesse claro em agendar, como “quero marcar”, “tem horário?” ou “tenho interesse”, diga naturalmente que chamará o responsável pelos agendamentos para verificar horários. Não confirme horário nem finja transferir a ligação se a transferência não estiver disponível. Não encerre abruptamente.

Se não houver interesse, encerre com educação, sem insistência. Se pedir para não receber novos contatos, respeite imediatamente.$prompt$,
    'agent_8301m6rv4enefz5b2j0bvshx6ppc',
    'Carla - Authority VSL',
    true
  )
on conflict (slug) do nothing;
