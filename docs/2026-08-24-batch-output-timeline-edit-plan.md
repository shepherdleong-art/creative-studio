# 批量成片时间轴编辑（合并截取/修剪入口 + 比例时间轴）执行文档

> 本文是交给执行者的**零上下文自包含**实施文档：目标、现状、已核实契约、改动清单、测试、红线、
> 验证命令、停止点全部在文内。执行前先通读全文，再动手。
> 撰写日期 2026-08-24；仓库 `I:\m7-studio`（Next.js 16 App Router + React 19 + better-sqlite3 +
> TypeScript strict；UI 文案中文）。

## 1. 任务目标

上一迭代（`docs/2026-08-24-batch-output-freeform-edit-plan.md`，已落地）把批量「检查成片」的片段编辑
升级为自由编辑，但遗留两个交互问题（用户验收时提出）：

1. **「截取」与「修剪」两个入口功能重叠**：新的变长修剪面板（`BatchClipTrimEditor`）的
   「选窗中间拖拽 = 等长整体平移」已经完全覆盖旧「截取」（等长滑窗）的能力，两个按钮并存只会让用户困惑。
   本迭代**合并为一个入口**：删除「截取」按钮与 `TrimEditor` 复用链路，只保留变长修剪面板。
2. **没有时间轴**：现状是「片段卡片条」，看不到片段按比例排列、看不到画面与口播/字幕的对位关系，
   而 ripple 编辑语义（口播不动、画面平移）恰恰最需要时间轴才能看明白。本迭代**用比例时间轴替换
   片段卡片条**，对齐单条混剪 `MixcutTimeline` 的交互范式。

最终交互（全部在现有编辑能力之上，**零后端改动**）：

- 时间轴 = 标尺 + 画面轨（按比例片段块）+ 字幕对照轨（只读）+ 口播锁定轨（只读）+ 播放头，与上方
  实时预览**共享同一个播放头**（点/拖时间轴 = 预览 seek）；
- 画面轨手势：单击选中 · 拖左右边缘 = 变长修剪（`trim_variable`）· 拖中段 = 等长滑窗（同旧「截取」，
  也用 `trim_variable` 提交，长度不变则后续片段不动）· 双击 = 打开精细修剪面板 · 右键 = 菜单
  （精细修剪 / 删除片段）；
- 分割工具：工具栏切换「选择 / 分割」，分割模式下点击片段上的目标位置即切开（`split`）；
- 画面短于口播时画面轨尾部显示「末帧延长」区，画面长于口播时显示「超出裁掉」区——声画错位
  **直接可见**，不再只靠 warnings 文字。

## 2. 现状（上一迭代交付物，先读再改）

- `components/batch-production/BatchOutputEditor.tsx`（513 行）：编辑面板。左侧预览 + **片段卡片条**
  （`:341-406`，等宽卡片 `w-36`，每卡三个按钮：截取 `:379` / 修剪 `:389` / 删除 `:401`），右侧素材池。
  「截取」打开单条侧 `TrimEditor`（`:4` import，`:490-499` 渲染，`:41-72` 两个映射函数
  `toTimelineClip`/`toTrimAsset` 专供它）；「修剪」打开 `BatchClipTrimEditor`（`:500-510`）。
  素材池确认块文案 `:452` 提到「截取」（要同步改）。
- `components/batch-production/BatchClipTrimEditor.tsx`（215 行）：变长修剪面板，双手柄 + 中段平移 +
  分割标记。**本迭代保留不动**，作为时间轴上「双击/右键 → 精细修剪」的入口面板。
- `components/batch-production/BatchTimelinePreview.tsx`（375 行）：实时预览。**播放头
  `playheadSec` 是内部 state**（`:108`），本迭代要改成受控（见 §4.2）。它只被
  `BatchOutputEditor.tsx:331` 一处使用（已 grep 全仓确认）。
- `lib/batch-production/output-arrangement.ts`：视图 `BatchOutputClipEditView` 已具备时间轴需要的
  **全部字段**（`clips[].timelineStartUs/timelineEndUs/sourceStartUs/sourceEndUs`、`visualDurationUs`、
  `narration.durationUs`、`subtitleCues[]`、`poolAssets[].durationSec/thumbnailUrl`）；编辑算子
  `trim_variable` / `split` / `delete` 已全部上线并有测试。**本迭代不改任何后端文件。**
