# 12. Frontend: Screens, Journeys and Components

**Stack [D]:**
- Next.js (App Router), React, TypeScript, Tailwind.
- TanStack Query for server state.
- Radix UI (or shadcn/ui) primitives for accessible dialogs, menus and comboboxes.
- No secrets in the frontend. No `NEXT_PUBLIC_*` values other than public configuration.

The browser talks to `/api/*` on **the same origin**, through a Next.js rewrite to the API. That keeps cookies first-party (`__Host-` prefix, `SameSite=Lax`).

**This plan covers information architecture and behaviour. The visual direction is in §12.0.**

---

## 12.0 Visual design direction (decided 2026-10-11)

**Brief:** flat design, light theme, Notion-like structure, styled after **patina.md**.

The tokens below come from patina.md's public stylesheet (`assets/css/index.css`, read on 2026-10-11). We take its *style language* only: colours, type and spacing. We copy no assets, logos, illustrations or code.

### Principles

1. **Flat.** No gradients, no decorative shadows. Surfaces are separated by a 1px border or a subtle background step. Only floating layers get a shadow (menus, popovers, dialogs, the side-peek panel), and it is very soft.
2. **Notion-like structure.** Left sidebar, a large page title, content as clean property lists and database-style tables, hover-revealed row actions, and a side-peek detail panel.
3. **Calm and content-first.** Mostly neutral warm greys. Colour is used only for meaning (status pills) and for the one accent (primary actions, focus, links).
4. **Dense but readable.** A 13–14px UI text size like Patina's, with generous whitespace around blocks.

### Design tokens

```css
:root {
  /* Surfaces (patina.md) */
  --bg:            #fafaf8;   /* app background: warm off-white */
  --surface:       #ffffff;   /* cards, table, side peek */
  --surface-muted: #f1f1ec;   /* hover rows, inputs, sidebar active item */
  --border:        #e5e5e3;   /* all dividers, 1px */
  --placeholder:   #e8e8e4;   /* skeleton loaders */

  /* Text (patina.md) */
  --text:          #111111;
  --text-secondary:#555555;
  --text-tertiary: #8a8a85;   /* timestamps, hints. Large or non-essential text only */

  /* Accent (patina.md) */
  --accent:        #2a6ef5;   /* primary buttons, links, focus ring. White text on it ≈ 4.5:1 */
  --accent-soft:   #edf4ff;   /* selected row, accent pill background */

  /* Radius and elevation */
  --radius-sm: 4px;  --radius: 8px;  --radius-lg: 12px;  --radius-pill: 999px;
  --shadow-float: 0 14px 40px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.06); /* floating layers only */

  /* Type */
  --font-ui: "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --fs-xs: 12px; --fs-sm: 13px; --fs-base: 14px; --fs-md: 16px;
  --fs-lg: 20px; --fs-xl: 28px; --fs-2xl: 40px;
  --fw-regular: 500; --fw-medium: 600; --fw-bold: 700;

  /* Spacing: 4px grid */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-6: 24px; --space-8: 32px; --space-12: 48px;
}
```

- **Font:** Manrope, loaded from Google Fonts (`wght@200..800`), which is free under the OFL.
- **Light theme only for now.** The tokens make a dark theme a later, one-file change.

### Status pills (pastel pairs, with an icon and a text label, never colour alone)

The background and text ("ink") pairs follow Patina's pastel feature palette. Red and grey are added to complete the set.

| Status | Background | Ink | Icon (lucide) |
|---|---|---|---|
| Detected | `#f1f1ec` | `#555555` | `circle-dashed` |
| Applied | `#edf4ff` | `#345f96` | `send` |
| Assessment | `#fff1d9` | `#7b5a23` | `file-code` |
| Shortlisted | `#eceaf7` | `#554f84` | `list-checks` |
| Interview | `#e7f6fb` | `#245d6a` | `messages-square` |
| Offer | `#eaf7ee` | `#2f6a41` | `badge-check` |
| Rejected | `#fbeaea` | `#8a3b3b` | `x-circle` |
| Withdrawn | `#f8ece1` | `#76523b` | `undo-2` |
| Closed | `#f1f1ec` | `#555555` | `archive` |
| Flag: Needs review | `#f6e9f3` | `#7a4b70` | `alert-circle` |

Pills are `--radius-pill`, 12–13px, weight 600, with 2px × 8px padding. Every ink colour should reach at least 4.5:1 contrast on its background; verify with a contrast checker when implementing.

### Layout (Notion-style)

