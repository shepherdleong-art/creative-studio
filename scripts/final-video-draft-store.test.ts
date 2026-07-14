import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as {
  registerHooks(hooks: {
    resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
  }): void;
}).registerHooks;
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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-draft-store-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const {
  createFinalVideoDraft,
  deleteFinalVideoDraft,
  getFinalVideoDraft,
  listFinalVideoDrafts,
  snapshotDraftForJob,
  updateFinalVideoDraft,
} = await import('../lib/final-video/draft-store.ts');
const { getDb } = await import('../lib/db.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');

const db = getDb();
db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, model) VALUES (?, ?, ?, ?)`).run(
  'test-provider', 'Test', 'https://example.invalid', 'test-model',
);
db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES (?, ?, ?, ?, ?)`).run(
  'project-1', 'Project 1', 'test-provider', 'test-model', 'test prompt',
);
for (const [id, name] of [['shot-set-1', 'Shot Set 1'], ['shot-set-2', 'Shot Set 2']]) {
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES (?, ?, ?)`).run(id, 'project-1', name);
}

const packageConfig = { ...defaultPackageConfig(), outputName: 'draft-test' };
const workflowConfig = {
  packageConfig,
  selectedClipIds: ['clip-1'],
};

try {
  const first = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig,
  });
  assert.equal(first.stage, 'draft');
  assert.equal(first.revision, 0);
  assert.deepEqual(JSON.parse(first.workflowConfigJson), workflowConfig);
  assert.deepEqual(JSON.parse(first.narrationBeatsJson), []);
  assert.deepEqual(JSON.parse(first.clipPoolJson), []);
  assert.deepEqual(JSON.parse(first.arrangementJson), { assignments: [], gaps: [] });
  assert.deepEqual(JSON.parse(first.issuesJson), []);
  assert.deepEqual(getFinalVideoDraft(first.id), first);
  assert.equal(getFinalVideoDraft('missing-draft'), null);

  const second = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-2', scriptDraftId: null, workflowConfig,
  });
  db.prepare(`UPDATE final_video_drafts SET createdAt = ? WHERE id = ?`).run('2026-01-01 00:00:00', first.id);
  db.prepare(`UPDATE final_video_drafts SET createdAt = ? WHERE id = ?`).run('2026-01-02 00:00:00', second.id);
  assert.deepEqual(listFinalVideoDrafts('project-1').map((row) => row.id), [second.id, first.id]);
  assert.deepEqual(listFinalVideoDrafts('project-1', 'shot-set-1').map((row) => row.id), [first.id]);

  const updated = updateFinalVideoDraft(first.id, 0, { stage: 'preparing', errorMessage: 'working' });
  assert.equal(updated.revision, 1);
  assert.equal(updated.stage, 'preparing');
  assert.equal(updated.errorMessage, 'working');
  assert.throws(
    () => updateFinalVideoDraft(first.id, 0, { stage: 'failed' }),
    (error: unknown) => error instanceof Error && error.message.includes('stale_revision'),
  );
  assert.deepEqual(getFinalVideoDraft(first.id), updated);
  assert.throws(
    () => updateFinalVideoDraft('missing-draft', 0, { stage: 'failed' }),
    (error: unknown) => error instanceof Error && error.message.includes('stale_revision'),
  );

  assert.throws(() => updateFinalVideoDraft(first.id, 1, { clipPoolJson: '{broken' }), /clipPoolJson/i);
  assert.deepEqual(getFinalVideoDraft(first.id), updated);

  const narrationBeatsJson = JSON.stringify([{
    beatId: 'beat-1', index: 0, text: 'Hello', subtitleText: 'Hello', shotId: 'shot-1', imageAssetId: 'image-1', audioPath: '/tmp/hello.wav',
    durationSec: 1.5, startSec: 0,
  }]);
  const clipPoolJson = JSON.stringify([{
    clipId: 'clip-1', shotId: 'shot-1', shotIndex: 0, videoPath: '/tmp/clip.mp4', clipDurationSec: 2,
    sourceImageId: 'image-1', sourceImagePath: '/tmp/image.png',
  }]);
  const arrangementJson = JSON.stringify({
    assignments: [{ assignmentId: 'assignment-1', clipId: 'clip-1', beatIds: ['beat-1'] }], gaps: [],
  });
  const issuesJson = JSON.stringify([{
    code: 'visual_gap', severity: 'warning', message: 'Gap', beatIds: ['beat-1'], clipId: null,
  }]);
  const ready = updateFinalVideoDraft(first.id, 1, {
    stage: 'review', narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson,
  });
  const snapshot = snapshotDraftForJob(first.id, ready.revision, 'preview');
  assert.deepEqual(snapshot, {
    kind: 'preview', draftId: first.id, draftRevision: 2, packageConfig,
    narrationBeats: JSON.parse(narrationBeatsJson), clipPool: JSON.parse(clipPoolJson),
    arrangement: JSON.parse(arrangementJson), issues: JSON.parse(issuesJson), selectedClipIds: ['clip-1'], solverVersion: 3,
  });
  snapshot.packageConfig.outputName = 'mutated';
  snapshot.narrationBeats[0].text = 'mutated';
  snapshot.arrangement.assignments[0].beatIds.push('mutated');
  const laterSnapshot = snapshotDraftForJob(first.id, ready.revision, 'preview');
  assert.equal(laterSnapshot.packageConfig.outputName, 'draft-test');
  assert.equal(laterSnapshot.narrationBeats[0].text, 'Hello');
  assert.deepEqual(laterSnapshot.arrangement.assignments[0].beatIds, ['beat-1']);
  assert.equal(getFinalVideoDraft(first.id)?.narrationBeatsJson, narrationBeatsJson);
  assert.throws(
    () => snapshotDraftForJob(first.id, ready.revision - 1, 'final'),
    (error: unknown) => error instanceof Error && error.message.includes('stale_revision'),
  );

  deleteFinalVideoDraft(second.id);
  assert.equal(getFinalVideoDraft(second.id), null);

  console.log('final-video-draft-store tests passed');
} finally {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
