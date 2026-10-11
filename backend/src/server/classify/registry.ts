/**
 * Sender registry (docs/plan §7.4): known recruiting platforms and what their emails mean.
 * Curated from public knowledge; contains no user data. Sending domains and local-parts
 * marked [A] are assumptions to confirm against real samples as they're seen.
 *
 * The key idea: the SENDER is often not the EMPLOYER. An email from greenhouse.io or
 * hackerrank.com is about an application to some other company.
 */
export type SenderRole =
  | 'ats' // applicant tracking system, sends on behalf of employers
  | 'job_board' // also sends job alerts
  | 'assessment' // online tests
  | 'scheduler' // interview scheduling
  | 'campus' // college placement platforms
  | 'events' // hackathons, competitions, fellowships: never job applications
  | 'employer' // the company itself (not in this list; inferred)
  | 'personal' // a person on a free-mail address (recruiters often are)
  | 'unknown';

export interface RegistryEntry {
  id: string;
  /** Platform name as shown to users; never treated as the employer. */
  name: string;
  role: SenderRole;
  domains: string[];
  /** Sender local-parts that only send alerts/newsletters. */
  alertLocalParts?: RegExp;
  /** Patterns that pull the employer's slug out of job URLs (also used on sender subdomains). */
  tenantPatterns?: RegExp[];
  /** Patterns that pull a job posting id out of job URLs. */
  postingPatterns?: RegExp[];
}

