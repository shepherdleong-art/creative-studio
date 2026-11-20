// Reproduces the old harness's interrupted navigation, then tests page isolation.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium, webkit } from '@playwright/test';
import { withUiAcceptancePage, applyKnownFailure } from './team-server/ui-acceptance-page.mjs';
const server = http.createServer((request, response) => {
  const send = () => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>' + request.url + '</title><p>' + request.url + '</p>'); };
  if (request.url === '/next') setTimeout(send, 350);
  else send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
    const browser = await launcher.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const old = await context.newPage();
      await old.goto(origin + '/old');
      await old.evaluate(() => { setTimeout(() => { location.href = '/old-return'; }, 80); });
      await assert.rejects(old.goto(origin + '/next'), /interrupted|ERR_ABORTED/);
      await old.close();
      const errors = [];
      await withUiAcceptancePage(context, error => errors.push(error.message), async page => {
        await page.goto(origin + '/old');
        await page.evaluate(() => { setTimeout(() => { location.href = '/old-return'; }, 80); });
      });
      await withUiAcceptancePage(context, error => errors.push(error.message), async page => {
        await page.goto(origin + '/next');
        assert.equal(new URL(page.url()).pathname, '/next');
      });
      assert.deepEqual(errors, []);
      assert.equal(context.pages().length, 0);
      console.log(`${engine}: reused page reproduced interrupted navigation; isolated screens passed`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
const screen = { knownFailure: 'ui-10', knownFailureChecks: ['hiddenOverflowContent'] };
assert.equal(applyKnownFailure({ result: 'failed', outcomes: {}, error: 'navigation interrupted' }, screen).result, 'failed');
assert.equal(applyKnownFailure({ result: 'failed', outcomes: {} }, screen).result, 'failed');
const layout = { result: 'failed', outcomes: { base: { hiddenOverflowContent: { passed: false } } } };
assert.equal(applyKnownFailure(layout, screen).result, 'known-failure');
assert.equal(applyKnownFailure({ ...layout, error: 'popup failed' }, screen).result, 'failed');
