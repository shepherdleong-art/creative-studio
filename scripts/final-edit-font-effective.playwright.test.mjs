import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';
import { listSystemFonts } from '../lib/media-core/system-fonts.ts';

// 字体生效判定（F2）的浏览器回归测试。
// 运行方式与文件头格式照抄 scripts/final-edit-canvas.playwright.test.mjs：
//   需要本机浏览器与系统字体，node scripts/final-edit-font-effective.playwright.test.mjs
// 验证 text-canvas-renderer.ts 的 assertFontsEffective 像素比对守卫：
//   - 一个确定不存在的 family 判定为「未生效」；
//   - 一个确定存在的 family（Arial）判定为「生效」；
//   - 回归锚点：文件名推导产物（如 Songti / msgothic）判定为「未生效」，
//     真实 family（Songti SC / MS Gothic）判定为「生效」——这正是 F1 要修的旧 bug。
// 注：Chrome 对部分文件名推导名会做大小写/无空格模糊匹配（如 cambria→Cambria），
//     所以回归锚点只用「推导名与真实名差异足够大」的可靠组合。

const source = fs.readFileSync('components/final-edit/text-canvas-renderer.ts', 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText
  .replace(/^import .*$/gm, '')
  .replace(/\bexport\s+/g, '');
const browserBundle = `${transpiled}\nwindow.__csFontEffective = { assertFontsEffective, createOverlayBundlePayload };`;

const realFamilies = new Set(listSystemFonts().map((font) => font.family));
// 可靠回归组合：推导名（无空格/去字重）与真实 family 差异足够大，浏览器不会模糊匹配。
const regressionCandidates = [
  { derived: 'Songti', real: 'Songti SC' },
  { derived: 'STHeiti Light', real: 'Heiti SC' },
  { derived: 'msgothic', real: 'MS Gothic' },
];
const regression = regressionCandidates.find((candidate) => realFamilies.has(candidate.real));
assert.ok(regression, `本机应存在已知多字型 ttc 的真实 family 用于回归锚点（当前可用：${[...realFamilies].slice(0, 12).join('、')}）`);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({
    content: `const OUTPUT_PRESETS={"3x4":{width:1080,height:1440,fps:24},"9x16":{width:1080,height:1920,fps:24},"16x9":{width:1920,height:1080,fps:24}};${browserBundle}`,
  });
  const result = await page.evaluate(async (probe) => {
    await document.fonts.ready;
    const { assertFontsEffective, createOverlayBundlePayload } = window.__csFontEffective;
    const judge = (family) => {
      try { assertFontsEffective([family]); return 'effective'; } catch (error) { return `ineffective:${error.message}`; }
    };
    const missing = judge('__cs_missing_font__');
    const arial = probe.hasArial ? judge('Arial') : 'skipped';
    const derived = judge(probe.derived);
    const real = judge(probe.real);
    const style = {
      fontFamily: 'Arial', fontSizePx: 42, italic: false, x: 0.5, y: 0.4, scale: 1,
      color: '#ffffff', align: 'center', boxWidthPx: 900, lineHeight: 1,
      stroke: { enabled: false, color: '#000000', widthPx: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0, blurPx: 0, distancePx: 0, angleDeg: 0 },
    };
    const group = {
      revision: 1,
      coverTitle: { primary: { text: '产品标题' }, secondary: { text: '副标题' } },
      subtitleCues: [],
      textStyles: {
        '16x9': {
          coverPrimary: { ...style, fontFamily: probe.derived },
          coverSecondary: { ...style },
          subtitle: { ...style },
        },
      },
    };
    let integration = 'no-error';
    try { await createOverlayBundlePayload(group, '16x9'); } catch (error) { integration = error.message; }
    return { missing, arial, derived, real, integration };
  }, { derived: regression.derived, real: regression.real, hasArial: realFamilies.has('Arial') });

  assert.match(result.missing, /未生效/, '不存在的 family 必须判定为未生效');
  if (realFamilies.has('Arial')) assert.equal(result.arial, 'effective', '确定存在的 Arial 必须判定为生效');
  assert.match(result.derived, /未生效/, `文件名推导产物 ${regression.derived} 必须判定为未生效`);
  assert.equal(result.real, 'effective', `真实 family ${regression.real} 必须判定为生效`);
  assert.match(result.integration, /未生效/, 'createOverlayBundlePayload 对无效字体必须在烘焙前拦截');
  console.log('final-edit-font-effective tests passed');
} finally {
  await browser.close();
}
