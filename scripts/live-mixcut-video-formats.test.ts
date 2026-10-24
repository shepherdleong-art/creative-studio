import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
/** Public seam: import → external narration → generation worker → actual full-size MP4.
 * Synthetic frame/audio markers isolate format and timing checks from service/model quality.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-video-formats-'));
const longSubtitle = process.argv.includes('--long-subtitle');
const evidence = path.resolve(longSubtitle ? 'outputs/formula-long-subtitle' : 'outputs/formula-video-formats');
const firstCaption = longSubtitle
  ? '选沙发先量好客厅的实际尺寸，再看坐深与靠背是否适合家人的习惯。平时喜欢坐着阅读，可以试试扶手的高度；喜欢躺着休息，也要确认腿部能够放松。最后再比较面料的清洁方式，让每天的使用都更省心。'
  : '第一镜头。';
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
let providerCalls = 0;
try {
  globalThis.fetch = async () => { providerCalls++; throw new Error('格式验收只在本地运行'); };
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaExternalNarration } = await import('../lib/live-mixcut/formula/external-narration.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { getBatchOutputArrangementView } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { renderBatchOutputVersion } = await import('../lib/live-mixcut/batch-renderer.ts');
  const { runFfmpeg, resolveFfmpegPath, resolveFfprobePath, probeVideoMedia } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'TEST',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','多格式与帧边界');
    CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  db.exec('CREATE TABLE final_edit_bgm_tracks (id TEXT PRIMARY KEY,relativePath TEXT,fileFingerprint TEXT,durationUs INTEGER,status TEXT)');
  fs.mkdirSync(evidence, { recursive: true });
  const videos = [];
  for (const [index, codec, color, pixelFormat] of [[1, 'libx265', 'red', 'yuv420p10le'], [2, 'libx264', 'blue', 'yuv420p']] as const) {
    const filename = path.join(root, `G${index}.mp4`);
    console.log(`生成 2160×3840 / 50fps ${codec} 输入`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=2160x3840:r=50:d=3`, '-vf',
      'drawbox=x=(iw-600)/2:y=(ih-600)/2:w=600:h=600:color=white:t=20',
      '-c:v', codec, '-preset', 'ultrafast', '-threads', '2', ...(codec === 'libx265' ? ['-x265-params', 'pools=2:frame-threads=1'] : []),
      '-pix_fmt', pixelFormat, '-y', filename], { timeoutMs: 180_000 });
    const probe = await probeVideoMedia(filename);
    assert.equal(probe.width, 2160); assert.equal(probe.height, 3840); assert.equal(probe.fps, 50);
    assert.equal(probe.videoCodec, index === 1 ? 'hevc' : 'h264'); assert.equal(probe.pixelFormat, pixelFormat);
    videos.push({ filename, probe });
  }
  const audio = path.join(root, 'voice.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.15*sin(2*PI*660*t)|0.15*sin(2*PI*880*t)':c=stereo:s=48000:d=4", '-c:a', 'pcm_s16le', '-y', audio]);
  const results = [];
  for (const [preset, width, height] of [['9x16', 1080, 1920], ['3x4', 1080, 1440], ['16x9', 1920, 1080]] as const) {
    console.log(`验收 ${preset}：导入、生成与 ${width}×${height} 正式尺寸渲染`);
    const batchId = createBatchProduction(db, 'p', `格式 ${preset}`, undefined, { planningMode: 'formula' });
    for (const [index, video] of videos.entries()) {
      const assetId = await registerManagedCopy(db, 'p', { sourcePath: video.filename });
      registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: `G${index + 1}_格式.mp4` });
    }
    const book = new ExcelJS.Workbook();
    book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
      [12, '本地验收', 2, 4, 'G1 G2', `${firstCaption}第二镜头。`]]);
    const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '格式.xlsx',
      bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 2 });
    confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 2, excludedKeys: [] });
    await saveFormulaExternalNarration(db, 'p', batchId, { scriptKey: '1:2', scriptsSessionId: imported.id,
      expectedInputRevision: 3, expectedNarrationRevision: 0, confirmed: true, filename: '合成双声道.wav', bytes: fs.readFileSync(audio),
      srt: `1\n00:00:00,125 --> 00:00:01,875\n${firstCaption}\n\n2\n00:00:02,125 --> 00:00:03,875\n第二镜头。\n` });
    const production = defaultFormulaProductionSettings();
    production.outputPreset = preset; production.audio = { mode: 'narration', tts: null }; production.packaging = { mode: 'none', templateIds: [] };
    const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 4, expectedSettingsRevision: 0,
      scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] }, production,
        timing: { mode: 'fixed', scope: 'body', overrideDurationSec: 4, speechMarginMs: 125 } } });
    const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: preset, settingsId: settings.saved!.id, expectedInputRevision: 4 });
    await runPendingOnce({ db, workerId: `formats-${preset}`, executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
    const view = getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId);
    assert(getBatchWorkspace(db, 'p', batchId).cards[0].approvable, '应通过真实媒体制作检查');
    assert.equal(view.audioPlan?.bodyDurationUs, 4_000_000);
    assert.deepEqual(view.clips.map(clip => [clip.timelineStartUs, clip.timelineEndUs]), [[0, 2_000_000], [2_000_000, 4_000_000]]);
    const output = await renderBatchOutputVersion({ db, projectId: 'p', batchId, batchVersionId: request.batchVersionId,
      planId: view.planId, outputVersionId: view.outputVersionId! });
    const finalPath = path.join(evidence, `${preset}.mp4`); fs.copyFileSync(output.videoAbsolutePath, finalPath);
    if (longSubtitle) {
      assert.equal(view.subtitleCues[0].text, firstCaption, '长字幕文字和人工时间不变');
      assert.equal(view.subtitleCues[0].startUs, 125_000); assert.equal(view.subtitleCues[0].endUs, 1_875_000);
      const image = spawnSync(resolveFfmpegPath(), ['-v', 'error', '-ss', '1.5', '-i', finalPath, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
        { windowsHide: true, timeout: 60_000, maxBuffer: width * height * 4 });
      assert.equal(image.status, 0, image.stderr.toString()); assert.equal(image.stdout.length, width * height * 3);
      await sharp(image.stdout, { raw: { width, height, channels: 3 } }).png().toFile(path.join(evidence, `${preset}-subtitle.png`));
      let minX: number = width, maxX = -1, brightPixels = 0;
      for (let y = Math.floor(height * 0.65); y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        if (image.stdout[offset] > 200 && image.stdout[offset + 1] > 200 && image.stdout[offset + 2] > 200) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); brightPixels++;
        }
      }
      assert(brightPixels > 100, '成片实际显示字幕');
      assert(minX >= width * 0.08 && maxX <= width * 0.92, `长字幕被横向切掉或挤到画边：${minX}..${maxX}`);
    }
    const counted = spawnSync(resolveFfprobePath(), ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', finalPath],
      { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
    assert.equal(counted.status, 0, counted.stderr);
    const streams = JSON.parse(counted.stdout).streams;
    const video = streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
    const sound = streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
    assert.equal(video.width, width); assert.equal(video.height, height); assert.equal(video.r_frame_rate, '24/1');
    assert.equal(Number(video.nb_read_frames), 116, '4 秒正文 96 帧，加且只加 20 帧封面');
    assert.equal(sound.channels, 2); assert.equal(sound.sample_rate, '48000');
    // Decode every frame to a single safe center sample. Letterboxing/gaps cannot hide behind metadata.
    const pixels = spawnSync(resolveFfmpegPath(), ['-v', 'error', '-i', finalPath, '-vf', 'crop=2:2:iw/2:ih/2,scale=1:1',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal(pixels.status, 0, pixels.stderr.toString()); assert.equal(pixels.stdout.length, 116 * 3);
    for (let frame = 20; frame < 116; frame++) {
      const [red, green, blue] = pixels.stdout.subarray(frame * 3, frame * 3 + 3);
      assert(frame < 68 ? red > 180 && blue < 50 && green < 50 : blue > 180 && red < 50 && green < 50,
        `${preset} 第 ${frame} 帧镜头边界/颜色错误：${red},${green},${blue}`);
    }
    const pcm = spawnSync(resolveFfmpegPath(), ['-v', 'error', '-i', finalPath, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
      { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(pcm.status, 0, pcm.stderr.toString());
    const samples = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.byteLength / 4);
    function rms(start: number, end: number, channel: number) {
      let sum = 0, count = 0;
      for (let i = Math.floor(start * 48_000); i < Math.floor(end * 48_000); i++) { sum += samples[i * 2 + channel] ** 2; count++; }
      return Math.sqrt(sum / count);
    }
    for (const channel of [0, 1]) {
      assert(rms(0.1, 0.7, channel) < 0.001, '封面阶段没有重复/提前播放正文声音');
      assert(rms(0.9, 1.1, channel) > 0.07, '正文声音按 20 帧封面偏移开始');
      assert(rms(4.6, 4.75, channel) > 0.07, '末尾配音仍存在，不能因变帧率截尾');
    }
    const frames = path.join(evidence, `${preset}-frames.jpg`);
    await runFfmpeg(['-y', '-i', finalPath, '-vf', "select='eq(n,19)+eq(n,20)+eq(n,67)+eq(n,68)+eq(n,115)',scale=320:-1,tile=5x1", '-frames:v', '1', frames]);
    const screenshot = await sharp(frames).metadata(); assert(screenshot.width && screenshot.height);
    results.push({ preset, width, height, frames: 116, bodyFrames: 96, introFrames: 20, fps: 24, seamFrame: 68,
      channels: 2, sampleRate: 48000, noBodyBlackFrames: true, tailAudioPresent: true, path: finalPath });
  }
  assert.equal(providerCalls, 0);
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ status: 'passed',
    inputs: videos.map(item => item.probe), outputs: results, providerCalls, source: 'synthetic_format_and_timing_markers' }, null, 2));
  console.log(`formula video formats: ${results.length} full-size presets, exact cuts, intro, stereo tail${longSubtitle ? ' and wrapped subtitles' : ''} passed`);
} finally {
  globalThis.fetch = originalFetch; db.close();
  (await import('../lib/db.ts')).closeDb();
  assert(fs.realpathSync(root).startsWith(path.join(fs.realpathSync(os.tmpdir()), 'formula-video-formats-')), '只清理本次临时目录');
  fs.rmSync(root, { recursive: true, force: true });
}
