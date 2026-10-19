# 包装面板瘦身 + 画面内文字直改 + 封面图包装修复 · 设计（2026-10-10）

> 背景：预览调整步的「视频包装」右栏过长（2×2 大模板卡 ≈500px + 5 个文案输入框）；导出联动模式下封面 JPG 无包装（视频正常）；另有模板 B 封面卖点选不中的存量 bug。用户逐问定稿：①模板卡四列瘦身+悬停放大预览卡（沿用 CSS 示意图，不用真图截图——会增加缓存量，且预览窗口切换模板已能直观感受差异）；②删右栏文案输入区，改为预览画面内双击+悬浮输入框直改（封面主副标题/封面卖点/正片卖点全覆盖），空元素幽灵占位可双击补加；③封面图高保真合成（overlay.webm 抽透明帧 + sharp 合成原始底图）。本文含一轮自我反驳的 8 项修订。

## 0. 反驳修订记录（已并入下文各节）

| # | 反驳点 | 修订 |
|---|---|---|
| 1 | 悬浮输入框放 iframe 内必被视口裁切（§18.6 手柄教训放大 10 倍）+ iframe/父页焦点与快捷键边界 | 浮框改父页渲染：桥只识别手势，postMessage 报 {pointId, rect}，PreviewStep 渲染浮框 |
| 2 | sharp「复刻」renderer 封面管线 = 第三次制造双实现（§13.2 吸色教训） | 抽共享函数 composeCover，renderer/packaging 单实现 |
| 3 | 包装快照缺封面输入、靠 renderJobId 回读渲染任务行 | 联动入队时封面输入冻结进包装快照（自包含，与 layouts/字体同哲学） |
| 4 | 覆盖已发布封面后前端可能缓存旧素封面（用户报假 bug） | 查证产物图路由缓存头，必要时 no-cache / mtime query |
| 5 | 抽帧 coverSec−1帧 时 D 逐字跳舞花字可能未落定 | 帧时间提为常量 COVER_SETTLE；验收加四模板抽帧人工确认落定 |
| 6 | 幽灵占位「模板如何知道编辑态」机制缺失 | 桥注入后轮询置 documentElement.dataset.edit，模板读它渲染幽灵 |
| 7 | 浮框键盘冲突（Esc 触发 exitToParent、空格触发播放暂停） | 浮框 keydown stopPropagation + 聚焦期间 PreviewStep 抑制全局快捷键 |
| 8 | CSS 示意图与 v4 模板漂移（D 还是 v2 色块条） | 本次顺手修正 D 示意图；不引入真图（用户决策） |

## 1. §A 模板选择区瘦身（PackagingCard.tsx + mixcut-content.module.css）

- `tplGridCompact` 2 列 → **4 列横排**：卡片 = 缩略图 + 模板名；`tplDesc` 移出文档流（不再占高度）。整区 ≈115px（现 ≈500px）。
- **悬停放大预览卡**：悬停 ~250ms 后在卡片左侧浮出大卡（≈220px 宽：3/4 大缩略图 + 名称 + 完整描述），移走即关。纯 CSS 实现：`:hover` + `transition-delay`（visibility/opacity 双属性过渡），浮层 `pointer-events:none`，零 JS 状态。注意 visibility 不能 transition，须用 `transition: visibility 0s .25s, opacity .15s .25s` 类技巧。
- 修正 D 模板示意图漂移（逐字花字/笔刷副标/搜索框卖点 motif），其余三套示意图顺手对一遍 v4 特征。
- 交互契约不变：`role=radiogroup/radio`、选中蓝描边+光晕、点击切模板。

## 2. §B 画面内文字直改

### 2.1 交互与架构

- **双击进入编辑**：编辑桥（packaging-preview route.ts §6）新增 `dblclick` 捕获监听，命中走 elementsFromPoint 命中栈（§16.3 红线，禁 e.target）。命中 `data-point-id` 元素后收集 `{pointId, rect}`，经既有同源通道 `window.parent.__packagingEditText(pointId, clientRect)` 上报。
- **浮框在父页**：PreviewStep 渲染悬浮输入框，定位 = iframe rect + 元素 rect 换算，视口 clamp（元素贴边时翻到另一侧/下方）。预填当前文案（父页自有数据：封面 ← preview.vars，正片 ← pointCues，桥不传文本），40 字上限与现有一致。Enter/失焦提交，Esc 取消。
- **键盘隔离**：浮框 keydown stopPropagation；打开期间 PreviewStep 抑制全局快捷键（空格播放暂停、Esc 取消选中）。
- **提交路由**（复用 set_packaging_config 串行队列，离散提交无防抖）：
  - `cover:title/subtitle/point1-3` → varsOverrides 合并（与 preview.defaults 相同则删键，逻辑同现防抖保存）。
  - `cue:<id>` → pointCues 文本替换（置 edited 保护，与时间线双击改字同路径）。
- 提交后经既有重载键刷新 overlay（varsOverrides/pointCues 本就在重载键内），模板 refitAll 自动重排；继承既有「改文案整帧重载」行为，不新增闪烁优化。

### 2.2 幽灵占位（空元素补加）

