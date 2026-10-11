-- 0005_classification: classify and extract job emails during sync.
-- Design: docs/plan/02-classification-extraction.md. Email bodies are never stored.

-- New processing states. Messages already imported as 'awaiting_classification' (headers only)
-- go back to 'discovered' so the next sync fetches and classifies them.
alter table app.source_messages drop constraint source_messages_state_check;
update app.source_messages
   set state = 'discovered', attempts = 0, next_attempt_at = now(), processed_at = null
 where state = 'awaiting_classification';
alter table app.source_messages add constraint source_messages_state_check check (state in (
  'discovered', 'retry', 'awaiting_match', 'irrelevant', 'duplicate', 'skipped_gone', 'failed'));

-- Kept ONLY for relevant emails. Subject, sender and snippet are encrypted (AES-256-GCM with a
-- key derived from TOKEN_ENCRYPTION_KEY, bound to the row); the domain is plain for grouping.
alter table app.source_messages
  add column duplicate_of_id     uuid references app.source_messages (id) on delete set null,
  add column sender_domain       text,
  add column sender_address_hash text,
  add column sender_enc          bytea,
  add column subject_enc         bytea,
  add column snippet_enc         bytea,
  add column classifier_version  integer,
  add column extractor_version   integer;

-- What the classifier decided, per version (rule ids only, no content).
create table app.message_classifications (
  id                uuid primary key,
  source_message_id uuid not null references app.source_messages (id) on delete cascade,
  user_id           uuid not null references app.users (id) on delete cascade,
  version           integer not null,
  category          text not null,
  confidence        real not null,
  needs_review      boolean not null,
  rule_hits         text[] not null default '{}',
  is_current        boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (source_message_id, version)
);
create unique index message_classifications_current_key on app.message_classifications (source_message_id) where is_current;
create index message_classifications_user_idx on app.message_classifications (user_id, category) where is_current;

-- Structured fields from relevant emails.
create table app.message_extractions (
  id                 uuid primary key,
  source_message_id  uuid not null references app.source_messages (id) on delete cascade,
  user_id            uuid not null references app.users (id) on delete cascade,
  version            integer not null,
  is_current         boolean not null default true,
  company_display    text,
  company_key        text,
  company_source     text,
  company_confidence real,
  role_title         text,
  role_key           text,
  role_confidence    real,
  employment_type    text not null default 'unknown',
  req_id             text,
  application_ref    text,
  job_posting_id     text,
  job_url            text,
  platform           text,
  event_at           timestamptz,
  deadline_at        timestamptz,
  event_source       text,
  created_at         timestamptz not null default now(),
  unique (source_message_id, version)
);
create unique index message_extractions_current_key on app.message_extractions (source_message_id) where is_current;
create index message_extractions_company_idx on app.message_extractions (user_id, company_key) where is_current;
