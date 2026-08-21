# 视频生成批量填充提示词 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在第四步视频生成里加一条批量通道——一键把运镜模板随机铺满全部分镜、在一张列表里通检通改、再一键提交全部视频任务。

---

## Context

同事反馈：一组分镜动辄 20 到 50、60 个片段，每个片段都要单独填运镜提示词，即使有模板也得一个一个选。希望能一键随机填模板，人再扫一眼改改，然后一键全部生成。

看过代码后确认痛点属实，并且**同事那套流程里「再慢慢检查看一眼」这步现在做不到**：

- `components/VideoGenerationPanel.tsx` 是一次只显示一个分镜的。左边是分镜 tab（`:957`），选中哪个才渲染哪个的运镜行，其余分镜的草稿躺在 `perShotMotionCache` 这个 ref 里（`:106`）不上屏。
- 所以哪怕一键填完 50 条，要复核还是得点 50 次 tab。瓶颈只是从「填」挪到了「看」，省不下时间。

因此本方案是三件套：**批量填充 + 批量检查列表 + 全部生成**，缺了中间那件前后两件都不成立。

已有可复用的基础：

- 6 个内置运镜模板已在 `video_prompt_templates` 表，由 `lib/seed.ts:393` 的 `seedMotionTemplates()` 幂等种入；面板启动时已经拉了 `/api/video-prompt-templates`（`:196`）。
- 建任务的批量接口 `POST /api/shot-sets/[id]/video-jobs/batch` 现成，单次一个分镜、最多 10 条运镜（`route.ts:9`），供应商配置校验、尾帧合法性校验、队列自动拉起都在里面。**本方案不新增服务端接口**，前端按分镜循环调它。
- 不覆盖手写提示词的判断逻辑已经存在于单行的 `updateRowTemplate`（`:577`）：提示词为空、或与当前所选模板原文一字不差，才算「自动填的」可以换。批量沿用同一条规则。

**Architecture:** 新建一个无副作用的纯逻辑模块承担全部决策（发牌、能否覆盖、这一轮提交谁），面板只负责把决策结果写进草稿、循环提交、如实报结果。草稿仍以 ref 为唯一真相，额外加一个 revision 计数触发列表重渲染，不动现有尾帧异步生命周期。

**Tech Stack:** Next.js App Router、React 19、TypeScript strict、Node 原生测试（`node scripts/<name>.test.ts`）。

---

## Task 1：批量决策纯逻辑模块

**Files:**
- Create: `components/video-bulk-prompt.ts`
- Create: `scripts/video-bulk-prompt.test.ts`

- [ ] 先写失败测试，覆盖下列全部断言，运行 `node scripts/video-bulk-prompt.test.ts` 确认因模块缺失而失败。
- [ ] 实现模块，再跑一遍预期通过。

导出：

| 导出 | 职责 |
| --- | --- |
| `MAX_ROWS_PER_SHOT = 10` | 镜像服务端 `MAX_ITEMS`，提交前先拦 |
| `buildTemplateSequence(templates, count, random?)` | 洗牌轮转发牌 |
| `isPromptReplaceable(row, templates)` | 这一行能不能被覆盖 |
| `materializeShotDrafts(shotIds, read, makeRow)` | 给没访问过的分镜补一条默认行，产出全量有序草稿 |
| `planBulkPromptFill(shots, templates, options)` | 填充计划 |
| `planBulkVideoGeneration(shots, options)` | 提交计划 |

**发牌规则（洗牌轮转，相邻不重复）：** 把模板池整体 Fisher-Yates 洗一遍发完，再洗下一遍。这样每个模板被用到的次数最多差 1（纯随机做不到），且相邻位置永远拿不到同一个模板——一副牌之内元素互不相同，只有跨牌接缝会撞，撞了就把新牌头张跟后面随机一张对调。`random` 参数默认 `Math.random`，注入是为了测试可复现。

测试须覆盖：

- [ ] 50 个不同种子 × 60 个片段：长度正确、**相邻两位永不同模板**、每个模板都用到、最多次与最少次相差 ≤ 1。
- [ ] 同种子两次调用产出同一序列。
- [ ] `count` 不足一轮时结果互不重复。
- [ ] 边界：`count = 0` 返回空；模板池为空返回空（**不得凭空写入空提示词**）；模板池只有一个时允许重复。
- [ ] `isPromptReplaceable`：空串/纯空白可覆盖；与当前 `templateId` 原文一致可覆盖；在模板基础上手改过**不可**覆盖；没挂 `templateId` 的手写提示词**不可**覆盖。
- [ ] `planBulkPromptFill`：按分镜显示顺序铺开（顺序决定成片顺序，相邻不重复靠的正是这个顺序）、跳过手写行并计入 `keptRows`、写入的 `prompt` 必须是模板原文（之后才能再次被识别为自动填充）、`overwriteEdited: true` 时才动手写内容。
- [ ] `planBulkVideoGeneration` 分流：`ready` / `skippedEmpty`（一条没填）/ `skippedExisting`（已有未失败任务）/ `blocked`（带原因）/ `overflow`（超 10 条），`totalClips` 按行算不按分镜算。`rowIssue` 由面板注入（它要查供应商尾帧能力，那是面板才有的上下文）。默认跳过已有任务的分镜，`includeShotsWithExistingJobs: true` 才纳入。