- 测试：`scripts/batch-phase-e-ui-contract.test.mjs` 是源码标记断言（`assert.match/doesNotMatch`），
  目前**没有**读 `BatchOutputEditor.tsx`，只读 `BatchStepReview.tsx` 等；本迭代给它追加对编辑器与
  时间轴的标记断言（§4.4）。

## 3. 已核实契约（设计地基，已读源码）

1. **时间坐标**：`FINAL_EDIT_INTRO_FRAMES = 20`、`FINAL_EDIT_FPS = 24`（`lib/final-edit/types.ts`），
   片头 20/24 秒封面静帧。预览的 `playheadSec` 是**含片头的绝对时间**；clips 的
   `timelineStartUs/timelineEndUs` 与 `subtitleCues[].startUs/endUs` 都是**正文（片头后）相对时间**。
   时间轴 x 坐标一律 `(INTRO_SEC + bodySec) * pxPerSecond`。
2. **可复用的既有设施**（都有批量侧 import 先例，只许 import 不许改源文件）：
   - `components/mixcut/mixcut-content.module.css` 的时间轴样式类：`tlShell tlToolbar tlToolButton
     tlToolButtonActive tlToolHint tl tlLabels tlLab tlScroll tlInner tlRuler tlTick tlTickMinor tlTrack
     tlTrackVideo tlTrackSub tlTrackAudio tlTrackNarration clip clipSel clipNo clipCd clipHandle
     clipHandleL clipHandleR tlPlayhead videoFreezeTail wf wfTts wfLabel timelineContextLayer
     timelineContextMenu timelineContextDanger subtitleSplitPreview`。
     先例：`BatchClipTrimEditor.tsx:6` 已 `import styles from '../mixcut/mixcut-content.module.css'`。
   - `components/final-edit/timeline-edit.ts` 纯函数：`timelineContentWidthPx({totalUs, pxPerSecond,
     viewportWidth})`、`timelineAbsoluteFrameFromPointer({clientX, contentLeft, scrollLeft, pxPerSecond,
     totalFrames, fps})`。先例：`BatchTimelinePreview.tsx:9` 已从 `@/components/final-edit/preview-playback`
     import。
   - `MixcutTimeline.tsx` 的交互范式（播放头拖拽 `:153-168`、VideoBlock 边缘手柄 `:396-435`、右键菜单
     portal `:311-368`、工具栏 `:172-194`）——**照抄模式，不改它的文件**。
3. **编辑算子语义**（服务端已保证，前端只负责提交与展示）：
   - `trim_variable {clipId, sourceStartUs, sourceEndUs}`：新区间在素材时长内、长度 ≥ 0.5s（12 帧），
     ripple 平移后续片段，`visualChanged=true` → 触发重渲染。
   - `split {clipId, offsetUs}`：offset 相对片段源起点，两侧 ≥ 0.5s；**总长不变、不清 review、不递增
     editRevision、不重渲染**（`changed=true, visualChanged=false`）。
   - `delete {clipId}`：只剩一条时拒绝；ripple。
   - 提交成功链路：`submitEdit`（`BatchOutputEditor.tsx:171`）已处理反馈文案、warnings 渲染、
     静默 `loadView(true)` 刷新——时间轴所有操作都走它，**不要新写提交函数**。
4. **批量语义与单条的差异**（不要照搬 mixcut 的行为）：
   - **没有 move/reorder/gap**：clips 顺序固定、从 0 首尾相接（服务端不变量）。所以片段块中段拖拽
     不排序，映射为**等长滑窗**（sourceStart/End 同步平移、长度不变）。
   - 拖边缘改的是**源区间**；时间线位置由服务端 ripple 重算（被拖片段 timelineStart 不变、长度变、
     后续平移）。拖拽中的本地预览要镜像这个规则（§4.1 的 draft 布局）。
   - 字幕轨/口播轨**只读**：本迭代不做字幕拖动/改字、不做口播变速（上一迭代红线继续有效）。
5. **预览播放头受控化的副作用**：父组件持有 `playheadSec` 后，播放中父树以 ~60fps 重渲染。
   单条混剪就是这个模式（`MixcutTimeline` 的 `playheadSec` 就是父级 prop），可接受，不做额外优化。

## 4. 前端改动

### 4.1 新建 `components/batch-production/BatchTimeline.tsx`

