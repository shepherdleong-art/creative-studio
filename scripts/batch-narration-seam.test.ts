import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createBatchNarrationExecutor } from '../lib/batch-production/narration-executor.ts';
import {
  assertNarrationPublishable,
  createLocalNarrationSnapshot,
  createSilentNarrationPlaceholder,
} from '../lib/batch-production/narration.ts';

const placeholder = createSilentNarrationPlaceholder({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  targetDurationUs: 9_000_000,
});
const repeated = createSilentNarrationPlaceholder({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  targetDurationUs: 9_000_000,
});
assert.deepEqual(repeated, placeholder, '预计 timing 必须确定性复现');
assert.equal(placeholder.mode, 'silent_placeholder');
assert.equal(placeholder.productionReady, false, '静音视觉候选不得伪装成正式口播');
assert.equal(placeholder.segments[0]?.startUs, 0);
assert.equal(placeholder.segments.at(-1)?.endUs, 9_000_000);
assert.ok(placeholder.segments.every((segment, index) => (
  segment.endUs > segment.startUs
  && (index === 0 || segment.startUs === placeholder.segments[index - 1]?.endUs)
)));
assert.throws(() => assertNarrationPublishable(placeholder), /尚未准备/);

const localFingerprint = `sha256:${createHash('sha256').update('local narration').digest('hex')}`;
const local = createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: 'storage/batch-narration/snapshot-a.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: placeholder.segments.map(({ sourceSegmentId, startUs, endUs }) => ({
      sourceSegmentId,
      startUs,
      endUs,
    })),
  },
});
assert.equal(local.productionReady, true);
assert.equal(local.mode, 'local_ready');
assert.doesNotThrow(() => assertNarrationPublishable(local));
assert.ok(local.segments.every((segment) => segment.timingSource === 'aligned'));

assert.throws(() => createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: '/tmp/escape.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: placeholder.segments,
  },
}), /storage 相对路径/);

assert.throws(() => createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: '../escape.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: placeholder.segments,
  },
}), /storage 相对路径/);

const invalidTimings = placeholder.segments.map(({ sourceSegmentId, startUs, endUs }) => ({
  sourceSegmentId,
  startUs,
  endUs,
}));
invalidTimings[1] = { ...invalidTimings[1]!, startUs: 0 };
assert.throws(() => createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: 'storage/batch-narration/snapshot-a.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: invalidTimings,
  },
}), /时间非法|重叠/);

// 受管快照未显式指定 provider 时，执行器必须固定选择官方豆包；
// 历史库中其他 enabled TTS 的排序不能影响这一选择。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-managed-narration-'));
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE batch_production_versions (id TEXT PRIMARY KEY, batchId TEXT NOT NULL);
      CREATE TABLE batch_script_snapshots (
        id TEXT PRIMARY KEY, batchVersionId TEXT NOT NULL, bodyText TEXT NOT NULL,
        narrationConfigJson TEXT NOT NULL
      );
      CREATE TABLE final_edit_tts_providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, baseUrl TEXT NOT NULL,
        apiKey TEXT NOT NULL, keyEnv TEXT NOT NULL, model TEXT NOT NULL,
        enabled INTEGER NOT NULL, isBuiltin INTEGER NOT NULL
      );
      INSERT INTO batch_production_versions (id, batchId) VALUES ('version-managed', 'batch-managed');
      INSERT INTO batch_script_snapshots (id, batchVersionId, bodyText, narrationConfigJson)
        VALUES ('snapshot-managed', 'version-managed', '固定豆包口播。', '{}');
      INSERT INTO final_edit_tts_providers
        (id, name, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin)
        VALUES
        ('legacy-enabled', '历史 TTS', 'vapi-qwen-json-url', 'https://api.v3.cm', 'legacy-key', 'VAPI_TTS_API_KEY', 'legacy-model', 1, 1),
        ('doubao-seed-tts-2', '豆包 Seed TTS 2.0', 'doubao-http-chunked', 'https://openspeech.bytedance.com', 'doubao-key', 'DOUBAO_TTS_API_KEY', 'seed-tts-2.0', 1, 0);
    `);
    const stateDir = path.join(root, 'data', 'provisioning');
    fs.mkdirSync(stateDir, { recursive: true });
    const configText = 'model_list: []\n';
    fs.writeFileSync(path.join(root, 'config.yaml'), configText, 'utf8');
    fs.writeFileSync(path.join(stateDir, 'runtime.env'), [
      'CREATIVE_STUDIO_GATEWAY_API_KEY=fixture',
      'COMPANY_GATEWAY_API_KEY=fixture',
      'GATEWAY_API_KEY=fixture',
      'CREATIVE_STUDIO_COS_SECRET_ID=fixture',
      'CREATIVE_STUDIO_COS_SECRET_KEY=fixture',
      'CREATIVE_STUDIO_COS_DOMAIN=fixture.example.com',
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
      schemaVersion: 2,
      profileName: 'Managed Narration Fixture',
      importedAt: '2026-08-06T00:00:00.000Z',
      configHash: createHash('sha256').update(configText).digest('hex'),
      managedProviders: {
        image: ['fixture-image'],
        script: ['fixture-script'],
        video: ['fixture-video'],
        tts: ['doubao-seed-tts-2'],
      },
    }), 'utf8');

    let adapterCalls = 0;
    let selectedProviderId = '';
    let selectedBaseUrl = '';
    const executor = createBatchNarrationExecutor({
      storageRoot: path.join(root, 'storage'),
      executionGate: {
        root,
        env: { ...process.env, CREATIVE_STUDIO_MANAGED_DEPLOYMENT: '1' },
        allowlist: {
          image: ['fixture-image'],
          script: ['fixture-script'],
          video: ['fixture-video'],
          tts: ['doubao-seed-tts-2'],
        },
        companyRuntime: {
          status: 'ready',
          reason: 'ready',
          proxyAvailable: true,
          cosConfigured: false,
          startedAt: null,
        },
      },
      synthesize: async (providerId, input) => {
        adapterCalls += 1;
        selectedProviderId = providerId;
        selectedBaseUrl = input.provider.baseUrl;
        throw new Error('stop_after_managed_provider_capture');
      },
    });
    await assert.rejects(
      executor.execute({
        db,
        claim: {
          task: {
            id: 'narration-task-managed',
            batchId: 'batch-managed',
            workType: 'narration',
            targetKind: 'script_snapshot',
            targetId: 'snapshot-managed',
          },
          attempt: { id: 'attempt-managed', attemptNumber: 1 },
        },
        signal: new AbortController().signal,
        reportProgress: () => undefined,
      }),
      /stop_after_managed_provider_capture/,
    );
    assert.equal(adapterCalls, 1);
    assert.equal(selectedProviderId, 'doubao-seed-tts-2');
    assert.equal(selectedBaseUrl, 'https://openspeech.bytedance.com');
    assert.doesNotMatch(selectedBaseUrl, /127\.0\.0\.1|localhost|:4000/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('batch narration seam tests passed');
