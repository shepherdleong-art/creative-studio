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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-draft-api-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const collection = await import('../app/api/projects/[id]/final-video-drafts/route.ts');
const item = await import('../app/api/final-video-drafts/[id]/route.ts');
const { getDb } = await import('../lib/db.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');
const db = getDb();

db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, model) VALUES ('provider', 'Provider', '', 'model')`).run();
for (const id of ['project-1', 'project-2']) {
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES (?, ?, 'provider', 'model', '')`).run(id, id);
}
db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('shot-set-1', 'project-1', 'One')`).run();
db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('shot-set-2', 'project-2', 'Two')`).run();
for (const [id, projectId] of [['script-1', 'project-1'], ['script-2', 'project-2']]) {
  db.prepare(`INSERT INTO script_drafts (id, projectId, model, inputSnapshot, outputJson) VALUES (?, ?, 'model', '{}', '{}')`).run(id, projectId);
}
db.prepare(`INSERT INTO final_video_jobs (id, projectId, shotSetId) VALUES ('preview-job', 'project-1', 'shot-set-1')`).run();

const bgmWorkflow = (overrides: Record<string, unknown> = {}) => ({
  packageConfig: { ...defaultPackageConfig(), outputName: 'api-test' },
  selectedClipIds: ['clip-1'], ...overrides,
});
const narrationWorkflow = () => ({
  ...bgmWorkflow(), selectedClipIds: [],
  packageConfig: {
    ...defaultPackageConfig(), mode: 'narration', outputName: 'narration-test',
    narration: { mode: 'tts', providerId: 'tts-provider', voice: 'Cherry', speed: 1 },
  },
});
const jsonRequest = (url: string, method: string, body?: unknown) => new Request(url, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const collectionContext = (id: string) => ({ params: Promise.resolve({ id }) });
const itemContext = (id: string) => ({ params: Promise.resolve({ id }) });
const responseJson = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });

async function create(projectId: string, body: unknown) {
  return responseJson(await collection.POST(jsonRequest('http://test/api', 'POST', body), collectionContext(projectId)));
}
async function patchDraft(id: string, body: unknown) {
  return responseJson(await item.PATCH(jsonRequest('http://test/api', 'PATCH', body), itemContext(id)));
}
function assertParsedDraft(draft: Record<string, unknown>) {
  for (const key of ['workflowConfig', 'narrationBeats', 'clipPool', 'arrangement', 'issues']) assert.ok(key in draft, key);
  for (const key of ['workflowConfigJson', 'narrationBeatsJson', 'clipPoolJson', 'arrangementJson', 'issuesJson']) assert.ok(!(key in draft), key);
}

const snapshots = {
  narrationBeats: [
    { beatId: 'beat-1', index: 0, text: 'one', subtitleText: 'one', shotId: 'shot-1', imageAssetId: 'image-1', audioPath: '/a.wav', durationSec: 2, startSec: 0 },
    { beatId: 'beat-2', index: 1, text: 'two', subtitleText: 'two', shotId: 'shot-2', imageAssetId: 'image-2', audioPath: '/a.wav', durationSec: 2, startSec: 2 },
    { beatId: 'beat-3', index: 2, text: 'three', subtitleText: 'three', shotId: 'shot-3', imageAssetId: 'image-3', audioPath: '/b.wav', durationSec: 2, startSec: 4 },
  ],
  clipPool: [{ clipId: 'clip-1', shotId: 'shot-1', shotIndex: 0, videoPath: '/v.mp4', clipDurationSec: 2,
    sourceImageId: 'image-1', sourceImagePath: '/i.png' }],
  arrangement: { assignments: [{ assignmentId: 'a-1', clipId: 'clip-1', beatIds: ['beat-1'] }], gaps: [] },
  issues: [{ code: 'visual_gap', severity: 'warning', message: 'gap', beatIds: ['beat-1'], clipId: null }],
};
function seedSnapshots(id: string) {
  db.prepare(`UPDATE final_video_drafts SET narrationBeatsJson=?, clipPoolJson=?, arrangementJson=?, issuesJson=?, previewJobId='preview-job', previewRevision=0 WHERE id=?`)
    .run(JSON.stringify(snapshots.narrationBeats), JSON.stringify(snapshots.clipPool), JSON.stringify(snapshots.arrangement), JSON.stringify(snapshots.issues), id);
}
async function newSeededDraft(workflow = bgmWorkflow()) {
  const result = await create('project-1', { shotSetId: 'shot-set-1', workflowConfig: workflow });
  assert.equal(result.status, 200);
  const draft = result.body.draft as Record<string, unknown>;
  seedSnapshots(draft.id as string);
  return { id: draft.id as string, workflow: draft.workflowConfig as Record<string, unknown> };
}

