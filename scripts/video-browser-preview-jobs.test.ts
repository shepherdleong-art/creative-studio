import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  setExecutionModuleRuntime({ instanceId: 'preview-test', fence: 1, facade: {} as ExecutionFacade });
  let release!: () => void;
  const occupied = withMediaResource({ taskId: 'other-render', wait: true }, () => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(ensureBrowserPreview(source), (error: unknown) => (error as { code?: string }).code === 'browser_preview_pending');
  release();
  await occupied;
  clearExecutionModuleRuntime();
  assert.equal(await ensureBrowserPreview(source), preview);

  console.log('video browser preview jobs: persistent dedupe, lease recovery and retryable capacity pending passed');
} finally {
  clearExecutionModuleRuntime();
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
