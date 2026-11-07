-- The browser webphone is the local telephony provider. Keep existing call rows.
alter table public.calls
  add column provider text not null default 'cvortex'
    check (provider = 'cvortex'),
  add column cvortex_call_id text unique;

-- Historical Twilio column is unused by the cVortex application.
alter table public.calls drop column twilio_call_sid;

create index calls_provider_cvortex_id_idx
  on public.calls (provider, cvortex_call_id)
  where cvortex_call_id is not null;
