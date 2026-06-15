import assert from 'node:assert/strict';

const {
  IMAGE_REFERENCE_COUNTS_SQL,
  getImageDeleteBlockers,
  getImageDeleteBlockMessage,
} = await import('../lib/image-delete-policy' + '.ts');

assert.deepEqual(
  getImageDeleteBlockers({ jobRefs: 0, sceneRefs: 0, shotRefs: 0, videoRefs: 0 }),
  []
);

assert.equal(
  getImageDeleteBlockMessage({ jobRefs: 0, sceneRefs: 0, shotRefs: 0, videoRefs: 0 }),
  null
);

assert.deepEqual(
  getImageDeleteBlockers({ jobRefs: 2, sceneRefs: 0, shotRefs: 9, videoRefs: 1 }),
  ['2 个生成任务', '9 个分镜', '1 个视频任务']
);

assert.equal(
  getImageDeleteBlockMessage({ jobRefs: 2, sceneRefs: 0, shotRefs: 9, videoRefs: 1 }),
  '该素材已被 2 个生成任务、9 个分镜、1 个视频任务引用，不能直接删除。请先删除关联的分镜组、任务或视频任务。'
);

const { default: Database } = await import('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE jobs (inputImageId TEXT, outputImageId TEXT, referenceImageIds TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE scene_references (imageAssetId TEXT);
  CREATE TABLE shots (sourceImageId TEXT, latestGeneratedImageId TEXT);
  CREATE TABLE video_jobs (sourceImageId TEXT);
  INSERT INTO jobs VALUES ('asset-1', NULL, '[]');
  INSERT INTO jobs VALUES ('other', NULL, '["asset-1"]');
  INSERT INTO shots VALUES ('asset-1', NULL);
  INSERT INTO video_jobs VALUES ('asset-1');
`);

assert.deepEqual(
  db.prepare(IMAGE_REFERENCE_COUNTS_SQL).get({ id: 'asset-1' }),
  { jobRefs: 2, sceneRefs: 0, shotRefs: 1, videoRefs: 1 }
);
