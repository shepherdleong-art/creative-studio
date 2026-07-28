import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { alphaBoundsWidth, overlayMeasurementLimit } from '../lib/final-edit/overlay-measurement.ts';

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
    // 素材时长比片段用量长（8s 素材只用了前 5s），给 Trim 截取条留出可拖拽的余量；
    // clip 的 sourceInFrame/sourceOutFrame 若正好等于素材全长，选择框会撑满整条、拖不动。
    assets: [
      { assetKey: 'module4:video-a', source: 'module4', videoJobId: 'video-a', shotSetId: 'shot-set-e2e', shotId: 'shot-a', filename: 'a.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 8_000_000, fingerprint: 'fingerprint-a', analysisStatus: 'succeeded', summary: '素材 A', autoUseDisabled: false, usageCount: 1 },
      { assetKey: 'module4:video-b', source: 'module4', videoJobId: 'video-b', shotSetId: 'shot-set-e2e', shotId: 'shot-b', filename: 'b.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 8_000_000, fingerprint: 'fingerprint-b', analysisStatus: 'succeeded', summary: '素材 B', autoUseDisabled: false, usageCount: 1 },
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

// Next.js 只允许同一项目目录下存在一个 `next dev`（见 .next/dev/lock）；本机常年开着手动调试用的
// dev server，直接 spawn 会报 "Another next dev server is already running." 而不是端口冲突。
// 复用它跑测试是安全的：mock 测试用 page.route 拦截了全部 /api/**，不会打到真实后端数据。
function readRunningDevLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.resolve('.next/dev/lock'), 'utf8'));
    process.kill(lock.pid, 0);
    return lock;
  } catch {
    return null;
  }
}

async function acquireNextDevServer() {
  const lock = readRunningDevLock();
  if (lock) {
    const baseUrl = lock.appUrl || `http://${lock.hostname}:${lock.port}`;
    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });
      if (response.status < 500) return { child: null, baseUrl, output: () => '(复用已在运行的 dev server，未捕获其输出)' };
    } catch { /* 锁文件失效，走下面的自起流程 */ }
  }
  return startNextDevServer();
}

