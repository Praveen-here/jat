import type { NormalizedEmail } from '../email/types';
import { LIFECYCLE_CATEGORIES, type Category } from './categories';
import { findRegistryEntry, senderRole, type SenderRole } from './registry';

/**
 * Rule-based email classifier (docs/plan §7.5). Deterministic and explainable: every decision
 * lists the rules that fired. No AI (decision Q2).
 *
 * Each rule adds a weight to one category when its pattern appears. The highest-scoring
 * category wins, subject to safety gates:
 *   - APPLICATION_RECEIVED needs real receipt evidence ("we received your application"),
 *     never just a job mention;
 *   - bulk mail with several job links and no receipt evidence is a job alert, whatever else
 *     it says;
 *   - OFFER always goes to the user for review (rare, high-stakes, and easy to mis-read).
 * Low confidence goes to review instead of guessing.
 */
/** Bump when results change; synced mail is then re-processed and applications rebuilt. */
export const CLASSIFIER_VERSION = 4;

/** Text the rules look at: subject + body, lower-cased, whitespace collapsed, capped. */
const MAX_RULE_TEXT = 20_000;

interface Features {
  text: string;
  subject: string;
  role: SenderRole;
  localPart: string;
  isAlertSender: boolean;
  bulk: boolean;
  jobLinkCount: number;
  hasCalendar: boolean;
  calendarSummary: string;
  attachmentNames: string;
}

interface Rule {
  id: string;
  category: Category;
  weight: number;
  /** Receipt evidence: allows APPLICATION_RECEIVED. */
  receipt?: boolean;
  test: (f: Features) => RegExpExecArray | boolean | null;
}

const has = (pattern: RegExp) => (f: Features) => pattern.exec(f.text);
const subjectHas = (pattern: RegExp) => (f: Features) => pattern.exec(f.subject);

const ASSESSMENT_WORDS = /\b(assessment|online test|coding test|coding challenge|aptitude test|hackerrank test|test link|technical test|online exam|quiz)\b/;
const INTERVIEW_WORDS = /\binterview/;