---

## Task 2：全分镜草稿的可渲染状态

**Files:**
- Modify: `components/VideoGenerationPanel.tsx`

- [ ] 新增 `const [draftRevision, setDraftRevision] = useState(0)`。
- [ ] 新增 `getShotRows(shotId)`：当前分镜读 `motionRowsRef.current`，其余读 `perShotMotionCache.current`。
- [ ] 新增 `setShotRows(shotId, rows)`：当前分镜走 `replaceActiveMotionRows`（`:153`），其余写回缓存 Map，最后 `setDraftRevision((v) => v + 1)`。
- [ ] 新增 `materializeAllDrafts()`：调 Task 1 的 `materializeShotDrafts`，只在事件处理里调用。

**关键约束（务必遵守）：**

- **草稿的唯一真相仍是 ref，不要把 `perShotMotionCache` 提升成 `useState`。** 现有尾帧异步链路依赖 ref 读取：`updateRowsForShot`（`:175`）故意读 ref，好让一个在分镜切换之后才落地的上传写进正确的分镜；卸载清理（`:158`）也要遍历 `motionCache.values()` 释放未提交的尾帧素材。改成 state 会给这条异步路径引入 stale closure 风险。revision 计数是纯增量的，一行都不用动上面这些。
- **`makeEmptyRow()` 内部调 `crypto.randomUUID()`，绝不可在 render 期间调用**，否则每次重渲染都换 key。补行只发生在「打开检查列表」和「一键填充」这两个事件处理里。

---

## Task 3：批量填充与全部生成两个动作

**Files:**
- Modify: `components/VideoGenerationPanel.tsx`

- [ ] `handleBulkFillPrompts()`：`materializeAllDrafts()` → `planBulkPromptFill` → 逐条 `setShotRows` 落盘 → 写状态条，例如「已填 47 条，保留 3 条手写没动」。模板表为空时不动手并提示。
- [ ] `handleGenerateAll()`：
  - `planBulkVideoGeneration`，`rowIssue` 传 `getVideoMotionRowIssue(row, getRowTailCapability(row))`，`shotsWithExistingJobs` 由 `videoJobs` 里状态不属于 `DISCARDABLE_JOB_STATUSES`（`:443`）的任务推出。
  - `ready` 为空直接说明原因返回，不发请求。
  - `window.confirm` 拦一道，文案写清「将为 N 个分镜提交 M 条视频；跳过 X 个已有任务、Y 个未填写、Z 个有问题」。这一步费钱且慢，误点不好收拾。
  - 按分镜顺序**串行** POST 现有 `/api/shot-sets/${effectiveSetId}/video-jobs/batch`，body 与 `handleCreateVideos`（`:782`）完全一致（`prompt` / `templateId` / `providerId` / `durationSec` / `tailImageId` / 条件性 `multiShot`），逐个更新进度「已提交 12/47」。
  - 单个分镜失败**不中断**，记下来继续；全部跑完后一次性汇总。
  - 结束 `refreshJobs()`，把成功数、失败明细写进**常驻状态条**。
- [ ] 全程用 `creatingRef` / `setCreating` 复用现有互斥，防止批量进行中切分镜或重复点击。

**两个必须保留的性质：**

- **默认跳过已有未失败任务的分镜**，所以「全部生成」天然可重入：部分失败后修好再点一次，只会补提交没成功的那些，不会重复扣费。
- **失败与结果不用 `alert`。** 沿用 `5b4666a` 定下的方向（脚本生成已把 alert 死胡同换成可操作面板）：批量结果必须留在屏幕上可读、可对照分镜号，`alert` 一关就没了。

---

## Task 4：批量检查列表

**Files:**
- Modify: `components/VideoGenerationPanel.tsx`

