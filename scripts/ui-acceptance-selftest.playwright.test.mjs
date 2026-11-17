// Standalone seconds-long regression for the browser geometry collectors.
import assert from 'node:assert/strict';
import { chromium, webkit } from '@playwright/test';
import { collectAllChecks } from './team-server/ui-acceptance-checks.mjs';
import { runCheckSelfTest } from './team-server/ui-acceptance-selftest.mjs';
for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
  const browser = await launcher.launch({ headless: true });
  try {
    const viewport = { width: 1024, height: 720, label: '1024x720' };
    const page = await browser.newPage({ viewport });
    const result = await runCheckSelfTest(page, { collectAllChecks, engine, viewport });
    const failed = result.selftest.filter(row => !row.passed);
    console.log(JSON.stringify({ engine, result: result.result, failed }, null, 2));
    assert.equal(result.result, 'passed');
  } finally { await browser.close(); }
}
