import fs from 'node:fs';

const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(`result=${result.result} screens=${result.screens?.length} runs=${result.runs.length} selftest=${result.selfTestRuns?.length}`);
console.log(`counts=${JSON.stringify(result.counts)} failures=${result.failures.length} blocked=${result.blocked?.length} knownFailures=${result.knownFailures?.length}`);
console.log(`paid=${result.realPaidProviderCalls} isolated=${result.isolatedDataRoot} cleanup=${JSON.stringify(result.cleanup)}`);
if (result.checkTotals) {
  console.log('checkTotals:');
  for (const [key, value] of Object.entries(result.checkTotals)) console.log(`  ${key.padEnd(24)} ${JSON.stringify(value)}`);
}
console.log(`selfTest passed=${result.selfTest.filter((r) => r.passed).length}/${result.selfTest.length}`);
const screenFailures = result.failures.filter((f) => f.screen);
const pageErrors = result.failures.filter((f) => !f.screen);
console.log(`screen failures=${screenFailures.length} other failures=${pageErrors.length}`);
const grouped = {};
for (const failure of screenFailures) {
  grouped[failure.screen] ??= [];
  const details = [];
  for (const outcomes of Object.values(failure.outcomes ?? {})) {
    for (const [check, outcome] of Object.entries(outcomes)) if (!outcome.passed) details.push(`${check}: ${String(outcome.detail).split('；')[0].slice(0, 120)}`);
  }
  grouped[failure.screen].push(details.join(' || '));
}
for (const [key, rows] of Object.entries(grouped)) {
  console.log(`FAIL ${key} x${rows.length}`);
  console.log(`   ${[...new Set(rows)][0]}`);
}
for (const other of pageErrors.slice(0, 5)) console.log(`OTHER ${other.kind}: ${String(other.message).slice(0, 120)} @${other.engine} ${other.viewport ?? ''}`);
if (result.blocked?.length) {
  const kinds = {};
  for (const b of result.blocked) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
  console.log(`blocked kinds=${JSON.stringify(kinds)}`);
  console.log(`  sample: ${String(result.blocked[0].reason).slice(0, 200)}`);
}
if (result.byScreen) {
  const bad = Object.entries(result.byScreen).filter(([, e]) => e.failed > 0);
  console.log(`byScreen total=${Object.keys(result.byScreen).length} hard-failing=${bad.length}`);
  for (const [id, entry] of bad) console.log(`  ${id.padEnd(34)} pass=${entry.passed} fail=${entry.failed} known=${entry['known-failure']}`);
}
