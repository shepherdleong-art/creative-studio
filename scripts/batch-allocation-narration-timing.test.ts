import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchProduction, createBatchProductionVersion, addAssetToPool } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot } from '../lib/batch-production/plans.ts';
import { allocateBatch, type FrozenBatchInput } from '../lib/batch-production/allocator.ts';
import { buildFrozenBatchInput, persistBatchAllocation } from '../lib/batch-production/allocation-store.ts';
import { buildBatchNarrationSegments, createLocalNarrationSnapshot } from '../lib/batch-production/narration.ts';

const G564_BODY = '周末午后，她窝在洒满阳光的客厅沙发里。坐着看书、贵妃位放腿，俩人并排躺也自在。软靠背和云座包稳稳托住身体，放松到不想起身。';
const ALIGNED = [
  { startUs: 0, endUs: 4_060_000 },
  { startUs: 4_060_000, endUs: 8_310_000 },
  { startUs: 8_310_000, endUs: 13_370_000 },
];
const WORD_TIMINGS = [
  { text: '周末午后', startUs: 0, endUs: 700_000 },
  { text: '她窝在洒满阳光的客厅沙发里', startUs: 700_000, endUs: 4_060_000 },
];

function makeAssets(): FrozenBatchInput['assets'] {
  return [
    { assetId: 'asset-1', contentFingerprint: 'sha256:' + 'a'.repeat(64), analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] }, analysisId: 'an-1' },
    { assetId: 'asset-2', contentFingerprint: 'sha256:' + 'b'.repeat(64), analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] }, analysisId: 'an-2' },
  ];
}

function makeInput(overrides: { narration?: unknown; targetDurationSec?: number } = {}): FrozenBatchInput {
  return {
    projectId: 'p',
    batchId: 'b',
    batchVersionId: 'v',
    fps: 24,
    preset: '3:4',
    targetDurationSec: overrides.targetDurationSec ?? 15,
    plans: [
      {
        planId: 'plan-1',
        scriptSnapshotId: 's1',
        title: 'G564',
        bodyText: G564_BODY,
        scriptSnapshot: { targetDurationSec: 15 },
        narration: overrides.narration as never,
      },
    ],
    assets: makeAssets(),
  };
}

const narrationA = {
  durationUs: 13_370_000,
  audioFingerprint: 'sha256:' + 'c'.repeat(64),
  segments: ALIGNED.map((timing, index) => ({ id: `nar-${index + 1}`, sourceSegmentId: `nar-${index + 1}`, text: `句${index + 1}`, ...timing })),
  wordTimings: WORD_TIMINGS,
};
const narrationB = {
  ...narrationA,
  audioFingerprint: 'sha256:' + 'd'.repeat(64),
};

