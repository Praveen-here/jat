# Job Application Tracker — Engineering Plan

**Version:** 0.2 (planning) · **Date:** 2026-10-11 · **Status:** decisions recorded, awaiting the go-ahead to implement.

## Decisions made (2026-10-11)

| # | Question | Decision | Effect on the plan |
|---|---|---|---|
| Q1 | Launch target | **Personal use only.** The owner is the only user, for now. | OAuth app stays in **Testing mode** with the owner as the single test user. This falls under Google's personal-use and testing exemptions, so no verification and no CASA [F]. Refresh tokens still expire every **7 days** [F], so expect a weekly "Reconnect". Multi-user features (isolation, rate limits) are still built correctly, but hardening for the public is deferred. |
| Q2 | LLM fallback | **Changed 2026-10-11: AI on, via the Groq free tier** (`openai/gpt-oss-120b`, Zero Data Retention on). Rules-only proved inaccurate on the real inbox. | Rules filter first (security, alerts and newsletters never reach the AI). AI classifies and extracts the rest with a strict JSON schema. Answers must be quoted from the email. Rules and AI disagreeing → review. Rate limits defer, never drop. Details in [02 §7.9 notes](02-classification-extraction.md). |
| Q3 | Import window | **6 months** | Default `backfillMonths = 6`. "Import older emails" stays available. |
| Q4 | On disconnect or account deletion | **Delete everything.** | One deletion mode only: all data derived from that account is removed (messages ledger, extractions, links, events, applications sourced only from it), and the Google token is revoked. The "keep applications" option is removed. We **never** touch the emails in Gmail itself. |
| Q5 | Budget | **$0, free tiers only.** | Develop locally first. Deploy later on free tiers (Vercel + Supabase + Cloud Run + Cloud Scheduler). Cloud KMS is replaced by a master key in the environment or Secret Manager. See §15.4. |
| Stack | Framework | **Next.js for both, in two folders** | `frontend/` is a Next.js UI app (port 3000). `backend/` is a Next.js app serving API routes only (port 4000), plus a separate worker script for background sync. Express is not used. The frontend proxies `/api/*` to the backend. |
| UI | Visual style | **Flat, light theme, Notion-like structure, styled after patina.md** | Warm off-white, Manrope font, pastel status pills, almost no shadows. Tokens and layout are in [05-frontend.md §12.0](05-frontend.md). |

The core of this product is four engines. Most of the planning effort went into them:

1. **Synchronization**: getting every relevant email reliably, exactly once, within Gmail quotas.
2. **Classification**: deciding which emails are about a real application, and what kind of event each one is.
3. **Extraction**: pulling out the correct employer, role, identifiers and dates.
4. **Matching**: grouping emails into the right application without wrongly merging different ones.

## Document map

| # | Deliverable | File |
|---|---|---|
| 1–4 | Executive summary, requirements, architecture, decision records | this file |
| 5–6 | OAuth/Gmail integration, initial and incremental sync algorithms | [01-oauth-and-sync.md](01-oauth-and-sync.md) |
| 7 | Email classification and extraction | [02-classification-extraction.md](02-classification-extraction.md) |
| 8–9 | Application matching engine, status and event lifecycle | [03-matching-and-lifecycle.md](03-matching-and-lifecycle.md) |
| 10–11 | Database schema, ER diagram, REST API | [04-data-model-and-api.md](04-data-model-and-api.md) |
| 12 | Frontend screens and components | [05-frontend.md](05-frontend.md) |
| 13–15 | Threat model and privacy, testing and metrics, deployment and costs | [06-security-testing-deployment.md](06-security-testing-deployment.md) |
| 16–17 | Roadmap, risks, first five tasks | this file |

**Labels used throughout:**
- **[F]** Fact checked against official Google documentation on 2026-10-11. Sources are listed at the end of this file.
- **[F-ref]** Fact from the API reference that was not re-checked in this session. Re-verify it before relying on it.
- **[A]** Assumption to be validated.
- **[D]** Decision or recommendation.

