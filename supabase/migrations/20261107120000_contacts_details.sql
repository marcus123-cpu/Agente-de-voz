-- Contatos: origem e observações para a aba Contatos do painel.
alter table public.contacts
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'planilha', 'cartao_de_todos', 'ligacao')),
  add column if not exists notes text;

create index if not exists contacts_name_idx on public.contacts (lower(name));
create index if not exists calls_phone_idx on public.calls (phone);
