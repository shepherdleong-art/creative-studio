import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as { registerHooks(hooks: {
  resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
}): void }).registerHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const candidate = new URL(`${specifier.slice(2)}.ts`, projectRootUrl);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-clip-pool-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const { getDb } = await import('../lib/db.ts');
const { runFfmpeg, probeDurationSec } = await import('../lib/ffmpeg.ts');
const { buildClipPool } = await import('../lib/final-video/clip-pool.ts');
const db = getDb();

const storage = path.join(testRoot, 'storage');
fs.mkdirSync(storage, { recursive: true });

function image(id: string, fileExists = true): string {
  const filePath = path.join(storage, `${id}.png`);
  if (fileExists) fs.writeFileSync(filePath, 'image fixture');
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path) VALUES (?, 'project', 'output', ?, ?)`)
    .run(id, `${id}.png`, filePath);
  return filePath;
}

function shot(id: string, setId: string, indexNum: number, sourceImageId: string): void {
  db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId) VALUES (?, ?, ?, ?, ?)`)
    .run(id, setId, indexNum, sourceImageId, sourceImageId);
}

function videoJob(input: {
  id: string; shotId: string; shotSetId?: string; sourceImageId: string; status?: string;
  localVideoPath?: string | null; durationSec?: number; createdAt?: string; finishedAt?: string | null;
}): void {
  db.prepare(`
    INSERT INTO video_jobs
      (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, prompt, durationSec,
       status, localVideoPath, createdAt, finishedAt)
    VALUES (?, 'project', ?, ?, ?, 'video-provider', 'model', '', ?, ?, ?, ?, ?)
  `).run(input.id, input.shotSetId ?? 'set-main', input.shotId, input.sourceImageId,
    input.durationSec ?? 99, input.status ?? 'succeeded', input.localVideoPath ?? null,
    input.createdAt ?? '2026-01-01 00:00:00', input.finishedAt ?? null);
}