try {
  // ---------- A. 纯分配器:有口播时句段时间等于真实对齐时间 ----------
  const withNarration = allocateBatch(makeInput({ narration: narrationA }));
  const arrangement = withNarration.outputs[0]!.arrangement;
  assert.equal(arrangement.targetDurationUs, 13_370_000, '有口播时目标时长必须取口播时长');
  assert.deepEqual(
    arrangement.clips.map((clip) => [clip.timelineStartUs, clip.timelineEndUs]),
    ALIGNED.map((timing) => [timing.startUs, timing.endUs]),
    '句段时间必须等于口播真实对齐时间(0/4.06/8.31/13.37s)',
  );
  assert.equal(arrangement.clips.length, 3);

  // 无口播:保留等分估算路径(3 句 15 秒 = 每句 5 秒)
  const withoutNarration = allocateBatch(makeInput({}));
  const estimatedArrangement = withoutNarration.outputs[0]!.arrangement;
  assert.equal(estimatedArrangement.targetDurationUs, 15_000_000, '无口播时目标时长仍用脚本设定值');
  assert.deepEqual(
    estimatedArrangement.clips.map((clip) => [clip.timelineStartUs, clip.timelineEndUs]),
    [[0, 5_000_000], [5_000_000, 10_000_000], [10_000_000, 15_000_000]],
    '无口播时仍按目标时长等分',
  );

  // 指纹:同音色重跑指纹一致,换音色(指纹不同)产生新输入身份
  const sameVoice = allocateBatch(makeInput({ narration: narrationA }));
  assert.equal(sameVoice.inputFingerprint, withNarration.inputFingerprint, '同音色同输入必须命中同一输入指纹');
  const otherVoice = allocateBatch(makeInput({ narration: narrationB }));
  assert.notEqual(otherVoice.inputFingerprint, withNarration.inputFingerprint, '换音色(新音频指纹)必须形成新的分配身份');
  assert.notEqual(withoutNarration.inputFingerprint, withNarration.inputFingerprint, '有/无口播是两种输入身份');

  // ---------- B. 冻结输入装配:buildFrozenInput 从权威表挂口播 ----------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-narration-timing-'));
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);
  await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  const batchId = createBatchProduction(db, 'project-1', '口播时间批次');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 1, defaultsJson: { outputPreset: '3:4', preset: '3:4', fps: 24, targetDurationSec: 15 } });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-g564',
    title: 'G564',
    bodyText: G564_BODY,
    sourceVersion: 'v1',
    metadata: { targetDurationSec: 15 },
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
  createOutputPlansForSnapshot(db, versionId, snapshotId);
  const asset1 = createAsset(db, { projectId: 'project-1', sourceKind: 'managed', locationJson: { key: 'a1' }, contentFingerprint: 'sha256:' + 'a'.repeat(64), mediaKind: 'video' });
  const analysis1 = createAnalysisVersion(db, { assetId: asset1, analyzerVersion: 't', providerId: 't', model: 't', analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] } });
  addAssetToPool(db, versionId, { assetId: asset1, analysisId: analysis1 });
  db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = '2026-08-03T00:00:00.000Z' WHERE id = ?`).run(versionId);
  db.prepare(`UPDATE batch_productions SET status = 'running', currentVersionId = ? WHERE id = ?`).run(versionId, batchId);

  function storeNarration(fingerprint: string, durationUs: number): void {
    const narrationSegments = buildBatchNarrationSegments(snapshotId, G564_BODY);
    const snapshot = createLocalNarrationSnapshot({
      scriptSnapshotId: snapshotId,
      bodyText: G564_BODY,
      artifact: {
        audioRelativePath: 'batch-narration/reuse/narration.wav',
        audioFingerprint: fingerprint,
        durationUs,
        segmentTimings: narrationSegments.map((segment, index) => ({
          sourceSegmentId: segment.segmentId,
          startUs: ALIGNED[index]!.startUs,
          endUs: ALIGNED[index]!.endUs,
        })),
        wordTimings: WORD_TIMINGS,
      },
    });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO batch_script_narrations
        (scriptSnapshotId, batchVersionId, narrationJson, audioRelativePath, audioFingerprint, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scriptSnapshotId) DO UPDATE SET
        narrationJson = excluded.narrationJson,
        audioRelativePath = excluded.audioRelativePath,
        audioFingerprint = excluded.audioFingerprint,
        updatedAt = excluded.updatedAt
    `).run(snapshotId, versionId, JSON.stringify(snapshot), snapshot.audioRelativePath, snapshot.audioFingerprint, now, now);
  }

  // 无口播时 buildFrozenInput 不挂 narration
  {
    const frozen = buildFrozenBatchInput(db, 'project-1', versionId);
    assert.equal(frozen.plans?.[0]?.narration, undefined, '权威表无记录时不得挂 narration');
  }

  // 有口播:plans[].narration 带真实时间与词级时间戳,分配吃真实时间
  let firstRunId = '';
  storeNarration('sha256:' + 'c'.repeat(64), 13_370_000);
  {
    const frozen = buildFrozenBatchInput(db, 'project-1', versionId);
    const narration = frozen.plans?.[0]?.narration;
    assert.ok(narration, '权威表有已核验口播时必须挂上');
    assert.equal(narration.durationUs, 13_370_000);
    assert.deepEqual(narration.segments.map((segment) => [segment.startUs, segment.endUs]), ALIGNED.map((timing) => [timing.startUs, timing.endUs]));
    assert.deepEqual(narration.wordTimings, WORD_TIMINGS);
    const first = persistBatchAllocation(db, 'project-1', versionId, { seed: 't7-seed' });
    assert.equal(first.created, true);
    const arrangement = JSON.parse((db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE allocationRunId = ?`).get(first.runId) as { arrangementJson: string }).arrangementJson);
    assert.equal(arrangement.targetDurationUs, 13_370_000, '落库的成片版本目标时长必须取口播时长');
    assert.deepEqual(
      arrangement.clips.map((clip: { timelineStartUs: number; timelineEndUs: number }) => [clip.timelineStartUs, clip.timelineEndUs]),
      ALIGNED.map((timing) => [timing.startUs, timing.endUs]),
    );
    const idempotent = persistBatchAllocation(db, 'project-1', versionId, { seed: 't7-seed' });
    assert.equal(idempotent.created, false, '同音色同输入重跑必须命中既有运行');
    assert.equal(idempotent.runId, first.runId);
    firstRunId = first.runId;
  }

  // 换音色 = 新音频指纹 → 新的分配运行
  storeNarration('sha256:' + 'd'.repeat(64), 13_370_000);
  {
    const switched = persistBatchAllocation(db, 'project-1', versionId, { seed: 't7-seed' });
    assert.equal(switched.created, true, '换音色必须形成新的分配身份');
    assert.notEqual(switched.runId, firstRunId, '换音色不得命中既有运行');
  }

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('batch allocation narration-timing tests passed');
} finally {
  // 无全局状态需要清理
}
