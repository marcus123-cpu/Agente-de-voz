-- Registro + revisão: guarda a transcrição e a análise pós-ligação da ElevenLabs em cada chamada,
-- e sinaliza automaticamente as que tiveram algum problema (confusão, frustração, resultado de falha),
-- para revisão periódica sem precisar pedir pra olhar ligação por ligação.
alter table public.calls
  add column transcript jsonb,
  add column flagged boolean not null default false,
  add column flag_reason text;

create index calls_flagged_idx on public.calls (flagged, created_at desc) where flagged;
