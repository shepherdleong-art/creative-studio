# Creative Studio 开发版对比汇报网页 PPT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成一份 12 页、电子杂志风 × 靛蓝瓷主题的单文件 HTML 汇报，完整呈现旧正式包与当前开发版的功能、优化、反馈闭环和下一步优先级。

**Architecture:** 以 `guizang-ppt-skill/assets/template.html` 为唯一视觉与交互基座，替换为靛蓝瓷主题并插入 12 个 slide。用户反馈截图和 Motion One 模块都以内嵌 data URL 携带，保证最终只交付一个 HTML；静态验证脚本负责内容与结构，Playwright QA 脚本负责逐页截图、溢出与导航验证。

**Tech Stack:** HTML/CSS/JavaScript、WebGL、Motion One、Node.js 22、Playwright、Sharp

---

## File Map

- Create: `outputs/Creative-Studio-开发版对比汇报.html` — 最终单文件网页 PPT。
- Create: `outputs/Creative-Studio-开发版对比汇报.validate.mjs` — 静态结构与内容校验，仅用于本地 QA。
- Create: `outputs/Creative-Studio-开发版对比汇报.qa.mjs` — Playwright 逐页视觉和交互检查，仅用于本地 QA。
- Create: `outputs/Creative-Studio-开发版对比汇报-review/slide-01.png` 至 `slide-12.png` — QA 截图。
- Create: `outputs/Creative-Studio-开发版对比汇报-review/contact-sheet.png` — 12 页接触表。
- Read only: `C:/Users/12089/AppData/Local/Temp/codex-clipboard-05386cb4-40b4-4a68-abd5-222c838b1828.png` — 用户反馈原图。
- Read only: `C:/Users/12089/.agents/skills/guizang-ppt-skill/assets/template.html` — 网页 PPT 基座。
- Read only: `C:/Users/12089/.agents/skills/guizang-ppt-skill/assets/motion.min.js` — 内嵌动效模块。
- Read only: `docs/superpowers/specs/2026-08-27-development-version-comparison-deck-design.md` — 已批准设计。

最终交付只指向 HTML；验证脚本与截图保留在 gitignored 的 `outputs/`，不修改产品代码。

## Slide Matrix

| 页 | Layout | Theme | 核心内容 | 动效 |
| --- | --- | --- | --- | --- |
| 01 | Layout 1 Hero Cover | `hero dark` | 从能用，到真正可生产 | hero |
| 02 | Layout 3 Big Numbers | `light` | 7 / 18 / 32 | cascade |
| 03 | Layout 10 Image + Text | `dark` | 原始反馈脑图 + 五类诉求 | cascade |
| 04 | Layout 9 Before / After | `light` | 旧包基线 vs 当前开发版 | directional |
| 05 | Layout 3 Status Numbers | `hero light` | 2 已解决 / 6 改善 / 7 待办 / 1 待定义 | hero |
| 06 | Layout 3 Capability Grid | `dark` | 7 大新增功能组 | cascade |
| 07 | Layout 6 Pipeline | `light` | 模板池 → 填充 → 检查 → 全部生成 | pipeline |
| 08 | Layout 9 Before / After | `dark` | 批量不可改 → 时间线自由编辑 | directional |
| 09 | Layout 10 Three Pillars | `light` | 脚本 / 封面 / 主题升级 | cascade |
| 10 | Layout 3 Six Cells | `dark` | 32 项优化的六类账本 | cascade |
| 11 | Layout 7 Hero Question | `hero light` | 7 个真实缺口 + 紫菜卷待定义 | hero |
| 12 | Layout 8 Closing | `hero dark` | P0 / P1 / P2 优先级 | quote |

主题节奏满足：无连续三页同色，包含 hero dark、hero light、light 正文、dark 正文。

### Task 1: 建立静态验收门槛

**Files:**
- Create: `outputs/Creative-Studio-开发版对比汇报.validate.mjs`
- Test: `outputs/Creative-Studio-开发版对比汇报.validate.mjs`

- [ ] **Step 1: 创建静态验证脚本**

使用 `apply_patch` 创建以下脚本：

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';

const deckPath = new URL('./Creative-Studio-开发版对比汇报.html', import.meta.url);
assert.ok(fs.existsSync(deckPath), 'deck HTML missing');
const html = fs.readFileSync(deckPath, 'utf8');

