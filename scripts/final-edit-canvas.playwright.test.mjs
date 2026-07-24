import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import ts from 'typescript';
import { chromium } from '@playwright/test';
import { coverFramingGeometry } from '../lib/final-edit/cover-framing.ts';

const source = fs.readFileSync('components/final-edit/text-canvas-renderer.ts', 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText
  .replace(/^import .*$/gm, '')
  .replace(/\bexport\s+/g, '')
const framingSource = fs.readFileSync('lib/final-edit/cover-framing.ts', 'utf8');
const framingTranspiled = ts.transpileModule(framingSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace(/^import .*$/gm, '').replace(/\bexport\s+/g, '');
const browserBundle = `${transpiled}\n${framingTranspiled}\nwindow.__finalEditCanvas = { drawText, drawEditorOverlay, createOverlayBundlePayload, measureSingleLineText, fitTextStyleToSingleLine, isTextStyleWithinSafeArea, drawFramedImage, coverSafeAreaRect };`;

const fixedFont = fs.readFileSync('node_modules/next/dist/next-devtools/server/font/geist-latin.woff2').toString('base64');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>@font-face{font-family:FinalEditGolden;src:url(data:font/woff2;base64,${fixedFont}) format('woff2')}</style><canvas id="golden" width="320" height="240"></canvas>`);
  await page.evaluate(async () => { await document.fonts.load('32px FinalEditGolden'); await document.fonts.ready; });
  await page.addScriptTag({ content: `const OUTPUT_PRESETS={"3x4":{width:1080,height:1440,fps:24},"9x16":{width:1080,height:1920,fps:24},"16x9":{width:1920,height:1080,fps:24}};${browserBundle}` });

  const result = await page.evaluate(async () => {
    const { drawText, drawEditorOverlay, createOverlayBundlePayload, measureSingleLineText, fitTextStyleToSingleLine, isTextStyleWithinSafeArea, drawFramedImage, coverSafeAreaRect } = window.__finalEditCanvas;
    const primary = {
      fontFamily: 'FinalEditGolden', fontSizePx: 42, italic: false, x: 0.5, y: 0.38, scale: 1,
      color: '#f4df74', align: 'center', boxWidthPx: 900, lineHeight: 1,
      stroke: { enabled: true, color: '#14213d', widthPx: 3 },
      shadow: { enabled: true, color: '#220044', opacity: 0.65, blurPx: 6, distancePx: 8, angleDeg: 35 },
    };
    const secondary = { ...primary, fontSizePx: 28, y: 0.63, color: '#ffffff', stroke: { enabled: false, color: '#000000', widthPx: 0 }, shadow: { ...primary.shadow, angleDeg: 145 } };
    const canvas = document.querySelector('#golden');
    const context = canvas.getContext('2d');
    drawText(context, 'PRIMARY', primary);
    drawText(context, 'secondary', secondary);
    const golden = canvas.toDataURL('image/png').split(',')[1];

    const group = {
      revision: 7,
      coverTitle: { primary: { text: 'PRIMARY' }, secondary: { text: 'secondary' } },
      subtitleCues: [{ id: 'cue-1', segmentId: 'seg-1', text: 'subtitle', startUs: 0, endUs: 1_000_000, textSource: 'manual', timingSource: 'manual' }],
      textStyles: {
        '3x4': { coverPrimary: primary, coverSecondary: secondary, subtitle: { ...secondary, y: 0.82, boxWidthPx: 900 } },
      },
    };
    const preview = document.createElement('canvas');
    drawEditorOverlay(preview, group, '3x4', null, true);
    const bundle = await createOverlayBundlePayload(group, '3x4');
    const subtitlePreview = document.createElement('canvas');
    drawEditorOverlay(subtitlePreview, group, '3x4', group.subtitleCues[0], false);
    let overflowRejected = false;
    let overflowCueIds = [];
    try {
      await createOverlayBundlePayload({ ...group, textStyles: { '3x4': { ...group.textStyles['3x4'], subtitle: { ...group.textStyles['3x4'].subtitle, boxWidthPx: 10 } } } }, '3x4');
    } catch (error) {
      overflowRejected = true;
      overflowCueIds = error.cueIds || [];
    }

    const secondaryOnly = document.createElement('canvas');
    secondaryOnly.width = 320; secondaryOnly.height = 240;
    drawText(secondaryOnly.getContext('2d'), 'secondary', secondary);
    const secondaryBefore = secondaryOnly.toDataURL('image/png');
    const changedPrimary = { ...primary, italic: true, x: 0.2, color: '#ff0000' };
    const independence = document.createElement('canvas');
    independence.width = 320; independence.height = 240;
    drawText(independence.getContext('2d'), 'PRIMARY', changedPrimary);
    secondaryOnly.getContext('2d').clearRect(0, 0, 320, 240);
    drawText(secondaryOnly.getContext('2d'), 'secondary', secondary);
    const edgeStyle = { ...primary, x: 0.98, fontSizePx: 64, boxWidthPx: 280 };
    const fittedEdgeStyle = fitTextStyleToSingleLine(context, '安全区标题', edgeStyle);
    const sourceFrame = document.createElement('canvas');
    sourceFrame.width = 640; sourceFrame.height = 360;
    const sourceContext = sourceFrame.getContext('2d');
    sourceContext.fillStyle = '#e53935'; sourceContext.fillRect(0, 0, 320, 180);
    sourceContext.fillStyle = '#43a047'; sourceContext.fillRect(320, 0, 320, 180);
    sourceContext.fillStyle = '#1e88e5'; sourceContext.fillRect(0, 180, 320, 180);
    sourceContext.fillStyle = '#fdd835'; sourceContext.fillRect(320, 180, 320, 180);
    const framedCover = document.createElement('canvas');
    framedCover.width = 1080; framedCover.height = 1920;
    const coverFraming = { scale: 1.35, offsetX: 0.28, offsetY: -0.22 };
    drawFramedImage(framedCover.getContext('2d'), sourceFrame, coverFraming);

    return {
      golden,
      previewMatchesBundle: preview.toDataURL('image/png').split(',')[1] === bundle.titlePngBase64,
      subtitleMatchesBundle: subtitlePreview.toDataURL('image/png').split(',')[1] === bundle.subtitlePngs['cue-1'],
      secondaryUnchanged: secondaryBefore === secondaryOnly.toDataURL('image/png'),
      overflowRejected,
      overflowCueIds,
      shortChineseFitsSingleLine: measureSingleLineText(context, '夏日轻盈', primary) < primary.boxWidthPx,
      independentItalic: changedPrimary.italic === true && secondary.italic === false,
      deterministicSafeFit: fittedEdgeStyle.x < edgeStyle.x && isTextStyleWithinSafeArea(context, '安全区标题', fittedEdgeStyle),
      framedCover: framedCover.toDataURL('image/png').split(',')[1],
      coverFraming,
      safeRect: coverSafeAreaRect(1080, 1920),
      manifest: bundle.manifest,
    };
  });

  const goldenHash = crypto.createHash('sha256').update(Buffer.from(result.golden, 'base64')).digest('hex');
  assert.equal(goldenHash, '154731d3be726f13137feace024ecb0f16fb251ee476874ccc46a88a7c2b7d30', 'Canvas 像素输出与 golden 不一致');
  assert.equal(result.previewMatchesBundle, true, 'preview canvas 必须与上传 bundle 标题 PNG 一致');
  assert.equal(result.subtitleMatchesBundle, true, 'preview canvas 必须与上传 bundle 字幕 PNG 一致');
  assert.equal(result.secondaryUnchanged, true, '修改第一段标题不得改变第二段标题像素');
  assert.equal(result.independentItalic, true, '主副标题正斜体必须互相独立');
  assert.equal(result.shortChineseFitsSingleLine, true, '短中文标题必须按单行测量，不得产生孤字换行');
  assert.equal(result.deterministicSafeFit, true, '单行适配必须先确定性平移并在必要时缩小到 4% 安全区');
  assert.deepEqual(result.safeRect, { x: 43.2, y: 76.8, width: 993.6, height: 1766.4 }, '封面安全区必须精确为四边 4%');
  const sourcePixels = Buffer.alloc(640 * 360 * 4);
  const quadrantColors = [[229, 57, 53, 255], [67, 160, 71, 255], [30, 136, 229, 255], [253, 216, 53, 255]];
  for (let y = 0; y < 360; y += 1) for (let x = 0; x < 640; x += 1) {
    const color = quadrantColors[(y >= 180 ? 2 : 0) + (x >= 320 ? 1 : 0)];
    const offset = (y * 640 + x) * 4;
    sourcePixels.set(color, offset);
  }
  const geometry = coverFramingGeometry({ sourceWidth: 640, sourceHeight: 360, outputWidth: 1080, outputHeight: 1920, framing: result.coverFraming });
  const rendererCover = await sharp(sourcePixels, { raw: { width: 640, height: 360, channels: 4 } })
    .resize(geometry.resizedWidth, geometry.resizedHeight, { fit: 'fill' })
    .extract({ left: geometry.left, top: geometry.top, width: 1080, height: 1920 })
    .png().toBuffer();
  const rendererPixels = await sharp(rendererCover).resize(108, 192, { kernel: 'nearest' }).raw().toBuffer();
  const browserPixels = await sharp(Buffer.from(result.framedCover, 'base64')).resize(108, 192, { kernel: 'nearest' }).raw().toBuffer();
  const meanPixelDelta = rendererPixels.reduce((sum, value, index) => sum + Math.abs(value - browserPixels[index]), 0) / rendererPixels.length;
  assert.ok(meanPixelDelta < 4, `浏览器封面与 renderer shared geometry 像素偏差过大：${meanPixelDelta.toFixed(3)}`);
  assert.equal(result.overflowRejected, true, '单行宽度溢出必须阻止 bundle');
  assert.deepEqual(result.overflowCueIds, ['cue-1'], '超宽错误必须保留具体字幕 ID，供编辑器定位与标记');
  assert.deepEqual(result.manifest.cues, [{ id: 'cue-1', startUs: 0, endUs: 1_000_000 }]);
  console.log('final-edit Chromium Canvas golden test passed');
} finally {
  await browser.close();
}