```
┌──────────────┬────────────────────────────────────────────────────────────┐
│ ▸ Workspace  │  Applications                                   [Sync ⟳ 4m] │  ← 28px title, sync status right
│              │  ───────────────────────────────────────────────────────── │
│ ▤ Applications│ [Table] [Board]    🔍 Search…   Status ▾  Type ▾  Account ▾│  ← view tabs + filter chips
│ ◎ Review   3 │  ┌─────────────────────────────────────────────────────────┐│
│ ✉ Other mail │  │ Company     Role             Type    Status   Last act. ││  ← flat table, 1px row lines
│ ─────────────│  │ Acme        SDE Intern       Intern  ●Interview  2d     ││     hover = --surface-muted
│ ⚙ Settings   │  │ Globex      Data Analyst     FT      ●Applied    5d     ││
│              │  └─────────────────────────────────────────────────────────┘│
│ ● 2 accounts │                                     ┌── side peek ─────────┐│
│   synced     │                                     │ Acme · SDE Intern    ││  ← detail opens as a right
└──────────────┴─────────────────────────────────────│ Status   ●Interview  ││    side panel (Notion
                                                      │ Applied  12 Sep      ││    "side peek"), with
                                                      │ Type     Internship  ││    properties as key/value
                                                      │ ── Timeline ──────── ││    rows, then the timeline
                                                      └──────────────────────┘│
```

- **Sidebar:** 240px, background `--bg`, items 28px high with a `--surface-muted` hover and an active state. It collapses to an icon rail below 1024px and becomes a drawer on mobile.
- **Views:** **Table** (default) and **Board**, a kanban grouped by status like a Notion board. Board cards are flat, white, with a 1px border and 8px radius.
- **Detail:** a side-peek panel on desktop, and a full page on mobile or via a direct link (`/applications/:id`). Properties are shown as Notion-style rows with a muted label column and an editable value (click to edit inline).
- **Timeline:** a vertical list with a thin 1px rule. Each event shows its pill, date and source chip ("from no-reply@greenhouse.io · placements@college.edu"), plus "Open in Gmail" and "Not right?" on hover.
- **Empty states:** short sentences and plenty of whitespace. Simple line icons only; no illustrations needed.
- **Buttons:**
  - Primary: solid `--accent` with white text, 8px radius, 32px high.
  - Secondary: white with a 1px `--border`.
  - Ghost: text only, with a `--surface-muted` hover.
  - Keyboard hints appear as small key badges (`⌘K` search, `R` review), as Patina does.
- **Icons:** lucide-react, 16px, 1.5px stroke, coloured `--text-secondary`.
- **Motion:** 120–160ms opacity and transform only. Respects `prefers-reduced-motion`.

### Tailwind mapping

The tokens go in `tailwind.config` under `theme.extend` (colors `bg`, `surface`, `border`, `accent`, `status.*`; `fontFamily.ui`; `borderRadius`). Components use semantic classes such as `bg-surface border-border text-secondary`, not raw hex values, so the theme can be changed in one place.

---

## 12.1 User journeys

```mermaid
flowchart LR
  L[Landing] --> S[Continue with Google<br/>(sign-in only)]
  S --> AG{18+ confirmed?}
  AG -->|no| AC[Age + terms confirmation]
  AC --> O
  AG -->|yes| HAS{Has connected mailbox?}
  HAS -->|no| O[Onboarding: Connect Gmail<br/>explainer]
  O --> GC[Google consent<br/>gmail.readonly]
  GC -->|scope unticked / denied| PE[Permission not granted<br/>explain + retry]
  GC -->|ok| IP[Import progress]
  IP --> D[Dashboard]
  HAS -->|yes| D
  D --> AD[Application detail + timeline]
  D --> RV[Review inbox]
  D --> ST[Settings → accounts / privacy]
  ST --> O
```

## 12.2 Screens