async function releaseNextDevServer(server) {
  if (!server.child) return; // 复用的外部 server 不归本测试管理，不主动停止
  await stopNextDevServer(server.child);
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
  const server = await acquireNextDevServer();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function measureTextWithOptionalUnderreport(text) {
        const metrics = originalMeasureText.call(this, text);
        if (!globalThis.__mixcutForceCanvasMeasurementUnderreport) return metrics;
        return new Proxy(metrics, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === 'width') return Math.max(0, value - 16);
            if (property === 'actualBoundingBoxLeft' || property === 'actualBoundingBoxRight') return Math.max(0, value - 8);
            return value;
          },
        });
      };
    });
    let savedGroup = createFormalGroup();
    const variantPatchBodies = [];
    const groupPatchBodies = [];
    const presetPostBodies = [];
    const overlayPostBodies = [];
    const overlayMeasurementFailures = [];
    let overlayForcedError = '';
    const renderPostBodies = [];
    const revealRequests = [];
    const durationResolutionBodies = [];
    let currentDurationJob = null;
    let durationReadyGroup = null;
    let durationJobGetCount = 0;
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
      if (pathname === '/api/final-edit-groups/group-e2e/duration-resolution' && request.method() === 'POST') {
        const body = request.postDataJSON();
        durationResolutionBodies.push(body);
        assert.ok(durationReadyGroup, 'duration review fixture must provide a ready group template');
        if (body.action === 'accept_actual') {
          currentDurationJob = {
            id: 'duration-job-accepted', groupId: 'group-e2e', variantId: null, kind: 'prepare', status: 'succeeded', phase: 'succeeded', progress: 1,
            durationReview: null, errorMessage: null, startedAt: '2026-07-28T01:00:00.000Z', finishedAt: '2026-07-28T01:00:02.000Z',
          };
          savedGroup = {
            ...durationReadyGroup,
            revision: body.expectedRevision + 2,
            durationGate: { ...durationReadyGroup.durationGate, status: 'accepted_actual', acceptedAt: '2026-07-28T01:00:01.000Z' },
            variants: durationReadyGroup.variants.map((variant) => ({
              ...variant,
              issues: [...variant.issues, { code: 'duration_target_overridden', severity: 'warning', message: '已明确按实际总时长 25.60 秒继续（目标 15.00 秒）' }],
            })),
            jobs: [currentDurationJob],
          };
        } else {
          const smartFitAvailable = body.action !== 'smart_fit' && currentDurationJob?.durationReview?.smartFitAvailable !== false;
          currentDurationJob = {
            id: body.action === 'smart_fit' ? 'duration-job-fit' : 'duration-job-retry',
            groupId: 'group-e2e', variantId: null, kind: 'prepare', status: 'needs_input', phase: 'duration_review', progress: 0.6,
            durationReview: { ...currentDurationJob.durationReview, smartFitAvailable },
            errorMessage: '真实 TTS 时长超出目标', startedAt: '2026-07-28T01:00:00.000Z', finishedAt: '2026-07-28T01:00:01.000Z',
          };
          savedGroup = { ...savedGroup, revision: body.expectedRevision + 2, jobs: [currentDurationJob] };
        }
        return json({ id: currentDurationJob.id, groupId: 'group-e2e', kind: 'prepare', status: currentDurationJob.status });
      }
      if (pathname.startsWith('/api/final-edit-jobs/duration-job-') && request.method() === 'GET') {
        durationJobGetCount += 1;
        return json(currentDurationJob);
      }
      if (pathname === '/api/final-edit-groups/group-e2e/overlay-bundles/9x16' && request.method() === 'POST') {
        const body = request.postDataJSON();
        overlayPostBodies.push(body);
        if (overlayForcedError) return json({ error: overlayForcedError }, 400);
        const widths = body.manifest.measurements;
        const expectedTitleWidth = widths.titleCompositeWidth;
        const actualTitleWidth = await alphaBoundsWidth(Buffer.from(body.titlePngBase64, 'base64'));
        const limit = overlayMeasurementLimit(expectedTitleWidth);
        if (actualTitleWidth > limit) {
          overlayMeasurementFailures.push({ layer: 'cover-title', actualWidth: actualTitleWidth, expectedWidth: expectedTitleWidth, limit });
          return json({ error: 'overlay_measurement_mismatch' }, 400);
        }
        for (const cue of savedGroup.subtitleCues) {
          const expectedWidth = widths.subtitleWidths[cue.id];
          const actualWidth = await alphaBoundsWidth(Buffer.from(body.subtitlePngs[cue.id], 'base64'));
          const subtitleLimit = overlayMeasurementLimit(expectedWidth);
          if (actualWidth > subtitleLimit) {
            overlayMeasurementFailures.push({ layer: cue.id, actualWidth, expectedWidth, limit: subtitleLimit });
            return json({ error: 'overlay_measurement_mismatch' }, 400);
          }
        }
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
        if (body.type === 'replace_clip') {
          const clips = currentVariant.timeline.clips.map((clip) => clip.id === body.clipId ? {
            ...clip,
            videoJobId: body.videoJobId,
            sourceFingerprint: body.sourceFingerprint,
            sourceInFrame: body.sourceInFrame,
            sourceOutFrame: body.sourceOutFrame,
          } : clip);
          const nextVariant = { ...currentVariant, revision: currentVariant.revision + 1, timeline: { ...currentVariant.timeline, clips } };
          savedGroup = { ...savedGroup, variants: [nextVariant] };
          return json({ view: nextVariant });
        }
        if (body.type === 'delete_clip') {
          const clips = currentVariant.timeline.clips.filter((clip) => clip.id !== body.clipId);
          const nextVariant = { ...currentVariant, revision: currentVariant.revision + 1, timeline: { ...currentVariant.timeline, clips } };
          savedGroup = { ...savedGroup, variants: [nextVariant] };
          return json({ view: nextVariant });
        }
        if (body.type === 'insert_clip') {
          const clip = {
            id: `clip-inserted-${variantPatchBodies.length}`,
            videoJobId: body.videoJobId,
            sourceFingerprint: body.sourceFingerprint,
            sourceInFrame: body.sourceInFrame,
            sourceOutFrame: body.sourceOutFrame,
            timelineInFrame: body.timelineInFrame,
            timelineOutFrame: body.timelineOutFrame,
            boundSegmentId: null,
            framing: { scale: 1, offsetX: 0, offsetY: 0 },
            manualUseOverride: true,
          };
          const clips = [...currentVariant.timeline.clips, clip];
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

    // 第 3 步预览区几何回归（规格 §6.3/§8.3）：预览必须留在大纸内，工具行/时间轴不得互相覆盖，
    // 页面不得横向溢出。V2 用 clamp(360px,58vh,560px) 视口驱动尺寸，取代 V1 的 flex 撑满写法，
    // 这类 viewport 相关几何 bug 只有挂载真实组件才能测出来，不用独立 CSS 样机复现。
    const checkPreviewGeometry = () => page.evaluate(() => {
      const root = document.documentElement;
      const stageEl = document.querySelector('main[aria-label="成片预览"] canvas')?.parentElement;
      const controlsEl = document.querySelector('input[aria-label="播放位置"]')?.parentElement;
      const timelineEl = document.querySelector('section[aria-label="智能混剪时间轴"]');
      const bigPaperEl = stageEl?.closest('[class*="bigPaper"]');
      const stage = stageEl?.getBoundingClientRect();
      const controls = controlsEl?.getBoundingClientRect();
      const timeline = timelineEl?.getBoundingClientRect();
      const bigPaper = bigPaperEl?.getBoundingClientRect();
      return {
        overflowX: root.scrollWidth - root.clientWidth,
        stageBottom: stage?.bottom ?? Infinity,
        controlsTop: controls?.top ?? -Infinity,
        controlsBottom: controls?.bottom ?? Infinity,
        timelineTop: timeline?.top ?? -Infinity,
        bigPaperBottom: bigPaper?.bottom ?? Infinity,
      };
    });
    const assertPreviewGeometry = async (label) => {
      const box = await checkPreviewGeometry();
      assert.ok(box.overflowX <= 1, `${label}: 不得整页横向溢出（当前溢出 ${box.overflowX}px）`);
      assert.ok(box.stageBottom <= box.controlsTop + 0.5, `${label}: 预览不得覆盖播放控制条`);
      assert.ok(box.controlsBottom <= box.timelineTop + 0.5, `${label}: 播放控制条不得覆盖时间轴`);
      assert.ok(box.stageBottom <= box.bigPaperBottom + 0.5, `${label}: 预览底边必须始终在大纸内（规格 §9）`);
    };

    const formalUrl = `${server.baseUrl}/projects/e2e-project?tab=final-edit`;
    await page.goto(formalUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '确认本次混剪要用的素材' }).waitFor();
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.locator('[data-track="video"]').waitFor();

    assert.equal(await page.locator('[data-track]').count(), 4, '正式页面必须挂载四条真实轨道');
    assert.deepEqual(
      await page.locator('section[aria-label="智能混剪时间轴"] > div:first-child > div').allTextContents(),
      ['', '视频', '字幕', '音频'],
      '时间轴标签列文案必须是视频/字幕/音频三组（音频行合并展示口播+BGM）',
    );

    await page.setViewportSize({ width: 1024, height: 1000 });
    await assertPreviewGeometry('1024×1000');
    await page.setViewportSize({ width: 1280, height: 650 });
    await assertPreviewGeometry('1280×650（规格 §9 最小验收窗口）');
    const previewPageScroll = await page.evaluate(() => {
      window.scrollTo(0, 0);
      const tabs = document.querySelector('nav[aria-label="项目工作台分区"]');
      const timeline = document.querySelector('section[aria-label="智能混剪时间轴"]');
      const previewMain = timeline?.closest('main');
      if (!(tabs instanceof HTMLElement) || !(timeline instanceof HTMLElement) || !(previewMain instanceof HTMLElement)) {
        throw new Error('正式预览页面缺少流程栏、时间线或主编辑列');
      }
      previewMain.scrollTop = 0;
      const tabsTopBefore = tabs.getBoundingClientRect().top;
      timeline.scrollIntoView({ block: 'end' });
      const timelineRect = timeline.getBoundingClientRect();
      return {
        pageY: window.scrollY,
        previewMainY: previewMain.scrollTop,
        tabsTopBefore,
        tabsTopAfter: tabs.getBoundingClientRect().top,
        timelineTop: timelineRect.top,
        timelineBottom: timelineRect.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    assert.ok(previewPageScroll.pageY > 0, '矮屏查看时间线时必须滚动浏览器页面');
    assert.ok(previewPageScroll.tabsTopAfter < previewPageScroll.tabsTopBefore, '顶部流程栏必须随浏览器页面滚动离开视口');
    assert.ok(previewPageScroll.timelineTop >= 0 && previewPageScroll.timelineBottom <= previewPageScroll.viewportHeight + 1, '时间线必须能仅靠浏览器页面滚动完整进入矮屏视口');

    await page.setViewportSize({ width: 2048, height: 1072 });
    const cappedPreviewScroll = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const appHeader = document.querySelector('body > header');
      const timeline = document.querySelector('section[aria-label="智能混剪时间轴"]');
      const stage = document.querySelector('main[aria-label="成片预览"] canvas')?.parentElement;
      const previewBody = timeline?.closest('[class*="bodyPreview"]');
      const rightPanel = previewBody ? [...previewBody.querySelectorAll('aside')].at(-1) : null;
      if (!(appHeader instanceof HTMLElement) || !(timeline instanceof HTMLElement) || !(stage instanceof HTMLElement) || !(previewBody instanceof HTMLElement) || !(rightPanel instanceof HTMLElement)) {
        throw new Error('正式预览页面缺少全局顶栏、预览、时间线或字幕样式栏');
      }
      const headerRect = appHeader.getBoundingClientRect();
      const bodyRect = previewBody.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const timelineRect = timeline.getBoundingClientRect();
      return {
        pageY: window.scrollY,
        headerBottom: headerRect.bottom,
        bodyTop: bodyRect.top,
        stageTop: stageRect.top,
        stageBottom: stageRect.bottom,
        timelineTop: timelineRect.top,
        timelineBottom: timelineRect.bottom,
        viewportHeight: window.innerHeight,
        rightScrollTop: rightPanel.scrollTop,
        rightScrollHeight: rightPanel.scrollHeight,
        rightClientHeight: rightPanel.clientHeight,
      };
    });
    assert.ok(Math.abs(cappedPreviewScroll.bodyTop - cappedPreviewScroll.headerBottom) <= 1, '页面最大滚动位置必须让预览正文顶边贴住全局顶栏');
    assert.ok(cappedPreviewScroll.stageTop >= cappedPreviewScroll.headerBottom, '页面滚到底时视频预览仍必须完整留在视口内');
    assert.ok(cappedPreviewScroll.stageBottom <= cappedPreviewScroll.timelineTop + 0.5, '页面滚到底时视频预览不得覆盖时间线');
    assert.ok(cappedPreviewScroll.timelineBottom <= cappedPreviewScroll.viewportHeight + 1, '页面滚到底时完整时间线必须留在视口内');
    assert.ok(cappedPreviewScroll.rightScrollHeight > cappedPreviewScroll.rightClientHeight + 1, '字幕样式栏必须恢复独立纵向滚动');

    await page.getByText('字幕样式', { exact: true }).hover();
    await page.mouse.wheel(0, 600);
    await expectEventually(async () => await page.evaluate(() => {
      const timeline = document.querySelector('section[aria-label="智能混剪时间轴"]');
      const previewBody = timeline?.closest('[class*="bodyPreview"]');
      const rightPanel = previewBody ? [...previewBody.querySelectorAll('aside')].at(-1) : null;
      return rightPanel instanceof HTMLElement && rightPanel.scrollTop > 0;
    }), '页面到达上限后，滚轮必须只推进字幕样式栏');
    const cappedPreviewAfterRightScroll = await page.evaluate(() => {
      const timeline = document.querySelector('section[aria-label="智能混剪时间轴"]');
      const stage = document.querySelector('main[aria-label="成片预览"] canvas')?.parentElement;
      const previewBody = timeline?.closest('[class*="bodyPreview"]');
      const rightPanel = previewBody ? [...previewBody.querySelectorAll('aside')].at(-1) : null;
      return {
        pageY: window.scrollY,
        stageTop: stage?.getBoundingClientRect().top ?? -1,
        rightScrollTop: rightPanel?.scrollTop ?? 0,
      };
    });
    assert.equal(cappedPreviewAfterRightScroll.pageY, cappedPreviewScroll.pageY, '字幕样式滚动不得继续推动浏览器页面');
    assert.ok(Math.abs(cappedPreviewAfterRightScroll.stageTop - cappedPreviewScroll.stageTop) <= 0.5, '字幕样式滚动时视频预览必须保持原位');
    assert.ok(cappedPreviewAfterRightScroll.rightScrollTop > cappedPreviewScroll.rightScrollTop, '字幕样式滚动必须能访问下方功能');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await assertPreviewGeometry('1440×1100');

    const stageRatio = async () => page.locator('main[aria-label="成片预览"] canvas').first().evaluate((canvas) => {
      const stage = canvas.parentElement.getBoundingClientRect();
      return stage.width / stage.height;
    });
    assert.ok(Math.abs(await stageRatio() - 3 / 4) < 0.02, '正式页面 3:4 播放器必须保持画幅');

    savedGroup = { ...savedGroup, variants: [{ ...savedGroup.variants[0], outputPreset: '9x16' }] };
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.locator('[data-track="video"]').waitFor();
    assert.ok(Math.abs(await stageRatio() - 9 / 16) < 0.02, '正式页面 9:16 播放器必须保持画幅');

    await page.getByText('字幕样式', { exact: true }).waitFor();
    await page.getByText('字体', { exact: true }).waitFor();
    await page.getByText('字号', { exact: true }).waitFor();
    await page.getByText('描边', { exact: true }).waitFor();

    const openCoverDrawer = async () => {
      await page.getByRole('button', { name: /视频封面设置/ }).click();
      return page.getByRole('dialog', { name: '精调封面' });
    };
    let coverDialog = await openCoverDrawer();
    await coverDialog.waitFor();
    assert.equal(
      await page.getByRole('button', { name: '应用封面' }).evaluate((button) => getComputedStyle(button).backgroundColor),
      'rgb(0, 113, 227)',
      '封面抽屉的主操作按钮必须保持蓝色可见，不能因 Portal 脱离主题变量作用域而变透明',
    );
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
    await coverDialog.getByRole('button', { name: /a\.mp4/ }).waitFor();
    assert.equal(await page.getByRole('slider', { name: '封面截帧时间' }).inputValue(), '1', '抽屉必须恢复真实截帧时间');

    const groupWritesBeforeCancel = groupPatchBodies.length;
    await page.getByLabel('主标题文字').fill('取消不保存');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(groupPatchBodies.length, groupWritesBeforeCancel, '点击取消不得提交任何 group PATCH');
    await page.setViewportSize({ width: 1440, height: 720 });
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
    await coverDialog.getByRole('button', { name: /b\.mp4/ }).click();
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
    const coverCanvas = coverDialog.locator('canvas');
    const coverCanvasBox = await coverCanvas.boundingBox();
    assert.ok(coverCanvasBox, '真实封面画布必须可交互');
    assert.ok(Math.abs(coverCanvasBox.width / coverCanvasBox.height - 9 / 16) < 0.01, `9:16 封面画布在低视口下也不得被纵向压扁或拉伸（实测 ${coverCanvasBox.width.toFixed(1)}×${coverCanvasBox.height.toFixed(1)}）`);
    assert.equal(await page.getByRole('button', { name: /拖动(画面|主标题|副标题)/ }).count(), 0, '封面不得再显示拖动目标切换按钮');
    await page.mouse.move(coverCanvasBox.x + coverCanvasBox.width / 2, coverCanvasBox.y + coverCanvasBox.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(coverCanvasBox.x + coverCanvasBox.width / 2 + 28, coverCanvasBox.y + coverCanvasBox.height * 0.35 + 16, { steps: 4 });
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

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.locator('[data-track="video"]').waitFor();
    await page.getByRole('button', { name: /视频封面设置/ }).waitFor();
    await page.getByText('已自定义', { exact: false }).first().waitFor();
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
    await page.locator('[data-track="video"]').waitFor();
    coverDialog = await openCoverDrawer();
    await page.getByRole('button', { name: '电商蓝橙', exact: true }).waitFor();
    await primaryControls.locator('input[type="color"]').first().fill('#000000').catch(() => undefined);
    await page.getByRole('button', { name: '电商蓝橙', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: '主标题' }).locator('xpath=../..').locator('input[type="color"]').first().inputValue(), '#ff3300', '重启后应用 V2 预设必须恢复样式');
    await page.getByRole('button', { name: '删除预设 电商蓝橙' }).click();
    assert.equal(savedPresets.length, 0, '删除预设必须持久化到服务端');
    await page.getByRole('button', { name: '取消', exact: true }).click();

    const safeAreaButton = page.locator('button[aria-label="显示安全区"]');
    assert.equal(await safeAreaButton.count(), 1, '视频预览必须渲染安全区按钮');
    assert.ok(await safeAreaButton.boundingBox(), '安全区按钮在竖屏预览底栏必须可见且可点击');
    await safeAreaButton.click();
    const hideSafeAreaButton = page.locator('button[aria-label="隐藏安全区"]');
    assert.equal(await hideSafeAreaButton.getAttribute('aria-pressed'), 'true', '安全区按钮必须暴露开启状态');
    await page.getByLabel('4% 预览安全区').waitFor();
    await hideSafeAreaButton.click();
    assert.equal(await page.getByLabel('4% 预览安全区').count(), 0, '再次点击必须隐藏预览安全区');

    const playbackPosition = page.getByRole('slider', { name: '播放位置' });
    await playbackPosition.fill('4');
    const timelineContent = page.locator('[data-testid="mixcut-timeline-scroll"] > div');
    await timelineContent.scrollIntoViewIfNeeded();
    const contentBox = await timelineContent.boundingBox();
    assert.ok(contentBox, '正式时间轴内容必须可见');
    await timelineContent.dispatchEvent('pointerdown', { bubbles: true, clientX: contentBox.x + 1, clientY: contentBox.y + 30, pointerId: 1, pointerType: 'mouse' });
    await expectEventually(async () => Number(await playbackPosition.inputValue()) <= 1 / 24, `点击时间轴开头应回到封面 0 秒（当前 ${await playbackPosition.inputValue()}）`);

    await playbackPosition.fill('4');
    const playhead = page.getByRole('button', { name: '拖动播放头' });
    await playhead.scrollIntoViewIfNeeded();
    const playheadBox = await playhead.boundingBox();
    assert.ok(playheadBox, '播放头必须可拖动');
    const playheadVisual = await playhead.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      height: element.getBoundingClientRect().height,
    }));
    assert.notEqual(playheadVisual.backgroundColor, 'rgba(0, 0, 0, 0)', '播放头必须显示贯穿时间轴的实线，不能只剩顶部小点');
    assert.ok(playheadVisual.height > 150, '播放头实线必须贯穿时间尺与全部轨道');
    const lastPlayedNarrationBar = page.locator('[data-track="narration"] [data-played]').last();
    const lastPlayedNarrationBarBox = await lastPlayedNarrationBar.boundingBox();
    assert.ok(lastPlayedNarrationBarBox, '口播波形必须显示已播放区域');
    const waveformPlayheadDelta = Math.abs(
      lastPlayedNarrationBarBox.x + lastPlayedNarrationBarBox.width - (playheadBox.x + playheadBox.width / 2),
    );
    assert.ok(waveformPlayheadDelta <= 6, `口播波形已播放终点必须与黄色播放线对齐（实测相差 ${waveformPlayheadDelta.toFixed(1)}px）`);
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

    // 素材替换列（V2 新功能，规格 §6.5）：选中片段后点击另一个素材，直接替换该片段的视频来源。
    const replaceResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e') && response.request().method() === 'PATCH');
    await page.locator('[data-clip-id="clip-a"]').click();
    await page.getByRole('button', { name: /b\.mp4/ }).click();
    await replaceResponse;
    assert.equal(variantPatchBodies.at(-1)?.type, 'replace_clip');
    assert.equal(variantPatchBodies.at(-1)?.clipId, 'clip-a');
    assert.equal(variantPatchBodies.at(-1)?.videoJobId, 'video-b');
    assert.equal(variantPatchBodies.at(-1)?.sourceFingerprint, 'fingerprint-b');
    assert.equal(savedGroup.variants[0].timeline.clips.find((clip) => clip.id === 'clip-a')?.videoJobId, 'video-b', 'mock 服务端必须保存替换后的素材');

    // V2 固定时间轴缩放为 60px/秒（不再提供缩放滑杆），内容超出可视宽度时改为横向滚动；
    // 标签列现在完全在滚动容器之外（不是 sticky），横滚后不应发生任何位移。
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.locator('[data-track="video"]').waitFor();
    assert.equal(await page.getByRole('slider', { name: '时间轴缩放' }).count(), 0, 'V2 时间轴不再提供缩放控件');
    const timelineScroll = page.locator('[data-testid="mixcut-timeline-scroll"]');
    const timelineLabels = page.locator('section[aria-label="智能混剪时间轴"] > div').first();
    const scrollBefore = await timelineScroll.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    assert.ok(scrollBefore.scrollWidth > scrollBefore.clientWidth, '正式时间轴必须产生真实横向滚动范围（无需缩放）');
    const stickyLeftBefore = await timelineLabels.evaluate((element) => element.getBoundingClientRect().left);
    await timelineScroll.evaluate((element) => { element.scrollLeft = Math.min(200, element.scrollWidth - element.clientWidth); });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    const scrolledLeft = await timelineScroll.evaluate((element) => element.scrollLeft);
    const stickyLeftAfter = await timelineLabels.evaluate((element) => element.getBoundingClientRect().left);
    assert.ok(scrolledLeft > 0, '正式时间轴必须可以实际横向滚动');
    assert.ok(Math.abs(stickyLeftAfter - stickyLeftBefore) <= 0.5, '横滚后标签列必须保持原位（labels 在滚动容器之外）');
    await timelineScroll.evaluate((element) => { element.scrollLeft = 0; });
    await page.setViewportSize({ width: 1440, height: 1100 });

    // 直接拖拽时间轴片段自身的裁剪手柄（保留自 V1 的能力，VideoBlock 内建 trim 支持）。
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
    await page.locator('[data-track="video"]').waitFor();
    const widthAfterTrimReload = (await page.locator('[data-clip-id="clip-a"]').boundingBox())?.width ?? 0;
    assert.ok(Math.abs(widthAfterTrimReload - widthAfterTrim) <= 1, '重载后必须恢复服务端保存的裁剪宽度');

    // V2 新增：双击片段打开专门的 Trim 截取条（规格 §6.7），拖动蓝色选择框调整入点。
    // 注：前面的排序测试已把顺序换成 [clip-b, clip-a]，所以此刻 clip-a 是第 2 个片段、clip-b 是第 1 个。
    await page.locator('[data-clip-id="clip-a"]').dblclick();
    await page.getByText(/截取片段 #2/).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText(/截取片段 #2/).waitFor({ state: 'detached' });

    const clipBTrimTarget = page.locator('[data-clip-id="clip-b"]');
    await clipBTrimTarget.dblclick();
    await page.getByText(/截取片段 #1/).waitFor();
    const trimSel = page.locator('[class*="trimSel"]');
    const trimSelBoxBefore = await trimSel.boundingBox();
    assert.ok(trimSelBoxBefore, 'Trim 选择框必须可见');
    const dialogTrimResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e') && response.request().method() === 'PATCH');
    await page.mouse.move(trimSelBoxBefore.x + trimSelBoxBefore.width / 2, trimSelBoxBefore.y + trimSelBoxBefore.height / 2);
    await page.mouse.down();
    await page.mouse.move(trimSelBoxBefore.x + trimSelBoxBefore.width / 2 + 40, trimSelBoxBefore.y + trimSelBoxBefore.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await dialogTrimResponse;
    const dialogTrimRequest = variantPatchBodies.at(-1);
    assert.equal(dialogTrimRequest?.type, 'trim_clip');
    assert.equal(dialogTrimRequest?.clipId, 'clip-b');
    assert.ok(dialogTrimRequest.sourceInFrame > 0, '向右拖动选择框必须推迟源入点');
    assert.equal(dialogTrimRequest.sourceOutFrame - dialogTrimRequest.sourceInFrame, 120, 'Trim 对话框拖动只平移窗口，不改变片段时长');
    await page.getByText(/截取片段 #1/).waitFor({ state: 'detached' });

    const deleteResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e') && response.request().method() === 'PATCH');
    await page.locator('[data-clip-id="clip-a"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除片段' }).click();
    await deleteResponse;
    assert.equal(variantPatchBodies.at(-1)?.type, 'delete_clip', '右键删除必须提交持久化 delete_clip 命令');
    assert.equal(variantPatchBodies.at(-1)?.clipId, 'clip-a');
    await page.locator('[data-clip-id="clip-a"]').waitFor({ state: 'detached' });

    const insertResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: /a\.mp4/ }).click();
    await insertResponse;
    const insertRequest = variantPatchBodies.at(-1);
    assert.equal(insertRequest?.type, 'insert_clip', '删除形成缺口后点击素材必须提交插入命令');
    assert.equal(insertRequest?.videoJobId, 'video-a');
    assert.equal(insertRequest?.timelineInFrame, 120, '素材必须从第一个视频缺口起点插入');
    await page.locator('[data-clip-id^="clip-inserted-"]').waitFor();

    const playButton = page.getByRole('button', { name: '播放成片' });
    await playButton.click();
    await page.getByRole('button', { name: '暂停' }).waitFor();
    await page.getByRole('button', { name: /AI 智能创作/ }).click();
    // V2 第 3 步只在 activeStep===2 时挂载 PreviewStep（不再是全步骤常驻 + CSS 隐藏），
    // 离开第三步会把预览连同播放器一起卸载，而不是仅仅停止播放。
    await expectEventually(async () => await page.locator('button[aria-label="播放成片"]').count() === 0, '切出第三步必须卸载预览播放器');
    // 此刻第 2 步 CreationStep 可见，其「去预览调整」CTA 文案也含「预览调整」子串，
    // 与左侧步骤条按钮同名，必须限定在步骤条 nav 内点击以消除歧义。
    const stepNav = page.getByRole('navigation', { name: '智能混剪步骤' });
    await stepNav.getByRole('button', { name: /预览调整/ }).click();
    await page.locator('[data-track="video"]').waitFor();
    await page.getByRole('button', { name: '播放成片' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '暂停' }).count(), 0, '重新进入第三步后播放器必须以暂停状态重新挂载');

    savedGroup = { ...savedGroup, variants: [...savedGroup.variants, { ...savedGroup.variants[0], id: 'variant-e2e-b', indexNum: 2 }] };
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /预览调整/ }).click();
    await page.locator('[data-track="video"]').waitFor();
    await page.getByLabel('选择成片草稿').selectOption('variant-e2e-b');
    await page.getByRole('button', { name: '下一步：导出' }).click();
    await page.getByRole('heading', { name: '导出并写回项目' }).waitFor();
    assert.equal(await page.getByLabel('选择导出草稿').inputValue(), 'variant-e2e-b', '从预览进入导出必须保持当前草稿，不得回退第一条');
    await page.getByLabel('选择导出草稿').selectOption('variant-e2e');
    // V2 导出步不再用 <section aria-labelledby> 包裹（见 ExportStep.tsx），改用离标题最近的
    // <main> 祖先来限定查找范围，避免和顶栏里同样显示项目名称的文案混淆。
    const exportStep = page.getByRole('heading', { name: '导出并写回项目' }).locator('xpath=ancestor::main[1]');
    await exportStep.getByText('Mixcut E2E 项目', { exact: true }).waitFor();
    await exportStep.getByText('E2E-001', { exact: true }).waitFor();
    await exportStep.getByText('20260724', { exact: true }).waitFor();
    await exportStep.getByText('成片-E2E-001-20260724.mp4', { exact: true }).waitFor();
    await exportStep.getByText('工作台/Mixcut E2E 项目/成片/', { exact: true }).waitFor();
    assert.equal(await page.getByText('model-e2e', { exact: true }).count(), 0, '导出命名不得误用 projects.model');

    await page.evaluate(() => { globalThis.__mixcutForceCanvasMeasurementUnderreport = true; });
    overlayForcedError = 'overlay_measurement_mismatch';
    const rejectedOverlayResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-groups/group-e2e/overlay-bundles/9x16') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '开始导出' }).click();
    await rejectedOverlayResponse;
    await page.getByText('文字图层与当前样式不一致，请返回预览刷新后重试', { exact: true }).waitFor();
    assert.equal(renderPostBodies.length, 0, '图层校验失败时不得创建渲染任务');
    overlayForcedError = '';

    const overlayResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-groups/group-e2e/overlay-bundles/9x16') && response.request().method() === 'POST');
    const renderResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e/render') && response.request().method() === 'POST').catch(() => null);
    await page.getByRole('button', { name: '开始导出' }).click();
    await overlayResponse;
    assert.deepEqual(overlayMeasurementFailures, [], `浏览器生成的合法标题图层不得被生产宽度校验误拒：${JSON.stringify(overlayMeasurementFailures)}`);
    assert.ok(await renderResponse, '合法图层上传成功后必须继续创建渲染任务');
    assert.equal(overlayPostBodies.length, 2, '图层校验重试时，每次开始导出都必须重新冻结当前画幅的叠加层');
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
    const inlineVideoResponse = await page.evaluate(async () => {
      const response = await fetch('/api/final-edit-jobs/render-job-e2e/video');
      return { ok: response.ok, size: (await response.arrayBuffer()).byteLength };
    });
    assert.equal(inlineVideoResponse.ok, true, '导出视频预览 URL 必须返回成功媒体响应');
    assert.equal(inlineVideoResponse.size > 0, true, '导出视频预览响应不得为空');
    assert.equal(await page.getByRole('button', { name: '在文件夹中查看' }).count(), 0, '普通 Web 模式不得显示桌面文件定位入口');

    revealAvailable = true;
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /导出渲染/ }).click();
    await page.getByRole('heading', { name: '导出并写回项目' }).waitFor();
    await page.getByText('成片-E2E-001-20260724-02.mp4', { exact: true }).waitFor();
    await page.getByRole('button', { name: '在文件夹中查看' }).click();
    assert.deepEqual(revealRequests, [null], '文件定位请求不得接受或泄露客户端路径');

    // 回归：匹配诊断必须在第 3 步可见；真实缺口显示红色 blocking，语义/短素材
    // 兜底显示黄色 warning，不再只等到第 4 步导出才第一次露面。
    savedGroup = { ...savedGroup, variants: savedGroup.variants.map((item) => item.id === savedGroup.variants[0].id ? { ...item, issues: [
      { code: 'timeline_gap', severity: 'blocking', message: '正文 0–536 帧缺少画面' },
      { code: 'material_gap', severity: 'blocking', message: '句段 segment-1 素材不足，保留时间线缺口', targetId: 'segment-1' },
      { code: 'semantic_fallback', severity: 'warning', message: '语义评分不可用，本次已使用确定性关键词降级匹配' },
    ] } : item) };
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('navigation', { name: '智能混剪步骤' }).getByRole('button', { name: /预览调整/ }).click();
    await page.locator('[data-track="video"]').waitFor();
    await page.getByText('正文 0–536 帧缺少画面', { exact: true }).waitFor();
    await page.getByText('句段 segment-1 素材不足，保留时间线缺口', { exact: true }).waitFor();
    await page.getByText('语义评分不可用，本次已使用确定性关键词降级匹配', { exact: true }).waitFor();

    // 回归：真实环境实测过一次「预览调整」布局炸裂——prepare job 已 succeeded（第 2 步会出现
    // 「去预览调整」CTA），但 group 还没到 ready/partial（variants 未最终落定），此时点 CTA 会让
    // activeStep===2 而 preparedGroup 仍是 null。.bodyPreview 六列网格只有在真正渲染 PreviewStep
    // 的五个子节点时列数才对得上；退回的 emptyState 只有一个 <main>，网格会把它自动摆进「素材替换」
    // 那条窄列（真实浏览器里如果之前折叠过该列，会窄到中文逐字换行）。断言：辅栏必须还在、
    // 空状态文案必须落在宽的主列而不是被挤扁。
    savedGroup = { ...savedGroup, status: 'editing' };
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('navigation', { name: '智能混剪步骤' }).getByRole('button', { name: /AI 智能创作/ }).click();
    const previewCta = page.getByRole('button', { name: '去预览调整' });
    await previewCta.waitFor();
    await previewCta.click();
    await page.getByText('预览草稿尚未准备完成').waitFor();
    const emptyStateLayout = await page.evaluate(() => {
      const main = document.querySelector('[class*="mainCol"]');
      const sideCol = document.querySelector('[class*="sideCol"]');
      return {
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        sideColVisible: sideCol ? getComputedStyle(sideCol).display !== 'none' : false,
      };
    });
    assert.ok(emptyStateLayout.sideColVisible, 'preparedGroup 未就绪时辅栏（当前素材组/本组概览）不得被 .bodyPreview 误隐藏');
    assert.ok(emptyStateLayout.mainWidth > 500, `preparedGroup 未就绪时空状态必须落在宽主列，不是被挤进素材替换窄列（实测 ${emptyStateLayout.mainWidth}px）`);

    // Script V3 Phase 6：真实 TTS 超限必须停在可恢复的 review，而不是失败或继续匹配。
    // 浏览器依次验证一次智能贴合、手工修改重试、明确接受实际时长，以及 warning 在预览/导出持续存在。
    const reviewGate = {
      version: 1, narrationHash: 'duration-review-hash', targetTotalUs: 15_000_000, targetNarrationUs: 14_166_667,
      actualNarrationUs: 24_766_667, actualTotalUs: 25_600_000, toleranceUs: 750_000, deltaUs: 10_600_000,
      status: 'needs_input', reason: 'too_long', smartFitAttempts: 0, checkedAt: '2026-07-28T01:00:00.000Z', acceptedAt: null,
    };
    durationReadyGroup = { ...createFormalGroup(), narrationDurationUs: 24_766_667, totalDurationUs: 25_600_000, durationGate: reviewGate };
    currentDurationJob = {
      id: 'duration-job-initial', groupId: 'group-e2e', variantId: null, kind: 'prepare', status: 'needs_input', phase: 'duration_review', progress: 0.6,
      durationReview: {
        targetTotalSec: 15, targetNarrationSec: 14.166667, estimatedNarrationSec: 24.75,
        actualNarrationSec: 24.766667, actualTotalSec: 25.6, deltaSec: 10.6, toleranceSec: 0.75,
        reason: 'too_long', smartFitAvailable: true,
      },
      errorMessage: '真实 TTS 时长超出目标', startedAt: '2026-07-28T01:00:00.000Z', finishedAt: '2026-07-28T01:00:01.000Z',
    };
    savedGroup = { ...durationReadyGroup, status: 'needs_input', phase: 'duration_review', revision: 12, variants: [], jobs: [currentDurationJob] };
    durationJobGetCount = 0;
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('真实口播时长需要确认', { exact: true }).waitFor();
    await page.getByText('25.60 秒', { exact: true }).waitFor();
    await page.getByText('当前偏差较大，不能只靠自动加速解决；请优先智能贴合或精简口播文案。', { exact: true }).waitFor();
    const reviewGetCountAfterRestore = durationJobGetCount;
    await page.waitForTimeout(1_800);
    assert.equal(durationJobGetCount, reviewGetCountAfterRestore, 'needs_input 必须停止定时轮询，只允许恢复状态时读取一次');

    await page.getByRole('button', { name: '智能贴合时长' }).click();
    await page.getByRole('button', { name: '智能贴合已使用' }).waitFor();
    assert.equal(durationResolutionBodies[0].action, 'smart_fit');
    assert.equal(durationResolutionBodies[0].expectedRevision, 12);

    await page.getByLabel('语速').fill('1.2');
    await page.getByRole('textbox', { name: '口播文案' }).fill('手工精简第一段。\n手工精简第二段。');
    await page.getByRole('button', { name: '修改文案或语速后重试' }).click();
    await expectEventually(() => durationResolutionBodies.length >= 2, '手工重试必须发送 resolution action');
    assert.deepEqual(
      { action: durationResolutionBodies[1].action, speed: durationResolutionBodies[1].speed, editedNarrationText: durationResolutionBodies[1].editedNarrationText },
      { action: 'retry_with_changes', speed: 1.2, editedNarrationText: '手工精简第一段。\n手工精简第二段。' },
    );

    await page.getByRole('button', { name: '按实际时长继续' }).click();
    await page.getByRole('button', { name: '去预览调整' }).waitFor();
    assert.equal(durationResolutionBodies[2].action, 'accept_actual');
    await page.getByRole('button', { name: '去预览调整' }).click();
    const overrideWarning = '已明确按实际总时长 25.60 秒继续（目标 15.00 秒）';
    await page.getByText(overrideWarning, { exact: true }).waitFor();
    await page.getByRole('button', { name: '下一步：导出' }).click();
    await page.getByRole('heading', { name: '导出并写回项目' }).waitFor();
    await page.getByText(overrideWarning, { exact: true }).waitFor();

    await page.close();
    console.log('final-edit mixcut formal page smoke tests passed');
  } catch (error) {
    error.message = `${error.message}\nNext dev output:\n${server.output()}`;
    throw error;
  } finally {
    await releaseNextDevServer(server);
  }
} finally {
  await browser.close();
}
