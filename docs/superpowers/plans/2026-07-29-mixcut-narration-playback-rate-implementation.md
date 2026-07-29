# 智能混剪口播音频整轨变速 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Windows 真实右键被播放头截走的问题，并在「背景音乐」下方增加与右键弹层同步的整轨口播倍速卡片。

**Architecture:** 在时间轴源头限制只有鼠标左键可以寻址，保留口播音轨自己的 `contextmenu`。把倍速边界与归一化提取成纯函数，把滑杆/数值框/快捷值提取成共享 React 控件；右键弹层和右侧卡片继续通过 `PreviewStep.applyGroup` 操作同一个 `narrationConfig.playbackRate`，不改数据库和后端命令。

**Tech Stack:** Next.js 16、React 19、TypeScript strict、CSS Modules、Node 22 原生 TypeScript 测试、Playwright、现有 final-edit workspace/renderer。

---

## 0. 执行上下文

先读：

- 设计规格：`docs/superpowers/specs/2026-07-29-mixcut-narration-playback-rate-design.md`
- 上游 UI 规格：`docs/superpowers/specs/2026-07-25-mixcut-v2-ui-spec.md` §6.4、§6.6、§7
- 右键与时间轴：`components/mixcut/MixcutTimeline.tsx`
- 第 3 步右栏：`components/mixcut/PreviewStep.tsx`
- 样式：`components/mixcut/MixcutPanel.module.css`
- 浏览器回归：`scripts/final-edit-mixcut.playwright.test.mjs`
- 服务端校验：`lib/final-edit/tts-speed.ts`
- 持久化命令：`lib/final-edit/workspace.ts` 的 `set_narration_playback_rate`
- 最终渲染：`lib/final-edit/renderer.ts` 的 `narrationPlaybackRate`

如果 Playwright 报 `Executable doesn't exist`，先执行一次：

```bash
npx playwright install chromium
```

工作区可能包含其他未提交内容。每次提交只暂存本任务列出的文件，禁止使用 `git add -A`。

## 1. 文件结构

| 文件 | 动作 | 单一职责 |
|---|---|---|
| `components/mixcut/narration-playback-rate.ts` | 新增 | 前端倍速常量、快捷值、归一化与显示格式 |
| `components/mixcut/NarrationPlaybackRateControl.tsx` | 新增 | 两个入口共享的滑杆、数值框、刻度和快捷值 |
| `components/mixcut/MixcutTimeline.tsx` | 修改 | 左键寻址、右键弹层、关闭时补交 pending 值 |
| `components/mixcut/PreviewStep.tsx` | 修改 | 右侧卡片和统一 preview/commit 回调 |
| `components/mixcut/MixcutPanel.module.css` | 修改 | 共享倍速控件与右侧卡片样式 |
| `scripts/final-edit-narration-playback-rate.test.ts` | 新增 | 纯函数边界和步进测试 |
| `scripts/final-edit-mixcut.playwright.test.mjs` | 修改 | Windows 真实右键与双入口同步回归 |

---

### Task 1: 倍速归一化纯函数

**Files:**
- Create: `components/mixcut/narration-playback-rate.ts`
- Create: `scripts/final-edit-narration-playback-rate.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `scripts/final-edit-narration-playback-rate.test.ts`：

```ts
import assert from 'node:assert/strict';
import {
  formatNarrationPlaybackRateInput,
  NARRATION_PLAYBACK_RATE_MAX,
  NARRATION_PLAYBACK_RATE_MIN,
  NARRATION_PLAYBACK_RATE_PRESETS,
  NARRATION_PLAYBACK_RATE_STEP,
  normalizeNarrationPlaybackRate,
} from '../components/mixcut/narration-playback-rate.ts';

assert.equal(NARRATION_PLAYBACK_RATE_MIN, 0.5);
assert.equal(NARRATION_PLAYBACK_RATE_MAX, 2);
assert.equal(NARRATION_PLAYBACK_RATE_STEP, 0.1);
assert.deepEqual(NARRATION_PLAYBACK_RATE_PRESETS, [0.8, 1, 1.2, 1.5]);

