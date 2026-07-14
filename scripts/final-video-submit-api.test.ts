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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-submit-api-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const previewRoute = await import('../app/api/final-video-drafts/[id]/preview/route.ts');
const renderRoute = await import('../app/api/final-video-drafts/[id]/render/route.ts');
const legacyPreviewRoute = await import('../app/api/projects/[id]/final-videos/preview/route.ts');
const { getDb } = await import('../lib/db.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');
const { createFinalVideoDraft, getFinalVideoDraft, updateFinalVideoDraft } = await import('../lib/final-video/draft-store.ts');
const { getFinalVideoQueueStatus } = await import('../lib/final-video/render-queue.ts');

const db = getDb();
const draftNarrationRoot = path.join(testRoot, 'storage', 'final-video-drafts');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (revision: unknown) => new Request('http://test/api', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision }),
});
const response = async (promise: Promise<Response>) => {
  const value = await promise;
  return { status: value.status, body: await value.json() as Record<string, unknown> };
};
const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

function workflow() {
  const packageConfig = defaultPackageConfig();
  return {
    packageConfig: {
      ...packageConfig,
      outputName: 'submitted',
      width: 120,
      height: 240,
      fps: 25,
      targetDurationSec: 0.4,
      durationTolerancePct: 1,
      subtitle: { ...packageConfig.subtitle, enabled: false },
      mode: 'narration' as const,
      narration: { mode: 'tts' as const, providerId: 'never-called', voice: 'unused', speed: 1 },
    },
    selectedClipIds: [],
  };
}

async function makeAudio(draftId: string): Promise<string> {
  const audioPath = path.join(draftNarrationRoot, draftId, 'narration', 'group-1.m4a');
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-c:a', 'aac', audioPath]);
  return audioPath;
}

async function seedDraft(input: { stage?: string; revision?: number; videoPath: string }) {
  const draft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: workflow() });
  const audioPath = await makeAudio(draft.id);
  const beats = [{ beatId: 'beat-1', index: 0, text: '提交快照', subtitleText: '提交快照', shotId: 'shot-1', imageAssetId: 'image-1', audioPath, durationSec: 0.4, startSec: 0 }];
  const clips = [{
    clipId: 'clip-1', shotId: 'shot-1', shotIndex: 0, videoPath: input.videoPath, clipDurationSec: 0.4,
    sourceImageId: 'image-1', sourceImagePath: path.join(testRoot, 'source.png'),
  }];
  db.prepare(`UPDATE final_video_drafts SET
    stage = ?, revision = ?, narrationBeatsJson = ?, clipPoolJson = ?, arrangementJson = ?, issuesJson = ?
    WHERE id = ?`)
    .run(input.stage ?? 'review', input.revision ?? 0, JSON.stringify(beats), JSON.stringify(clips),
      JSON.stringify({ assignments: [{ assignmentId: 'assignment-1', clipId: 'clip-1', beatIds: ['beat-1'] }], gaps: [] }),
      JSON.stringify([{ code: 'visual_gap', severity: 'warning', message: 'persisted issue', beatIds: ['beat-1'], clipId: null }]), draft.id);
  return getFinalVideoDraft(draft.id)!;
}

