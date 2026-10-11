import * as chrono from 'chrono-node';
import { timeZoneOffsetMinutes } from '../email/normalize';
import type { NormalizedEmail } from '../email/types';
import type { Category } from './categories';
import { findRegistryEntry, isFreeMail, PLATFORM_NAMES, REGISTRY } from './registry';

/**
 * Field extraction (docs/plan §7.7). Every field carries a confidence and where it came from.
 * The employer is resolved from several candidate sources and the best one wins. Platform names
 * (Greenhouse, HackerRank, LinkedIn…) are never accepted as the employer.
 */
export const EXTRACTOR_VERSION = 1;

export type EmploymentType = 'internship' | 'full_time' | 'part_time' | 'contract' | 'unknown';

export interface Extraction {
  company: { display: string; key: string; source: string; confidence: number } | null;
  role: { title: string; key: string; confidence: number } | null;
  employmentType: EmploymentType;
  reqId: string | null;
  applicationRef: string | null;
  jobPostingId: string | null;
  jobUrl: string | null;
  platform: string;
  eventAt: Date | null;
  deadlineAt: Date | null;
  eventSource: 'calendar' | 'text' | null;
  /** For shortlists: what the next step is, when the email says. */
  nextStep: 'assessment' | 'interview' | null;
}

// ---- company ----------------------------------------------------------------------------------

// Words of a company name: capitalised, no sentence punctuation (so "Acme. We've…" stops at "Acme").
const COMPANY_WORD = String.raw`[A-Z0-9][A-Za-z0-9&'’+-]{0,30}`;
const LEGAL_FORM = String.raw`(?:,? (?:Pvt\.?|Private|Ltd\.?|Limited|Inc\.?|LLC|LLP|Corp\.?|Corporation|Co\.)){0,3}`;
const COMPANY_NAME = String.raw`(${COMPANY_WORD}(?: (?:&|and|of|de|for) ${COMPANY_WORD}| ${COMPANY_WORD}){0,4}${LEGAL_FORM})`;

/** Phrases where a company name follows (or precedes) predictable words. Case-sensitive on the name. */
const COMPANY_PATTERNS: Array<{ pattern: RegExp; confidence: number; source: string }> = [
  { pattern: new RegExp(String.raw`\b(?:applied|applying|application) (?:to|for) [^\n.]{1,80}? at ${COMPANY_NAME}`), confidence: 0.85, source: 'body' },
  { pattern: new RegExp(String.raw`\b(?:applying|applied|application|interest|candidacy) (?:to|at|with|for a position at|for a role at) ${COMPANY_NAME}`), confidence: 0.85, source: 'body' },
  { pattern: new RegExp(String.raw`\bapplication was sent to ${COMPANY_NAME}`), confidence: 0.9, source: 'body' },
  { pattern: new RegExp(String.raw`\b(?:position|role|opening|opportunity|internship|job) (?:of [^.\n]{1,60}? )?(?:at|with) ${COMPANY_NAME}`), confidence: 0.8, source: 'body' },
  { pattern: new RegExp(String.raw`\b${COMPANY_NAME} (?:has invited|invites|invited|would like to invite) you\b`), confidence: 0.85, source: 'body' },
  { pattern: new RegExp(String.raw`\b(?:test|assessment|challenge|interview|offer|invitation|message) from ${COMPANY_NAME}`), confidence: 0.75, source: 'body' },
  { pattern: new RegExp(String.raw`\b(?:by|with|for) ${COMPANY_NAME} for the (?:role|position) of\b`), confidence: 0.8, source: 'body' },
  { pattern: new RegExp(String.raw`\b(?:the|your) ${COMPANY_NAME} (?:online |coding |technical )?(?:test|assessment|interview|application|offer|team)\b`), confidence: 0.7, source: 'body' },
  { pattern: new RegExp(String.raw`\bshortlisted (?:by|at) ${COMPANY_NAME}`), confidence: 0.8, source: 'body' },
  { pattern: new RegExp(String.raw`\b(?:on behalf of|team at|careers at|hiring team at|recruiting team at|recruitment team at|talent team at|join|joining) ${COMPANY_NAME}`), confidence: 0.75, source: 'body' },
  { pattern: new RegExp(String.raw`\binterest in (?:joining |working (?:at|with) )?${COMPANY_NAME}`), confidence: 0.8, source: 'body' },
  { pattern: new RegExp(String.raw`(?:^|\n)(?:the )?${COMPANY_NAME} (?:recruiting|recruitment|careers|talent acquisition|hiring|hr|people) team\b`, 'i'), confidence: 0.75, source: 'signature' },
  { pattern: new RegExp(String.raw`\bwelcome to ${COMPANY_NAME}`), confidence: 0.6, source: 'body' },
];

