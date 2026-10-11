# 10–11. Database Schema and REST API

Labels: [A] assumption · [D] decision.

**Conventions:**
- PostgreSQL 16 or later. `uuid` primary keys (v7, so they sort by time). `timestamptz` everywhere.
- Every user-owned table carries **`user_id`**, even where it could be derived. This allows tenant-scoped queries, cheap deletion and optional row-level security (RLS).
- `*_enc` columns are encrypted at the application level.
- `*_hash` columns are HMAC-SHA256 with a deployment pepper.
- Soft deletes only where undo or audit needs them. Everything else is hard-deleted.

---

## 10.1 ER diagram

```mermaid
erDiagram
  users ||--o{ auth_identities : has
  users ||--o{ sessions : has
  users ||--o{ mail_accounts : owns
  mail_accounts ||--|| mail_account_credentials : "secured by"
  mail_accounts ||--|| sync_states : "checkpoint/lease"
  mail_accounts ||--o{ sync_runs : runs
  mail_accounts ||--o{ source_messages : provides
  users ||--o{ source_messages : owns
  source_messages ||--o{ message_classifications : "classified as"
  source_messages ||--o{ message_extractions : "extracted to"
  source_messages ||--o{ message_application_links : "linked via"
  source_messages ||--o{ match_decisions : "decided by"
  users ||--o{ applications : owns
  applications ||--o{ message_application_links : groups
  applications ||--o{ application_events : "history"
  application_events }o--o| source_messages : "evidenced by"
  applications ||--o{ application_identifiers : "identified by"
  applications |o--o{ applications : "merged_into"
  users ||--o{ review_items : "asked to review"
  users ||--o{ user_corrections : made
  users ||--o{ user_rules : configures
  users ||--o{ user_aliases : configures
  users ||--o{ audit_log : "subject of"
  users ||--o{ deletion_requests : requests

  users { uuid id PK; citext primary_email; text display_name; text timezone; timestamptz age_confirmed_at; timestamptz deleted_at }
  auth_identities { uuid id PK; uuid user_id FK; text provider; text provider_subject; citext email }
  mail_accounts { uuid id PK; uuid user_id FK; text provider; text provider_subject; citext address; text status; text[] granted_scopes }
  sync_states { uuid mail_account_id PK; text checkpoint; text backfill_state; int lease_version; timestamptz next_sync_at }
  source_messages { uuid id PK; uuid user_id FK; uuid mail_account_id FK; text provider_message_id; text processing_state; text relevance }
  applications { uuid id PK; uuid user_id FK; text company_key; text role_key; text current_status; uuid status_event_id }
  application_events { uuid id PK; uuid application_id FK; text event_type; timestamptz occurred_at; uuid source_message_id FK; text dedupe_key }
  message_application_links { uuid id PK; uuid source_message_id FK; uuid application_id FK; text state; numeric score }
```

## 10.2 Tables

### Identity and sessions

**`users`**
- **Purpose:** the app account.
- **Columns:**
  - `id` (PK), `primary_email` citext, `display_name`.
  - `timezone` (default `Asia/Kolkata`).
  - `age_confirmed_at` (records the 18+ declaration).
  - `settings` jsonb: backfill window (default 6 months), stale days.
  - `last_active_at`, `created_at`, `deleted_at`.
- **Indexes:** `UNIQUE(primary_email) WHERE deleted_at IS NULL`.
- **Retention:** hard delete 30 days after a deletion request (grace period for undo). Disclosed.

**`auth_identities`**
- **Purpose:** login identities.
- **Columns:** `id`, `user_id` FK, `provider` ('google'), `provider_subject` (the `sub`), `email`, `created_at`, `last_login_at`.
- **Constraints:** `UNIQUE(provider, provider_subject)`.
- **Index:** `(user_id)`.
- **Retention:** deleted with the user.

**`sessions`**
- **Purpose:** server-side sessions.
- **Columns:** `id_hash` (PK, SHA-256 of the 256-bit cookie token), `user_id` FK, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `ip_prefix` (a /24, coarse), `user_agent_hash`, `revoked_at`.
- **Index:** `(user_id)`, and `(absolute_expires_at)` for the cleanup job.
- **Retention:** purge 7 days after expiry.