---

## 1. Executive summary

**Product.** A dashboard that tracks a job seeker's applications automatically from their Gmail. It covers confirmations, assessments, interviews, offers and rejections, merged across several connected Gmail accounts.

**What makes it hard, in order of difficulty:**

1. **Matching.** One company can have several applications from the same user. Gmail threads can mix two roles together. Assessment vendors often don't name the role. A wrong merge corrupts the user's history without them noticing, which is worse than a missed email.
2. **Classification precision.** Most job-related email is job alerts, newsletters and recruiter marketing. Recording an alert as an application destroys user trust immediately.
3. **Sync correctness under constraints.**
   - The per-user quota is about 300 full message fetches per minute [F].
   - History checkpoints can expire, sometimes within hours [F].
   - Push notifications can be dropped [F].
   - Tokens can be revoked at any time [F].
4. **Compliance.** `gmail.readonly` is a **restricted** scope [F]. A public launch needs Google verification and an **annual** CASA security assessment by an approved assessor [F]. This is the main obstacle to a real public launch, and the plan accounts for it explicitly.

**Headline recommendations [D]:**

- **Architecture.** A modular monolith in one TypeScript codebase:
  - Next.js web app.
  - Express API process.
  - Worker process.
  - PostgreSQL as both the database and the job queue (pg-boss).
  - No Redis, Kafka or microservices.
- **Processing model.** Server-side processing (option A) with strict data minimisation:
  - Email bodies are processed in memory and **never stored**.
  - Gmail remains the source of truth.
  - We store only structured records, short evidence snippets and Gmail message IDs for "Open in Gmail" links.
- **Scopes.**
  - Sign-in: `openid email profile` only.
  - Mailbox connection, as a separate step: `gmail.readonly`.
  - `gmail.metadata` gives no compliance benefit. It is also restricted [F], it can't read bodies, and it can't use search queries [F-ref].
- **Sync.**
  - A bounded backfill (default 6 months) in two phases: list candidate IDs first, then fetch and extract.
  - Incremental sync after that, using `history.list` checkpoints.
  - Polling in the MVP. Gmail push via Pub/Sub comes later, and polling stays on as a safety net.
- **Classification and extraction.**
  - Deterministic rules plus a curated sender/template registry.
  - The system abstains and asks the user when evidence is weak.
  - An LLM fallback for ambiguous emails is optional, off by default, and only added after the rules baseline has been measured.
- **Matching.** Deterministic, explainable scoring:
  - Hard vetoes prevent wrong merges, for example two different requisition IDs.
  - A margin rule means the system asks the user when two candidates score close together.
  - Decisions made by the user are never overridden automatically.
- **Status.** The current status is a **projection of an immutable event log**, sorted by email date. It is therefore order-independent and can be recomputed at any time. Every status change links back to its source email.
- **Policy constraint that shapes the ML roadmap [F].** Google's Workspace API user-data policy forbids using user data to create, train or improve AI/ML models, except a model personalised to that one user. So we **cannot train a global classifier on users' emails or corrections**. Quality improvements must come from a synthetic corpus and from mailboxes donated with explicit consent.

**MVP in scope:**
- Google sign-in.
- Connecting one or more Gmail accounts.
- Bounded backfill, followed by incremental polling sync.
- Rules-based classification and extraction.
- The matching engine, with a review queue.
- An event timeline per application.
- The dashboard, with search, filters and sorting.
- Corrections, including merging and splitting applications.
- Sync status and recovery screens.
- Disconnecting accounts and deleting data.

**Out of scope for the MVP:**
- Other email providers.
- Push sync (planned for phase 2).
- LLM fallback (phase 2, behind a feature flag).
- Reminders and notifications.
- Detecting applications from the user's own **sent** emails.
- Attachment parsing.
- Mobile apps.

---

## 2. Requirements, assumptions, unresolved questions

### 2.1 Assumptions [A]

| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | A typical user has 1–3 Gmail accounts and receives 30–150 emails a day per account. | Sync cost and backfill time. |
| A2 | A 6-month backfill window covers one placement or recruiting cycle. Users can extend it to 12 months. | Recall of older applications. |
| A3 | Candidate search queries find at least 95% of real application emails in the window. | Recall. This is measured with consented donor mailboxes (see §14). |
| A4 | Users are 18 or older. | Users under 18 would require verifiable parental consent under India's DPDP law. MVP: restrict to 18+. |
| A5 | Users accept polling freshness: new emails appear within about 10–20 minutes while they are active. | Push sync would need to move earlier. |
| A6 | The beta runs in OAuth "Testing" mode with at most 100 test users. Refresh tokens expire after 7 days in this mode [F], so beta users reconnect weekly. | Beta experience. |
| A7 | No human at the company reads user email content. All debugging uses metadata and structured records. | Google policy compliance. |
| A8 | Messages in Spam, Trash, Drafts, Sent and Chats are excluded in the MVP. | Some recruiting emails land in Spam. Opt-in Spam scanning comes later. |

### 2.2 Questions for you (they change the plan)

> **Answered 2026-10-11.** See "Decisions made" at the top of this file. The original questions are kept below for the record.

1. **Launch target.** Is this a portfolio or private beta (Testing mode, at most 100 users, no CASA), or a public product (verification plus an annual CASA assessment, which costs money and takes weeks)? The plan supports both. The roadmap assumes a beta first.
2. **LLM fallback.** Is a third-party LLM processing trimmed email text acceptable to you, given the extra disclosure and policy surface? It is off by default in this plan.
3. **Default backfill window.** 6 months or 12 months?
4. **On disconnect**, the default is to delete that account's derived data. Do you prefer "keep my applications"?
5. **Budget ceiling** per month for the beta, which decides between free tiers and paid hosting.

### 2.3 Challenges to the original brief

- **The "Unknown" status.** Make it a `Detected` status plus a `needs_review` flag. "Unknown" doesn't tell users anything useful. See §9.
- **The "Closed" status.** Never set it automatically just because time has passed. Show a derived **Stale** flag instead (no activity for N days), so every status stays traceable to an email.
- **"Real-time".** Polling gives minutes of delay. Push gives about a minute, usually, but Google can drop notifications [F]. The UI should say "Last synced 4 min ago", not "live".
- **Learning from user corrections.** This can personalise one user's experience, for example "always ignore this sender". It cannot train a shared model, per Google's policy [F].

---

## 3. Functional and non-functional requirements

### 3.1 Functional

| ID | Requirement |
|---|---|
| FR-1 | Sign in with Google (OIDC) without requesting mailbox access. |
| FR-2 | Connect a Gmail account through a separate consent. A user can connect several accounts. Each mailbox can be linked to only one app user at a time. |
| FR-3 | Per connected account, track: status, checkpoint, backfill progress, last successful sync, errors and retry state. |
| FR-4 | Bounded historical import, with a configurable window and visible progress. |
| FR-5 | Automatic incremental sync, plus a "Sync now" button with debouncing. |
| FR-6 | Classify emails into the category set in §7. Never create an application from a job alert or marketing email. |
| FR-7 | Extract employer, role, employment type, IDs, URL, platform, event type and event time, each with a confidence score. |
| FR-8 | Group emails into applications with confidence levels: confident, probable (needs review), ambiguous (needs review), new, or unrelated. |
| FR-9 | Keep a current status and an immutable event history. Each automatic change is traceable to a source email. |
| FR-10 | Dashboard: search, filter (status, type, account, platform, date range), sort (last activity, applied date, company), and a detail timeline. |
| FR-11 | User corrections: edit fields, change status, mark "not a job email", move an email, merge applications, split an application, undo. |
| FR-12 | A review inbox for low-confidence decisions. |
| FR-13 | Disconnect an account: revoke the token and delete or keep that account's data. Delete the whole user account. |
| FR-14 | Sync error screen with specific recovery steps: reconnect, retry, or contact support. |

### 3.2 Non-functional

