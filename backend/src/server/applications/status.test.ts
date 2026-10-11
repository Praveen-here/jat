import { describe, expect, it } from 'vitest';
import { project, type ProjectableEvent } from './status';

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 8, day, hour));
let n = 0;
const ev = (eventType: string, day: number, extra: Partial<ProjectableEvent> = {}): ProjectableEvent => ({
  id: `e${String(++n).padStart(3, '0')}`,
  eventType,
  occurredAt: at(day),
  scheduledAt: null,
  deadlineAt: null,
  pending: false,
  ...extra,
});

describe('status projection', () => {
  it('follows the latest stage by email date', () => {
    const p = project([ev('APPLICATION_RECEIVED', 1), ev('ASSESSMENT_INVITE', 5), ev('INTERVIEW_INVITE', 10), ev('REJECTION', 20)]);
    expect(p).toMatchObject({ status: 'REJECTED', conflict: false, appliedAt: at(1), firstSeenAt: at(1), lastActivityAt: at(20) });
  });

  it('gives the same answer whatever order the emails were processed in', () => {
    const events = [ev('APPLICATION_RECEIVED', 1), ev('ASSESSMENT_INVITE', 3), ev('SHORTLISTED', 7), ev('INTERVIEW_INVITE', 9), ev('OFFER', 15)];
    const expected = project(events);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...events].sort(() => Math.random() - 0.5);
      expect(project(shuffled)).toEqual(expected);
    }
    expect(expected.status).toBe('OFFER');
  });

  it("doesn't treat reminders, reschedules or info requests as progress", () => {
    const p = project([ev('APPLICATION_RECEIVED', 1), ev('INTERVIEW_INVITE', 4), ev('ASSESSMENT_REMINDER', 6), ev('INFO_REQUEST', 7), ev('INTERVIEW_RESCHEDULED', 8)]);
    expect(p.status).toBe('INTERVIEW');
  });

  it('tracks the next interview through reschedules and cancellations', () => {
    const now = at(10);
    const invite = ev('INTERVIEW_INVITE', 5, { scheduledAt: at(15) });
    const moved = ev('INTERVIEW_RESCHEDULED', 6, { scheduledAt: at(18) });
    expect(project([invite], now).nextEventAt).toEqual(at(15));
    expect(project([invite, moved], now).nextEventAt).toEqual(at(18));
    expect(project([invite, moved, ev('INTERVIEW_CANCELLED', 7)], now).nextEventAt).toBeNull();
  });

  it('clears an assessment deadline once the assessment is completed', () => {
    const now = at(4);
    const invite = ev('ASSESSMENT_INVITE', 2, { deadlineAt: at(6) });
    expect(project([invite], now).nextEventAt).toEqual(at(6));
    expect(project([invite, ev('ASSESSMENT_COMPLETED', 3)], now).nextEventAt).toBeNull();
  });

  it('an offer followed by a withdrawal ends as withdrawn', () => {
    expect(project([ev('OFFER', 1), ev('WITHDRAWAL_CONFIRMATION', 3)]).status).toBe('WITHDRAWN');
  });

  it('flags a stage arriving after a rejection as a conflict', () => {
    const p = project([ev('APPLICATION_RECEIVED', 1), ev('REJECTION', 5), ev('INTERVIEW_INVITE', 8)]);
    expect(p).toMatchObject({ status: 'INTERVIEW', conflict: true });
  });

  it('ignores pending (unconfirmed) events for status, but counts them as activity', () => {
    const p = project([ev('APPLICATION_RECEIVED', 1), ev('REJECTION', 5, { pending: true })]);
    expect(p).toMatchObject({ status: 'APPLIED', lastActivityAt: at(5) });
  });

  it('says exactly where things stand (your HackerRank case): applied → assessment completed', () => {
    const p = project([ev('APPLICATION_RECEIVED', 3), ev('ASSESSMENT_COMPLETED', 9)]);
    expect(p).toMatchObject({ status: 'ASSESSMENT', statusDetail: 'Assessment completed' });
  });

  it('says what a shortlist is for (your LTM case)', () => {
    const p = project([ev('APPLICATION_RECEIVED', 1), ev('ASSESSMENT_INVITE', 5), ev('SHORTLISTED', 6, { detail: 'assessment', deadlineAt: at(25) })], at(10));
    expect(p).toMatchObject({ status: 'SHORTLISTED', statusDetail: 'Shortlisted for assessment', nextEventAt: at(25) });
    expect(project([ev('SHORTLISTED', 2, { detail: 'interview' })]).statusDetail).toBe('Shortlisted for interview');
  });

  it('describes rejections by how far the application got', () => {
    expect(project([ev('APPLICATION_RECEIVED', 1), ev('INTERVIEW_INVITE', 4), ev('REJECTION', 9)]).statusDetail).toBe('Rejected after interview');
    expect(project([ev('APPLICATION_RECEIVED', 1), ev('REJECTION', 9)]).statusDetail).toBe('Rejected');
  });

  it('shows documents requested without changing the stage, and never moves backwards', () => {
    expect(project([ev('APPLICATION_RECEIVED', 1), ev('INFO_REQUEST', 3)])).toMatchObject({ status: 'APPLIED', statusDetail: 'Documents requested' });
    // A late assessment reminder after an interview invite doesn't drag the application back.
    expect(project([ev('INTERVIEW_INVITE', 2), ev('ASSESSMENT_REMINDER', 5)])).toMatchObject({ status: 'INTERVIEW', statusDetail: 'Interview scheduled' });
  });

  it('infers a stage from a lone reminder when nothing else is known', () => {
    expect(project([ev('ASSESSMENT_REMINDER', 2)]).status).toBe('ASSESSMENT');
  });
});