比例时间轴组件。常量与换算：

```ts
const FPS = FINAL_EDIT_FPS;                    // 24
const INTRO_SEC = FINAL_EDIT_INTRO_FRAMES / FPS; // 20/24
const PX_PER_SECOND = 60;                      // 与 MixcutTimeline V2 固定缩放一致
const MIN_FRAMES = 12;                         // 0.5s 最短片段
const usToFrame = (us: number) => Math.round((us / 1_000_000) * FPS);
const frameToUs = (frame: number) => Math.round((frame / FPS) * 1_000_000);
```

Props（全部来自 `BatchOutputEditor` 现有数据，不新增取数）：

```ts
export interface BatchTimelineProps {
  clips: BatchOutputClipView[];
  assets: BatchOutputPoolAssetView[];                       // 取 thumbnailUrl/displayName/durationSec
  subtitleCues: Array<{ startUs: number; endUs: number; text: string }>;
  narrationDurationUs: number | null;
  playheadSec: number;                                      // 含片头绝对时间，与预览同源
  selectedClipId: string | null;
  disabled: boolean;                                        // = 编辑器 editLocked；只禁用变更，不禁用 seek/选中
  onSeek: (sec: number) => void;
  onSelectClip: (clipId: string | null) => void;
  onTrimVariable: (clipId: string, sourceStartUs: number, sourceEndUs: number) => Promise<boolean>;
  onSplit: (clipId: string, offsetUs: number) => Promise<boolean>;
  onOpenFineTrim: (clipId: string) => void;
  onDeleteClip: (clipId: string) => void;
}
```

结构与行为：

- **布局**（类名全来自 mixcut CSS module）：`tlShell > tlToolbar + section.tl[data-tool] >
  tlLabels + tlScroll > tlInner(width=timelineContentWidthPx) > tlRuler +
  tlTrackVideo + tlTrackSub + tlTrackNarration + tlPlayhead`。`tlLabels` 与四条视觉行对齐：
  20px 标尺占位 + `视频`（64px）+ `字幕`（28px）+ `口播`（60px），照 mixcut `:196-201` 的高度。
  section 上加 `data-testid="batch-output-timeline"` 与 `aria-label="成片时间轴"`。
- **总时长**：`visualFrames = usToFrame(clips.at(-1)?.timelineEndUs ?? 0)`；
  `narrationFrames = narrationDurationUs != null ? usToFrame(narrationDurationUs) : null`；
  `bodyFrames = Math.max(visualFrames, narrationFrames ?? 0)`；`totalFrames = INTRO_FRAMES + bodyFrames`。
  标尺刻度照 mixcut：每 0.5s 一条，整数秒带 `{n}s` 文本。
- **画面轨片段块**：先把 µs 换成帧——`timelineInFrame = usToFrame(clip.timelineStartUs)`、
  `timelineOutFrame = usToFrame(clip.timelineEndUs)`、`sourceIn = usToFrame(clip.sourceStartUs)`、
  `sourceOut = usToFrame(clip.sourceEndUs)`、`durFrames = timelineOutFrame - timelineInFrame`；
  绝对定位 `left = (INTRO_FRAMES + timelineInFrame)/FPS*pps`、`width = durFrames/FPS*pps`；
  块内缩略图 `<img>`、`#序号`、时长 `X.Xs`；两侧 `clipHandle` 手柄。
  `data-clip-id` 照 mixcut 带上。
- **拖拽**（内部全部按帧计算，提交时 `frameToUs`）：`pointerdown` 记录起点与初值、
  `setPointerCapture`、`pointermove` 更新 draft、`pointerup` 提交；`changed = deltaFrames !== 0`，
  未变化不提交（单击=选中）。三种模式：
  - `start`（左手柄）：`newSourceIn = clamp(sourceIn + Δ, 0, sourceOut - MIN_FRAMES)`；
  - `end`（右手柄）：`newSourceOut = clamp(sourceOut + Δ, sourceIn + MIN_FRAMES, sourceTotalFrames)`；
  - `slip`（中段）：`Δ clamp 到 [-sourceIn, sourceTotalFrames - sourceOut]`，`sourceIn/sourceOut`
    同步平移、长度不变。
  - `sourceTotalFrames = asset.durationSec != null ? Math.floor(asset.durationSec * FPS)
    : usToFrame(clip.sourceEndUs)`（durationSec 缺失时与 `BatchClipTrimEditor.tsx:58` 同款兜底）。
  - **拖拽中的本地布局**（镜像服务端 ripple）：draft 存在时，显示用 clips 重新累计布局——从 0 起
    依次首尾相接，被拖片段用 draft 时长、其余用原时长，逐段平移显示；提交失败（onTrimVariable
    返回 false）丢弃 draft 回到视图值。
  - 提交统一 `onTrimVariable(clipId, frameToUs(in), frameToUs(out))`（slip 长度不变，服务端 ripple
    后后续片段自然不动）。