assert.equal(normalizeNarrationPlaybackRate(0.2), 0.5);
assert.equal(normalizeNarrationPlaybackRate(2.4), 2);
assert.equal(normalizeNarrationPlaybackRate(1.35), 1.4);
assert.equal(normalizeNarrationPlaybackRate(1.34), 1.3);
assert.equal(normalizeNarrationPlaybackRate(Number.NaN), 1);
assert.equal(normalizeNarrationPlaybackRate(Number.POSITIVE_INFINITY), 1);

assert.equal(formatNarrationPlaybackRateInput(1), '1');
assert.equal(formatNarrationPlaybackRateInput(1.4), '1.4');

console.log('final-edit narration playback rate tests passed');
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
node scripts/final-edit-narration-playback-rate.test.ts
```

Expected: FAIL，错误为找不到 `components/mixcut/narration-playback-rate.ts`。

- [ ] **Step 3: 实现最小纯函数模块**

创建 `components/mixcut/narration-playback-rate.ts`：

```ts
export const NARRATION_PLAYBACK_RATE_MIN = 0.5;
export const NARRATION_PLAYBACK_RATE_MAX = 2;
export const NARRATION_PLAYBACK_RATE_STEP = 0.1;
export const NARRATION_PLAYBACK_RATE_PRESETS = [0.8, 1, 1.2, 1.5] as const;

export function normalizeNarrationPlaybackRate(value: number): number {
  const finiteValue = Number.isFinite(value) ? value : 1;
  const stepped = Math.round(finiteValue / NARRATION_PLAYBACK_RATE_STEP) * NARRATION_PLAYBACK_RATE_STEP;
  return Number(Math.max(
    NARRATION_PLAYBACK_RATE_MIN,
    Math.min(NARRATION_PLAYBACK_RATE_MAX, stepped),
  ).toFixed(1));
}