**`oauth_flows`**
- **Purpose:** one-time OAuth `state`.
- **Columns:** `state_hash` (PK), `session_id_hash`, `purpose` (`login` or `connect`), `pkce_verifier_enc`, `nonce`, `mail_account_id` (for reconnect), `expires_at`, `consumed_at`.
- **Retention:** purge after 1 day.

### Mail accounts and sync

**`mail_accounts`**
- **Purpose:** one connected mailbox.
- **Columns:**
  - `id`, `user_id` FK, `provider` ('gmail'), `provider_subject` (Google `sub` of the mailbox), `address` citext.
  - `status`: `connecting` | `backfilling` | `active` | `recovering` | `reauth_required` | `paused` | `error` | `disconnecting` | `deleted`.
  - `status_reason`, `granted_scopes` text[], `connected_at`, `disconnected_at`.
- **Constraints:** `UNIQUE(provider, provider_subject) WHERE status <> 'deleted'`. One mailbox belongs to one live user.
- **Index:** `(user_id)`.
- **Retention:** the row is kept as `deleted` (no PII except the address hash) for 30 days for audit, then purged.

**`mail_account_credentials`**
- **Purpose:** the encrypted refresh token, isolated from other data.
- **Columns:**
  - `mail_account_id` (PK, FK).
  - `refresh_token_enc` bytea, `dek_wrapped` bytea, `kek_key_id` text, `iv` bytea, `aad_version` int.
  - `obtained_at`, `last_refreshed_at`, `last_refresh_error`.
- **Access:** a separate DB role or grant. Only the token module reads it.
- **Retention:** deleted immediately on disconnect.

**`sync_states`**
- **Purpose:** checkpoint, lease and scheduling. One row per account.
- **Columns:**
  - `mail_account_id` (PK, FK).
  - `checkpoint` text (historyId), `checkpoint_numeric` numeric(20) (for monotonic comparison), `checkpoint_updated_at`.
  - `backfill_state` (`pending` | `enumerating` | `fetching` | `matching` | `done`), `backfill_window_start`, `backfill_completed_at`.
  - `last_success_at`, `last_attempt_at`, `consecutive_failures`, `next_sync_at`, `last_error_code`.
  - `lease_owner`, `lease_expires_at`, `lease_version` bigint.
  - `quota_tokens` numeric, `quota_refilled_at`.
  - `watch_expires_at` (phase 2).
- **Index:** `(next_sync_at)`, restricted to schedulable statuses.
- **Retention:** lifetime of the account.

**`sync_runs`**
- **Purpose:** progress and audit for each run.
- **Columns:**
  - `id`, `mail_account_id` FK, `user_id`.
  - `kind` (`backfill` | `incremental` | `gap_recovery` | `reprocess` | `extend_window`), `status` (`running` | `succeeded` | `failed` | `cancelled`).
  - `query_version`, `cursor` jsonb (`{family: pageToken}`), `window_start`, `window_end`.
  - `start_checkpoint`, `end_checkpoint`.
  - `counters` jsonb: listed, fetched, relevant, irrelevant, duplicate, failed, quota_units.
  - `error_code`, `started_at`, `finished_at`.
- **Index:** `(mail_account_id, started_at desc)`.
- **Retention:** 90 days. Only the latest backfill row per account is kept longer.

**`source_messages`**
- **Purpose:** the **message ledger**: idempotency plus provenance. **No bodies.**
- **Columns:**
  - `id`, `user_id`, `mail_account_id` FK, `provider_message_id`, `provider_thread_id`, `internal_date`.
  - `rfc822_message_id_hash`, `content_fingerprint`.
  - `processing_state` (`discovered` | `retry` | `fetched` | `awaiting_match` | `matched` | `irrelevant` | `duplicate` | `skipped_gone` | `failed` | `user_irrelevant`), `attempts`, `next_attempt_at`, `last_error_code`.
  - `relevance` (`relevant` | `irrelevant` | `needs_review`), `duplicate_of_id` FK (self).
  - Stored **only when relevant**: `sender_email`, `sender_domain`, `sender_display_name`, `subject_enc`, `evidence_snippet_enc` (≤300 chars), `is_forward`.
  - `discovered_by_run_id`, `classifier_version`, `extractor_version`.
