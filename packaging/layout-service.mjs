// 规范布局服务：真实模板 + bundled Chromium + 共享几何求解器。
// 用法：node packaging/layout-service.mjs <request.json> <output.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require('./win-hide-spawn.cjs');
const puppeteer = await import('puppeteer-core');

const requestPath = process.argv[2];
const outputPath = process.argv[3];
if (!requestPath || !outputPath) throw new Error('用法：node packaging/layout-service.mjs <request.json> <output.json>');
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const CHROME = process.env.HYPERFRAMES_BROWSER_PATH || path.join(__dirname, 'runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
if (!fs.existsSync(CHROME)) throw new Error(`规范布局 Chrome 缺失：${CHROME}`);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function safeRelative(file) {
  return typeof file === 'string' && file.length > 0 && !file.includes('\0') && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-layout-'));
let browser;
try {
  const templateDir = path.resolve(request.templateDir || '');
  if (!fs.existsSync(path.join(templateDir, 'index.html'))) throw new Error('规范布局模板不存在');
  copyDir(templateDir, workDir);
  const sharedFonts = path.join(__dirname, 'fonts');
  if (fs.existsSync(sharedFonts)) copyDir(sharedFonts, path.join(workDir, 'fonts'));
  if (request.userFontsDir && fs.existsSync(request.userFontsDir)) copyDir(request.userFontsDir, path.join(workDir, 'fonts', 'user'));
  fs.mkdirSync(path.join(workDir, 'stickers'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'stickers', 'runtime.js'), path.join(workDir, 'stickers', 'runtime.js'));
  fs.mkdirSync(path.join(workDir, 'auto-layout'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'auto-layout', 'runtime.js'), path.join(workDir, 'auto-layout', 'runtime.js'));
  fs.copyFileSync(path.join(__dirname, 'auto-layout', 'replay.js'), path.join(workDir, 'auto-layout', 'replay.js'));

  const vars = request.vars && typeof request.vars === 'object' ? request.vars : {};
  const assets = vars.stickerAssets && typeof vars.stickerAssets === 'object' ? vars.stickerAssets : {};
  for (const asset of Object.values(assets)) {
    if (!asset || !safeRelative(asset.file)) throw new Error('规范布局贴纸路径无效');
    const source = path.resolve(__dirname, 'stickers', asset.file);
    if (!source.startsWith(`${path.resolve(__dirname, 'stickers')}${path.sep}`) || !fs.existsSync(source)) throw new Error(`规范布局贴纸缺失：${asset.file}`);
    const destination = path.resolve(workDir, 'stickers', asset.file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  const outputWidth = Number(request.outputWidth);
  const outputHeight = Number(request.outputHeight);
  const totalSec = Number(request.totalSec || vars.totalSec);
  if (!Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight) || outputWidth <= 0 || outputHeight <= 0 || !(totalSec > 0)) {
    throw new Error('规范布局输出尺寸或时长无效');
  }
  let html = fs.readFileSync(path.join(workDir, 'index.html'), 'utf8')
    .replace(/data-duration="[^"]*"/, `data-duration="${totalSec}"`)
    .replace(/data-fps="[^"]*"/, 'data-fps="24"')
    .replace(/data-width="[^"]*"/, `data-width="${outputWidth}"`)
    .replace(/data-height="[^"]*"/, `data-height="${outputHeight}"`);
  const injection = `<style>html,body{margin:0;background:transparent!important}</style>${request.fontFacesCss || ''}<script>window.__hyperframes={getVariables:()=>(${JSON.stringify(vars).replace(/</g, '\\u003c')})};${request.palette ? `window.__palette=${JSON.stringify(request.palette).replace(/</g, '\\u003c')};` : ''}</script>`;
  html = html.replace('<head>', `<head>${injection}`);
  if (vars.layoutResolution) html = html.replace('</body>', '<script src="auto-layout/replay.js"></script></body>');
  html = html.replace('</body>', '<script src="auto-layout/runtime.js"></script></body>');
  fs.writeFileSync(path.join(workDir, 'index.html'), html, 'utf8');

  browser = await puppeteer.default.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: outputWidth, height: outputHeight, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(path.join(workDir, 'index.html')).href, { waitUntil: 'load', timeout: 30_000 });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise((resolve, reject) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', () => reject(new Error(`图片加载失败：${img.src}`)), { once: true });
    })));
    await Promise.all(Array.from(document.images).map(img => typeof img.decode === 'function' ? img.decode().catch(() => undefined) : Promise.resolve()));
  });
  await new Promise(resolve => setTimeout(resolve, 650));

  const result = await page.evaluate((serviceInput) => {
    const runtime = window.__packagingAutoLayoutRuntime;
    const timeline = window.__timelines && window.__timelines.overlay;
    const root = document.getElementById('root');
    if (!runtime || !timeline || !root) return { status: 'error', message: '模板布局运行时或时间线未就绪', pageErrors: serviceInput.pageErrors };
    timeline.pause(0);
    const vars = serviceInput.vars;
    const W = serviceInput.outputWidth;
    const H = serviceInput.outputHeight;
    const FPS = 24;
    const totalFrames = Math.max(1, Math.ceil(serviceInput.totalSec * FPS));
    const coverSec = Number(vars.coverSec) || 0;
    const bodyFrames = Math.max(1, Math.round((serviceInput.totalSec - coverSec) * FPS));
    const rootRect = root.getBoundingClientRect();
    const sx = W / rootRect.width;
    const sy = H / rootRect.height;
    const stickerById = new Map((Array.isArray(vars.stickers) ? vars.stickers : []).map(item => [item.id, item]));
    const template = vars.stickerTemplate;
    const manualCues = vars.layouts && vars.layouts[template] && vars.layouts[template].cues || {};
    const entries = [];

    function numericStyle(value) {
      const n = Number.parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    }
    function percentPosition(el, rect) {
      const left = el.style.left || '';
      const top = el.style.top || '';
      const x = left.endsWith('%') ? numericStyle(left) : (rect.left + rect.width / 2 - rootRect.left) / rootRect.width * 100;
      const y = top.endsWith('%') ? numericStyle(top) : (rect.top + rect.height / 2 - rootRect.top) / rootRect.height * 100;
      return { x, y };
    }
    function outsetFor(el) {
      const style = getComputedStyle(el);
      const stroke = Math.abs(numericStyle(style.webkitTextStrokeWidth || style.getPropertyValue('-webkit-text-stroke-width')));
      let shadow = 0;
      for (const value of [style.textShadow, style.boxShadow, style.filter]) {
        if (!value || value === 'none') continue;
        const numbers = value.match(/-?\d+(?:\.\d+)?px/g) || [];
        for (const number of numbers) shadow = Math.max(shadow, Math.abs(numericStyle(number)));
      }
      return Math.ceil(Math.max(stroke, shadow));
    }
    function unionRect(rect, outset) {
      return { left: rect.left - outset, top: rect.top - outset, right: rect.right + outset, bottom: rect.bottom + outset };
    }
    function outputBox(rect) {
      return {
        left: (rect.left - rootRect.left) * sx,
        top: (rect.top - rootRect.top) * sy,
        right: (rect.right - rootRect.left) * sx,
        bottom: (rect.bottom - rootRect.top) * sy,
      };
    }

    for (const outer of Array.from(document.querySelectorAll('.packaging-sticker'))) {
      const id = outer.dataset.stickerId;
      const sticker = stickerById.get(id);
      if (!sticker) continue;
      const motion = outer.querySelector('.packaging-sticker-motion');
      const image = outer.querySelector('img');
      const asset = vars.stickerAssets && vars.stickerAssets[id];
      if (!motion || !image || !asset || !Array.isArray(asset.alpha_gt8_bbox)) return { status: 'error', message: `贴纸 ${id} 缺少实际素材几何` };
      motion.style.position = 'relative';
      const probe = document.createElement('div');
      const bbox = asset.alpha_gt8_bbox;
      Object.assign(probe.style, {
        position: 'absolute', pointerEvents: 'none', visibility: 'hidden',
        left: `${bbox[0] / asset.width * 100}%`, top: `${bbox[1] / asset.height * 100}%`,
        width: `${(bbox[2] - bbox[0]) / asset.width * 100}%`, height: `${(bbox[3] - bbox[1]) / asset.height * 100}%`,
      });
      motion.appendChild(probe);
      const rect = outer.getBoundingClientRect();
      const center = percentPosition(outer, rect);
      const stageIndex = Math.max(0, Math.min(2, Math.floor((sticker.startFrame - 20) * 3 / bodyFrames)));
      entries.push({
        id, kind: 'sticker', stage: stageIndex === 0 ? 'opening' : stageIndex === 1 ? 'middle' : 'ending',
        layoutVersion: sticker.origin && sticker.origin.layoutVersion,
        positionPinned: sticker.origin && sticker.origin.positionPinned === true,
        centerXPct: center.x, centerYPct: center.y, el: outer, probe, frames: [],
      });
    }
    for (const el of Array.from(document.querySelectorAll('[data-point-id^="cue:"]'))) {
      const id = el.dataset.pointId.slice(4);
      const rect = el.getBoundingClientRect();
      const center = percentPosition(el, rect);
      let probe = el;
      // 手账便签 PNG 自带上下透明边；使用模板既有有效视觉几何，不把透明区误算为遮挡范围。
      if (template === 'overlay-journal' && el.classList.contains('note')) {
        const crop = { s: { t: 0.227, b: 0.254 }, m: { t: 0.166, b: 0.216 }, l: { t: 0.159, b: 0.164 } }[el.dataset.tier];
        if (crop) {
          probe = document.createElement('div');
          Object.assign(probe.style, {
            position: 'absolute', pointerEvents: 'none', visibility: 'hidden', left: '0',
            top: `${crop.t * 100}%`, width: '100%', height: `${(1 - crop.t - crop.b) * 100}%`,
          });
          el.appendChild(probe);
        }
      }
      entries.push({
        id, kind: 'pointCue', stage: 'middle', layoutVersion: vars.pointCuesLayoutVersion,
        manualLayout: Boolean(manualCues[id]), positionPinned: Boolean(manualCues[id]),
        centerXPct: center.x, centerYPct: center.y, el, probe, outset: outsetFor(el), frames: [],
      });
    }

    function opacityOf(entry) {
      const value = Number(getComputedStyle(entry.el).opacity);
      return Number.isFinite(value) ? value : 1;
    }
    function currentBox(entry) {
      return outputBox(unionRect(entry.probe.getBoundingClientRect(), entry.outset || 0));
    }
    for (let frame = 0; frame < totalFrames; frame += 1) {
      timeline.seek(frame / FPS, true);
      for (const entry of entries) {
        const opacity = opacityOf(entry);
        if (opacity > 0.0001) entry.frames.push({ frame, opacity, box: currentBox(entry) });
      }
    }

    const solverInput = {
      outputWidth: W, outputHeight: H, maxNodes: serviceInput.maxNodes,
      elements: entries.map(entry => ({
        id: entry.id, kind: entry.kind, stage: entry.stage, layoutVersion: entry.layoutVersion,
        positionPinned: entry.positionPinned, manualLayout: entry.manualLayout,
        centerXPct: entry.centerXPct, centerYPct: entry.centerYPct, frames: entry.frames,
      })),
    };
    const solved = runtime.solveAutoLayout(solverInput);
    if (solved.status !== 'resolved') return { ...solved, pageErrors: serviceInput.pageErrors };

    // 统一在第 0 帧写入解析中心；在动画末帧用测量-修正桥会错误补偿当前 GSAP 位移。
    timeline.seek(0, true);
    for (const entry of entries) {
      const resolved = solved.elements[entry.id];
      if (!resolved) continue;
      if (entry.kind === 'sticker') {
        entry.el.style.left = `${resolved.centerXPct}%`;
        entry.el.style.top = `${resolved.centerYPct}%`;
      } else if (window.__pointLayout && typeof window.__pointLayout.apply === 'function') {
        // 测量-修正桥必须在元素实际可见时运行；隐藏帧的零盒会污染偏移求解。
        timeline.seek((entry.frames[0]?.frame ?? 0) / FPS, true);
        const rect = entry.el.getBoundingClientRect();
        const actualCenter = {
          x: (rect.left + rect.width / 2 - rootRect.left) / rootRect.width * 100,
          y: (rect.top + rect.height / 2 - rootRect.top) / rootRect.height * 100,
        };
        // 手账便签的求解中心基于有效 Alpha 区域，桥接中心基于完整 PNG；按位移差换算，不能混用两个中心。
        entry.bridgeX = actualCenter.x + (resolved.centerXPct - entry.centerXPct);
        entry.bridgeY = actualCenter.y + (resolved.centerYPct - entry.centerYPct);
        window.__pointLayout.apply(entry.el, {
          x: entry.bridgeX, y: entry.bridgeY,
          scale: numericStyle(entry.el.style.zoom) || 1,
          rotate: numericStyle(entry.el.style.rotate),
        });
      } else {
        entry.el.style.left = `${resolved.centerXPct}%`;
        entry.el.style.top = `${resolved.centerYPct}%`;
      }
    }
    // 应用后逐帧复测：模板 refit、延时字体回调或点布局桥不得覆盖求解结果。
    // 只允许相对原始测量做整体平移；超过 1.5 输出像素即判定验证失败，不发布 Resolution。
    const mismatches = [];
    let validatedFrames = 0;
    for (let frame = 0; frame < totalFrames; frame += 1) {
      timeline.seek(frame / FPS, true);
      for (const entry of entries) {
        const original = entry.frames.find(item => item.frame === frame);
        if (!original) continue;
        const resolved = solved.elements[entry.id];
        if (!resolved) { mismatches.push(`${entry.id}@${frame}:missing`); continue; }
        const dx = (resolved.centerXPct - entry.centerXPct) / 100 * W;
        const dy = (resolved.centerYPct - entry.centerYPct) / 100 * H;
        const actual = currentBox(entry);
        const differences = [
          actual.left - (original.box.left + dx), actual.top - (original.box.top + dy),
          actual.right - (original.box.right + dx), actual.bottom - (original.box.bottom + dy),
        ].map(value => Math.abs(value));
        if (Math.max(...differences) > 1.5) mismatches.push(`${entry.id}@${frame}:${Math.max(...differences).toFixed(2)}px`);
        validatedFrames += 1;
      }
    }
    if (mismatches.length) {
      return { status: 'error', message: `布局应用后逐帧验证失败：${mismatches.slice(0, 6).join('，')}`, pageErrors: serviceInput.pageErrors };
    }
    timeline.seek(0, true);
    const elements = {};
    for (const entry of entries) {
      const resolved = solved.elements[entry.id];
      elements[entry.id] = {
        id: entry.id, kind: entry.kind,
        centerXPct: resolved.centerXPct, centerYPct: resolved.centerYPct,
        positionPinned: entry.kind === 'pointCue' ? Boolean(entry.manualLayout) : Boolean(entry.positionPinned),
        fit: {
          left: entry.el.style.left, top: entry.el.style.top,
          zoom: entry.el.style.zoom || '1', rotate: entry.el.style.rotate || '0',
          bridgeX: entry.bridgeX, bridgeY: entry.bridgeY,
          fontSize: entry.el.style.fontSize || getComputedStyle(entry.el).fontSize,
          textFontSize: (() => {
            const text = entry.el.querySelector('.txt,.ptxt');
            return text ? (text.style.fontSize || getComputedStyle(text).fontSize) : undefined;
          })(),
        },
        visualBox: entry.frames.length ? currentBox(entry) : undefined,
      };
    }
    return {
      status: 'resolved', elements, metrics: solved.metrics,
      diagnostics: { elementCount: entries.length, visibleFrameCount: entries.reduce((sum, entry) => sum + entry.frames.length, 0), validatedFrames },
      pageErrors: serviceInput.pageErrors,
    };
  }, { vars, outputWidth, outputHeight, totalSec, maxNodes: request.maxNodes, pageErrors });

  const output = result.status === 'resolved' ? {
    schemaVersion: 1,
    status: 'resolved',
    inputHash: request.inputHash,
    runtimeBundleVersion: request.runtimeBundleVersion || 2,
    geometryManifestHash: request.geometryManifestHash,
    outputWidth,
    outputHeight,
    elements: result.elements,
    validation: { frameCount: result.metrics?.frameCount || result.diagnostics.visibleFrameCount, digest: result.metrics?.digest || '' },
    diagnostics: result.diagnostics,
    pageErrors: result.pageErrors,
  } : result;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  if (result.status !== 'resolved') process.exitCode = result.status === 'infeasible' || result.status === 'budget_exceeded' ? 3 : 2;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  fs.rmSync(workDir, { recursive: true, force: true });
}
