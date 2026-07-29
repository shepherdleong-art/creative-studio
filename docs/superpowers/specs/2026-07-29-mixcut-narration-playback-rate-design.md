# 智能混剪 · 口播音频整轨变速双入口设计

> 日期：2026-07-29
> 状态：已确认
> 决策人确认：右侧采用方案 A；倍速作用于整条 TTS 口播音轨
> 上游规格：`docs/superpowers/specs/2026-07-25-mixcut-v2-ui-spec.md` §6.4、§6.6、§7
> 执行计划：`docs/superpowers/plans/2026-07-29-mixcut-narration-playback-rate-implementation.md`

---

## 1. 目标

修复 Windows Chrome 中「右键口播音轨无法打开变速弹层」的问题，并在第 3 步「预览调整」右侧栏的「背景音乐」卡片下方增加常驻的「口播音频变速」卡片。

两个入口必须操作同一个当前成片组的整轨 `playbackRate`：

- 时间轴口播音轨右键：适合熟练用户快速调整；
- 右侧常驻卡片：提供稳定、可发现的操作入口；
- 任一入口修改后，另一个入口、预览播放器、字幕时序和成片总时长立即同步；
- 调整当前音轨，不创建新成片版本，也不重新提交 TTS 或 `prepare` 任务。

## 2. 已确认交互

### 2.1 右侧卡片位置

第 3 步右侧栏顺序调整为：

1. 字幕样式；
2. 背景音乐；
3. 口播音频变速；
4. 视频封面设置。

「口播音频变速」使用独立白色卡片，沿用现有 `.rcard`、Apple 官网式精致极简视觉和 `MixcutPanel.module.css` token，不与 BGM 控件合并。

### 2.2 控件内容

- 标题：`口播音频变速`，使用现有 `speaker` 图标；
- 当前值：以 `1.0x` 形式明确显示；
- 说明：`同步调整口播、字幕与成片时长`；
- 滑杆：`0.5x–2.0x`，步进 `0.1x`；
- 数值框：与滑杆双向同步，非法值归一化到合法范围与步进；
- 快捷值：`0.8x / 1.0x / 1.2x / 1.5x`；
- 禁用态：沿用 `busy`，保存期间不可继续提交新值。

### 2.3 预览与保存时机

- 滑杆或数值框变化时，立即更新本地 `FinalEditGroupView`，预览播放器、时间轴长度、字幕位置和顶部总时长随之变化；
- 滑杆松手、键盘调整结束、数值框回车或失焦时提交保存；
- 点击快捷值时先预览，再立即提交；
- 关闭右键弹层时，如果存在尚未提交的预览值，自动补交最后一个值；
- 保存成功显示现有 `已自动保存`；保存失败沿用 `PreviewStep.applyGroup` 的恢复机制，重新加载服务端版本并显示错误。

## 3. Windows 根因与修复原则

### 3.1 复现方式

现有 Playwright 用例通过以下代码直接合成事件：

```js
await page.locator('[data-track="narration"]').dispatchEvent('contextmenu', {
  button: 2,
  clientX: 720,
  clientY: 820,
  bubbles: true,
  cancelable: true,
});
```

该用例在 Windows Chrome 中通过，但它绕过了真实鼠标的 `pointerdown → mousedown → pointerup → mouseup → contextmenu` 序列。

把用例改成真实右键后可稳定复现失败：

```js
await page.locator('[data-track="narration"]').click({ button: 'right' });
```

### 3.2 事件证据

Windows Chrome 实际采集到的目标变化为：

```text
pointerdown  button=2  target=wfLabel
mousedown    button=2  target=wfLabel
pointerup    button=2  target=tlPlayhead
mouseup      button=2  target=tlPlayhead
contextmenu  button=2  target=tlPlayhead
```

原因是 `MixcutTimeline` 的 `.tlInner` 对任意鼠标按钮执行 `seekFromPointer(event.clientX)`。右键按下后播放头立即移动到鼠标位置，覆盖到指针下方；随后 `contextmenu` 的目标变成 `tlPlayhead`，不会冒泡到口播音轨的 `onContextMenu`。

### 3.3 根因修复

时间轴寻址只接受主按钮：

```tsx
onPointerDown={(event) => {
  if (event.button !== 0) return;
  seekFromPointer(event.clientX);
}}
```

修复必须发生在播放头错误移动的源头。不得仅靠在顶层捕获 `contextmenu`、按坐标猜测音轨，或只增加右侧卡片来掩盖右键失效。

## 4. 组件与状态设计

### 4.1 纯函数模块

新增 `components/mixcut/narration-playback-rate.ts`，集中导出：

- `NARRATION_PLAYBACK_RATE_MIN = 0.5`；
- `NARRATION_PLAYBACK_RATE_MAX = 2`；
- `NARRATION_PLAYBACK_RATE_STEP = 0.1`；
- `NARRATION_PLAYBACK_RATE_PRESETS = [0.8, 1, 1.2, 1.5]`；
- `normalizeNarrationPlaybackRate(value)`；
- `formatNarrationPlaybackRateInput(value)`。

服务端最终校验继续由 `lib/final-edit/tts-speed.ts` 的 `assertNarrationPlaybackRate` 负责；前端纯函数只承担交互归一化，不替代服务端校验。

