import { describe, expect, it } from 'vitest';
import { parseAddress } from '../email/normalize';
import type { NormalizedEmail } from '../email/types';
import { detectNextStep, extract, isPlausibleRole, parseDatePhrase } from './extract';

function mail(from: string, subject: string, text: string): NormalizedEmail {
  return {
    id: 'x', threadId: null, internalDate: new Date('2026-10-01T07:45:00Z'), labelIds: [], detail: 'full', from: parseAddress(from),
    replyTo: null, subject, snippet: '', messageIdHeader: null, bulk: false, text, links: [], calendar: null, attachmentNames: [], isForward: false,
  };
}

describe('extraction fixes from the real inbox', () => {
  it('keeps a date with no time as just that day (no invented "5:31 am")', () => {
    const email = mail('ECH <hiring@ltm.example>', 'Shortlisted', '');
    const day = parseDatePhrase('Sunday, October 4th', email, 'Asia/Kolkata');
    expect(day?.toISOString()).toBe('2026-10-03T18:30:00.000Z'); // 4 Oct 00:00 IST
    const withTime = parseDatePhrase('Sunday, October 4th at 10:30 AM IST', email, 'Asia/Kolkata');
    expect(withTime?.toISOString()).toBe('2026-10-04T05:00:00.000Z');
  });

  it('knows what a shortlist is for', () => {
    expect(detectNextStep('LTM Early Career Hiring Process | Shortlisted for Online Assessment | Sunday, October 4th')).toBe('assessment');
    expect(detectNextStep('You have been shortlisted for the technical interview round')).toBe('interview');
    expect(detectNextStep('You have been shortlisted.')).toBeNull();
  });

  it('rejects places and campuses as roles', () => {
    expect(isPlausibleRole('Campus28-PES University, Bengaluru')).toBe(false);
    expect(isPlausibleRole('Software Development Engineer Intern')).toBe(true);
    expect(isPlausibleRole('Graduate Engineer Trainee - PES University')).toBe(true);
  });

  it('accepts a platform as the employer when it is hiring for itself (your HackerRank case)', () => {
    const own = mail(
      'HackerRank Inc Hiring Team <no-reply@hackerrankcareers.com>',
      'Exciting News: We have received your Application || Software Development Engineer Intern || HackerRank',
      'Thank you for applying for the Software Development Engineer Intern role at HackerRank.',
    );
    expect(extract(own, 'APPLICATION_RECEIVED').company?.display).toBe('HackerRank');
  });

  it("still doesn't take the platform as the employer when it delivers someone else's test", () => {
    const forOthers = mail('HackerRank <support@hackerrankforwork.com>', 'Test invitation', 'Rivet Labs has invited you to take a coding test.');
    expect(extract(forOthers, 'ASSESSMENT_INVITE').company?.display).toBe('Rivet Labs');
  });
});