| Screen | Purpose | Key states | Main components |
|---|---|---|---|
| **Landing** | Explain the value and the privacy stance in plain language | — | Hero, how-it-works (3 steps), "What we read / store / never do", FAQ, privacy link |
| **Sign-in** | A single "Continue with Google" button. States clearly that this does **not** give mailbox access. | Error (denied, state invalid) | `GoogleButton`, `AuthError` |
| **Age and terms** | 18+ declaration, terms, privacy notice (DPDP notice) | — | `ConsentForm` |
| **Connect Gmail (onboarding)** | Pre-consent explainer, import window choice (3, 6 or 12 months; default 6), "Connect Gmail" | Unverified-app note in beta; `SCOPE_NOT_GRANTED`; `MAILBOX_LINKED_ELSEWHERE` | `ScopeExplainer`, `WindowPicker`, `ConnectButton` |
| **Import progress** | Show backfill phases: Searching → Reading N/M → Organising → Done | Phases; slow (rate-limited) message; error with retry; "You can leave this page, we'll keep going" | `ProgressStepper`, `LiveCounters` (polling every 3 s or SSE), `PartialResultsPreview` |
| **Dashboard** | All applications across accounts | Empty (no applications found, with tips); provisional (backfill running); stale-sync banner; reauth banner; loading skeleton | `SyncStatusBar`, `StatusSummaryChips` (counts), `SearchBox`, `FilterBar`, `ApplicationsTable` (desktop) / `ApplicationCards` (mobile), `UpcomingPanel`, `ReviewBadge` |
| **Application detail** | Fields, status, timeline with sources | Pending suggestions; conflict banner; inferred badge; edit mode | `ApplicationHeader` (editable fields, status menu with pin), `Timeline` (`EventItem` with source chip and "Open in Gmail", "Not right?"), `IdentifiersList`, `ActionsMenu` (merge, split, delete) |
| **Review inbox** | Resolve suggestions in one place | Empty ("All caught up"); batch resolve | `ReviewCard` (evidence snippet, candidates radio list, "New application", "Not job-related", "Always ignore sender") |
| **Merge / split flow** | Fix grouping | Merge: pick applications, preview the combined timeline, confirm. Split: tick emails, name the new application. Undo toast | `MergeDialog`, `SplitDialog`, `UndoToast` |
| **Other recruiting emails** | Outreach and unlinked emails | — | `RecruitingEmailList` with "Track this" |
| **Settings → Accounts** | Per-account status and actions | active / backfilling / reauth_required / error / paused | `AccountCard` (address, status, last sync, "Sync now", "Reconnect", "Import older emails", "Pause", "Disconnect") |
| **Settings → Privacy and data** | Export, delete account, explanation of what's stored | Deletion in progress | `DataSummary`, `ExportButton`, `DeleteAccountDialog` (type-to-confirm) |
| **Sync errors and recovery** | One place per account explaining the problem and the fix | Reason codes mapped to plain-language messages and actions (below) | `SyncErrorPanel` |

**Sync error messages:**

| Reason code | Message and action |
|---|---|
| `reauth_required` | "Google access expired or was removed. Reconnect." In the beta, add: "Test accounts must reconnect every 7 days." |
| `rate_limited` | "Gmail is slowing us down. We'll retry automatically." |
| `error` | "We couldn't sync since …", with a Retry button and a support code (no content). |
| Failed messages | "N emails couldn't be processed. Retry." |

## 12.3 Dashboard details

- **Columns:** Company · Role · Type · Applied · Status · Last activity · Source (account and platform icons) · flags (review, upcoming, stale, conflict).
- **Filters:** status (multi-select), employment type, account, platform, applied date range, "Needs review", "Has upcoming", "Hide closed/rejected".
- **Search:** company and role, using the server-side trigram index, debounced at 250 ms.
- **Sort:** last activity (default, descending), applied date, company A–Z, status.
- **Filter state lives in URL query parameters**, so it's shareable and survives a refresh.
- **Pagination:** cursor-based infinite scroll, with a "Load more" button for accessibility.
- **Upcoming panel:** the next 7 days of interviews and assessment deadlines, shown in the user's timezone.

## 12.4 Accessibility and responsiveness

- WCAG 2.1 AA.
  - Status chips use **text plus an icon**, never colour alone.
  - Focus is managed in dialogs.
  - Table semantics on desktop, labelled cards on mobile.
  - Announce progress updates with `aria-live="polite"`.
- Fully keyboard-operable: review actions have shortcuts with visible hints.
- Mobile first: the 360 px layout is tested. Students will often check it on their phone.
- Respect `prefers-reduced-motion` and dark mode.

## 12.5 Security in the UI

- **Never render email HTML.** Snippets and subjects are plain text, escaped by React.
- "Open in Gmail" links point only to `https://mail.google.com/...`, built server-side.
- Job URLs are shown with their hostname, open with `rel="noopener noreferrer nofollow"`, and only `https:` URLs are allowed.
- **CSP:** `default-src 'self'`; no inline scripts (nonce-based for Next.js); `frame-ancestors 'none'`.
