import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Public seam: generation → saved output → renderer → decoded MP4 samples.
// External speech services alone are fixtures; media, storage, edits and renderer are real.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-renderer-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
try {
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { readFormulaNarration, resolveFormulaNarrationMedia } = await import('../lib/live-mixcut/formula/narration-store.ts');
  const { getBatchOutputArrangementView, applyBatchOutputClipEdit } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { renderBatchOutputVersion } = await import('../lib/live-mixcut/batch-renderer.ts');
  const { resolveFullRenderContract, computeFullRenderContractHash } = await import('../lib/live-mixcut/cover-contract.ts');
  const { createBatchTask, getBatchTask, listTaskAttempts } = await import('../lib/live-mixcut/tasks.ts');
  const { buildFullRenderTaskRequestKey } = await import('../lib/live-mixcut/render-task-key.ts');
  const { resolveFormulaPreviewMedia } = await import('../lib/live-mixcut/formula/preview.ts');
  const { runFfmpeg, resolveFfmpegPath } = await import('../lib/ffmpeg.ts');
  const { computeFingerprintFromFile } = await import('../lib/live-mixcut/fingerprint.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT '');
    INSERT INTO projects VALUES ('p','声音渲染','TEST');
    CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);
    INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试音色','vapi-qwen-json-url','https://voice.example','fixture',NULL,'qwen3-tts-flash',1);`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  db.exec('CREATE TABLE final_edit_bgm_tracks (id TEXT PRIMARY KEY,relativePath TEXT,fileFingerprint TEXT,durationUs INTEGER,status TEXT)');
  const musicPath = path.join(root, 'storage', 'bgm', 'tone.wav');
  fs.mkdirSync(path.dirname(musicPath), { recursive: true });
  await runFfmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.125*sin(2*PI*if(lt(t,4),1000,1500)*t)':s=48000:d=8", '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', musicPath]);
  const musicFingerprint = await computeFingerprintFromFile(musicPath);
  db.prepare('INSERT INTO final_edit_bgm_tracks VALUES (?,?,?,?,?)').run('music', 'bgm/tone.wav', musicFingerprint, 8_000_000, 'ready');
  const source = path.join(root, 'source.mp4'), silent = path.join(root, 'silent.mp4'), voice = path.join(root, 'voice.wav');
  // 0–5s = 220Hz, 5–6s = 660Hz, 6–7s = 880Hz, 7–8s = 220Hz.
  // A wrong 0s seek is distinguishable from the two seconds actually selected.
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=8', '-f', 'lavfi', '-i',
    "aevalsrc='0.12*sin(2*PI*if(lt(t,5),220,if(lt(t,6),660,if(lt(t,7),880,220)))*t+if(between(t,5,5.02),(5.02-t)/0.02*PI/2,0))':s=48000:d=8",
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', silent]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', voice]);
  const batchId = createBatchProduction(db, 'p', '源区间声标', undefined, { planningMode: 'formula' });
  for (const [file, name] of [[source, 'VO1_原声.mp4'], [silent, 'G1_静物.mp4']]) {
    const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
    registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: name });
  }
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [141, '抖音', 2, 3, 'VO1 G1', '好擦洗。坐得稳。'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 2 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 2, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.packaging = { mode: 'none', templateIds: [] }; // Audio-only regression; real packaging has its own generation/render test.
  production.audio = { mode: 'mixed', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] }, production,
      timing: { mode: 'fixed', scope: 'body', overrideDurationSec: 3, speechMarginMs: 125 } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'render-audio', settingsId: settings.saved!.id, expectedInputRevision: 3 });
  globalThis.fetch = async (url, init) => String(url).endsWith('/audio/speech')
    ? Response.json({ output: { audio: { data: fs.readFileSync(voice).toString('base64') } } })
    : init?.body instanceof FormData && init.body.has('prompt')
      ? Response.json({ words: [{ word: '坐得稳', start: 0.1, end: 0.9 }] })
      : Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 5.125, end: 6.875 }] });
  await runPendingOnce({ db, workerId: 'render-fixture', log: () => {}, executors: [createFormulaStageExecutor(async () => ({
    id: 'fixture', name: '文案映射', model: 'fixture', async complete(input) {
      const prompt = JSON.parse(input.userPrompt);
      return { blocks: [{ text: '好擦洗。', kind: 'source', slotId: prompt.sources[0].slotId },
        { text: '坐得稳。', kind: 'tts', slotIds: prompt.narrationWindows[0] }] };
    },
  }))] });
  globalThis.fetch = originalFetch;
  const planId = request.outputs[0].planId;
  const view = getBatchOutputArrangementView(db, 'p', batchId, planId);
  assert.ok(view.outputVersionId, '实际阶段应建立可编辑版本');
  assert.deepEqual(view.formulaPreview!.audioTimeline.clips.map(clip => [clip.sourceInUs, clip.sourceOutUs, clip.timelineStartUs, clip.timelineEndUs]),
    [[5_000_000, 7_000_000, 0, 2_000_000], [0, 1_000_000, 2_000_000, 3_000_000]]);
  const renderInput = { db, projectId: 'p', batchId, batchVersionId: request.batchVersionId, planId, outputVersionId: view.outputVersionId!,
    outputSize: { width: 64, height: 64 } };
  const expectedRenderHash = computeFullRenderContractHash({ ...resolveFullRenderContract(db, view.outputVersionId!),
    outputWidth: 64, outputHeight: 64 });
  const beforeRender = (db.prepare('SELECT arrangementJson FROM live_mixcut_output_versions WHERE id=?')
    .get(view.outputVersionId) as { arrangementJson: string }).arrangementJson;
  let editedAtCompletion = false;
  const result = await renderBatchOutputVersion({ ...renderInput, onProgress(progress) {
    if (progress.phase !== 'ready') return;
    applyBatchOutputClipEdit(db, 'p', batchId, planId, { type: 'set_narration_gain', gainDb: -3,
      expectedEditRevision: view.editRevision, expectedOutputVersionId: view.outputVersionId! });
    editedAtCompletion = true;
  } });
  assert.equal(editedAtCompletion, true, '在编码完成与结果返回之间模拟另页保存音量');
  assert.equal(result.fullRenderContractHash, expectedRenderHash, '实际公式视频必须携带自己使用的画面与声音版本，供任务收尾核验');
  assert.notEqual(computeFullRenderContractHash({ ...resolveFullRenderContract(db, view.outputVersionId!),
    outputWidth: 64, outputHeight: 64 }), result.fullRenderContractHash, '实际视频不能被重新标记为刚保存的新音量版本');
  db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(beforeRender, view.outputVersionId);
  // Runner seam: the executor is a registered task worker. A task for A must
  // reject B's completion even if the editor has already returned from B to A.
  const savedArrangement = (db.prepare('SELECT arrangementJson FROM live_mixcut_output_versions WHERE id=?')
    .get(view.outputVersionId) as { arrangementJson: string }).arrangementJson;
  try {
    for (const [index, scenario] of ['different', 'missing', 'legacy', 'matching'].entries()) {
      const frozen = { ...JSON.parse(savedArrangement), editRevision: index + 100 };
      db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(frozen), view.outputVersionId);
      const taskHash = computeFullRenderContractHash(resolveFullRenderContract(db, view.outputVersionId!));
      const taskId = createBatchTask(db, 'p', { batchId, workType: 'render', targetKind: 'output_version', targetId: view.outputVersionId!,
        requestKey: scenario === 'legacy' ? `legacy-${index}` : buildFullRenderTaskRequestKey(view.outputVersionId!, taskHash) });
      let discarded = 0;
      await runPendingOnce({ db, workerId: `identity-${scenario}`, log: () => {}, executors: [{ workTypes: ['render'], async execute() {
        let returnedHash: string | undefined = taskHash;
        if (scenario === 'different') {
          const changed = structuredClone(frozen);
          changed.audioPlan.clips[0].gainDb = -12;
          db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(changed), view.outputVersionId);
          returnedHash = computeFullRenderContractHash(resolveFullRenderContract(db, view.outputVersionId!));
          db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(frozen), view.outputVersionId);
        } else if (scenario === 'missing') returnedHash = undefined;
        return { resultJson: { fullRenderContractHash: returnedHash }, discard: () => { discarded++; } };
      } }] });
      const accepted = scenario === 'matching';
      assert.equal(getBatchTask(db, 'p', taskId)?.status, accepted ? 'succeeded' : 'cancelled', `${scenario}: 公式整片任务必须核对任务、当前内容与实际结果三者身份`);
      assert.equal(listTaskAttempts(db, taskId)[0]?.status, accepted ? 'succeeded' : 'interrupted');
      assert.equal(discarded, accepted ? 0 : 1, '不能提交的候选必须清理');
    }
  } finally {
    db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(savedArrangement, view.outputVersionId);
  }
  async function samples(file: string, channels = 1): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      // One-channel checks select left, not a stereo-to-mono mix that adds gain.
      const child = spawn(resolveFfmpegPath(), ['-v', 'error', '-i', file, '-map', '0:a:0', '-af',
        `aresample=48000:async=1:first_pts=0${channels === 1 ? ',pan=mono|c0=c0' : ''}`, '-ac', String(channels), '-ar', '48000', '-f', 'f32le', 'pipe:1'], { windowsHide: true });
      const chunks: Buffer[] = []; let stderr = '';
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr));
        const bytes = Buffer.concat(chunks);
        resolve(Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4)));
      });
    });
  }
  function toneAmplitude(pcm: Float32Array, start: number, duration: number, hz: number) {
    const from = Math.round(start * 48_000), length = Math.round(duration * 48_000);
    assert(from + length <= pcm.length, '成片声音不能提前结束');
    let re = 0, im = 0;
    for (let i = 0; i < length; i++) {
      const phase = 2 * Math.PI * hz * i / 48_000;
      re += pcm[from + i] * Math.cos(phase); im += pcm[from + i] * Math.sin(phase);
    }
    return 2 * Math.hypot(re, im) / length;
  }
  const decoded = await samples(result.videoAbsolutePath);
  const intro = 20 / 24;
  function rms(pcm: Float32Array, start: number, duration: number) {
    const from = Math.round(start * 48_000), count = Math.round(duration * 48_000);
    let sum = 0;
    for (let i = from; i < from + count; i++) sum += pcm[i] ** 2;
    return Math.sqrt(sum / count);
  }
  assert(rms(decoded, intro + 0.0003, 0.0012) < 0.03, '原声从非零采样切入时，开头应短渐入而不是突然跳满音量');
  assert(rms(decoded, intro + 0.015, 0.02) > 0.06, '防爆音不能长期压低正常原声');
  const originalAudio = await samples(source);
  assert(toneAmplitude(originalAudio, 5.25, 0.5, 660) > 0.1, '声标素材第 5 秒为 660Hz');
  assert(toneAmplitude(originalAudio, 6.25, 0.5, 880) > 0.1, '声标素材第 6 秒为 880Hz');
  const encodedStereo = await samples(result.videoAbsolutePath, 2);
  for (const channel of [0, 1]) {
    const channelSamples = encodedStereo.filter((_, index) => index % 2 === channel);
    const level = toneAmplitude(channelSamples, intro + 0.25, 0.5, 660);
    assert(level > 0.115 && level < 0.125, `单声道原声在输出左右声道都保持原电平，不额外衰减：${channel} / ${level}`);
  }
  assert(toneAmplitude(decoded, intro + 0.25, 0.5, 660) > 0.04, `MP4 正文开头必须播放源 5–6 秒，不能静音或从原片 0 秒取声：${JSON.stringify([220, 440, 660, 880].map(hz => [hz, toneAmplitude(decoded, intro + 0.25, 0.5, hz)]))}`);
  assert(toneAmplitude(decoded, intro + 1.25, 0.5, 880) > 0.04, '第二秒必须继续播放原声 6–7 秒');
  assert(toneAmplitude(decoded, intro + 2.25, 0.5, 440) > 0.04, '正文两秒以后播放独立配音');
  for (const hz of [220, 440, 660, 880]) assert(toneAmplitude(decoded, 0.1, 0.5, hz) < 0.001, '封面期间必须静音，偏移只加一次');
  assert(toneAmplitude(decoded, intro + 0.25, 0.5, 220) < 0.001, '不能混入未选中的原片声音');
  assert(toneAmplitude(decoded, intro + 0.25, 0.5, 1000) < 0.001, '曲库有音乐也不能覆盖明确的不加音乐设置');
  assert(Math.abs(result.durationUs - 3_833_333) < 50_000, '三秒正文加二十帧封面');
  assert.equal(result.audioMode, 'mixed');
  assert.equal(result.productionReady, true, '真实制作检查通过后的渲染可交给独立审核与发布检查');
  assert.ok(result.formulaExecution?.stageId, '结果保留实际使用的制作检查记录');
  const current = () => getBatchOutputArrangementView(db, 'p', batchId, planId);
  function edit(command: Parameters<typeof applyBatchOutputClipEdit>[4]) {
    const state = current();
    return applyBatchOutputClipEdit(db, 'p', batchId, planId, { ...command,
      expectedEditRevision: state.editRevision, expectedOutputVersionId: state.outputVersionId! });
  }
  const loudPath = path.join(root, 'storage', 'bgm', 'loud.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.99*sin(2*PI*1000*t)|0.3*sin(2*PI*1000*t)':c=stereo:s=48000:d=8", '-c:a', 'pcm_s16le', '-y', loudPath]);
  db.prepare('INSERT INTO final_edit_bgm_tracks VALUES (?,?,?,?,?)').run('loud-music', 'bgm/loud.wav', await computeFingerprintFromFile(loudPath), 8_000_000, 'ready');
  edit({ type: 'set_narration_gain', gainDb: 10 });
  edit({ type: 'set_music', trackId: 'loud-music', gainDb: 0, fadeInSec: 0, fadeOutSec: 0,
    ducking: { version: 1, enabled: false, reductionDb: 8, attackMs: 100, releaseMs: 250 } });
  const loudMix = await renderBatchOutputVersion(renderInput);
  assert.equal(loudMix.productionReady, false, '编辑声音后尚未重新检查的渲染不能正式发布');
  // Measure both encoded channels directly; mono downmix can itself add gain.
  const loudSamples = await samples(loudMix.videoAbsolutePath, 2);
  const peak = loudSamples.slice(Math.round((intro + 0.25) * 48_000) * 2, Math.round((intro + 0.75) * 48_000) * 2)
    .reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  assert(peak > 0.7 && peak < 0.95, `大音量原声与音乐混合后应保留编码余量，不能过载或静音：${peak}`);
  const rightPeak = loudSamples.slice(Math.round((intro + 0.25) * 48_000) * 2, Math.round((intro + 0.75) * 48_000) * 2)
    .filter((_, index) => index % 2 === 1).reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  assert(rightPeak < 0.8 && peak - rightPeak > 0.1, '已有立体声的左右声道差异必须保留，不能当作单声道复制');
  edit({ type: 'restore_arrangement', snapshot: { ...view, musicTrackId: null, musicGainDb: view.music.gainDb,
    musicFadeInSec: view.music.fadeInSec, musicFadeOutSec: view.music.fadeOutSec, musicDucking: view.music.ducking,
    narrationGainDb: view.narration.gainDb } });
  db.prepare("UPDATE final_edit_bgm_tracks SET status='archived' WHERE id='loud-music'").run();
  console.log('audio protection evidence', { onsetRms: rms(decoded, intro + 0.0003, 0.0012),
    steadyRms: rms(decoded, intro + 0.015, 0.02), encodedStereoPeak: peak });
  // A split retains the same media identity. Moving the TTS changes only its
  // destination; extending the last silent picture keeps the whole edit covered.
  edit({ type: 'split', clipId: view.clips[0].clipId, offsetUs: 1_000_000 });
  edit({ type: 'trim_variable', clipId: view.clips[1].clipId, sourceStartUs: view.clips[1].sourceStartUs, sourceEndUs: 2_000_000 });
  edit({ type: 'move_audio_clip', track: 'narration', clipId: view.audioPlan!.clips[1].id, timelineStartUs: 2_500_000 });
  edit({ type: 'split_audio_clip', track: 'narration', clipId: view.audioPlan!.clips[1].id, atUs: 3_000_000 });
  edit({ type: 'set_narration_gain', gainDb: -6 });
  const editedView = current();
  assert.equal(editedView.audioPlan!.bodyDurationUs, 3_500_000);
  assert.equal(editedView.audioPlan!.clips.length, 4);
  assert.deepEqual(editedView.formulaPreview!.audioTimeline.clips.map(clip => clip.gainDb), [-6, -6, -6, -6]);
  const edited = await renderBatchOutputVersion(renderInput);
  const editedAudio = await samples(edited.videoAbsolutePath);
  assert(rms(editedAudio, intro + 0.999, 0.002) > 0.025, '连续原声的结构分割处不应增加淡入淡出凹口');
  for (const [at, hz] of [[0.25, 660], [1.25, 880], [2.6, 440], [3.1, 440]]) {
    const amplitude = toneAmplitude(editedAudio, intro + at, 0.25, hz);
    assert(amplitude > 0.05 && amplitude < 0.07, `分割/移动后仍使用正确源声音和 -6dB 音量：${at}s / ${hz}Hz / ${amplitude}`);
  }
  assert(toneAmplitude(editedAudio, intro + 2.1, 0.25, 440) < 0.001, '移动后原来的配音位置必须安静');
  assert.equal(edited.editRevision, editedView.editRevision);
  assert(Math.abs(edited.durationUs - 4_333_333) < 50_000, '编辑后使用实际正文长度，不按整段口播长度裁短');
  assert.deepEqual(edited.subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]),
    editedView.subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]), '导出与当前预览使用同一字幕坐标');
  edit({ type: 'set_music', trackId: 'music', gainDb: -6, fadeInSec: 0, fadeOutSec: 0 });
  const musicView = current();
  assert.deepEqual(musicView.music.ducking, { version: 1, enabled: true, reductionDb: 8, attackMs: 100, releaseMs: 250 },
    '新公式成片保存默认说话压低音乐参数');
  assert.ok(musicView.formulaPreview!.music?.fileUrl, '公式音乐预览必须读取本条保存的来源');
  const musicUrl = new URL(musicView.formulaPreview!.music!.fileUrl, 'http://local.test');
  const musicQuery = musicUrl.searchParams;
  const resolveMusic = (projectId = 'p') => resolveFormulaPreviewMedia(db, projectId, batchId, planId,
    musicQuery.get('selectionStageId')!, musicQuery.get('timelineStageId')!, 'music', musicQuery.get('mediaId')!,
    new AbortController().signal, { outputVersionId: musicQuery.get('outputVersionId')!, sourceFingerprint: musicQuery.get('sourceFingerprint')! });
  assert.equal((await resolveMusic()).absolutePath, musicPath);
  await assert.rejects(() => resolveMusic('foreign'), /不存在|项目|归属/);
  // Catalogue changes must not replace the saved file in preview or render.
  db.prepare("UPDATE final_edit_bgm_tracks SET relativePath='bgm/replaced.wav',fileFingerprint='different' WHERE id='music'").run();
  assert.equal((await resolveMusic()).absolutePath, musicPath);
  const withMusic = await renderBatchOutputVersion(renderInput);
  const musicSamples = await samples(withMusic.videoAbsolutePath);
  for (const at of [0.25, 2.6]) {
    const level = toneAmplitude(musicSamples, intro + at, 0.2, 1000);
    assert(level > 0.022 && level < 0.028, `原声与配音窗口的音乐均额外降低 8dB：${at}s / ${level}`);
  }
  const gapMusic = toneAmplitude(musicSamples, intro + 2.27, 0.1, 1000);
  assert(gapMusic > 0.055 && gapMusic < 0.07, '声音窗口之间，音乐在恢复时间后回到所设音量');
  for (const at of [0.98, 2.98]) {
    const level = toneAmplitude(musicSamples, intro + at, 0.04, 1000);
    assert(level > 0.022 && level < 0.028, '连续原声或配音被分割后，音乐不能在接缝突然变响');
  }
  for (const at of [2.105, 2.43]) {
    const level = toneAmplitude(musicSamples, intro + at, 0.04, 1000);
    assert(level > 0.039 && level < 0.049, `音乐平滑恢复/压低，不能突然跳音量：${at}s / ${level}`);
  }
  assert(toneAmplitude(musicSamples, intro + 0.25, 0.5, 660) > 0.05, '添加音乐不降低原本人声音量');
  const noDucking = { version: 1 as const, enabled: false, reductionDb: 12, attackMs: 50, releaseMs: 400 };
  edit({ type: 'set_music', trackId: 'music', gainDb: -6, fadeInSec: 0, fadeOutSec: 0, ducking: noDucking });
  assert.deepEqual(current().music.ducking, noDucking, '用户关闭并调整压低参数后必须保存');
  const withoutDucking = await renderBatchOutputVersion(renderInput);
  const noDuckSamples = await samples(withoutDucking.videoAbsolutePath);
  assert(toneAmplitude(noDuckSamples, intro + 0.25, 0.5, 1000) > 0.055, '关闭说话压低后，音乐恢复设定音量');
  edit({ type: 'set_music', trackId: 'music', gainDb: -6, fadeInSec: 0, fadeOutSec: 0,
    ducking: { version: 1, enabled: true, reductionDb: 12, attackMs: 0, releaseMs: 0 } });
  const immediateDucking = await renderBatchOutputVersion(renderInput);
  const immediateSamples = await samples(immediateDucking.videoAbsolutePath);
  const customLevel = toneAmplitude(immediateSamples, intro + 0.25, 0.2, 1000);
  assert(customLevel > 0.014 && customLevel < 0.017, '自定义 12dB 降低量应进入实际 MP4');
  assert(toneAmplitude(immediateSamples, intro + 2.03, 0.1, 1000) > 0.055, '零恢复时间合法且不产生无效音频');
  edit({ type: 'set_music', trackId: 'music', gainDb: -6, fadeInSec: 0, fadeOutSec: 0,
    ducking: { version: 1, enabled: true, reductionDb: 12, attackMs: 100, releaseMs: 500 } });
  const joinedDucking = await renderBatchOutputVersion(renderInput);
  const joinedSamples = await samples(joinedDucking.videoAbsolutePath);
  const joinedLevel = toneAmplitude(joinedSamples, intro + 2.2, 0.1, 1000);
  assert(joinedLevel > 0.014 && joinedLevel < 0.017, '短于恢复加压低时间的说话间隙维持低音量，避免来回起伏');
  edit({ type: 'set_music_track', trackId: null });
  await assert.rejects(resolveMusic, /变化|当前|音乐/);
  edit({ type: 'restore_arrangement', snapshot: { ...musicView, musicTrackId: musicView.music.trackId,
    musicGainDb: musicView.music.gainDb, musicFadeInSec: 0, musicFadeOutSec: 0, narrationGainDb: musicView.narration.gainDb,
    musicSourceFingerprint: musicView.formulaPreview!.music!.sourceFingerprint, musicDucking: musicView.music.ducking } });
  assert.deepEqual(current().music.ducking, musicView.music.ducking, '整包撤销同时恢复音乐压低参数');
  assert.equal((await resolveMusic()).absolutePath, musicPath, '撤销关闭音乐恢复原文件，不能换成曲库中的新内容');
  edit({ type: 'trim_audio_clip', track: 'bgm', clipId: 'bgm-full', sourceStartUs: 5_000_000, sourceEndUs: 7_000_000,
    timelineStartUs: 0, timelineEndUs: 2_000_000 });
  edit({ type: 'move_audio_clip', track: 'bgm', clipId: 'bgm-full', timelineStartUs: 1_000_000 });
  edit({ type: 'split_audio_clip', track: 'bgm', clipId: 'bgm-full', atUs: 2_000_000 });
  const cutMusic = await renderBatchOutputVersion(renderInput);
  const cutSamples = await samples(cutMusic.videoAbsolutePath);
  for (const at of [1.25, 2.65]) {
    const level = toneAmplitude(cutSamples, intro + at, 0.2, 1500);
    assert(level > 0.022 && level < 0.028, `裁切/移动/分割后的音乐仍播放源 5–7 秒，且音量不因分割改变：${at}s / ${level}`);
    assert(toneAmplitude(cutSamples, intro + at, 0.2, 1000) < 0.001, '不能继续播放音乐原来的开头');
  }
  for (const at of [0.3, 3.1]) assert(toneAmplitude(cutSamples, intro + at, 0.15, 1500) < 0.001, '音乐片段外保持安静');
  assert(toneAmplitude(cutSamples, intro + 2.28, 0.1, 1500) > 0.055, '移动后音乐与原声压低窗口仍使用正文位置');
  edit({ type: 'restore_arrangement', snapshot: { ...musicView, musicTrackId: musicView.music.trackId,
    musicGainDb: musicView.music.gainDb, musicFadeInSec: 0, musicFadeOutSec: 0, narrationGainDb: musicView.narration.gainDb,
    musicSourceFingerprint: musicView.formulaPreview!.music!.sourceFingerprint, musicDucking: musicView.music.ducking } });
  edit({ type: 'trim_audio_clip', track: 'bgm', clipId: 'bgm-full', sourceStartUs: 15_500_000, sourceEndUs: 17_500_000,
    timelineStartUs: 1_000_000, timelineEndUs: 3_000_000 });
  edit({ type: 'split_audio_clip', track: 'bgm', clipId: 'bgm-full', atUs: 2_000_000 });
  const loopMusic = await renderBatchOutputVersion(renderInput);
  const loopSamples = await samples(loopMusic.videoAbsolutePath);
  assert(toneAmplitude(loopSamples, intro + 1.15, 0.15, 1500) > 0.022, '循环裁切先播放音乐尾部');
  for (const at of [1.75, 2.65]) {
    assert(toneAmplitude(loopSamples, intro + at, 0.15, 1000) > 0.022, '跨音乐尾部后回到开头，分割不丢失循环位置');
    assert(toneAmplitude(loopSamples, intro + at, 0.15, 1500) < 0.001);
  }
  for (const clip of current().audio!.bgm!) edit({ type: 'delete_audio_clip', track: 'bgm', clipId: clip.id });
  const deletedMusic = await renderBatchOutputVersion(renderInput);
  const deletedMusicSamples = await samples(deletedMusic.videoAbsolutePath);
  for (const frequency of [1000, 1500]) assert(toneAmplitude(deletedMusicSamples, intro + 1.2, 0.2, frequency) < 0.001,
    '删除全部音乐片段后不能回填整首歌曲');
  edit({ type: 'restore_arrangement', snapshot: { ...musicView, musicTrackId: musicView.music.trackId,
    musicGainDb: musicView.music.gainDb, musicFadeInSec: 0, musicFadeOutSec: 0, narrationGainDb: musicView.narration.gainDb,
    musicSourceFingerprint: musicView.formulaPreview!.music!.sourceFingerprint, musicDucking: musicView.music.ducking } });
  assert.throws(() => edit({ type: 'restore_arrangement', snapshot: { ...musicView, musicTrackId: 'music',
    musicSourceFingerprint: 'foreign-file', musicGainDb: -6, musicFadeInSec: 0, musicFadeOutSec: 0 } }), /不属于这份成片/);
  db.prepare('UPDATE final_edit_bgm_tracks SET relativePath=?,fileFingerprint=? WHERE id=?').run('bgm/tone.wav', musicFingerprint, 'music');
  function renderedFiles() {
    return fs.readdirSync(path.join(root, 'storage', 'live-mixcut/renders'), { recursive: true }).map(String)
      .filter(file => /\.(mp4|jpg)(\.tmp)?$/.test(file)).sort();
  }
  const completedFiles = renderedFiles();
  const intactMusic = fs.readFileSync(musicPath), damagedMusic = Buffer.from(intactMusic);
  damagedMusic[damagedMusic.length - 2] ^= 0x7f;
  let musicChanged = false;
  try {
    await assert.rejects(() => renderBatchOutputVersion({ ...renderInput, onProgress(progress) {
      if (progress.phase === 'verifying' && !musicChanged) { musicChanged = true; fs.writeFileSync(musicPath, damagedMusic); }
    } }), /BGM|音乐|变化/);
    assert.equal(musicChanged, true);
    await assert.rejects(resolveMusic, /音乐文件内容已变化/);
    await assert.rejects(() => renderBatchOutputVersion(renderInput), /BGM|音乐|变化/);
  } finally { fs.writeFileSync(musicPath, intactMusic); }
  assert.deepEqual(renderedFiles(), completedFiles, '渲染结束前音乐变化也必须丢弃本次候选');
  edit({ type: 'set_music_track', trackId: null });
  let editedDuringRender = false;
  await assert.rejects(() => renderBatchOutputVersion({ ...renderInput, onProgress(progress) {
    if (progress.phase === 'verifying' && !editedDuringRender) {
      editedDuringRender = true;
      edit({ type: 'set_narration_gain', gainDb: -3 });
    }
  } }), /编辑内容|已变化/);
  assert.equal(editedDuringRender, true);
  assert.deepEqual(renderedFiles(), completedFiles, '旧内容即使已编码完，也不能留下可误用的成片候选');
  const abort = new AbortController();
  let cancelledWhileEncoding = false;
  await assert.rejects(() => renderBatchOutputVersion({ ...renderInput, signal: abort.signal, onProgress(progress) {
    if (progress.phase === 'rendering' && Number(progress.completed) > 0 && !cancelledWhileEncoding) {
      cancelledWhileEncoding = true; abort.abort();
    }
  } }), /中止|abort/);
  assert.equal(cancelledWhileEncoding, true, '取消发生在 FFmpeg 已报告实际进度之后');
  assert.deepEqual(renderedFiles(), completedFiles, '取消后的临时视频和封面应清理，既有结果保持');
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
  await assert.rejects(() => renderBatchOutputVersion(renderInput), /暂不可用/);
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
  await assert.rejects(() => renderBatchOutputVersion({ ...renderInput, projectId: 'foreign' }), /谱系/);
  const incomplete = current().audioPlan!.clips.find(clip => clip.kind === 'narration')!;
  edit({ type: 'delete_audio_clip', track: 'narration', clipId: incomplete.id });
  await assert.rejects(() => renderBatchOutputVersion(renderInput), /截断|删除|完整声音/);
  assert.deepEqual(renderedFiles(), completedFiles);
  // The other supported voice choices must use the same renderer without a
  // fabricated full-length narration file or requiring an unused TTS provider.
  for (const mode of ['original', 'narration'] as const) {
    db.prepare('UPDATE final_edit_tts_providers SET enabled=?').run(mode === 'original' ? 0 : 1);
    const modeBatch = createBatchProduction(db, 'p', mode, undefined, { planningMode: 'formula' });
    for (const [file, name] of [[source, 'VO1_原声.mp4'], [silent, 'G1_静物.mp4']]) {
      const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
      registerFormulaAssetBinding(db, 'p', modeBatch, { assetId, sourcePath: name });
    }
    const modeImport = await createFormulaImportSession(db, 'p', modeBatch, { kind: 'scripts', filename: '脚本.xlsx',
      bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 2 });
    confirmFormulaImportSession(db, 'p', modeBatch, modeImport.id, { expectedRevision: 2, excludedKeys: [] });
    const modeProduction = defaultFormulaProductionSettings();
    modeProduction.packaging = { mode: 'none', templateIds: [] };
    modeProduction.audio = { mode, tts: mode === 'original' ? null : { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
    const modeSettings = await saveFormulaSettings(db, 'p', modeBatch, { expectedInputRevision: 3, expectedSettingsRevision: 0,
      scriptsSessionId: modeImport.id, settings: { selections: [{ key: '1:2', copies: 1 }],
        bgm: { mode: mode === 'original' ? 'manual' : 'auto', trackIds: mode === 'original' ? ['music'] : [] }, production: modeProduction,
        timing: { mode: 'fixed', scope: 'body', overrideDurationSec: 3, speechMarginMs: 125 } } });
    const modeRequest = await createFormulaGenerationRequest(db, 'p', modeBatch, { requestKey: `render-${mode}`, settingsId: modeSettings.saved!.id, expectedInputRevision: 3 });
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/audio/speech')) {
        assert.equal(mode, 'narration', '纯原声不得请求 TTS');
        return Response.json({ output: { audio: { data: fs.readFileSync(voice).toString('base64') } } });
      }
      return init?.body instanceof FormData && init.body.has('prompt')
        ? Response.json({ words: [{ word: '好擦洗坐得稳', start: 0.1, end: 0.9 }] })
        : Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 5.125, end: 6.875 }] });
    };
    await runPendingOnce({ db, workerId: `mode-${mode}`, log: () => {}, executors: [createFormulaStageExecutor()] });
    globalThis.fetch = originalFetch;
    const modePlan = modeRequest.outputs[0].planId;
    const modeView = getBatchOutputArrangementView(db, 'p', modeBatch, modePlan);
    assert.ok(modeView.outputVersionId);
    assert.equal(modeView.music.trackId, 'music', '手选或自动分配的音乐必须进入当前成片');
    const modeResult = await renderBatchOutputVersion({ ...renderInput, batchId: modeBatch, batchVersionId: modeRequest.batchVersionId,
      planId: modePlan, outputVersionId: modeView.outputVersionId! });
    const pcm = await samples(modeResult.videoAbsolutePath);
    const hz = mode === 'original' ? 660 : 440;
    assert(toneAmplitude(pcm, intro + 0.25, 0.5, hz) > 0.1, `${mode} 使用实际声音`);
    assert(toneAmplitude(pcm, 0.1, 0.5, hz) < 0.001, `${mode} 片头静音`);
    assert(toneAmplitude(pcm, intro + 0.25, 0.5, 1000) > 0.0015, `${mode} 的生成时选曲压低后仍实际进入 MP4`);
    assert(toneAmplitude(pcm, 0.1, 0.5, 1000) < 0.001, '背景音乐也不提前进入片头');
    assert.equal(modeResult.audioMode, mode === 'original' ? 'source' : 'narration');
    assert.equal(modeResult.productionReady, true, '公式声音经制作检查后才能产生可发布渲染');
    assert.ok(modeResult.formulaExecution?.stageId);
    if (mode === 'narration') {
      const savedVoice = readFormulaNarration(db, 'p', modeBatch, modePlan);
      const media = resolveFormulaNarrationMedia(db, 'p', modeBatch, modePlan, savedVoice.selectionStageId, savedVoice.result!.items[0].id);
      const intact = fs.readFileSync(media.absolutePath), corrupted = Buffer.from(intact);
      corrupted[corrupted.length - 2] ^= 0x7f;
      const before = renderedFiles();
      let changed = false;
      try {
        await assert.rejects(() => renderBatchOutputVersion({ ...renderInput, batchId: modeBatch, batchVersionId: modeRequest.batchVersionId,
          planId: modePlan, outputVersionId: modeView.outputVersionId!, onProgress(progress) {
            if (progress.phase === 'verifying' && !changed) { changed = true; fs.writeFileSync(media.absolutePath, corrupted); }
          } }), /变化|changed/);
        assert.equal(changed, true);
        await assert.rejects(() => renderBatchOutputVersion({ ...renderInput, batchId: modeBatch, batchVersionId: modeRequest.batchVersionId,
          planId: modePlan, outputVersionId: modeView.outputVersionId! }), /配音文件|已变化/);
      } finally { fs.writeFileSync(media.absolutePath, intact); }
      assert.deepEqual(renderedFiles(), before, '编码后声音文件被替换，也必须丢弃本次候选');
    }
  }
  console.log('formula-renderer: source intervals, speech edits, music trim/move/split/loop/delete, ducking, file changes, intro, cancellation and gates passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
