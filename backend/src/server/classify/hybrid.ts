import type { AiClassifier, AiVerdict, PrivacyContext } from '../ai/classify-ai';
import type { NormalizedEmail } from '../email/types';
import { analyze, shouldFetchBody, type Analysis } from './analyze';
import { isRelevant, LIFECYCLE_CATEGORIES, type Category } from './categories';
import { PERSONAL_EVIDENCE } from './classifier';
import { companyKey, extract, isPlausibleRole, parseDatePhrase, roleKey } from './extract';
import { findRegistryEntry } from './registry';

/**
 * Rules + AI, checking each other (docs/plan §7.5 / §7.9).
 *
 *  1. The rules run first. Security mail, job alerts, bulk hiring newsletters and hackathons/events
 *     are blocked there and NEVER sent to the AI (privacy, and the free tier's daily budget).
 *  2. Emails that might be job-related go to the AI as well.
 *  3. Agreement → accepted. Disagreement → the better-grounded answer is used and the email is
 *     flagged for review. A real application is never silently dropped on the AI's word alone.
 *
 * Rate-limit/outage errors propagate (the caller defers the email and retries later);
 * an unusable AI reply falls back to the rules with a review flag.
 */
export interface HybridOptions {
  timeZone: string;
  ai?: { classifier: AiClassifier; privacy: PrivacyContext } | null;
}

const LIFECYCLE_RULE_PREFIX = /^(app|assess|iv|short|offer|rej|info|withdraw|outreach)\./;
const HARD_BLOCKS = new Set(['gate.security', 'gate.bulk-generic', 'gate.kitchen-sink', 'gate.event', 'alert.sender']);

const ACCEPT_ALONE = 0.85; // AI found a job email the rules had no opinion on
const USE_ON_DISAGREEMENT = 0.7;

/** Would the AI be asked about this email? (Blocked mail and clearly unrelated mail: no.) */
export function needsAiCheck(email: NormalizedEmail, rulesResult: Analysis): boolean {
  if (email.detail !== 'full') return false;
  const hits = rulesResult.classification.ruleHits;
  if (hits.some((h) => HARD_BLOCKS.has(h))) return false;
  return rulesResult.relevant || hits.some((h) => LIFECYCLE_RULE_PREFIX.test(h)) || shouldFetchBody(email);
}

export async function analyzeHybrid(email: NormalizedEmail, options: HybridOptions): Promise<Analysis> {
  const base = analyze(email, { timeZone: options.timeZone });
  if (!options.ai || email.detail !== 'full') return base;

  const hits = base.classification.ruleHits;
  if (hits.some((h) => HARD_BLOCKS.has(h))) return mark(base, 'ai.skipped-blocked');
  if (!needsAiCheck(email, base)) return mark(base, 'ai.skipped-unrelated');
  const rulesHadOpinion = base.relevant || hits.some((h) => LIFECYCLE_RULE_PREFIX.test(h));

  const verdict = await options.ai.classifier.classify(email, options.ai.privacy);
  return combine(email, base, verdict, rulesHadOpinion, options.timeZone);
}

/** Rules-only result after an unusable AI reply: kept, but anything job-related gets reviewed. */
export function rulesFallback(email: NormalizedEmail, timeZone: string): Analysis {
  const base = analyze(email, { timeZone });
  if (base.relevant) base.classification.needsReview = true;
  return mark(base, 'ai.fallback');
}

function mark(analysis: Analysis, marker: string): Analysis {
  analysis.classification.ruleHits.push(marker);
  return analysis;
}

