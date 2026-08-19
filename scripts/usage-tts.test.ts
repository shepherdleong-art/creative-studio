import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-usage-tts-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;

const [{ closeDb, getDb }, { requestDoubaoAudio }, { getFinalEditTtsAdapter }, { requestVapiAudio }] = await Promise.all([
  import('../lib/db.ts'),
  import('../lib/media-core/adapters/doubao-tts.ts'),
  import('../lib/media-core/adapters/tts-registry.ts'),
  import('../lib/media-core/adapters/vapi-qwen-tts.ts'),
]);

const db = getDb();
const originalFetch = globalThis.fetch;
const outputDir = path.join(dataRoot, 'outputs');
fs.mkdirSync(outputDir, { recursive: true });

type ProviderConfig = Parameters<typeof requestDoubaoAudio>[0];

function canonicalProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: 'https://openspeech.bytedance.com',
    apiKey: 'test-key',
    model: 'seed-tts-2.0',
    providerId: 'doubao-seed-tts-2',
    providerName: '豆包 Seed TTS 2.0',
    providerType: 'doubao-http-chunked',
    configuredModel: 'seed-tts-2.0',
    requestModel: 'seed-tts-2.0',
    ...overrides,
  };
}

function audioResponse(audio: Buffer | string = 'audio'): Response {
  const audioBuffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  return new Response([
    JSON.stringify({ code: 0, message: 'ok', data: audioBuffer.toString('base64') }),
    JSON.stringify({ code: 20_000_000, message: 'done' }),
  ].join(''), { status: 200 });
}

function validAudioResponse(durationMs = 300): Response {
  return audioResponse(pcmWav(durationMs));
}

function clearUsage(): void {
  db.exec('DELETE FROM usage_ledger; DELETE FROM usage_call_events;');
}

