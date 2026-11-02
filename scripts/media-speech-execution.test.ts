import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import type { ResourceAccessContext } from '../lib/media-core/access-context.ts';

register('./typescript-extension-loader.mjs', import.meta.url);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-media-speech-execution-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;

const { getDb, closeDb } = await import('../lib/db.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { clearExecutionModuleRuntime, setExecutionModuleRuntime } = await import('../lib/media-core/execution/module-runtime.ts');
const { requestDoubaoAudio } = await import('../lib/media-core/adapters/doubao-tts.ts');
const { createOpenAiAlignmentAdapter } = await import('../lib/media-core/adapters/alignment.ts');

const db = getDb();
const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) });
assert.equal(readiness.available, true);
const identity = { instanceId: 'media-speech-test', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'media-speech-test' });
upsertExecutionPool(db, {
  poolKey: 'tts:remote', kind: 'remote', capacity: 1, enabled: true,
  mappingSnapshot: { providerId: 'doubao-seed-tts-2' }, expectedVersion: 0,
});
upsertExecutionPool(db, {
  poolKey: 'alignment:remote', kind: 'remote', capacity: 1, enabled: true,
  mappingSnapshot: { providerId: 'alignment' }, expectedVersion: 0,
});
for (const actorId of ['user-a', 'user-b']) {
  updateActorPolicy(db, { actorId, monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0 });
}
const execution = createExecutionFacade({
  db,
  deploymentId: 'media-speech-test',
  journal: createExecutionJournal({
    deploymentId: 'media-speech-test',
    directory: path.join(dataRoot, 'storage', 'execution-journal', 'media-speech-test'),
  }),
  actorAllowed: () => true,
  scopeAllowed: () => true,
  maintenance: () => false,
});
await execution.lifecycle.start({ ...identity, deploymentId: 'media-speech-test', signal: new AbortController().signal });
setExecutionModuleRuntime({ facade: execution.facade, ...identity });

function access(userId: string): ResourceAccessContext {
  return {
    kind: 'team', actor: { userId, role: 'admin' },
    assertAccess() {}, resolveOwner() { return userId; }, registerRootScope() {},
    registerInheritedScope() {}, registerTaskPrincipal() {},
  };
}

function pcmWav(durationMs = 400): Buffer {
  const sampleRate = 24_000;
  const dataSize = Math.round(sampleRate * durationMs / 1_000) * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

const provider = {
  providerId: 'doubao-seed-tts-2', providerName: '豆包', providerType: 'doubao-http-chunked',
  configuredModel: 'seed-tts-2.0', requestModel: 'seed-tts-2.0',
  baseUrl: 'https://openspeech.bytedance.com', apiKey: 'test-key', model: 'seed-tts-2.0',
};
const originalFetch = globalThis.fetch;
let posts = 0;
globalThis.fetch = async () => {
  posts += 1;
  return new Response([
    JSON.stringify({ code: 0, data: pcmWav().toString('base64'), sentence: { words: [{ word: '你', startTime: 0, endTime: 0.1 }, { word: '好', startTime: 0.1, endTime: 0.2 }] } }),
    JSON.stringify({ code: 20_000_000, message: 'done' }),
  ].join(''), { status: 200 });
};

function call(userId: string, taskId: string, step = 'segment:segment-1:chunk:0') {
  return runWithAccessContext(access(userId), () => requestDoubaoAudio(
    provider, 'zh_female_vv_uranus_bigtts', '你好', path.join(dataRoot, `${taskId}.mp3`), undefined,
    {
      taskId, step, inputRevision: `${taskId}:attempt:1`,
      businessAttempt: { id: `${taskId}:attempt:1`, number: 1 },
      scope: { resourceType: 'project', resourceId: `${userId}-project` },
    },
  ));
}

try {
  const first = await call('user-a', 'speech-complete');
  assert.equal(first.wordTimings.length, 2);
  assert.equal(posts, 1);
  await call('user-a', 'speech-complete');
  assert.equal(posts, 1, '已完成 chunk 恢复必须复用执行回执和音频，不得重复付费');
  assert.equal(db.prepare("SELECT status FROM execution_operations WHERE taskId = 'speech-complete'").pluck().get(), 'succeeded');
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM execution_reservations r JOIN execution_operations o ON o.id = r.operationId
    WHERE o.taskId = 'speech-complete' AND r.kind = 'concurrency' AND r.state = 'held'
  `).pluck().get(), 0, '同步 TTS 终态后必须释放远端生成名额');

  globalThis.fetch = async () => { posts += 1; throw new Error('socket reset'); };
  await assert.rejects(call('user-b', 'speech-unknown'), (error: unknown) => (error as { code?: string }).code === 'media_execution_unknown');
  const beforeUnknownReplay = posts;
  await assert.rejects(call('user-b', 'speech-unknown'), (error: unknown) => (error as { code?: string }).code === 'media_execution_unknown');
  assert.equal(posts, beforeUnknownReplay, '未知同步请求只能核查，不得自动重提');
  assert.equal(db.prepare("SELECT status FROM execution_operations WHERE taskId = 'speech-unknown'").pluck().get(), 'unknown');

  const audioPath = path.join(dataRoot, 'alignment.wav');
  fs.writeFileSync(audioPath, pcmWav());
  const alignment = createOpenAiAlignmentAdapter({}, {
    baseUrl: 'https://alignment.test/v1', apiKey: 'alignment-key', model: 'whisper-1',
    providerId: 'doubao-seed-tts-2', timeoutMs: 5_000,
  });
  let alignmentPosts = 0;
  globalThis.fetch = async () => {
    alignmentPosts += 1;
    if (alignmentPosts === 1) return new Response('temporary', { status: 500, headers: { 'retry-after': '0' } });
    return Response.json({ words: [{ word: '你', start: 0, end: 0.1 }, { word: '好', start: 0.1, end: 0.2 }] });
  };
  const align = () => runWithAccessContext(access('user-a'), () => alignment.align({
    audioPath, text: '你好',
    execution: {
      taskId: 'alignment-retry', step: 'segment:s1:alignment', inputRevision: 'alignment-attempt-1',
      businessAttempt: { id: 'alignment-attempt-1', number: 1 },
      scope: { resourceType: 'project', resourceId: 'user-a-project' },
      requiredPools: ['alignment:remote'],
    },
  }));
  assert.deepEqual(await align(), [
    { text: '你', startUs: 0, endUs: 100_000 },
    { text: '好', startUs: 100_000, endUs: 200_000 },
  ]);
  assert.equal(alignmentPosts, 2, '明确 5xx 的内部重试必须是第二次实际 POST');
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_operations WHERE taskId = 'alignment-retry'").pluck().get(), 2);
  await align();
  assert.equal(alignmentPosts, 2, '失败细节与后续成功回执都必须可重放，不得从第一次 HTTP 重新付费');

  console.log('media speech execution: stable chunk replay, permit release, unknown reconciliation and alignment retry recovery passed');
} finally {
  clearExecutionModuleRuntime();
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