### 4.2 共享控件

新增 `components/mixcut/NarrationPlaybackRateControl.tsx`。组件只负责：

- 滑杆、数值框、刻度和可选快捷值的统一渲染；
- 本地草稿值与输入字符串；
- 预览、提交和待提交值通知；
- 为右键弹层与右侧卡片提供不同的 `idPrefix` 和无障碍名称。

它不直接请求 API，不持有成片组，不决定是否创建版本。API 保存仍由 `PreviewStep.applyGroup({ type: 'set_narration_playback_rate', playbackRate })` 统一完成。

### 4.3 双入口同步

数据流保持单向：

```text
右键控件 / 右侧控件
        ↓ onPreview(value)
PreviewStep.previewNarrationPlaybackRate
        ↓ publishGroup
group.script.narrationConfig.playbackRate
        ↓ props
预览播放器 + 时间轴 + 两个控件
        ↓ onCommit(value)
PATCH /api/final-edit-groups/:id
        ↓ 服务端 view
publishGroup(服务端版本)
```

右键弹层需要保留「关闭时补交」能力：共享控件通过 `onPendingChange(number | null)` 把未提交值交给 `MixcutTimeline`；`closeContextMenu` 只在 pending 非空时提交一次。

## 5. 既有后端与渲染约束

本功能不新增数据库列、不修改迁移、不增加 API 命令。继续复用：

- `FinalEditGroupView.script.narrationConfig.playbackRate`；
- group command `set_narration_playback_rate`；
- `workspace.ts` 的 0.5x–2.0x 校验和 `narrationConfigJson` 持久化；
- `FinalEditPreview` 的 `<audio>.playbackRate`；
- `renderer.ts` 的 FFmpeg `atempo`、字幕时间缩放、快速裁短和慢速末帧延长；
- 现有 revision 冲突恢复与自动保存提示。

创作阶段的 TTS `speed` 与预览阶段的整轨 `playbackRate` 必须继续分离：前者决定生成音频，后者只调整当前已生成音轨。

## 6. 可访问性与输入规则

- 右键弹层维持 `role="dialog"` 与 `aria-label="口播音频变速"`；
- 右侧卡片使用可定位的 heading 和独立 input label，避免两个滑杆在自动化与读屏中重名；
- 滑杆支持方向键，数值框支持回车提交；
- `Escape` 关闭右键弹层前补交 pending 值；
- 控件禁用时不预览、不提交；
- 快捷值用原生 `button type="button"`，当前值使用 `aria-pressed`。

## 7. 测试策略

### 7.1 纯函数测试

新增 `scripts/final-edit-narration-playback-rate.test.ts`，覆盖：

- 小于 0.5 归一化为 0.5；
- 大于 2 归一化为 2；
- 1.35 按 0.1 步进归一化为 1.4；
- 整数与一位小数显示；
- 非有限数回退为 1。

### 7.2 Windows 真实右键回归

把 `scripts/final-edit-mixcut.playwright.test.mjs` 的合成 `contextmenu` 改成 Playwright 真实右键：

```js
await page.locator('[data-track="narration"]').click({ button: 'right' });
```

该用例必须在修复前因弹层不可见而失败，在限制左键寻址后通过。

### 7.3 双入口回归

浏览器用例覆盖：

- 右侧卡片位于「背景音乐」之后、「视频封面设置」之前；
- 右侧滑杆预览后，音频 `playbackRate`、时间轴标签和总时长同步；
- 右侧提交产生 `set_narration_playback_rate` PATCH，不产生 prepare/start 请求；
- 再打开右键弹层时显示右侧刚保存的值；
- 右键调整后右侧卡片同步；
- 快捷值提交一次并正确高亮；
- `Escape` 关闭弹层时补交最后预览值。

### 7.4 既有回归

- `scripts/final-edit-workspace.test.ts`：整轨倍速持久化与边界；
- `scripts/final-edit-render.test.ts`：0.5x/2.0x 实际音频、时长、裁短和延长；
- `npm run lint`；
- `npm run build`。

## 8. 不在本次范围

- 不做逐句或逐片段独立变速；
- 不重新生成 TTS；
- 不增加 BGM 变速；
- 不改变 TTS 供应商或音色；
- 不改变倍速边界与步进；
- 不创建新成片版本；
- 不重构其他时间轴拖拽、字幕编辑或视频右键菜单。

## 9. 验收标准

- [ ] Windows Chrome 真实右键口播音轨能稳定打开变速弹层，原生菜单不出现；
- [ ] 右键不会移动播放头；左键寻址和拖动播放头保持正常；
- [ ] 「背景音乐」下方显示独立「口播音频变速」卡片；
- [ ] 两个入口显示、预览和保存同一个整轨倍速；
- [ ] 0.5x–2.0x、0.1x 步进、数值框和快捷值行为正确；
- [ ] 预览口播、字幕、视频时长和最终导出一致；
- [ ] 调速不创建新版本、不触发 TTS 或 prepare；
- [ ] 保存失败恢复服务端版本并给出明确提示；
- [ ] 定向测试、Playwright、Lint 和生产构建通过。
