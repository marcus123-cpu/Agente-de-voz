-- Caixa postal / URA detectada pela ElevenLabs passa a ter status próprio,
-- separado de falha técnica, para facilitar decidir quem precisa ser rediscado.
alter table public.calls drop constraint calls_status_check;
alter table public.calls add constraint calls_status_check
  check (status in ('idle','connecting','ringing','in_progress','completed','failed','busy','no_answer','canceled','voicemail'));