- **Constraints:** `UNIQUE(mail_account_id, provider_message_id)`.
- **Indexes:**
  - `(mail_account_id, processing_state, next_attempt_at)`: the work queue.
  - `(user_id, rfc822_message_id_hash)` and `(user_id, content_fingerprint)`: cross-account deduplication.
  - `(user_id, processing_state, internal_date)`: the chronological match pass.
  - `(mail_account_id, provider_thread_id)`.
- **Retention:**
  - Irrelevant rows keep IDs and versions only and are **pruned when older than the backfill window plus 30 days**. Re-scans skip them by date anyway.
  - Relevant rows live as long as their application.

**`message_classifications`**
- **Purpose:** classifier output per version.
- **Columns:** `id`, `source_message_id` FK, `user_id`, `category`, `confidence`, `method` (`rules` | `llm` | `user`), `rule_hits` text[] (rule IDs only), `version`, `is_current`, `created_at`.
- **Constraints:** `UNIQUE(source_message_id, version, method)`, and a partial unique `(source_message_id) WHERE is_current`.
- **Retention:** with the message. Older versions are pruned after 90 days.

**`message_extractions`**
- **Purpose:** structured fields.
- **Columns:**
  - `id`, `source_message_id` FK, `user_id`, `version`, `is_current`.
  - `company_display`, `company_key`, `company_source`, `role_title`, `role_key`, `employment_type`.
  - `req_id`, `ats_application_id`, `job_posting_id`, `job_url_canonical`, `platform`.
  - `event_type`, `event_at`, `event_deadline`, `event_tz`, `event_details` jsonb (mode, duration, round, meeting host).
  - `field_confidence` jsonb, `evidence` jsonb (spans of ≤120 chars).
- **Constraint:** partial unique `(source_message_id) WHERE is_current`.
- **Index:** `(user_id, company_key)`.
- **Retention:** with the message.

### Applications

**`applications`**
- **Purpose:** one tracked application.
- **Columns:**
  - `id`, `user_id`.
  - `company_display`, `company_key`, `role_title`, `role_key`, `employment_type`, `location`, `platform`.
  - `origin` (`auto` | `inferred` | `manual`), `confidence`.
  - `applied_at`, `first_seen_at`, `last_activity_at`.
  - `current_status`, `status_event_id` FK, `status_pinned` bool, `status_conflict` bool, `needs_review` bool, `has_upcoming` bool, `next_upcoming_at`.
  - `merged_into_id` FK (self), `archived_at`, `deleted_at`, `row_version` (optimistic locking for edits).
- **Indexes:**
  - `(user_id, last_activity_at desc) WHERE merged_into_id IS NULL AND deleted_at IS NULL`.
  - `(user_id, current_status)`, `(user_id, company_key)`.
  - A GIN trigram index on `company_display || ' ' || role_title` for search.
- **Retention:** user-controlled. Deleted with the account, or by choice on disconnect.

**`application_identifiers`**
- **Purpose:** strong keys for matching and conflict detection.
- **Columns:** `id`, `user_id`, `application_id` FK, `kind` (`ats_application_id` | `req_id` | `job_posting_id` | `job_url` | `recruiter_email`), `value_hash` (HMAC of the normalised value; `req_id` is scoped by company_key), `source_message_id`, `created_by` (engine | user).
- **Constraint:** `UNIQUE(user_id, kind, value_hash)` for every kind except `recruiter_email`.
- **Index:** `(application_id)`.
- **Retention:** with the application.

**`identifier_aliases`**
- **Purpose:** user merges across conflicting IDs.
- **Columns:** `user_id`, `kind`, `value_hash`, `application_id`.
- **Primary key:** `(user_id, kind, value_hash)`.

**`message_application_links`**
- **Purpose:** which email belongs to which application.
- **Columns:** `id`, `user_id`, `source_message_id` FK, `application_id` FK, `state` (`auto` | `suggested` | `user_confirmed` | `user_rejected`), `score`, `engine_version`, `decided_at`.
- **Constraints:** `UNIQUE(source_message_id, application_id)`, plus a **partial unique** `(source_message_id) WHERE state IN ('auto','suggested','user_confirmed')`, so a message has at most one active application.
- **Index:** `(application_id)`.
- **Retention:** with the application.

