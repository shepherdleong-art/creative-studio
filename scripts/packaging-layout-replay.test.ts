// 运行：node scripts/packaging-layout-replay.test.ts
// 需要 packaging 内置 Chrome、真实模板、字体与贴纸素材。
// 回归目标：手动拖动的卖点/贴纸不得在 refit + Resolution 重放时回弹；未编辑的自动元素仍须正常重放。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolvePackagingAutoLayout } from '../lib/media-core/packaging-auto-layout-service.ts';
import { planPackagingStickerAutoLayout, type PackagingStickerPlanningAsset } from '../lib/media-core/packaging-sticker-planner.ts';
import { buildTimelineVars, resolvePackagingDir, resolvePackagingTemplateDir } from '../lib/media-core/packaging-runtime.ts';
import type { PackagingVars } from '../lib/media-core/packaging-vars.ts';
import { resolvePackagingStickerAssets } from '../lib/media-core/packaging-sticker-assets.ts';

const require = createRequire(path.resolve('packaging/package.json'));
const puppeteer = require('puppeteer-core');
const packagingDir = resolvePackagingDir();
const template = 'overlay-poster' as const;
const chrome = process.env.HYPERFRAMES_BROWSER_PATH
  || path.join(packagingDir, 'runtime', 'chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
assert.ok(fs.existsSync(chrome), `内置 Chrome 缺失：${chrome}`);

const { assets } = JSON.parse(fs.readFileSync(path.join(packagingDir, 'stickers', 'catalog.json'), 'utf8')) as { assets: PackagingStickerPlanningAsset[] };
const bodyFrames = 240;
const coverSec = 20 / 24;
const totalSec = (bodyFrames + 20) / 24;
const outputWidth = 1080;
const outputHeight = 1440;
const stickers = planPackagingStickerAutoLayout({
  bodyFrames, template, assets, animation: 'soft', autoGroupId: 'auto_replay',
  random: () => 0, createId: (index) => `s_replay_${index}`, outputWidth, outputHeight,
})!;
const vars: PackagingVars = {
  title: '测试产品', subtitle: '手动布局优先', point1: '舒适耐用', point2: '环保材质', point3: '',
  accent1: '', accent2: '', accent3: '',
};
const config = {
  enabled: true as const,
  template,
  varsOverrides: {},
  pointCues: [
    { id: 'p_replay_a', text: '舒适耐用', startSec: coverSec + 0.2, endSec: 3 },
    { id: 'p_replay_b', text: '环保材质', startSec: 3.2, endSec: 5.2 },
  ],
  pointCuesMode: 'timed' as const,
  pointCuesLayoutVersion: 2,
  layoutRuntimeBundleVersion: 2,
  stickers,
};
const resolution = await resolvePackagingAutoLayout({ config, vars, totalSec, coverSec, outputWidth, outputHeight });
assert.equal(resolution.status, 'resolved', '必须先得到有效 Resolution');
if (resolution.status !== 'resolved') throw new Error('布局未解析');

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-replay-test-'));
let browser;
try {
  copyDir(resolvePackagingTemplateDir(packagingDir, template), workDir);
  const sharedFonts = path.join(packagingDir, 'fonts');
  if (fs.existsSync(sharedFonts)) copyDir(sharedFonts, path.join(workDir, 'fonts'));
  fs.mkdirSync(path.join(workDir, 'stickers'), { recursive: true });
  fs.copyFileSync(path.join(packagingDir, 'stickers', 'runtime.js'), path.join(workDir, 'stickers', 'runtime.js'));
  fs.mkdirSync(path.join(workDir, 'auto-layout'), { recursive: true });
  for (const file of ['runtime.js', 'replay.js']) {
    fs.copyFileSync(path.join(packagingDir, 'auto-layout', file), path.join(workDir, 'auto-layout', file));
  }
  const stickerAssets = resolvePackagingStickerAssets({ packagingDir, template, stickers });
  for (const asset of Object.values(stickerAssets)) {
    const source = path.join(packagingDir, 'stickers', asset.file);
    const destination = path.join(workDir, 'stickers', asset.file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  const timelineVars = {
    ...buildTimelineVars({
      vars, totalSec, coverSec,
      pointCues: config.pointCues, pointCuesMode: config.pointCuesMode,
      stickers, stickerDefaults: { animation: 'soft' as const }, stickerAssets, template,
    }),
    pointCuesLayoutVersion: 2,
    layoutRuntimeBundleVersion: 2,
    layoutResolution: resolution,
  };
  const injection = `<style>html,body{margin:0;background:transparent!important}</style><script>window.__hyperframes={getVariables:()=>(${JSON.stringify(timelineVars).replace(/</g, '\\u003c')})};</script>`;
  let html = fs.readFileSync(path.join(workDir, 'index.html'), 'utf8')
    .replace(/data-duration="[^"]*"/, `data-duration="${totalSec}"`)
    .replace(/data-fps="[^"]*"/, 'data-fps="24"')
    .replace(/data-width="[^"]*"/, `data-width="${outputWidth}"`)
    .replace(/data-height="[^"]*"/, `data-height="${outputHeight}"`);
  html = html.replace('<head>', `<head>${injection}`);
  html = html.replace('</body>', '<script src="auto-layout/replay.js"></script></body>');
  fs.writeFileSync(path.join(workDir, 'index.html'), html);

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error: Error) => pageErrors.push(error.message));
  await page.setViewport({ width: outputWidth, height: outputHeight, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(workDir, 'index.html')).href, { waitUntil: 'load', timeout: 30_000 });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((img) => img.complete
      ? Promise.resolve()
      : new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); })));
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const outcome = await page.evaluate((expected) => {
    const win = window as unknown as {
      __timelines?: { overlay?: { pause: (time: number) => void; seek: (time: number, suppress?: boolean) => void } };
      __pointLayout: { apply: (el: Element, layout: { x: number; y: number; scale: number; rotate: number }) => void };
      __packagingAutoLayoutReplay: { apply: () => boolean };
      __packagingLayoutReady?: { status: string };
    };
    const timeline = win.__timelines?.overlay;
    if (!timeline) throw new Error('overlay 时间线未就绪');
    timeline.pause(0);
    timeline.seek(2, true);
    const root = document.getElementById('root')!;
    const rootRect = root.getBoundingClientRect();
    const center = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return {
        x: (rect.left + rect.width / 2 - rootRect.left) / rootRect.width * 100,
        y: (rect.top + rect.height / 2 - rootRect.top) / rootRect.height * 100,
      };
    };
    const cueA = document.querySelector('[data-point-id="cue:p_replay_a"]')!;
    const cueB = document.querySelector('[data-point-id="cue:p_replay_b"]')!;
    const autoInitial = center(cueA);
    // 模拟用户拖动：桥接管后 dataset.ul='1'，再次重放旧 Resolution 不得覆盖。
    win.__pointLayout.apply(cueA, { x: 70, y: 60, scale: 1, rotate: 0 });
    const dragged = center(cueA);
    win.__packagingAutoLayoutReplay.apply();
    const afterReplay = center(cueA);
    const otherAfterReplay = center(cueB);

    const editedSticker = document.querySelector<HTMLElement>('.packaging-sticker[data-sticker-id="s_replay_4"]')!;
    const autoSticker = document.querySelector<HTMLElement>('.packaging-sticker[data-sticker-id="s_replay_0"]')!;
    editedSticker.dataset.stickerEdited = '1';
    editedSticker.style.left = '33%';
    editedSticker.style.top = '61%';
    win.__packagingAutoLayoutReplay.apply();
    return {
      autoInitial, dragged, afterReplay, otherAfterReplay,
      stickerEditedLeft: editedSticker.style.left,
      stickerEditedTop: editedSticker.style.top,
      autoStickerLeft: autoSticker.style.left,
      autoStickerExpectedLeft: `${expected.autoStickerCenterXPct}%`,
      layoutReady: win.__packagingLayoutReady?.status ?? '',
    };
  }, { autoStickerCenterXPct: resolution.elements.s_replay_0.centerXPct });

  const bridgeA = Number(resolution.elements.p_replay_a.fit?.bridgeX);
  const bridgeB = Number(resolution.elements.p_replay_b.fit?.bridgeY);
  assert.equal(outcome.layoutReady, 'resolved', `布局应处于 resolved：${JSON.stringify(outcome)}`);
  assert.ok(Math.abs(outcome.autoInitial.x - bridgeA) < 0.6,
    `自动卖点初始必须按 Resolution 重放：${JSON.stringify(outcome.autoInitial)} vs ${bridgeA}`);
  assert.ok(Math.abs(outcome.dragged.x - 70) < 0.6 && Math.abs(outcome.dragged.y - 60) < 0.6,
    `模拟拖动必须落到目标位置：${JSON.stringify(outcome.dragged)}`);
  assert.ok(Math.abs(outcome.afterReplay.x - 70) < 0.6 && Math.abs(outcome.afterReplay.y - 60) < 0.6,
    `手动卖点不得在 Resolution 重放时回弹：${JSON.stringify(outcome.afterReplay)}`);
  assert.ok(Math.abs(outcome.otherAfterReplay.y - bridgeB) < 0.6,
    `未编辑的自动卖点仍须按 Resolution 重放：${JSON.stringify(outcome.otherAfterReplay)}`);
  assert.equal(outcome.stickerEditedLeft, '33%', '编辑中的贴纸不得被旧 Resolution 覆盖');
  assert.equal(outcome.stickerEditedTop, '61%', '编辑中的贴纸纵向位置不得被旧 Resolution 覆盖');
  assert.equal(outcome.autoStickerLeft, outcome.autoStickerExpectedLeft, '未编辑的自动贴纸仍须按 Resolution 重放');
  assert.deepEqual(pageErrors, [], `页面不得出现脚本错误：${pageErrors.join(' | ')}`);
  console.log('布局重放回归通过：手动卖点/贴纸不回弹，自动元素仍按 Resolution 重放，字号与 ready 状态正常。');
} finally {
  if (browser) await browser.close().catch(() => undefined);
  fs.rmSync(workDir, { recursive: true, force: true });
}
