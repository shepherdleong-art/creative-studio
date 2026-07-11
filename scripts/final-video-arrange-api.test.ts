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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-arrange-api-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const arrangeRoute = await import('../app/api/final-video-drafts/[id]/arrange/route.ts');
const { getDb } = await import('../lib/db.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');
const { createFinalVideoDraft, getFinalVideoDraft, updateFinalVideoDraft } = await import('../lib/final-video/draft-store.ts');

const db = getDb();
const beats = [
  { beatId: 'beat-1', groupId: 'group-1', index: 0, text: '第一句口播', audioPath: '/narration/one.mp3', durationSec: 1, startSec: 0 },
  { beatId: 'beat-2', groupId: 'group-2', index: 1, text: '第二句口播', audioPath: '/narration/two.mp3', durationSec: 1, startSec: 1 },
];
const clips = [
  { clipId: 'clip-1', shotId: 'shot-1', shotIndex: 0, videoPath: '/video/one.mp4', clipDurationSec: 4,
    sourceImageId: 'image-1', sourceImagePath: '/image/one.png', visualDescription: '白色产品特写', descriptionProviderId: 'vision', descriptionModel: 'vision-model' },
  { clipId: 'clip-2', shotId: 'shot-2', shotIndex: 1, videoPath: '/video/two.mp4', clipDurationSec: 4,
    sourceImageId: 'image-2', sourceImagePath: '/image/two.png', visualDescription: '产品使用场景', descriptionProviderId: 'vision', descriptionModel: 'vision-model' },
];

function workflow() {
  const packageConfig = defaultPackageConfig();
  return {
    packageConfig: {
      ...packageConfig,
      mode: 'narration' as const,
      narration: { mode: 'tts' as const, providerId: 'edge', voice: 'zh-CN-XiaoxiaoNeural', speed: 1 },
    },
    narrationScriptProviderId: 'qwen',
    visionProviderId: 'qwen',
    orchestrationProviderId: 'qwen',
    selectedClipIds: [],
  };
}

function seedDraft(input: { stage?: string; narrationBeats?: unknown; clipPool?: unknown; revision?: number } = {}) {
  const draft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: workflow() });
  db.prepare(`UPDATE final_video_drafts
    SET stage = ?, revision = ?, narrationBeatsJson = ?, clipPoolJson = ?,
        arrangementJson = ?, issuesJson = ?, previewJobId = 'preview-job', previewRevision = 0
    WHERE id = ?`)
    .run(input.stage ?? 'narration-ready', input.revision ?? 0, JSON.stringify(input.narrationBeats ?? beats), JSON.stringify(input.clipPool ?? clips),
      JSON.stringify({ assignments: [{ assignmentId: 'old', clipId: 'clip-1', beatIds: ['beat-1'] }], gaps: [{ beatId: 'beat-2', reason: 'old gap' }]}),
      JSON.stringify([{ code: 'visual_gap', severity: 'warning', message: 'old issue', beatIds: ['beat-2'], clipId: null }]), draft.id);
  return getFinalVideoDraft(draft.id)!;
}

