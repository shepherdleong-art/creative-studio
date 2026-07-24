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
      cover: { coverKey: 'cover-e2e', kind: 'storyboard_image', sourceUrl: transparentPixel, framing: { scale: 1, offsetX: 0, offsetY: 0 } },
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
      project: { id: project.id, name: project.name, productName: project.productName, productCode: project.productCode, createdAt: '2026-07-24T00:00:00.000Z' },
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
      if (pathname === '/api/projects/e2e-project/final-edit/context') return json(context);
      if (pathname === '/api/projects/e2e-project/final-edit/shot-sets/shot-set-e2e/external-assets') return json({ assets: [] });
      if (pathname === '/api/projects/e2e-project/final-edit/groups') return json({ groups: [savedGroup] });
      if (pathname === '/api/final-edit-groups/group-e2e/narration') return route.fulfill({ status: 204, body: '' });
      if (pathname === '/api/final-edit-groups/group-e2e' && request.method() === 'GET') return json(savedGroup);
      if (pathname === '/api/final-edit-groups/group-e2e' && request.method() === 'PATCH') {
        const body = request.postDataJSON();
        savedGroup = { ...savedGroup, revision: savedGroup.revision + 1 };
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
