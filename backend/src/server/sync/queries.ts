/**
 * Candidate search queries for the backfill (docs/plan §6.3, Step 1). Several overlapping
 * families so that no single keyword list decides recall; the ledger de-duplicates overlaps.
 * Gmail's `q` searches subject AND body. Job alerts are deliberately NOT excluded here: the
 * classifier separates them later, which keeps recall high.
 *
 * Changing these? Bump QUERY_VERSION.
 */
export const QUERY_VERSION = 1;

const RECRUITING_DOMAINS = [
  // Applicant tracking systems
  'greenhouse.io', 'lever.co', 'myworkday.com', 'myworkdayjobs.com', 'smartrecruiters.com', 'icims.com',
  'ashbyhq.com', 'taleo.net', 'successfactors.com', 'zohorecruit.com', 'darwinbox.in', 'keka.com', 'freshteam.com',
  // Job boards
  'linkedin.com', 'naukri.com', 'internshala.com', 'foundit.in', 'indeed.com', 'instahyre.com', 'cutshort.io',
  'wellfound.com', 'unstop.com', 'glassdoor.com',
  // Assessment and interview platforms
  'hackerrank.com', 'hackerearth.com', 'codility.com', 'codesignal.com', 'mettl.com', 'shl.com', 'talview.com',
  'imocha.io', 'calendly.com', 'goodtime.io',
];

const APPLICATION_PHRASES = [
  '"thank you for applying"', '"your application"', '"application received"', '"we received your application"',
  '"application status"', '"applied for"', '"candidate id"', '"application id"',
];

const STAGE_WORDS = [
  'interview', 'assessment', '"online test"', '"coding test"', '"coding challenge"', 'shortlisted',
  '"offer letter"', '"next steps"', '"regret to inform"', '"not moving forward"',
];

const EXCLUSIONS = '-in:chats -in:drafts -in:sent';

export function candidateQueries(windowStart: Date): Record<string, string> {
  const after = `after:${Math.floor(windowStart.getTime() / 1000)}`;
  return {
    registry: `from:(${RECRUITING_DOMAINS.join(' OR ')}) ${after} ${EXCLUSIONS}`,
    phrases: `(${APPLICATION_PHRASES.join(' OR ')}) ${after} ${EXCLUSIONS}`,
    stages: `(${STAGE_WORDS.join(' OR ')}) ${after} ${EXCLUSIONS}`,
    invites: `filename:ics ${after} ${EXCLUSIONS}`,
  };
}