export const REGISTRY: RegistryEntry[] = [
  // --- Applicant tracking systems ---
  {
    id: 'greenhouse', name: 'Greenhouse', role: 'ats', domains: ['greenhouse.io', 'greenhouse-mail.io'],
    tenantPatterns: [/(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9-]{2,60})/i],
    postingPatterns: [/greenhouse\.io\/[a-z0-9-]+\/jobs\/(\d{4,12})/i],
  },
  {
    id: 'lever', name: 'Lever', role: 'ats', domains: ['lever.co', 'hire.lever.co'],
    tenantPatterns: [/jobs\.lever\.co\/([a-z0-9-]{2,60})/i],
    postingPatterns: [/jobs\.lever\.co\/[a-z0-9-]+\/([0-9a-f-]{36})/i],
  },
  {
    id: 'workday', name: 'Workday', role: 'ats', domains: ['myworkday.com', 'myworkdayjobs.com', 'workday.com'],
    tenantPatterns: [/([a-z0-9-]{2,60})\.wd\d{1,2}\.myworkday(?:jobs)?\.com/i],
    postingPatterns: [/myworkdayjobs\.com\/.{0,200}?_((?:JR|R)-?\d{3,10})/i],
  },
  {
    id: 'ashby', name: 'Ashby', role: 'ats', domains: ['ashbyhq.com'],
    tenantPatterns: [/jobs\.ashbyhq\.com\/([^/?#\s]{2,60})/i],
    postingPatterns: [/jobs\.ashbyhq\.com\/[^/?#\s]+\/([0-9a-f-]{36})/i],
  },
  {
    id: 'smartrecruiters', name: 'SmartRecruiters', role: 'ats', domains: ['smartrecruiters.com'],
    tenantPatterns: [/(?:jobs|careers)\.smartrecruiters\.com\/([^/?#\s]{2,60})/i],
    postingPatterns: [/smartrecruiters\.com\/[^/?#\s]+\/(\d{6,16})/i],
  },
  { id: 'icims', name: 'iCIMS', role: 'ats', domains: ['icims.com'], tenantPatterns: [/careers-([a-z0-9-]{2,60})\.icims\.com/i] },
  { id: 'taleo', name: 'Oracle Taleo', role: 'ats', domains: ['taleo.net'], tenantPatterns: [/([a-z0-9-]{2,60})\.taleo\.net/i] },
  { id: 'oracle-hcm', name: 'Oracle Recruiting', role: 'ats', domains: ['oraclecloud.com'] },
  { id: 'successfactors', name: 'SAP SuccessFactors', role: 'ats', domains: ['successfactors.com', 'successfactors.eu', 'sapsf.com'] },
  { id: 'zoho-recruit', name: 'Zoho Recruit', role: 'ats', domains: ['zohorecruit.com', 'zohorecruit.in'] },
  { id: 'darwinbox', name: 'Darwinbox', role: 'ats', domains: ['darwinbox.in', 'darwinbox.com'], tenantPatterns: [/([a-z0-9-]{2,60})\.darwinbox\.in/i] },
  { id: 'keka', name: 'Keka', role: 'ats', domains: ['keka.com'], tenantPatterns: [/([a-z0-9-]{2,60})\.keka\.com/i] },
  { id: 'freshteam', name: 'Freshteam', role: 'ats', domains: ['freshteam.com'], tenantPatterns: [/([a-z0-9-]{2,60})\.freshteam\.com/i] },
  { id: 'recruitee', name: 'Recruitee', role: 'ats', domains: ['recruitee.com'], tenantPatterns: [/([a-z0-9-]{2,60})\.recruitee\.com/i] },
  { id: 'workable', name: 'Workable', role: 'ats', domains: ['workable.com', 'workablemail.com'], tenantPatterns: [/apply\.workable\.com\/([a-z0-9-]{2,60})/i] },

  // --- Job boards (application confirmations AND alerts) ---
  {
    id: 'linkedin', name: 'LinkedIn', role: 'job_board', domains: ['linkedin.com'],
    // [A] jobs-noreply@ sends "Your application was sent to…"; these send alerts/digests.
    alertLocalParts: /^(jobalerts-noreply|jobs-listings|messages-noreply|news|editors|groups-noreply|notifications-noreply|invitations)$/,
    postingPatterns: [/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d{6,14})/i],
  },
  { id: 'naukri', name: 'Naukri', role: 'job_board', domains: ['naukri.com', 'naukrimail.com'], alertLocalParts: /^(jobalert|jobalerts|recommendedjobs|info|newsletter|naukrialerts)$/ },
  { id: 'internshala', name: 'Internshala', role: 'job_board', domains: ['internshala.com'], alertLocalParts: /^(newsletter|jobs|internships|recommendations)$/ },
  { id: 'foundit', name: 'foundit', role: 'job_board', domains: ['foundit.in', 'monsterindia.com'], alertLocalParts: /^(jobalert|alerts|newsletter)$/ },
  { id: 'indeed', name: 'Indeed', role: 'job_board', domains: ['indeed.com', 'indeedemail.com'], alertLocalParts: /^(alert|alerts|jobalert|donotreply-jobalert)$/, postingPatterns: [/indeed\.com\/.{0,100}?jk=([0-9a-f]{12,20})/i] },
  { id: 'instahyre', name: 'Instahyre', role: 'job_board', domains: ['instahyre.com'], alertLocalParts: /^(jobs|newsletter|opportunities)$/ },
  { id: 'cutshort', name: 'Cutshort', role: 'job_board', domains: ['cutshort.io'], alertLocalParts: /^(jobs|newsletter|digest)$/ },
  { id: 'wellfound', name: 'Wellfound', role: 'job_board', domains: ['wellfound.com', 'angel.co'], alertLocalParts: /^(digest|newsletter|jobs)$/ },
  { id: 'unstop', name: 'Unstop', role: 'job_board', domains: ['unstop.com', 'unstop.news', 'unstop.events', 'unstop.email', 'dare2compete.com'], alertLocalParts: /^(newsletter|opportunities|digest)$/ },
  { id: 'glassdoor', name: 'Glassdoor', role: 'job_board', domains: ['glassdoor.com', 'glassdoor.co.in'], alertLocalParts: /^(jobalerts|jobalert)$/ },
  { id: 'apna', name: 'apna', role: 'job_board', domains: ['apna.co'] },

  // --- Assessment platforms ---
  { id: 'hackerrank', name: 'HackerRank', role: 'assessment', domains: ['hackerrank.com', 'hackerrankforwork.com'] },
  { id: 'hackerearth', name: 'HackerEarth', role: 'assessment', domains: ['hackerearth.com'] },
  { id: 'codility', name: 'Codility', role: 'assessment', domains: ['codility.com'] },
  { id: 'codesignal', name: 'CodeSignal', role: 'assessment', domains: ['codesignal.com'] },
  { id: 'mettl', name: 'Mercer Mettl', role: 'assessment', domains: ['mettl.com'] },
  { id: 'shl', name: 'SHL', role: 'assessment', domains: ['shl.com', 'myamcat.com', 'aspiringminds.com'] },
  { id: 'talview', name: 'Talview', role: 'assessment', domains: ['talview.com'] },
  { id: 'imocha', name: 'iMocha', role: 'assessment', domains: ['imocha.io'] },
  { id: 'testgorilla', name: 'TestGorilla', role: 'assessment', domains: ['testgorilla.com'] },
  { id: 'hirevue', name: 'HireVue', role: 'assessment', domains: ['hirevue.com'] },

  // --- Scheduling ---
  { id: 'calendly', name: 'Calendly', role: 'scheduler', domains: ['calendly.com'] },
  { id: 'goodtime', name: 'GoodTime', role: 'scheduler', domains: ['goodtime.io'] },

  // --- Hackathons and events (not job applications) ---
  { id: 'devfolio', name: 'Devfolio', role: 'events', domains: ['devfolio.co'] },
  { id: 'mlh', name: 'Major League Hacking', role: 'events', domains: ['mlh.io', 'majorleaguehacking.com'] },
  { id: 'luma', name: 'Luma', role: 'events', domains: ['lu.ma', 'luma-mail.com'] },

  // --- Campus placement ---
  { id: 'superset', name: 'Superset', role: 'campus', domains: ['joinsuperset.com', 'superset.ai'] },
];

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'rediffmail.com', 'protonmail.com', 'proton.me', 'zoho.com', 'aol.com',
]);

export function isFreeMail(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase());
}

/**
 * Exact domain or a true subdomain ("x.greenhouse.io"), never a lookalike suffix
 * ("greenhouse.io.evil.com" or "evilgreenhouse.io").
 */
export function domainMatches(domain: string, registered: string): boolean {
  const d = domain.toLowerCase();
  return d === registered || d.endsWith(`.${registered}`);
}

export function findRegistryEntry(domain: string | undefined | null): RegistryEntry | null {
  if (!domain) return null;
  return REGISTRY.find((entry) => entry.domains.some((registered) => domainMatches(domain, registered))) ?? null;
}

export function senderRole(domain: string | null | undefined): SenderRole {
  if (!domain) return 'unknown';
  const entry = findRegistryEntry(domain);
  if (entry) return entry.role;
  return isFreeMail(domain) ? 'personal' : 'employer';
}

/** Platform names, so extraction never mistakes a platform for the employer. */
export const PLATFORM_NAMES = new Set(REGISTRY.flatMap((e) => [e.name.toLowerCase(), e.id.replace(/-/g, ' ')]));