- 桥轮询 editMode 时同步置 `document.documentElement.dataset.edit`（active 镜像）。
- 四模板：为空的 title/subtitle/point1-3 渲染虚线幽灵占位（「双击添加副标题」「双击添加卖点三」等），CSS 仅 `html[data-edit]` 下可见（CLI 渲染无此标记，不进成片）。幽灵挂原 data-point-id + `data-ghost="1"`。
- 桥对 `data-ghost` 元素只放行 dblclick，禁止选中/拖拽/手柄——`hitEditable` 与 250ms only 自动高亮循环均须跳过 `[data-ghost]`（幽灵与原元素同 data-point-id，不防会被 querySelector 抢先匹配）。
- 模板侧布局机械（`applyAllLayouts`/`resetGeometry`/fit）查询改 `[data-point-id]:not([data-ghost])`，幽灵不参与布局应用与测量。

### 2.3 右栏裁减

- 删除 5 个文案输入框（VAR_FIELDS）+ 说明文字 + 防抖保存逻辑（PackagingCard 内 draft/saveConfigPatch 的 varsOverrides 分支相应清理）。
- 「恢复默认文案」并入按钮行第 4 枚小按钮（跳到封面/恢复默认版式/重新提取卖点/恢复默认文案）。
- 时间线双击改字保留不动。

## 3. §C 封面图高保真合成

### 3.1 根因（已实锤）

联动模式 worker.ts 在渲染任务成功时先把 `cover.jpg`（renderer.ts 仅合成底图+旧 title.png，无包装层）发布为 final_cover；包装任务只产视频不碰封面 → 导出目录里封面图永远是无包装版。

### 3.2 方案

1. **共享函数**：renderer.ts 封面段（coverFramingGeometry → resize/extract → composite → jpeg q92）抽为 `lib/final-edit/cover-compose.ts` 的 `composeCoverJpg({coverSource, framing, output, overlays[], jpgPath})`。renderer 传 `overlays=[title.png?]`；packaging 传 `[title.png?, overlay-frame.png]`。单实现，拒绝双实现。
2. **快照冻结**：worker.ts 组装 packagingSnapshot 时新增 `cover: { relativePath, framing, width, height, titlePngPath? }`（取自渲染快照），类型同步 FinalEditPackagingSnapshot。
3. **抽帧**：包装视频发布成功后，ffmpeg `-c:v libvpx-vp9 -i overlay.webm -ss <COVER_SETTLE> -frames:v 1 overlay-frame.png`（libvpx 解码是 §12.4 红线；`-ss` 放 `-i` 之后走精确解码 seek，避免 VP9 关键帧 seek 落到未落定帧）。COVER_SETTLE 默认 coverSec − 1/24（模板入场动画须落定，验收确认四模板）。
4. **合成与覆盖**：composeCoverJpg 输出 temp jpg → 同目录 rename 原子覆盖已发布封面。artifact 记录路径不变，DB 零更新。
5. **缓存查证**：实施时确认产物图服务路由缓存头；若可缓存，加 no-cache 或 mtime query（防覆盖后 UI 显示旧素封面）。
6. package-video.mjs 的 overlay.webm 须保留到封面合成后（查现有清理逻辑调整）。

### 3.3 边界

- 失败语义：封面合成失败 = 包装任务 failed（可重试；重试幂等重跑）；视频已发布不受影响；publish-original 兜底时素封面保持（与无包装视频一致）。
- 仅联动模式（snapshot.exportTarget 存在）执行；v1 独立包装 API（-包装.mp4）不发封面，不动；批量无包装功能，不涉及。
- 中止安全：temp+rename 原子，中止不污染已发布封面。

## 4. §D 模板 B 便签选不中修复（存量 bug）

- **根因**：overlay-journal `.note { pointer-events: none }`（v4 纯展示层遗留）使 note 子树被 elementsFromPoint 整体跳过，命中栈无 data-point-id → 桥判「点空白」。封面便签与正片 cue 便签同 class 全挂；其余三模板可编辑元素无此规则。
- **修复**：删除该行（overlay-journal 生产 + `_src` 镜像，MD5 同步；`_proto-journal-v4` 为存档快照不同步）。`.cover-frame` 的 pointer-events:none 保留（全幅装饰图必须保持穿透）。
- 安全性：overlay iframe 恒带 edit=1 桥；非编辑态桥提前 return 事件自然放行，iframe 内无其他点击消费者，pointer-events 恢复无行为回归。
- **回归断言**：`packaging/_t-verify.mjs` 新增「四模板全部 [data-point-id] 元素 computed pointer-events ≠ none」（--dump-dom 可查 computed style，堵死此类只能靠真鼠标发现的 bug）。

## 5. 验证计划

- 单测：packaging-vars（cue 文本替换/varsOverrides 合并删键回环）、cover-compose 抽取后 renderer 路径回归、_t-verify.mjs 43+n 断言（幽灵占位 + pointer-events + 既有布局）。
- 浏览器真鼠标路径（§16.3）：journal 封面便签/cue 便签选中拖拽；双击改字（封面三元素+正片 cue）；幽灵双击补加；Esc/失焦/Enter 三分支；浮框视口 clamp。
- 封面合成端到端：联动导出 → 封面 JPG 与视频封面帧抽帧比对（像素差异率阈值）；四模板落定帧人工确认；失败注入（坏 ffmpeg 路径）→ 包装 failed 可重试、视频与素封面无碍。
- 生效路径：模板改动运行时直读（双侧 MD5）；app 侧 `npm run build` + robocopy 同步 standalone。

## 6. 明确不做（YAGNI）

- 真图模板截图（用户否决：缓存量 + 预览窗口已直观）。
- 文字提交免重载优化（继承既有重载行为）。
- 正片 cue 幽灵（空 cue 无意义，时间线「+ 卖点」管增）。
- v1 独立包装路径封面、批量包装。
