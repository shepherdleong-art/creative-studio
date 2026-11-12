import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';

import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
} from '../lib/media-core/unified-media/catalog.ts';
import {
  buildUnifiedImageJobContract,
  isUnifiedImageJobProvider,
} from '../lib/media-core/unified-media/project-jobs.ts';
import { UnifiedImageRequestError } from '../lib/media-core/unified-media/requests.ts';
import {
  UnifiedJobRequestConflictError,
  findUnifiedJobRequestReplay,
  normalizeUnifiedJobRequestKey,
  unifiedJobRequestHash,
} from '../lib/media-core/unified-media/job-idempotency.ts';

const frozen = buildUnifiedImageJobContract({
  projectSize: '1728x2304',
  prompt: '保持产品主体不变，参考图2调整场景',
  inputImageId: 'image-base',
  referenceImageIds: ['scene-reference', 'style-reference'],
  referenceGuidanceMode: 'preserve_subject',
});
assert.deepEqual(frozen.frozen, {
  unifiedModel: 'image2',
  ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
  inputImageId: 'image-base',
  referenceImageIds: ['scene-reference', 'style-reference'],
  prompt: '保持产品主体不变，参考图2调整场景',
  tier: '2k',
  ratio: '3:4',
  size: '1728x2304',
  quality: 'auto',
  referenceGuidanceMode: 'preserve_subject',
});
assert.equal(frozen.providerId, UNIFIED_IMAGE_ANCHOR_ID);
assert.equal(frozen.model, UNIFIED_IMAGE_MODEL_KEY);
assert.equal(frozen.maxAttempts, 1, 'channel attempts must be parent-controlled, not legacy retries');
assert.equal(frozen.quality, 'auto');
assert.equal(JSON.parse(frozen.unifiedRequestJson).inputImageId, 'image-base');
assert.deepEqual(JSON.parse(frozen.unifiedRequestJson).referenceImageIds, ['scene-reference', 'style-reference']);

assert.throws(
  () => buildUnifiedImageJobContract({
    projectSize: '3840x1920',
    prompt: 'invalid',
    inputImageId: 'image-base',
    referenceImageIds: [],
  }),
  (error: unknown) => error instanceof UnifiedImageRequestError
    && error.code === 'unsupported_image_combination',
  '4K 2:1 must not silently fall back to 2K',
);
assert.equal(buildUnifiedImageJobContract({
  projectSize: '720x1280', prompt: 'portrait', inputImageId: 'image-base', referenceImageIds: [],
}).frozen.ratio, '9:16');
assert.equal(buildUnifiedImageJobContract({
  projectSize: '3200x2560', prompt: 'landscape', inputImageId: 'image-base', referenceImageIds: [],
}).frozen.ratio, '5:4');
assert.throws(
  () => buildUnifiedImageJobContract({
    projectSize: 'not-a-size',
    prompt: 'invalid',
    inputImageId: 'image-base',
    referenceImageIds: [],
  }),
  (error: unknown) => error instanceof UnifiedImageRequestError,
);

assert.equal(isUnifiedImageJobProvider({
  id: UNIFIED_IMAGE_ANCHOR_ID,
  type: 'unified-image',
  model: UNIFIED_IMAGE_MODEL_KEY,
}), true);
assert.equal(isUnifiedImageJobProvider({
  id: 'company-gateway-image2-medium',
  type: 'gateway-task-image',
  model: 'image2-medium',
}), false, 'real channels are not the employee-facing model identity');

assert.equal(normalizeUnifiedJobRequestKey(' request-1 '), 'request-1');
assert.equal(normalizeUnifiedJobRequestKey(''), null);
assert.throws(() => normalizeUnifiedJobRequestKey('x'.repeat(201)), UnifiedJobRequestConflictError);

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    creationIndex INTEGER NOT NULL,
    creationSource TEXT,
    creationRequestKey TEXT,
    creationRequestHash TEXT,
    revision INTEGER
  );
`);
const hash = unifiedJobRequestHash({ prompt: 'same', count: 2 });
db.prepare(`INSERT INTO jobs (id, projectId, creationIndex, creationSource, creationRequestKey, creationRequestHash, revision)
  VALUES ('job-1', 'project-a', 0, 'project_scene', 'request-a', ?, 1)`).run(hash);
db.prepare(`INSERT INTO jobs (id, projectId, creationIndex, creationSource, creationRequestKey, creationRequestHash, revision)
  VALUES ('job-2', 'project-a', 1, 'project_scene', 'request-a', ?, 1)`).run(hash);
assert.deepEqual(findUnifiedJobRequestReplay(db, {
  projectId: 'project-a',
  requestKey: 'request-a',
  requestHash: hash,
  expectedCount: 2,
  creationSource: 'project_scene',
}), ['job-1', 'job-2']);
assert.throws(() => findUnifiedJobRequestReplay(db, {
  projectId: 'project-a',
  requestKey: 'request-a',
  requestHash: unifiedJobRequestHash({ prompt: 'different', count: 2 }),
  expectedCount: 2,
  creationSource: 'project_scene',
}), UnifiedJobRequestConflictError);
assert.equal(findUnifiedJobRequestReplay(db, {
  projectId: 'project-b',
  requestKey: 'request-a',
  requestHash: hash,
  expectedCount: 2,
  creationSource: 'project_scene',
}), null, 'same request key on another project is independent');
db.close();

const applySceneSource = fs.readFileSync(
  new URL('../app/api/shot-sets/[id]/apply-scene/route.ts', import.meta.url),
  'utf8',
);
assert.match(applySceneSource, /buildUnifiedImageJobContract/);
assert.match(applySceneSource, /isUnifiedImageJobProvider/);
assert.match(applySceneSource, /unifiedModel, unifiedRuleVersion, unifiedRequestJson, creationSource/);
assert.match(applySceneSource, /shot\.sourceImageId/);
assert.match(applySceneSource, /\[sceneRef\.imageAssetId\]/);

const regenerateSource = fs.readFileSync(
  new URL('../app/api/jobs/[id]/regenerate/route.ts', import.meta.url),
  'utf8',
);
assert.match(regenerateSource, /buildUnifiedImageJobContract/);
assert.match(regenerateSource, /findUnifiedJobRequestReplay/);
assert.match(regenerateSource, /creationSource = 'project_regenerate'/);
assert.match(regenerateSource, /parentJobId/);

const sceneStepSource = fs.readFileSync(
  new URL('../components/workbench/SceneStep.tsx', import.meta.url),
  'utf8',
);
assert.doesNotMatch(sceneStepSource, /统一 Image 2 的手动重试入口留待后续任务接入/);
assert.match(sceneStepSource, /selectedJobUnified \|\| providerSelectionChanged/);
assert.match(sceneStepSource, /requestKey: crypto\.randomUUID\(\)/);

const shotStepSource = fs.readFileSync(
  new URL('../components/workbench/ShotSetStep.tsx', import.meta.url),
  'utf8',
);
assert.match(shotStepSource, /currentJobUnified \|\| providerSelectionChanged/);
assert.match(shotStepSource, /requestKey: crypto\.randomUUID\(\)/);
assert.match(shotStepSource, /provider\.type === 'unified-image'/);

console.log('unified image project entrypoint tests passed');
