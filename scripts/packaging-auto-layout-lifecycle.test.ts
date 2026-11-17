// node scripts/packaging-auto-layout-lifecycle.test.ts — actual child lifecycle, no real Chromium needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPackagingLayoutFixture } from './packaging-layout-fixture.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-lifecycle-'));
const packaging = createPackagingLayoutFixture(root);
const envBefore = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = packaging;
process.env.CREATIVE_STUDIO_PACKAGING_NODE = process.execPath;
const markerPath = path.join(root, 'child-started.json');
process.env.LAYOUT_TEST_MARKER = markerPath;
const puppetDir = path.join(packaging, 'node_modules/puppeteer-core');
fs.mkdirSync(puppetDir, { recursive: true });
fs.writeFileSync(path.join(puppetDir, 'index.js'), `
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
exports.default = { launch: async options => {
  if (options.userDataDir) {
    fs.mkdirSync(options.userDataDir, { recursive: true });
    fs.writeFileSync(path.join(options.userDataDir, 'profile'), 'browser profile');
  }
  return { close: async () => {}, newPage: async () => ({
    setViewport: async () => {}, on: () => {},
    goto: async url => {
      fs.writeFileSync(process.env.LAYOUT_TEST_MARKER, JSON.stringify({
        workDir: path.dirname(fileURLToPath(url)), profile: options.userDataDir, pid: process.pid
      }));
      if (process.env.LAYOUT_TEST_MODE === 'block') {
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
      if (process.env.LAYOUT_TEST_MODE === 'fail') throw new Error('fixture browser failure');
    },
    evaluate: async (_fn, input) => input ? { status: 'resolved', elements: {},
      metrics: { frameCount: 24, digest: 'fixture' }, diagnostics: { visibleFrameCount: 24 } } : undefined
  }) };
} };
`);
const { resolvePackagingAutoLayout } = await import('../lib/media-core/packaging-auto-layout-service.ts');
const input = {
  config: { enabled: true, template: 'overlay-poster' as const, varsOverrides: {},
    pointCuesLayoutVersion: 2, layoutRuntimeBundleVersion: 2,
    pointFont: { family: 'Test', file: 'user-point-test.ttf' } },
  vars: { title: '标题', subtitle: '副标题', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '' },
  totalSec: 3, coverSec: 20 / 24, outputWidth: 1080, outputHeight: 1440,
};
const requestRoot = path.join(root, 'storage/packaging/layout-requests');
let observedWorkDir: string | undefined;
async function started(): Promise<{ workDir: string; profile: string; pid: number }> {
  for (let i = 0; i < 400; i += 1) {
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      observedWorkDir = marker.workDir;
      return marker;
    }
    await delay(25);
  }
  throw new Error('layout child did not reach the copied template');
}
function assertClean() {
  assert.deepEqual(fs.readdirSync(requestRoot), [], 'all per-request files must be removed');
  assert.ok(observedWorkDir && !fs.existsSync(observedWorkDir), 'forced stop must remove copied templates and private fonts');
}

try {
  for (const stopMode of ['abort', 'timeout'] as const) {
    process.env.LAYOUT_TEST_MODE = 'block';
    fs.rmSync(markerPath, { force: true });
    const controller = new AbortController();
    if (stopMode === 'timeout') mock.timers.enable({ apis: ['setTimeout'] });
    const result = resolvePackagingAutoLayout({ ...input, signal: controller.signal }).catch(error => error);
    const marker = await started();
    assert.ok(fs.existsSync(path.join(marker.workDir, 'fonts/user/user-point-test.ttf')));
    if (stopMode === 'abort') controller.abort();
    else mock.timers.tick(120_000);
    const error = await result;
    mock.timers.reset();
    assert.equal(error.code, stopMode === 'abort' ? 'layout_aborted' : 'layout_timeout');
    assert.throws(() => process.kill(marker.pid, 0), 'promise must settle after the child exits');
    assertClean();
    assert.ok(path.resolve(marker.workDir).startsWith(`${path.resolve(requestRoot)}${path.sep}`));
    assert.ok(path.resolve(marker.profile).startsWith(`${path.resolve(requestRoot)}${path.sep}`));
  }
  for (const mode of ['fail', 'success']) {
    process.env.LAYOUT_TEST_MODE = mode;
    fs.rmSync(markerPath, { force: true });
    const result = resolvePackagingAutoLayout(input).catch(error => error);
    await started();
    const value = await result;
    if (mode === 'fail') assert.match(value.message, /fixture browser failure/);
    else assert.equal(value.status, 'resolved');
    assertClean();
  }
  process.env.CREATIVE_STUDIO_PACKAGING_NODE = path.join(root, 'missing-node');
  await assert.rejects(resolvePackagingAutoLayout(input), /进程启动失败/);
  assertClean();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(resolvePackagingAutoLayout({ ...input, signal: cancelled.signal }), /取消/);
  assertClean();
  console.log('packaging auto layout lifecycle tests passed');
} finally {
  mock.timers.reset();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
  // The red regression can leave its own legacy OS-temp copy; remove only that exact fixture directory.
  if (observedWorkDir && path.dirname(observedWorkDir) === path.resolve(os.tmpdir())
    && path.basename(observedWorkDir).startsWith('creative-studio-layout-')) {
    fs.rmSync(observedWorkDir, { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
