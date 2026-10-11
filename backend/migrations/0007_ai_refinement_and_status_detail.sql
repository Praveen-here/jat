-- 0007: two-phase classification (fast rules pass, then AI double-check in the background) and
-- specific statuses ("Shortlisted for assessment", "Assessment completed"…).

-- AI double-check queue: 'pending' = sorted by rules, waiting for the AI; 'done' = AI-checked.
alter table app.source_messages
  add column ai_state    text check (ai_state in ('pending', 'done')),
  add column ai_retry_at timestamptz;
create index source_messages_ai_pending_idx on app.source_messages (mail_account_id, ai_retry_at) where ai_state = 'pending';

-- What a shortlist was for ('assessment' | 'interview'), when the email says.
alter table app.message_extractions add column next_step text;
alter table app.application_events  add column detail text;

-- Human-readable status, e.g. "Shortlisted for interview", next to the broad stage.
alter table app.applications add column status_detail text;