- **分割**：工具栏「选择 / 分割」两个 `tlToolButton`（照 mixcut `:172-194`，图标用 `Icon` 的
  `check-circle`/`scissors`）。分割模式下：`pointermove` 在片段块上时算 `splitFrame` 并显示
  `subtitleSplitPreview` 竖线；`pointerdown` 提交。换算：
  `absoluteFrame = timelineAbsoluteFrameFromPointer(...)` → `bodyFrame = absoluteFrame - INTRO_FRAMES`
  → `offsetFrames = bodyFrame - timelineInFrame`；两侧 `< MIN_FRAMES` 时不提交（预览线也不显示）。
  `onSplit(clipId, frameToUs(offsetFrames))`。
- **右键菜单**（照 mixcut portal 模式 `:311-368`）：`精细修剪…`（onOpenFineTrim）、
  `删除片段`（`timelineContextDanger`，`clips.length === 1` 时 disabled）。Esc/blur 关闭。
  `disabled`（编辑锁定）时不弹菜单。双击块 = onOpenFineTrim。
- **双击与右键都先 onSelectClip(clipId)**。
- **字幕轨**（只读对照）：cue 块 `left = (INTRO_SEC + startUs/1e6)*pps`、
  `width = (endUs-startUs)/1e6*pps`，`subclip` 类，**`pointerEvents: 'none'`**（点击穿透到底层
  seek），title 显示 cue 文本。
- **口播轨**（只读）：有口播时从 `introPx` 起宽度 `narrationSec*pps` 的色条 + 伪波形（把
  `MixcutTimeline.tsx:26-48` 的 `Waveform` 小组件**原样复制**进本文件——它没有 export，跨侧
  import 不可行，复制时注释注明来源）+ 标签 `口播（锁定）· X.Xs`；无口播时标签 `无口播配音`。
- **错位可视区**：
  - `narrationFrames > visualFrames`：画面轨尾部 `videoFreezeTail` 块，
    `left = (INTRO_SEC + visualSec)*pps`、`width = (narrationSec - visualSec)*pps`，文案 `末帧延长`；
  - `narrationFrames != null && visualFrames > narrationFrames`：同位置逻辑显示 `超出裁掉` 块
    （复用 `videoFreezeTail` 类，inline `style` 覆盖背景为警示色，文案 `超出裁掉`）。
- **播放头**：`tlPlayhead` 按钮 `left = playheadSec * pps`，拖拽照抄 mixcut `beginPlayheadDrag`
  （`:153-168`，内部用 `timelineAbsoluteFrameFromPointer` + `onSeek(frame / FPS)`）；`tlInner`
  的 `pointerdown`（左键、非片段块/手柄冒泡上来的）也 seek。播放头始终可拖（`disabled` 不锁 seek）。
- **空 clips**：三条轨照常渲染（标尺 + 口播/字幕），画面轨为空；工具栏按钮 disabled。
- **口播轨标签位置**照 mixcut 用 `wfLabel` + `left: introPx + 8`。

### 4.2 `BatchTimelinePreview.tsx` 播放头改受控

把内部播放头 state 改成受控 props，让时间轴与预览共享同一个播放头。**该组件只有
`BatchOutputEditor` 一处使用**（已 grep 确认），直接改签名：

1. props 新增 `playheadSec: number` 与 `onSeek: (sec: number) => void`；删除 `:108` 的
   `useState(0)`。组件内所有 `setPlayheadSec(x)` 改为驱动函数 `drivePlayhead(x)`：
   ```ts
   const lastDrivenSecRef = useRef(0);
   const drivePlayhead = useCallback((sec: number) => {
     lastDrivenSecRef.current = sec;
     onSeek(sec);
   }, [onSeek]);
   ```
   rAF 时钟 tick、`seek()`、`togglePlayback` 里的起点重置，全部走 `drivePlayhead`。
