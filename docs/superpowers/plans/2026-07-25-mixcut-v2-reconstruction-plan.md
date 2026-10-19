# 智能混剪 V2 — 界面重构 + 后台提速 执行文档

> 日期：2026-07-25
> 类型：交接执行文档（可由另一个 AI/工程师独立执行）
> 依据：PRD `../specs/2026-07-23-mixcut-prd.md`、V1 评审 `2026-07-24-mixcut-v1-completion-review.md`
> 触发：主理人验收 V1 后反馈「界面挤、和样机差距大；后台太慢；第 3 步打不开」。方向已定：**先最小修复 + 写本重构文档**；提速走**并行化优先**。

---

## 0. 已在 2026-07-25 当场完成（执行者勿重复做）

这两项已在主仓库 `mixcut01` 分支改好、`npm run lint`（0 error）、`npm run build`（exit 0）通过：

1. **第 3 步「预览调整」打不开（阻塞级 bug，已修）**
   - 根因：`components/mixcut/MixcutPanel.tsx` 轮询 effect 竞态。任务变 `succeeded` 时 `setActiveJob` 触发该 effect 依赖（`activeJobStatus`）变化，清理函数把 `jobPollRef.current` 置空；随后 group 抓取完成时 `if (jobPollRef.current !== token) return;` 误判提前返回，`setPreparedGroup` **永不执行** → 进度 100% 但预览一直卡「预览草稿尚未准备完成」。后台其实成功并写入了 variants（`lib/final-edit/workspace.ts:1186,1202`），刷新页面即恢复，印证是纯前端竞态。
   - 修法：把「成功后加载草稿组」从轮询里拆成独立 effect（keyed on `activeJobStatus==='succeeded'` + `groupId`，自带 `cancelled` 守卫）。

2. **素材池最小修复（交互语义 + 固定框）**
   - `components/mixcut/MaterialStep.tsx` + `MixcutPanel.module.css`：素材池套 `.materialPool`（`max-height:46vh; overflow-y:auto` 的固定框，上下滑挑选）；交互从「勾选=挑选」改为「**默认全用，点击=排除/恢复**」——被排除卡片虚线+置灰+「已排除」，角标 `✕`(移除)/`＋`(恢复)；文案与页脚改为「N 个将参与混剪 / 恢复全部（已排除 M 个）」。移除了不再使用的 `onClear`。
   - 说明：这是**止血**。V2 视觉系统落地时，本组件应并入新设计（见 Part A §A3），不要停留在止血版。

---

## 1. 背景与差距（为什么要 V2）

V1 按迁移执行文档完成了功能与后端（音频优先匹配、真实 ffmpeg 渲染、组隔离、导出），但**界面与主理人样机差距大**：

- **视觉拥挤**：正式界面是「顶栏 + 左步骤条 + 中辅栏 + 右主区」的单列滚动堆叠，字号普遍 8–11px，统计块、卡片、进度挤在一起（三张验收截图为证）。
- **素材池**：曾是无固定高度、越堆越长的网格（已止血为固定框）。主理人心智：**素材全用，点选只为删除个别**——已在止血版对齐，需在 V2 设计中正式承载。
- **后台慢**：一次准备任务实测 241 秒，主理人对比其 demo「慢很多」。

### ⚠️ 参照物已丢失（执行前必读）
主理人提到「项目里只做了前端界面的那个 demo，是很好的参照」——即 V1 评审 §3 删除的 `app/mixcut-preview/` + `components/mixcut-prototype/`。经全盘磁盘、全部 git 分支、worktree、stash 搜索，**该原型未提交且已删除，无法找回**。

**2026-07-25 决定：视觉基准改用 AI-remix**（主理人原话「参照原型 demo 没了，那就看下 AI-remix-master」）。因此 Part A 不再阻塞于样机，而是**逐条对标 AI-remix 源码**（已研读，规格见 Part A）：
- `/Users/liangpeijian/for-cc/AI-mixcut/AI-remix-master/short-video-mashup-tool`（Electron + MUI + Zustand；只借**设计语言/布局/信息层级/进度条**，技术栈不搬，全部翻译成本项目 CSS Module）。核心文件：`theme/fcpTheme.ts`、`components/layout/{AppShell,Panel,StepLeftPanel,StepRightPanel}.tsx`、`components/analysis/AnalysisProgress.tsx`、`components/materials/*`。
- 本次三张验收截图（标注了「哪里挤」）作为反例校验。
- 落地前建议先出一版 HTML 视觉稿给主理人确认（避免 V1 的「凭空猜」重演）。