const SUBJECT_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(?:at|with|from|to) ${COMPANY_NAME}\s*(?:$|[|:–—(!-])`),
  new RegExp(String.raw`^${COMPANY_NAME}\s*[|:–—-]\s`),
];

const DISPLAY_NAME_PATTERNS: RegExp[] = [
  /^(.{2,60}?)\s+(?:via|through|@)\s+\w+/i,
  /^(.{2,60}?)\s+(?:recruiting|recruitment|careers|talent acquisition|talent|campus|university relations|hiring team|hiring|hr|jobs|team|people)\b/i,
];

const NOT_COMPANIES = new Set([
  'the', 'we', 'our', 'your', 'you', 'thank', 'thanks', 'unfortunately', 'dear', 'hi', 'hello', 'team', 'hiring', 'recruiting',
  'careers', 'jobs', 'job', 'us', 'this', 'that', 'a', 'an', 'congratulations', 'regards', 'best', 'next', 'role', 'position',
  'application', 'interview', 'assessment', 'update', 'noreply', 'no reply', 'do not reply', 'notification', 'notifications',
  'candidate', 'talent acquisition', 'hr', 'human resources', 'recruitment', 'recruiter', 'test', 'online', 'online test',
  'technical', 'round', 'it', 'its', 'please', 'reminder', 'important', 'urgent', 'action required', 'invitation', 'offer',
  'internship', 'intern', 'india', 'mr', 'ms', 'mrs', 'admin', 'support', 'info', 'mail', 'email', 'team members',
]);

const LEGAL_SUFFIXES = /\s+(pvt\.?|private|ltd\.?|limited|inc\.?|llc|llp|corp\.?|corporation|co\.?|company|technologies|technology|tech|solutions|services|software|systems|labs|group|global|india|in)$/i;

/** Canonical comparison key: "Acme Technologies Pvt. Ltd." → "acme". */
export function companyKey(name: string): string {
  let key = name.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const stripped = key.replace(LEGAL_SUFFIXES, '').trim();
    if (!stripped || stripped === key) break;
    key = stripped;
  }
  return key.replace(/^the /, '');
}

function cleanCompany(raw: string, allowPlatform = false): string | null {
  let name = raw
    .replace(/\s+(?:for|as|and|in|on|via|is|has|team|we|to|from|at|with|regarding|online|technical|interview|test|hiring|careers|recruiting|–|-)$/i, '')
    .replace(/[.,!:;'’"-]+$/g, '')
    .trim();
  name = name.replace(/^(?:the)\s+/i, '');
  const key = companyKey(name);
  if (!name || name.length > 60 || name.includes('@') || !key || NOT_COMPANIES.has(key) || (!allowPlatform && PLATFORM_NAMES.has(key))) return null;
  if (/^\d+$/.test(key)) return null;
  // "applied to SDE Intern at…" is a role, and "Application Received" is a subject line, not companies.
  if (ROLE_NOUNS.test(name) || NOT_COMPANY_WORDS.test(name)) return null;
  return name;
}

const ROLE_NOUNS =
  /\b(engineer|developer|intern|internship|trainee|analyst|manager|designer|scientist|associate|consultant|executive|specialist|architect|administrator|officer|sde|swe|sdet|programmer|tester|recruiter|accountant|apprentice|technician|coordinator|position|role)\b/i;
const NOT_COMPANY_WORDS =
  /\b(application|applications|interview|invitation|invite|update|status|received|reminder|assessment|test|offer|schedule|scheduled|thank|thanks|congratulations|regarding|next steps|action required|your|our|dear|hello|hi)\b/i;

/** Letters and digits only: "Tatva Fintech" → "tatvafintech", comparable with domains and slugs. */
const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Finds the capitalised phrase in the text that spells a domain or ATS slug:
 * "tatvafintech.com" ↔ "Tatva Fintech", "cobalt.ai" ↔ "Cobalt AI".
 */
function alignToText(base: string, text: string): string | null {
  if (base.length < 3) return null;
  const words = [...text.slice(0, 5000).matchAll(/[A-Z0-9][A-Za-z0-9&'’+-]{0,30}/g)];
  let best: string | null = null;
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < Math.min(i + 4, words.length); j++) {
      // Words must be adjacent (separated by a single space).
      if (j > i && text.slice(words[j - 1]!.index! + words[j - 1]![0].length, words[j]!.index!) !== ' ') break;
      joined += squash(words[j]![0]);
      const phrase = text.slice(words[i]!.index!, words[j]!.index! + words[j]![0].length);
      if (joined === base) {
        // Keep a short all-caps tail that belongs to the name: "Cobalt" + "AI" (domain cobalt.ai).
        const next = words[j + 1];
        if (next && /^[A-Z]{2,3}$/.test(next[0]) && text.slice(words[j]!.index! + words[j]![0].length, next.index!) === ' ') {
          return text.slice(words[i]!.index!, next.index! + next[0].length);
        }
        return phrase;
      }
      if (joined.startsWith(base) && joined.length - base.length <= 3) best ??= phrase;
      if (!base.startsWith(joined)) break;
    }
  }
  return best;
}

function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The registrable name of a domain: "hr.pixelwave.studio" → "Pixelwave",
 * "careers.tatvafintech.co.in" → "Tatvafintech" (only for non-platform, non-free-mail senders).
 */
function companyFromDomain(domain: string): string | null {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  // Second-level suffixes like co.in, ac.in, co.uk: the name sits one label further left.
  const secondLevel = new Set(['co', 'ac', 'org', 'net', 'gov', 'edu', 'com', 'ltd', 'firm', 'gen', 'ind']);
  let index = labels.length - 2;
  if (index >= 1 && secondLevel.has(labels[index]!) && labels[labels.length - 1]!.length === 2) index--;
  const base = labels[index];
  return base && base.length >= 2 ? titleCase(base) : null;
}

function resolveCompany(email: NormalizedEmail, text: string): Extraction['company'] {
  type Candidate = { display: string; confidence: number; source: string };
  const candidates: Candidate[] = [];
  const senderDomain = email.from?.domain ?? '';
  const entry = findRegistryEntry(senderDomain);
  const displayName = email.from?.name ?? '';
  // A platform's name (HackerRank, Unstop…) is accepted as the employer only when the platform
  // isn't the sender, or the email names it explicitly as the employer ("at HackerRank",
  // "HackerRank Inc Hiring Team"): platforms hire for themselves too.
  const add = (raw: string | null | undefined, confidence: number, source: string, allowPlatform = !entry) => {
    const display = raw ? cleanCompany(raw, allowPlatform) : null;
    if (display) candidates.push({ display, confidence, source });
  };

  for (const { pattern, confidence, source } of COMPANY_PATTERNS) add(pattern.exec(text)?.[1], confidence, source);
  for (const pattern of SUBJECT_PATTERNS) add(pattern.exec(email.subject)?.[1], 0.7, 'subject', true);
  if (displayName && !isFreeMail(senderDomain)) {
    for (const pattern of DISPLAY_NAME_PATTERNS) add(pattern.exec(displayName)?.[1], 0.7, 'sender_name', true);
  }

  // Domains and ATS slugs are reliable but ugly ("tatvafintech"): use the matching phrase from the
  // text when there is one ("Tatva Fintech"), else a title-cased fallback.
  const fullText = `${email.subject}\n${text}\n${displayName}`;
  const fromBase = (base: string | null, confidence: number, source: string) => {
    if (!base) return;
    const aligned = alignToText(base, fullText);
    add(aligned ?? titleCase(base), aligned ? confidence + 0.15 : confidence, source);
  };

  const haystacks = [...email.links.map((l) => l.href), senderDomain];
  for (const registry of REGISTRY) {
    for (const pattern of registry.tenantPatterns ?? []) {
      for (const hay of haystacks) {
        const slug = pattern.exec(hay)?.[1];
        if (slug && !['www', 'jobs', 'careers', 'apply', 'app'].includes(slug.toLowerCase())) fromBase(squash(slug), 0.7, 'ats_tenant');
      }
    }
  }
  if (senderDomain && !entry && !isFreeMail(senderDomain)) fromBase(domainBase(senderDomain), 0.65, 'sender_domain');
  const organizer = email.calendar?.organizerDomain;
  if (organizer && !findRegistryEntry(organizer) && !isFreeMail(organizer)) fromBase(domainBase(organizer), 0.6, 'calendar');

  if (candidates.length === 0) return null;

  // Group candidates that name the same company ("Pixelwave" slug and "Pixelwave Studios" text).
  // Agreement between independent sources raises confidence; the text form is preferred for display.
  const groups: Candidate[][] = [];
  for (const c of candidates) {
    const s = squash(companyKey(c.display));
    const group = groups.find((g) =>
      g.some((o) => {
        const t = squash(companyKey(o.display));
        return s === t || (Math.min(s.length, t.length) >= 5 && (s.startsWith(t) || t.startsWith(s)));
      }),
    );
    if (group) group.push(c);
    else groups.push([c]);
  }
  let best: { display: string; confidence: number; source: string } | null = null;
  for (const group of groups) {
    // A name seen only in the subject line is too often a phrase ("Application Update"): it needs
    // the body, sender or links to agree.
    if (group.every((g) => g.source === 'subject')) continue;
    const top = group.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const confidence = Math.min(0.98, top.confidence + 0.08 * (new Set(group.map((g) => g.source)).size - 1));
    const textual = group.filter((g) => g.source !== 'ats_tenant' && g.source !== 'sender_domain' && g.source !== 'calendar');
    const display = (textual.length ? textual : group).reduce((a, b) => (b.display.length < a.display.length ? b : a)).display; // shortest clean form: "Tatva Fintech", not "… Pvt. Ltd."
    if (!best || confidence > best.confidence) best = { display, confidence, source: top.source };
  }
  return best && { display: best.display, key: companyKey(best.display), source: best.source, confidence: Math.round(best.confidence * 100) / 100 };
}

/** "careers.tatvafintech.co.in" → "tatvafintech". */
function domainBase(domain: string): string | null {
  const name = companyFromDomain(domain);
  return name ? squash(name) : null;
}

// ---- role ---------------------------------------------------------------------------------------

const ROLE_STOP = String.raw`(?=\s+(?:at|with|in|position|role|opening|internship at|has|was|is|for)\b|\s*[.,;:!?\n(|–—]|\s+-\s|$)`;
const ROLE_PATTERNS: Array<{ pattern: RegExp; confidence: number; subjectOnly?: boolean }> = [
  { pattern: new RegExp(String.raw`\bfor the (?:position|role|post|opening|job) (?:of |as )?["“']?([^"”'\n.,;:()|]{2,80}?)["”']?${ROLE_STOP}`, 'i'), confidence: 0.85 },
  { pattern: /\bfor the ([^"”'\n.,;:()|]{2,80}?) (?:role|position|opening|internship|vacancy)\b/i, confidence: 0.85 },
  { pattern: /\b(?:applying|applied) to the ([^"”'\n.,;:()|]{2,80}?) (?:role|position|opening|internship)\b/i, confidence: 0.85 },
  { pattern: /\bapplication was sent to [^\n]{2,80}\n([^\n]{2,80})/, confidence: 0.8 },
  { pattern: /\b(?:applied|applying) to ([^"”'\n.,;:()|]{2,80}?) at [A-Z]/, confidence: 0.8 },
  { pattern: new RegExp(String.raw`\b(?:application|applying|applied) for (?:the )?(?:position of |role of |post of )?["“']?([^"”'\n.,;:()|]{2,80}?)["”']?${ROLE_STOP}`, 'i'), confidence: 0.8 },
  { pattern: new RegExp(String.raw`\b(?:position|role|job title|designation|profile|opening)\s*[:\-–]\s*([^\n|]{2,80}?)\s*(?:\n|\||$|\s{2})`, 'i'), confidence: 0.85 },
  { pattern: new RegExp(String.raw`\b(?:interview|assessment|test|challenge) for (?:the )?["“']?([^"”'\n.,;:()|]{2,80}?)["”']?(?: (?:position|role))?${ROLE_STOP}`, 'i'), confidence: 0.75 },
  { pattern: new RegExp(String.raw`\b(?:as|as an?|for an?) ([A-Z][^\n.,;:()|]{2,60}?) (?:at|with|in) [A-Z]`), confidence: 0.6 },
  // Subject tails: "Interview Invitation – Data Analyst", "Next steps for SDE Intern".
  { pattern: /^.{0,200}(?:[-–—:|]|\bfor)\s+([^-–—:|()\n]{2,80}?)\s*(?:\((?:[^()]{0,30})\))?\s*$/, confidence: 0.65, subjectOnly: true },
];

const ROLE_WORDS = /\b(engineer|engineering|developer|development|intern|internship|trainee|analyst|analytics|manager|designer|design|scientist|science|associate|consultant|executive|specialist|lead|architect|administrator|officer|sde|swe|sdet|programmer|tester|qa|researcher|research|writer|marketing|sales|operations|product|data|devops|frontend|front-end|backend|back-end|full stack|full-stack|fullstack|ml|ai|machine learning|cloud|security|support|accountant|finance|hr|recruiter|teacher|graduate|fresher|apprentice|technician|coordinator|director|head|staff|member of technical staff|mts)\b/i;

const ROLE_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bsde\b/g, 'software development engineer'],
  [/\bswe\b/g, 'software engineer'],
  [/\bsdet\b/g, 'software development engineer in test'],
  [/\bml\b/g, 'machine learning'],
  [/\bai\b/g, 'artificial intelligence'],
  [/\bqa\b/g, 'quality assurance'],
  [/\bmts\b/g, 'member of technical staff'],
  [/\bsr\.?\b/g, 'senior'],
  [/\bjr\.?\b/g, 'junior'],
  [/\bfront[- ]end\b/g, 'frontend'],
  [/\bback[- ]end\b/g, 'backend'],
  [/\bfull[- ]?stack\b/g, 'fullstack'],
];

/** Canonical role key: "SDE Intern (R-123) – Remote" → "software development engineer intern". */
export function roleKey(title: string): string {
  let key = title
    .toLowerCase()
    .replace(/\((?:[^()]{0,40})\)/g, ' ')
    .replace(/\b(?:r|jr|req)-?\d{3,10}\b/g, ' ')
    .replace(/[-–—|,]\s*(?:remote|hybrid|on-?site|bangalore|bengaluru|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|noida|chennai|india)\b.*$/g, ' ');
  for (const [pattern, replacement] of ROLE_ABBREVIATIONS) key = key.replace(pattern, replacement);
  return key.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveRole(email: NormalizedEmail, text: string, company: Extraction['company']): Extraction['role'] {
  const companySquash = company ? squash(company.key) : null;
  for (const [source, isSubject] of [[text, false], [email.subject, true]] as const) {
    for (const { pattern, confidence, subjectOnly } of ROLE_PATTERNS) {
      if (subjectOnly && !isSubject) continue;
      const raw = pattern.exec(source)?.[1]?.trim();
      if (!raw) continue;
      const title = raw.replace(/^(?:the|a|an|our)\s+/i, '').replace(/\s+(?:position|role|job)$/i, '').trim();
      if (title.length < 2 || title.length > 80 || !isPlausibleRole(title)) continue;
      // Never return the company as the role ("applying to Granite Analytics").
      if (companySquash && squash(title).includes(companySquash)) continue;
      return { title, key: roleKey(title), confidence };
    }
  }
  return null;
}

// ---- other fields -------------------------------------------------------------------------------

function resolveEmploymentType(text: string, role: string | null): EmploymentType {
  const hay = `${role ?? ''} ${text}`.toLowerCase();
  if (/\b(intern|internship|summer intern|winter intern|stipend|ppo)\b/.test(hay)) return 'internship';
  if (/\b(part[- ]time)\b/.test(hay)) return 'part_time';
  if (/\b(contract|contractual|contractor|freelance|fixed[- ]term)\b/.test(hay)) return 'contract';
  if (/\b(full[- ]time|fte|permanent|new grad|graduate (program|programme)|\d+(\.\d+)? ?lpa|ctc)\b/.test(hay)) return 'full_time';
  return 'unknown';
}

const REQ_PATTERN = /\b(?:req(?:uisition)?|job|posting|vacancy)\s*(?:id|no\.?|number|#|code)\s*[:#\-–]?\s*([A-Z0-9][A-Z0-9_-]{2,24})\b/i;
const WORKDAY_REQ = /\((R-?\d{4,8}|JR-?\d{3,8})\)|\b(JR-?\d{4,8}|R-\d{4,8})\b/;
const APPLICATION_REF = /\b(?:application|candidate|reference|ref)\s*(?:id|no\.?|number|#)\s*[:#\-–]?\s*([A-Z0-9][A-Z0-9_-]{3,24})\b/i;
const NOT_IDS = new Set(['is', 'has', 'was', 'and', 'the', 'for', 'number', 'please']);

function pickId(match: RegExpExecArray | null): string | null {
  const id = (match?.[1] ?? match?.[2])?.toUpperCase() ?? null;
  return id && !NOT_IDS.has(id.toLowerCase()) && /\d/.test(id) ? id : null;
}

function resolveJob(email: NormalizedEmail): { jobPostingId: string | null; jobUrl: string | null } {
  for (const link of email.links) {
    for (const entry of REGISTRY) {
      for (const pattern of entry.postingPatterns ?? []) {
        const id = pattern.exec(link.href)?.[1];
        if (id) return { jobPostingId: `${entry.id}:${id.toLowerCase()}`, jobUrl: link.href };
      }
    }
  }
  return { jobPostingId: null, jobUrl: null };
}

const DEADLINE_CONTEXT = /\b(by|before|deadline|due|expires?|expiry|valid (till|until)|complete within|no later than|last date)\b[^.\n]{0,25}$/i;

function resolveDates(
  email: NormalizedEmail,
  category: Category,
  timeZone: string,
): Pick<Extraction, 'eventAt' | 'deadlineAt' | 'eventSource'> {
  const wantsDates = category.startsWith('INTERVIEW') || category.startsWith('ASSESSMENT');
  if (!wantsDates) return { eventAt: null, deadlineAt: null, eventSource: null };
  if (email.calendar?.start) return { eventAt: email.calendar.start, deadlineAt: null, eventSource: 'calendar' };

  let text = `${email.subject}\n${email.text || email.snippet}`.slice(0, 20_000);
  // "Date: 14 October 2026" and "Time: 3:00 PM IST" on separate lines: read them together.
  const dateLine = /^\s*date\s*[:\-–]\s*([^\n]{4,60})$/im.exec(text)?.[1];
  const timeLine = /^\s*time\s*[:\-–]\s*([^\n]{3,40})$/im.exec(text)?.[1];
  if (dateLine && timeLine) text = `on ${dateLine.trim()} at ${timeLine.trim()}\n${text}`;
  const reference = { instant: email.internalDate, timezone: timeZoneOffsetMinutes(timeZone, email.internalDate) };
  let eventAt: Date | null = null;
  let deadlineAt: Date | null = null;
  for (const result of chrono.parse(text, reference, { forwardDate: true })) {
    // Only dates with a day, and not in the past relative to the email.
    if (!result.start.isCertain('day') && !result.start.isCertain('weekday')) continue;
    const date = startOfDayIfNoTime(result, timeZone);
    if (date.getTime() < email.internalDate.getTime() - 3600_000) continue;
    const before = text.slice(Math.max(0, result.index - 40), result.index);
    if (DEADLINE_CONTEXT.test(before)) deadlineAt ??= date;
    else eventAt ??= date;
    if (eventAt && deadlineAt) break;
  }
  if (category.startsWith('ASSESSMENT') && !deadlineAt && eventAt && !/\b(scheduled|on|at)\b/i.test(text)) {
    deadlineAt = eventAt;
    eventAt = null;
  }
  return { eventAt, deadlineAt, eventSource: eventAt || deadlineAt ? 'text' : null };
}

/** Parses one date phrase (e.g. quoted by the AI) relative to the email's date, in the user's zone. */
/** "Data Analyst" yes; "Campus28-PES University, Bengaluru" no. */
export function isPlausibleRole(title: string): boolean {
  if (!ROLE_WORDS.test(title)) return false;
  // Mostly a place or institution, with at most a weak role word: not a job title.
  return !/\b(university|college|institute|campus\d*|school|academy)\b/i.test(title) || /\b(engineer|developer|analyst|intern|designer|scientist|manager|associate|trainee)\b/i.test(title);
}

/** A date phrase with no time ("Sunday, October 4th") becomes that day at 00:00 in the user's zone. */
function startOfDayIfNoTime(result: chrono.ParsedResult, timeZone: string): Date {
  const date = result.start.date();
  if (result.start.isCertain('hour')) return date;
  const offset = timeZoneOffsetMinutes(timeZone, date) * 60_000;
  const local = new Date(date.getTime() + offset);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset);
}

/** For shortlist emails: shortlisted for an assessment, or for an interview? */
export function detectNextStep(text: string): 'assessment' | 'interview' | null {
  const t = text.toLowerCase();
  const m =
    /\bshortlist\w*\b.{0,80}?\b(assessment|test|aptitude|coding round|online round|assignment|interview)/.exec(t) ??
    /\b(assessment|test|aptitude|coding round|online round|assignment|interview)\b.{0,40}?\bshortlist/.exec(t);
  if (!m) return null;
  return m[1] === 'interview' ? 'interview' : 'assessment';
}

export function parseDatePhrase(phrase: string, email: NormalizedEmail, timeZone: string): Date | null {
  const reference = { instant: email.internalDate, timezone: timeZoneOffsetMinutes(timeZone, email.internalDate) };
  const result = chrono.parse(phrase.slice(0, 200), reference, { forwardDate: true })[0];
  if (!result || (!result.start.isCertain('day') && !result.start.isCertain('weekday'))) return null;
  return startOfDayIfNoTime(result, timeZone);
}

export function extract(email: NormalizedEmail, category: Category, options: { timeZone?: string } = {}): Extraction {
  const text = `${email.text || email.snippet}`.slice(0, 20_000);
  const company = resolveCompany(email, text);
  const role = resolveRole(email, text, company);
  const entry = findRegistryEntry(email.from?.domain);
  return {
    company,
    role,
    employmentType: resolveEmploymentType(`${email.subject} ${text}`, role?.title ?? null),
    reqId: pickId(REQ_PATTERN.exec(`${email.subject}\n${text}`)) ?? pickId(WORKDAY_REQ.exec(email.subject)),
    applicationRef: pickId(APPLICATION_REF.exec(text)),
    ...resolveJob(email),
    platform: entry?.name ?? (email.from && !isFreeMail(email.from.domain) ? 'Direct' : 'Unknown'),
    ...resolveDates(email, category, options.timeZone ?? 'Asia/Kolkata'),
    nextStep: category === 'SHORTLISTED' ? detectNextStep(`${email.subject}\n${text}`) : null,
  };
}
