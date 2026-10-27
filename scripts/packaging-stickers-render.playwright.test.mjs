// 运行：node scripts/packaging-stickers-render.playwright.test.mjs
// 使用 packaging 内置 chrome-headless-shell；真实调用 HyperFrames + FFmpeg 导出一条静态贴纸视频。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { resolvePackagingStickerAssets } from '../lib/media-core/packaging-sticker-assets.ts';
import { buildTimelineVars } from '../lib/media-core/packaging-runtime.ts';

const ROOT = process.cwd();
const PACKAGING_DIR = path.join(ROOT, 'packaging');
const CHROME = path.join(PACKAGING_DIR, 'runtime', 'chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
assert.ok(ffmpegPath && fs.existsSync(ffmpegPath), 'ffmpeg-static 不可用');
assert.ok(fs.existsSync(CHROME), `chrome-headless-shell 不存在：${CHROME}`);

function sticker(overrides = {}) {
  return {
    id: 'sticker_1',
    assetId: 'highlight',
    styleMode: 'fixed',
    fixedStyle: 'show',
    startFrame: 24,
    endFrame: 72,
    centerXPct: 50,
    centerYPct: 55,
    visualWidthPct: 60,
    rotationDeg: 0,
    trackIndex: 0,
    animation: 'none',
    origin: { kind: 'manual' },
    ...overrides,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`命令失败（${result.status}）：${path.basename(command)}\n${result.stderr || result.stdout || result.error?.message || ''}`);
  return result;
}

async function alphaInfo(file, region) {
  let pipeline = sharp(file);
  if (region) pipeline = pipeline.extract(region);
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0, alphaSum = 0, left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      alphaSum += alpha;
      if (alpha <= 8) continue;
      count++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const offsetX = region?.left ?? 0, offsetY = region?.top ?? 0;
  return { width: info.width, height: info.height, count, alphaSum, bbox: count ? [left + offsetX, top + offsetY, right + 1 + offsetX, bottom + 1 + offsetY] : null };
}

async function brightPixelCount(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.max(data[i], data[i + 1], data[i + 2]) > 80) count++;
  }
  return count;
}

function stickerGeometry(sticker, asset, width, height) {
  const [left, top, right, bottom] = asset.alpha_gt8_bbox;
  const imageWidth = sticker.visualWidthPct / 100 * width * asset.width / (right - left);
  const imageHeight = imageWidth * asset.height / asset.width;
  const imageLeft = sticker.centerXPct / 100 * width - (left + right) / 2 / asset.width * imageWidth;
  const imageTop = sticker.centerYPct / 100 * height - (top + bottom) / 2 / asset.height * imageHeight;
  return {
    imageLeft,
    imageTop,
    imageWidth,
    imageHeight,
    bbox: [
      imageLeft + left / asset.width * imageWidth,
      imageTop + top / asset.height * imageHeight,
      imageLeft + right / asset.width * imageWidth,
      imageTop + bottom / asset.height * imageHeight,
    ],
  };
}

function expectedRegion(bbox, width, height, padding = 6) {
  const left = Math.max(0, Math.floor(bbox[0]) - padding);
  const top = Math.max(0, Math.floor(bbox[1]) - padding);
  const right = Math.min(width, Math.ceil(bbox[2]) + padding);
  const bottom = Math.min(height, Math.ceil(bbox[3]) + padding);
  return { left, top, width: right - left, height: bottom - top };
}

async function assertStickerGeometry(file, sticker, asset, label) {
  const width = 270, height = 360;
  const expected = stickerGeometry(sticker, asset, width, height).bbox;
  const info = await alphaInfo(file, expectedRegion(expected, width, height));
  assert.ok(info.count > 100 && info.bbox, `${label} 应有可见像素`);
  expected.forEach((value, index) => assert.ok(Math.abs(info.bbox[index] - value) <= 4, `${label} 包围框轴 ${index}：实际 ${info.bbox[index]}，预期 ${value}`));
  return info;
}

async function readRgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

function pixelAt(raw, x, y) {
  const offset = (Math.round(y) * raw.info.width + Math.round(x)) * raw.info.channels;
  return [...raw.data.subarray(offset, offset + 4)];
}

function colorDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

