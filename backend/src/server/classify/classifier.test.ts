import { describe, expect, it } from 'vitest';
import { parseAddress } from '../email/normalize';
import type { NormalizedEmail } from '../email/types';
import { analyze, shouldFetchBody } from './analyze';
import { LIFECYCLE_CATEGORIES } from './categories';
import { buildCorpus } from './corpus/corpus';
import { evaluate } from './corpus/evaluate';
import { domainMatches, findRegistryEntry } from './registry';

function mail(from: string, subject: string, text: string, extra: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    id: 'x',
    threadId: null,
    internalDate: new Date('2026-09-01T06:00:00Z'),
    labelIds: ['INBOX'],
    detail: 'full',
    from: parseAddress(from),
    replyTo: null,
    subject,
    snippet: text.slice(0, 140),
    messageIdHeader: null,
    bulk: false,
    text,
    links: [],
    calendar: null,
    attachmentNames: [],
    isForward: false,
    ...extra,
  };
}

/**
 * Hand-written emails phrased differently from the corpus templates: a check that the rules
 * generalise beyond the exact wording they were tuned on.
 */
describe('classifier on unseen phrasings', () => {
  it.each([
    [
      'rejection without "regret"',
      mail('Talent Team <jobs@finlytics.com>', 'Your candidacy at Finlytics', 'Hi Sam, we appreciate the time you spent with us. Having reviewed all profiles, we have decided not to proceed with your application for the Analyst role. We wish you luck.'),
      'REJECTION',
    ],
    [
      'big-company confirmation with job id',
      mail('Amazon Jobs <no-reply@amazon.jobs>', 'Thank you for applying to Amazon', 'Hello, We have received your application for Software Development Engineer, Job ID: 2876543. We will review your qualifications.'),
      'APPLICATION_RECEIVED',
    ],
    [
      'scheduler confirmation',
      mail('Calendly <notifications@calendly.com>', 'New Event: 30 Minute Interview with Rivet Labs', 'Hi Sam, A new event has been scheduled. Event Type: 30 Minute Interview. Invitee: Sam. Event Date/Time: 3:00pm - Thursday, 10 September 2026 (India Standard Time).'),
      'INTERVIEW_INVITE',
    ],
    [
      'test results acknowledgement',
      mail('Codility <no-reply@codility.com>', 'Your Codility test has been submitted', 'Thank you for completing the test for Rivet Labs. The company will review your solution and contact you.'),
      'ASSESSMENT_COMPLETED',
    ],
    [
      'completed "AI screen" (from a real inbox)',
      mail('Kestrel Inc Hiring Team <support@hackerrankforwork.com>', 'Thanks for taking the AI Screen - Software Development Engineer Intern', 'Thank you for completing the AI screening assessment for the Software Development Engineer Intern role at Kestrel.'),
      'ASSESSMENT_COMPLETED',
    ],
    [
      'offer worded as "happy to offer you an internship"',
      mail('Priya <priya@rivetlabs.in>', 'Internship offer', 'Dear Sam, We are happy to offer you an internship as a Data Science Intern at Rivet Labs. Your stipend will be ₹40,000 per month.'),
      'OFFER',
    ],
    [
      'rejection with only "unfortunately" and "filled"',
      mail('Rivet Labs Careers <careers@rivetlabs.in>', 'About your application', 'Unfortunately the position has been filled. Thank you for applying and we will keep your resume on file.'),
      'REJECTION',
    ],
  ] as const)('%s', (_name, email, category) => {
    expect(analyze(email).classification.category).toBe(category);
  });

  it('never turns alerts, newsletters or chatty mail into application events', () => {
    const notApplications = [
      mail('LinkedIn <jobalerts-noreply@linkedin.com>', 'New jobs for Data Analyst', 'Data Analyst at Rivet Labs. Thank you for applying… just kidding, here are jobs for you.', { bulk: true }),
      mail('The Hiring Digest <digest@hiringweekly.com>', 'This week: 10 companies hiring freshers', 'Companies hiring now, interview tips, and salary data. Read more on our blog. Unsubscribe.', { bulk: true }),
      mail('Ravi <ravi.k@gmail.com>', 'Re: referral', "Hey, I've referred you for the SDE role at our company. You'll probably get an email from HR soon. Let's grab coffee!"),
      mail('College Placement Cell <placements@college.ac.in>', 'Placement drive schedule', 'Dear students, the campus placement drive schedule for next week is attached. Companies visiting: 12. Register on the portal.', { bulk: true }),
      // Seen in a real inbox: security mail and hiring newsletters full of job words.
      mail('Naukri <info@naukri.com>', 'OTP for Naukri login', 'Use 482913 as your one time password to sign in. Never share your OTP. Thank you for applying through Naukri!'),
      mail('Amazon <account-update@amazon.com>', 'Amazon password assistance', 'To reset your password, use this verification code: 993012. If you did not request a password reset, ignore this email.'),
      mail('Unstop <noreply@unstop.news>', 'Interview season is here: new dates for the Mega Hiring Challenge', 'The interview rounds have been rescheduled to new dates! Get shortlisted, clear the online assessment, and win offer letters. Register now, limited seats.', { bulk: true }),
      // Seen in a real inbox: hackathon reminders that ask you to "submit your profile".
      mail('Devfolio <hello+hacker-house-goa-2026@devfolio.co>', 'HACKER HOUSE GOA 2026: Reminder to submit your profile for review', 'Please submit your profile and details for review before the deadline on 1 October. Shortlisted hackers will be invited.'),
      mail('Hack Club <team@hackclub.example>', 'Your hackathon registration', 'Please submit your project details and documents for the hackathon by Friday.'),
    ];
    for (const email of notApplications) {
      expect(LIFECYCLE_CATEGORIES.has(analyze(email).classification.category), email.subject).toBe(false);
    }
  });

  it('treats an onboarding request that mentions "offer letter" as an information request, not an offer', () => {
    const email = mail(
      'Campus Team <campus@email.indiacampus.example.com>',
      'Onboarding: upload documents',
      'Please upload your signed offer letter, PAN and marksheets on the portal. Your date of joining will be shared after verification.',
      { bulk: true },
    );
    expect(analyze(email).classification.category).toBe('INFO_REQUEST');
  });

  it('sends offers to review, and extracts company, role, type and stipend context', () => {
    const result = analyze(
      mail('Priya <hr@rivetlabs.in>', 'Offer Letter – Data Science Intern', 'Dear Sam, We are delighted to extend an offer for the position of Data Science Intern at Rivet Labs. Please find your offer letter attached.', {
        attachmentNames: ['Offer_Letter.pdf'],
      }),
    );
    expect(result.classification).toMatchObject({ category: 'OFFER', needsReview: true });
    expect(result.extraction).toMatchObject({
      company: { display: 'Rivet Labs', key: 'rivet' }, // keys drop endings like "Labs" so variants match
      role: { key: 'data science intern' },
      employmentType: 'internship',
    });
  });

  it('never takes the platform as the employer', () => {
    const result = analyze(mail('HackerRank <support@hackerrankforwork.com>', 'Invitation to a test', 'Rivet Labs has invited you to take an online coding test for the Backend Engineer role.'));
    expect(result.extraction?.company?.display).toBe('Rivet Labs');
    expect(result.extraction?.platform).toBe('HackerRank');
  });
});