---

## 2. 范围

- **Part A — 界面视觉/布局重构**（大）：从「单列堆叠」改为有呼吸感的工作台布局，字号/间距/卡片体系重排，正式承载素材池交互。**前置：拿到样机。**
- **Part B — 后台提速（并行化优先）**（中）：并行化逐视频分析与逐句 TTS；进度卡做成可读的分阶段/计数。
- **Part C — 素材池终态**：把止血版并入 V2 设计系统。

非目标：改匹配算法质量（音频优先逻辑保持）；改导出/渲染管线；双平台打包。

---

## Part A — 界面视觉/布局重构（对标 AI-remix，已研读源码）

原型 demo 丢失后，**视觉基准改为 AI-remix**（`AI-mixcut/AI-remix-master/short-video-mashup-tool`，主理人实盘验证过「好用」）。以下规格从其源码逐条提取，翻译为本项目的 **CSS Module（不引入 MUI）**。注意：本项目混剪是**嵌在产品工作台第 5 步**里的面板，不是独占整屏的 app，布局要点在「高度模型」而非全屏。

### A1. 根因：为什么现在「挤」（file:line）
- `MixcutPanel.module.css:6 .shell{min-height:680px}` 是**最小高度不是固定高度**：内容一多整卡片往下撑、带动整页滚动。
- `.body:25{min-height:616px}` 同理会长高；`.materialStep{height:100%}` 相对一个「会长高的父级」→ 内部 `overflow-y:auto` **永远触发不了**，于是所有内容堆叠、互相挤压。
- 字号普遍 8–11px（`.materialToolbar strong{11px}`、`.materialMeta small{9px}`、`.stepNav button strong{11px}`、`.groupPicker small{8px}`）——层级对比不足，观感更挤。

> AI-remix 的解法（`AppShell.tsx:141`）：根容器 `height:100vh; overflow:hidden` **固定骨架**，内部每个区各自 `flex:1; minHeight:0; overflow:auto`（`AppShell.tsx:344` 中心区、`Panel.tsx:43` 侧栏体）。**先把骨架钉死、再让各区内部滚动**——这是「不挤」的根本。

