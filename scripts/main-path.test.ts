// node scripts/main-path.test.ts
// 一条项目贯通上传、场景、分镜、脚本、视频、混剪、正式发布和 ZIP。
// AI 输出与浏览器绘制的文字图层用固定素材；路由、队列、数据库、媒体处理和发布用真实代码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { NextRequest } from 'next/server';
import type { ScriptOutputV3 } from '../lib/script-providers/types.ts';

// 在独立进程启动前固定数据根，避免静态导入把日志写到用户目录。
// 父进程负责总超时与清理，失败也不遗留 FFmpeg 子进程或测试数据库。
if (!process.argv.includes('--isolated-child')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-main-path-'));
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const name of ['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, { CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_EXPORT_ENCODER: 'cpu' });
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url), '--isolated-child'], {
    env, stdio: 'inherit', detached: process.platform !== 'win32',
  });
  const stop = () => {
    if (!child.pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const timer = setTimeout(() => { console.error('主流程检查超过 180 秒'); stop(); }, 180_000);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
    process.exitCode = code;
  } finally {
    clearTimeout(timer);
    stop();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  await checkMainPath();
}

async function checkMainPath() {
  const root = process.env.CREATIVE_STUDIO_DATA_ROOT!;
  assert.ok(path.basename(root).startsWith('creative-main-path-'));
  register('./typescript-extension-loader.mjs', import.meta.url);
  // Node 原生 TS 不解析 Next 的无后缀入口和目录 index；只为本测试补解析，不替换实现。
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
    if(s==='next/server') return n('next/server.js',c);
    try { return await n(s,c); } catch(e) {
      if(e.code!=='ERR_UNSUPPORTED_DIR_IMPORT') throw e;
      return n(s+'/index.ts',c);
    }
  }`)}`, import.meta.url);
  const sharp = (await import('sharp')).default;
  const { getDb, closeDb } = await import('../lib/db.ts');
  const { runFfmpeg, probeVideoMedia } = await import('../lib/ffmpeg.ts');
  const { runQueue } = await import('../lib/queue.ts');
  const { getVideoQueueStatus } = await import('../lib/video-queue.ts');
  const { registerTestVideoAdapter } = await import('../lib/video-providers/index.ts');
  const { generateAndPersistScriptV3 } = await import('../lib/script-generation-v3-service.ts');
  const { createFinalEditWorkspace } = await import('../lib/final-edit/workspace.ts');
  const { warmPreparePreview } = await import('../lib/final-edit/prepare-preview.ts');
  const { wakeFinalEditWorker, waitForFinalEditJobsIdle } = await import('../lib/final-edit/worker.ts');
  const storage = path.join(root, 'storage');
  const db = getDb();
  const fetchBefore = globalThis.fetch;
  const requests: string[] = [];
  let imageCalls = 0;
  let videoCalls = 0;
  const inputPng = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#446688' } }).png().toBuffer();
  const outputPng = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#cc8844' } }).png().toBuffer();
  const sourceVideo = path.join(root, 'provider-video.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=15', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', sourceVideo]);
  const videoBytes = fs.readFileSync(sourceVideo);
  // 拦截全部 fetch：只有这里声明的模拟响应可通过，未知地址立即失败，绝不转发到外网。
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url.pathname);
    assert.equal(url.origin, 'http://main-path.invalid', '检查不得调用真实服务');
    if (url.pathname === '/v1/images/edits') {
      const form = await request.formData();
      assert.equal(form.get('model'), 'fixture-image');
      assert.equal(form.getAll('image[]').length, imageCalls === 0 ? 1 : 2, '分镜生成必须带上场景参考图');
      imageCalls++;
      return Response.json({ data: [{ b64_json: outputPng.toString('base64') }] });
    }
    assert.equal(url.pathname, '/video.mp4', '未知模拟请求');
    return new Response(videoBytes, { headers: { 'content-type': 'video/mp4' } });
  };
  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (body: unknown) => new Request('http://localhost/api/fixture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as NextRequest;
  async function json(response: Response) {
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body));
    return body;
  }
  async function until(done: () => boolean, label: string) {
    const deadline = Date.now() + 60_000;
    while (!done()) {
      assert.ok(Date.now() < deadline, `${label}超时`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    db.prepare("INSERT INTO providers(id,name,type,baseUrl,apiKey,model) VALUES('fixture-image','模拟图片','openai-compatible','http://main-path.invalid','fixture-only','fixture-image')").run();
    db.prepare("INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,baseUrl,apiKey,defaultModel) VALUES('fixture-video','模拟视频','jimeng','','','','http://main-path.invalid','fixture-only','fixture-video')").run();
    const upload = await import('../app/api/upload/route.ts');
    async function uploadImage(name: string, usage: string, projectId?: string) {
      const form = new FormData();
      form.set('files', new File([new Uint8Array(inputPng)], name, { type: 'image/png' }));
      form.set('usage', usage);
      if (projectId) form.set('projectId', projectId);
      return (await json(await upload.POST(new Request('http://localhost/api/upload', { method: 'POST', body: form }) as NextRequest))).files[0].id as string;
    }
    const seedId = await uploadImage('场景底图.png', 'scene_seed');
    const projects = await import('../app/api/projects/route.ts');
    const project = await json(await projects.POST(request({
      storeCode: 'B店', productCode: 'SMOKE-01', productionType: 'AI种草', editorName: '自动检查',
      providerId: 'fixture-image', model: 'fixture-image', size: '1024x1024', maxAttempts: 1,
    })));
    const projectId: string = project.id;
    const shotInputId = await uploadImage('分镜原图.png', 'shot_source', projectId);
    console.log('通过：上传素材 → 建项目');
    const scenes = await import('../app/api/projects/[id]/scene-jobs/route.ts');
    const scene = await json(await scenes.POST(request({ sceneSeedImageId: seedId, scenePrompt: '模拟温馨客厅', generationCount: 1 }), context(projectId)));
    await runQueue({ projectId, concurrency: 1, maxAttempts: 1, timeoutMs: 5000 });
    const sceneJob = db.prepare('SELECT status,outputImageId FROM jobs WHERE id=?').get(scene.jobIds[0]) as { status: string; outputImageId: string };
    assert.equal(sceneJob.status, 'succeeded');
    const references = await import('../app/api/projects/[id]/scene-references/route.ts');
    const reference = await json(await references.POST(request({ name: '客厅', imageAssetId: sceneJob.outputImageId, sourceJobId: scene.jobIds[0] }), context(projectId)));
    const shotSets = await import('../app/api/projects/[id]/shot-sets/route.ts');
    const set = await json(await shotSets.POST(request({ name: '主流程分镜', shotImageIds: [shotInputId] }), context(projectId)));
    const applyScene = await import('../app/api/shot-sets/[id]/apply-scene/route.ts');
    await json(await applyScene.POST(request({ sceneReferenceId: reference.id, prompt: '保持产品，替换客厅' }), context(set.id)));
    await runQueue({ projectId, concurrency: 1, maxAttempts: 1, timeoutMs: 5000 });
    const shot = db.prepare('SELECT id,latestGeneratedImageId FROM shots WHERE shotSetId=?').get(set.id) as { id: string; latestGeneratedImageId: string };
    assert.ok(shot.latestGeneratedImageId);
    assert.notEqual(shot.latestGeneratedImageId, shotInputId);
    assert.equal(imageCalls, 2);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM shot_result_candidates WHERE shotId=?').get(shot.id) as { n: number }).n, 1);
    console.log('通过：场景生成 → 场景归库 → 分镜生成及候选记录');

    const narration = '舒适的沙发，让忙碌的一天慢下来。柔软的坐垫，稳稳承托身体，给家人留一个温暖的角落。';
    const bodySeconds = 15 - 20 / 24;
    const script: ScriptOutputV3 = {
      version: 3, title: '温暖客厅', coverTitleParts: { primary: '舒适客厅', secondary: '温暖陪伴', source: 'model' },
      platform: '小红书', tone: '温柔', templateId: 'scene_seeding', template: '场景种草', shotSetId: set.id,
      targetDurationSec: 15, targetNarrationDurationSec: bodySeconds, contentCharacterCount: narration.length,
      estimatedNarrationDurationSec: bodySeconds, durationStatus: 'qualified', durationPolicyVersion: 'zh-tts-budget-v1',
      segments: [{ id: 'seg-1', narration, subtitle: narration, sellingPointRefs: ['舒适'], visualIntent: '沙发全景', visualKeywords: ['沙发'] }],
      fullScript: narration, fullSubtitle: narration,
    };
    const generated = await generateAndPersistScriptV3({ projectId, project: { name: project.name }, body: {
      shotSetId: set.id, providerId: 'fixture-script', templateId: 'scene_seeding', targetDurationSec: 15,
      selectedSellingPoints: [{ title: '舒适', priority: 'highest', reason: '模拟卖点' }],
    } }, {
      db, storageRoot: storage,
      providerMeta: () => ({ id: 'fixture-script', name: '模拟脚本', model: 'fixture', configured: true, apiStyle: 'openai-compatible', supportsVision: true, executionScope: 'external' }),
      completeJson: async () => { throw new Error('脚本模型应由固定输出替代'); },
      generate: async input => {
        assert.equal(input.visuals[0].imageAssetId, shot.latestGeneratedImageId, '脚本必须看到刚生成的分镜');
        return { script, attempts: 1 };
      },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const draftId = String(generated.body.draftId);
    console.log('通过：读取分镜 → 脚本保存');
    registerTestVideoAdapter('jimeng', {
      submit: async input => {
        const source = db.prepare('SELECT path FROM image_assets WHERE id=?').get(shot.latestGeneratedImageId) as { path: string };
        assert.equal(input.sourceImagePath, source.path, '视频首帧必须来自生成后的分镜');
        videoCalls++;
        return { providerTaskId: 'fixture-remote-video', rawResponse: {} };
      },
      poll: async () => ({ status: 'succeeded', videoUrl: 'http://main-path.invalid/video.mp4', rawResponse: {} }),
    });
    const videos = await import('../app/api/shot-sets/[id]/video-jobs/route.ts');
    const video = await json(await videos.POST(request({ shotId: shot.id, providerId: 'fixture-video', prompt: '缓慢推进', durationSec: 15 }), context(set.id)));
    await until(() => getVideoQueueStatus(projectId) === 'idle', '视频队列');
    const videoRow = db.prepare('SELECT status,errorMessage,localVideoPath FROM video_jobs WHERE id=?').get(video.videoJobId) as { status: string; errorMessage: string; localVideoPath: string };
    assert.equal(videoRow.status, 'succeeded', videoRow.errorMessage);
    assert.equal(videoCalls, 1);
    assert.ok((await probeVideoMedia(videoRow.localVideoPath)).durationUs >= 15_000_000);
    console.log('通过：视频提交 → 轮询 → 下载 → 可解码文件');

    const workspace = createFinalEditWorkspace({
      db, storageRoot: storage, runJobsInline: true,
      probeVideo: ({ filePath }) => probeVideoMedia(filePath),
      analyzeVideo: async ({ videoJobId }) => {
        assert.equal(videoJobId, video.videoJobId);
        return { summary: '沙发全景', sellingPoints: ['舒适'], semanticTags: ['沙发'], usableRanges: [{ startUs: 0, endUs: 15_000_000, qualityScore: 1 }], qualityIssues: [], coverFrameTimesUs: [1_000_000] };
      },
      scoreSemanticMatrix: async ({ userPrompt }) => {
        const dimensions = /必须是 (\d+) 行、每行 (\d+) 列/.exec(userPrompt);
        assert.ok(dimensions, '模拟评分需要明确的句段与素材数量');
        return { score_matrix: Array.from({ length: Number(dimensions[1]) }, () => Array(Number(dimensions[2])).fill(0.95)), hook_scores: Array(Number(dimensions[2])).fill(0.9) };
      },
      synthesize: async ({ segments }) => {
        assert.equal(segments.map(s => s.narration).join(''), narration, '配音必须使用已保存脚本');
        const relativePath = 'fixture-narration.wav';
        await runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${bodySeconds}`, '-c:a', 'pcm_s16le', '-y', path.join(storage, relativePath)]);
        return { relativePath, durationUs: Math.round(bodySeconds * 1e6),
          segmentTimings: segments.map((s, i) => ({ segmentId: s.segmentId, startUs: Math.round(i * bodySeconds * 1e6 / segments.length), endUs: Math.round((i + 1) * bodySeconds * 1e6 / segments.length) })),
          wordTimings: segments.map((s, i) => ({ text: s.narration, startUs: Math.round(i * bodySeconds * 1e6 / segments.length), endUs: Math.round((i + 1) * bodySeconds * 1e6 / segments.length) })), alignmentDegradedSegmentIds: [] };
      },
      warmPreview: input => warmPreparePreview({ ...input, storageRoot: storage }),
    });
    const prepared = await workspace.start({ projectId, shotSetId: set.id, scriptDraftId: draftId, count: 1, outputPreset: '3x4', providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1, analysisProviderId: 'fixture-vision' });
    let group = workspace.load(prepared.groupId);
    // 选择基础成片导出；浏览器驱动的装饰模板包装另有专项验收。
    workspace.apply({ scope: 'group', groupId: group.id, expectedRevision: group.revision, type: 'set_packaging_config', config: { ...group.packaging, enabled: false } });
    group = workspace.load(prepared.groupId);
    assert.equal(group.variants.length, 1);
    const variant = group.variants[0];
    assert.ok(variant.timeline.clips.length > 0);
    assert.ok(variant.timeline.clips.every(c => c.videoJobId === video.videoJobId));
    assert.ok(group.subtitleCues.length > 0);
    assert.deepEqual(variant.issues.filter(i => i.severity === 'blocking'), [], JSON.stringify(variant.timeline));
    assert.ok(variant.previewUrl, '准备阶段必须生成真实预览');
    const previewPath = decodeURIComponent(variant.previewUrl.replace('/api/videos/', ''));
    assert.equal((await probeVideoMedia(path.join(storage, previewPath))).hasAudio, true);
    console.log('通过：视频分析 + 模拟配音 → 字幕/时间线 → 真实预览');

    // 浏览器文字排版不在这条 Node 检查内；固定透明图层仍走真实上传校验和登记接口。
    const overlay = (await sharp({ create: { width: 1080, height: 1440, channels: 4, background: '#00000000' } }).png().toBuffer()).toString('base64');
    const overlays = await import('../app/api/final-edit-groups/[id]/overlay-bundles/[preset]/route.ts');
    const bundle = await json(await overlays.POST(request({ groupRevision: group.revision, titlePngBase64: overlay,
      subtitlePngs: Object.fromEntries(group.subtitleCues.map(c => [c.id, overlay])),
      manifest: { width: 1080, height: 1440, overflow: false, cues: group.subtitleCues,
        measurements: { titlePrimaryWidth: 0, titleSecondaryWidth: 0, titleCompositeWidth: 0, subtitleWidths: Object.fromEntries(group.subtitleCues.map(c => [c.id, 0])) } },
    }), { params: Promise.resolve({ id: group.id, preset: '3x4' }) }));
    const render = await workspace.enqueueRender({ groupId: group.id, variantId: variant.id, expectedGroupRevision: group.revision, expectedVariantRevision: variant.revision, overlayBundleId: bundle.id });
    wakeFinalEditWorker();
    const renderRow = () => db.prepare('SELECT status,errorMessage,outputJson FROM final_edit_jobs WHERE id=?').get(render.id) as { status: string; errorMessage: string; outputJson: string };
    await until(() => ['succeeded', 'failed'].includes(renderRow().status), '渲染发布');
    assert.equal(renderRow().status, 'succeeded', renderRow().errorMessage);
    const output = JSON.parse(renderRow().outputJson);
    const finalPath = path.join(storage, output.publishedVideoRelativePath);
    const media = await probeVideoMedia(finalPath);
    assert.ok(Math.abs(media.durationUs / 1e6 - 15) < 0.1);
    assert.equal(media.hasAudio, true);
    assert.equal(media.width, 1080);
    assert.equal(media.height, 1440);
    const artifacts = db.prepare('SELECT kind,relativePath FROM project_artifacts WHERE projectId=?').all(projectId) as Array<{ kind: string; relativePath: string }>;
    assert.deepEqual(artifacts.map(a => a.kind).sort(), ['final_cover', 'final_video']);
    for (const artifact of artifacts) assert.ok(fs.statSync(path.join(storage, artifact.relativePath)).size > 0);
    // 不只检查存在音轨：逐个字幕时间窗抽取 PCM，确认对应位置确实有声音。
    const pcmPath = path.join(root, 'final.pcm');
    await runFfmpeg(['-i', finalPath, '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-f', 's16le', '-ac', '1', '-ar', '8000', '-y', pcmPath]);
    const pcm = fs.readFileSync(pcmPath);
    for (const cue of group.subtitleCues) {
      const from = Math.ceil((20 / 24 + cue.startUs / 1e6 + 0.05) * 8000);
      const to = Math.min(pcm.length / 2, Math.floor((20 / 24 + cue.endUs / 1e6 - 0.05) * 8000));
      let sum = 0;
      for (let i = from; i < to; i++) sum += pcm.readInt16LE(i * 2) ** 2;
      assert.ok(to > from && Math.sqrt(sum / (to - from)) > 100, `字幕 ${cue.id} 对应音轨不应静音`);
    }
    console.log('通过：正式渲染 → 视频/封面发布 → 成片时长、尺寸及每段音轨');
    const creativePackage = await import('../app/api/projects/[id]/creative-package/route.ts');
    const zipped = await creativePackage.GET(request({}), context(projectId));
    assert.equal(zipped.status, 200);
    assert.match(zipped.headers.get('content-type')!, /application\/zip/);
    // 用独立解压器验证 CRC 和文件内容，避免只检查 ZIP 头。
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await zipped.arrayBuffer(), { checkCRC32: true });
    const files = Object.values(zip.files).filter(f => !f.dir);
    const scriptEntry = files.find(f => f.name.endsWith('latest-script.json'));
    assert.ok(scriptEntry, '导出包应包含已保存的脚本');
    assert.equal(JSON.parse(await scriptEntry.async('string')).fullScript, narration);
    const imageEntry = files.find(f => f.name.endsWith('/images/shot-01.png'));
    assert.ok(imageEntry, '导出包应包含生成后的分镜');
    const generatedImage = db.prepare('SELECT path FROM image_assets WHERE id=?').get(shot.latestGeneratedImageId) as { path: string };
    assert.deepEqual(await imageEntry.async('nodebuffer'), fs.readFileSync(generatedImage.path));
    for (const artifact of artifacts) {
      const expected = fs.readFileSync(path.join(storage, artifact.relativePath));
      const matching = files.filter(f => f.name.endsWith(path.basename(artifact.relativePath)));
      assert.equal(matching.length, 1, `导出包应包含 ${artifact.kind}`);
      assert.deepEqual(await matching[0].async('nodebuffer'), expected);
    }
    assert.ok(files.filter(f => /\.mp4$/.test(f.name)).length >= 2, '原视频与成片都应进入创意包');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.ok(requests.includes('/video.mp4'));
    await waitForFinalEditJobsIdle(5000);
    console.log('主流程检查通过：同一项目从上传到创意 ZIP，真实付费调用 0 次。');
  } finally {
    globalThis.fetch = fetchBefore;
    closeDb();
  }
}