- [ ] 在分镜 tab 上方的 `panel-col-header`（`:954`）加一排批量入口：「一键填充提示词」「批量检查 N 个分镜」。
- [ ] 列表用**覆盖整个工作区的抽屉**，不要塞进左栏——左栏宽度被 `video-ui-layout.test.mjs` 锁在 `minmax(380px, 420px)`，放不下带缩略图的 50 行。
- [ ] 每行渲染：分镜缩略图（`shot.imageUrl`，复用 `HoverZoomImage`）、分镜号、模板下拉（复用 `updateRowTemplate` 的覆盖规则）、提示词 textarea、时长、以及状态徽标：`已有视频` / `未填写` / `手写已锁定` / `带尾帧`。一个分镜有多条运镜就并排列出。
- [ ] 顶部放批量控件：供应商、时长各一个「应用到全部」。否则改 50 条的时长又变成 50 次操作。
- [ ] 抽屉底部复用 Task 3 的两个动作按钮，让「填 → 检 → 生成」在同一个地方走完。
- [ ] 所有编辑走 Task 2 的 `setShotRows`。

**边界：**

- **检查列表里不做尾帧上传/移除。** 尾帧有一整套异步上传、失败回滚、409 保护的生命周期（`:620` 起），铺到 50 行里得不偿失。列表只显示「带尾帧」徽标和 `getVideoMotionRowIssue` 给出的问题原因，改尾帧回单分镜视图。
- 自由素材工位（`isFreeSet`）同样可用，但**等待传图的空槽位不是真 shot，必须排除**，只收 `safeShots` 里的分镜。

---

## Task 5：样式

**Files:**
- Modify: `app/globals.css`

- [ ] 在 `.video-motion-card` 一族附近（`:469` 前后）追加 `.video-bulk-*` 类：抽屉遮罩、列表行网格、状态徽标、进度/结果状态条。
- [ ] 纯追加，不得改动 `video-ui-layout.test.mjs` 断言过的 `.video-workspace` 栅格、`.video-preview-col` 背景、`.video-prompt-field` 最小高度等既有规则。

---

## Task 6：契约测试与回归

**Files:**
- Create: `scripts/video-bulk-prompt-ui-contract.test.mjs`

- [ ] 参照 `scripts/video-multi-shot-ui-contract.test.mjs` 的写法（读源码做正则断言），覆盖：
  - 面板从 `video-bulk-prompt` 导入决策函数，**面板内不得出现自己挑模板的 `Math.random`**。
  - 批量提交前有 `window.confirm` 关口。
  - 批量结果写进状态条，不是 `alert`。
  - 检查列表不调用 `handleTailFrameUpload` / `handleTailFrameRemove`。
  - `perShotMotionCache` 仍是 `useRef`（守住 Task 2 的关键约束，防止后来者顺手改成 state）。
- [ ] 回归跑通：`node scripts/video-bulk-prompt.test.ts`、`node scripts/video-bulk-prompt-ui-contract.test.mjs`、`node scripts/video-ui-layout.test.mjs`、`node scripts/video-tail-frame-ui-state.test.ts`、`node scripts/video-tail-frame-ui-contract.test.mjs`、`node scripts/video-multi-shot-ui-contract.test.mjs`、`node scripts/free-material-video-slot-ui-contract.test.mjs`。
- [ ] `npm run lint` 与 `npm run build` 均通过。

---

## Verification

自动化之外，`npm run dev` 手动走一遍：

1. 开一个有 20 张以上分镜的项目，进第四步视频生成，选中分镜组。
2. 点「一键填充提示词」→ 打开检查列表：每个分镜都有提示词，**上下滚动确认相邻分镜的运镜模板不重样**，6 个模板分布大致均匀。
3. 手改其中一条提示词 → 再点一次「一键填充」→ **手改的那条必须原样保留**，状态条报出保留条数。
4. 用「应用到全部」把时长改成 8 秒，确认所有行同步。
5. 关掉抽屉，切到任意单个分镜 → 该分镜的提示词、模板、时长与列表里一致（两边同一份草稿）。
6. 点「全部生成」→ 确认弹窗数字与列表条数对得上 → 观察进度递增 → 结束后右侧结果区出现对应数量的任务，状态条留在屏幕上。
7. **重入验证**：再点一次「全部生成」，应报告「全部分镜都已有任务」并且**不提交任何新任务**。
8. 断网或临时改错供应商配置制造失败，确认失败分镜被逐条列出、成功的部分照常入队。
9. 自由素材工位重复步骤 2 与 6，确认等待传图的空槽位没被算进批量。

---

## Out of Scope

- 不新增服务端接口，沿用现有按分镜的 `video-jobs/batch`。
- 不做费用预估——视频供应商目前没有 cost 计算实现，确认弹窗只报条数。
- 不做模板池勾选（本轮选定纯洗牌轮转，模板池就是全部内置模板）。
- 检查列表不做尾帧编辑。
- 不动 `perShotMotionCache` 的 ref 语义和尾帧异步生命周期。
