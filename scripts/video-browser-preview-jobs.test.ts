import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
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

  // --- 失败/中断不得留下 ready 半成品，临时文件必须清理 ---
  const failingSource = path.join(dataRoot, 'transcode-fails.mp4');
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', failingSource,
  ], { timeoutMs: 60_000 });
  const failingPreview = browserPreviewPath(failingSource);
  const realSpawn = childProcess.spawn;
  let transcodeSpawns = 0;
  const temporaryOutputs: string[] = [];
  const spawnMock = mock.method(childProcess, 'spawn', function (
    command: string,
    args?: readonly string[],
    options?: unknown,
  ) {
    const argv = Array.isArray(args) ? [...args] : [];
    if (argv.includes('libx264')) {
      transcodeSpawns += 1;
      if (argv.includes(failingSource)) {
        // 模拟 ffmpeg 写了一半临时文件后失败退出；原子发布前的半成品必须被清理。
        const outputPath = argv[argv.length - 1];
        fs.writeFileSync(outputPath, Buffer.from('partial-transcode'));
        temporaryOutputs.push(outputPath);
        const fake = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: () => void;
        };
        fake.stdout = new EventEmitter();
        fake.stderr = new EventEmitter();
        fake.kill = () => {};
        setImmediate(() => fake.emit('close', 1));
        return fake;
      }
    }
    return (realSpawn as (...rest: unknown[]) => unknown).apply(childProcess, [command, args, options]);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await ensureBrowserPreview(failingSource), failingSource, '转码失败回退原件');
    assert.equal(transcodeSpawns, 1);
    assert.equal(fs.existsSync(failingPreview), false, '失败不得留下可被 existsSync 复用的 ready 半成品');
    for (const tempPath of temporaryOutputs) {
      assert.equal(fs.existsSync(tempPath), false, `失败必须清理临时文件：${path.basename(tempPath)}`);
    }
    assert.equal(
      getDb().prepare('SELECT status FROM media_derivative_jobs WHERE sourcePath = ?').pluck().get(failingSource),
      'failed',
    );
    await assert.rejects(
      ensureBrowserPreview(failingSource),
      (error: unknown) => (error as { code?: string }).code === 'browser_preview_pending',
      '失败重试窗口内不得再次转码',
    );
    assert.equal(transcodeSpawns, 1);

    // --- 并发首次访问只转码一次 ---
    const dedupeSource = path.join(dataRoot, 'dedupe-hevc.mp4');
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', dedupeSource,
    ], { timeoutMs: 60_000 });
    const dedupePreview = browserPreviewPath(dedupeSource);
    const beforeDedupe = transcodeSpawns;
    const [firstConcurrent, secondConcurrent] = await Promise.all([
      ensureBrowserPreview(dedupeSource),
      ensureBrowserPreview(dedupeSource),
    ]);
    assert.equal(firstConcurrent, dedupePreview);
    assert.equal(secondConcurrent, dedupePreview);
    assert.equal(transcodeSpawns - beforeDedupe, 1, '并发首次访问只允许转码一次');
    assert.ok(fs.statSync(dedupePreview).size > 0, '原子发布后衍生物必须完整可读');
    assert.equal(await ensureBrowserPreview(dedupeSource), dedupePreview);
    assert.equal(transcodeSpawns - beforeDedupe, 1, '已就绪衍生物不得重复转码');
    assert.deepEqual(
      fs.readdirSync(dataRoot).filter(name => name.includes('.tmp')),
      [],
      '成功发布后不得残留临时文件',
    );
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }

  // --- 过期临时文件清理：只清 24 小时前的同源临时文件，未过期/当前任务的不受影响 ---
  const staleTempsSource = path.join(dataRoot, 'stale-temps-hevc.mp4');
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', staleTempsSource,
  ], { timeoutMs: 60_000 });
  const staleTempsPreview = browserPreviewPath(staleTempsSource);
  const staleTemp = `${staleTempsPreview}.stale-owner.tmp.mp4`;
  const freshTemp = `${staleTempsPreview}.fresh-owner.tmp.mp4`;
  fs.writeFileSync(staleTemp, Buffer.from('stale'));
  fs.writeFileSync(freshTemp, Buffer.from('fresh'));
  const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(staleTemp, oldTimestamp, oldTimestamp);
  assert.equal(await ensureBrowserPreview(staleTempsSource), staleTempsPreview);
  assert.equal(fs.existsSync(staleTemp), false, '超过 24 小时的过期临时文件必须被清理');
  assert.equal(fs.existsSync(freshTemp), true, '未过期的临时文件（含当前任务）不得被清理');
  fs.rmSync(freshTemp, { force: true });

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