### A2. 设计 token（从 `theme/fcpTheme.ts` 提取；浅色为默认）
| 语义 | 浅色 | 深色（可选） | 当前混剪对应 |
|---|---|---|---|
| 工作台底 bg | `#ECECEC` | `#121212` | `.shell` 现 `#f5f5f7`，可保留 |
| 面板 paper | `#FFFFFF` | `#1E1E1E` | 卡片/侧栏 |
| 次级面板 paperAlt | `#F7F7F8` | `#262626` | stat 块底 |
| 分隔线 | `#D9D9D9` | `#2E2E2E` | `--mixcut-line`(#e5e5ea) |
| 主文字 | `#1D1D1F` | `#F5F5F7` | `--mixcut-ink` |
| 次文字 | `#6E6E73` | `#A1A1A6` | `--mixcut-secondary` |
| 主色 primary | `#1976D2` | `#2DD4BF` | `--mixcut-blue`(#0071e3)，保留即可 |
| success/warn/error/info | `#34C759`/`#FF9F0A`/`#FF3B30`/`#0A84FF` | 同 | 语义色统一到这套 |
| 圆角 | 8（按钮/卡）·面板 12 | | 现 11–14，收敛到 8/12 |

字号阶梯（`fcpTheme typography`）：**body 14 / body2 13 / caption 12**，标题 h6 700 且 `letter-spacing:-0.01em`。→ 新建 `--mixcut-fs-body:13px / -sm:12px / -title:15px`，把现有 8–11px 全量抬到这套 2–3 级层级。字体栈：`"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui`。

### A3. 布局骨架改造（核心）
1. **钉死高度**：`.shell` 由 `min-height:680px` 改为**填满可用视口**——`height: calc(100vh - <工作台顶栏+5步Tab 的高度>)`（或让父级 `app/projects/[id]` 给它一个 flex 定高容器），`overflow:hidden` 保留。`.body`/`.bodyPreview` 去掉 `min-height:*`，改 `height:100%`。
2. **各区内部滚动**：`.main` 保持 `overflow:hidden`；每个 Step 的根（`.materialStep/.creationStep/...`）改成 `display:flex;flex-direction:column;height:100%;min-height:0`，把**可变长的区（素材池、脚本、音色、进度）各自 `flex/overflow:auto`**，页头/页脚固定。素材池止血版的 `.materialPool{max-height:46vh}` 换成 `flex:1;min-height:0`（吃掉剩余高度，随窗口变）。
3. **侧栏 Panel 化**：把 `MixcutSidebar` 的每块（当前素材组 / 统计 / 步骤概览 / 最近会话）套一个 `Panel`（对标 `Panel.tsx`：paper + 标题行 subtitle2/700 + `flex:1;overflow:auto` 体）。
4. **统计做成 Stat 磁贴**：对标 `StepLeftPanel.tsx:62 Stat` —— 2×2 网格，每格 paperAlt + 1px 边、大号数字（h6/700/lineHeight:1）+ caption 标签。现有 `.statGrid` 已接近，抬字号、统一留白即可。
5. **左步骤条**：对标 `AppShell.tsx:216` —— 34px 圆图标（active 填主色、已访问显绿勾）、active 左侧 3px 竖条、label active 700+主色。现有 `.stepNav` 已是雏形，补「已完成绿勾」「active 左竖条」。
6. **（可选，二期）可调宽 + 可折叠侧栏**：`AppShell` 的 `Resizer`(6px col-resize) + 折叠按钮 + localStorage 记忆。非必须。
7. **（可选，二期）深色模式**：token 已给深色；如上主理人要再加 `ThemeSwitch`。

### A4. 各步右侧/主区内容映射（AI-remix → 本项目）
- Step1 导入：主区 = 素材池（Part C）；侧栏 = 素材库概览 Panel（`StepImportLeft`）。
- Step2 创作：主区 = 脚本+音色+进度（现 `CreationStep`，按 A3 拆成内部滚动的卡列）；进度卡对标 `AnalysisProgress`（见 Part B §B3）。
- Step3 预览：主区 = 时间线/预览（现 `PreviewStep`）；对标 `TimelineEditor` + 右栏 `StepPreviewRight`（字幕样式/BGM/封面卡）。
- Step4 导出：对标 `ExportConfirm` + `StepExportLeft` 校验清单（勾选项 + 「可以导出」chip）。

### A5. 验收标准
- 页面主体不再「一根到底」滚动：素材多时**只有素材池内部滚动**，页头/页脚/统计不被挤压（对照 `AppShell` 的固定骨架行为）。
- 基础字号 ≥12px、正文 13px，层级 2–3 级；配色走 A2 token。
- 逐屏与 AI-remix 对应步骤在**分区、层级、留白**上同构（建议先出 HTML 视觉稿给主理人确认，再落地——见 §3 建议）。
- 窄屏不横向溢出（沿用现有媒体查询）。

---

## Part B — 后台提速（并行化优先）

### B1. 慢在哪（已定位，file:line）
准备管线 `lib/final-edit/workspace.ts` 的 `prepare()`：
- **analyzing（0→0.3）串行逐视频大模型视觉分析**：`:918 for (const row of rows)` 循环内 `:920 probeVideo` + `:937 analyzeVideo`（多模态大模型）。7 个视频 = 7 次串行大模型往返 = **主要耗时**。
- **synthesizing（0.3→0.55）逐句串行 TTS**：`:998 synthesize`（`onSegmentComplete` 逐句回调）；适配器 `lib/final-edit/adapters/vapi-qwen-tts.ts:132 for (segmentIndex...)` 也是串行。
- matching/previewing 相对轻（语义矩阵 1 次大模型 + 本地 ffmpeg 预览）。
- **已有缓存**：分析按 `fileFingerprint+providerId+model+analyzerVersion` 命中（`:925,:929`），语义矩阵有 `final_edit_semantic_matrix_cache`——**首跑慢、重跑快**。提速主要救「首跑」。

### B2. 并行化改造（保持匹配逻辑不变）
1. **逐视频分析并行**：把 `:918` 的 `for` 改为**有限并发**（建议并发度 3–4，可由 `projects.concurrency` 或新设置驱动；参考 CLAUDE.md「provider-concurrency」约定）。每个迭代相互独立（各写各自 `final_edit_asset_analysis` 行）。注意：
   - `better-sqlite3` 写是同步串行的，天然无并发写冲突；但要确保**每个任务内不持有跨 await 的半完成状态**。
   - 进度 `updateJob('analyzing', done/total*0.3)` 改为**完成计数**（用原子递增的 completed 计数，不要用循环下标）。
   - 失败仍按现有逻辑降级（`:957 catch` 写 failed 分析、从匹配池排除），单个失败不拖垮整批。
   - `prepared[]` 需保持稳定顺序（先占位后回填，或收集后按 rows 顺序排序），下游 `matcherAssets`/封面选择依赖顺序。
2. **逐句 TTS 并行**：`vapi-qwen-tts.ts:132` 的分句合成改有限并发（并发度 2–3，避免触供应商限流），保留：
   - 段落**顺序**用于拼接与对齐（并发产出后按 index 归位）。
   - `onSegmentComplete(completed,total)` 改为**完成计数**回调（当前用 `segmentIndex+1`，并发下会乱序）。
   - 对齐（`adapters/alignment.ts`）与既有重试逻辑不变。
3. **可选**：analyzing 与 synthesizing 之间无强依赖（synthesize 只依赖脚本，不依赖视频分析结果），可评估**两阶段重叠启动**（先并发起 TTS 与视频分析）。风险更高，列为二期。

### B3. 进度可读性（低成本 UX，和提速一起做）
- `components/mixcut/CreationStep.tsx` 的「真实后台进度」已有 4 阶段（`STAGES`）。对标 AI-remix `components/analysis/AnalysisProgress.tsx`：加**分阶段计数**（如「分析 3/7」「口播 5/8」）与 stepper 态，让 241→(提速后)更短的过程不再是一根不动的进度条。数据源：`updateJob` 已按阶段写 `progress`；可扩展 job 快照里回传 `analyzedCount/total`。

### B4. 验收标准
- 同一 7 视频首跑任务，墙钟时间较改造前**显著下降**（目标：分析阶段接近「单个最慢视频 × ⌈N/并发度⌉」而非 N 倍串行）。
- `scripts/*.test.ts` 全绿（尤其 `final-edit-workspace.test.ts`、`audio-first-*`、TTS/对齐相关）；`final-edit-mixcut-real.playwright.test.mjs` 真实 E2E 仍通过（无黑场/冻结、组隔离、真实 ZIP）。
- 并发下 DB 无脏写、`prepared`/段落顺序稳定、进度单调不回退（`:906 updateJob` 已有「不回退」守卫，需在并发下复核）。
- 供应商限流（429/超时）有退避，不因并发放大失败率。

---

## Part C — 素材池终态
把 §0.2 止血版并入 Part A 设计系统（尺寸/配色/空态/导入区随新 token）。语义不变：默认全用、点击排除/恢复、固定框上下滑。验收：与样机一致，且「排除→恢复→开始创作」端到端选择集正确落到 `selectedMaterialKeys`（自动保存路径 `MixcutPanel.persistCurrentState`）。

---

## 3. 执行顺序建议
1. **B（提速）先行**：纯逻辑、可被单测/E2E 钉住，风险可控，主理人体感提升最快。
2. **取样机 → A（视觉）**：拿到样机再动视觉，避免二次返工。
3. **C** 随 A 落地。

## 4. 测试与门禁
- `node scripts/<name>.test.ts` 全量（Node 22+）；重点见 §B4。
- `npm run lint`（0 error）、`npm run build`（exit 0）。
- 两个 Playwright：`final-edit-mixcut.playwright.test.mjs`（mock UI）、`final-edit-mixcut-real.playwright.test.mjs`（真实 E2E）。
- 人工：7 视频首跑计时对比；素材排除/恢复；第 3 步在同一会话内直达（不靠刷新）。

## 5. 证据附录（file:line）
- 第 3 步竞态：`components/mixcut/MixcutPanel.tsx`（轮询 effect / 新独立成功 effect）；后台成功写入：`lib/final-edit/workspace.ts:1186,1202`。
- 串行分析：`lib/final-edit/workspace.ts:918,920,937`；分析缓存：`:925,929-947`。
- 串行 TTS：`lib/final-edit/workspace.ts:998,1001`；适配器 `lib/final-edit/adapters/vapi-qwen-tts.ts:132,178`。
- 进度阶段：`components/mixcut/CreationStep.tsx` `STAGES`；`workspace.ts:906,910`（updateJob 不回退守卫）。
- 素材池：`components/mixcut/MaterialStep.tsx`、`MixcutPanel.module.css`（`.materialPool/.materialExcluded/.badgeRemove/.badgeRestore`）。
- 参照实现：`AI-mixcut/AI-remix-master/short-video-mashup-tool/src/renderer/components/{layout,materials,analysis}/`。
- 丢失原型：`app/mixcut-preview/`、`components/mixcut-prototype/`（V1 评审 §3 删除，不可恢复）。