function pcmWav(durationMs: number): Buffer {
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

try {
  // Exact registry identity is billable, and Unicode characters use Array.from semantics.
  globalThis.fetch = async () => validAudioResponse();
  const exactPath = path.join(outputDir, 'exact.mp3');
  await requestDoubaoAudio(canonicalProvider(), 'zh_female_vv_uranus_bigtts', '你好🙂', exactPath);
  const exactRow = db.prepare(`SELECT eventKey, quantity, callCount, costMicros, detailJson FROM usage_ledger`).get() as {
    eventKey: string;
    quantity: number;
    callCount: number;
    costMicros: number;
    detailJson: string;
  };
  assert.match(exactRow.eventKey, /^tts-call:[0-9a-f-]{36}$/i);
  assert.equal(exactRow.quantity, 3);
  assert.equal(exactRow.callCount, 1);
  assert.equal(exactRow.costMicros, 840);
  assert.equal(JSON.parse(exactRow.detailJson).source, 'doubao-tts');
  clearUsage();

  // The registry must pass through the persisted provider type; a mismatched
  // DB type is not the canonical billable identity even when the adapter id is.
  globalThis.fetch = async () => validAudioResponse();
  const wrongTypePreviewPath = path.join(outputDir, 'wrong-type-preview.wav');
  try {
    await getFinalEditTtsAdapter('doubao-seed-tts-2').synthesizePreview({
      provider: canonicalProvider({ providerType: 'wrong-tts-type' }) as never,
      voice: 'zh_female_vv_uranus_bigtts',
      speed: 1,
      text: '类型不匹配',
      outputPath: wrongTypePreviewPath,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_call_events`).get(), { count: 0 });
  clearUsage();

  // Non-decodable upstream bytes must not be marked billable before FFmpeg
  // rejects the normalized audio.
  globalThis.fetch = async () => audioResponse('not-audio');
  const invalidAudioPath = path.join(outputDir, 'invalid-preview.wav');
  await assert.rejects(
    getFinalEditTtsAdapter('doubao-seed-tts-2').synthesizePreview({
      provider: canonicalProvider(),
      voice: 'zh_female_vv_uranus_bigtts',
      speed: 1,
      text: '无效音频',
      outputPath: invalidAudioPath,
    }),
  );
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 0 });
  clearUsage();

  // A non-canonical configured/request model succeeds upstream but creates no usage evidence.
  globalThis.fetch = async () => audioResponse('non-target');
  await requestDoubaoAudio(canonicalProvider({ configuredModel: 'seed-tts-2.1' }), 'zh_female_vv_uranus_bigtts', '你好', path.join(outputDir, 'non-target.mp3'));
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_call_events`).get(), { count: 0 });
  await requestDoubaoAudio(canonicalProvider({ model: 'seed-tts-2.1' }), 'zh_female_vv_uranus_bigtts', '你好', path.join(outputDir, 'non-target-request-model.mp3'));
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_call_events`).get(), { count: 0 });

  // Each real chunk gets a fresh random call id and its own character quantity.
  globalThis.fetch = async () => validAudioResponse();
  await requestDoubaoAudio(canonicalProvider({ usageContext: { refType: 'batch-narration', refId: 'chunk-1' } }), 'zh_female_vv_uranus_bigtts', '你', path.join(outputDir, 'chunk-1.mp3'));
  await requestDoubaoAudio(canonicalProvider({ usageContext: { refType: 'batch-narration', refId: 'chunk-2' } }), 'zh_female_vv_uranus_bigtts', '好🙂', path.join(outputDir, 'chunk-2.mp3'));
  const chunkRows = db.prepare(`SELECT eventKey, quantity FROM usage_ledger ORDER BY createdAt, id`).all() as Array<{ eventKey: string; quantity: number }>;
  assert.equal(chunkRows.length, 2);
  assert.notEqual(chunkRows[0]?.eventKey, chunkRows[1]?.eventKey);
  assert.deepEqual(chunkRows.map((row) => row.quantity), [1, 2]);
  clearUsage();

  // Supplier/HTTP/stream failures leave started evidence but never become billable.
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 123, message: 'failed' }), { status: 200 });
  await assert.rejects(() => requestDoubaoAudio(canonicalProvider(), 'zh_female_vv_uranus_bigtts', '失败', path.join(outputDir, 'failed.mp3')));
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT status FROM usage_call_events`).all(), [{ status: 'started' }]);
  clearUsage();

  // A ledger write failure is isolated from successful upstream audio generation.
  db.exec(`CREATE TRIGGER fail_usage_tts_start BEFORE INSERT ON usage_call_events BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  globalThis.fetch = async () => audioResponse('write-failure-audio');
  const writeFailurePath = path.join(outputDir, 'write-failure.mp3');
  await requestDoubaoAudio(canonicalProvider(), 'zh_female_vv_uranus_bigtts', '仍然成功', writeFailurePath);
  assert.deepEqual(fs.readFileSync(writeFailurePath), Buffer.from('write-failure-audio'));
  db.exec(`DROP TRIGGER fail_usage_tts_start`);
  clearUsage();

  // Existing normalized chunks are cache hits: no low-level request and no usage event.
  const adapter = getFinalEditTtsAdapter('doubao-seed-tts-2');
  const cacheDir = path.join(outputDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'segment-0-0.wav'), pcmWav(300));
  fs.writeFileSync(path.join(cacheDir, 'segment-0-0.wav.words.json'), JSON.stringify([{ text: '你', startUs: 0, endUs: 100_000 }]));
  let cacheFetches = 0;
  globalThis.fetch = async () => { cacheFetches += 1; return audioResponse('must-not-fetch'); };
  try {
    await adapter.synthesize({
      provider: { baseUrl: 'https://openspeech.bytedance.com', apiKey: 'test-key', model: 'seed-tts-2.0' },
      voice: adapter.defaultVoice,
      speed: 1,
      segments: [{ segmentId: 'segment-1', narration: '你' }],
      outputDir: cacheDir,
      relativeOutputPath: 'batch-narration/cache/narration.wav',
      alignment: { configured: false, align: async () => [] },
    });
    assert.equal(cacheFetches, 0);
    assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_call_events`).get(), { count: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    console.warn('usage-tts cache test skipped: ffmpeg spawn EPERM in sandbox');
  }
  clearUsage();

  // V-API has an independent adapter boundary and must not create Doubao events.
  globalThis.fetch = async () => new Response(JSON.stringify({ output: { audio: { data: Buffer.from('vapi-audio').toString('base64') } } }), { status: 200 });
  await requestVapiAudio({ baseUrl: 'https://api.v3.cm', apiKey: 'test-key', model: 'qwen3-tts-flash' }, 'Cherry', 'VAPI', path.join(outputDir, 'vapi.wav'));
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_call_events`).get(), { count: 0 });
} finally {
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log('usage-tts tests passed');
