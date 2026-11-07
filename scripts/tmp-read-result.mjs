import fs from 'node:fs';

const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(`result=${result.result} engines=${result.engines} viewports=${result.viewports} themes=${result.themes}`);
console.log(`runs=${result.runs.length} selftestRuns=${result.selfTestRuns.length} screens=${result.screens.length}`);
console.log(`counts=${JSON.stringify(result.counts)}`);
console.log(`failures=${result.failures.length} blocked=${result.blocked.length} knownFailures=${result.knownFailures.length}`);
console.log(`paid=${result.realPaidProviderCalls} isolated=${result.isolatedDataRoot} cleanup=${JSON.stringify(result.cleanup)}`);
console.log(`checkTotals=${JSON.stringify(result.checkTotals, null, 1)}`);
console.log('--- selfTest');
const bad01 = result.selfTest.filter((row) => !row.passed);
console.log(`selfTest rows=${result.selfTest.length} failed=${bad01.length}`);
console.log('--- byScreen');
for (const [id, entry] of Object.entries(result.byScreen)) {
  console.log(`${id.padEnd(34)} pass=${String(entry.passed).padStart(2)} fail=${String(entry.failed).padStart(2)} known=${String(entry['known-failure']).padStart(2)}`);
  for (const note of entry.notes.slice(0, 1)) console.log(`    note: ${String(note).slice(0, 200)}`);
}
console.log('--- known failure samples');
const seen = new Set();
for (const row of result.knownFailures) {
  if (seen.has(row.screen)) continue;
  seen.add(row.screen);
  console.log(`${row.screen} ${row.engine} ${row.viewport} ${row.theme} owner=${row.knownFailure}`);
  for (const [scope, outcomes] of Object.entries(row.outcomes)) {
    for (const [key, outcome] of Object.entries(outcomes)) {
      if (!outcome.passed) console.log(`   ${scope}/${key}: ${String(outcome.detail).slice(0, 260)}`);
    }
  }
}
console.log('--- mediaFrames measured count');
let measuredRows = 0;
for (const row of result.runs) {
  const m = row.outcomes?.base?.mediaFrames;
  if (m && m.detail && !m.detail.includes('没有可测画面')) measuredRows += 1;
}
console.log(`rows with measurable frames=${measuredRows}`);
console.log('--- assertions');
for (const line of result.assertions) console.log(`  ${line}`);
