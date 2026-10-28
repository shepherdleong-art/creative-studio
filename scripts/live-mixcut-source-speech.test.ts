import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-source-speech-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const originalFetch = globalThis.fetch;
const db = new Database(path.join(root, 'test.db'));
try {
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { registerManagedCopy, listAssetSources, resolveSourceFilePath } = await import('../lib/live-mixcut/media-catalog.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { createOpenAiTranscriptionAdapter } = await import('../lib/media-core/adapters/alignment.ts');
  const { analyzeFormulaSourceSpeech, withCleanedSourceSpeech } = await import('../lib/live-mixcut/formula/source-speech.ts');
  type FormulaSourceSpeech = Awaited<ReturnType<typeof analyzeFormulaSourceSpeech>>;
  type SchedulingWord = { text: string; startUs: number; endUs: number };
  /** 按字给逐字时间，保证和识别文字去掉标点后一致。 */
  const charWords = (text: string): SchedulingWord[] => [...text].filter(char => /[\p{L}\p{N}]/u.test(char))
    .map((text, index) => ({ text, startUs: index * 300_000, endUs: (index + 1) * 300_000 }));
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','原声核验');");
  assert.equal((await checkBatchProductionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
  seedLiveMixcutProjects({ db }, ['p']);
  const file = path.join(root, 'source.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file]);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
  const asset = db.prepare('SELECT contentFingerprint FROM live_mixcut_assets WHERE id=?').get(assetId) as { contentFingerprint: string };
  const input = { assetId, contentFingerprint: asset.contentFingerprint,
    sources: listAssetSources(db, assetId).map(source => ({ id: source.id, location: source.locationJson })) };
  let uploads = 0;
  globalThis.fetch = async (_url, init) => {
    uploads += 1;
    const form = init!.body as FormData;
    assert.equal(form.has('prompt'), false);
    const audio = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF', '上传由真实原片提取的 WAV，不提交视频或假音频');
    assert(audio.length > 60_000);
    return Response.json({ text: '声音测试。', words: [{ word: '声音', start: 0.25, end: 0.7 }, { word: '测试', start: 0.8, end: 1.5 }] });
  };
  const adapter = createOpenAiTranscriptionAdapter({}, { baseUrl: 'https://speech.example.test', apiKey: 'test-secret' });
  const result = await analyzeFormulaSourceSpeech(db, 'p', input, adapter, new AbortController().signal);
  assert.equal(result.status, 'transcribed');
  if (result.status !== 'transcribed') throw new Error('expected transcribed');
  assert.equal(result.assetId, assetId);
  assert.equal(result.contentFingerprint, input.contentFingerprint);
  assert.equal(result.mediaDurationUs, 2_000_000);
  assert.equal(result.text, '声音测试。');
  assert.deepEqual(result.words, [{ text: '声音', startUs: 250_000, endUs: 700_000 }, { text: '测试', startUs: 800_000, endUs: 1_500_000 }]);
  assert.equal(result.executionReady, false, '转写完成仍不是逐输出声音计划或正式发布资格');
  assert.equal(result.reviewStatus, 'pending');
  assert.ok(result.transcriptionIdentity, '自动识别须保留真实服务身份');
  assert.equal(result.transcriptionIdentity.model, 'whisper-1');
  assert.equal(result.audioStreamIndex, 0);
  assert.ok(result.cleaned, '识别后直接带上清洗结果');
  assert.equal(result.cleaned.text, '声音测试');
  assert.deepEqual([result.cleaned.startUs, result.cleaned.endUs], [250_000, 1_500_000], '说话起止按清洗后的逐字时间');
  assert.deepEqual([result.cleaned.headCutEndUs, result.cleaned.tailCutStartUs], [null, null], '没有倒数口令时不做剪裁');
  assert.equal(uploads, 1);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'storage/live-mixcut/speech-temp')), [], '成功后清理临时声音');
  const missingService = await analyzeFormulaSourceSpeech(db, 'p', input, createOpenAiTranscriptionAdapter({}), new AbortController().signal);
  assert.equal(missingService.status, 'needs_attention');
  if (missingService.status === 'needs_attention') assert.equal(missingService.reason, 'service_unavailable');
  assert.equal(uploads, 1, '服务未配置不会尝试网络请求');
  const wrongProject = await analyzeFormulaSourceSpeech(db, 'another', input, adapter, new AbortController().signal);
  assert.equal(wrongProject.status, 'needs_attention');
  assert.equal(uploads, 1, '跨项目不能读取并上传声音');

  globalThis.fetch = async () => Response.json({ text: '', words: [] });
  const empty = await analyzeFormulaSourceSpeech(db, 'p', input, adapter, new AbortController().signal);
  assert.equal(empty.status, 'needs_attention', '无识别结果不能被宣布为无人声');
  if (empty.status === 'needs_attention') assert.equal(empty.reason, 'transcription_failed');
  assert.deepEqual(fs.readdirSync(path.join(root, 'storage/live-mixcut/speech-temp')), []);

  const { createVolcFlashAsrAdapter } = await import('../lib/media-core/adapters/volc-asr.ts');
  const volc = createVolcFlashAsrAdapter({ CREATIVE_STUDIO_VOLC_ASR_API_KEY: 'fixture-only' });
  globalThis.fetch = async (_url, init) => {
    const wav = Buffer.from(JSON.parse(String(init!.body)).audio.data, 'base64');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF', '火山也收到实际提取的 WAV');
    assert(wav.length > 60_000);
    return new Response('{}', { headers: { 'X-Api-Status-Code': '20000003' } });
  };
  const noSpeech = await analyzeFormulaSourceSpeech(db, 'p', input, volc, new AbortController().signal);
  assert.equal(noSpeech.status, 'no_speech', '供应商明确无人声结果不能阻塞展示镜头');
  assert.equal(noSpeech.manualVerification, undefined, '自动检测不能冒充人工确认');
  if (noSpeech.status === 'no_speech') {
    assert.equal(noSpeech.mediaDurationUs, 2_000_000);
    assert.deepEqual(noSpeech.detection, { provider: 'volc', statusCode: '20000003', transcriptionIdentity: volc.identity });
  }
  assert.equal(noSpeech.executionReady, false, '无人声检查不等于成片通过');
  assert.deepEqual(fs.readdirSync(path.join(root, 'storage/live-mixcut/speech-temp')), []);

  const controller = new AbortController();
  const stopReason = new Error('本次原声任务已停止');
  globalThis.fetch = async () => { controller.abort(stopReason); throw stopReason; };
  await assert.rejects(analyzeFormulaSourceSpeech(db, 'p', input, adapter, controller.signal), error => error === stopReason);
  assert.deepEqual(fs.readdirSync(path.join(root, 'storage/live-mixcut/speech-temp')), [], '停止时清理临时声音');

  const sourcePath = resolveSourceFilePath(input.sources[0].location);
  const originalBytes = fs.readFileSync(sourcePath);
  globalThis.fetch = async () => {
    fs.writeFileSync(sourcePath, '源文件在识别期间变化');
    return Response.json({ text: '声音测试', words: [{ word: '声音测试', start: 0.25, end: 1.5 }] });
  };
  try { await assert.rejects(analyzeFormulaSourceSpeech(db, 'p', input, adapter, new AbortController().signal), /变化|changed/); }
  finally { fs.writeFileSync(sourcePath, originalBytes); }
  assert.deepEqual(fs.readdirSync(path.join(root, 'storage/live-mixcut/speech-temp')), []);

  const silentFile = path.join(root, 'silent.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', silentFile]);
  const silentId = await registerManagedCopy(db, 'p', { sourcePath: silentFile });
  const silentFingerprint = (db.prepare('SELECT contentFingerprint FROM live_mixcut_assets WHERE id=?').get(silentId) as { contentFingerprint: string }).contentFingerprint;
  globalThis.fetch = async () => { throw new Error('无音轨不应调用转写服务'); };
  const silent = await analyzeFormulaSourceSpeech(db, 'p', { assetId: silentId, contentFingerprint: silentFingerprint,
    sources: listAssetSources(db, silentId).map(source => ({ id: source.id, location: source.locationJson })) }, createOpenAiTranscriptionAdapter({}), new AbortController().signal);
  assert.equal(silent.status, 'no_audio_stream', '无音轨是本地核验结论，不依赖外部服务配置');

  const delayedFile = path.join(root, 'delayed.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=2', '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', delayedFile]);
  const delayedId = await registerManagedCopy(db, 'p', { sourcePath: delayedFile });
  const delayedFingerprint = (db.prepare('SELECT contentFingerprint FROM live_mixcut_assets WHERE id=?').get(delayedId) as { contentFingerprint: string }).contentFingerprint;
  globalThis.fetch = async (_url, init) => {
    const wav = Buffer.from(await (((init!.body as FormData).get('file')) as Blob).arrayBuffer());
    let offset = 12;
    while (wav.toString('ascii', offset, offset + 4) !== 'data') {
      const size = wav.readUInt32LE(offset + 4);
      offset += 8 + size + size % 2;
      assert(offset < wav.length, '提取声音必须有 PCM 数据');
    }
    const samples = wav.subarray(offset + 8);
    assert(samples.subarray(0, 8_000).every(value => value === 0), '音轨晚一秒开始，识别文件开头仍保留实际空白');
    assert(samples.subarray(38_400, 41_600).some(value => value !== 0), '1.2 秒处应保留真实音频，不能只生成静音');
    return Response.json({ text: '后段', words: [{ word: '后段', start: 1.1, end: 1.7 }] });
  };
  const delayed = await analyzeFormulaSourceSpeech(db, 'p', { assetId: delayedId, contentFingerprint: delayedFingerprint,
    sources: listAssetSources(db, delayedId).map(source => ({ id: source.id, location: source.locationJson })) }, adapter, new AbortController().signal);
  assert.equal(delayed.status, 'transcribed');
  if (delayed.status === 'transcribed') assert.equal(delayed.words[0].startUs, 1_100_000, '源时间保持原片坐标，不提前到零秒');

  // 识别文字里的倒数和结尾口令被剪掉；台词本身以「来」开头时保留。
  const dirtyText = '三二一开始。来看看这张沙发。OK.';
  globalThis.fetch = async () => Response.json({ text: dirtyText, words: [
    { word: '三二一开始', start: 0, end: 0.5 }, { word: '来', start: 0.6, end: 0.8 },
    { word: '看看这张沙发', start: 0.9, end: 1.5 }, { word: 'OK', start: 1.6, end: 1.8 }] });
  const dirty = await analyzeFormulaSourceSpeech(db, 'p', { ...input, plannedLine: '来看看这张沙发' }, adapter, new AbortController().signal);
  assert.equal(dirty.status, 'transcribed');
  if (dirty.status !== 'transcribed') throw new Error('expected transcribed');
  assert.equal(dirty.text, dirtyText, '原始识别文字照原样保留');
  assert.equal(dirty.cleaned?.text, '来看看这张沙发');
  assert.deepEqual(dirty.cleaned?.removedHead, ['三二一开始']);
  assert.deepEqual(dirty.cleaned?.removedTail, ['OK']);
  assert.deepEqual([dirty.cleaned?.startUs, dirty.cleaned?.endUs], [600_000, 1_500_000]);
  assert.deepEqual([dirty.cleaned?.headCutEndUs, dirty.cleaned?.tailCutStartUs], [500_000, 1_600_000],
    '余量不能伸进被剪掉的倒数/口令');

  // 10-26 已经识别过、没有清洗结果的原声：读取时补做清洗，不再调用识别服务。
  const before = uploads;
  const legacy = { algorithmVersion: 'formula-source-speech/1', executionReady: false, assetId,
    contentFingerprint: input.contentFingerprint, sourceId: 'legacy', mediaDurationUs: 2_000_000,
    status: 'transcribed', reviewStatus: 'pending', text: '三二一开始。买沙发。OK.',
    words: charWords('三二一开始。买沙发。OK.'), audioStreamIndex: 0,
    transcriptionIdentity: { adapterVersion: 'legacy/1', model: 'legacy', endpointHash: 'x' } } as unknown as FormulaSourceSpeech;
  const recleaned = withCleanedSourceSpeech(legacy, null);
  assert.equal(recleaned.status, 'transcribed');
  if (recleaned.status === 'transcribed') assert.equal(recleaned.cleaned?.text, '买沙发');
  assert.equal(uploads, before, '补清洗不调用识别服务');
  assert.deepEqual(withCleanedSourceSpeech(recleaned, null), recleaned, '已清洗过的不重复处理');
  const manual = withCleanedSourceSpeech({ ...legacy, manualVerification: { revisionId: 'r', verifiedAt: 't', timing: 'manual_segments' } } as unknown as FormulaSourceSpeech, null);
  assert.equal(manual.status === 'transcribed' ? manual.cleaned : undefined, null, '人工核对的台词不清洗');
  console.log('formula source speech tests passed (ASR response stubbed, real extraction)');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  const resolved = fs.realpathSync(root);
  assert(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('formula-source-speech-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