**`application_events`**
- **Purpose:** the immutable history.
- **Columns:**
  - `id`, `user_id`, `application_id` FK.
  - `event_type`, `kind` (`stage` | `modifier` | `terminal` | `user`).
  - `occurred_at` (email date), `scheduled_at`, `deadline_at`, `details` jsonb (minimised).
  - `source_message_id` FK nullable (null means user-entered), `origin` (`rules` | `llm` | `user`), `confidence`.
  - `pending` bool, `removed_at`, `relates_to_event_id` FK (reschedule → original), `dedupe_key`, `created_at`.
- **Constraint:** `UNIQUE(application_id, dedupe_key)`.
- **Indexes:** `(application_id, occurred_at)`, and `(user_id, scheduled_at) WHERE scheduled_at > now()` for the upcoming list.
- **Retention:** with the application.

**`match_decisions`**
- **Purpose:** explainability and debugging.
- **Columns:** `id`, `user_id`, `source_message_id`, `engine_version`, `outcome`, `candidates` jsonb (top 5: application_id, score, feature contributions; **no text**), `created_at`.
- **Index:** `(source_message_id)`.
- **Retention:** 180 days.

### Review, corrections, rules, audit

**`review_items`**
- **Purpose:** the user's review inbox.
- **Columns:**
  - `id`, `user_id`.
  - `kind` (`probable_match` | `ambiguous_match` | `low_conf_classification` | `status_conflict` | `identifier_conflict` | `offer_confirmation` | `company_unknown`).
  - `source_message_id`, `application_id`, `payload` jsonb (candidate IDs, suggestion).
  - `state` (`open` | `resolved` | `dismissed`), `resolution` jsonb, `created_at`, `resolved_at`.
- **Constraint:** `UNIQUE(user_id, kind, source_message_id) WHERE state='open'`.
- **Index:** `(user_id, state, created_at)`.
- **Retention:** 90 days after resolution.

**`user_corrections`**
- **Purpose:** an undoable correction log.
- **Columns:** `id`, `user_id`, `action` (`merge` | `split` | `move` | `edit_field` | `set_status` | `confirm_link` | `reject_link` | `mark_irrelevant` | …), `target_type`, `target_id`, `before` jsonb, `after` jsonb, `undone_at`, `created_at`.
- **Index:** `(user_id, created_at desc)`.
- **Retention:** 1 year, or until account deletion.

**`user_rules`**
- **Purpose:** per-user personalisation.
- **Columns:** `id`, `user_id`, `kind` (`ignore_sender` | `ignore_domain` | `sender_company` | `always_track_sender`), `value`, `created_from_correction_id`.
- **Constraint:** `UNIQUE(user_id, kind, value)`.

**`user_aliases`**
- **Purpose:** company and role aliases learned from edits and merges.
- **Columns:** `user_id`, `kind` (`company` | `role`), `alias_key`, `canonical_key`.
- **Primary key:** `(user_id, kind, alias_key)`.

**`company_aliases_global`**
- **Purpose:** a curated public alias list. **Not user data.**
- **Columns:** `alias_key` (PK), `canonical_key`, `display`.

**`audit_log`**
- **Purpose:** a security and privacy trail. **No content.**
- **Columns:** `id`, `user_id`, `actor` (`user` | `system` | `admin`), `action` (`login`, `connect`, `disconnect`, `token_revoked`, `export`, `delete_request`, `admin_access`…), `target`, `ip_prefix`, `created_at`, `meta` jsonb (IDs and codes only).
- **Index:** `(user_id, created_at)`.
- **Retention:** 1 year (security need). User-identifying fields are pseudonymised after user deletion.

**`deletion_requests`**
- **Columns:** `id`, `user_id`, `scope` (`account` | `user`), `mail_account_id`, `state`, `requested_at`, `completed_at`, `verification` jsonb (per-table counts deleted).
- **Retention:** 1 year, as proof of erasure.

**`pgboss.*`**
- Job tables managed by pg-boss. Payloads hold **IDs only**. Completed jobs are archived for 7 days.

### Optional (phase 3): `notifications` / `reminders`

**Columns:** `id`, `user_id`, `application_id`, `event_id`, `channel`, `send_at`, `sent_at`, `dedupe_key` (unique).

### 10.3 Row-level security (defence in depth) [D]