2. 新增**外部 seek 同步 effect**（时间轴拖动/点击发起的 seek 走这里对齐音频与播放时钟）：
   ```ts
   // 外部 seek（时间轴）与自有时钟驱动的区分:时钟驱动会先写 lastDrivenSecRef,差值≈0;
   // 外部 seek 差值大,暂停时对齐音频,播放中时基重置并对齐口播/BGM。
   useEffect(() => {
     if (Math.abs(playheadSec - lastDrivenSecRef.current) <= 1 / FPS) return;
     lastDrivenSecRef.current = playheadSec;
     if (playing) {
       clockOffsetRef.current = playheadSec;
       clockStartRef.current = performance.now();
       syncAudioStart(playheadSec);
     } else {
       synchronizePausedAudio(playheadSec);
     }
   }, [playheadSec, playing, syncAudioStart, synchronizePausedAudio]);
   ```
3. `seek()` 内原有 `stopPlayback()` + `synchronizePausedAudio` 逻辑保持，末尾 `drivePlayhead(clamped)`。
4. 其余（双 slot、canvas 上屏、字幕、音量包络）一行不动。

### 4.3 `BatchOutputEditor.tsx` 重构

- **删除**：`TrimEditor` import（`:4`）、`toTimelineClip`/`toTrimAsset`（`:41-72`）、`trimClipId`
  state 与其派生 `trimClip/trimClipIndex/trimAsset`、`handleTrimCommit`、片段卡片条整段 JSX
  （`:341-406`）、`TrimEditor` 渲染块（`:490-499`）。`FPS/usToFrame/frameToUs`（`:20-22`）若因此
  无人使用一并删除（lint 会报）。
- **新增**：`const [playheadSec, setPlayheadSec] = useState(0);`；在 `loadView` 的切换重置 effect
  （`:122-131`）里补 `setPlayheadSec(0)`。
- `BatchTimelinePreview` 调用处补 `playheadSec={playheadSec} onSeek={setPlayheadSec}`。
- 卡片条原位置（预览下方）改为**整行跨列**的时间轴：把 `</section>` 与右侧 `section`（素材池）
  的 grid 结构保持，时间轴放在 grid **之后**整宽渲染：
  ```tsx
  <BatchTimeline
    clips={clips}
    assets={poolAssets}
    subtitleCues={view.subtitleCues}
    narrationDurationUs={view.narration.durationUs}
    playheadSec={playheadSec}
    selectedClipId={selectedClipId}
    disabled={editLocked}
    onSeek={setPlayheadSec}
    onSelectClip={setSelectedClipId}
    onTrimVariable={async (clipId, sourceStartUs, sourceEndUs) =>
      submitEdit({ type: 'trim_variable', clipId, sourceStartUs, sourceEndUs })}
    onSplit={async (clipId, offsetUs) => submitEdit({ type: 'split', clipId, offsetUs })}
    onOpenFineTrim={(clipId) => { setSelectedClipId(clipId); setFreeformClipId(clipId); }}
    onDeleteClip={(clipId) => void confirmDelete(clipId)}
  />
  ```
- 素材池文案同步：`:411-415` 的「先在左侧选中片段」改「先在时间轴上选中片段」；`:452` 确认文案里的
  「截取」改「修剪」。
- `confirmDelete`、`BatchClipTrimEditor` 渲染块、`submitEdit`、摘要行、warnings 全部保持原样。
- 删除操作后 `setSelectedClipId(null)` 的既有逻辑（`:268-271`）保持。

### 4.4 `scripts/batch-phase-e-ui-contract.test.mjs` 追加标记断言

照该文件既有风格（顶部 `readFileSync` + 末尾 `assert`），追加：

```js
const outputEditor = fs.readFileSync('components/batch-production/BatchOutputEditor.tsx', 'utf8');
const batchTimeline = fs.readFileSync('components/batch-production/BatchTimeline.tsx', 'utf8');
// 截取/修剪合并为一个入口:编辑器不再出现「截取」按钮与旧 TrimEditor 复用
assert.doesNotMatch(outputEditor, />截取</);
assert.doesNotMatch(outputEditor, /mixcut\/TrimEditor/);
// 时间轴替换片段卡片条:比例时间轴存在且带画面/字幕/口播三轨与错位可视区
assert.match(outputEditor, /BatchTimeline/);
assert.match(batchTimeline, /batch-output-timeline/);
assert.match(batchTimeline, /末帧延长/);
assert.match(batchTimeline, /超出裁掉/);
assert.match(batchTimeline, /口播（锁定）/);
assert.match(batchTimeline, /data-tool/);
```

