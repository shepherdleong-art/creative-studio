import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from '@playwright/test';

const mixcutCss = fs.readFileSync('components/mixcut/MixcutPanel.module.css', 'utf8');
const editorCss = fs.readFileSync('components/final-edit/FinalEditEditor.module.css', 'utf8');

const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function textStyle(fontSizePx, y) {
  return {
    fontFamily: 'Arial',
    fontSizePx,
    italic: false,
    x: 0.5,
    y,
    scale: 1,
    color: '#ffffff',
    align: 'center',
    boxWidthPx: 800,
    lineHeight: 1.2,
    stroke: { enabled: true, color: '#000000', widthPx: 2 },
    shadow: { enabled: false, color: '#000000', opacity: 0.4, blurPx: 4, distancePx: 2, angleDeg: 90 },
  };
}

function createFormalGroup() {
  const styles = {
    coverPrimary: textStyle(72, 0.35),
    coverSecondary: textStyle(44, 0.48),
    subtitle: textStyle(48, 0.84),
  };
  return {
    id: 'group-e2e',
    projectId: 'e2e-project',
    scriptDraftId: 'draft-e2e',
    shotSetId: 'shot-set-e2e',
    status: 'ready',
    phase: 'ready',
    revision: 4,
    script: {
      sourceDraftId: 'draft-e2e',
      title: 'E2E 文案',
      importedNarrationText: '第一句。第二句。',
      editedNarrationText: '第一句。第二句。',
      syncState: 'synced',
      sourceScriptUpdatedAt: '2026-07-24T00:00:00.000Z',
      narrationConfig: { providerId: 'tts-e2e', voice: 'voice-e2e', speed: 1 },
      selectedMaterialKeys: ['module4:video-a', 'module4:video-b'],
    },
    narrationDurationUs: 10_000_000,
    totalDurationUs: 10_833_333,
    coverTitle: {
      primary: { id: 'primary', text: '正式页面测试', textSource: 'script' },
      secondary: { id: 'secondary', text: 'Mixcut Phase 4', textSource: 'script' },
    },
    subtitleCues: [
      { id: 'cue-a', segmentId: 'segment-a', text: '第一句', startUs: 0, endUs: 5_000_000, textSource: 'script', timingSource: 'aligned' },
      { id: 'cue-b', segmentId: 'segment-b', text: '第二句', startUs: 5_000_000, endUs: 10_000_000, textSource: 'script', timingSource: 'aligned' },
    ],
    textStyles: { '3x4': structuredClone(styles), '9x16': structuredClone(styles), '16x9': structuredClone(styles) },
    variants: [{
      id: 'variant-e2e',
      indexNum: 1,
      outputPreset: '3x4',
      timeline: {
        fps: 24,
        introFrames: 20,
        bodyFrames: 240,
        clips: [
          { id: 'clip-a', videoJobId: 'video-a', sourceFingerprint: 'fingerprint-a', sourceInFrame: 0, sourceOutFrame: 120, timelineInFrame: 0, timelineOutFrame: 120, boundSegmentId: 'segment-a', framing: { scale: 1, offsetX: 0, offsetY: 0 }, manualUseOverride: false },
          { id: 'clip-b', videoJobId: 'video-b', sourceFingerprint: 'fingerprint-b', sourceInFrame: 0, sourceOutFrame: 120, timelineInFrame: 120, timelineOutFrame: 240, boundSegmentId: 'segment-b', framing: { scale: 1, offsetX: 0, offsetY: 0 }, manualUseOverride: false },
        ],
      },
      bgm: { trackId: null, gainDb: -12, loop: true, fadeInSec: 0.5, fadeOutSec: 0.8 },
      cover: { coverKey: 'video:video-a:1000000', kind: 'video_keyframe', sourceKey: 'module4:video-a', frameTimeUs: 1_000_000, sourceUrl: '/api/final-edit-groups/group-e2e/cover-frame?sourceKey=module4%3Avideo-a&timeUs=1000000&preset=3x4', framing: { scale: 1, offsetX: 0, offsetY: 0 } },
      issues: [],
      maxOverlap: 1,
      revision: 7,
      lastRenderedRevision: null,
      renderStatus: null,
      previewUrl: null,
    }],
    assets: [
      { assetKey: 'module4:video-a', source: 'module4', videoJobId: 'video-a', shotSetId: 'shot-set-e2e', shotId: 'shot-a', filename: 'a.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 5_000_000, fingerprint: 'fingerprint-a', analysisStatus: 'succeeded', summary: '素材 A', autoUseDisabled: false, usageCount: 1 },
      { assetKey: 'module4:video-b', source: 'module4', videoJobId: 'video-b', shotSetId: 'shot-set-e2e', shotId: 'shot-b', filename: 'b.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 5_000_000, fingerprint: 'fingerprint-b', analysisStatus: 'succeeded', summary: '素材 B', autoUseDisabled: false, usageCount: 1 },
    ],
    bgmTracks: [{ id: 'bgm-e2e', relativePath: 'bgm/e2e.mp3', durationUs: 20_000_000 }],
    coverCandidates: [{ coverKey: 'cover-e2e', sourceUrl: transparentPixel, kind: 'storyboard_image' }],
    jobs: [{ id: 'job-e2e', variantId: null, kind: 'prepare', status: 'succeeded', phase: 'ready', progress: 1, estimatedCost: null, costCurrency: 'CNY', errorCode: null, errorMessage: null, startedAt: '2026-07-24T00:00:00.000Z', finishedAt: '2026-07-24T00:00:10.000Z', createdAt: '2026-07-24T00:00:00.000Z' }],
  };
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startNextDevServer() {
  const port = await getFreePort();
  const nextBin = path.resolve('node_modules/next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next dev server exited with ${child.exitCode}:\n${output}`);
    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });
      if (response.status < 500) return { child, baseUrl, output: () => output };
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`Next dev server did not become ready:\n${output}`);
}

async function stopNextDevServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function expectEventually(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError) throw lastError;
  assert.fail(message);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const fixture of [
    { width: 1600, presetClass: 'preview34', ratio: 3 / 4 },
    { width: 1600, presetClass: 'preview916', ratio: 9 / 16 },
    { width: 1024, presetClass: 'preview34', ratio: 3 / 4 },
    { width: 1024, presetClass: 'preview916', ratio: 9 / 16 },
  ]) {
    const page = await browser.newPage({ viewport: { width: fixture.width, height: 1000 }, deviceScaleFactor: 1 });
    await page.setContent(`
      <style>
        *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:auto}button{border:0;background:transparent}
        ${mixcutCss}
        ${editorCss}
      </style>
      <section class="previewStep" data-output-preset="fixture">
        <header class="previewStepHeader"><div><p class="eyebrow">STEP 03</p><h1>预览并调整完整时间轴</h1></div></header>
        <div class="previewEditorGrid">
          <div class="previewPlayerCell">
            <main class="previewColumn" aria-label="成片预览">
              <div class="previewToolbar"><span>24 fps</span><span>成片时间线</span></div>
              <div class="previewStageWrap"><div class="previewStage ${fixture.presetClass}" data-testid="stage"><canvas class="previewCanvas"></canvas></div></div>
              <div class="playbackBar" data-testid="controls"><button class="playButton">▶</button><span class="timecode">00:00 / 00:15</span><input type="range"></div>
            </main>
          </div>
          <aside class="previewPropertyPanel"><div class="previewPropertyTabs"><strong>当前编辑</strong></div><div class="previewPropertyScroll"><section class="previewPropertyCard"><h2>字幕</h2></section></div></aside>
        </div>
        <section class="mixcutTimeline" data-testid="timeline">
          <div class="timelineToolbar"><div><strong>精细时间轴</strong></div><label class="zoomControl"><span>缩放</span><input type="range"></label></div>
          <div class="timelineScroll" data-testid="scroll">
            <div class="timelineCanvas" data-testid="canvas" style="width:2488px">
              <div class="timelineLabels" data-testid="labels"><div class="timelineRulerLabel">轨道</div><div class="timelineLabel">视频</div><div class="timelineLabel">字幕</div><div class="timelineLabel">口播</div><div class="timelineLabel">BGM</div></div>
              <div class="timelineContent" style="width:2400px"><div class="timelineRuler"></div><div class="timelineTrack"></div><div class="timelineTrack"></div><div class="timelineTrack"></div><div class="timelineTrack"></div></div>
            </div>
          </div>
        </section>
      </section>
    `);

    const boxes = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const stage = rect('[data-testid=stage]');
      const controls = rect('[data-testid=controls]');
      const timeline = rect('[data-testid=timeline]');
      const scroll = document.querySelector('[data-testid=scroll]');
      const labels = document.querySelector('[data-testid=labels]');
      const labelBefore = labels.getBoundingClientRect().left;
      scroll.scrollLeft = 900;
      scroll.scrollTop = 40;
      const labelAfter = labels.getBoundingClientRect().left;
      return {
        stage: { width: stage.width, height: stage.height, bottom: stage.bottom },
        controls: { top: controls.top, bottom: controls.bottom },
        timeline: { top: timeline.top },
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth,
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        labelBefore,
        labelAfter,
        trackLabels: [...labels.querySelectorAll('.timelineLabel')].map((element) => element.textContent),
      };
    });

    assert.ok(Math.abs(boxes.stage.width / boxes.stage.height - fixture.ratio) < 0.02, `${fixture.presetClass}/${fixture.width}: 播放器必须保持画幅`);
    assert.ok(boxes.stage.bottom <= boxes.controls.top + 0.5, `${fixture.presetClass}/${fixture.width}: 视频不能覆盖控制条`);
    assert.ok(boxes.controls.bottom <= boxes.timeline.top + 0.5, `${fixture.presetClass}/${fixture.width}: 播放器不能覆盖时间轴`);
    assert.ok(boxes.scrollWidth > boxes.clientWidth, `${fixture.presetClass}/${fixture.width}: 时间轴必须可以横向滚动`);
    assert.ok(boxes.scrollHeight > boxes.clientHeight, `${fixture.presetClass}/${fixture.width}: 轨道区必须可以纵向滚动`);
    assert.ok(Math.abs(boxes.labelBefore - boxes.labelAfter) < 0.5, `${fixture.presetClass}/${fixture.width}: 轨道标签必须 sticky`);
    assert.deepEqual(boxes.trackLabels, ['视频', '字幕', '口播', 'BGM']);

    const zoom = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid=canvas]');
      const scroll = document.querySelector('[data-testid=scroll]');
      const before = canvas.getBoundingClientRect().width;
      canvas.style.width = '4888px';
      canvas.querySelector('.timelineContent').style.width = '4800px';
      const after = canvas.getBoundingClientRect().width;
      scroll.scrollLeft = scroll.scrollWidth;
      return { before, after, end: scroll.scrollLeft, maximum: scroll.scrollWidth - scroll.clientWidth };
    });
    assert.ok(zoom.after > zoom.before, 'zoom 必须增加真实内容宽度');
    assert.ok(Math.abs(zoom.end - zoom.maximum) <= 1, 'zoom 后必须仍可滚到完整时间轴结尾');
    await page.close();
  }
  console.log('final-edit mixcut Playwright layout tests passed');

  const server = await startNextDevServer();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    let savedGroup = createFormalGroup();
    const variantPatchBodies = [];
    const groupPatchBodies = [];
    const presetPostBodies = [];
    const overlayPostBodies = [];
    const renderPostBodies = [];
    const revealRequests = [];
    let savedPresets = [];
    let revealAvailable = false;
    let renderPollCount = 0;
    const project = {
      id: 'e2e-project',
      name: 'Mixcut E2E 项目',
      providerId: 'provider-e2e',
      model: 'model-e2e',
      prompt: '',
      status: 'draft',
      concurrency: 1,
      maxAttempts: 1,
      workflowType: 'complex_product',
      productName: 'E2E 产品',
      productCode: 'E2E-001',
      images: [],
      jobs: [],
      provider: null,
    };
    const context = {
      project: { id: project.id, name: project.name, productName: project.productName, productCode: project.productCode, createdAt: '2026-07-24T00:00:00.000Z', taskDate: '20260724' },
      shotSets: [{ id: 'shot-set-e2e', name: '正式测试分镜组', shotCount: 2, succeededVideoCount: 2, totalDurationUs: 10_000_000 }],
      currentShotSetId: 'shot-set-e2e',
      drafts: [{ id: 'draft-e2e', shotSetId: 'shot-set-e2e', title: 'E2E 文案', narrationText: '第一句。第二句。', targetDurationSec: 10, provider: 'mock', model: 'mock', createdAt: '2026-07-24T00:00:00.000Z' }],
      videoAssets: [
        { videoJobId: 'video-a', shotSetId: 'shot-set-e2e', filename: 'a.mp4', durationUs: 5_000_000, width: 1080, height: 1440, thumbnailUrl: transparentPixel, source: 'module4' },
        { videoJobId: 'video-b', shotSetId: 'shot-set-e2e', filename: 'b.mp4', durationUs: 5_000_000, width: 1080, height: 1440, thumbnailUrl: transparentPixel, source: 'module4' },
      ],
    };

    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

      if (pathname === '/api/projects/e2e-project') return json(project);
      if (pathname === '/api/projects/e2e-project/run') return json({ queueStatus: 'idle' });
      if (pathname === '/api/providers') return json([]);
      if (pathname === '/api/providers/tts') return json([{ id: 'tts-e2e', name: 'Mock TTS', configured: true, voices: [{ id: 'voice-e2e', name: '测试音色' }] }]);
      if (pathname === '/api/providers/script') return json([{ id: 'vision-e2e', configured: true, supportsVision: true }]);
      if (pathname === '/api/system-fonts') return json(['Arial']);
      if (pathname === '/api/final-edit/capabilities') return json({ revealInFolder: revealAvailable });
      if (pathname === '/api/final-edit/title-presets' && request.method() === 'GET') return json(savedPresets);
      if (pathname === '/api/final-edit/title-presets' && request.method() === 'POST') {
        const body = request.postDataJSON();
        presetPostBodies.push(body);
        const created = { id: `preset-${savedPresets.length + 1}`, name: body.name, version: 2, stylesByPreset: body.stylesByPreset, createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z' };
        savedPresets = [created, ...savedPresets];
        return json(created, 201);
      }
      if (pathname.startsWith('/api/final-edit/title-presets/') && request.method() === 'DELETE') {
        const id = pathname.split('/').at(-1);
        savedPresets = savedPresets.filter((preset) => preset.id !== id);
        return route.fulfill({ status: 204, body: '' });
      }
      if (pathname === '/api/projects/e2e-project/final-edit/context') return json(context);
      if (pathname === '/api/projects/e2e-project/final-edit/shot-sets/shot-set-e2e/external-assets') return json({ assets: [] });
      if (pathname === '/api/projects/e2e-project/final-edit/groups') return json({ groups: [savedGroup] });
      if (pathname === '/api/final-edit-groups/group-e2e/narration') return route.fulfill({ status: 204, body: '' });
      if (pathname === '/api/final-edit-groups/group-e2e/cover-frame') return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from(transparentPixel.split(',')[1], 'base64') });
      if (pathname === '/api/final-edit-groups/group-e2e' && request.method() === 'GET') return json(savedGroup);
      if (pathname === '/api/final-edit-groups/group-e2e/overlay-bundles/9x16' && request.method() === 'POST') {
        overlayPostBodies.push(request.postDataJSON());
        return json({ id: 'overlay-e2e' }, 201);
      }
      if (pathname === '/api/final-edit-groups/group-e2e' && request.method() === 'PATCH') {
        const body = request.postDataJSON();
        groupPatchBodies.push(body);
        if (body.type === 'apply_cover_editor') {
          const currentVariant = savedGroup.variants.find((variant) => variant.id === body.variantId);
          assert.ok(currentVariant, 'cover command variant must exist');
          const sourceKey = body.draft.sourceKey;
          const videoJobId = sourceKey.replace(/^module4:/, '');
          const frameTimeUs = Math.floor(body.draft.frameTimeUs * 24 / 1_000_000) * 1_000_000 / 24;
          const nextVariant = {
            ...currentVariant,
            revision: currentVariant.revision + 1,
            cover: {
              coverKey: `video:${videoJobId}:${frameTimeUs}`,
              kind: 'video_keyframe',
              sourceKey,
              frameTimeUs,
              sourceUrl: `/api/final-edit-groups/group-e2e/cover-frame?sourceKey=${encodeURIComponent(sourceKey)}&timeUs=${frameTimeUs}&preset=${currentVariant.outputPreset}`,
              framing: body.draft.framing,
            },
          };
          savedGroup = {
            ...savedGroup,
            revision: savedGroup.revision + 1,
            coverTitle: {
              primary: { ...savedGroup.coverTitle.primary, text: body.draft.primary.text, textSource: 'manual' },
              secondary: { ...savedGroup.coverTitle.secondary, text: body.draft.secondary.text, textSource: 'manual' },
            },
            textStyles: {
              ...savedGroup.textStyles,
              [currentVariant.outputPreset]: {
                ...savedGroup.textStyles[currentVariant.outputPreset],
                coverPrimary: body.draft.primary.style,
                coverSecondary: body.draft.secondary.style,
              },
            },
            variants: savedGroup.variants.map((variant) => variant.id === nextVariant.id ? nextVariant : variant),
          };
          await new Promise((resolve) => setTimeout(resolve, 120));
        } else {
          savedGroup = { ...savedGroup, revision: savedGroup.revision + 1 };
        }
        return json({ view: savedGroup, command: body.type });
      }
      if (pathname === '/api/final-edit-variants/variant-e2e' && request.method() === 'PATCH') {
        const body = request.postDataJSON();
        variantPatchBodies.push(body);
        const currentVariant = savedGroup.variants[0];
        if (body.type === 'reorder_clips') {
          const byId = new Map(currentVariant.timeline.clips.map((clip) => [clip.id, clip]));
          let timelineFrame = 0;
          const clips = body.orderedClipIds.map((id) => {
            const clip = byId.get(id);
            assert.ok(clip, `unknown clip ${id}`);
            const duration = clip.timelineOutFrame - clip.timelineInFrame;
            const next = { ...clip, timelineInFrame: timelineFrame, timelineOutFrame: timelineFrame + duration };
            timelineFrame += duration;
            return next;
          });
          const nextVariant = { ...currentVariant, revision: currentVariant.revision + 1, timeline: { ...currentVariant.timeline, clips } };
          savedGroup = { ...savedGroup, variants: [nextVariant] };
          return json({ view: nextVariant });
        }
        if (body.type === 'trim_clip') {
          const clips = currentVariant.timeline.clips.map((clip) => clip.id === body.clipId ? {
            ...clip,
            sourceInFrame: body.sourceInFrame,
            sourceOutFrame: body.sourceOutFrame,
            timelineInFrame: body.timelineInFrame,
            timelineOutFrame: body.timelineOutFrame,
          } : clip);
          const nextVariant = { ...currentVariant, revision: currentVariant.revision + 1, timeline: { ...currentVariant.timeline, clips } };
          savedGroup = { ...savedGroup, variants: [nextVariant] };
          return json({ view: nextVariant });
        }
        return json({ view: currentVariant });
      }
      if (pathname === '/api/final-edit-variants/variant-e2e/render' && request.method() === 'POST') {
        const body = request.postDataJSON();
        renderPostBodies.push(body);
        const queued = { id: 'render-job-e2e', variantId: 'variant-e2e', kind: 'render', status: 'queued', phase: 'preflight', progress: 0, estimatedCost: 0, costCurrency: 'CNY', errorCode: null, errorMessage: null, startedAt: null, finishedAt: null, createdAt: '2026-07-24T01:00:00.000Z' };
        savedGroup = { ...savedGroup, jobs: [queued, ...savedGroup.jobs.filter((job) => job.id !== queued.id)] };
        renderPollCount = 0;
        return json({ ...queued, groupId: savedGroup.id, target: { taskName: project.name, productCode: project.productCode, taskDate: '20260724', videoFilename: '成片-E2E-001-20260724-02.mp4', coverFilename: '成片-E2E-001-20260724-02-封面.jpg', displayDirectory: '工作台/Mixcut E2E 项目/成片/' } }, 202);
      }
      if (pathname === '/api/final-edit-jobs/render-job-e2e' && request.method() === 'GET') {
        renderPollCount += 1;
        const target = { taskName: project.name, productCode: project.productCode, taskDate: '20260724', videoFilename: '成片-E2E-001-20260724-02.mp4', coverFilename: '成片-E2E-001-20260724-02-封面.jpg', displayDirectory: '工作台/Mixcut E2E 项目/成片/' };
        if (renderPollCount <= 4) return json({ id: 'render-job-e2e', groupId: savedGroup.id, variantId: 'variant-e2e', kind: 'render', status: 'running', phase: 'rendering', progress: 0.42, target, output: null, errorMessage: null });
        const output = { videoRelativePath: 'final-edits/jobs/render-job-e2e/final.mp4', coverRelativePath: 'final-edits/jobs/render-job-e2e/cover.jpg', publishedVideoRelativePath: 'projects/e2e-project/成片/成片-E2E-001-20260724-02.mp4', publishedCoverRelativePath: 'projects/e2e-project/成片/成片-E2E-001-20260724-02-封面.jpg', videoFilename: '成片-E2E-001-20260724-02.mp4', coverFilename: '成片-E2E-001-20260724-02-封面.jpg', displayDirectory: '工作台/Mixcut E2E 项目/成片/', durationSec: 10.83, width: 1080, height: 1920, fps: 24, videoUrl: '/api/final-edit-jobs/render-job-e2e/video', videoDownloadUrl: '/api/final-edit-jobs/render-job-e2e/video?download=1', coverUrl: '/api/final-edit-jobs/render-job-e2e/cover', coverDownloadUrl: '/api/final-edit-jobs/render-job-e2e/cover?download=1' };
        const succeeded = { id: 'render-job-e2e', groupId: savedGroup.id, variantId: 'variant-e2e', kind: 'render', status: 'succeeded', phase: 'succeeded', progress: 1, output, errorMessage: null, finishedAt: '2026-07-24T01:00:10.000Z' };
        savedGroup = { ...savedGroup, jobs: savedGroup.jobs.map((job) => job.id === succeeded.id ? { ...job, ...succeeded } : job) };
        return json({ ...succeeded, target });
      }
      if (pathname === '/api/final-edit-jobs/render-job-e2e/reveal' && request.method() === 'POST') {
        revealRequests.push(request.postData());
        return json({ revealed: true });
      }
      if (pathname === '/api/final-edit-jobs/render-job-e2e/cover') return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from(transparentPixel.split(',')[1], 'base64') });
      if (pathname === '/api/final-edit-jobs/render-job-e2e/video') return route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('non-empty-mocked-video-response') });
      if (pathname.startsWith('/api/final-edit-bgm/')) return route.fulfill({ status: 204, body: '' });
      return json({ error: `Unhandled E2E API: ${request.method()} ${pathname}` }, 404);
    });

    const formalUrl = `${server.baseUrl}/projects/e2e-project?tab=final-edit&mixcut=v1`;
    await page.goto(formalUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.getByRole('heading', { name: '预览并调整完整时间轴' }).waitFor();

    await page.setViewportSize({ width: 1024, height: 1000 });
    const formalSmallScreen = await page.evaluate(() => {
      const root = document.documentElement;
      const stage = document.querySelector('main[aria-label="成片预览"] canvas')?.parentElement?.getBoundingClientRect();
      const controls = document.querySelector('input[aria-label="播放位置"]')?.parentElement?.getBoundingClientRect();
      const timeline = document.querySelector('section[aria-label="智能混剪时间轴"]')?.getBoundingClientRect();
      return {
        overflowX: root.scrollWidth - root.clientWidth,
        stageBottom: stage?.bottom ?? Infinity,
        controlsTop: controls?.top ?? -Infinity,
        controlsBottom: controls?.bottom ?? Infinity,
        timelineTop: timeline?.top ?? -Infinity,
      };
    });
    assert.ok(formalSmallScreen.overflowX <= 1, '1024px 正式外壳不得整页横向溢出，横滚只能发生在时间轴内部');
    assert.ok(formalSmallScreen.stageBottom <= formalSmallScreen.controlsTop + 0.5, '1024px 正式播放器不得覆盖控制条');
    assert.ok(formalSmallScreen.controlsBottom <= formalSmallScreen.timelineTop + 0.5, '1024px 正式控制条不得覆盖时间轴');
    await page.setViewportSize({ width: 1440, height: 1100 });

    const stageRatio = async () => page.locator('main[aria-label="成片预览"] canvas').first().evaluate((canvas) => {
      const stage = canvas.parentElement.getBoundingClientRect();
      return stage.width / stage.height;
    });
    assert.ok(Math.abs(await stageRatio() - 3 / 4) < 0.02, '正式页面 3:4 播放器必须保持画幅');
    assert.equal(await page.locator('[data-track]').count(), 4, '正式页面必须挂载四条真实轨道');
    await page.getByText('全局字幕样式').waitFor();
    await page.getByText('字体', { exact: true }).waitFor();
    await page.getByText('字号', { exact: true }).waitFor();
    await page.getByText('描边', { exact: true }).waitFor();

    savedGroup = { ...savedGroup, variants: [{ ...savedGroup.variants[0], outputPreset: '9x16' }] };
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.getByRole('heading', { name: '预览并调整完整时间轴' }).waitFor();
    assert.ok(Math.abs(await stageRatio() - 9 / 16) < 0.02, '正式页面 9:16 播放器必须保持画幅');

    const openCoverDrawer = async () => {
      await page.getByRole('button', { name: '封面', exact: true }).click();
      await page.getByRole('button', { name: '精调封面' }).click();
      return page.getByRole('dialog', { name: '精调封面' });
    };
    let coverDialog = await openCoverDrawer();
    await coverDialog.waitFor();
    const drawerGeometry = await coverDialog.evaluate((dialog) => ({
      directPortal: dialog.parentElement?.parentElement === document.body,
      widthRatio: dialog.getBoundingClientRect().width / window.innerWidth,
      bodyLocked: document.body.style.overflow === 'hidden',
    }));
    assert.equal(drawerGeometry.directPortal, true, '封面抽屉必须 portal 到 document.body 根级');
    assert.ok(drawerGeometry.widthRatio >= 0.68 && drawerGeometry.widthRatio <= 0.72, `封面抽屉宽度应为视口 68%–72%，实际 ${drawerGeometry.widthRatio}`);
    assert.equal(drawerGeometry.bodyLocked, true, '打开根级抽屉时必须锁定底层滚动');
    await page.getByRole('button', { name: '关闭封面精调' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await coverDialog.evaluate((dialog) => dialog.contains(document.activeElement)), true, 'Shift+Tab 必须被圈定在 aria-modal 抽屉内');
    await page.getByRole('button', { name: /a\.mp4/ }).waitFor();
    assert.equal(await page.getByRole('slider', { name: '封面截帧时间' }).inputValue(), '1', '抽屉必须恢复真实截帧时间');

    const groupWritesBeforeCancel = groupPatchBodies.length;
    await page.getByLabel('主标题文字').fill('取消不保存');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(groupPatchBodies.length, groupWritesBeforeCancel, '点击取消不得提交任何 group PATCH');
    coverDialog = await openCoverDrawer();
    assert.equal(await page.getByLabel('主标题文字').inputValue(), '正式页面测试', '取消后重开必须从持久化状态重新克隆草稿');
    await page.getByLabel('主标题文字').fill('Esc 不保存');
    await page.keyboard.press('Escape');
    assert.equal(groupPatchBodies.length, groupWritesBeforeCancel, 'Esc 不得提交封面修改');
    coverDialog = await openCoverDrawer();
    await page.getByLabel('主标题文字').fill('关闭不保存');
    await page.getByRole('button', { name: '关闭封面精调' }).click();
    assert.equal(groupPatchBodies.length, groupWritesBeforeCancel, '关闭按钮不得提交封面修改');
    coverDialog = await openCoverDrawer();
    await page.getByLabel('主标题文字').fill('遮罩不保存');
    await page.getByTestId('cover-drawer-backdrop').dispatchEvent('pointerdown', { bubbles: true });
    assert.equal(groupPatchBodies.length, groupWritesBeforeCancel, '点击遮罩不得提交封面修改');

    coverDialog = await openCoverDrawer();
    const expectedGroupRevision = savedGroup.revision;
    const expectedVariantRevision = savedGroup.variants[0].revision;
    await page.getByRole('button', { name: /b\.mp4/ }).click();
    await page.getByRole('slider', { name: '封面截帧时间' }).fill('2');
    await page.getByLabel('主标题文字').fill('封面主标题');
    await page.getByLabel('副标题文字').fill('封面副标题');
    const primaryControls = page.getByRole('heading', { name: '主标题' }).locator('xpath=../..');
    const secondaryControls = page.getByRole('heading', { name: '副标题' }).locator('xpath=../..');
    await primaryControls.locator('input[type="checkbox"]').first().check();
    await primaryControls.locator('input[type="color"]').first().fill('#ff3300');
    await primaryControls.locator('input[type="color"]').nth(1).fill('#111111');
    await primaryControls.locator('input[type="number"]').first().fill('68');
    await primaryControls.locator('input[type="number"]').nth(1).fill('5');
    await secondaryControls.locator('input[type="checkbox"]').first().uncheck();
    await secondaryControls.locator('input[type="color"]').first().fill('#33aaff');
    await secondaryControls.locator('input[type="color"]').nth(1).fill('#002244');
    await secondaryControls.locator('input[type="number"]').first().fill('42');
    await secondaryControls.locator('input[type="number"]').nth(1).fill('2');
    const zoomRange = coverDialog.getByRole('heading', { name: '画面' }).locator('xpath=..').locator('input[type="range"]').first();
    await zoomRange.fill('1.4');
    await page.getByRole('button', { name: '拖动主标题' }).click();
    const coverCanvas = coverDialog.locator('canvas');
    const coverCanvasBox = await coverCanvas.boundingBox();
    assert.ok(coverCanvasBox, '真实封面画布必须可交互');
    await page.mouse.move(coverCanvasBox.x + coverCanvasBox.width / 2, coverCanvasBox.y + coverCanvasBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(coverCanvasBox.x + coverCanvasBox.width / 2 + 28, coverCanvasBox.y + coverCanvasBox.height / 2 + 16, { steps: 4 });
    await page.mouse.up();
    const coverApplyResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-groups/group-e2e') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '应用封面' }).click();
    assert.equal(await page.getByLabel('主标题文字').isDisabled(), true, '保存进行中必须冻结抽屉正文，防止修改丢失');
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true, '保存进行中不得关闭并误以为修改被取消');
    assert.equal(await coverCanvas.evaluate((canvas) => getComputedStyle(canvas).pointerEvents), 'none', '保存进行中必须冻结画布拖拽');
    assert.equal(await coverDialog.evaluate((dialog) => dialog.contains(document.activeElement)), true, '保存进行中焦点不得逃到背景页面');
    await coverApplyResponse;
    assert.equal(groupPatchBodies.length, groupWritesBeforeCancel + 1, '应用封面必须恰好提交一次 group PATCH');
    const coverCommand = groupPatchBodies.at(-1);
    assert.equal(coverCommand.type, 'apply_cover_editor');
    assert.equal(coverCommand.expectedRevision, expectedGroupRevision);
    assert.equal(coverCommand.expectedVariantRevision, expectedVariantRevision);
    assert.equal(coverCommand.draft.sourceKey, 'module4:video-b');
    assert.equal(coverCommand.draft.primary.style.italic, true);
    assert.equal(coverCommand.draft.secondary.style.italic, false);
    assert.ok(coverCommand.draft.primary.style.x > 0.5, '画布拖拽必须改变主标题位置');
    assert.deepEqual(coverCommand.draft.framing, { scale: 1.4, offsetX: 0, offsetY: 0 });

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.getByRole('heading', { name: '预览并调整完整时间轴' }).waitFor();
    await page.getByRole('button', { name: '封面', exact: true }).click();
    await page.getByText('封面主标题', { exact: true }).waitFor();
    await page.getByText('封面副标题', { exact: true }).waitFor();
    coverDialog = await openCoverDrawer();
    assert.equal(await page.getByLabel('主标题文字').inputValue(), '封面主标题', '刷新后必须恢复已应用主标题');
    assert.equal(await page.getByLabel('副标题文字').inputValue(), '封面副标题', '刷新后必须恢复已应用副标题');
    assert.equal(await page.getByRole('slider', { name: '封面截帧时间' }).inputValue(), '2', '刷新后必须恢复视频截帧时间');

    await page.getByLabel('预设名称').fill('电商蓝橙');
    const presetCreateResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit/title-presets') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await presetCreateResponse;
    assert.equal(presetPostBodies.at(-1).version, 2, '自定义封面预设必须写 V2');
    assert.equal('text' in presetPostBodies.at(-1), false, '封面预设不得保存标题文案');
    assert.equal('sourceKey' in presetPostBodies.at(-1), false, '封面预设不得保存来源片段');
    assert.equal('frameTimeUs' in presetPostBodies.at(-1), false, '封面预设不得保存截帧时间');
    assert.deepEqual(presetPostBodies.at(-1).stylesByPreset['3x4'].framing, { scale: 1, offsetX: 0, offsetY: 0 }, '非当前画幅不得继承未经审阅的 framing');
    assert.deepEqual(presetPostBodies.at(-1).stylesByPreset['16x9'].framing, { scale: 1, offsetX: 0, offsetY: 0 }, '跨画幅预设必须保留独立 framing');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.getByRole('heading', { name: '预览并调整完整时间轴' }).waitFor();
    coverDialog = await openCoverDrawer();
    await page.getByRole('button', { name: '电商蓝橙', exact: true }).waitFor();
    await primaryControls.locator('input[type="color"]').first().fill('#000000').catch(() => undefined);
    await page.getByRole('button', { name: '电商蓝橙', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: '主标题' }).locator('xpath=../..').locator('input[type="color"]').first().inputValue(), '#ff3300', '重启后应用 V2 预设必须恢复样式');
    await page.getByRole('button', { name: '删除预设 电商蓝橙' }).click();
    assert.equal(savedPresets.length, 0, '删除预设必须持久化到服务端');
    await page.getByRole('button', { name: '取消', exact: true }).click();

    const playbackPosition = page.getByRole('slider', { name: '播放位置' });
    await playbackPosition.fill('4');
    const timelineContent = page.locator('[data-testid="mixcut-timeline-scroll"] > div > div').nth(1);
    await timelineContent.scrollIntoViewIfNeeded();
    const contentBox = await timelineContent.boundingBox();
    assert.ok(contentBox, '正式时间轴内容必须可见');
    await timelineContent.dispatchEvent('pointerdown', { bubbles: true, clientX: contentBox.x + 1, clientY: contentBox.y + 20, pointerId: 1, pointerType: 'mouse' });
    await expectEventually(async () => Number(await playbackPosition.inputValue()) <= 1 / 24, `点击时间轴开头应回到封面 0 秒（当前 ${await playbackPosition.inputValue()}）`);

    await playbackPosition.fill('4');
    const playhead = page.getByRole('button', { name: '拖动播放头' });
    await playhead.scrollIntoViewIfNeeded();
    const playheadBox = await playhead.boundingBox();
    assert.ok(playheadBox, '播放头必须可拖动');
    await page.mouse.move(playheadBox.x + playheadBox.width / 2, playheadBox.y + playheadBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(contentBox.x + 1, playheadBox.y + playheadBox.height / 2, { steps: 4 });
    await page.mouse.up();
    await expectEventually(async () => Number(await playbackPosition.inputValue()) <= 1 / 24, '拖动播放头应回到封面 0 秒');

    const reorderResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e') && response.request().method() === 'PATCH');
    const clipABeforeReorder = await page.locator('[data-clip-id="clip-a"]').boundingBox();
    const clipBBeforeReorder = await page.locator('[data-clip-id="clip-b"]').boundingBox();
    assert.ok(clipABeforeReorder && clipBBeforeReorder, '排序前两个正式视频片段必须可见');
    await page.mouse.move(clipABeforeReorder.x + clipABeforeReorder.width / 2, clipABeforeReorder.y + clipABeforeReorder.height / 2);
    await page.mouse.down();
    await page.mouse.move(clipBBeforeReorder.x + clipBBeforeReorder.width * 0.8, clipBBeforeReorder.y + clipBBeforeReorder.height / 2, { steps: 8 });
    await page.mouse.up();
    await reorderResponse;
    assert.equal(variantPatchBodies.at(-1)?.type, 'reorder_clips');
    assert.deepEqual(variantPatchBodies.at(-1)?.orderedClipIds, ['clip-b', 'clip-a']);
    await expectEventually(async () => {
      const [a, b] = await Promise.all([
        page.locator('[data-clip-id="clip-a"]').boundingBox(),
        page.locator('[data-clip-id="clip-b"]').boundingBox(),
      ]);
      return Boolean(a && b && a.x > b.x);
    }, '保存后正式时间轴必须显示新的片段顺序');

    const timelineScroll = page.locator('[data-testid="mixcut-timeline-scroll"]');
    const timelineCanvas = page.locator('[data-testid="mixcut-timeline-scroll"] > div');
    const timelineLabels = page.locator('[data-testid="mixcut-timeline-scroll"] > div > div').first();
    const widthBeforeZoom = await timelineCanvas.evaluate((element) => element.getBoundingClientRect().width);
    await page.getByRole('slider', { name: '时间轴缩放' }).fill('220');
    await expectEventually(async () => await timelineCanvas.evaluate((element) => element.getBoundingClientRect().width) > widthBeforeZoom, '真实 zoom 控件必须改变 canvas 宽度');
    const scrollBefore = await timelineScroll.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    assert.ok(scrollBefore.scrollWidth > scrollBefore.clientWidth, '正式时间轴必须产生真实横向滚动范围');
    assert.ok(scrollBefore.scrollHeight > scrollBefore.clientHeight, '正式时间轴必须产生真实纵向滚动范围');
    const stickyLeftBefore = await timelineLabels.evaluate((element) => element.getBoundingClientRect().left);
    await timelineScroll.evaluate((element) => {
      element.scrollLeft = Math.min(700, element.scrollWidth - element.clientWidth);
      element.scrollTop = element.scrollHeight;
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    const scrolled = await timelineScroll.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
    const stickyLeftAfter = await timelineLabels.evaluate((element) => element.getBoundingClientRect().left);
    assert.ok(scrolled.left > 0, '正式时间轴必须可以实际横向滚动');
    assert.ok(scrolled.top > 0, '正式时间轴必须可以实际纵向滚动');
    assert.ok(Math.abs(stickyLeftAfter - stickyLeftBefore) <= 0.5, '正式时间轴横滚后轨道标签必须保持 sticky');

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.getByRole('heading', { name: '预览并调整完整时间轴' }).waitFor();
    await expectEventually(async () => {
      const [a, b] = await Promise.all([
        page.locator('[data-clip-id="clip-a"]').boundingBox(),
        page.locator('[data-clip-id="clip-b"]').boundingBox(),
      ]);
      return Boolean(a && b && a.x > b.x);
    }, '重载后必须从 mock 服务端恢复保存的片段顺序');

    const clipABeforeTrim = page.locator('[data-clip-id="clip-a"]');
    const widthBeforeTrim = (await clipABeforeTrim.boundingBox())?.width;
    const endHandle = clipABeforeTrim.locator('[aria-label="裁剪片段结尾"]');
    await endHandle.scrollIntoViewIfNeeded();
    const endHandleBox = await endHandle.boundingBox();
    assert.ok(widthBeforeTrim && endHandleBox, '片段尾部裁剪手柄必须可见');
    const trimResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e') && response.request().method() === 'PATCH');
    await page.mouse.move(endHandleBox.x + endHandleBox.width / 2, endHandleBox.y + endHandleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(endHandleBox.x + endHandleBox.width / 2 - 80, endHandleBox.y + endHandleBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await trimResponse;
    const trimRequest = variantPatchBodies.at(-1);
    assert.equal(trimRequest?.type, 'trim_clip');
    assert.equal(trimRequest?.clipId, 'clip-a');
    assert.ok(trimRequest.sourceOutFrame < 120, '尾部向左拖动必须缩短源片段出点');
    assert.equal(savedGroup.variants[0].timeline.clips.find((clip) => clip.id === 'clip-a')?.sourceOutFrame, trimRequest.sourceOutFrame, 'mock 服务端必须保存源出点');
    let widthAfterTrim = 0;
    await expectEventually(async () => {
      widthAfterTrim = (await page.locator('[data-clip-id="clip-a"]').boundingBox())?.width ?? 0;
      return widthAfterTrim > 0 && widthAfterTrim < widthBeforeTrim;
    }, '裁剪成功后正式时间轴片段宽度必须缩短');

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.getByRole('heading', { name: '预览并调整完整时间轴' }).waitFor();
    const widthAfterTrimReload = (await page.locator('[data-clip-id="clip-a"]').boundingBox())?.width ?? 0;
    assert.ok(Math.abs(widthAfterTrimReload - widthAfterTrim) <= 1, '重载后必须恢复服务端保存的裁剪宽度');
    await page.locator('[data-clip-id="clip-a"]').click();
    await page.getByText(`源 ${trimRequest.sourceInFrame}–${trimRequest.sourceOutFrame} 帧`, { exact: false }).waitFor();

    const playButton = page.getByRole('button', { name: '播放成片' });
    await playButton.click();
    await page.getByRole('button', { name: '暂停' }).waitFor();
    await page.getByRole('button', { name: /AI 智能创作/ }).click();
    await expectEventually(async () => await page.locator('button[aria-label="播放成片"]').count() === 1, '切出第三步后预览必须恢复暂停');

    savedGroup = { ...savedGroup, variants: [...savedGroup.variants, { ...savedGroup.variants[0], id: 'variant-e2e-b', indexNum: 2 }] };
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.getByLabel('选择成片草稿').selectOption('variant-e2e-b');
    await page.getByRole('button', { name: '下一步：导出' }).click();
    await page.getByRole('heading', { name: '导出并写回项目' }).waitFor();
    assert.equal(await page.getByLabel('选择导出草稿').inputValue(), 'variant-e2e-b', '从预览进入导出必须保持当前草稿，不得回退第一条');
    await page.getByLabel('选择导出草稿').selectOption('variant-e2e');
    await page.getByText('Mixcut E2E 项目', { exact: true }).waitFor();
    await page.getByText('E2E-001', { exact: true }).waitFor();
    await page.getByText('20260724', { exact: true }).waitFor();
    await page.getByText('成片-E2E-001-20260724.mp4', { exact: true }).waitFor();
    await page.getByText('工作台/Mixcut E2E 项目/成片/', { exact: true }).waitFor();
    assert.equal(await page.getByText('model-e2e', { exact: true }).count(), 0, '导出命名不得误用 projects.model');

    const renderResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e/render') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '开始导出' }).click();
    await renderResponse;
    assert.equal(overlayPostBodies.length, 1, '开始导出必须先冻结当前画幅的叠加层');
    assert.equal(renderPostBodies.length, 1, '开始导出必须只创建一个渲染任务');
    assert.equal(renderPostBodies[0].groupId, savedGroup.id);
    assert.equal(renderPostBodies[0].expectedGroupRevision, savedGroup.revision);
    assert.equal(renderPostBodies[0].expectedVariantRevision, savedGroup.variants[0].revision);
    assert.equal(renderPostBodies[0].overlayBundleId, 'overlay-e2e');
    await page.getByRole('progressbar').waitFor();
    await page.getByText('正在渲染 · 42%').waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /导出渲染/ }).click();
    await page.getByText('正在渲染 · 42%').waitFor();
    await page.getByText('成片-E2E-001-20260724-02.mp4', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '开始导出' }).count(), 0, '恢复运行中任务时不得短暂开放重复导出');
    await page.getByText('成片-E2E-001-20260724-02.mp4', { exact: true }).waitFor();
    await page.getByText('成片-E2E-001-20260724-02-封面.jpg', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '下载视频' }).getAttribute('href'), '/api/final-edit-jobs/render-job-e2e/video?download=1');
    assert.equal(await page.getByRole('link', { name: '下载封面' }).getAttribute('href'), '/api/final-edit-jobs/render-job-e2e/cover?download=1');
    assert.equal(await page.locator('section[aria-label="导出结果"] video').getAttribute('src'), '/api/final-edit-jobs/render-job-e2e/video');
    await expectEventually(async () => page.locator('section[aria-label="导出结果"] img').evaluate((image) => image.naturalWidth > 0), '导出封面预览必须真实加载成功');
    const inlineVideoResponse = await page.request.get(`${server.baseUrl}/api/final-edit-jobs/render-job-e2e/video`);
    assert.equal(inlineVideoResponse.ok(), true, '导出视频预览 URL 必须返回成功媒体响应');
    assert.equal((await inlineVideoResponse.body()).length > 0, true, '导出视频预览响应不得为空');
    assert.equal(await page.getByRole('button', { name: '在文件夹中查看' }).count(), 0, '普通 Web 模式不得显示桌面文件定位入口');

    revealAvailable = true;
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /导出渲染/ }).click();
    await page.getByRole('heading', { name: '导出并写回项目' }).waitFor();
    await page.getByText('成片-E2E-001-20260724-02.mp4', { exact: true }).waitFor();
    await page.getByRole('button', { name: '在文件夹中查看' }).click();
    assert.deepEqual(revealRequests, [null], '文件定位请求不得接受或泄露客户端路径');

    await page.close();
    console.log('final-edit mixcut formal page smoke tests passed');
  } catch (error) {
    error.message = `${error.message}\nNext dev output:\n${server.output()}`;
    throw error;
  } finally {
    await stopNextDevServer(server.child);
  }
} finally {
  await browser.close();
}