export function combine(email: NormalizedEmail, base: Analysis, ai: AiVerdict, rulesHadOpinion: boolean, timeZone: string): Analysis {
  const rules = base.classification;
  // "Interview" about hiring in general, not the reader's own candidacy, isn't an application event.
  const aiCategory: Category = LIFECYCLE_CATEGORIES.has(ai.category) && !ai.aboutOwnApplication ? 'UNRELATED' : ai.category;
  const rulesRelevant = isRelevant(rules.category);
  const aiRelevant = isRelevant(aiCategory);
  const rulesPersonal = rules.ruleHits.some((h) => PERSONAL_EVIDENCE.has(h));

  let category: Category;
  let needsReview: boolean;
  let marker: string;
  if (aiCategory === rules.category) {
    category = rules.category;
    needsReview = ai.confidence < 0.6;
    marker = 'ai.agree';
  } else if (!rulesRelevant && !aiRelevant) {
    category = aiCategory;
    needsReview = false;
    marker = 'ai.agree-not-job';
  } else if (aiRelevant && !rulesHadOpinion && ai.confidence >= ACCEPT_ALONE) {
    category = aiCategory;
    needsReview = false;
    marker = 'ai.found';
  } else if (aiRelevant && ai.confidence >= USE_ON_DISAGREEMENT) {
    category = aiCategory;
    needsReview = true;
    marker = 'ai.override';
  } else if (!aiRelevant && rulesRelevant && !rulesPersonal && ai.confidence >= USE_ON_DISAGREEMENT) {
    category = aiCategory;
    needsReview = false;
    marker = 'ai.dropped-weak-rules';
  } else {
    category = rules.category;
    needsReview = rulesRelevant;
    marker = 'ai.disputed';
  }

  const confidence = marker === 'ai.agree' ? Math.max(rules.confidence, ai.confidence) : ai.confidence;
  const classification = {
    ...rules,
    category,
    confidence: Math.round(confidence * 100) / 100,
    needsReview,
    ruleHits: [...rules.ruleHits, marker, ...ai.rejectedFields.map((f) => `ai.rejected-${f}`)],
  };
  if (!isRelevant(category)) return { classification, extraction: null, relevant: false };

  // Fields: the AI's grounded answers first, the rules as fallback.
  const fromRules = base.extraction ?? extract(email, category, { timeZone });
  const extraction = { ...fromRules };
  if (ai.company) {
    // A platform's name is the employer only if the platform isn't just delivering the email for
    // someone else (HackerRank hiring for itself is fine; HackerRank sending Acme's test is not).
    const senderEntry = findRegistryEntry(email.from?.domain);
    const platformSendingForOthers = ai.companyIsPlatform && senderEntry && companyKey(senderEntry.name) === companyKey(ai.company) && fromRules.company && !keysCompatible(fromRules.company.key, companyKey(ai.company));
    if (!platformSendingForOthers) {
      const key = companyKey(ai.company);
      if (fromRules.company && !keysCompatible(fromRules.company.key, key)) classification.needsReview = true;
      extraction.company = { display: ai.company, key, source: 'ai', confidence: 0.9 };
    }
  }
  // Recruiter outreach: the sender is usually an agency, not the employer. Only an employer the AI
  // found named in the email counts, never a fallback from the sender's domain.
  if (category === 'RECRUITER_OUTREACH' && !ai.company) extraction.company = null;
  if (ai.role && isPlausibleRole(ai.role)) extraction.role = { title: ai.role, key: roleKey(ai.role), confidence: 0.9 };
  else if (extraction.role && !isPlausibleRole(extraction.role.title)) extraction.role = null;
  if (ai.employmentType !== 'unknown') extraction.employmentType = ai.employmentType;
  if (category === 'SHORTLISTED' && ai.nextStep) extraction.nextStep = ai.nextStep;
  if (!email.calendar?.start && ai.dateText) {
    const when = parseDatePhrase(ai.dateText, email, timeZone);
    if (when && ai.dateKind === 'deadline') {
      extraction.deadlineAt = when;
      extraction.eventSource = 'text';
    } else if (when && ai.dateKind === 'event') {
      extraction.eventAt = when;
      extraction.eventSource = 'text';
    }
  }
  if (LIFECYCLE_CATEGORIES.has(category) && !extraction.company) classification.needsReview = true;
  return { classification, extraction, relevant: true };
}

const squash = (s: string) => s.replace(/[^a-z0-9]/g, '');
function keysCompatible(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
}