describe('triage (which new emails get their body downloaded)', () => {
  const headers = (from: string, subject: string, snippet = '', bulk = false) => ({
    ...mail(from, subject, ''),
    detail: 'headers' as const,
    snippet,
    bulk,
  });

  it('fetches job-looking mail and recruiting platforms, and skips the rest', () => {
    expect(shouldFetchBody(headers('Rivet Labs <careers@rivetlabs.in>', 'Your application'))).toBe(true);
    expect(shouldFetchBody(headers('Greenhouse <no-reply@greenhouse.io>', 'Update'))).toBe(true);
    expect(shouldFetchBody(headers('Mom <mom@gmail.com>', 'Dinner tonight?', 'Coming home by 8?'))).toBe(false);
    expect(shouldFetchBody(headers('Swiftcart <orders@swiftcart.in>', 'Your order shipped'))).toBe(false);
    expect(shouldFetchBody(headers('LinkedIn <jobalerts-noreply@linkedin.com>', '25 new jobs', '', true))).toBe(false);
  });
});

describe('registry', () => {
  it('matches real domains and subdomains, never lookalikes', () => {
    expect(domainMatches('greenhouse.io', 'greenhouse.io')).toBe(true);
    expect(domainMatches('us.greenhouse-mail.io', 'greenhouse-mail.io')).toBe(true);
    expect(domainMatches('greenhouse.io.evil.com', 'greenhouse.io')).toBe(false);
    expect(domainMatches('evilgreenhouse.io', 'greenhouse.io')).toBe(false);
    expect(findRegistryEntry('hackerrank.com.phish.net')).toBeNull();
  });
});

describe('robustness against hostile input', () => {
  it('stays fast on pathological text (no catastrophic regex backtracking)', () => {
    const nasty = [
      'a'.repeat(100_000),
      'A '.repeat(50_000),
      `applied to ${'X '.repeat(20_000)}`,
      `${'Thank you for applying to '.repeat(2_000)}`,
      `Date: ${'1'.repeat(5_000)}\nTime: ${'2'.repeat(5_000)}`,
      `interview ${'invite you to the '.repeat(5_000)}`,
    ];
    for (const text of nasty) {
      const start = performance.now();
      analyze(mail('X <x@y.com>', text.slice(0, 2000), text));
      expect(performance.now() - start).toBeLessThan(1_500);
    }
  });
});

describe('quality gate on the synthetic corpus (holdout seed)', () => {
  // Thresholds from docs/plan §14.5 / roadmap phase 3. Optimistic by construction (see corpus.ts).
  const report = evaluate(buildCorpus(7));
  it('meets classification targets', () => {
    expect(report.relevance.precision).toBeGreaterThanOrEqual(0.97);
    expect(report.relevance.recall).toBeGreaterThanOrEqual(0.95);
    expect(report.alertFalsePositiveRate).toBeLessThanOrEqual(0.01);
    expect(report.categoryAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(report.reviewRate).toBeLessThanOrEqual(0.08);
  });
  it('meets extraction targets', () => {
    expect(report.fields.company.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(report.fields.role.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(report.fields.eventAt.accuracy).toBeGreaterThanOrEqual(0.95);
  });
});
