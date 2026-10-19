import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot } from '../lib/batch-production/plans.ts';
import { createBatchNarrationExecutor, type BatchNarrationSynthesisResult } from '../lib/batch-production/narration-executor.ts';
import { buildBatchNarrationSegments } from '../lib/batch-production/narration.ts';
import { createLocalNarrationSnapshot, BATCH_NARRATION_SCHEMA_VERSION } from '../lib/batch-production/narration.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-narration-timings-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

/** 生成合法静音 PCM WAV(48kHz 16bit mono,指定秒数),供 ffprobe 探测时长。 */
function silentWavBytes(durationSec: number): Buffer {
  const sampleRate = 48_000;
  const sampleCount = sampleRate * durationSec;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const BODY_TEXT = '周末午后，她窝在洒满阳光的客厅沙发里。坐着看书、贵妃位放腿，俩人并排躺也自在。';
const WORD_TIMINGS = [
  { text: '周末午后', startUs: 0, endUs: 700_000 },
  { text: '她窝在洒满阳光的客厅沙发里', startUs: 700_000, endUs: 4_060_000 },
  { text: '坐着看书', startUs: 4_060_000, endUs: 5_900_000 },
  { text: '贵妃位放腿', startUs: 5_900_000, endUs: 7_600_000 },
  { text: '俩人并排躺也自在', startUs: 7_600_000, endUs: 8_310_000 },
];
const SEGMENT_TIMINGS = [
  { segmentId: 's1', startUs: 0, endUs: 4_060_000 },
  { segmentId: 's2', startUs: 4_060_000, endUs: 8_310_000 },
];

try {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT DEFAULT '');
    INSERT INTO projects (id, name, productCode) VALUES ('project-1', '测试项目', 'SKU');
  `);
  await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  db.exec(`
    CREATE TABLE IF NOT EXISTS final_edit_tts_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL DEFAULT '', keyEnv TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, isBuiltin INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO final_edit_tts_providers
      (id, name, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin, createdAt, updatedAt)
    VALUES ('vapi-qwen3-tts', 'V-API', 'vapi-qwen-json-url', 'https://api.v3.cm', 'test-key', '', 'qwen3-tts-flash', 1, 1, datetime('now'), datetime('now'))
  `).run();

  const batchId = createBatchProduction(db, 'project-1', '词级时间戳批次');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 1, defaultsJson: {} });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-source-timings',
    title: '时间戳脚本',
    bodyText: BODY_TEXT,
    sourceVersion: 'v1',
    metadata: {
      targetDurationSec: 15,
      narrationConfigJson: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 },
    },
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
  const planIds = createOutputPlansForSnapshot(db, versionId, snapshotId);
  for (const planId of planIds) {
    db.prepare(`
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES (?, ?, 1, '{}', ?)
    `).run(randomUUID(), planId, new Date().toISOString());
  }

  let synthesizeCount = 0;
  const executor = createBatchNarrationExecutor({
    storageRoot,
    synthesize: async (providerId, input) => {
      synthesizeCount += 1;
      fs.mkdirSync(path.dirname(path.join(input.outputDir, 'narration.wav')), { recursive: true });
      fs.writeFileSync(path.join(input.outputDir, 'narration.wav'), silentWavBytes(8.31));
      const result: BatchNarrationSynthesisResult = {
        relativePath: input.relativeOutputPath,
        absolutePath: path.join(input.outputDir, 'narration.wav'),
        durationUs: 8_310_000,
        segmentTimings: input.segments.map((segment, index) => ({
          segmentId: segment.segmentId,
          startUs: SEGMENT_TIMINGS[index]!.startUs,
          endUs: SEGMENT_TIMINGS[index]!.endUs,
        })),
        wordTimings: WORD_TIMINGS,
      };
      void providerId;
      return result;
    },
  });

  const claim = {
    task: { id: 'task-1', batchId, workType: 'narration' as const, targetKind: 'script_snapshot' as const, targetId: snapshotId },
    attempt: { id: 'attempt-1', attemptNumber: 1 },
  };
  const signal = new AbortController().signal;

  // 1. wordTimings 随快照往返落库,且 schemaVersion 升级到 v2
  const first = await executor.execute({ db, claim, signal, reportProgress: () => undefined });
  first.commit?.();
  assert.equal(synthesizeCount, 1);
  const stored = db.prepare(`SELECT narrationJson FROM batch_script_narrations WHERE scriptSnapshotId = ?`).get(snapshotId) as { narrationJson: string };
  const storedSnap = JSON.parse(stored.narrationJson) as { schemaVersion: string; wordTimings?: Array<{ text: string; startUs: number; endUs: number }>; segments: Array<{ startUs: number; endUs: number; timingSource: string }> };
  assert.equal(storedSnap.schemaVersion, BATCH_NARRATION_SCHEMA_VERSION);
  assert.deepEqual(storedSnap.wordTimings, WORD_TIMINGS, '词级时间戳必须随快照落库');
  assert.ok(storedSnap.segments.every((segment) => segment.timingSource === 'aligned'));

  // 2. 缓存复用:第二次执行不再调用 TTS,且复用真实对齐而非平均切回去
  const second = await executor.execute({ db, claim, signal, reportProgress: () => undefined });
  second.commit?.();
  assert.equal(synthesizeCount, 1, '命中音频缓存时不得重复调用 TTS');
  const storedAfterReuse = db.prepare(`SELECT narrationJson FROM batch_script_narrations WHERE scriptSnapshotId = ?`).get(snapshotId) as { narrationJson: string };
  const reusedSnap = JSON.parse(storedAfterReuse.narrationJson) as {
    wordTimings?: Array<{ text: string; startUs: number; endUs: number }>;
    segments: Array<{ startUs: number; endUs: number; timingSource: string }>;
  };
  assert.deepEqual(reusedSnap.segments.map((segment) => [segment.startUs, segment.endUs]), [
    [0, 4_060_000],
    [4_060_000, 8_310_000],
  ], '缓存复用必须保留真实对齐时间,不能退化成等分(4.155s)');
  assert.deepEqual(reusedSnap.wordTimings, WORD_TIMINGS, '缓存复用必须连带词级时间戳');
  assert.ok(reusedSnap.segments.every((segment) => segment.timingSource === 'aligned'));

  // 3. 老快照(无 wordTimings 字段)能正常读,不抛错
  {
    const legacySegments = buildBatchNarrationSegments('legacy-snapshot', BODY_TEXT);
    const legacyTimings = legacySegments.map((segment, index) => ({
      sourceSegmentId: segment.segmentId,
      startUs: SEGMENT_TIMINGS[index]!.startUs,
      endUs: SEGMENT_TIMINGS[index]!.endUs,
    }));
    const legacySnapshot = createLocalNarrationSnapshot({
      scriptSnapshotId: 'legacy-snapshot',
      bodyText: BODY_TEXT,
      artifact: {
        audioRelativePath: 'batch-narration/legacy/narration.wav',
        audioFingerprint: 'sha256:' + 'b'.repeat(64),
        durationUs: 8_310_000,
        segmentTimings: legacyTimings,
      },
    });
    assert.equal('wordTimings' in legacySnapshot, false, '老快照没有词级时间戳时不得凭空生成该字段');
    assert.equal(legacySnapshot.segments.length, 2);
    assert.equal(legacySnapshot.productionReady, true);
  }

  // 4. 权威表拿不到对齐(跨批次复用同一音频文件)时回落等分并标 estimated
  db.prepare(`DELETE FROM batch_script_narrations WHERE scriptSnapshotId = ?`).run(snapshotId);
  const third = await executor.execute({ db, claim, signal, reportProgress: () => undefined });
  third.commit?.();
  assert.equal(synthesizeCount, 1, '音频仍在,回落对齐不得重新调用 TTS');
  const estimatedSnap = JSON.parse((db.prepare(`SELECT narrationJson FROM batch_script_narrations WHERE scriptSnapshotId = ?`).get(snapshotId) as { narrationJson: string }).narrationJson) as {
    segments: Array<{ startUs: number; endUs: number; timingSource: string }>;
    wordTimings?: unknown;
  };
  assert.deepEqual(estimatedSnap.segments.map((segment) => [segment.startUs, segment.endUs]), [
    [0, 4_155_000],
    [4_155_000, 8_310_000],
  ], '拿不到真实对齐时必须回落到等分');
  assert.ok(estimatedSnap.segments.every((segment) => segment.timingSource === 'estimated'), '回落对齐必须标注 timingSource=estimated');
  assert.equal('wordTimings' in estimatedSnap, false, '回落路径没有词级时间戳可复用');

  db.close();
  console.log('batch narration word-timings tests passed');
} finally {
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