- The repository layer **always** filters by `user_id` from the session. This is the primary control.
- Optionally enable Postgres RLS on user-owned tables with the policy `user_id = current_setting('app.user_id')::uuid`, set per transaction. Workers use a separate role that bypasses RLS but runs job-scoped code.
- Recommended from phase 6, once queries are stable.

---

## 11. REST API

**General conventions:**
- Base `/api/v1`. JSON. Requests are validated with zod.
- **Auth:** an `HttpOnly` session cookie, `__Host-sid`.
- **CSRF:** state-changing requests require a matching `Origin` header and an `X-CSRF-Token` (double-submit, tied to the session).
- **Errors:** `{ error: { code, message, details? } }`. Common codes:
  - `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404 (also used for other users' resources, so existence isn't leaked).
  - `VALIDATION_FAILED` 422, `CONFLICT` 409 (optimistic version), `RATE_LIMITED` 429.
- **Pagination:** cursor-based (`?cursor=…&limit=50`).

### Authentication and session

| Method & path | Purpose | Request → Response | Auth | Errors |
|---|---|---|---|---|
| `GET /auth/google/login` | Start sign-in | → 302 to Google (state, nonce, PKCE) | public, rate-limited | — |
| `GET /auth/google/callback` | Finish sign-in | `?code&state` → 302 to `/onboarding` or `/dashboard`; sets the cookie | public | `OAUTH_STATE_INVALID`, `OAUTH_DENIED`, `EMAIL_NOT_VERIFIED`, `AGE_CONFIRMATION_REQUIRED` |
| `GET /me` | Current user | → `{id, email, name, timezone, ageConfirmed, accounts:[…summary]}` | session | 401 |
| `POST /me/age-confirmation` | Record the 18+ declaration | `{confirmed:true}` → 204 | session | 422 |
| `POST /auth/logout` | End the session | → 204 | session + CSRF | — |
| `POST /auth/logout-all` | Revoke all sessions | → 204 | session + CSRF | — |

### Mail accounts

| Method & path | Purpose | Request → Response | Errors |
|---|---|---|---|
| `POST /mail-accounts/gmail/connect` | Start the connect flow | `{backfillMonths?:1..12}` → `{redirectUrl}` | `RATE_LIMITED`, `ACCOUNT_LIMIT_REACHED` (e.g. 5) |
| `GET /auth/google/mailbox/callback` | Finish connect | → 302 `/import/:accountId` | `SCOPE_NOT_GRANTED`, `NO_REFRESH_TOKEN`, `MAILBOX_LINKED_ELSEWHERE`, `OAUTH_STATE_INVALID` |
| `GET /mail-accounts` | List accounts | → `[{id, address, status, statusReason, lastSuccessAt, backfill:{state, windowStart, progress}, errorCode}]` | — |
| `POST /mail-accounts/:id/reconnect` | Re-authorise | → `{redirectUrl}` (login_hint set) | 404 |
| `DELETE /mail-accounts/:id` | Disconnect, revoke the token, and delete all data derived from this account (the only mode, decision Q4) | `{confirm:true}` → 202 `{deletionRequestId}` | 404, `ALREADY_DISCONNECTING` |
| `POST /mail-accounts/:id/pause` / `resume` | Pause or resume sync | → 204 | 404 |

### Sync

| Method & path | Purpose | Request → Response | Errors |
|---|---|---|---|
| `GET /mail-accounts/:id/sync` | Status and progress | → `{status, backfill:{state, listed, processed, relevant, applicationsFound, etaSeconds}, lastSuccessAt, nextSyncAt, lastErrorCode, failedMessages}` | 404 |
| `POST /mail-accounts/:id/sync` | "Sync now" | → 202 `{queued:true}` or 200 `{queued:false, reason:'recently_synced'\|'already_running'}` | `RATE_LIMITED`, `REAUTH_REQUIRED` |
| `POST /mail-accounts/:id/extend-window` | Import older email | `{months: 1..12}` → 202 | `WINDOW_TOO_LARGE`, `SYNC_IN_PROGRESS` |
| `POST /mail-accounts/:id/retry-failed` | Re-queue failed messages | → 202 `{count}` | — |
| `GET /sync/events` *(optional)* | Server-sent events for progress | SSE stream of progress ticks for the user's accounts | — |

### Applications

| Method & path | Purpose | Request → Response | Errors |
|---|---|---|---|
| `GET /applications` | List, search, filter, sort | Query: `q, status[], type[], accountId[], platform[], appliedFrom, appliedTo, needsReview, stale, sort=(lastActivity\|appliedAt\|company)&order, cursor, limit` → `{items:[{id, company, role, employmentType, status, appliedAt, lastActivityAt, platform, origin, needsReview, hasUpcoming, nextUpcomingAt, sourceAccounts:[…]}], nextCursor, counts:{byStatus}}` | 422 |
| `GET /applications/:id` | Details and timeline | → `{application, events:[{id, type, occurredAt, scheduledAt, pending, origin, confidence, source:{messageId, account, sender, subject, snippet, gmailUrl}}], identifiers:[{kind, display}], reviewItems:[…]}` | 404 |
| `POST /applications` | Add manually | `{company, role, employmentType?, appliedAt?, status?}` → 201 | 422 |
| `PATCH /applications/:id` | Edit fields | `{company?, role?, employmentType?, location?, rowVersion}` → 200 | 409, 422 |
| `POST /applications/:id/status` | Set status manually | `{status, pin?:bool, note?}` → 200 | 422 |
| `POST /applications/:id/merge` | Merge others into this one | `{sourceIds:[…], rowVersion}` → 200 `{application, correctionId}` | 409, `CANNOT_MERGE_SELF` |
| `POST /applications/:id/split` | Split emails into a new application | `{sourceMessageIds:[…], newFields?}` → 201 `{newApplicationId, correctionId}` | 422 (empty or all messages) |
| `POST /source-messages/:id/move` | Move an email to an application | `{applicationId \| 'new'}` → 200 | 404 |
| `POST /source-messages/:id/not-job` | Mark irrelevant | `{ignoreSender?:bool}` → 200 | 404 |
| `DELETE /applications/:id` | Delete an application | → 204 (sources marked `user_irrelevant` so they don't come back) | 404 |
| `POST /corrections/:id/undo` | Undo a correction | → 200 | `UNDO_EXPIRED`, `UNDO_CONFLICT` |
| `GET /recruiting-emails` | Unlinked recruiting emails | → list with "Track this" | — |

### Review inbox

| Method & path | Purpose | Request → Response |
|---|---|---|
| `GET /review-items?state=open` | List | → `[{id, kind, message:{sender, subject, snippet, gmailUrl, date}, suggestion, candidates:[{applicationId, company, role, status, score}]}]` |
| `POST /review-items/:id/resolve` | Resolve | `{action:'confirm'\|'choose'\|'new_application'\|'not_job'\|'dismiss', applicationId?, category?}` → 200 |

### Privacy and settings

| Method & path | Purpose | Request → Response |
|---|---|---|
| `GET /settings` / `PATCH /settings` | Timezone, default window, stale days | — |
| `GET /privacy/export` | Export my data as JSON (DPDP right of access) | → 202, then a download link valid for 24 hours |
| `DELETE /me` | Delete my account | `{confirm:"DELETE"}` → 202 `{deletionRequestId}` (signs out) |
| `GET /privacy/deletion-requests/:id` | Deletion status | → `{state, completedAt}` |

### Internal (phase 2)

`POST /webhooks/gmail`: Pub/Sub push.
- **Auth:** an OIDC JWT, checked for issuer, audience and service account.
- **Response:** 204, always fast.
- Unknown addresses are ignored.

## 11.1 Who does what

| Concern | API server | Worker | DB |
|---|---|---|---|
| OAuth redirects, code exchange, token encryption at connect | ✔ | | stores ciphertext |
| Token refresh, all Gmail calls | | ✔ | |
| Queueing jobs | ✔ (transactional insert into pg-boss) | ✔ (self-chaining) | queue tables |
| Classification and extraction | | ✔ (pure modules) | results |
| Matching and status projection | ✔ for user corrections (merge/split/move run under the same per-user lock and code path) | ✔ for automatic matches | constraints enforce idempotency |
| Dashboard reads | ✔ (projections only, no Gmail calls) | | indexes |
| Deletion | ✔ marks the request | ✔ executes and verifies | |
