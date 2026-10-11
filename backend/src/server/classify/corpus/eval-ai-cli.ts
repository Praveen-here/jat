/* eslint-disable no-console -- a command-line report on synthetic data, not server logging */
import { createAiClassifier } from '../../ai/classify-ai';
import { GroqClient } from '../../ai/groq';
import { loadEnv } from '../../config/env';
import { analyze } from '../analyze';
import { isRelevant } from '../categories';
import { companyKey } from '../extract';
import { analyzeHybrid } from '../hybrid';
import { buildCorpus } from './corpus';

/**
 * `pnpm --filter backend eval:ai [count]`: rules-only vs rules+AI on a sample of the synthetic
 * corpus, using the REAL Groq API. Uses free-tier quota (about 1.5K tokens per email), so keep it small.
 * Only synthetic emails are sent.
 */
const env = loadEnv();
if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
const count = Number(process.argv[2] ?? 24);

const corpus = buildCorpus(7, 1);
// Every trap/alert/newsletter template first, then the rest, up to `count`.
const ordered = [...corpus.filter((c) => /^(trap|newsletter|linkedin\.alert|naukri|indeed|onboarding|outreach|unrelated)/.test(c.template)), ...corpus];
const sample = [...new Map(ordered.map((c) => [c.template, c])).values()].slice(0, count);

const ai = createAiClassifier(new GroqClient({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL }));
const privacy = { ownAddresses: [], userName: null };

let rulesCorrect = 0, hybridCorrect = 0, rulesCompany = 0, hybridCompany = 0, companyTotal = 0, reviews = 0, falseJobs = 0;
const rows: string[] = [];
const started = Date.now();
for (const { template, email, expected } of sample) {
  const rules = analyze(email);
  const hybrid = await analyzeHybrid(email, { timeZone: 'Asia/Kolkata', ai: { classifier: ai, privacy } });
  const rOk = rules.classification.category === expected.category;
  const hOk = hybrid.classification.category === expected.category;
  rulesCorrect += Number(rOk);
  hybridCorrect += Number(hOk);
  if (hybrid.classification.needsReview) reviews++;
  if (!isRelevant(expected.category) && hybrid.relevant) falseJobs++;
  if (expected.company) {
    companyTotal++;
    rulesCompany += Number(rules.extraction?.company?.key === companyKey(expected.company));
    hybridCompany += Number(hybrid.extraction?.company?.key === companyKey(expected.company));
  }
  const marker = hybrid.classification.ruleHits.find((h) => h.startsWith('ai.')) ?? '';
  rows.push(`${hOk ? '✓' : '✗'} ${template.padEnd(34)} expected ${expected.category.padEnd(24)} rules ${rules.classification.category.padEnd(24)} rules+AI ${hybrid.classification.category.padEnd(24)} ${hybrid.classification.needsReview ? 'REVIEW ' : ''}${marker}`);
}

const pct = (a: number, b: number) => `${b ? ((a / b) * 100).toFixed(0) : '–'}%`;
console.log(`\n${sample.length} synthetic emails · model ${env.GROQ_MODEL} · ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
console.log(rows.join('\n'));
console.log(`\nCategory correct:   rules ${pct(rulesCorrect, sample.length)}   rules+AI ${pct(hybridCorrect, sample.length)}`);
console.log(`Company correct:    rules ${pct(rulesCompany, companyTotal)}   rules+AI ${pct(hybridCompany, companyTotal)}`);
console.log(`Non-job emails counted as job emails (rules+AI): ${falseJobs}`);
console.log(`Sent to review (rules+AI): ${reviews} of ${sample.length}`);