function request(body: unknown): Request {
  return new Request('http://test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function malformedRequest(): Request {
  return new Request('http://test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
}
function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
async function result(pending: Promise<Response>) { const response = await pending; return { status: response.status, body: await response.json() as Record<string, unknown> }; }
async function arrange(id: string, body: unknown) { return result(arrangeRoute.POST(request(body), ctx(id))); }

const originalFetch = globalThis.fetch;
let response: Response = Response.json({ choices: [{ message: { content: JSON.stringify({
  assignments: [{ clipId: 'clip-1', beatIds: ['beat-1'] }, { clipId: 'clip-2', beatIds: ['beat-2'] }], gaps: [],
}) } }] });
let fetchPause: Promise<void> | null = null;
let releaseFetch: () => void = () => { throw new Error('fetch was not paused'); };
let fetchStarted: (() => void) | null = null;
function pauseFetch(): void { fetchPause = new Promise<void>((resolve) => { releaseFetch = resolve; }); }
globalThis.fetch = (async () => {
  fetchStarted?.();
  if (fetchPause) await fetchPause;
  return response.clone();
}) as typeof fetch;

try {
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, model) VALUES ('provider', 'Provider', '', 'model')`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-1', 'Project', 'provider', 'model', '')`).run();
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('shot-set-1', 'project-1', 'One')`).run();
  db.prepare(`INSERT INTO final_video_jobs (id, projectId, shotSetId) VALUES ('preview-job', 'project-1', 'shot-set-1')`).run();
  db.prepare(`UPDATE script_providers SET baseUrl = ?, apiKey = ?, model = ?, apiStyle = 'openai-compatible', enabled = 1 WHERE id = 'qwen'`)
    .run('https://qwen.example/api', 'qwen-key', 'qwen-model');

  const ready = seedDraft();
  assert.equal((await result(arrangeRoute.POST(malformedRequest(), ctx(ready.id)))).status, 400);
  assert.equal((await arrange(ready.id, { revision: 0 })).status, 400);
  assert.equal((await arrange(ready.id, { revision: 0, providerId: 'qwen', extra: true })).status, 400);
  assert.equal((await arrange(ready.id, { revision: -1, providerId: 'qwen' })).status, 400);
  assert.equal((await arrange('missing', { revision: 0, providerId: 'qwen' })).status, 404);

  const wrongStage = seedDraft({ stage: 'draft' });
  assert.equal((await arrange(wrongStage.id, { revision: 0, providerId: 'qwen' })).status, 400);
  assert.deepEqual(getFinalVideoDraft(wrongStage.id), wrongStage);
  const emptyBeats = seedDraft({ narrationBeats: [] });
  assert.equal((await arrange(emptyBeats.id, { revision: 0, providerId: 'qwen' })).status, 400);
  const emptyClips = seedDraft({ clipPool: [] });
  assert.equal((await arrange(emptyClips.id, { revision: 0, providerId: 'qwen' })).status, 400);

  const review = seedDraft({ stage: 'review' });
  assert.equal((await arrange(review.id, { revision: 0, providerId: 'qwen' })).status, 200);
  assert.equal(getFinalVideoDraft(review.id)?.stage, 'review');

  const staleInitial = seedDraft({ revision: 1 });
  assert.deepEqual(await arrange(staleInitial.id, { revision: 0, providerId: 'qwen' }), {
    status: 409, body: { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' },
  });

  // The in-flight state is durable; a normal arrangement writes the model plan and issues,
  // clears preview metadata, and increments revision twice.
  const success = seedDraft();
  let markFetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  fetchStarted = markFetchStarted;
  pauseFetch();
  const pending = arrange(success.id, { revision: 0, providerId: 'qwen' });
  await started;
  assert.equal(getFinalVideoDraft(success.id)?.stage, 'arranging');
  assert.equal(getFinalVideoDraft(success.id)?.revision, 1);
  releaseFetch();
  fetchPause = null;
  const successResult = await pending;
  assert.equal(successResult.status, 200);
  const successDraft = successResult.body.draft as Record<string, unknown>;
  assert.equal(successDraft.stage, 'review');
  assert.equal(successDraft.revision, 2);
  assert.deepEqual(successDraft.arrangement, {
    assignments: [
      { assignmentId: 'llm-0', clipId: 'clip-1', beatIds: ['beat-1'] },
      { assignmentId: 'llm-1', clipId: 'clip-2', beatIds: ['beat-2'] },
    ],
    gaps: [],
  });
  assert.deepEqual(successDraft.issues, []);
  assert.equal(successDraft.previewJobId, null);
  assert.equal(successDraft.previewRevision, null);
  assert.equal(successDraft.errorMessage, null);

  // buildArrangement owns model/provider errors and returns a fallback warning rather than
  // letting the route return 500 or leave the draft in arranging.
  response = new Response('provider failed', { status: 502 });
  const fallback = seedDraft();
  const fallbackResult = await arrange(fallback.id, { revision: 0, providerId: 'qwen' });
  assert.equal(fallbackResult.status, 200);
  const fallbackDraft = fallbackResult.body.draft as Record<string, unknown>;
  assert.equal(fallbackDraft.stage, 'review');
  assert.equal((fallbackDraft.issues as Array<Record<string, unknown>>).at(-1)?.code, 'arrangement_fallback_used');
  assert.equal((fallbackDraft.issues as Array<Record<string, unknown>>).at(-1)?.severity, 'warning');

  // A concurrent writer after the first CAS wins. The request returns the shared stale
  // contract and never overwrites that newer draft with an arrangement result.
  response = Response.json({ choices: [{ message: { content: JSON.stringify({
    assignments: [{ clipId: 'clip-1', beatIds: ['beat-1'] }, { clipId: 'clip-2', beatIds: ['beat-2'] }], gaps: [],
  }) } }] });
  const staleFinal = seedDraft();
  let markRaceStarted!: () => void;
  const raceStarted = new Promise<void>((resolve) => { markRaceStarted = resolve; });
  fetchStarted = markRaceStarted;
  pauseFetch();
  const race = arrange(staleFinal.id, { revision: 0, providerId: 'qwen' });
  await raceStarted;
  updateFinalVideoDraft(staleFinal.id, 1, { stage: 'review', errorMessage: 'newer writer won' });
  releaseFetch();
  fetchPause = null;
  assert.deepEqual(await race, {
    status: 409, body: { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' },
  });
  assert.equal(getFinalVideoDraft(staleFinal.id)?.errorMessage, 'newer writer won');

  console.log('final-video-arrange-api tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
