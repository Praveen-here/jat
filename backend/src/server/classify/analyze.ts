import type { NormalizedEmail } from '../email/types';
import { isRelevant, LIFECYCLE_CATEGORIES } from './categories';
import { classify, type Classification } from './classifier';
import { extract, type Extraction } from './extract';
import { findRegistryEntry } from './registry';

export interface Analysis {
  classification: Classification;
  /** Only for relevant emails; nothing is extracted from the rest. */
  extraction: Extraction | null;
  relevant: boolean;
}

export function analyze(email: NormalizedEmail, options: { timeZone?: string } = {}): Analysis {
  const classification = classify(email);
  if (!isRelevant(classification.category)) return { classification, extraction: null, relevant: false };

  const extraction = extract(email, classification.category, options);
  // An application event we can't attach to a company needs the user's eyes.
  if (LIFECYCLE_CATEGORIES.has(classification.category) && !extraction.company) {
    classification.needsReview = true;
  }
  return { classification, extraction, relevant: true };
}

const JOB_WORDS =
  /\b(appl(y|ied|ying|ication)s?|interview\w*|assessments?|tests?|challenge|shortlist\w*|offer|regret|unfortunately|candidate\w*|recruit\w*|hiring|hired|position|role|opportunit(y|ies)|internships?|intern|jobs?|careers?|onboarding|joining|placement|campus|selected|selection|next steps|round)\b/i;

/**
 * Header-only triage for NEW mail (docs/plan §6.4): decides from sender, subject and Gmail's
 * snippet whether to download the body. Tuned for recall: when in doubt, fetch. Personal mail
 * that is clearly not job-related never has its body downloaded.
 */
export function shouldFetchBody(email: NormalizedEmail): boolean {
  const entry = findRegistryEntry(email.from?.domain);
  const localPart = email.from?.address.split('@')[0] ?? '';
  if (entry?.alertLocalParts?.test(localPart) && email.bulk) return false;
  if (entry) return true;
  return JOB_WORDS.test(`${email.subject} ${email.snippet} ${email.from?.name ?? ''}`);
}
