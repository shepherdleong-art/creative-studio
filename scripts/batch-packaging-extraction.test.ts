import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initialBatchPackagingConfig, batchPackagingDefaults } from '../lib/batch-production/packaging.ts';
import { buildPointCandidates, buildPointCues } from '../lib/media-core/packaging-cues.ts';

const db = new Database(':memory:');
try {
  db.exec(`CREATE TABLE projects (id TEXT, productName TEXT, sellingPointsJson TEXT);
    INSERT INTO projects VALUES ('p', '储物床', '[]');
    CREATE TABLE batch_output_plans (id TEXT, scriptSnapshotId TEXT, batchVersionId TEXT);
    INSERT INTO batch_output_plans VALUES ('plan', 'script', 'v');
    CREATE TABLE batch_script_snapshots (id TEXT, title TEXT, coverTitleJson TEXT);
    INSERT INTO batch_script_snapshots VALUES ('script', '收纳好帮手', '{}');
    CREATE TABLE batch_script_narrations (scriptSnapshotId TEXT, batchVersionId TEXT, narrationJson TEXT);`);
  const view = { planId: 'plan', coverTitle: null, coverTitleOverride: false, visualDurationUs: 12_000_000, narration: { durationUs: 12_000_000 },
    subtitleCues: [
      { text: '我妈真的从头夸到尾', startUs: 0, endUs: 2_000_000 },
      { text: '她说我挑的床', startUs: 2_000_000, endUs: 4_000_000 },
      { text: '像凭空多出一块收纳地', startUs: 4_000_000, endUs: 7_000_000 },
      { text: '胡桃木两色可选', startUs: 8_000_000, endUs: 11_000_000 },
    ] };
  const config = initialBatchPackagingConfig(db, 'p', view);
  assert.deepEqual(config.pointCues?.map(c => c.text), ['像凭空多出一块收纳地', '胡桃木两色可选']);
  assert.ok(config.pointCues![0].startSec >= 4 + 20 / 24 - 0.000001, '卖点跟随实际讲述出现，而非从片头均分');
  assert.equal(batchPackagingDefaults(db, 'p', view).point1, '像凭空多出一块收纳地', '封面也不取口播开头的寒暄');
  db.prepare('INSERT INTO batch_script_narrations VALUES (?, ?, ?)').run('script', 'v', JSON.stringify({
    packagingPoints: ['收纳地'], wordTimings: [{ text: '收纳地', startUs: 5_500_000, endUs: 6_800_000 }],
  }));
  const fromAI = initialBatchPackagingConfig(db, 'p', view);
  assert.deepEqual(fromAI.pointCues?.map(c => c.text), ['收纳地'], '新分配复用口播准备阶段提炼结果');
  assert.ok(Math.abs(fromAI.pointCues![0].startSec - (5.5 + 20 / 24)) < 0.000001, '批量和单条一样优先词级对时，封面偏移只加一次');
  assert.equal(batchPackagingDefaults(db, 'p', view).point1, '收纳地');
  const explicitlyEmpty = initialBatchPackagingConfig(db, 'p', view, { ...fromAI, pointCues: [], pointCuesEdited: true });
  assert.deepEqual(explicitlyEmpty.pointCues, [], '保留用户明确删除的卖点');
  let calls = 0;
  assert.deepEqual((await buildPointCandidates({ narrationText: '实木稳固', sellingPoints: ['实木稳固'], extractPoints: async () => { calls++; return ['不该调用']; } })).candidates, ['实木稳固']);
  assert.equal(calls, 0, '有项目卖点库时不请求 AI');
  const offline = await buildPointCues({ narrationText: view.subtitleCues.map(c => c.text).join('，'), sellingPoints: [], words: [], subtitleCues: view.subtitleCues, coverSec: 20 / 24, totalSec: 13, narrationPlaybackRate: 1, extractPoints: async () => { throw new Error('offline'); } });
  assert.deepEqual(offline.pointCues.map(c => c.text), config.pointCues?.map(c => c.text), 'AI 失败时按分句筛选具体卖点');
  console.log('batch packaging extraction: intro rejection, cached AI, word timing, cover text and offline fallback passed');
} finally { db.close(); }