async function assertUpperLayer(file, upperSticker, upperAsset, lowerSticker, lowerAsset, label) {
  const width = 270, height = 360;
  const upperGeometry = stickerGeometry(upperSticker, upperAsset, width, height);
  const lowerGeometry = stickerGeometry(lowerSticker, lowerAsset, width, height);
  const left = Math.max(0, Math.ceil(Math.max(upperGeometry.bbox[0], lowerGeometry.bbox[0])));
  const top = Math.max(0, Math.ceil(Math.max(upperGeometry.bbox[1], lowerGeometry.bbox[1])));
  const right = Math.min(width, Math.floor(Math.min(upperGeometry.bbox[2], lowerGeometry.bbox[2])));
  const bottom = Math.min(height, Math.floor(Math.min(upperGeometry.bbox[3], lowerGeometry.bbox[3])));
  const [upperRaw, lowerRaw, actualRaw] = await Promise.all([
    readRgba(path.join(PACKAGING_DIR, 'stickers', upperAsset.file)),
    readRgba(path.join(PACKAGING_DIR, 'stickers', lowerAsset.file)),
    readRgba(file),
  ]);
  const sourcePixel = (raw, geometry, asset, x, y) => {
    const sourceX = Math.round((x - geometry.imageLeft) / geometry.imageWidth * asset.width);
    const sourceY = Math.round((y - geometry.imageTop) / geometry.imageHeight * asset.height);
    if (sourceX < 0 || sourceY < 0 || sourceX >= raw.info.width || sourceY >= raw.info.height) return null;
    return pixelAt(raw, sourceX, sourceY);
  };
  const probes = [];
  for (let y = top; y < bottom && probes.length < 24; y += 3) {
    for (let x = left; x < right && probes.length < 24; x += 3) {
      const upper = sourcePixel(upperRaw, upperGeometry, upperAsset, x, y);
      const lower = sourcePixel(lowerRaw, lowerGeometry, lowerAsset, x, y);
      if (!upper || !lower || upper[3] < 250 || lower[3] < 250 || colorDistance(upper, lower) < 100) continue;
      probes.push({ x, y, upper, lower });
    }
  }
  assert.ok(probes.length >= 4, `${label} 未找到足够的上下层高对比重叠探测点`);
  const votes = probes.map((probe) => {
    const actual = pixelAt(actualRaw, probe.x, probe.y);
    const upperDistance = colorDistance(actual, probe.upper);
    const lowerDistance = colorDistance(actual, probe.lower);
    return { probe, actual, upperDistance, lowerDistance, upperWins: upperDistance < lowerDistance };
  });
  const upperWins = votes.filter((vote) => vote.upperWins).length;
  const first = votes[0];
  assert.ok(upperWins > votes.length / 2, `${label} 上层覆盖错误：${upperWins}/${votes.length} 点接近上层；首点实际 ${first.actual}，上层 ${first.probe.upper}，下层 ${first.probe.lower}`);
}

