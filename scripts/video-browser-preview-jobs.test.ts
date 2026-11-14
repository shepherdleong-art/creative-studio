import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import type { ExecutionFacade } from '../lib/media-core/execution/context.ts';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-preview-jobs-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_MEDIA_CONCURRENCY = '1';
delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;

const { closeDb, getDb } = await import('../lib/db.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const { browserPreviewPath, ensureBrowserPreview } = await import('../lib/video-browser-preview.ts');
const { withMediaResource } = await import('../lib/media-core/media-resource-gate.ts');
const { clearExecutionModuleRuntime, setExecutionModuleRuntime } = await import('../lib/media-core/execution/module-runtime.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');

const source = path.join(dataRoot, 'source-hevc.mp4');
await runFfmpeg([
  '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
  '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', source,
], { timeoutMs: 60_000 });
const preview = browserPreviewPath(source);

try {
  assert.equal(await ensureBrowserPreview(source), preview);
  const jobKey = (getDb().prepare('SELECT jobKey FROM media_derivative_jobs WHERE sourcePath = ?').pluck().get(source) as string);
  assert.ok(jobKey);
  assert.equal(getDb().prepare('SELECT status FROM media_derivative_jobs WHERE jobKey = ?').pluck().get(jobKey), 'ready');

  fs.rmSync(preview);
  getDb().prepare(`UPDATE media_derivative_jobs SET status = 'running', leaseUntil = ? WHERE jobKey = ?`)
    .run(Date.now() + 60_000, jobKey);
  await assert.rejects(ensureBrowserPreview(source), (error: unknown) => (error as { code?: string }).code === 'browser_preview_pending');
  assert.equal(fs.existsSync(preview), false, '未完成的持久任务不得被第二个 GET 重复启动');

  getDb().prepare(`UPDATE media_derivative_jobs SET leaseUntil = ? WHERE jobKey = ?`).run(Date.now() - 1, jobKey);
  assert.equal(await ensureBrowserPreview(source), preview, '租约到期的崩溃任务必须可恢复');

  fs.rmSync(preview);
  getDb().prepare('DELETE FROM media_derivative_jobs WHERE jobKey = ?').run(jobKey);
  const compatibleSource = path.join(dataRoot, 'ready-h264.mp4');
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:rate=24:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', compatibleSource,
  ], { timeoutMs: 60_000 });
  setExecutionModuleRuntime({ instanceId: 'preview-test', fence: 1, facade: {} as ExecutionFacade });
  let release!: () => void;
  const occupied = withMediaResource({ taskId: 'other-render', wait: true }, () => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const spawn = mock.method(childProcess, 'spawn');
  syncBuiltinESMExports();
  const probeCount = () => spawn.mock.calls.filter(call => Array.isArray(call.arguments[1]) && call.arguments[1].includes('-show_entries')).length;
  const denied = new Error('preview-authorization-denied');
  const deniedPreview = () => runWithAccessContext({
    kind: 'team', actor: { userId: 'denied-user', role: 'employee' },
    assertAccess() {}, resolveOwner() { return 'denied-user'; }, registerRootScope() {},
    registerInheritedScope() {}, registerTaskPrincipal() {},
    authorizeFileRead() { throw denied; },
  }, () => ensureBrowserPreview(compatibleSource));
  try {
    // Cold H.264 and repeat Range reads do not wait for an unrelated render.
    const first = ensureBrowserPreview(compatibleSource);
    await assert.rejects(deniedPreview(), error => error === denied, 'in-flight work must not bypass caller authorization');
    assert.equal(await first, compatibleSource);
    assert.equal(probeCount(), 1);
    for (let index = 0; index < 4; index += 1) assert.equal(await ensureBrowserPreview(compatibleSource), compatibleSource);
    assert.equal(probeCount(), 1, 'unchanged H.264 Range reads must reuse the successful format probe');
    await assert.rejects(deniedPreview(), error => error === denied, 'cache hits must still authorize each caller');
    assert.equal(fs.existsSync(browserPreviewPath(compatibleSource)), false);

    // Replacing a source must invalidate compatibility, even at the same path.
    fs.copyFileSync(source, compatibleSource);
    await assert.rejects(ensureBrowserPreview(compatibleSource), (error: unknown) => (error as { code?: string }).code === 'browser_preview_pending');
    assert.equal(probeCount(), 2, 'changed source must be probed again');
    await assert.rejects(ensureBrowserPreview(source), (error: unknown) => (error as { code?: string }).code === 'browser_preview_pending');
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    release();
    await occupied;
    clearExecutionModuleRuntime();
  }
  assert.equal(await ensureBrowserPreview(source), preview);
  assert.equal(await ensureBrowserPreview(compatibleSource), browserPreviewPath(compatibleSource));

  const authorizationFailure = new Error('preview-authorization-denied');
  await assert.rejects(
    runWithAccessContext({
      kind: 'team', actor: { userId: 'denied-user', role: 'employee' },
      assertAccess() {}, resolveOwner() { return 'denied-user'; }, registerRootScope() {},
      registerInheritedScope() {}, registerTaskPrincipal() {},
      authorizeFileRead() { throw authorizationFailure; },
    }, () => ensureBrowserPreview(source)),
    (error: unknown) => error === authorizationFailure,
    '授权失败必须向上返回，不得吞错后回退原件',
  );

  console.log('video browser preview jobs: busy-server playback, probe reuse/invalidation, persistent dedupe, lease recovery, transcode capacity and authorization passed');
} finally {
  clearExecutionModuleRuntime();
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