try {
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, model) VALUES ('provider', 'Provider', '', 'model')`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project', 'Project', 'provider', 'model', '')`).run();
  db.prepare(`INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel) VALUES ('video-provider', 'Video', 'kling', '', '', '', 'model')`).run();
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('set-main', 'project', 'Main'), ('set-other', 'project', 'Other')`).run();

  const media = path.join(storage, 'fixture.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=25:d=1.24', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media]);
  const actualDuration = await probeDurationSec(media);
  assert.ok(actualDuration > 1 && actualDuration < 1.5, `unexpected fixture duration ${actualDuration}`);

  const oldImagePath = image('image-old');
  const selectedImagePath = image('image-selected');
  const currentImagePath = image('image-current');
  const orderImagePath = image('image-order');
  image('image-missing-path', false);
  image('image-other');

  shot('shot-later', 'set-main', 20, oldImagePath ? 'image-old' : '');
  db.prepare(`UPDATE shots SET latestGeneratedImageId = 'image-current' WHERE id = 'shot-later'`).run();
  shot('shot-first', 'set-main', 2, 'image-order');
  shot('shot-no-image', 'set-main', 30, 'image-current');
  shot('shot-no-video', 'set-main', 40, 'image-current');
  shot('shot-corrupt', 'set-main', 50, 'image-current');
  shot('shot-no-job', 'set-main', 60, 'image-current');
  shot('shot-other', 'set-other', 0, 'image-other');

  videoJob({ id: 'job-old', shotId: 'shot-later', sourceImageId: 'image-old', localVideoPath: media,
    createdAt: '2026-01-01 00:00:00', finishedAt: '2026-01-01 00:01:00' });
  videoJob({ id: 'job-selected', shotId: 'shot-later', sourceImageId: 'image-selected', localVideoPath: media,
    durationSec: 99, createdAt: '2026-01-02 00:00:00', finishedAt: '2026-01-02 00:01:00' });
  videoJob({ id: 'job-newer-failed', shotId: 'shot-later', sourceImageId: 'image-current', status: 'failed', localVideoPath: media,
    createdAt: '2026-01-03 00:00:00', finishedAt: '2026-01-03 00:01:00' });
  videoJob({ id: 'job-newer-pending', shotId: 'shot-later', sourceImageId: 'image-current', status: 'pending', localVideoPath: media,
    createdAt: '2026-01-04 00:00:00' });
  videoJob({ id: 'job-first', shotId: 'shot-first', sourceImageId: 'image-order', localVideoPath: media,
    createdAt: '2025-01-01 00:00:00', finishedAt: '2025-01-01 00:01:00' });
  videoJob({ id: 'job-no-image', shotId: 'shot-no-image', sourceImageId: 'image-missing-path', localVideoPath: media });
  videoJob({ id: 'job-no-video-old-valid', shotId: 'shot-no-video', sourceImageId: 'image-current', localVideoPath: media,
    createdAt: '2025-01-01 00:00:00', finishedAt: '2025-01-01 00:01:00' });
  videoJob({ id: 'job-no-video', shotId: 'shot-no-video', sourceImageId: 'image-current', localVideoPath: path.join(storage, 'missing.mp4'),
    createdAt: '2026-01-01 00:00:00', finishedAt: '2026-01-01 00:01:00' });
  const corrupt = path.join(storage, 'corrupt.mp4');
  fs.writeFileSync(corrupt, 'not media');
  videoJob({ id: 'job-corrupt', shotId: 'shot-corrupt', sourceImageId: 'image-current', localVideoPath: corrupt });
  videoJob({ id: 'job-other', shotId: 'shot-other', shotSetId: 'set-other', sourceImageId: 'image-other', localVideoPath: media });
  // A job linked to the main shot but belonging to another set must never leak into the result.
  videoJob({ id: 'job-cross-set', shotId: 'shot-no-job', shotSetId: 'set-other', sourceImageId: 'image-other', localVideoPath: media });

  const result = await buildClipPool('set-main');
  assert.deepEqual(result.clips.map((clip) => clip.clipId), ['job-first', 'job-selected']);
  assert.deepEqual(result.clips.map((clip) => clip.shotIndex), [2, 20]);

  const selected = result.clips[1];
  assert.equal(selected.sourceImageId, 'image-selected');
  assert.equal(selected.sourceImagePath, selectedImagePath);
  assert.notEqual(selected.sourceImagePath, currentImagePath);
  assert.equal(selected.videoPath, media);
  assert.ok(Math.abs(selected.clipDurationSec - actualDuration) < 0.01);
  assert.notEqual(selected.clipDurationSec, 99);
  assert.equal(selected.visualDescription, '');
  assert.equal(selected.descriptionProviderId, null);
  assert.equal(selected.descriptionModel, null);
  assert.equal(result.clips[0].sourceImagePath, orderImagePath);

  assert.deepEqual(result.issues.map((issue) => issue.clipId), ['job-no-image', 'job-no-video', 'job-corrupt', null]);
  assert.ok(result.issues.every((issue) => issue.code === 'clip_missing' && issue.severity === 'warning'));
  assert.ok(result.issues.every((issue) => issue.beatIds.length === 0));
  assert.ok(!result.clips.some((clip) => clip.clipId === 'job-old' || clip.clipId === 'job-other' || clip.clipId === 'job-cross-set'));
  assert.ok(!result.clips.some((clip) => clip.clipId === 'job-no-video-old-valid'), 'must not fall back after selecting the newest successful job');
  assert.equal(oldImagePath.endsWith('image-old.png'), true);

  await assert.rejects(() => buildClipPool(''), /shotSetId is required/);
  await assert.rejects(() => buildClipPool('missing-set'), /Shot set not found/);
  const other = await buildClipPool('set-other');
  assert.deepEqual(other.clips.map((clip) => clip.clipId), ['job-other']);

  console.log('final-video clip pool tests passed');
} finally {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