export function formatNarrationPlaybackRateInput(value: number): string {
  const normalized = normalizeNarrationPlaybackRate(value);
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(1);
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run:

```bash
node scripts/final-edit-narration-playback-rate.test.ts
```

Expected: PASS，输出 `final-edit narration playback rate tests passed`。

- [ ] **Step 5: 提交纯函数与测试**

```bash
git add components/mixcut/narration-playback-rate.ts scripts/final-edit-narration-playback-rate.test.ts
git commit -m "test: cover mixcut narration playback rate"
```

---

### Task 2: 用真实右键锁定 Windows 回归并修复根因

**Files:**
- Modify: `scripts/final-edit-mixcut.playwright.test.mjs:1270`
- Modify: `components/mixcut/MixcutTimeline.tsx:210`

- [ ] **Step 1: 把合成事件改为真实鼠标右键**

在 `scripts/final-edit-mixcut.playwright.test.mjs` 中替换现有 `dispatchEvent('contextmenu', ...)`：

```js
const narrationTrack = page.locator('[data-track="narration"]');
const playheadBeforeRightClick = await page.getByRole('button', { name: '拖动播放头' }).evaluate((element) => element.style.left);
await narrationTrack.click({ button: 'right', position: { x: 120, y: 15 } });
assert.equal(
  await page.getByRole('button', { name: '拖动播放头' }).evaluate((element) => element.style.left),
  playheadBeforeRightClick,
  '右键口播音轨不得移动播放头',
);
```

保留紧随其后的：

```js
const speedMenu = page.getByRole('dialog', { name: '口播音频变速' });
await speedMenu.waitFor();
```

- [ ] **Step 2: 运行浏览器测试并确认真实右键失败**

Run:

```bash
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: FAIL，`口播音频变速` dialog 等待超时。Windows 事件目标会因播放头移动而从口播音轨变成 `tlPlayhead`。

- [ ] **Step 3: 只允许左键在时间轴空白处寻址**

在 `components/mixcut/MixcutTimeline.tsx` 的 `.tlInner` 上，把无条件寻址：

```tsx
onPointerDown={(event) => seekFromPointer(event.clientX)}
```

改为：

```tsx
onPointerDown={(event) => {
  if (event.button !== 0) return;
  seekFromPointer(event.clientX);
}}
```

不要给顶层新增按坐标判断音轨的 `onContextMenuCapture`；根因必须在错误移动播放头的源头修复。

- [ ] **Step 4: 运行真实右键回归并确认通过**

Run:

```bash
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: PASS，输出 `final-edit mixcut formal page smoke tests passed`。

- [ ] **Step 5: 提交 Windows 根因修复**

```bash
git add components/mixcut/MixcutTimeline.tsx scripts/final-edit-mixcut.playwright.test.mjs
git commit -m "fix: restore mixcut narration context menu on Windows"
```

---

### Task 3: 提取右键与右栏共享倍速控件

**Files:**
- Create: `components/mixcut/NarrationPlaybackRateControl.tsx`
- Modify: `components/mixcut/MixcutPanel.module.css:363-375`
- Modify: `components/mixcut/MixcutTimeline.tsx:15-30, 99-143, 267-401`
- Test: `scripts/final-edit-mixcut.playwright.test.mjs`

- [ ] **Step 1: 先增加共享控件的浏览器契约断言**

在右键弹层打开后的现有断言附近增加：

```js
assert.equal(await speedMenu.locator('[data-narration-speed-control]').count(), 1, '右键弹层必须使用共享倍速控件');
assert.equal(await speedMenu.getByRole('button', { name: '设置口播倍速为 1.2x' }).count(), 0, '右键弹层保持紧凑，不显示快捷值');
```

- [ ] **Step 2: 运行浏览器测试并确认共享控件契约失败**

Run:

```bash
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: FAIL，右键弹层中找不到 `[data-narration-speed-control]`。

- [ ] **Step 3: 创建共享 React 控件**

创建 `components/mixcut/NarrationPlaybackRateControl.tsx`：

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  formatNarrationPlaybackRateInput,
  NARRATION_PLAYBACK_RATE_MAX,
  NARRATION_PLAYBACK_RATE_MIN,
  NARRATION_PLAYBACK_RATE_PRESETS,
  NARRATION_PLAYBACK_RATE_STEP,
  normalizeNarrationPlaybackRate,
} from './narration-playback-rate';
import styles from './MixcutPanel.module.css';

export function NarrationPlaybackRateControl({
  idPrefix,
  value,
  disabled,
  showPresets = false,
  ariaLabelPrefix = '音频倍速',
  onPreview,
  onCommit,
  onPendingChange,
}: {
  idPrefix: string;
  value: number;
  disabled: boolean;
  showPresets?: boolean;
  ariaLabelPrefix?: string;
  onPreview: (playbackRate: number) => void;
  onCommit: (playbackRate: number) => void;
  onPendingChange?: (playbackRate: number | null) => void;
}) {
  const normalizedValue = normalizeNarrationPlaybackRate(value);
  const [draft, setDraft] = useState(normalizedValue);
  const [inputValue, setInputValue] = useState(() => formatNarrationPlaybackRateInput(normalizedValue));
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingRef.current !== null) return;
    const next = normalizeNarrationPlaybackRate(value);
    setDraft(next);
    setInputValue(formatNarrationPlaybackRateInput(next));
  }, [value]);

  const preview = (nextValue: number) => {
    const next = normalizeNarrationPlaybackRate(nextValue);
    pendingRef.current = next;
    setDraft(next);
    setInputValue(formatNarrationPlaybackRateInput(next));
    onPendingChange?.(next);
    onPreview(next);
  };

  const commit = (nextValue: number) => {
    const next = normalizeNarrationPlaybackRate(nextValue);
    pendingRef.current = null;
    setDraft(next);
    setInputValue(formatNarrationPlaybackRateInput(next));
    onPendingChange?.(null);
    onCommit(next);
  };

  return (
    <div className={styles.timelineSpeedControl} data-narration-speed-control>
      <label htmlFor={`${idPrefix}-range`}>倍速</label>
      <div className={styles.timelineSpeedRow}>
        <input
          id={`${idPrefix}-range`}
          type="range"
          aria-label={`${ariaLabelPrefix}拉条`}
          min={NARRATION_PLAYBACK_RATE_MIN}
          max={NARRATION_PLAYBACK_RATE_MAX}
          step={NARRATION_PLAYBACK_RATE_STEP}
          value={draft}
          disabled={disabled}
          onChange={(event) => preview(Number(event.currentTarget.value))}
          onPointerUp={(event) => {
            if (pendingRef.current !== null) commit(Number(event.currentTarget.value));
          }}
          onKeyUp={() => {
            if (pendingRef.current !== null) commit(pendingRef.current);
          }}
        />
        <input
          type="number"
          aria-label={`${ariaLabelPrefix}数值`}
          min={NARRATION_PLAYBACK_RATE_MIN}
          max={NARRATION_PLAYBACK_RATE_MAX}
          step={NARRATION_PLAYBACK_RATE_STEP}
          value={inputValue}
          disabled={disabled}
          onChange={(event) => {
            const rawValue = event.currentTarget.value;
            if (rawValue.trim() === '') {
              setInputValue(rawValue);
              return;
            }
            const next = Number(rawValue);
            if (Number.isFinite(next)) preview(next);
          }}
          onBlur={() => {
            if (pendingRef.current !== null) commit(pendingRef.current);
            else setInputValue(formatNarrationPlaybackRateInput(draft));
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || pendingRef.current === null) return;
            event.preventDefault();
            commit(pendingRef.current);
          }}
        />
      </div>
      <div className={styles.timelineSpeedScale} aria-hidden="true">
        <span>0.5x</span><span>1.0x</span><span>1.5x</span><span>2.0x</span>
      </div>
      {showPresets && (
        <div className={styles.narrationSpeedPresets} aria-label="口播倍速快捷值">
          {NARRATION_PLAYBACK_RATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={`设置口播倍速为 ${preset.toFixed(1)}x`}
              aria-pressed={Math.abs(draft - preset) < 1e-8}
              disabled={disabled}
              onClick={() => {
                preview(preset);
                commit(preset);
              }}
            >{preset.toFixed(1)}x</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 增加共享控件样式**

保留现有 `.timelineSpeedControl`、`.timelineSpeedRow`、`.timelineSpeedScale`，在 `components/mixcut/MixcutPanel.module.css` 后追加：

```css
.narrationSpeedPresets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 13px; }
.narrationSpeedPresets button { min-height: 24px; padding: 0 9px; border: 0; border-radius: 999px; background: var(--blue-wash); color: var(--blue); font-size: 10px; font-variant-numeric: tabular-nums; cursor: pointer; }
.narrationSpeedPresets button[aria-pressed='true'] { background: var(--blue); color: #fff; }
.narrationSpeedPresets button:disabled { cursor: not-allowed; opacity: .55; }
```

- [ ] **Step 5: 用共享控件替换右键弹层的重复 JSX**

在 `components/mixcut/MixcutTimeline.tsx`：

1. 删除本文件的倍速常量、`normalizeNarrationPlaybackRate`、`formatNarrationPlaybackRateInput`、`narrationPlaybackRateDraft` 和 `narrationPlaybackRateInput`；
2. 导入共享控件；
3. 把 dirty ref 改成 pending ref；
4. 关闭菜单时只补交 pending 值；
5. 用共享控件替换原滑杆与数值框 JSX。

关键代码：

```tsx
import { NarrationPlaybackRateControl } from './NarrationPlaybackRateControl';

const narrationPlaybackRatePendingRef = useRef<number | null>(null);

const closeContextMenu = useCallback(() => {
  const pending = narrationPlaybackRatePendingRef.current;
  if (contextMenu?.kind === 'narration' && pending !== null) {
    narrationPlaybackRatePendingRef.current = null;
    onNarrationPlaybackRateCommit(pending);
  }
  setContextMenu(null);
}, [contextMenu, onNarrationPlaybackRateCommit]);
```

打开口播菜单前重置：

```tsx
narrationPlaybackRatePendingRef.current = null;
setContextMenu({
  kind: 'narration',
  x: Math.max(8, Math.min(event.clientX, window.innerWidth - 356)),
  y: Math.max(8, Math.min(event.clientY, window.innerHeight - 224)),
});
```

弹层内容改为：

```tsx
<div className={styles.timelineContextTitle}>调整音频倍速</div>
<div className={styles.timelineSpeedHint}>拖动后立即作用于当前音轨，松手自动保存。</div>
<NarrationPlaybackRateControl
  idPrefix="mixcut-narration-context-speed"
  value={narrationPlaybackRate}
  disabled={disabled}
  onPreview={onNarrationPlaybackRatePreview}
  onCommit={onNarrationPlaybackRateCommit}
  onPendingChange={(pending) => { narrationPlaybackRatePendingRef.current = pending; }}
/>
```

- [ ] **Step 6: 运行定向测试**

Run:

```bash
node scripts/final-edit-narration-playback-rate.test.ts
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: 两条命令均 PASS；右键弹层仍支持即时预览、松手保存和 Escape 补交。

- [ ] **Step 7: 提交共享控件重构**

```bash
git add components/mixcut/NarrationPlaybackRateControl.tsx components/mixcut/MixcutPanel.module.css components/mixcut/MixcutTimeline.tsx scripts/final-edit-mixcut.playwright.test.mjs
git commit -m "refactor: share mixcut narration speed control"
```

---

### Task 4: 在背景音乐下方增加方案 A 右侧卡片

**Files:**
- Modify: `scripts/final-edit-mixcut.playwright.test.mjs:1268-1295`
- Modify: `components/mixcut/PreviewStep.tsx:422-477`
- Modify: `components/mixcut/MixcutPanel.module.css:416-423`

- [ ] **Step 1: 写右侧卡片与双入口同步失败测试**

在进入第 3 步并看到时间轴后、打开右键菜单前增加：

```js
const bgmHeading = page.getByRole('heading', { name: '背景音乐' });
const narrationSpeedHeading = page.getByRole('heading', { name: '口播音频变速' });
const coverButton = page.getByRole('button', { name: /视频封面设置/ });
await narrationSpeedHeading.waitFor();

const [bgmBox, narrationSpeedBox, coverBox] = await Promise.all([
  bgmHeading.boundingBox(),
  narrationSpeedHeading.boundingBox(),
  coverButton.boundingBox(),
]);
assert.ok(bgmBox && narrationSpeedBox && coverBox, '三个右栏卡片都必须可见并可测量');
assert.ok(bgmBox.y < narrationSpeedBox.y, '口播音频变速卡必须位于背景音乐之后');
assert.ok(narrationSpeedBox.y < coverBox.y, '口播音频变速卡必须位于视频封面设置之前');

const sidebarSpeedSlider = page.getByRole('slider', { name: '右侧音频倍速拉条' });
const sidebarSpeedNumber = page.getByRole('spinbutton', { name: '右侧音频倍速数值' });
assert.equal(await sidebarSpeedSlider.inputValue(), '1');
assert.equal(await sidebarSpeedNumber.inputValue(), '1');

await sidebarSpeedSlider.fill('1.2');
assert.equal(await page.locator('audio').first().evaluate((element) => element.playbackRate), 1.2, '右侧滑杆必须立即预览整轨倍速');
await sidebarSpeedSlider.dispatchEvent('pointerup');
await expectEventually(
  () => groupPatchBodies.some((body) => body.type === 'set_narration_playback_rate' && body.playbackRate === 1.2),
  '右侧滑杆松手必须保存整轨倍速',
);

await page.locator('[data-track="narration"]').click({ button: 'right', position: { x: 120, y: 15 } });
assert.equal(await page.getByRole('slider', { name: '音频倍速拉条' }).inputValue(), '1.2', '右键弹层必须读取右侧刚保存的倍速');
await page.keyboard.press('Escape');

await page.getByRole('button', { name: '设置口播倍速为 1.5x' }).click();
await expectEventually(
  () => groupPatchBodies.some((body) => body.type === 'set_narration_playback_rate' && body.playbackRate === 1.5),
  '快捷值必须保存整轨倍速',
);
assert.equal(startPostBodies.length, 2, '右侧调速不得创建 prepare 任务或新版本');
```


- [ ] **Step 2: 运行浏览器测试并确认卡片缺失**

Run:

```bash
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: FAIL，找不到 heading `口播音频变速`。

- [ ] **Step 3: 在 PreviewStep 插入方案 A 卡片**

在 `components/mixcut/PreviewStep.tsx` 导入：

```tsx
import { NarrationPlaybackRateControl } from './NarrationPlaybackRateControl';
```

在「背景音乐」section 之后、「视频封面设置」section 之前插入：

```tsx
<section className={styles.rcard} data-testid="mixcut-narration-speed-card">
  <h4><Icon name="speaker" size={15} />口播音频变速</h4>
  <div className={styles.narrationSpeedSummary}>
    <span>整条口播音轨</span>
    <strong>{group.script.narrationConfig.playbackRate.toFixed(1)}x</strong>
  </div>
  <p className={styles.narrationSpeedCardHint}>同步调整口播、字幕与成片时长</p>
  <NarrationPlaybackRateControl
    idPrefix="mixcut-narration-sidebar-speed"
    value={group.script.narrationConfig.playbackRate}
    disabled={busy}
    showPresets
    ariaLabelPrefix="右侧音频倍速"
    onPreview={previewNarrationPlaybackRate}
    onCommit={(playbackRate) => void applyGroup({ type: 'set_narration_playback_rate', playbackRate })}
  />
</section>
```

同时把右栏注释更新为：

```tsx
{/* 右栏：字幕样式 / 背景音乐 / 口播音频变速 / 封面 */}
```

- [ ] **Step 4: 增加方案 A 卡片细节样式**

在 `components/mixcut/MixcutPanel.module.css` 的 `.rcard` 控件样式附近增加：

```css
.narrationSpeedSummary { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 5px; color: var(--sub); font-size: 12px; }
.narrationSpeedSummary strong { color: var(--blue); font-size: 13px; font-variant-numeric: tabular-nums; }
.narrationSpeedCardHint { margin: 0 0 12px; color: var(--faint); font-size: 11px; line-height: 1.45; }
.rcard .timelineSpeedControl { padding: 11px 10px 9px; }
```

保持现有 14px 圆角、`var(--paper)`、`var(--sh-sm)`；不新增渐变或其他色系。

- [ ] **Step 5: 运行双入口浏览器回归**

Run:

```bash
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: PASS；右侧卡片顺序、即时预览、保存、右键同步和快捷值全部通过。

- [ ] **Step 6: 提交右侧卡片**

```bash
git add components/mixcut/PreviewStep.tsx components/mixcut/MixcutPanel.module.css scripts/final-edit-mixcut.playwright.test.mjs
git commit -m "feat: add mixcut narration speed sidebar card"
```

---

### Task 5: 完整回归与交付检查

**Files:**
- Verify only; modify only if a test exposes a defect within this feature's files

- [ ] **Step 1: 运行纯函数、工作区和渲染回归**

```bash
node scripts/final-edit-narration-playback-rate.test.ts
node scripts/final-edit-workspace.test.ts
node scripts/final-edit-render.test.ts
```

Expected: 三条命令全部 exit 0。渲染测试继续验证 2.0x 在约一半时长结束、0.5x 延长到双倍时长。

- [ ] **Step 2: 运行正式页面 Playwright**

```bash
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: PASS，且用例使用真实 `click({ button: 'right' })`，不再用 `dispatchEvent('contextmenu')`。

- [ ] **Step 3: 运行 Lint**

```bash
npm run lint
```

Expected: exit 0，无新增 error。

- [ ] **Step 4: 运行生产构建**

```bash
npm run build
```

Expected: `next build` 与 `scripts/sync-standalone-assets.mjs` 均 exit 0。

- [ ] **Step 5: 检查最终差异范围**

```bash
git status --short
git diff --check
git diff --stat HEAD~3..HEAD
```

Expected: 本功能只涉及文件结构表中列出的 7 个文件；`git diff --check` 无输出。工作区原有的其他未提交修改仍保持原样。

- [ ] **Step 6: 对照规格逐项验收**

逐项核对 `docs/superpowers/specs/2026-07-29-mixcut-narration-playback-rate-design.md` §9：

- Windows 真实右键打开弹层且不移动播放头；
- 方案 A 卡片位置正确；
- 两入口共享整轨值；
- 预览、字幕、总时长和渲染一致；
- 无新版本、TTS 或 prepare 请求；
- 保存失败恢复机制未被绕开。

全部满足后，本计划执行完成。
