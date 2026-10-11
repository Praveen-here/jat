# 7. Email Classification and Information Extraction

Labels: [F] fact checked on 2026-10-11 · [A] assumption · [D] decision.

**Guiding principles:**
1. **Precision before recall** when the result would create or change an application.
2. **Abstain** and ask the user rather than guess.
3. **The sender is not the employer.**
4. Every output carries **confidence plus evidence**.
5. The classifier is a **pure, versioned function**: it is deterministic, testable and re-runnable.

---

## 7.1 Pipeline

```mermaid
flowchart TD
  A[Gmail message<br/>(metadata or full)] --> B[Normalise + sanitise<br/>MIME → text, strip quotes/forwards,<br/>extract links, ICS, attachment names]
  B --> C[Hard filters<br/>own sent mail, drafts, chats,<br/>user ignore rules]
  C -->|filtered| X[irrelevant]
  C --> D[Feature extraction<br/>headers, sender role, phrases,<br/>bulk signals, IDs, dates]
  D --> E[Sender/template registry match]
  E --> F[Rule scorer → category scores]
  F --> G{Decision}
  G -->|high confidence| H[Accept category]
  G -->|ambiguous band| I{LLM enabled?}
  I -->|yes| J[LLM structured extraction<br/>+ grounding check]
  I -->|no| R[needs_review]
  J -->|grounded & agrees| H
  J -->|not grounded / conflicting| R
  G -->|low| X
  H --> K[Field extractors<br/>company, role, type, IDs, URL, dates]
  K --> M[Extraction record<br/>with per-field confidence + evidence]
  M --> N[Matching engine §8]
```

## 7.2 Normalisation and sanitisation (security-relevant)

- **MIME parsing** with a hardened parser (for example `postal-mime` or `mailparser` in a worker thread). Limits:
  - At most 2 MB total processed per message.
  - At most 100 KB of text after conversion. Truncate beyond that.
  - At most 50 MIME parts.
- **Prefer `text/plain`.** Otherwise convert HTML to text with a DOM-free converter (`html-to-text` over `parse5`).
  - **Never render or execute email HTML**, server-side or in our UI.
  - Drop `<script>`, `<style>`, hidden elements (`display:none`, zero-size or white-on-white is best effort) and tracking pixels.
  - Hidden text is a known way to hide prompt injection and keywords.
- **Strip quoted replies, signatures and forward wrappers.** Keep the forwarded *original* as the primary content, and record `is_forward=true` and the original sender, date and subject if they can be parsed.
- **Links:** collect `{href, anchor_text}`.
  - Unwrap known redirectors (LinkedIn, Google, Outlook safelinks, SendGrid and Mailchimp click trackers) **by parsing only, never by fetching**.
  - Canonicalise: lower-case the host and strip `utm_*`, `trk`, `refId` and other tracking parameters.
- **Calendar:** parse `text/calendar` and `.ics` parts. Extract `DTSTART` and `DTEND` with timezone, `ORGANIZER`, `SUMMARY`, `LOCATION`, and the meeting URL host only.
- **Attachments:** filename, MIME type and size only. **Never downloaded** in the MVP. A filename like `Offer_Letter.pdf` is a weak signal.
- **Regex safety:** all rules use **RE2** (the `re2` npm binding), so matching runs in linear time. Fuzz tests guard against ReDoS.

## 7.3 Signal catalogue

