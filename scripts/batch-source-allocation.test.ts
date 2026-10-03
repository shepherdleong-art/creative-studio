import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { resolveModule4AssetGroupKeys } from '../lib/batch-production/media-catalog.ts';
import { allocateBatch } from '../lib/batch-production/allocator.ts';

// 同一原始分镜图生成两组新分镜，各组有独立 shotId 和生成图身份。
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE batch_asset_sources (id TEXT, assetId TEXT, sourceKind TEXT, locationJson TEXT, createdAt TEXT);
  CREATE TABLE video_jobs (id TEXT, projectId TEXT, shotSetId TEXT, shotId TEXT, sourceImageId TEXT);
  CREATE TABLE shots (id TEXT, shotSetId TEXT, sourceImageId TEXT);
  CREATE TABLE shot_sets (id TEXT, projectId TEXT);
  INSERT INTO shot_sets VALUES ('set-1', 'project'), ('set-2', 'project');
  INSERT INTO shots VALUES ('shot-a', 'set-1', 'original-a'), ('shot-a-copy', 'set-2', 'original-a'), ('shot-b', 'set-1', 'original-b');
  INSERT INTO video_jobs VALUES
    ('job-a', 'project', 'set-1', 'shot-a', 'generated-a'),
    ('job-a-copy', 'project', 'set-2', 'shot-a-copy', 'generated-a-copy'),
    ('job-b', 'project', 'set-1', 'shot-b', 'generated-b');
`);
for (const [assetId, videoJobId] of [['a', 'job-a'], ['a-copy', 'job-a-copy'], ['b', 'job-b']]) {
  db.prepare('INSERT INTO batch_asset_sources VALUES (?, ?, ?, ?, ?)')
    .run(assetId, assetId, 'module4', JSON.stringify({ videoJobId }), '2026-09-21');
}
try {
  const groups = resolveModule4AssetGroupKeys(db, ['a', 'a-copy', 'b']);
  assert.equal(groups.get('a'), groups.get('a-copy'), '不同生成图、不同分镜组应按原图归组');
  assert.notEqual(groups.get('a'), groups.get('b'), '不同原图不能因同处一个分镜组而合并');
  const result = allocateBatch({
    projectId: 'project', batchId: 'batch', batchVersionId: 'version', seed: 'cross-set',
    targetDurationUs: 4_000_000,
    assets: ['a', 'a-copy', 'b'].map((assetId) => ({
      assetId, contentFingerprint: assetId, sourceGroupKey: groups.get(assetId), durationUs: 2_000_000,
      analysisJson: { durationUs: 2_000_000, usableRanges: [{ startUs: 0, endUs: 2_000_000, qualityScore: 1 }] },
    })),
    plans: [{ planId: 'plan', segments: [
      { id: 's1', text: '开场', startUs: 0, endUs: 2_000_000, semanticScores: { a: 1, 'a-copy': 0.9, b: 0.6 } },
      { id: 's2', text: '细节', startUs: 2_000_000, endUs: 4_000_000, semanticScores: { a: 0.9, 'a-copy': 1, b: 0.6 } },
    ] }],
  });
  assert.deepEqual(result.outputs[0]!.arrangement.clips.map((clip) => clip.assetId), ['a', 'b'],
    '同一原始分镜图跨组生成的视频不得结伴进入同一条成片');
  db.prepare('DELETE FROM shots WHERE id = ?').run('shot-a');
  assert.equal(resolveModule4AssetGroupKeys(db, ['a']).get('a'), 'shot:shot-a', '缺失原始分镜时保留 shot 级避让');
  db.prepare('UPDATE video_jobs SET shotId = NULL WHERE id = ?').run('job-a');
  assert.equal(resolveModule4AssetGroupKeys(db, ['a', 'external']).size, 0, '无分镜的自由素材与外部素材不强行归组');
} finally {
  db.close();
}
console.log('batch source allocation tests passed');
