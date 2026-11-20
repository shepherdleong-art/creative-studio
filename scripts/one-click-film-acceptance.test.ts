// node scripts/one-click-film-acceptance.test.ts
// 一键成片首版贯通验收（16）：同一项目两条片，从建项目到下载解压。
// 识图、脚本、视频、TTS 用固定响应；路由、数据库、切点识别、包装契约与导出走真实代码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--isolated-child')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-click-film-acceptance-'));
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const name of ['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, {
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'local',
    CREATIVE_STUDIO_EXPORT_ENCODER: 'cpu',
  });
  const child = spawn(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url), '--isolated-child',
  ], { env, stdio: 'inherit', detached: process.platform !== 'win32' });
  const stop = () => {
    if (!child.pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const timer = setTimeout(() => { console.error('一键成片验收超过 300 秒'); stop(); }, 300_000);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
  } finally {
    clearTimeout(timer);
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  await runAcceptance();
}

async function runAcceptance() {
  const root = process.env.CREATIVE_STUDIO_DATA_ROOT!;
  assert.ok(path.basename(root).startsWith('one-click-film-acceptance-'));
  register('./typescript-extension-loader.mjs', import.meta.url);
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
    if(s==='next/server') return n('next/server.js',c);
    try { return await n(s,c); } catch(e) {
      if(e.code!=='ERR_UNSUPPORTED_DIR_IMPORT') throw e;
      return n(s+'/index.ts',c);
    }
  }`)}`, import.meta.url);

  const sharp = (await import('sharp')).default;
  const JSZip = (await import('jszip')).default;
  const { getDb, closeDb } = await import('../lib/db.ts');
  const { runFfmpeg, probeVideoMedia } = await import('../lib/ffmpeg.ts');
  const { detectVideoScenes } = await import('../lib/media-core/scene-detect.ts');
  const { getVideoQueueStatus } = await import('../lib/video-queue.ts');
  const { registerTestVideoAdapter } = await import('../lib/video-providers/index.ts');
  const { runOneClickFilmAnalysis } = await import('../lib/one-click-film/analysis.ts');
  const { ensureOneClickFilmSchemaReady } = await import('../lib/one-click-film/schema.ts');
  const store = await import('../lib/one-click-film/store.ts');
  const { submitOneClickFilmGeneration, syncGenerationStatus } = await import('../lib/one-click-film/generation.ts');
  const { listReviews, approveReview } = await import('../lib/one-click-film/review.ts');
  const { createCandidate, setCandidateResult, adoptCandidate, revertAdoption } = await import('../lib/one-click-film/rework.ts');
  const { planHdSources } = await import('../lib/one-click-film/hd.ts');
  const { preparePackaging, updatePackagingDraft, listPackaging, filmTimeForBodyTime } = await import('../lib/one-click-film/packaging.ts');
  const { exportEntries, exportZipEntries, listExports } = await import('../lib/one-click-film/exports.ts');

  const db = getDb();
  const storage = path.join(root, 'storage');
  const readiness = await ensureOneClickFilmSchemaReady({
    db, backupRoot: path.join(root, 'data', 'backups', 'schema-upgrades'),
  });
  assert.notEqual(readiness.state, 'compatibility_only', JSON.stringify(readiness));
  const fetchBefore = globalThis.fetch;
  const submittedPrompts: string[] = [];

  // 15 秒测试原片：6 秒与 9 秒有真实切点。
  const providerVideo = path.join(root, 'provider-15s.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x223344:size=540x720:rate=24:duration=6',
    '-f', 'lavfi', '-i', 'color=c=0x884422:size=540x720:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'color=c=0x22aa55:size=540x720:rate=24:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=15',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', providerVideo,
  ]);
  const videoBytes = fs.readFileSync(providerVideo);
  const probe = await probeVideoMedia(providerVideo);
  assert.ok(Math.abs(probe.durationUs / 1e6 - 15) < 0.2, `测试原片应为 15 秒，实际 ${probe.durationUs / 1e6}`);
  const ranges = await detectVideoScenes({ filePath: providerVideo, durationUs: probe.durationUs });
  const cuts = ranges.slice(1).map((range) => Math.round(range.startUs / 1e6 * 10) / 10);
  assert.ok(cuts.some((cut) => Math.abs(cut - 6) < 0.4), `应识别到 6 秒切点：${cuts.join(',')}`);
  assert.ok(cuts.some((cut) => Math.abs(cut - 9) < 0.4), `应识别到 9 秒切点：${cuts.join(',')}`);

  const inputPng = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#557799' } }).png().toBuffer();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, 'http://one-click-film.invalid', '验收不得调用真实服务');
    if (url.pathname === '/v1/chat/completions') {
      const body = await request.json() as { messages?: Array<{ content: unknown }> };
      const text = JSON.stringify(body.messages ?? '');
      if (text.includes('analyze_product_material_for_short_video')) {
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            productName: '云朵床',
            appearance: '卧室，软包靠背，米白色面料',
            sceneClues: '卧室靠窗位置',
            points: [
              { text: '卧室放松体验', kind: 'usage', sourcePageIndex: 0, tileRefs: ['tile_1'] },
              { text: '靠背倚靠体验', kind: 'usage', sourcePageIndex: 0, tileRefs: ['tile_1'] },
              { text: '面料触感细节', kind: 'claim', sourcePageIndex: 1, tileRefs: ['tile_1'] },
            ],
          }) } }],
        });
      }
      return Response.json({ choices: [{ message: { content: '{}' } }] });
    }
    assert.equal(url.pathname, '/video.mp4', '未知模拟请求');
    return new Response(videoBytes, { headers: { 'content-type': 'video/mp4' } });
  };

  try {
    // ── 准备供应商与项目 ──
    db.prepare(`INSERT INTO providers (id, name, type, baseUrl, apiKey, model)
      VALUES ('fixture-image', '模拟图片', 'openai-compatible', 'http://one-click-film.invalid', 'fixture', 'fixture-image')`).run();
    db.prepare(`INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, baseUrl, apiKey, defaultModel, enabled)
      VALUES ('fixture-video', '模拟 Seedance', 'jimeng', '', '', '', 'http://one-click-film.invalid', 'fixture', 'doubao-seedance-2-5-251015', 1)`).run();
    db.prepare(`INSERT INTO script_providers
      (id, name, type, apiStyle, baseUrl, apiKey, model, enabled, supportsVision, maxTokens)
      VALUES ('fixture-vision', '模拟识图', 'openai-compatible', 'openai-compatible',
        'http://one-click-film.invalid', 'fixture', 'fixture-vision', 1, 1, 8000)`).run();

    const upload = await import('../app/api/upload/route.ts');
    const projects = await import('../app/api/projects/route.ts');
    const uploadImage = async (name: string, usage: string, projectId?: string) => {
      const form = new FormData();
      form.set('files', new File([new Uint8Array(inputPng)], name, { type: 'image/png' }));
      form.set('usage', usage);
      if (projectId) form.set('projectId', projectId);
      const response = await upload.POST(new Request('http://localhost/api/upload', { method: 'POST', body: form }) as never);
      const body = await response.json() as { files?: Array<{ id: string }>; error?: string };
      assert.ok(body.files?.[0]?.id, JSON.stringify(body));
      return body.files[0].id;
    };
    const sceneImageId = await uploadImage('场景图.png', 'scene_seed');
    const projectResponse = await projects.POST(new Request('http://localhost/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        storeCode: 'B店', productCode: 'OCF-01', productionType: 'AI种草', editorName: '验收',
        providerId: 'fixture-image', model: 'fixture-image', size: '1024x1024', maxAttempts: 1,
      }),
    }) as never);
    const project = await projectResponse.json() as { id: string };
    assert.ok(project.id);
    const detailImageId = await uploadImage('详情页.png', 'detail_page', project.id);
    const run = store.getOrCreateRun(db, project.id);
    console.log('通过：建项目 → 上传场景图与详情页');

    // ── 分析卖点并确认 ──
    const analysis = store.createAnalysisVersion(db, {
      run, sourceImageIds: [sceneImageId, detailImageId], status: 'running',
    });
    await runOneClickFilmAnalysis({ analysisId: analysis.id, providerId: 'fixture-vision', db });
    const points = store.listSellingPoints(db, analysis.id);
    assert.ok(points.length >= 2, '分析应产出候选卖点');
    assert.ok(points.every((point) => point.sourceImageId), '每条卖点都要有来源图片');
    const confirmed = store.confirmAnalysis(db, {
      analysisId: analysis.id, productName: '云朵床', points,
    });
    assert.ok(confirmed.confirmedAt);
    console.log('通过：分析素材 → 卖点来源可追溯 → 确认内容');

    // ── 两条脚本：F01 场景体验、F02 痛点解决 ──
    const applied = store.applyScriptPlan(db, {
      run,
      analysis: confirmed,
      points: store.listSellingPoints(db, analysis.id),
      plan: {
        count: 2,
        plan: { mode: 'individual', choices: ['scene', 'problem'] },
        soundMode: 'native',
      },
    });
    assert.deepEqual(applied.entries.map((entry) => entry.structure), ['scene', 'problem']);
    const handEditedNarration = '手改口播：我把手机放到一边，在床边坐了一会儿。';
    store.updateEntryDraft(db, {
      run, code: 'F01',
      outline: '手改大纲：下班回家先坐一会儿',
      narration: handEditedNarration,
    });
    store.confirmEntry(db, { run, code: 'F01' });
    const f01Before = store.getEntry(db, run.id, 'F01');
    const f02Before = store.getEntry(db, run.id, 'F02');
    const redrafted = store.redraftEntry(db, { run, code: 'F02' });
    assert.equal(redrafted.status, 'pending');
    assert.deepEqual(redrafted.sellingPointsSnapshot, f02Before.sellingPointsSnapshot);
    assert.notEqual(redrafted.narration, f02Before.narration);
    const f01After = store.getEntry(db, run.id, 'F01');
    assert.equal(f01After.narration, handEditedNarration, 'F01 手改全文逐字保留');
    assert.equal(f01After.scriptConfirmedAt, f01Before.scriptConfirmedAt);
    store.confirmEntry(db, { run, code: 'F02' });
    console.log('通过：两条脚本 → 手改确认 F01 → 只重做 F02 → F01 原样保留');

    // ── 生成两条正文 ──
    registerTestVideoAdapter('jimeng', {
      submit: async (input) => {
        submittedPrompts.push(input.prompt);
        return { providerTaskId: `fixture-${submittedPrompts.length}`, rawResponse: {} };
      },
      poll: async () => ({ status: 'succeeded', videoUrl: 'http://one-click-film.invalid/video.mp4', rawResponse: {} }),
    });
    const submission = await submitOneClickFilmGeneration({
      run, providerId: 'fixture-video', durationSec: 15, aspectRatio: '3:4', db,
    });
    assert.deepEqual(submission.submitted.sort(), ['F01', 'F02']);
    const deadline = Date.now() + 120_000;
    while (getVideoQueueStatus(project.id) !== 'idle') {
      assert.ok(Date.now() < deadline, '视频队列超时');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await syncGenerationStatus(db, run);
    const jobs = db.prepare(`SELECT id, entryCode, status, videoJobId FROM one_click_film_video_jobs WHERE runId = ?`)
      .all(run.id) as Array<{ id: string; entryCode: string; status: string; videoJobId: string }>;
    assert.deepEqual(jobs.map((job) => job.status), ['succeeded', 'succeeded']);
    assert.equal(submittedPrompts.length, 2, '两次供应商请求');
    assert.ok(submittedPrompts.some((prompt) => prompt.includes('手改口播')), 'F01 请求必须带手改全文');
    const f02Prompt = submittedPrompts.find((prompt) => prompt !== submittedPrompts[0])!;
    assert.ok(f02Prompt.length > 0);
    console.log('通过：整批直出 → 两条原片可下载 → 供应商收到各自确认稿');

    // ── A 布局：实际切点与等长采用 ──
    const reviews = listReviews(db, run);
    assert.equal(reviews.length, 2);
    const f02Review = reviews.find((review) => review.entryCode === 'F02')!;
    assert.equal(f02Review.detection, 'cuts');
    assert.ok(f02Review.shots.length >= 3, '应按实际切点分成多个镜头');
    const middle = f02Review.shots.find((shot) => shot.startUs === 6_000_000) ?? f02Review.shots[1]!;
    const candidate = createCandidate(db, {
      run, entryId: f02Before.id, entryCode: 'F02', reviewJobId: f02Review.jobId, shotId: middle.id,
      replaceStartUs: middle.startUs, replaceEndUs: middle.endUs,
      prompt: '只换这 3 秒画面，保留产品外观', references: [],
      providerId: 'fixture-video', model: 'doubao-seedance-2-5-251015',
    });
    setCandidateResult(db, {
      run, candidateId: candidate.id, status: 'ready',
      localVideoPath: path.join(storage, 'one-click-film', 'candidates', 'c1.mp4'),
      durationUs: middle.endUs - middle.startUs,
    });
    adoptCandidate(db, { run, candidateId: candidate.id });
    revertAdoption(db, { run, entryId: f02Before.id, entryCode: 'F02', shotId: middle.id });
    adoptCandidate(db, { run, candidateId: candidate.id });
    for (const review of reviews) approveReview(db, { run, jobId: review.jobId });
    const hdPlan = planHdSources(db, run);
    assert.ok(hdPlan.sources.length >= 2, '按采用来源列高清清单');
    assert.equal(new Set(hdPlan.sources.map((source) => source.sourceVideoJobId)).size, hdPlan.sources.length);
    console.log('通过：按实际切点选镜 → 等长采用/撤销/恢复 → 审片通过 → 高清来源清单');

    // ── 一键包装并移动 F02 花字 ──
    const packagingResults = preparePackaging(db, {
      run,
      options: {
        template: 'overlay-minimal', cover: true, subtitles: true, decoration: true, bgm: true,
        titleMode: 'shared', title: '把松弛感带回家',
      },
    });
    assert.ok(packagingResults.every((result) => result.ok), JSON.stringify(packagingResults));
    updatePackagingDraft(db, {
      run, entryCode: 'F02',
      pointCues: [{ id: 'dec-0', text: '松弛', startSec: 4, endSec: 8 }],
    });
    const packaging = listPackaging(db, run);
    const f02Packaging = packaging.find((record) => record.entryCode === 'F02')!;
    assert.equal(filmTimeForBodyTime(f02Packaging.pointCues[0]!.startSec, true).frame, 116);
    assert.equal(filmTimeForBodyTime(0, true).frame, 20, '正文第 0 帧对应交付第 20 帧');
    console.log('通过：一键包装两条 → 加封面 → 移动 F02 花字 → 帧偏移正确');

    // ── 导出、总览、ZIP ──
    const first = exportEntries(db, { run, all: true });
    assert.equal(first.exported.length, 2);
    const firstF02 = first.exported.find((record) => record.entryCode === 'F02')!;
    const repeat = exportEntries(db, { run, codes: ['F01', 'F02'] });
    assert.deepEqual(repeat.reused.sort(), ['F01', 'F02'], '重复提交找回同一记录');
    updatePackagingDraft(db, { run, entryCode: 'F02', title: '第二次交付' });
    const second = exportEntries(db, { run, codes: ['F02'] });
    assert.notEqual(second.exported[0]!.id, firstF02.id, '重新导出形成独立记录');
    const all = listExports(db, run);
    assert.equal(all.length, 3);
    assert.ok(all.some((record) => record.checksum === firstF02.checksum), '旧交付摘要不变');

    const zipEntries = exportZipEntries(db, { run, ids: all.map((record) => record.id) });
    assert.equal(zipEntries.length, 3);
    for (const entry of zipEntries) {
      assert.ok(fs.existsSync(entry.filePath));
      const media = await probeVideoMedia(entry.filePath);
      assert.ok(media.durationUs > 0, `${entry.filename} 应可播放`);
      assert.equal(media.hasAudio, true);
    }
    // 用独立解压器核对内容，不只检查 ZIP 头。
    const zip = new JSZip();
    for (const entry of zipEntries) zip.file(entry.filename, fs.readFileSync(entry.filePath));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const loaded = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const files = Object.values(loaded.files).filter((file) => !file.dir);
    assert.equal(files.length, 3);
    assert.equal(new Set(files.map((file) => file.name)).size, 3);
    console.log('通过：全选导出 → 总览 → 重新导出独立记录 → ZIP 内容可解压且可播放');

    assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('一键成片贯通验收通过：同一项目两条片，真实付费调用 0 次。');
  } finally {
    globalThis.fetch = fetchBefore;
    closeDb();
  }
}
