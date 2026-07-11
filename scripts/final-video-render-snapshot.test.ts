import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server.js';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as { registerHooks(hooks: {
  resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
}): void }).registerHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-render-snapshot-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const { getDb } = await import('../lib/db.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');
const { startFinalVideoQueue, getFinalVideoQueueStatus } = await import('../lib/final-video/render-queue.ts');
const legacyRoute = await import('../app/api/projects/[id]/final-videos/route.ts');
const retryRoute = await import('../app/api/final-video-jobs/[id]/retry/route.ts');

const db = getDb();
const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const response = async (promise: Promise<Response>) => ({ status: (await promise).status, body: await (await promise).json() as Record<string, unknown> });

try {
  db.prepare(`INSERT INTO providers (id, name, baseUrl, model) VALUES ('provider', 'Provider', '', 'model')`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-1', 'Project', 'provider', 'model', '')`).run();
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('shot-set-1', 'project-1', 'Set')`).run();

  const mediaDir = path.join(testRoot, 'fixtures');
  fs.mkdirSync(mediaDir, { recursive: true });
  const clipPath = path.join(mediaDir, 'clip.mp4');
  const audioPath = path.join(mediaDir, 'narration.m4a');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=25:d=1.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath]);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:a', 'aac', audioPath]);

  const packageConfig = {
    ...defaultPackageConfig(),
    mode: 'narration' as const,
    outputName: 'snapshot-preview',
    width: 1080,
    height: 1920,
    fps: 25,
    targetDurationSec: 1.2,
    durationTolerancePct: 0.5,
    maxClipSeconds: 4,
    narration: { mode: 'tts' as const, providerId: 'must-not-run', voice: 'unused', speed: 1 },
    cover: { ...defaultPackageConfig().cover, titleText: 'Snapshot', introDurationSec: 0 },
  };
  const beats = [{ beatId: 'beat-1', groupId: 'group-1', index: 0, text: 'Snapshot narration', audioPath, durationSec: 1.2, startSec: 0 }];
  const clips = [{
    clipId: 'clip-1', shotId: 'shot-1', shotIndex: 0, videoPath: clipPath, clipDurationSec: 1.2,
    sourceImageId: 'image-1', sourceImagePath: path.join(mediaDir, 'image.png'), visualDescription: 'blue image',
    descriptionProviderId: null, descriptionModel: null,
  }];
  const arrangement = { assignments: [{ assignmentId: 'assignment-1', clipId: 'clip-1', beatIds: ['beat-1'] }], gaps: [] };
  const issues = [{ code: 'visual_gap', severity: 'warning' as const, message: 'Persisted issue', beatIds: ['beat-1'], clipId: null }];
  const insertJob = db.prepare(`
    INSERT INTO final_video_jobs (
      id, projectId, shotSetId, status, packageJson, kind, draftId, draftRevision,
      narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, solverVersion
    ) VALUES (?, 'project-1', 'shot-set-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // A v2-only queue must never recover or consume legacy jobs, even if their
  // status says pending/running. They remain visible for historical diagnosis.
  insertJob.run('legacy-pending', 'pending', '{}', 'final', null, null,
    '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', 1);
  insertJob.run('legacy-running', 'running', '{}', 'final', null, null,
    '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', 1);
  insertJob.run('preview-v2', 'pending', JSON.stringify(packageConfig), 'preview', 'draft-1', 7,
    JSON.stringify(beats), JSON.stringify(clips), JSON.stringify(arrangement), JSON.stringify(issues), 2);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('rendering a persisted snapshot must not call a paid API'); }) as typeof fetch;
  startFinalVideoQueue();
  await waitFor(() => getFinalVideoQueueStatus() === 'idle', 'snapshot job queue');
  globalThis.fetch = originalFetch;

  const rendered = db.prepare(`SELECT * FROM final_video_jobs WHERE id = 'preview-v2'`).get() as { status: string; manifestPath: string | null; outputPath: string | null };
  assert.equal(rendered.status, 'succeeded', 'v2 job must render without script_drafts or video_jobs rows');
  assert.equal((db.prepare(`SELECT status FROM final_video_jobs WHERE id = 'legacy-pending'`).get() as { status: string }).status, 'pending');
  assert.equal((db.prepare(`SELECT status FROM final_video_jobs WHERE id = 'legacy-running'`).get() as { status: string }).status, 'running');
  assert.ok(rendered.outputPath && fs.existsSync(rendered.outputPath));
  assert.ok(rendered.manifestPath && fs.existsSync(rendered.manifestPath));
  const manifest = JSON.parse(fs.readFileSync(rendered.manifestPath!, 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.draftRevision, 7);
  assert.deepEqual(manifest.beats, beats);
  assert.deepEqual(manifest.arrangement, arrangement);
  assert.deepEqual(manifest.issues, issues);
  assert.equal(manifest.solverVersion, 2);
  assert.deepEqual(manifest.output, {
    video: rendered.outputPath,
    cover: path.join(testRoot, 'storage', 'final-videos', 'preview-v2', 'cover.jpg'),
    durationSec: (manifest.output as { durationSec: number }).durationSec,
    width: 540,
    height: 960,
  });

  // Legacy final successes continue to be visible, while preview jobs stay internal to the draft workflow.
  insertJob.run('legacy-success', 'succeeded', '{}', 'final', null, null, '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', 1);
  const listed = await response(legacyRoute.GET(new NextRequest('http://test/api'), ctx('project-1')));
  assert.equal(listed.status, 200);
  const listedIds = (listed.body.jobs as Array<{ id: string }>).map((job) => job.id);
  assert.ok(listedIds.includes('legacy-success'));
  assert.ok(!listedIds.includes('preview-v2'));
  const legacyPost = await response(legacyRoute.POST(new NextRequest('http://test/api', { method: 'POST' }), ctx('project-1')));
  assert.deepEqual(legacyPost, { status: 409, body: { error: 'draft_workflow_required' } });

  insertJob.run('legacy-failed', 'failed', '{}', 'final', null, null, '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', 1);
  const legacyRetry = await response(retryRoute.POST(new NextRequest('http://test/api', { method: 'POST' }), ctx('legacy-failed')));
  assert.equal(legacyRetry.status, 409);
  assert.match(String(legacyRetry.body.error), /新建成片草稿/);

  insertJob.run('final-v2-retry', 'failed', JSON.stringify(packageConfig), 'final', 'draft-1', 7,
    JSON.stringify(beats), JSON.stringify(clips), JSON.stringify(arrangement), JSON.stringify(issues), 2);
  const v2Retry = await response(retryRoute.POST(new NextRequest('http://test/api', { method: 'POST' }), ctx('final-v2-retry')));
  assert.deepEqual(v2Retry, { status: 200, body: { success: true } });
  await waitFor(() => (db.prepare(`SELECT status FROM final_video_jobs WHERE id = 'final-v2-retry'`).get() as { status: string }).status === 'succeeded', 'v2 retry');

  const source = fs.readFileSync(new URL('../lib/final-video/render-queue.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /FROM script_drafts|FROM video_jobs/);
  assert.doesNotMatch(source, /synthesizeNarrationSegments|describeClip|buildArrangement/);
  assert.match(source, /preview[\s\S]*540|540[\s\S]*preview/);
  assert.match(source, /ultrafast/);
  assert.match(source, /['"]28['"]/);
  console.log('final-video-render-snapshot tests passed');
} finally {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