| Area | Target |
|---|---|
| Security | OWASP ASVS L2 as the baseline. Tokens encrypted with envelope encryption. No email content in logs. |
| Privacy | Bodies are never persisted. Irrelevant emails leave only an ID plus processing state. Retention rules are in §11 and §13. |
| Freshness (MVP, polling) | New relevant email reflected within 20 minutes at p95 for users active in the last 7 days. |
| Freshness (phase 2, push) | Usually within 2 minutes. Not guaranteed. |
| Backfill | Typical mailbox (about 1,000 candidate emails) finishes in under 10 minutes. Partial results are visible within 1 minute. |
| Reliability | At least 99% of scheduled syncs succeed, excluding token revocations. No email is lost after a crash: work resumes from the checkpoint. |
| Correctness | Applications created from job alerts: at most 1%. Wrong merges (pairwise matching precision): at least 98%. False automatic offer or rejection: at most 0.5%. See §14. |
| Performance | Dashboard API p95 under 300 ms for a user with 500 applications. |
| Accessibility | WCAG 2.1 AA, keyboard-navigable, screen-reader-labelled status chips (not colour-only). |
| Extensibility | A new provider (for example Outlook via Microsoft Graph delta queries) is added by implementing one `MailProvider` adapter. |

---

## 4. Recommended architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Next.js app<br/>React + TS + Tailwind]
  end
  subgraph Edge["Next.js server (same origin)"]
    RW[/rewrites /api/* → API/]
  end
  subgraph Backend["Modular monolith — one TS codebase, two processes"]
    API[API process<br/>Express: auth, sessions,<br/>REST, OAuth callbacks]
    WK[Worker process<br/>pg-boss consumers + cron]
    subgraph Modules
      AUTH[auth / sessions]
      ACC[accounts + token vault]
      SYNC[sync engine]
      PROV[MailProvider<br/>GmailProvider | FakeProvider]
      CLS[classifier + extractor]
      MATCH[matching engine]
      APPS[applications + events<br/>status projection]
      PRIV[privacy: deletion, export]
    end
  end
  PG[(PostgreSQL<br/>data + pg-boss queue)]
  KMS[[Cloud KMS<br/>key-encryption key]]
  G[(Google OAuth + Gmail API)]
  PS[[Pub/Sub — phase 2]]
  LLM[[LLM API — optional, phase 2]]

  UI --> RW --> API
  API --> AUTH & ACC & APPS & PRIV
  WK --> SYNC --> PROV --> G
  SYNC --> CLS --> MATCH --> APPS
  CLS -.ambiguous only.-> LLM
  ACC --> KMS
  API & WK --> PG
  G -.watch notifications.-> PS -.push.-> API
```

### 4.1 Responsibilities

| Component | Owns | Never does |
|---|---|---|
| **API process** | OAuth redirects and callbacks; sessions; REST endpoints; queueing jobs; reading projections for the dashboard. | Calls Gmail for message data. Long-running work. |
| **Worker process** | Every Gmail call; sync, classification, extraction and matching jobs; scheduling; deletion jobs. | Serves HTTP to users. It may expose a health endpoint. |
| **MailProvider** | Provider-neutral interface: profile, list candidates, fetch messages, get changes since a checkpoint, revoke, watch. | Classification. Database writes. |
| **Sync engine** | Leases, checkpoints, the message ledger, pacing, retries, recovery from expired checkpoints. | Business interpretation of emails. |
| **Classifier and extractor** | Pure functions: normalised email in, category and fields with evidence out. Versioned. | I/O. Deterministic, so easy to test. |
| **Matching engine** | Candidate selection, scoring, vetoes, decisions, review items. | Rewrites links the user has decided. |
| **Applications module** | Event log, status projection, identifiers, merge and split, corrections. | Sync logic. |
| **PostgreSQL** | System of record and job queue (pg-boss uses `SKIP LOCKED`). | Stores email bodies. |

### 4.2 Provider abstraction (sketch, not implementation)

```ts
interface MailProvider {
  kind: 'gmail';                                   // later: 'outlook'
  getProfile(acct): Promise<{ address: string; checkpoint: string }>;
  listCandidateIds(acct, query: CandidateQuery, pageToken?): Promise<{ ids: ProviderMsgRef[]; nextPageToken?: string }>;
  getMessages(acct, ids: string[], detail: 'headers' | 'full'): Promise<Array<NormalizedMessage | MessageGone>>;
  getChangesSince(acct, checkpoint: string, pageToken?): Promise<ChangesPage | CheckpointExpired>;
  compareCheckpoints(a: string, b: string): -1 | 0 | 1;   // Gmail: numeric compare of historyId
  revoke(acct): Promise<void>;
  watch?(acct): Promise<{ expiresAt: Date }>;               // optional capability
}
```

`NormalizedMessage` contains provider IDs, the RFC 5322 `Message-ID`, `In-Reply-To` and `References`, sender, recipients, subject, date, provider-neutral flags (spam, sent, draft, promotions-like, bulk), the text body, links, calendar parts, and attachment *metadata* only. Checkpoints are stored as opaque text, so Outlook's delta links fit the same column later.

### 4.3 Decision records

Each record states the choice, the alternatives, why, the risks, and how to validate it.

| # | Decision [D] | Alternatives | Why | Risks / limits | Validation |
|---|---|---|---|---|---|
| D1 | **Modular monolith**: API and worker are two entry points of one codebase. | Microservices; serverless functions. | One deploy and one schema. Module boundaries are enforced by folders and lint rules. The worker needs long-lived, paced jobs, which serverless handles poorly. | Modules can couple over time. | Import-boundary lint rule. Load test of the worker. |
| D2 | **PostgreSQL + pg-boss** for queue and cron. | Redis + BullMQ; SQS; Kafka. | The workload is tiny (thousands of jobs a day). Transactional enqueue in the same database gives exactly-once *effects* together with the ledger. One less service. | Throughput ceiling far above our needs. Polling load on the database. | Benchmark 50 jobs/s on the smallest database tier. |
| D3 | **Server-side processing (option A)** with minimisation. | Client-side processing (option B). | Background sync needs offline refresh tokens. Option B can't sync while the browser is closed, and handles multiple devices poorly. See §13.3. | CASA is required. Server breach risk. | Threat model review. CASA readiness checklist. |
| D4 | **`gmail.readonly`** for the mailbox; login uses basic scopes only. | `gmail.metadata` (also restricted, no bodies, no `q` search); `gmail.modify` (unneeded write access). | Least privilege that still allows body extraction and search. | Restricted scope means verification plus annual CASA [F]. | Google's verification review. |
| D5 | **Polling first, push in phase 2**, with polling kept as a safety net. | Push only. | Push needs Pub/Sub, a public webhook, and daily `watch` renewal [F]. Notifications can be dropped [F], so polling is needed anyway. | Minutes of delay in the MVP. | Freshness metric (p95). |
| D6 | **Bounded backfill** (6 months by default) using **candidate queries**, in two phases. | Scanning the whole mailbox. | Quota: 20 units per fetch, 6,000 per minute per user [F]. Privacy. Speed. | Recall depends on the queries. | Recall audit against full-scan labels on donor mailboxes. |
| D7 | **Hybrid classification**: rules and registry first, abstain to review, LLM optional. | Pure regex; a trained classifier; LLM for every email. | Precision, explainability, cost and privacy. No training data allowed from users [F]. | Long tail of templates. | Precision and recall on the labelled corpus (§14). |
| D8 | **Deterministic matching scores with vetoes and margins.** | Machine learning; LLM matching. | Explainable, and works without training data. Vetoes prevent catastrophic merges. | Weights need hand tuning. | Pairwise precision and recall, measured as B-cubed F1 on clustered ground truth. |
| D9 | **Status as a projection of the event log.** | Mutable status updated with each email. | Order-independent, replayable and traceable. Corrections are just events. | Recompute cost (trivial at about 50 events per application). | Property tests: shuffling event order gives the same status. |
| D10 | **Next.js route handlers (backend app) + Kysely + SQL migrations + zod.** Express was replaced at the owner's request (2026-10-11). | Express; Prisma; NestJS. | One framework for both apps. A SQL-first query builder handles partial indexes, advisory locks and `FOR UPDATE` cleanly. | Next.js can't run timed jobs, so the worker stays a separate Node process. | — |
| D11 | **No stored email bodies.** Store a ≤300-character evidence snippet only for relevant emails. Re-fetch from Gmail when reprocessing. | Store raw messages. | Minimisation, smaller breach impact, easier CASA. | Reprocessing costs quota: 20 units per message. | Cost model in §15. |

---

## 16. Phased roadmap

Each phase ends with a demonstrable result. Durations assume one developer working part-time, about 15 hours a week.

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **0. Foundations** (1 wk) | Repo, TypeScript config, lint boundaries, Postgres in Docker, migrations, pg-boss, config and secrets, logging with redaction, CI. Google Cloud project and OAuth consent screen in Testing mode. | `pnpm dev` starts web, API and worker. CI is green. A log-redaction unit test passes. |
| **1. Identity and accounts** (2 wks) | Google sign-in (code + PKCE + state + nonce), server sessions, Gmail connect flow, granted-scope check, encrypted token vault, multiple accounts, disconnect with revocation. | Two Gmail accounts connected for one user. Tokens are encrypted at rest. Revoking access at myaccount.google.com produces `reauth_required` within one sync cycle. |
| **2. Sync engine** (3 wks) | `GmailProvider` and `FakeGmailProvider`, message ledger, leases, two-phase backfill, incremental history sync, recovery from expired checkpoints, pacing, retries, progress API. | Fault-injection suite passes: 429s, 5xx, history 404, crash mid-page, concurrent triggers, mail arriving during backfill. Zero lost or duplicated ledger rows. |
| **3. Classification and extraction** (3 wks) | Normalisation and sanitisation, sender registry v1, rules, extractors, evaluation harness, synthetic corpus v1 (500 or more labelled emails). | On the corpus: job-related precision ≥ 0.95 and recall ≥ 0.90. Alert→application false positives ≤ 2%. Company accuracy ≥ 0.90. |
| **4. Matching and lifecycle** (3 wks) | Candidate selection, scoring, vetoes, decisions, review items, events, status projection, identifiers, cross-account deduplication. | Pairwise matching precision ≥ 0.97 on the corpus clusters. Duplicate application rate ≤ 2%. Order-shuffle property tests pass. |
| **5. Product UI** (3 wks) | Onboarding, import progress, dashboard, details timeline, review inbox, corrections, merge and split, settings, deletion. | End-to-end test: sign in → connect → import → review → correct → disconnect and delete. Accessibility audit passes. |
| **6. Hardening and personal deployment** (2 wks) | Rate limits, security headers, CSRF, audit log, data-deletion verification, monitoring and alerts, backups. Deploy on free tiers (§15.4). The owner uses it daily as the only user. | Security checklist complete. Deletion verified across tables. Sync runs unattended for 2 weeks (apart from the weekly Testing-mode reconnect). |
| **7. Phase-2 features** | Pub/Sub push; opt-in Spam scanning; reminders. **Deferred until requested:** LLM fallback; inviting other users; verification and CASA for a public launch. | Push freshness p95 under 2 minutes. |
| **Later** | Outlook adapter, detection from sent mail, attachment parsing, mobile. | — |

---

## 17. Major risks, alternatives, decisions needing validation

| Risk | Likelihood / impact | Mitigation | Validate by |
|---|---|---|---|
| **Restricted-scope verification and CASA** block a public launch (cost and time) | High / High | Stay in Testing mode for the beta. Build the evidence CASA needs from day one: SAST in CI, dependency scanning, encryption, deletion, access controls. Get assessor quotes early. | Assessor quote; CASA self-assessment questionnaire dry-run. |
| **Testing-mode refresh tokens expire after 7 days** [F] | Certain in beta / Medium | Clear "Reconnect" call to action. Treat reconnects as a gap recovery (§6.5). | Beta feedback. |
| **Wrong merges** between applications at the same company | Medium / High | Vetoes, margin rule, review queue, the "prefer under-merge" principle, easy merge in the UI. | Matching precision on the corpus. Review rate in beta. |
| **Job alerts counted as applications** | Medium / High | Bulk-mail signals, alert-sender registry, a rule that confirmations need past-tense evidence, abstaining. | False-positive rate on the corpus. |
| **Candidate queries miss emails** (recall) | Medium / Medium | Several query families, plus registry domains, plus calendar invites. Incremental sync checks headers on *all* new emails, not just query matches. | Recall audit against full scan on donor mailboxes. |
| **History checkpoint expiry** (can happen within hours [F]) | Low–Medium / Medium | Bounded gap recovery from the last successful sync time. | Fault-injection test. |
| **Template drift** (ATS vendors change their emails) | Certain / Medium | Versioned registry, per-rule hit-rate monitoring (aggregate counts only), alert on sudden drops. | Dashboard of rule hit-rates. |
| **Training on user data prohibited** [F] | Certain / Medium | Synthetic corpus and consented donors. Per-user personalisation only. | Policy review before any ML work. |
| **ReDoS or malicious HTML** | Medium / Medium | RE2 regex engine, size caps, never render email HTML, parse with a strict parser. | Fuzz tests. |
| **DPDP obligations phase in by about May 2027** | Certain / Medium | Notice and consent, rights endpoints, breach process, 18+ gating, grievance contact. | Legal review before public launch. |
| **Scope creep** (Outlook, AI everything) | High / Medium | Provider interface now, implementation later. LLM behind a flag. | Roadmap discipline. |

---

## First five implementation tasks (in dependency order)

1. **Foundations.** Monorepo (`apps/web`, `apps/server` with `api` and `worker` entry points, `packages/core`). Postgres via Docker. SQL migrations. pg-boss. Typed config with secrets from the environment. pino logger with a **redaction allowlist**. CI running lint, typecheck and tests.
2. **Google sign-in and sessions.** Authorization code + PKCE + state + nonce. ID token verification. `users` and `auth_identities`. Server-side sessions in a `__Host-` cookie. CSRF and Origin checks.
3. **Gmail connection and token vault.**
   - Separate consent flow for `gmail.readonly`, with a granted-scope check.
   - `mail_accounts` and an encrypted `mail_account_credentials` table (envelope encryption, AAD bound to the account).
   - Disconnect with revocation.
   - The `MailProvider` interface, with a `GmailProvider` and a **`FakeGmailProvider` with fault injection**.
4. **Sync engine.**
   - `sync_states` (lease, fencing token, checkpoint), `sync_runs`, and the `source_messages` ledger.
   - Two-phase backfill, incremental history sync, gap recovery, pacing and retries.
   - Fully tested against the fake provider before any classifier exists. The ledger is the deliverable.
5. **Corpus, evaluation harness and rules v1.**
   - A synthetic labelled corpus with category, fields and an application cluster label for each email.
   - An evaluation command that prints precision, recall and accuracy.
   - Normalisation, sanitisation, sender registry v1, rule-based classifier and extractors.
   - Matching (phase 4) builds on this corpus.

---

## Sources (checked 2026-10-11)

- Gmail synchronization guide: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail usage limits (quota units): https://developers.google.com/workspace/gmail/api/reference/quota
- Gmail push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail API scopes and sensitivity: https://developers.google.com/workspace/gmail/api/auth/scopes
- Restricted scope verification and CASA: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Google Workspace API user data policy (Limited Use, AI/ML training): https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- OAuth 2.0 overview (refresh token expiry rules): https://developers.google.com/identity/protocols/oauth2
- DPDP Rules 2025 timeline (secondary sources, verify against the Gazette):
  - https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-
  - https://www.tcsa.in/resources/dpdp-rules-2025-implementation-roadmap