try {
  db.prepare(`INSERT INTO providers (id, name, baseUrl, model) VALUES ('provider', 'Provider', '', 'model')`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-1', 'Project', 'provider', 'model', '')`).run();
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('shot-set-1', 'project-1', 'Set')`).run();

  const mediaDir = path.join(testRoot, 'fixtures');
  fs.mkdirSync(mediaDir, { recursive: true });
  const videoPath = path.join(mediaDir, 'clip.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=120x240:r=25:d=0.4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
  const wrongStageSeed = await seedDraft({ stage: 'draft', videoPath });
  assert.equal((await response(previewRoute.POST(request(0), ctx(wrongStageSeed.id)))).status, 400);
  assert.equal((await response(renderRoute.POST(request(0), ctx(wrongStageSeed.id)))).status, 400);

  const escapedNarrationDraft = await seedDraft({ videoPath });
  const escapedNarrationDir = path.join(draftNarrationRoot, escapedNarrationDraft.id, 'narration');
  const outsideNarrationDir = path.join(mediaDir, 'escaped-narration');
  fs.mkdirSync(outsideNarrationDir, { recursive: true });
  fs.renameSync(path.join(escapedNarrationDir, 'group-1.m4a'), path.join(outsideNarrationDir, 'group-1.m4a'));
  fs.rmdirSync(escapedNarrationDir);
  fs.symlinkSync(outsideNarrationDir, escapedNarrationDir);
  assert.equal((await response(previewRoute.POST(request(0), ctx(escapedNarrationDraft.id)))).status, 400);

  const staleDraft = await seedDraft({ videoPath, revision: 1 });
  assert.deepEqual(await response(previewRoute.POST(request(0), ctx(staleDraft.id))), {
    status: 409, body: { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' },
  });
  assert.deepEqual(await response(renderRoute.POST(request(0), ctx(staleDraft.id))), {
    status: 409, body: { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' },
  });

  const previewDraft = await seedDraft({ videoPath });
  const submittedPreview = await response(previewRoute.POST(request(0), ctx(previewDraft.id)));
  assert.equal(submittedPreview.status, 200);
  const previewJobId = submittedPreview.body.jobId as string;
  assert.ok(previewJobId);
  const previewJob = db.prepare(`SELECT * FROM final_video_jobs WHERE id = ?`).get(previewJobId) as Record<string, unknown>;
  assert.equal(previewJob.kind, 'preview');
  assert.equal(previewJob.draftId, previewDraft.id);
  assert.equal(previewJob.draftRevision, 0);
  const previewBeats = JSON.parse(previewJob.narrationBeatsJson as string) as Array<{ audioPath: string }>;
  assert.notEqual(previewBeats[0].audioPath, path.join(draftNarrationRoot, previewDraft.id, 'narration', 'group-1.m4a'));
  assert.ok(previewBeats[0].audioPath.startsWith(path.join(testRoot, 'storage', 'final-videos', previewJobId, 'work') + path.sep));
  assert.deepEqual(fs.readFileSync(previewBeats[0].audioPath), fs.readFileSync(path.join(draftNarrationRoot, previewDraft.id, 'narration', 'group-1.m4a')));
  assert.deepEqual(JSON.parse(previewJob.clipPoolJson as string).map((clip: { clipId: string }) => clip.clipId), ['clip-1']);

  // The insert is durable before the queue is kicked: even if the queue immediately claims it,
  // its immutable snapshot row already exists with the job-local narration path.
  assert.ok(['pending', 'running', 'succeeded'].includes(previewJob.status as string));
  await waitFor(() => getFinalVideoQueueStatus() === 'idle', 'preview queue');
  await waitFor(() => getFinalVideoDraft(previewDraft.id)?.previewJobId === previewJobId, 'preview draft writeback');
  assert.equal(getFinalVideoDraft(previewDraft.id)?.previewRevision, 0);

  // BGM-only submission persists the explicit review selection in the immutable
  // job snapshot and does not require a script, narration beat, or arrangement.
  const bgmBase = defaultPackageConfig();
  const bgmWorkflow = {
    packageConfig: {
      ...bgmBase,
      outputName: 'submitted-bgm', width: 120, height: 240, fps: 25,
      targetDurationSec: 0.4,
      subtitle: { ...bgmBase.subtitle, enabled: true },
    },
    selectedClipIds: ['clip-1'],
  };
  const emptyBgmDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: { ...bgmWorkflow, selectedClipIds: [] } });
  db.prepare(`UPDATE final_video_drafts SET stage = 'review' WHERE id = ?`).run(emptyBgmDraft.id);
  assert.equal((await response(previewRoute.POST(request(0), ctx(emptyBgmDraft.id)))).status, 400, 'BGM-only jobs need at least one selected clip');
  const bgmDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: bgmWorkflow });
  db.prepare(`UPDATE final_video_drafts SET stage = 'review', clipPoolJson = ? WHERE id = ?`)
    .run(JSON.stringify([{
      clipId: 'clip-1', shotId: 'shot-1', shotIndex: 0, videoPath, clipDurationSec: 0.4,
      sourceImageId: 'image-1', sourceImagePath: path.join(testRoot, 'source.png'),
    }]), bgmDraft.id);
  const submittedBgm = await response(previewRoute.POST(request(0), ctx(bgmDraft.id)));
  assert.equal(submittedBgm.status, 200);
  const bgmJobId = submittedBgm.body.jobId as string;
  const bgmJob = db.prepare(`SELECT selectedClipIdsJson, narrationBeatsJson, arrangementJson FROM final_video_jobs WHERE id = ?`).get(bgmJobId) as Record<string, string>;
  assert.deepEqual(JSON.parse(bgmJob.selectedClipIdsJson), ['clip-1']);
  assert.deepEqual(JSON.parse(bgmJob.narrationBeatsJson), []);
  assert.deepEqual(JSON.parse(bgmJob.arrangementJson), { assignments: [], gaps: [] });
  await waitFor(() => getFinalVideoQueueStatus() === 'idle', 'bgm queue');

  const finalDraft = await seedDraft({ videoPath });
  const submittedFinal = await response(renderRoute.POST(request(0), ctx(finalDraft.id)));
  assert.equal(submittedFinal.status, 200);
  const finalJobId = submittedFinal.body.jobId as string;
  assert.equal((db.prepare(`SELECT kind FROM final_video_jobs WHERE id = ?`).get(finalJobId) as { kind: string }).kind, 'final');
  await waitFor(() => getFinalVideoQueueStatus() === 'idle', 'final queue');

  const stalePreviewDraft = await seedDraft({ videoPath });
  const stalePreview = await response(previewRoute.POST(request(0), ctx(stalePreviewDraft.id)));
  assert.equal(stalePreview.status, 200);
  updateFinalVideoDraft(stalePreviewDraft.id, 0, { stage: 'review' });
  await waitFor(() => getFinalVideoQueueStatus() === 'idle', 'stale preview queue');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(getFinalVideoDraft(stalePreviewDraft.id)?.previewJobId, null);
  assert.equal(getFinalVideoDraft(stalePreviewDraft.id)?.previewRevision, null);

  const oldPreview = await response(legacyPreviewRoute.GET(new NextRequest('http://test/api?shotSetId=shot-set-1'), ctx('project-1')));
  assert.equal(oldPreview.status, 200);
  assert.deepEqual(oldPreview.body, {
    error: 'draft_workflow_required',
    message: '预览已迁移到成片草稿工作流，请使用当前草稿创建 preview job',
    currentDraft: { id: stalePreviewDraft.id, stage: 'review', revision: 1, previewJobId: null, previewRevision: null },
    draft: null,
    segments: [],
    issues: [],
    totalDurationSec: 0,
  });

  const submitJobSource = fs.readFileSync(new URL('../lib/final-video/submit-job.ts', import.meta.url), 'utf8');
  assert.ok(submitJobSource.indexOf('INSERT INTO final_video_jobs') < submitJobSource.indexOf('startFinalVideoQueue();'));
  const legacySource = fs.readFileSync(new URL('../app/api/projects/[id]/final-videos/preview/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(legacySource, /buildTimeline|video_jobs|script_drafts/);
  console.log('final-video-submit-api tests passed');
} finally {
  await waitFor(() => getFinalVideoQueueStatus() === 'idle', 'queue cleanup');
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
