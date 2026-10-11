-- 0006_applications: group job emails into applications (docs/plan/03-matching-and-lifecycle.md).

alter table app.source_messages drop constraint source_messages_state_check;
alter table app.source_messages add constraint source_messages_state_check check (state in (
  'discovered', 'retry', 'awaiting_match', 'matched', 'irrelevant', 'duplicate', 'skipped_gone', 'failed'));

-- One row per application. Status is a projection of its events (recomputed, never edited by hand).
create table app.applications (
  id                uuid primary key,
  user_id           uuid not null references app.users (id) on delete cascade,
  company_display   text,
  company_key       text,
  role_title        text,
  role_key          text,
  employment_type   text not null default 'unknown',
  platform          text,
  -- 'auto': started by an application confirmation; 'inferred': first seen via a later stage.
  origin            text not null check (origin in ('auto', 'inferred')),
  status            text not null,
  status_event_id   uuid,
  status_conflict   boolean not null default false,
  needs_review      boolean not null default false,
  applied_at        timestamptz,
  first_seen_at     timestamptz not null,
  last_activity_at  timestamptz not null,
  next_event_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index applications_user_activity_idx on app.applications (user_id, last_activity_at desc);
create index applications_user_company_idx on app.applications (user_id, company_key);

-- Strong identifiers (requisition, application reference, job posting). A value belongs to one
-- application per user: two applications can't both claim the same ATS application id.
create table app.application_identifiers (
  user_id         uuid not null references app.users (id) on delete cascade,
  kind            text not null check (kind in ('req_id', 'application_ref', 'job_posting_id')),
  value           text not null,
  application_id  uuid not null references app.applications (id) on delete cascade,
  primary key (user_id, kind, value)
);
create index application_identifiers_app_idx on app.application_identifiers (application_id);

-- Which application each email belongs to, and how sure the matcher was.
create table app.message_application_links (
  source_message_id uuid primary key references app.source_messages (id) on delete cascade,
  application_id    uuid not null references app.applications (id) on delete cascade,
  user_id           uuid not null references app.users (id) on delete cascade,
  decision          text not null check (decision in ('identifier', 'confident', 'probable', 'ambiguous', 'new')),
  score             real not null,
  needs_review      boolean not null default false,
  created_at        timestamptz not null default now()
);
create index message_application_links_app_idx on app.message_application_links (application_id);

-- The timeline: one event per email (duplicates of the same event are absorbed by dedupe_key).
create table app.application_events (
  id                uuid primary key,
  application_id    uuid not null references app.applications (id) on delete cascade,
  user_id           uuid not null references app.users (id) on delete cascade,
  source_message_id uuid unique references app.source_messages (id) on delete cascade,
  event_type        text not null,
  occurred_at       timestamptz not null,
  scheduled_at      timestamptz,
  deadline_at       timestamptz,
  -- Probable/ambiguous matches: shown on the timeline, but don't change the status until confirmed.
  pending           boolean not null default false,
  dedupe_key        text not null,
  created_at        timestamptz not null default now(),
  unique (application_id, dedupe_key)
);
create index application_events_app_idx on app.application_events (application_id, occurred_at);