assert.match(html, /^<!DOCTYPE html>/i);
assert.match(html, /<title>Creative Studio · 开发版进化报告<\/title>/);
assert.doesNotMatch(html, /\[必填\]|SLIDES_HERE|TBD|TODO/);

const slides = [...html.matchAll(/<section\s+class="slide\s+([^"]+)"/g)];
assert.equal(slides.length, 12, 'expected 12 slides');
const themes = slides.map((match) => match[1].trim());
assert.deepEqual(themes, [
  'hero dark', 'light', 'dark', 'light', 'hero light', 'dark',
  'light', 'dark', 'light', 'dark', 'hero light', 'hero dark',
]);

for (const token of ['7 大新增功能组', '18 项具体操作能力', '32 个优化与修复点']) {
  assert.ok(html.includes(token), `missing summary token: ${token}`);
}
for (const token of ['2 项已解决', '6 项明显改善', '7 项仍待解决', '1 项待定义']) {
  assert.ok(html.includes(token), `missing feedback token: ${token}`);
}

assert.match(html, /data:image\/png;base64,/);
assert.doesNotMatch(html, /codex-clipboard-05386cb4|AppData\/Local\/Temp|src="images\//);
assert.doesNotMatch(html, /\.\/assets\/motion\.min\.js/);
assert.match(html, /data:text\/javascript;base64,/);
assert.ok((html.match(/data-anim/g) || []).length >= 36, 'too few motion markers');
assert.equal((html.match(/class="dot"/g) || []).length, 0, 'nav dots must be generated at runtime');

for (let page = 1; page <= 12; page += 1) {
  const label = `${String(page).padStart(2, '0')} / 12`;
  assert.ok(html.includes(label), `missing page label ${label}`);
}

console.log('version comparison deck static validation passed');
```

- [ ] **Step 2: 运行验证并确认先失败**

Run:

```powershell
node outputs/Creative-Studio-开发版对比汇报.validate.mjs
```

Expected: FAIL with `deck HTML missing`，证明门槛能拦截未生成产物。

### Task 2: 生成单文件 HTML Deck

**Files:**
- Create: `outputs/Creative-Studio-开发版对比汇报.html`
- Read: `C:/Users/12089/.agents/skills/guizang-ppt-skill/assets/template.html`
- Read: `C:/Users/12089/.agents/skills/guizang-ppt-skill/assets/motion.min.js`
- Read: `C:/Users/12089/AppData/Local/Temp/codex-clipboard-05386cb4-40b4-4a68-abd5-222c838b1828.png`
- Test: `outputs/Creative-Studio-开发版对比汇报.validate.mjs`

- [ ] **Step 1: 检查输入素材**

Run:

```powershell
Get-Item -LiteralPath 'C:\Users\12089\AppData\Local\Temp\codex-clipboard-05386cb4-40b4-4a68-abd5-222c838b1828.png' | Select-Object FullName,Length
Get-Item -LiteralPath 'C:\Users\12089\.agents\skills\guizang-ppt-skill\assets\motion.min.js' | Select-Object FullName,Length
```

Expected: 两个文件均存在且长度大于 0。

- [ ] **Step 2: 读取并内嵌二进制素材**

通过 PowerShell 只读取得两个 base64 字符串，由 `functions.exec` 在内存中拼入传给 `apply_patch` 的 HTML：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\Users\12089\AppData\Local\Temp\codex-clipboard-05386cb4-40b4-4a68-abd5-222c838b1828.png'))
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\Users\12089\.agents\skills\guizang-ppt-skill\assets\motion.min.js'))
```

HTML 中分别写为：

```html
<img src="data:image/png;base64,PNG_BASE64" alt="一线用户对旧正式版的反馈脑图">
<script type="module">
const motion = await import('data:text/javascript;base64,MOTION_BASE64');
</script>
```

禁止写入原始绝对路径或外部 `images/` 目录。

- [ ] **Step 3: 从模板创建 12 页 Deck**

使用 `apply_patch` 创建 `outputs/Creative-Studio-开发版对比汇报.html`，以 `template.html` 为基座并完成以下固定替换：

```css
:root{
  --ink:#0a1f3d;
  --ink-rgb:10,31,61;
  --paper:#f1f3f5;
  --paper-rgb:241,243,245;
  --paper-tint:#e4e8ec;
  --ink-tint:#152a4a;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
  --serif-en:"Playfair Display","Source Serif 4",Georgia,serif;
  --serif-zh:"Noto Serif SC","Songti SC",SimSun,serif;
  --sans-zh:"Noto Sans SC","Microsoft YaHei UI",sans-serif;
}
```

并加入打印降级：

```css
@media print{
  html,body{overflow:visible;background:#fff}
  #deck{position:static;width:auto!important;height:auto;display:block;transform:none!important}
  .slide{page-break-after:always;width:100vw;height:56.25vw;min-height:100vh}
  canvas.bg,#nav,#hint,#overview{display:none!important}
  [data-anim]{opacity:1!important;transform:none!important}
}
```

每页文案必须来自已批准设计，不加入未验证的功能：

1. `从能用，到真正可生产`；
2. `7 大新增功能组 / 18 项具体操作能力 / 32 个优化与修复点`；
3. 原始脑图 + `生产规范 / 效率 / 审核 / 功能 / 数据`；
4. `9415939` vs `54810de`，并写明旧包元数据不一致；
5. `2 项已解决 / 6 项明显改善 / 7 项仍待解决 / 1 项待定义`；
6. 视频批量工作流、运镜模板、三态主题、批量控制、成片编辑、每脚本封面、脚本透明化；
7. 模板池 → 一键填充 → 保留手写 → 批量检查 → 全部生成；
8. 时间线预览、调整长度、替换、插入、删除、分割；
9. 生成阶段/流式正文、每脚本封面样式、浅色/深色/跟随系统；
10. 脚本 8、图片 4、视频 4、批量 7、界面 6、成本 3；
11. 数量规范、分镜提示词、感知查重、安全产量、口播/总音量、字体映射、每日看板；`紫菜卷` 标记待定义；
12. P0 音量与字体，P1 感知查重与安全产量，P2 规范与每日看板。

不使用 emoji；不引入 Lucide 图标时删除外部 Lucide CDN；Google Fonts 可以作为增强，但所有中文字体必须有 Windows 系统 fallback。

- [ ] **Step 4: 运行静态验证**

Run:

```powershell
node outputs/Creative-Studio-开发版对比汇报.validate.mjs
```

Expected: `version comparison deck static validation passed`。

- [ ] **Step 5: 检查单文件边界**

Run:

```powershell
rg -n "AppData|codex-clipboard|src=\"images/|\.\/assets/|SLIDES_HERE|\[必填\]" outputs/Creative-Studio-开发版对比汇报.html
```

Expected: no matches。

### Task 3: 建立 Playwright 视觉与交互 QA

**Files:**
- Create: `outputs/Creative-Studio-开发版对比汇报.qa.mjs`
- Create: `outputs/Creative-Studio-开发版对比汇报-review/*.png`
- Test: `outputs/Creative-Studio-开发版对比汇报.qa.mjs`

- [ ] **Step 1: 创建浏览器 QA 脚本**

使用 `apply_patch` 创建脚本，核心逻辑如下：

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = path.resolve('outputs');
const deckPath = path.join(root, 'Creative-Studio-开发版对比汇报.html');
const reviewDir = path.join(root, 'Creative-Studio-开发版对比汇报-review');
fs.mkdirSync(reviewDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(deckPath).href, { waitUntil: 'load' });
await page.evaluate(() => window.__setLowPowerMode?.(true, { persist: false }));

assert.equal(await page.locator('.slide').count(), 12);
assert.equal(await page.locator('#nav .dot').count(), 12);

const shots = [];
for (let index = 0; index < 12; index += 1) {
  await page.evaluate((target) => window.go(target), index);
  await page.waitForTimeout(80);
  const overflow = await page.locator('.slide').nth(index).evaluate((slide) => {
    const frame = slide.querySelector('.frame');
    return frame ? {
      x: frame.scrollWidth - frame.clientWidth,
      y: frame.scrollHeight - frame.clientHeight,
    } : { x: 0, y: 0 };
  });
  assert.ok(overflow.x <= 1 && overflow.y <= 1, `slide ${index + 1} overflow ${JSON.stringify(overflow)}`);
  const shotPath = path.join(reviewDir, `slide-${String(index + 1).padStart(2, '0')}.png`);
  await page.screenshot({ path: shotPath });
  shots.push(shotPath);
}

await page.keyboard.press('Escape');
assert.notEqual(await page.locator('#overview').evaluate((node) => getComputedStyle(node).display), 'none');
await page.keyboard.press('Escape');
await page.keyboard.press('Home');
await page.keyboard.press('ArrowRight');
assert.match(await page.locator('#deck').evaluate((node) => node.style.transform), /-100vw/);

const thumbs = await Promise.all(shots.map((shot) => sharp(shot).resize(400, 225).png().toBuffer()));
await sharp({ create: { width: 1600, height: 675, channels: 4, background: '#0a1f3d' } })
  .composite(thumbs.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * 225 })))
  .png()
  .toFile(path.join(reviewDir, 'contact-sheet.png'));