const RULES: Rule[] = [
  // ---- Application received (receipt evidence) ----
  { id: 'app.thanks-applying', category: 'APPLICATION_RECEIVED', weight: 3, receipt: true, test: has(/\bthanks? (you )?for (applying|your application|submitting your application)\b/) },
  { id: 'app.received', category: 'APPLICATION_RECEIVED', weight: 4, receipt: true, test: has(/\b(we('ve| have)|has been|have been) (successfully )?received (your|the) application\b|\bwe (have )?received your (job )?application\b/) },
  { id: 'app.submitted', category: 'APPLICATION_RECEIVED', weight: 4, receipt: true, test: has(/\byour application (for|to) .{1,120}? (has been|was|is) (successfully )?(submitted|received|sent)\b/) },
  { id: 'app.sent-to', category: 'APPLICATION_RECEIVED', weight: 4, receipt: true, test: has(/\byour application was sent to\b/) },
  { id: 'app.applied', category: 'APPLICATION_RECEIVED', weight: 3.5, receipt: true, test: has(/\byou (have )?(successfully )?applied (to|for)\b|\byou('ve| have) successfully applied\b/) },
  { id: 'app.subject', category: 'APPLICATION_RECEIVED', weight: 2, receipt: true, test: subjectHas(/\b(application (received|confirmation|submitted|acknowledg(e)?ment)|thank you for (applying|your application))\b/) },
  { id: 'app.id', category: 'APPLICATION_RECEIVED', weight: 1, test: has(/\b(application|candidate) (id|number|reference)\s*[:#]/) },
  { id: 'app.review', category: 'APPLICATION_RECEIVED', weight: 1.5, test: has(/\b(our (team|recruiters?|hiring team) will (review|be reviewing)|we will review your (application|profile))\b/) },

  // ---- Assessments ----
  { id: 'assess.invited', category: 'ASSESSMENT_INVITE', weight: 4, test: has(/\b(invited|invite you|inviting you|requested|shortlisted) (you )?to (take|complete|attempt|appear for|participate in) .{0,60}?\b(assessment|test|challenge|exam|quiz)\b/) },
  { id: 'assess.has-invited', category: 'ASSESSMENT_INVITE', weight: 3, test: has(/\bhas invited you\b/) },
  { id: 'assess.kind', category: 'ASSESSMENT_INVITE', weight: 2, test: has(/\b(online|coding|technical|aptitude|skills?|cognitive|programming) (assessment|test|challenge|round|exam)\b/) },
  { id: 'assess.complete-the', category: 'ASSESSMENT_INVITE', weight: 2, test: has(/\b(complete|attempt|take|start) (the|this|your) (online |coding |technical )?(assessment|test|challenge)\b/) },
  { id: 'assess.link', category: 'ASSESSMENT_INVITE', weight: 1.5, test: has(/\b(test|assessment|challenge) (link|url|invitation)\b/) },
  { id: 'assess.platform', category: 'ASSESSMENT_INVITE', weight: 2, test: (f) => f.role === 'assessment' },
  { id: 'assess.reminder', category: 'ASSESSMENT_REMINDER', weight: 5.5, test: (f) => (/\b(reminder|gentle reminder|friendly reminder|don'?t forget|yet to (complete|attempt|start)|not (yet )?(started|completed|attempted)|expires? (soon|in|today|tomorrow)|last chance|pending)\b/.test(f.text) && ASSESSMENT_WORDS.test(f.text)) },
  // "Thanks for taking the AI screen", "thank you for completing the online coding assessment"…
  { id: 'assess.completed', category: 'ASSESSMENT_COMPLETED', weight: 6, test: has(/\b(thank you for|thanks for) (completing|taking|submitting|attempting|finishing) (the|your|this) ([a-z0-9-]+ ){0,3}(assessment|test|challenge|screen|screening|assignment|quiz)\b|\byou have (successfully )?(completed|submitted|finished) (the|your) ([a-z0-9-]+ ){0,3}(assessment|test|challenge|screen|screening|assignment)\b|\b(assessment|test|screening|assignment) (has been )?(successfully )?(completed|submitted)\b/) },

  // ---- Interviews ----
  { id: 'iv.invite', category: 'INTERVIEW_INVITE', weight: 4, test: has(/\b(invite|inviting|invited) you (to|for) (an? |the |your )?([a-z-]+ ){0,3}interview\b|\binterview (invitation|invite|scheduled|confirmation|confirmed)\b|\b(like|love|happy|pleased) to (invite you to |schedule |set up )?(an? |your )?([a-z-]+ ){0,2}interview\b/) },
  { id: 'iv.schedule', category: 'INTERVIEW_INVITE', weight: 3, test: has(/\b(schedule|book|pick|select|choose) (a |your )?(time|slot) for (your |the |an )?([a-z-]+ ){0,2}interview\b|\b(schedule|book) (your|an|the) interview\b/) },
  { id: 'iv.round', category: 'INTERVIEW_INVITE', weight: 1.5, test: has(/\b(technical|hr|final|first|second|third|panel|managerial|onsite|virtual|video|phone) (round|interview)\b|\binterview round\b/) },
  { id: 'iv.calendar', category: 'INTERVIEW_INVITE', weight: 4, test: (f) => f.hasCalendar && /\b(interview|screen|round|discussion|conversation|chat)\b/.test(f.calendarSummary) },
  { id: 'iv.scheduler', category: 'INTERVIEW_INVITE', weight: 1.5, test: (f) => f.role === 'scheduler' },
  { id: 'iv.event-scheduled', category: 'INTERVIEW_INVITE', weight: 3, test: (f) => INTERVIEW_WORDS.test(f.text) && /\b(new event|event (type|scheduled)|has been scheduled|is scheduled|scheduled for|confirmed for|you are scheduled)\b/.test(f.text) },
  { id: 'iv.chance-to-interview', category: 'INTERVIEW_INVITE', weight: 4.5, test: has(/\boffer you (an? |the )?(opportunity|chance) to (interview|meet|speak)\b/) },
  { id: 'iv.availability', category: 'INTERVIEW_INVITE', weight: 2, test: (f) => INTERVIEW_WORDS.test(f.text) && /\b(share|send|let us know) (a few |some |your )?(time ?slots|availability|available times)\b/.test(f.text) },
  // A real rescheduling phrase about an interview, not "interview" + "new date" anywhere in a newsletter.
  { id: 'iv.rescheduled', category: 'INTERVIEW_RESCHEDULED', weight: 6.5, test: has(/\binterview\b.{0,80}?\b(has been |was |is being )?reschedul(ed|e)\b|\breschedul(e|ed|ing) (of )?(your |the )?([a-z-]+ ){0,2}interview\b|\bupdated invitation\b.{0,80}?\binterview\b|\binterview\b.{0,60}?\b(moved|changed) to\b/) },
  { id: 'iv.cancelled', category: 'INTERVIEW_CANCELLED', weight: 7.5, test: has(/\binterview\b.{0,80}?\b(has been |is |was )?cancel+ed\b|\bcancel+(ed|ing|ation of) (your |the )?([a-z-]+ ){0,2}interview\b/) },

  // ---- Progress / outcome ----
  { id: 'short.shortlisted', category: 'SHORTLISTED', weight: 4, test: has(/\b(you have been|you've been|you are|you're|your (profile|application) has been) (successfully )?shortlisted\b|\bcongratulations[!,. ]{1,3}.{0,60}?\byou.{0,30}?\bshortlisted\b/) },
  { id: 'short.next-round', category: 'SHORTLISTED', weight: 4, test: has(/\b(moved|moving|move) (you )?(forward|ahead|on) to the next (round|stage|step)\b|\bselected for the next (round|stage)\b|\b(cleared|qualified|passed) the (\w+ ){0,2}(round|test|assessment)\b|\bprogress(ed)? to the next (round|stage)\b/) },
  { id: 'offer.extend', category: 'OFFER', weight: 5, test: has(/\b(pleased|happy|delighted|excited|glad) to (extend|offer|make) (you )?(an? |the |this )?(formal |conditional |job |employment |internship |full[- ]time )?(offer|position|role|internship|job)\b/) },
  { id: 'offer.letter', category: 'OFFER', weight: 3, test: has(/\b(offer letter|letter of offer|offer of employment|internship offer|job offer)\b/) },
  { id: 'offer.terms', category: 'OFFER', weight: 1, test: has(/\b(ctc|cost to company|joining date|date of joining|compensation|stipend of)\b/) },
  { id: 'offer.attachment', category: 'OFFER', weight: 1.5, test: (f) => /offer/i.test(f.attachmentNames) },
  // Trap: "offer you a chance to interview" is not an offer.
  { id: 'offer.not-really', category: 'OFFER', weight: -6, test: has(/\boffer you (an? |the )?(opportunity|chance) to (interview|take|attend|appear|meet|speak)\b/) },
  { id: 'rej.regret', category: 'REJECTION', weight: 5, test: has(/\b(regret to inform|we are sorry to inform|we're sorry to (let you know|inform))\b/) },
  { id: 'rej.not-forward', category: 'REJECTION', weight: 5, test: has(/\b(not|won'?t|will not) be (moving|proceeding|progressing) (forward|ahead)\b|\b(not|unable to) (move|proceed|progress) (forward|ahead|further)\b|\bdecided not to (move|proceed|progress)\b/) },
  { id: 'rej.other-candidates', category: 'REJECTION', weight: 4.5, test: has(/\b(move|moving|proceed|go|going) (forward|ahead) with (other|another|different) (candidates?|applicants?)\b|\bpursue other candidates\b|\bother candidates whose\b/) },
  { id: 'rej.filled', category: 'REJECTION', weight: 4, test: has(/\b(position|role) has (now )?been filled\b|\bnot been selected\b|\bwere not selected\b|\bunsuccessful\b/) },
  { id: 'rej.unfortunately', category: 'REJECTION', weight: 1.5, test: has(/\bunfortunately\b/) },
  { id: 'info.request', category: 'INFO_REQUEST', weight: 4, test: has(/\b(please|kindly) (submit|upload|share|send|provide|fill( out| in)?|complete) .{0,60}?\b(documents?|details|form|information|transcripts?|marksheets?|id proof|certificates?|pan|aadhaar|bank details)\b/) },
  { id: 'info.action', category: 'INFO_REQUEST', weight: 1, test: subjectHas(/\b(action required|documents? required|pending documents)\b/) },
  { id: 'withdraw', category: 'WITHDRAWAL_CONFIRMATION', weight: 6, test: has(/\byou have (successfully )?withdrawn\b|\b(your )?application (has been |was )?withdrawn\b|\bwithdrawal (of your application|confirmed|request)\b/) },

  // ---- Not about your own application ----
  { id: 'outreach.profile', category: 'RECRUITER_OUTREACH', weight: 3.5, test: has(/\b(came across|found|reviewed|saw) your (profile|resume|cv)\b|\b(would you be|are you) (interested|open) (in|to)\b|\b(i('m| am)|we are) (a |an )?(recruiter|talent (acquisition|partner)|hiring (manager|for))\b|\breaching out (to you )?(about|regarding|for)\b/) },
  { id: 'outreach.personal', category: 'RECRUITER_OUTREACH', weight: 1, test: (f) => f.role === 'personal' && /\b(opportunity|position|opening|role)\b/.test(f.text) },
  { id: 'alert.phrases', category: 'JOB_ALERT', weight: 3, test: has(/\bjobs? (you may|you might|that may|that might) (be interested|like)\b|\b(recommended|suggested) (jobs?|for you|internships?)\b|\bjobs? (matching|based on) your\b|\bjob alerts?\b|\bnew jobs? (for you|posted|matching)\b|\b\d+ new (jobs|openings|internships|opportunities)\b|\btop (jobs|companies hiring)\b|\bjobs? for you\b|\bsimilar jobs\b/) },
  { id: 'alert.apply-now', category: 'JOB_ALERT', weight: 1.5, test: has(/\b(apply now|easy apply|view (all )?jobs|see (all|more) jobs|view job)\b/) },
  { id: 'alert.sender', category: 'JOB_ALERT', weight: 5, test: (f) => f.isAlertSender },
  { id: 'alert.links', category: 'JOB_ALERT', weight: 3, test: (f) => f.jobLinkCount >= 3 },
  { id: 'news.marketing', category: 'NEWSLETTER_MARKETING', weight: 2.5, test: has(/\b(webinar|newsletter|masterclass|workshop|upskill|course|courses|certification|certificate|career tips|resume tips|discount|offer ends|enrol|enroll|register now|registrations? (open|close|closing)|free trial|premium|hackathon|competition|contest|prizes?|leaderboard|scholarship|bootcamp|giveaway|early bird|limited seats|subscribe)\b|% off/) },
  { id: 'news.bulk', category: 'NEWSLETTER_MARKETING', weight: 1, test: (f) => f.bulk },
];

/** Rules that only fire on mail about the reader's OWN application (not newsletters about hiring). */
export const PERSONAL_EVIDENCE: ReadonlySet<string> = new Set([
  'app.thanks-applying', 'app.received', 'app.submitted', 'app.sent-to', 'app.applied', 'assess.invited', 'assess.has-invited',
  'assess.completed', 'iv.invite', 'iv.calendar', 'short.shortlisted', 'offer.extend',
  'rej.regret', 'rej.not-forward', 'rej.other-candidates', 'withdraw',
]);

/** Account and security mail (OTPs, password resets, sign-in alerts) is never a job email. */
const SECURITY =
  /\b(otp|one[- ]time (password|passcode|pin|code)|verification code|security code|login code|sign[- ]?in code|passcode|verify your (email|e-mail|account|identity|phone|mobile)|confirm your (email|e-mail|account)|reset (your )?password|password reset|password (has been |was )?(changed|updated)|forgot (your )?password|new (sign[- ]?in|login)|unusual (sign[- ]?in|activity|login)|two[- ](factor|step)|2fa|account (has been )?(created|activated|locked|suspended)|activate your account)\b/;

/** Hackathons, competitions and similar events: about the reader, but not a job application. */
const EVENTS = /\b(hackathon|hacker ?house|ideathon|buildathon|datathon|codeathon|hackfest|hack ?week|game ?jam|fellowship programme|fellowship program|bootcamp|meetup|conference|summit|devfolio|major league hacking)\b/;
/** Words that make an event email actually about a job (e.g. "hiring challenge for SDE roles"). */
const JOB_CONTEXT = /\b(job|jobs|position|employment|full[- ]time role|hiring process|recruitment process|recruitment drive|campus drive|placement drive|offer letter)\b/;

/** Minimum winning score to count as job-related at all. */
const MIN_SCORE = 3;
const CONFIDENT = 0.8;

export interface Classification {
  category: Category;
  confidence: number;
  needsReview: boolean;
  /** IDs of the rules that fired (no email content). */
  ruleHits: string[];
  /** Short text that triggered the winning category, for the user's "why?" view. */
  evidence: string | null;
}

function features(email: NormalizedEmail): Features {
  const text = `${email.subject}\n${email.text || email.snippet}`.toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_RULE_TEXT);
  const domain = email.from?.domain ?? '';
  const entry = findRegistryEntry(domain);
  const localPart = email.from?.address.split('@')[0] ?? '';
  const jobLinks = new Set(
    email.links.map((l) => l.href).filter((href) => /\/(jobs?|careers?|internships?|vacanc(y|ies)|openings?)\b/i.test(href) || /jk=|jobid=|\/jobs\/view\//i.test(href)),
  );
  return {
    text,
    subject: email.subject.toLowerCase(),
    role: senderRole(domain),
    localPart,
    isAlertSender: !!entry?.alertLocalParts?.test(localPart),
    bulk: email.bulk,
    jobLinkCount: jobLinks.size,
    hasCalendar: !!email.calendar,
    calendarSummary: (email.calendar?.summary ?? '').toLowerCase(),
    attachmentNames: email.attachmentNames.join(' '),
  };
}

export function classify(email: NormalizedEmail): Classification {
  const f = features(email);
  const scores = new Map<Category, number>();
  const evidence = new Map<Category, string>();
  const hits: string[] = [];
  let receipt = false;

  for (const rule of RULES) {
    const result = rule.test(f);
    if (!result) continue;
    hits.push(rule.id);
    scores.set(rule.category, (scores.get(rule.category) ?? 0) + rule.weight);
    if (rule.receipt) receipt = true;
    if (Array.isArray(result) && rule.weight > 0 && !evidence.has(rule.category)) {
      evidence.set(rule.category, excerpt(f.text, result.index, result[0].length));
    }
  }

  // Gate: account/security mail (OTP, password reset, sign-in alert) is never a job email.
  if (SECURITY.test(`${f.subject} ${f.text.slice(0, 1500)}`)) {
    return { category: 'UNRELATED', confidence: 0.9, needsReview: false, ruleHits: [...hits, 'gate.security'], evidence: null };
  }

  // Gate: hackathons/events (Devfolio reminders, MLH…) are never job applications, even when they
  // ask the reader to "submit your profile", unless the email is clearly about a job.
  if ((f.role === 'events' || EVENTS.test(`${f.subject} ${f.text.slice(0, 3000)}`)) && !JOB_CONTEXT.test(f.text.slice(0, 3000))) {
    return { category: 'NEWSLETTER_MARKETING', confidence: 0.85, needsReview: false, ruleHits: [...hits, 'gate.event'], evidence: null };
  }

  // Gate: no receipt evidence means it can't be "application received".
  if (!receipt) scores.delete('APPLICATION_RECEIVED');

  // Gate: an offer needs offer wording or an offer document, not just "offer letter" mentioned
  // (onboarding emails ask you to upload your offer letter).
  if (!hits.includes('offer.extend') && !hits.includes('offer.attachment')) scores.delete('OFFER');

  // Gate: bulk mail about hiring in general (newsletters, hackathons, campus mailers, job-board
  // digests) is not about the reader's own application unless it carries personal evidence.
  // Reschedules/cancellations count as personal only when they're about "your" interview
  // ("the interview rounds have been rescheduled" in a newsletter is not).
  const personal =
    hits.some((id) => PERSONAL_EVIDENCE.has(id)) ||
    ((hits.includes('iv.rescheduled') || hits.includes('iv.cancelled')) && /\byour ([a-z-]+ ){0,2}interview\b/.test(f.text));
  const lifecycleHit = new Set(RULES.filter((r) => r.weight > 0 && hits.includes(r.id) && LIFECYCLE_CATEGORIES.has(r.category)).map((r) => r.category));
  const marketing = hits.includes('news.marketing');
  const bulkGeneric = f.bulk && !personal && (marketing || f.role === 'job_board' || f.role === 'campus' || lifecycleHit.size >= 3);
  const kitchenSink = f.bulk && lifecycleHit.size >= 4; // tests, interviews, shortlists AND offers in one email
  if (bulkGeneric || kitchenSink) {
    for (const category of LIFECYCLE_CATEGORIES) scores.delete(category);
    scores.delete('RECRUITER_OUTREACH');
    if (!scores.has('JOB_ALERT')) scores.set('NEWSLETTER_MARKETING', Math.max(scores.get('NEWSLETTER_MARKETING') ?? 0, MIN_SCORE + 1));
    hits.push(kitchenSink ? 'gate.kitchen-sink' : 'gate.bulk-generic');
  }

  // Gate: bulk mail with several job links and no receipt evidence is an alert/digest.
  const looksLikeDigest = (f.bulk || f.isAlertSender) && f.jobLinkCount >= 3 && !receipt;
  if (looksLikeDigest || f.isAlertSender) {
    for (const category of LIFECYCLE_CATEGORIES) scores.delete(category);
    scores.delete('RECRUITER_OUTREACH');
    scores.set('JOB_ALERT', Math.max(scores.get('JOB_ALERT') ?? 0, MIN_SCORE + 2));
  }

  const ranked = [...scores.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top || top[1] < MIN_SCORE) {
    return { category: 'UNRELATED', confidence: top ? 0.6 : 0.9, needsReview: false, ruleHits: hits, evidence: null };
  }

  const [category, score] = top;
  const margin = score - (second?.[1] ?? 0);
  // One strong rule (weight ≥ 4) with a clear lead is confident; close calls are not.
  const confidence = round(sigmoid(1.2 * (score - 2.5)) * (margin >= 2 ? 1 : margin >= 1 ? 0.88 : 0.7));
  const needsReview =
    category === 'OFFER' || (LIFECYCLE_CATEGORIES.has(category) && confidence < CONFIDENT);

  return { category, confidence, needsReview, ruleHits: hits, evidence: evidence.get(category) ?? null };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`.slice(0, 200);
}
