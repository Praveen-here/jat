/* eslint-disable no-console -- a command-line report on synthetic data, not server logging */
import { buildCorpus } from './corpus';
import { evaluate } from './evaluate';

/** `pnpm --filter backend eval [seed]`: prints classification and extraction quality. */
const seed = Number(process.argv[2] ?? 1);
const report = evaluate(buildCorpus(seed));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`\nCorpus: ${report.total} synthetic emails (seed ${seed})\n`);
console.log(`Job-related precision   ${pct(report.relevance.precision)}`);
console.log(`Job-related recall      ${pct(report.relevance.recall)}`);
console.log(`Alerts → application    ${pct(report.alertFalsePositiveRate)}   (lower is better)`);
console.log(`Category accuracy       ${pct(report.categoryAccuracy)}   (job-related emails)`);
console.log(`Sent to review          ${pct(report.reviewRate)}\n`);

console.log('Category                    precision  recall  support');
for (const row of report.perCategory) {
  console.log(`${row.category.padEnd(28)}${pct(row.precision).padStart(9)}${pct(row.recall).padStart(8)}${String(row.support).padStart(9)}`);
}

console.log('\nField            accuracy   (checked)');
for (const [field, f] of Object.entries(report.fields)) {
  console.log(`${field.padEnd(17)}${pct(f.accuracy).padStart(8)}   (${f.total})`);
}

const group = <T,>(items: T[], key: (t: T) => string) => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};
if (report.mistakes.length) {
  console.log('\nCategory mistakes (template: expected → got ×count)');
  for (const [k, n] of group(report.mistakes, (m) => `${m.template}: ${m.expected} → ${m.got}`).slice(0, 25)) console.log(`  ${k} ×${n}`);
}
if (report.fieldMistakes.length) {
  console.log('\nField mistakes (first examples per template/field)');
  const seen = new Set<string>();
  for (const m of report.fieldMistakes) {
    const key = `${m.template}/${m.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${key}: expected "${m.expected}", got "${m.got}"`);
    if (seen.size >= 25) break;
  }
}