await browser.close();
console.log('version comparison deck browser QA passed');
```

- [ ] **Step 2: 运行浏览器 QA**

Run:

```powershell
node outputs/Creative-Studio-开发版对比汇报.qa.mjs
```

Expected: `version comparison deck browser QA passed`，并生成 12 张 1600×900 截图和一张接触表。

### Task 4: 逐页视觉复核与修订

**Files:**
- Modify: `outputs/Creative-Studio-开发版对比汇报.html`
- Read: `outputs/Creative-Studio-开发版对比汇报-review/contact-sheet.png`
- Test: static validator + browser QA

- [ ] **Step 1: 打开接触表进行整体节奏检查**

使用 `view_image` 打开：

```text
I:/m7-studio/outputs/Creative-Studio-开发版对比汇报-review/contact-sheet.png
```

确认：hero 与正文交替、没有连续三页同构、靛蓝瓷主题一致、原始反馈图在第 3 页足够可读。

- [ ] **Step 2: 逐张检查高风险页面**

重点打开 `slide-03.png`、`slide-06.png`、`slide-10.png`、`slide-11.png`：

- 第 3 页截图完整且没有裁字；
- 第 6 页 7 个能力不拥挤；
- 第 10 页六类优化数字和说明均可读；
- 第 11 页七个缺口没有进入底部导航安全区。

- [ ] **Step 3: 用最小补丁修复视觉问题**

仅使用 `apply_patch` 调整对应 slide 的字号、间距、网格和文案密度；不改模板导航与 WebGL 基座。每轮只修同一类问题，便于判断效果。

- [ ] **Step 4: 重新运行两层验证**

Run:

```powershell
node outputs/Creative-Studio-开发版对比汇报.validate.mjs
node outputs/Creative-Studio-开发版对比汇报.qa.mjs
```

Expected: both pass。

### Task 5: 最终内容审计与交付

**Files:**
- Read: `outputs/Creative-Studio-开发版对比汇报.html`
- Read: `docs/superpowers/specs/2026-08-27-development-version-comparison-deck-design.md`
- Test: static validator + browser QA + file portability

- [ ] **Step 1: 核对数字和结论**

逐项确认：

```text
7 大新增功能组
18 项具体操作能力
32 个优化与修复点
2 项已解决 / 6 项明显改善 / 7 项仍待解决 / 1 项待定义
14 组代表性测试通过，但不宣称完整生产构建通过
```

- [ ] **Step 2: 检查独立文件可打开**

Run:

```powershell
Get-Item -LiteralPath 'I:\m7-studio\outputs\Creative-Studio-开发版对比汇报.html' | Select-Object FullName,Length
```

再用浏览器直接打开该绝对路径，确认截图和静态模式无需旁边资产即可显示。

- [ ] **Step 3: 最终验证**

Run:

```powershell
node outputs/Creative-Studio-开发版对比汇报.validate.mjs
node outputs/Creative-Studio-开发版对比汇报.qa.mjs
git status --short
```

Expected: 两个 QA 均通过；git 状态只保留用户原有的 `AGENTS.md` 修改和 `.codex/agents/luna_worker.toml` 删除，`outputs/` 因 gitignore 不进入版本控制。

- [ ] **Step 4: 在 Codex 中展示成品**

调用 `open_in_codex` 打开：

```text
I:/m7-studio/outputs/Creative-Studio-开发版对比汇报.html
```

最终回复提供 HTML、设计说明和计划文档的可点击绝对路径，并说明键盘操作：左右翻页、Esc 索引、B 静态模式、浏览器打印为 PDF。