let browser;
let temporaryDir = '';
let passed = false;
try {
  temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-stickers-render-'));
  const previewStickers = [sticker(), sticker({ id: 'sticker_2', assetId: 'like', centerXPct: 30, centerYPct: 40, visualWidthPct: 25, rotationDeg: 25, trackIndex: 1 })];
  const previewAssets = resolvePackagingStickerAssets({ packagingDir: PACKAGING_DIR, template: 'overlay-variety', stickers: previewStickers });
  const previewVars = { totalSec: 4, coverSec: 20 / 24, pointCues: [], pointCuesMode: 'none', stickers: previewStickers, stickerAssets: previewAssets };
  // 源模板经应用路由预览时有共享资源回退；file:// 验收则按 package-video 的目录契约物化同一结构。
  const previewDir = path.join(temporaryDir, 'preview');
  fs.cpSync(path.join(PACKAGING_DIR, 'templates', 'overlay-variety'), previewDir, { recursive: true });
  fs.mkdirSync(path.join(previewDir, 'stickers'), { recursive: true });
  fs.copyFileSync(path.join(PACKAGING_DIR, 'stickers', 'runtime.js'), path.join(previewDir, 'stickers', 'runtime.js'));
  for (const file of new Set(Object.values(previewAssets).map((asset) => asset.file))) {
    fs.mkdirSync(path.dirname(path.join(previewDir, 'stickers', file)), { recursive: true });
    fs.copyFileSync(path.join(PACKAGING_DIR, 'stickers', file), path.join(previewDir, 'stickers', file));
  }
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript((vars) => { window.__hyperframes = { getVariables: () => vars }; }, previewVars);
  await page.goto(pathToFileURL(path.join(previewDir, 'index.html')).href);
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.packaging-sticker img')];
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
  }).catch(async (error) => {
    const debug = await page.evaluate(() => ({
      stickers: document.querySelectorAll('.packaging-sticker').length,
      images: [...document.querySelectorAll('.packaging-sticker img')].map((image) => ({ src: image.src, complete: image.complete, naturalWidth: image.naturalWidth })),
      hasRuntime: Boolean(window.__packagingStickerRuntime),
      hasTimeline: Boolean(window.__timelines?.overlay),
      vars: window.__hyperframes?.getVariables?.(),
    }));
    throw new Error(`${error.message}\n页面错误：${pageErrors.join(' | ') || '无'}\n${JSON.stringify(debug)}`);
  });

  for (const [frame, expected] of [[23, '0'], [24, '1'], [71, '1'], [72, '0'], [24, '1']]) {
    const opacity = await page.evaluate((time) => {
      const timeline = window.__timelines.overlay;
      timeline.pause();
      timeline.seek(time);
      return getComputedStyle(document.querySelector('[data-sticker-id="sticker_1"]')).opacity;
    }, frame / 24);
    assert.equal(opacity, expected, `第 ${frame} 帧可见性错误`);
  }

  const geometry = await page.evaluate((asset) => {
    const rootRect = document.getElementById('root').getBoundingClientRect();
    const image = document.querySelector('[data-sticker-id="sticker_1"] img');
    const rect = image.getBoundingClientRect();
    const [left, top, right, bottom] = asset.alpha_gt8_bbox;
    return {
      centerXPct: (rect.left + (left + right) / 2 / asset.width * rect.width - rootRect.left) / rootRect.width * 100,
      centerYPct: (rect.top + (top + bottom) / 2 / asset.height * rect.height - rootRect.top) / rootRect.height * 100,
      visualWidthPct: (right - left) / asset.width * rect.width / rootRect.width * 100,
      upperTrackZ: getComputedStyle(document.querySelector('[data-sticker-id="sticker_1"]')).zIndex,
      lowerTrackZ: getComputedStyle(document.querySelector('[data-sticker-id="sticker_2"]')).zIndex,
      stickerLayerZ: getComputedStyle(document.getElementById('sticker-layer')).zIndex,
      stageZ: getComputedStyle(document.querySelector('.stage')).zIndex,
      dynamicLayerZ: getComputedStyle(document.getElementById('dyn')).zIndex,
    };
  }, previewAssets.sticker_1);
  assert.ok(Math.abs(geometry.centerXPct - 50) < 0.02, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.centerYPct - 55) < 0.02, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.visualWidthPct - 60) < 0.02, JSON.stringify(geometry));
  assert.ok(Number(geometry.upperTrackZ) > Number(geometry.lowerTrackZ), 'trackIndex 越小必须越靠上');
  assert.ok(Number(geometry.stickerLayerZ) < Number(geometry.stageZ), '贴纸必须低于封面/包装文字舞台');
  assert.ok(Number(geometry.stickerLayerZ) < Number(geometry.dynamicLayerZ), '贴纸必须低于正片卖点');
  const rotation = await page.evaluate((asset) => {
    const outer = document.querySelector('[data-sticker-id="sticker_2"]');
    const layer = outer.querySelector('.packaging-sticker-rotation');
    const style = getComputedStyle(layer);
    const [left, top, right, bottom] = asset.alpha_gt8_bbox;
    const outerRect = outer.getBoundingClientRect();
    const [originX, originY] = style.transformOrigin.split(' ').map(parseFloat);
    return {
      transform: style.transform,
      originX,
      originY,
      expectedX: (left + right) / 2 / asset.width * outerRect.width,
      expectedY: (top + bottom) / 2 / asset.height * outerRect.height,
    };
  }, previewAssets.sticker_2);
  assert.notEqual(rotation.transform, 'none');
  assert.notEqual(rotation.transform, 'matrix(1, 0, 0, 1, 0, 0)');
  assert.ok(Math.abs(rotation.originX - rotation.expectedX) < 0.1, JSON.stringify(rotation));
  assert.ok(Math.abs(rotation.originY - rotation.expectedY) < 0.1, JSON.stringify(rotation));
  assert.deepEqual(pageErrors, [], '模板浏览器运行时不应有脚本错误');

  const animationIds = ['soft', 'bounce', 'rise', 'slide', 'zoom', 'none'];
  const animatedStickers = animationIds.map((animation, index) => sticker({
    id: `anim_${animation}`,
    animation,
    centerXPct: 15 + index * 12,
    centerYPct: 55,
    visualWidthPct: 18,
  }));
  const animatedAssets = resolvePackagingStickerAssets({ packagingDir: PACKAGING_DIR, template: 'overlay-variety', stickers: animatedStickers });
  const animatedPage = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1 });
  const animatedErrors = [];
  animatedPage.on('pageerror', (error) => animatedErrors.push(error.message));
  await animatedPage.addInitScript((vars) => { window.__hyperframes = { getVariables: () => vars }; }, {
    totalSec: 4,
    coverSec: 20 / 24,
    pointCues: [],
    pointCuesMode: 'none',
    stickers: animatedStickers,
    stickerAssets: animatedAssets,
    stickerTemplate: 'overlay-variety',
  });
  await animatedPage.goto(pathToFileURL(path.join(previewDir, 'index.html')).href);
  await animatedPage.waitForFunction(() => {
    const images = [...document.querySelectorAll('.packaging-sticker img')];
    return images.length === 6 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  const readAnimationFrame = (frame) => animatedPage.evaluate((time) => {
    const timeline = window.__timelines.overlay;
    timeline.pause();
    timeline.seek(time);
    return Object.fromEntries([...document.querySelectorAll('.packaging-sticker')].map((element) => {
      const motion = element.querySelector('.packaging-sticker-motion');
      const matrix = new DOMMatrix(getComputedStyle(motion).transform);
      return [element.dataset.stickerId.replace('anim_', ''), {
        opacity: Number(getComputedStyle(element).opacity),
        x: matrix.m41,
        y: matrix.m42,
        scale: matrix.a,
      }];
    }));
  }, frame / 24);
  const atStart = await readAnimationFrame(24);
  const entering = await readAnimationFrame(26);
  const stable = await readAnimationFrame(48);
  const exiting = await readAnimationFrame(70);
  const atEnd = await readAnimationFrame(72);
  for (const animation of animationIds) {
    assert.equal(atEnd[animation].opacity, 0, `${animation} 必须在 endFrame 完全隐藏`);
    assert.equal(stable[animation].opacity, 1, `${animation} 稳定段必须完全不透明`);
    assert.ok(Math.abs(stable[animation].x) < 0.01 && Math.abs(stable[animation].y) < 0.01 && Math.abs(stable[animation].scale - 1) < 0.01, `${animation} 稳定段必须回到原始几何`);
    if (animation === 'none') {
      assert.equal(atStart.none.opacity, 1);
      assert.equal(entering.none.opacity, 1);
      assert.equal(exiting.none.opacity, 1);
      continue;
    }
    assert.ok(atStart[animation].opacity < 0.001, `${animation} 入场首帧应从透明开始`);
    assert.ok(entering[animation].opacity > 0 && entering[animation].opacity < 1, `${animation} 入场中应渐显`);
    assert.ok(exiting[animation].opacity > 0 && exiting[animation].opacity < 1, `${animation} 退场中应渐隐`);
  }
  assert.ok(entering.soft.y > 0.1 && exiting.soft.y < -0.1, '柔和应上浮进入并轻微上移退场');
  assert.ok(Math.abs(entering.bounce.scale - 1) > 0.02 && exiting.bounce.scale < 0.99, 'Q 弹应缩放进入并缩小退场');
  assert.ok(entering.rise.y > 0.1 && exiting.rise.y > 0.1, '上浮应从下方进入并向下方退场');
  assert.ok(entering.slide.x < -0.1 && exiting.slide.x > 0.1, '滑入应从左侧进入并向右侧退场');
  assert.ok(entering.zoom.scale < 0.99 && exiting.zoom.scale < 0.99, '缩放应放大进入并缩小退场');
  assert.deepEqual(animatedErrors, [], '六种动效运行时不应有脚本错误');
  await animatedPage.close();
  await browser.close();
  browser = undefined;

  const baseVideo = path.join(temporaryDir, 'base.mp4');
  const outputVideo = path.join(temporaryDir, 'packaged.mp4');
  const templateDir = path.join(PACKAGING_DIR, 'templates', 'overlay-minimal');
  run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x101010:s=270x360:r=24:d=4', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', baseVideo]);

  const exportSticker = sticker({ id: 'export_sticker' });
  const exportAssets = resolvePackagingStickerAssets({ packagingDir: PACKAGING_DIR, template: 'overlay-minimal', stickers: [exportSticker] });
  const vars = buildTimelineVars({
    vars: { title: '', subtitle: '', desc: '', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '' },
    totalSec: 4,
    coverSec: 20 / 24,
    pointCues: [],
    pointCuesMode: 'none',
    stickers: [exportSticker],
    stickerDefaults: { animation: 'none' },
    stickerAssets: exportAssets,
    template: 'overlay-minimal',
  });
  const varsPath = path.join(temporaryDir, 'vars.json');
  fs.writeFileSync(varsPath, JSON.stringify(vars));

  const badVarsPath = path.join(temporaryDir, 'bad-vars.json');
  const badVars = { ...vars, stickerAssets: { export_sticker: { ...exportAssets.export_sticker, sha256: '0'.repeat(64) } } };
  fs.writeFileSync(badVarsPath, JSON.stringify(badVars));
  const badResult = spawnSync(process.execPath, [path.join(PACKAGING_DIR, 'package-video.mjs'), baseVideo, badVarsPath, path.join(temporaryDir, 'bad.mp4'), templateDir], {
    cwd: ROOT,
    env: { ...process.env, CREATIVE_STUDIO_PACKAGING_WORK_ROOT: path.join(temporaryDir, 'bad-work') },
    encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.notEqual(badResult.status, 0, '哈希错误必须中止导出');
  assert.match(`${badResult.stdout}\n${badResult.stderr}`, /SHA-256 校验失败/);

  run(process.execPath, [path.join(PACKAGING_DIR, 'package-video.mjs'), baseVideo, varsPath, outputVideo, templateDir], {
    cwd: ROOT,
    env: { ...process.env, CREATIVE_STUDIO_PACKAGING_WORK_ROOT: path.join(temporaryDir, 'work') },
    timeout: 9 * 60_000,
  });
  assert.ok(fs.statSync(outputVideo).size > 0, '正式 MP4 未生成');
  const overlayWebm = path.join(temporaryDir, 'overlay.webm');
  assert.ok(fs.statSync(overlayWebm).size > 0, '透明 overlay WebM 未生成');

  const extract = (input, frame, output, alpha = false) => run(ffmpegPath, [
    '-y', '-v', 'error', ...(alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', input,
    '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', ...(alpha ? ['-pix_fmt', 'rgba'] : []), output,
  ], { timeout: 60_000 });
  const overlayFrames = {};
  for (const frame of [23, 24, 71, 72]) {
    const file = path.join(temporaryDir, `overlay-${frame}.png`);
    extract(overlayWebm, frame, file, true);
    overlayFrames[frame] = await alphaInfo(file);
  }
  assert.equal(overlayFrames[23].count, 0, '开始前一帧必须完全隐藏');
  assert.equal(overlayFrames[72].count, 0, '结束帧属于开区间，必须完全隐藏');
  assert.ok(overlayFrames[24].count > 100, '开始帧必须显示贴纸');
  assert.ok(overlayFrames[71].count > 100, '结束前最后一帧必须显示贴纸');

  const asset = exportAssets.export_sticker;
  const [left, top, right, bottom] = asset.alpha_gt8_bbox;
  const width = overlayFrames[24].width, height = overlayFrames[24].height;
  const imageWidth = exportSticker.visualWidthPct / 100 * width * asset.width / (right - left);
  const imageHeight = imageWidth * asset.height / asset.width;
  const imageLeft = exportSticker.centerXPct / 100 * width - (left + right) / 2 / asset.width * imageWidth;
  const imageTop = exportSticker.centerYPct / 100 * height - (top + bottom) / 2 / asset.height * imageHeight;
  const expected = [
    imageLeft + left / asset.width * imageWidth,
    imageTop + top / asset.height * imageHeight,
    imageLeft + right / asset.width * imageWidth,
    imageTop + bottom / asset.height * imageHeight,
  ];
  overlayFrames[24].bbox.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= 4, `导出包围框轴 ${index}：实际 ${value}，预期 ${expected[index]}`));
  overlayFrames[71].bbox.forEach((value, index) => assert.ok(Math.abs(value - overlayFrames[24].bbox[index]) <= 1, '静态贴纸在稳定区间不应漂移'));

  const finalFrame24 = path.join(temporaryDir, 'final-24.png');
  const finalFrame72 = path.join(temporaryDir, 'final-72.png');
  extract(outputVideo, 24, finalFrame24);
  extract(outputVideo, 72, finalFrame72);
  const visibleAt24 = await brightPixelCount(finalFrame24);
  const visibleAt72 = await brightPixelCount(finalFrame72);
  assert.ok(visibleAt24 > visibleAt72 + 100, `最终 MP4 未体现贴纸：开始帧 ${visibleAt24}，结束帧 ${visibleAt72}`);

  const acceptanceBase = path.join(temporaryDir, 'acceptance-base.mp4');
  run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x101010:s=270x360:r=24:d=9', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', acceptanceBase]);
  const acceptanceTemplates = ['overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'];
  const bboxCenter = (info) => [(info.bbox[0] + info.bbox[2]) / 2, (info.bbox[1] + info.bbox[3]) / 2];
  for (const template of acceptanceTemplates) {
    const outputDir = path.join(temporaryDir, 'acceptance', template);
    fs.mkdirSync(outputDir, { recursive: true });
    const animated = animationIds.map((animation, index) => sticker({
      id: `${template}_${animation}`,
      assetId: 'highlight',
      styleMode: 'follow-template',
      fixedStyle: null,
      animation,
      startFrame: 24 + index * 24,
      endFrame: 48 + index * 24,
      centerXPct: index % 2 === 0 ? 30 : 70,
      centerYPct: 45,
      visualWidthPct: 18,
      trackIndex: 0,
    }));
    const lower = sticker({ id: `${template}_lower`, assetId: 'highlight', styleMode: 'follow-template', fixedStyle: null, startFrame: 176, endFrame: 200, centerXPct: 50, centerYPct: 55, visualWidthPct: 45, trackIndex: 1, animation: 'none' });
    const upper = sticker({ id: `${template}_upper`, assetId: 'recommend', styleMode: 'follow-template', fixedStyle: null, startFrame: 176, endFrame: 200, centerXPct: 50, centerYPct: 55, visualWidthPct: 20, trackIndex: 0, animation: 'none' });
    const special = sticker({ id: `${template}_special`, assetId: 'special', styleMode: 'fixed', fixedStyle: 'show', startFrame: 176, endFrame: 200, centerXPct: 15, centerYPct: 25, visualWidthPct: 12, trackIndex: 2, animation: 'none' });
    const cross = sticker({ id: `${template}_cross`, assetId: 'like', styleMode: 'fixed', fixedStyle: 'show', startFrame: 176, endFrame: 200, centerXPct: 85, centerYPct: 25, visualWidthPct: 12, trackIndex: 3, animation: 'none' });
    const acceptanceStickers = [...animated, lower, upper, special, cross];
    const acceptanceAssets = resolvePackagingStickerAssets({ packagingDir: PACKAGING_DIR, template, stickers: acceptanceStickers });
    const acceptanceVars = buildTimelineVars({
      vars: { title: '', subtitle: '', desc: '', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '' },
      totalSec: 9,
      coverSec: 20 / 24,
      pointCues: [],
      pointCuesMode: 'none',
      stickers: acceptanceStickers,
      stickerDefaults: { animation: 'follow-template' },
      stickerAssets: acceptanceAssets,
      template,
    });
    const acceptanceVarsPath = path.join(outputDir, 'vars.json');
    const acceptanceOutput = path.join(outputDir, 'packaged.mp4');
    fs.writeFileSync(acceptanceVarsPath, JSON.stringify(acceptanceVars));
    run(process.execPath, [path.join(PACKAGING_DIR, 'package-video.mjs'), acceptanceBase, acceptanceVarsPath, acceptanceOutput, path.join(PACKAGING_DIR, 'templates', template)], {
      cwd: ROOT,
      env: { ...process.env, CREATIVE_STUDIO_PACKAGING_WORK_ROOT: path.join(outputDir, 'work') },
      timeout: 9 * 60_000,
    });
    const acceptanceOverlay = path.join(outputDir, 'overlay.webm');
    assert.ok(fs.statSync(acceptanceOutput).size > 0 && fs.statSync(acceptanceOverlay).size > 0, `${template} 正式 MP4 与透明 WebM 必须生成`);
    const extractAcceptance = (frame, name, input = acceptanceOverlay, alpha = true) => {
      const file = path.join(outputDir, `${name}.png`);
      extract(input, frame, file, alpha);
      return file;
    };
    for (let index = 0; index < animated.length; index += 1) {
      const item = animated[index];
      const animation = animationIds[index];
      const label = `${template}/${animation}`;
      const asset = acceptanceAssets[item.id];
      const atStartInfo = await alphaInfo(extractAcceptance(item.startFrame, `${animation}-start`));
      const enteringInfo = await alphaInfo(extractAcceptance(item.startFrame + 2, `${animation}-entering`));
      const stableInfo = await assertStickerGeometry(extractAcceptance(item.startFrame + 16, `${animation}-stable`), item, asset, `${label} 稳定段`);
      const exitingInfo = await alphaInfo(extractAcceptance(item.endFrame - 2, `${animation}-exiting`));
      const atEndInfo = await alphaInfo(
        extractAcceptance(item.endFrame, `${animation}-end`),
        expectedRegion(stickerGeometry(item, asset, 270, 360).bbox, 270, 360),
      );
      assert.equal(atEndInfo.count, 0, `${label} 必须在 endFrame 隐藏`);
      if (animation === 'none') {
        assert.ok(atStartInfo.count > 100 && exitingInfo.count > 100, `${label} 无动画应直接出现并保持到终点前`);
        continue;
      }
      assert.equal(atStartInfo.count, 0, `${label} 入场首帧应透明`);
      assert.ok(enteringInfo.alphaSum < stableInfo.alphaSum, `${label} 入场透明度应低于稳定段`);
      assert.ok(exitingInfo.alphaSum < stableInfo.alphaSum, `${label} 退场透明度应低于稳定段`);
      const enteringCenter = bboxCenter(enteringInfo);
      const exitingCenter = bboxCenter(exitingInfo);
      const stableCenter = bboxCenter(stableInfo);
      if (animation === 'soft') {
        assert.ok(enteringCenter[1] > stableCenter[1] + 1 && exitingCenter[1] < stableCenter[1] - 1, `${label} 上浮方向错误`);
      } else if (animation === 'rise') {
        assert.ok(enteringCenter[1] > stableCenter[1] + 1 && exitingCenter[1] > stableCenter[1] + 1, `${label} 上下方向错误`);
      } else if (animation === 'slide') {
        assert.ok(enteringCenter[0] < stableCenter[0] - 1 && exitingCenter[0] > stableCenter[0] + 1, `${label} 左右方向错误`);
      } else {
        const enteringWidth = enteringInfo.bbox[2] - enteringInfo.bbox[0];
        const exitingWidth = exitingInfo.bbox[2] - exitingInfo.bbox[0];
        const stableWidth = stableInfo.bbox[2] - stableInfo.bbox[0];
        assert.ok(enteringWidth < stableWidth - 1 && exitingWidth < stableWidth - 1, `${label} 缩放尺寸错误`);
      }
    }
    const staticFrame = extractAcceptance(188, 'static');
    await assertUpperLayer(staticFrame, upper, acceptanceAssets[upper.id], lower, acceptanceAssets[lower.id], `${template} 上下层`);
    await assertStickerGeometry(staticFrame, special, acceptanceAssets[special.id], `${template}/special 固定 show`);
    await assertStickerGeometry(staticFrame, cross, acceptanceAssets[cross.id], `${template}/跨风格固定 show`);
    const staticEnd = await alphaInfo(extractAcceptance(200, 'static-end'));
    assert.equal(staticEnd.count, 0, `${template} 静态贴纸必须在 endFrame 全部消失`);
    const finalVisible = await brightPixelCount(extractAcceptance(188, 'final-visible', acceptanceOutput, false));
    const finalHidden = await brightPixelCount(extractAcceptance(200, 'final-hidden', acceptanceOutput, false));
    assert.ok(finalVisible > finalHidden, `${template} 最终 MP4 未体现静态贴纸`);
    console.log(`四模板验收进度：${template} 正式导出与抽帧通过`);
  }

  passed = true;
  console.log('贴纸真实渲染测试通过：四套模板正式导出、六动效逐帧、几何与透明度、多点像素层级、special/跨风格固定、终点隐藏、WebM alpha 与最终 MP4。');
} finally {
  if (browser) await browser.close();
  if (temporaryDir) {
    if (passed) fs.rmSync(temporaryDir, { recursive: true, force: true });
    else console.error(`测试产物保留供排查：${temporaryDir}`);
  }
}