| Group | Signals |
|---|---|
| **Envelope** | From address and domain; display name; Reply-To; To/Cc (is the user a direct recipient or on a list); `List-Id`, `List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`; Gmail category labels (Promotions, Updates, Social, Forums). |
| **Sender role** (registry) | `ATS`, `JOB_BOARD`, `ASSESSMENT_VENDOR`, `SCHEDULER`, `STAFFING_AGENCY`, `CAMPUS_PLACEMENT_PLATFORM`, `EMPLOYER_DIRECT`, `PERSONAL` (free-mail domain such as gmail.com, for recruiter personal accounts), `UNKNOWN`. |
| **Lexical: application evidence** | Past or perfect tense receipt: "thank you for applying", "we have received your application", "your application for X has been submitted", "application ID", "you applied to". |
| **Lexical: stage** | Assessment ("online assessment", "coding challenge", "test link", "complete by"); interview ("schedule your interview", "interview invitation", "round", "panel"); shortlist ("shortlisted", "moved to the next round"); offer ("offer letter", "pleased to offer", "CTC", "joining date"); rejection ("regret to inform", "not moving forward", "decided to pursue other candidates", "position has been filled"); information request ("please submit", "documents required"); withdrawal ("you have withdrawn"); rescheduling or cancellation. |
| **Lexical: alert or marketing (negative)** | "jobs you may be interested in", "recommended for you", "new jobs matching", "X new jobs", "job alert", "apply now" used as a call to action, "unsubscribe from job alerts", "top companies hiring". |
| **Structural** | Number of distinct job-posting links (alerts link to many), personalisation (user's first name present), presence of an ICS invite, presence of labelled identifiers, message length, table or list of jobs. |
| **Thread context** | `In-Reply-To` or `References` pointing to a message already linked to an application, or a reply from the user in the thread (a strong sign of a real conversation). |

**Header-only triage for incremental sync** (decides whether to fetch the body; tuned for recall):
- **Fetch** if any of these hold:
  - The sender domain or local-part is in the registry (not alert-only entries).
  - The subject or snippet matches a stage or application phrase.
  - The email is a reply in a thread we already track.
  - The email has a calendar invite.
- **Skip** if the sender is an alert-only registry entry *and* bulk headers are present.
- **Fetch** if the email is personal mail from an unknown domain whose subject mentions a job word.

## 7.4 Sender and template registry [D]

A **versioned, code-reviewed data file** in the repo (YAML or JSON). It is curated from public knowledge and donated, consented samples, never from users' email. Illustrative shape:

```yaml
- id: greenhouse
  role: ATS
  domains: [greenhouse.io, greenhouse-mail.io]     # verify actual sending domains on donor samples
  employer_from: [display_name, subject_pattern, body_pattern, job_url_slug]
  job_url_patterns:
    - 'boards\.greenhouse\.io/(?P<tenant>[^/]+)/jobs/(?P<posting_id>\d+)'
  templates:
    - category: APPLICATION_RECEIVED
      subject: '(?i)thank you for (applying|your application)'
- id: linkedin
  role: JOB_BOARD
  domains: [linkedin.com]
  local_parts:                                    # local-part distinguishes alerts from application mail
    alert:        ['jobalerts-noreply', 'jobs-listings']        # [A] confirm on donor samples
    application:  ['jobs-noreply']
  job_url_patterns: ['linkedin\.com/(comm/)?jobs/view/(?P<posting_id>\d+)']
- id: workday
  role: ATS
  domains: [myworkday.com, myworkdayjobs.com]
  employer_from: [url_tenant_subdomain, display_name, body_pattern]   # e.g. acme.wd5.myworkdayjobs.com
- id: hackerrank
  role: ASSESSMENT_VENDOR
  domains: [hackerrank.com, hackerrankforwork.com]
  employer_from: [body_pattern]                                       # "<Company> has invited you…"
```

**Initial coverage target (Indian and global, to be confirmed with real samples):**

| Sender role | Examples |
|---|---|
| ATS | Workday, Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS, Oracle Taleo, SAP SuccessFactors, Zoho Recruit, Darwinbox, Keka, Freshteam |
| Job boards | LinkedIn, Naukri, foundit, Indeed, Internshala, Instahyre, Cutshort, Wellfound, Unstop, Glassdoor |
| Assessment vendors | HackerRank, HackerEarth, Codility, CodeSignal, Mercer Mettl, SHL/AMCAT, Talview, iMocha |
| Schedulers | Calendly, GoodTime, Google Calendar and Microsoft invites (ICS) |
| Campus platforms | Superset, college placement-cell domains (user-addable) |

**Registry hygiene:**
- Each entry has an owner and a "last verified" date.
- Aggregate rule hit-counts (no content) feed a drift monitor that alerts when a template stops matching.

## 7.5 Category scoring and decision

**Taxonomy** (email level; the event type is derived from it):

| Category | Creates an application? | Event type |
|---|---|---|
| `APPLICATION_RECEIVED` | Yes | `APPLIED` |
| `ASSESSMENT_INVITE` | Yes, inferred (if no match) | `ASSESSMENT_INVITED` |
| `ASSESSMENT_REMINDER` | No | `ASSESSMENT_REMINDER` (modifier) |
| `ASSESSMENT_COMPLETED` | No | `ASSESSMENT_COMPLETED` |
| `INTERVIEW_INVITE` | Yes, inferred | `INTERVIEW_SCHEDULED` |
| `INTERVIEW_RESCHEDULED` | No | `INTERVIEW_RESCHEDULED` |
| `INTERVIEW_CANCELLED` | No | `INTERVIEW_CANCELLED` |
| `SHORTLISTED` | Yes, inferred | `SHORTLISTED` |
| `OFFER` | Yes, inferred, **always reviewed** | `OFFER` |
| `REJECTION` | Yes, inferred | `REJECTED` |
| `INFO_REQUEST` | No | `INFO_REQUESTED` |
| `WITHDRAWAL_CONFIRMATION` | No | `WITHDRAWN` |
| `RECRUITER_OUTREACH` | **No.** Listed under "Other recruiting emails" with a "Track this" button. | — |
| `JOB_ALERT` | **Never** | — |
| `NEWSLETTER_MARKETING` | **Never** | — |
| `UNRELATED` | Never | — |

"Inferred" means the email shows an application exists, but we never saw its confirmation (for example, it predates the import window). Such applications are created with `origin = inferred` and a lower confidence.

**Scoring [D].**
- Each rule contributes a weight (in log-odds) to one or more categories. Registry template hits are strong (+4 to +6). Phrase hits are moderate (+1 to +3). Negative signals such as bulk headers or many job links subtract from the application categories.
- Scores are normalised to a confidence in [0, 1] with a calibrated logistic function. Calibration uses only the synthetic and donor corpus.
- **Decision bands**, initial values, tuned on the corpus:

| Condition | Result |
|---|---|
| Top category ≥ 0.85 and margin over the runner-up ≥ 0.25 | Accept |
| 0.55–0.85, or a small margin | **Ambiguous band**: LLM if enabled, otherwise `needs_review` (category shown as a suggestion) |
| Below 0.55 for every job category | `UNRELATED` or the alert/marketing category, whichever scored highest |

- **Gates that override scores:**
  - **Application gate.** `APPLICATION_RECEIVED` requires *receipt evidence*: a past-tense receipt phrase, a registry application template, or a labelled application ID. A job mention alone never qualifies.
  - **Alert gate.** If bulk headers are present *and* there are 3 or more distinct posting links *and* no receipt evidence, the result can't be an application category, whatever the other scores.
  - **Offer gate.** `OFFER` always goes to review in the MVP. It is rare and high-stakes, and phrasing like "we'd like to offer you a chance to interview" is a classic false positive.

## 7.6 Job alert versus application

| Signal | Job alert or newsletter | Application email |
|---|---|---|
| Bulk headers (`List-Unsubscribe`, `Precedence: bulk`) | Almost always | Often (ATS mail is bulk-sent too), so a **weak** signal alone |
| Distinct posting links | Many (3 or more) | 0–1 |
| Tense and intent | Future or imperative: "apply now", "you may like" | Past: "you applied", "we received" |
| Personal identifiers | None | Application or candidate ID, the role you applied to |
| Sender local-part | `jobalerts-…`, `digest`, `newsletter` | `no-reply@<ats>`, `careers@`, a recruiter's name |
| Thread history | Standalone | Often a continuation |

LinkedIn, Naukri and Internshala send **both** kinds from the same domain. The registry therefore distinguishes them by local-part and template, not by domain.

## 7.7 Field extraction

Each extractor returns `{value, confidence, source, evidence_span}`. The span is at most 120 characters from the cleaned text and is what we store as evidence.

### Employer (company): the sender is not the employer

Candidates are collected from every source, scored, and the best is chosen:

| Source | Example | Base confidence |
|---|---|---|
| ATS URL tenant | `acme.wd5.myworkdayjobs.com`, `boards.greenhouse.io/acme`, `jobs.lever.co/acme` | 0.9 (tenant slug is reliable; mapped to a display name via body or display name) |
| Labelled body phrase | "Thank you for applying to **Acme**", "**Acme** has invited you to…", "position at **Acme**" | 0.8 |
| Display name on an ATS or job-board sender | "Acme Recruiting via Greenhouse", "Acme Hiring Team" | 0.75 |
| Subject pattern | "Your application to Acme", "Acme \| Interview invitation" | 0.7 |
| ICS organiser domain (non-freemail) | `recruiter@acme.com` | 0.7 |
| Sender domain when the role is `EMPLOYER_DIRECT` | `careers@acme.com` | 0.85 |
| Signature block company line | "Talent Acquisition, Acme Pvt Ltd" | 0.5 |
| Staffing agency email with the client not named | — | Company = "Undisclosed (via Agency X)", `needs_review` |

**Rules:**
- **Reject** candidates that equal the platform name when the sender role is ATS, job board or assessment vendor. For example, "HackerRank" is not the employer on a HackerRank invite.
- **Normalise** to a `company_key`:
  - Case-fold and strip legal suffixes (Pvt Ltd, Private Limited, Inc, LLC, Ltd, Technologies, Solutions, India, Services). Suffix stripping is careful: keep a word if removing it leaves nothing.
  - Collapse whitespace and punctuation.
  - Apply the **global curated alias table** (for example TCS → Tata Consultancy Services; this is public knowledge, not user data), then the **per-user alias table**, which grows from the user's renames and merges.

### Role title

- **Patterns:** "for the position of **X**", "applying for **X**", "your application for **X**", "role: **X**", subject templates such as "Application received – X (R-12345)".
- **Normalised `role_key`:**
  - Lower-case.
  - Strip requisition IDs, locations in brackets, "– Remote" and similar.
  - Expand abbreviations (SDE → software development engineer, SWE → software engineer, ML → machine learning).
  - Keep seniority words ("intern", "II", "senior"), because they distinguish applications.
- **Similarity** for matching: token-set Jaccard on `role_key` plus a check for meaningful words (§8).

### Employment type

- `INTERNSHIP`: intern, internship, stipend, PPO, summer/winter intern, "6-month".
- `FULL_TIME`: full-time, FTE, CTC, LPA, permanent, graduate/new-grad program.
- `PART_TIME`, `CONTRACT`: explicit keywords only.
- Otherwise `UNKNOWN`. Never guess.

### Identifiers (anchored patterns only; random numbers are never captured)

- **Requisition:** `(?i)(req(uisition)?|job)\s*(id|no\.?|#|number)\s*[:#-]?\s*([A-Z0-9-]{3,20})`, plus ATS formats such as Workday `R\d{4,8}` or `JR\d+`, only when next to such a label or inside the subject template.
- **Application or candidate reference:** `(?i)(application|candidate|reference)\s*(id|no\.?|number|#)\s*[:#-]?\s*([A-Z0-9-]{4,24})`.
- **Job URL and posting ID:** from registry `job_url_patterns`, applied to unwrapped links.

### Dates and times

- **Precedence:**
  1. ICS `DTSTART` with a timezone.
  2. An explicit date and time with a timezone in the body ("Oct 14, 2026 at 3:00 PM IST").
  3. A relative or partial date resolved against the message `Date` ("tomorrow at 3 PM", "this Friday"), using `chrono-node` with the reference date set to the message date.
  4. None.
- If no timezone is given, default to the user's profile timezone (Asia/Kolkata by default) and **lower the confidence**.
- **Application date** = the date of the `APPLICATION_RECEIVED` email. Otherwise it stays `null` (inferred applications show "Applied: unknown").
- **Deadline vs event time:** "complete the assessment **by** Oct 20" is a deadline; "interview **on** Oct 20" is a scheduled time. They are stored in separate fields.

### Event details stored (minimised)

- **Interview:** time, duration, round label, mode (video, phone, onsite), meeting **host only** (`zoom.us` or `meet.google.com`, not the full link with passcode).
- **Assessment:** deadline, vendor, duration.

Full links stay in Gmail. The UI offers "Open in Gmail".

### Platform and source

- `platform` comes from the registry (for example `LinkedIn`, `Workday`, `HackerRank`), or `Direct` or `Unknown`.
- Provenance (`mail_account_id`, `provider_message_id`, `provider_thread_id`) is always recorded on `source_messages`.

## 7.8 Approach comparison

| Approach | Accuracy | Maintainability | Privacy | Latency | Cost | Verdict |
|---|---|---|---|---|---|---|
| 1. Regex and keyword rules | High precision on known phrasing; poor on the long tail | Gets brittle without structure | Best (all local) | Microseconds | ~0 | Necessary, not sufficient |
| 2. Sender registry and templates | Very high for covered platforms (most volume for students goes through about 30 platforms [A]) | Data-driven and reviewable; needs drift monitoring | Best | Microseconds | ~0 | **Core of the MVP** |
| 3. Traditional ML (logistic regression, gradient boosting, fine-tuned small transformer) | Good with **lots of labelled data** | Needs an MLOps pipeline | Fine at inference, **but training on users' emails is prohibited** [F] | ms | Low | Phase 3 at the earliest, trained only on synthetic and donor data |
| 4. LLM for every email | Good on the long tail; hallucination and injection risk | Prompt versioning; vendor drift | Worst: every candidate email goes to a third party | 0.5–3 s | Linear in volume | Rejected as the default |
| 5. **Hybrid**: registry and rules, abstain, LLM only in the ambiguous band | Precision of rules with recall on the long tail | Good | Only a small fraction of trimmed emails leave our servers, and only if the user opts in | Mostly μs | Small | **Recommended [D]** |

**MVP decision.** Ship 1+2 with abstention (send to review). Measure. Add the LLM fallback only if the review rate or long-tail recall on the corpus justifies it. Target: LLM used on at most 15% of *candidate* emails [A].

## 7.9 LLM fallback design (DEFERRED: decision Q2, "no AI for now")

> Not built. In the current plan, the ambiguous band always goes to `needs_review`. The design below is kept for if and when AI is reconsidered.

- **When:** only in the ambiguous band, for candidate emails (never for every email).
- **Input minimisation.** Subject, sender display name and domain, and cleaned body text up to about 3,000 characters, with forwards and quotes already stripped. Before sending, redact phone numbers, the user's email addresses, Indian PAN/Aadhaar-shaped numbers and URLs, keeping only the URL host.
- **Output.** A strict JSON schema (structured outputs or tool schema) containing: category, company, role, employment type, IDs, event time, and **`evidence` quotes for each field**.
- **Grounding check.** Every returned value and evidence quote must appear (after normalisation) in the text we sent. Otherwise the field is discarded. This blocks fabricated companies and roles.
- **Prompt-injection posture:**
  - The email is wrapped as data with an explicit instruction that it is untrusted.
  - The model has **no tools**, no access to other data, and no ability to take actions.
  - Output is validated against the schema, with length caps, and escaped in the UI.
  - LLM outputs can never produce `OFFER` or a status change without review unless the rule scorer independently agrees above the mid band.
- **Vendor requirements.** No training on our data, and zero or short data retention. Disclosed in the privacy policy and in the opt-in screen. Covered by a data processing agreement. Tracked as a third-party transfer for consented feature delivery under Limited Use [F].
- **Cost control.** Use a small, fast model tier. Cap per user per month (for example 200 calls) and send to review beyond the cap. Cache by content fingerprint so duplicates aren't re-sent. Choose the model and check current pricing when implementing.

## 7.10 User confirmation

`needs_review` items appear in a **Review inbox**, with:
- the suggested category,
- the company and role,
- an evidence snippet,
- "Open in Gmail".

| Action | Effect |
|---|---|
| Confirm | Accept the suggestion. |
| Change category | Correct the classification. |
| Not job-related | Optionally "always ignore this sender", which creates a per-user rule. |
| Track as application | For outreach emails. |

Each answer is a `user_corrections` row. It overrides the automatic result for that message and can create **per-user rules**. Per-user rules count as personalisation for that user, which the policy allows [F].

## 7.11 Versioning and reprocessing

- `classifier_version` and `extractor_version` are stored on every result, along with the rule IDs that fired.
- **Reprocess job:** after a rule change, re-fetch (20 units each) and re-run for the affected messages. Only relevant and `needs_review` messages are re-run by default; irrelevant ones only if the change targets recall. The result is a diff:
  - Changes not locked by the user are applied.
  - Changes that would alter the application grouping go through the matching engine's review rules (§8.9).

## 7.12 Improving quality within policy limits

- **Allowed:**
  - The synthetic corpus.
  - Team and volunteer **donor mailboxes with written consent**, exported and labelled offline.
  - **Aggregated, anonymised operational metrics**, such as rule hit-rates, review rates per category and correction rates per registry entry, with no content.
  - Per-user personalisation.
- **Not allowed:** training or tuning shared models on users' emails or corrections. Humans reading user email (except under the narrow exceptions in the policy) [F].
- **Open question for legal review:** whether aggregated counts keyed by a *public ATS sender domain* (for example "rule greenhouse.rejection.v3 overridden 40 times this week") count as aggregated, anonymised operations. The plan assumes yes, with k-anonymity thresholds (a minimum of 20 users per bucket) [A].

---

## Implementation notes (task 5, 2026-10-11)

Built in `backend/src/server/classify/` (rules, registry, extraction, triage) and `sync/record.ts` (storage).

| Design | Built | Why |
|---|---|---|
| RE2 regex engine against ReDoS | **Standard JS regexes, written without nested unbounded quantifiers, on size-capped input** (100 KB text, 20 KB for rules), plus a speed test on pathological inputs | The `re2` native module needs a C++ toolchain on Windows. The speed test fails CI if a regex ever becomes slow. |
| Hidden-text stripping "best effort" | `display:none`, `hidden`, scripts, styles and images dropped by `html-to-text` selectors | Covers the common injection and keyword-stuffing tricks. White-on-white text is not detected. |
| Encrypted subject and snippet | Subject, sender and Gmail snippet encrypted with **AES-256-GCM using a key derived (HKDF) from `TOKEN_ENCRYPTION_KEY`**, bound to row and field | A separate key from the token vault, and no extra secret to manage. |
| LLM fallback | Not built (decision Q2) | The ambiguous band goes to review. |

**Quality (synthetic corpus, `pnpm --filter backend eval [seed]`), 820 emails across 40 templates:**
- job-related precision and recall: 100% / 100%;
- alerts mistaken for applications: 0%;
- category accuracy: 100%;
- company: 98.8–99.3%; role, type, IDs and dates: 100%;
- review rate: 3.3%.

The CI gate is in `classifier.test.ts`.

**These numbers are optimistic.** The same author wrote the templates and the rules, and the holdout seed varies names and dates, not phrasing. Six hand-written emails with different wording are also tested, and they surfaced one real gap (Calendly confirmations) before shipping. Real accuracy must be judged on real mail: the "Job emails found" list and its "Needs review" tab exist for that.

**Known limitations:**
- A company known only from an unusual domain (e.g. `pixelwave.studio` → "Pixelwave", not "Pixelwave Studios") gets the shorter name. Matching (task 6) should treat a name and its prefix as compatible.
- Recruiter outreach with an undisclosed client has no company, by design.
- Order-delivery and marketing emails are sometimes labelled "newsletter" rather than "unrelated". Both are dropped, so this has no effect.

---

## AI layer (built 2026-10-11, replaces the "deferred" note in §7.9)

Code: `backend/src/server/ai/` (Groq client, prompt, grounding) and `classify/hybrid.ts` (rules + AI decision).

**Flow:** rules first → hard blocks (security/OTP, alert senders, bulk hiring newsletters) never reach the AI → for possibly job-related mail, the AI returns a strict-schema verdict → combined with the rules:

| Rules vs AI | Result |
|---|---|
| Agree | Accepted (review only if AI confidence < 0.6) |
| Both "not a job email" | Dropped |
| AI finds a job email the rules had no opinion on, confidence ≥ 0.85 | Accepted |
| Disagree on the kind of job email (AI ≥ 0.7) | AI's answer, **flagged for review** |
| AI says "not job" but the rules have personal evidence | **Kept, flagged for review** (never silently drop an application) |
| AI says "not job", rules only weakly matched | Dropped |
| AI rate-limited or down | Email waits (`retry`, `ai_waiting`) and is processed later, without counting as a failure |
| AI reply unusable | Rules result, flagged for review |

**Security and privacy:**
- Minimal text (2,500 characters), with the user's addresses, name and phone numbers redacted.
- The email is wrapped as untrusted data, and the model has no tools.
- Strict JSON schema, then zod validation.
- Every company, role and date must be a verbatim quote from the sent text, and platforms are never accepted as employers.
- Temperature 0.
- The key is only in the Authorization header; logs scrub `gsk_…`.
- No prompts or replies are logged.

**Measured (real Groq, 2026-10-11):**
- 24 synthetic corpus emails: rules+AI made 0 job/not-job mistakes, every company correct, 0 reviews. The only differences were newsletter-vs-unrelated labels; both are dropped.
- 8 hand-written hard emails (soft rejection, informal invite, "Letter of Intent" offer, take-home task, agency outreach…): **rules 3/8, rules+AI 8/8**.

These are small samples and not a guarantee. The real measure is the user's inbox plus their corrections.

**Free-tier limits:** gpt-oss-120b allows about 8K tokens/min and 200K tokens/day. The client paces to 7K/min (about 4 emails/min). The daily limit is roughly 100+ AI-checked emails; beyond it, emails wait for the next day automatically.
