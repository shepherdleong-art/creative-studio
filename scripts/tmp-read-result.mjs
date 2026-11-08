import fs from 'node:fs';

const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(`result=${result.result}`);
console.log(`screens=${result.screens?.length} runs=${result.runs.length} selftestRuns=${result.selfTestRuns?.length}`);
console.log(`matrix=${result.engines?.join('+')} x ${result.viewports?.join('+')} x ${result.themes?.join('+')}`);
console.log(`counts=${JSON.stringify(result.counts)}`);
console.log(`failures=${result.failures.length} blocked=${result.blocked?.length} knownFailures=${result.knownFailures?.length} absorbedPageErrors=${result.absorbedPageErrors?.length ?? 0}`);
console.log(`paid=${result.realPaidProviderCalls} isolated=${result.isolatedDataRoot} cleanup=${JSON.stringify(result.cleanup)}`);
console.log('checkTotals:');
for (const [key, value] of Object.entries(result.checkTotals ?? {})) console.log(`  ${key.padEnd(24)} ${JSON.stringify(value)}`);
console.log(`selfTest passed=${result.selfTest.filter((r) => r.passed).length}/${result.selfTest.length}`);
for (const failure of result.failures.slice(0, 8)) console.log(`FAIL ${failure.screen ?? failure.kind}: ${String(failure.error ?? failure.message ?? failure.reason).slice(0, 200)}`);
if (result.blocked?.length) {
  const kinds = {};
  for (const b of result.blocked) kinds[`${b.kind}:${b.screen ?? ''}`] = (kinds[`${b.kind}:${b.screen ?? ''}`] ?? 0) + 1;
  console.log(`blocked=${JSON.stringify(kinds)}`);
}
const knownScreens = [...new Set((result.knownFailures ?? []).map((r) => r.screen))];
console.log(`knownFailure screens=${JSON.stringify(knownScreens)}`);
