import { analyze } from '../analyze';
import { CATEGORIES, isRelevant, LIFECYCLE_CATEGORIES, type Category } from '../categories';
import { companyKey, roleKey } from '../extract';
import type { LabeledEmail } from './corpus';

/** Quality metrics (docs/plan §14.5) over a labelled corpus. */
export interface EvalReport {
  total: number;
  relevance: { precision: number; recall: number };
  alertFalsePositiveRate: number;
  categoryAccuracy: number;
  reviewRate: number;
  perCategory: Array<{ category: Category; precision: number; recall: number; support: number }>;
  fields: Record<'company' | 'role' | 'employmentType' | 'reqId' | 'applicationRef' | 'eventAt' | 'deadlineAt', { correct: number; total: number; accuracy: number }>;
  mistakes: Array<{ template: string; expected: Category; got: Category }>;
  fieldMistakes: Array<{ template: string; field: string; expected: string; got: string }>;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : Math.round((a / b) * 1000) / 1000);

export function evaluate(corpus: LabeledEmail[]): EvalReport {
  let tp = 0, fp = 0, fn = 0, alerts = 0, alertsAsLifecycle = 0, correctCategory = 0, relevantExpected = 0, review = 0, predictedRelevant = 0;
  const predicted = new Map<Category, number>();
  const expectedCount = new Map<Category, number>();
  const correct = new Map<Category, number>();
  const fields: EvalReport['fields'] = {
    company: { correct: 0, total: 0, accuracy: 0 },
    role: { correct: 0, total: 0, accuracy: 0 },
    employmentType: { correct: 0, total: 0, accuracy: 0 },
    reqId: { correct: 0, total: 0, accuracy: 0 },
    applicationRef: { correct: 0, total: 0, accuracy: 0 },
    eventAt: { correct: 0, total: 0, accuracy: 0 },
    deadlineAt: { correct: 0, total: 0, accuracy: 0 },
  };
  const mistakes: EvalReport['mistakes'] = [];
  const fieldMistakes: EvalReport['fieldMistakes'] = [];

  for (const { template, email, expected } of corpus) {
    const { classification, extraction, relevant } = analyze(email);
    const got = classification.category;
    const wantRelevant = isRelevant(expected.category);

    if (relevant && wantRelevant) tp++;
    else if (relevant) fp++;
    else if (wantRelevant) fn++;
    if (relevant) {
      predictedRelevant++;
      if (classification.needsReview) review++;
    }
    if (expected.category === 'JOB_ALERT' || expected.category === 'NEWSLETTER_MARKETING') {
      alerts++;
      if (LIFECYCLE_CATEGORIES.has(got)) alertsAsLifecycle++;
    }
    if (wantRelevant) relevantExpected++;
    predicted.set(got, (predicted.get(got) ?? 0) + 1);
    expectedCount.set(expected.category, (expectedCount.get(expected.category) ?? 0) + 1);
    if (got === expected.category) {
      correct.set(got, (correct.get(got) ?? 0) + 1);
      if (wantRelevant) correctCategory++;
    } else {
      mistakes.push({ template, expected: expected.category, got });
    }

    // Fields are scored only where the template defines them and the category was right.
    if (got !== expected.category || !extraction) continue;
    const check = (field: keyof EvalReport['fields'], want: string | undefined, have: string | undefined | null) => {
      if (want === undefined) return;
      fields[field].total++;
      if (want === (have ?? '')) fields[field].correct++;
      else fieldMistakes.push({ template, field, expected: want, got: have ?? '—' });
    };
    if (expected.company !== undefined) check('company', expected.company ? companyKey(expected.company) : '', extraction.company?.key);
    if (expected.role !== undefined) check('role', expected.role ? roleKey(expected.role) : '', extraction.role?.key);
    check('employmentType', expected.employmentType, extraction.employmentType);
    check('reqId', expected.reqId, extraction.reqId);
    check('applicationRef', expected.applicationRef, extraction.applicationRef);
    const minute = (d: Date | null | undefined) => (d ? new Date(Math.round(d.getTime() / 60000) * 60000).toISOString() : undefined);
    check('eventAt', minute(expected.eventAt), minute(extraction.eventAt));
    check('deadlineAt', minute(expected.deadlineAt), minute(extraction.deadlineAt));
  }

  for (const f of Object.values(fields)) f.accuracy = ratio(f.correct, f.total);
  return {
    total: corpus.length,
    relevance: { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) },
    alertFalsePositiveRate: ratio(alertsAsLifecycle, alerts),
    categoryAccuracy: ratio(correctCategory, relevantExpected),
    reviewRate: ratio(review, predictedRelevant),
    perCategory: CATEGORIES.filter((c) => expectedCount.has(c) || predicted.has(c)).map((category) => ({
      category,
      precision: ratio(correct.get(category) ?? 0, predicted.get(category) ?? 0),
      recall: ratio(correct.get(category) ?? 0, expectedCount.get(category) ?? 0),
      support: expectedCount.get(category) ?? 0,
    })),
    fields,
    mistakes,
    fieldMistakes,
  };
}