try {
  assert.equal((await create('missing', { shotSetId: 'shot-set-1', workflowConfig: bgmWorkflow() })).status, 404);
  assert.equal((await create('project-1', { shotSetId: 'missing', workflowConfig: bgmWorkflow() })).status, 404);
  assert.equal((await create('project-1', { shotSetId: 'shot-set-2', workflowConfig: bgmWorkflow() })).status, 404);

  const narrationMissing = await create('project-1', { shotSetId: 'shot-set-1', workflowConfig: narrationWorkflow() });
  assert.equal(narrationMissing.status, 400);
  assert.match(String(narrationMissing.body.error), /口播.*脚本/);
  assert.equal((await create('project-1', { shotSetId: 'shot-set-1', scriptDraftId: 'missing', workflowConfig: narrationWorkflow() })).status, 404);
  assert.equal((await create('project-1', { shotSetId: 'shot-set-1', scriptDraftId: 'script-2', workflowConfig: narrationWorkflow() })).status, 404);
  assert.equal((await create('project-1', { shotSetId: 'shot-set-1', scriptDraftId: 'script-1', workflowConfig: narrationWorkflow() })).status, 200);
  assert.equal((await create('project-1', { shotSetId: 'shot-set-1', workflowConfig: bgmWorkflow() })).status, 200);
  assert.equal((await create('project-1', { shotSetId: 'shot-set-1', scriptDraftId: 'script-2', workflowConfig: bgmWorkflow() })).status, 404);
  assert.equal((await create('project-1', { shotSetId: 'shot-set-1', workflowConfig: { bad: true } })).status, 400);

  const created = await create('project-1', { shotSetId: 'shot-set-1', workflowConfig: bgmWorkflow() });
  assert.equal(created.status, 200);
  const createdDraft = created.body.draft as Record<string, unknown>;
  assert.equal(createdDraft.revision, 0);
  assertParsedDraft(createdDraft);
  const createdId = createdDraft.id as string;

  assert.equal((await patchDraft(createdId, { revision: 0, surprise: true })).status, 400);
  assert.equal((await patchDraft(createdId, {})).status, 400);
  assert.equal((await patchDraft(createdId, { revision: -1 })).status, 400);
  assert.equal((await patchDraft(createdId, { revision: 0.5 })).status, 400);
  assert.equal((await patchDraft(createdId, { revision: 0, workflowConfig: { bad: true } })).status, 400);
  assert.equal((await patchDraft(createdId, { revision: 0, arrangement: { assignments: 'bad', gaps: [] } })).status, 400);

  const firstPatch = await patchDraft(createdId, { revision: 0, arrangement: { assignments: [], gaps: [] } });
  assert.equal(firstPatch.status, 200);
  assert.equal((firstPatch.body.draft as Record<string, unknown>).revision, 1);
  assert.deepEqual(await responseJson(await item.PATCH(jsonRequest('http://test/api', 'PATCH', { revision: 0, arrangement: { assignments: [], gaps: [] } }), itemContext(createdId))), {
    status: 409, body: { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' },
  });
  assert.deepEqual((await patchDraft('missing', { revision: 0 })).body, { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' });

  const arrangementCase = await newSeededDraft();
  const arrangementResult = await patchDraft(arrangementCase.id, { revision: 0, arrangement: {
    assignments: [{ assignmentId: 'a-new', clipId: 'clip-1', beatIds: ['beat-1', 'beat-2'] }],
    gaps: [{ beatId: 'beat-3', reason: '  no suitable clip  ' }],
  } });
  const arrangementDraft = arrangementResult.body.draft as Record<string, unknown>;
  assert.deepEqual(arrangementDraft.arrangement, {
    assignments: [{ assignmentId: 'a-new', clipId: 'clip-1', beatIds: ['beat-1', 'beat-2'] }],
    gaps: [{ beatId: 'beat-3', reason: 'no suitable clip' }],
  });
  assert.deepEqual(arrangementDraft.narrationBeats, snapshots.narrationBeats);
  assert.deepEqual(arrangementDraft.clipPool, snapshots.clipPool);
  assert.deepEqual(arrangementDraft.issues, snapshots.issues);
  assert.equal(arrangementDraft.previewJobId, null);
  assert.equal(arrangementDraft.previewRevision, null);

  const invalidPlans = [
    { assignments: [{ assignmentId: 'a', clipId: 'clip-1', beatIds: [] }], gaps: snapshots.narrationBeats.map((beat) => ({ beatId: beat.beatId, reason: 'gap' })) },
    { assignments: [{ assignmentId: 'a', clipId: 'clip-1', beatIds: ['beat-1', 'beat-3'] }], gaps: [{ beatId: 'beat-2', reason: 'gap' }] },
    { assignments: [{ assignmentId: 'a', clipId: 'clip-1', beatIds: ['beat-2', 'beat-1'] }], gaps: [{ beatId: 'beat-3', reason: 'gap' }] },
    { assignments: [{ assignmentId: 'a', clipId: 'missing', beatIds: ['beat-1'] }], gaps: [{ beatId: 'beat-2', reason: 'gap' }, { beatId: 'beat-3', reason: 'gap' }] },
    { assignments: [{ assignmentId: 'a', clipId: 'clip-1', beatIds: ['missing'] }], gaps: snapshots.narrationBeats.map((beat) => ({ beatId: beat.beatId, reason: 'gap' })) },
    { assignments: [{ assignmentId: 'a', clipId: 'clip-1', beatIds: ['beat-1'] }, { assignmentId: 'b', clipId: 'clip-1', beatIds: ['beat-2'] }], gaps: [{ beatId: 'beat-3', reason: 'gap' }] },
    { assignments: [{ assignmentId: 'a', clipId: 'clip-1', beatIds: ['beat-1'] }], gaps: snapshots.narrationBeats.map((beat) => ({ beatId: beat.beatId, reason: 'gap' })) },
    { assignments: [], gaps: [{ beatId: 'beat-1', reason: 'gap' }, { beatId: 'beat-2', reason: 'gap' }] },
    { assignments: [], gaps: snapshots.narrationBeats.map((beat) => ({ beatId: beat.beatId, reason: '   ' })) },
    { assignments: [], gaps: snapshots.narrationBeats.map((beat) => ({ beatId: beat.beatId, reason: beat.beatId === 'beat-1' ? 'x'.repeat(201) : 'gap' })) },
  ];
  for (const plan of invalidPlans) {
    const testCase = await newSeededDraft();
    assert.equal((await patchDraft(testCase.id, { revision: 0, arrangement: plan })).status, 400);
  }

  const appearanceCase = await newSeededDraft();
  const appearance = structuredClone(appearanceCase.workflow);
  (appearance.packageConfig as Record<string, unknown>).width = 720;
  const appearanceDraft = (await patchDraft(appearanceCase.id, { revision: 0, workflowConfig: appearance })).body.draft as Record<string, unknown>;
  assert.deepEqual(appearanceDraft.narrationBeats, snapshots.narrationBeats);
  assert.deepEqual(appearanceDraft.clipPool, snapshots.clipPool);
  assert.deepEqual(appearanceDraft.arrangement, snapshots.arrangement);
  assert.deepEqual(appearanceDraft.issues, snapshots.issues);
  assert.equal(appearanceDraft.previewJobId, null);
  assert.equal(appearanceDraft.previewRevision, null);

  for (const [field, value] of [['fps', 24], ['durationTolerancePct', 0.1]] as const) {
    const solverCase = await newSeededDraft();
    const solverConfig = structuredClone(solverCase.workflow);
    (solverConfig.packageConfig as Record<string, unknown>)[field] = value;
    const solverDraft = (await patchDraft(solverCase.id, { revision: 0, workflowConfig: solverConfig })).body.draft as Record<string, unknown>;
    assert.deepEqual(solverDraft.narrationBeats, snapshots.narrationBeats);
    assert.deepEqual(solverDraft.clipPool, snapshots.clipPool);
    assert.deepEqual(solverDraft.arrangement, snapshots.arrangement);
    assert.deepEqual(solverDraft.issues, []);
    assert.equal(solverDraft.previewJobId, null);
    assert.equal(solverDraft.previewRevision, null);
  }

  const narrationCase = await newSeededDraft();
  const narrationChanged = structuredClone(narrationCase.workflow);
  (narrationChanged.packageConfig as Record<string, unknown>).targetDurationSec = 20;
  const narrationDraft = (await patchDraft(narrationCase.id, { revision: 0, workflowConfig: narrationChanged })).body.draft as Record<string, unknown>;
  assert.deepEqual(narrationDraft.narrationBeats, []);
  assert.deepEqual(narrationDraft.clipPool, snapshots.clipPool);
  assert.deepEqual(narrationDraft.arrangement, { assignments: [], gaps: [] });
  assert.deepEqual(narrationDraft.issues, []);

  const modeCreated = await create('project-1', { shotSetId: 'shot-set-1', scriptDraftId: 'script-1', workflowConfig: narrationWorkflow() });
  const modeId = (modeCreated.body.draft as Record<string, unknown>).id as string;
  seedSnapshots(modeId);
  const modeDraft = (await patchDraft(modeId, { revision: 0, workflowConfig: bgmWorkflow() })).body.draft as Record<string, unknown>;
  assert.equal(modeDraft.scriptDraftId, 'script-1');
  assert.deepEqual(modeDraft.narrationBeats, []);
  assert.deepEqual(modeDraft.arrangement, { assignments: [], gaps: [] });

  for (const [field, value] of [['selectedClipIds', ['clip-2']]] as const) {
    const testCase = await newSeededDraft();
    const changed = structuredClone(testCase.workflow);
    changed[field] = value;
    const draft = (await patchDraft(testCase.id, { revision: 0, workflowConfig: changed })).body.draft as Record<string, unknown>;
    assert.deepEqual(draft.narrationBeats, snapshots.narrationBeats);
    assert.deepEqual(draft.clipPool, snapshots.clipPool);
    assert.deepEqual(draft.arrangement, { assignments: [], gaps: [] });
    assert.deepEqual(draft.issues, []);
  }

  const equalCase = await newSeededDraft();
  const equalDraft = (await patchDraft(equalCase.id, { revision: 0, workflowConfig: structuredClone(equalCase.workflow) })).body.draft as Record<string, unknown>;
  assert.equal(equalDraft.revision, 1);
  assert.deepEqual(equalDraft.narrationBeats, snapshots.narrationBeats);
  assert.deepEqual(equalDraft.clipPool, snapshots.clipPool);
  assert.deepEqual(equalDraft.arrangement, snapshots.arrangement);
  assert.deepEqual(equalDraft.issues, snapshots.issues);

  const project2 = await create('project-2', { shotSetId: 'shot-set-2', workflowConfig: bgmWorkflow() });
  assert.equal(project2.status, 200);
  const all = await responseJson(await collection.GET(new Request('http://test/api'), collectionContext('project-1')));
  assert.ok((all.body.drafts as unknown[]).length > 0);
  assert.ok((all.body.drafts as Array<Record<string, unknown>>).every((draft) => draft.projectId === 'project-1'));
  const filtered = await responseJson(await collection.GET(new Request('http://test/api?shotSetId=shot-set-1'), collectionContext('project-1')));
  assert.ok((filtered.body.drafts as Array<Record<string, unknown>>).every((draft) => draft.shotSetId === 'shot-set-1'));
  assertParsedDraft((filtered.body.drafts as Array<Record<string, unknown>>)[0]);

  const detail = await responseJson(await item.GET(new Request('http://test/api'), itemContext(createdId)));
  assert.equal(detail.status, 200);
  assertParsedDraft(detail.body.draft as Record<string, unknown>);
  assert.equal((await responseJson(await item.GET(new Request('http://test/api'), itemContext('missing')))).status, 404);
  assert.deepEqual(await responseJson(await item.DELETE(new Request('http://test/api', { method: 'DELETE' }), itemContext(createdId))), { status: 200, body: { success: true } });
  assert.equal((await responseJson(await item.DELETE(new Request('http://test/api', { method: 'DELETE' }), itemContext(createdId)))).status, 404);

  console.log('final-video-draft-api tests passed');
} finally {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