## 5. 不需要动

- **后端零改动**：`lib/batch-production/output-arrangement.ts`、两个路由、渲染器全部不动（视图字段
  与编辑算子已齐，见 §3.3）。`scripts/batch-output-clip-edit.test.ts` 不改且必须保持全绿。
- `BatchClipTrimEditor.tsx`（精细修剪面板原样保留，双击/右键打开）。
- `BatchStepReview.tsx`（「调整片段」入口与弹窗结构不动；时间轴在弹窗内靠 `tlScroll` 横向滚动，
  不需要拓宽弹窗）。
- 单条侧任何文件：`components/mixcut/`、`components/final-edit/`、`lib/final-edit/`（只许 import，
  不许改）。

## 6. 红线与 scope cut

- 不动 schema/迁移；不动 git（add/commit/push 一律禁止）。
- 工作树里 `app/globals.css`、`components/VideoGenerationPanel.tsx`、
  `scripts/video-bulk-prompt-ui-contract.test.mjs` 是另一任务的既有改动，不要碰。
- **不做**：字幕拖动/改字、口播变速/重对齐、片段排序（批量语义没有 reorder）、时间轴缩放
  （固定 60px/s）、间隙/黑场、新依赖。
- 新增 UI 颜色走设计令牌/mixcut CSS module 既有类，不新增硬编码浅色值（暗色覆盖靠 module 自带）。

## 7. 验证清单（全部真跑，不许凭印象声明通过）

```bash
node scripts/batch-phase-e-ui-contract.test.mjs    # 含 §4.4 新断言
node scripts/batch-output-clip-edit.test.ts        # 后端零改动,必须原样全绿
node scripts/batch-phase-e-orchestration.test.ts
node scripts/batch-phase-e-schema.test.ts
npx tsc --noEmit
npm run lint                                       # 0 error；你触动的文件零 warning（存量基线：37 条 warning 在未触碰文件）
```

手动冒烟（`npm run dev` 起服务，进「检查成片 → 调整片段」）：

1. 时间轴三轨渲染，播放头拖动/点击轨道 = 预览同步 seek（含暂停时口播对齐）；
2. 拖片段右缘变长 → 松手后后续片段平移、触发重渲染；拖中段平移 → 源区间平移、长度不变；
3. 分割模式下点击片段 → 一分为二、**不**触发重渲染（卡片不进渲染中）；
4. 右键菜单：精细修剪打开 `BatchClipTrimEditor`、删除有 confirm、只剩一条时删除禁用；
5. 删短片段后画面 < 口播 → 画面轨尾部出现「末帧延长」区；加长到画面 > 口播 → 出现「超出裁掉」区。

**预存失败基线**：`scripts/batch-render-smoke.test.ts` 在本机失败（ffmpeg 环境差异，2026-08-24
已确认与本任务无关）。执行前先跑一遍拿基线；执行后它仍败是预期，不许当成自己改坏的，也不许顺手修。

## 8. 执行纪律与停止点

1. 动手前先读：本文 → `docs/reference/批量生产模块.md` → 上一迭代文档 →
   `BatchOutputEditor.tsx` / `BatchTimelinePreview.tsx` / `BatchClipTrimEditor.tsx` /
   `MixcutTimeline.tsx` 现状代码。
2. 改动最小化：不顺手重构、不改无关格式、不引入新依赖。
3. 完成后：`docs/reference/批量生产模块.md` 的 Phase E 段片段编辑 bullet 更新为「时间轴编辑
   （比例画面轨 + 字幕/口播对照轨 + 播放头与预览同步；边缘变长修剪、中段等长平移、点击分割、
   右键删除，双击进精细修剪面板）」。
4. 停下并汇报的情形：发现本文与代码现状冲突（锚点找不到、契约已变）、需要动后端/单条侧文件才能
   达成、或测试出现无法归因的失败。
5. 汇报格式：改动/新增文件清单（带要点）、实际运行的验证命令与结果（贴关键输出）、偏离本文档的
   点及原因。
