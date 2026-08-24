# 批量成片自由编辑（变长修剪 / 删除 / 插入拼接 / 分割）执行文档

> 本文是交给执行者（DeepSeek）的**零上下文自包含**实施文档：目标、现状、已核实契约、改动清单、
> 测试、红线、验证命令、停止点全部在文内。执行前先通读全文，再动手。
> 撰写日期 2026-08-24；仓库 `I:\m7-studio`（Next.js 16 App Router + React 19 + better-sqlite3 +
> TypeScript strict；UI 文案中文）。

## 1. 任务目标

批量生产「检查成片」已有简化版片段编辑（等长截取 / 等长替换 / 实时预览 / 素材使用标记）。
本次把它升级为**自由编辑**，对齐单条精剪的核心能力：

- **变长修剪**：拖动片段选窗两侧手柄，改入点也改出点（片段长度可变）；
- **删除片段**：删掉某一段，后续片段依次提前（ripple）；
- **插入拼接**：从冻结素材池挑素材插入到任意位置（片头/某片段之后/末尾），后续片段依次后延；
- **分割**：把一个片段在指定位置切成源连续的两段（总长不变，画面不变）；
- 编辑后仍走「就地改 arrangement + 重渲染同版本」的既有管线，实时预览即改即看。

## 2. 现状（上一迭代已交付，先读再改）

上一迭代文档：`docs/2026-08-24-batch-review-clip-edit-and-reveal-fix-plan.md`（含字段契约与偏差记录）。
模块常驻参考：`docs/reference/批量生产模块.md`。本次涉及的既有代码：

- `lib/batch-production/output-arrangement.ts`（新建于上一迭代）：
  - `getBatchOutputArrangementView(db, projectId, batchId, planId)` → `BatchOutputClipEditView`
    `{ planId, batchVersionId, outputVersionId|null, versionNumber|null, editable, editRevision,
       clips[{clipId, segmentId, assetId, contentFingerprint, sourceStartUs, sourceEndUs,
       timelineStartUs, timelineEndUs, locked}], narration{audioRelativePath|null, durationUs|null},
       subtitleCues[{startUs,endUs,text}], coverAssetId|null,
       music{trackId|null,gainDb,fadeInSec,fadeOutSec},
       poolAssets[{assetId,displayName,durationSec,contentFingerprint,thumbnailUrl,previewUrl,excluded,usedByPlanIds}] }`；
  - `applyBatchOutputClipEdit(db, projectId, batchId, planId, edit)`，`edit` 目前只有
    `{type:'trim',clipId,sourceStartUs,sourceEndUs}`（等长）与 `{type:'replace',clipId,assetId}` 两种；
    单事务整读-改-整写 `arrangementJson`，生效编辑 `editRevision+1` 并删除 `$.review`；
    含 `FRAME_TOLERANCE_US = 41667`（24fps 一帧）容差规整。
- `lib/batch-production/phase-e.ts`：`renderRequestKey` 已含 `:edit:{editRevision}`；
  `scheduleRenderAfterClipEdit(db, projectId, batchId, planId, now?)` 可复用。
- 路由：
  `app/api/batch-production/batches/[id]/outputs/[planId]/arrangement/route.ts`（GET 视图）；
  `app/api/batch-production/batches/[id]/outputs/[planId]/clips/route.ts`（POST 编辑，成功后
  `scheduleRenderAfterClipEdit` + `ensureBatchSchedulerStarted()`）。
- 前端：`components/batch-production/BatchOutputEditor.tsx`（编辑面板：实时预览 + 片段条 + 素材池列），
  `components/batch-production/BatchTimelinePreview.tsx`（实时预览，按 clips 区间播任意长度），
  `components/batch-production/BatchStepReview.tsx`（预览弹窗内嵌编辑器，「调整片段」入口）。
- 测试：`scripts/batch-output-clip-edit.test.ts`（12 组断言，`:memory:` 库 + 手动应用
  `BATCH_SCHEMA_MIGRATIONS` 的引导方式，新用例照抄同款夹具）。

## 3. 已核实的渲染契约（本次设计的地基，已读源码）

以 `lib/batch-production/batch-renderer.ts` 为准（行号是 2026-08-24 的快照，可能有小幅漂移，按锚点找）：

1. **正文时长恒等于口播时长**（有口播时）：`:683`
   `const targetDurationUs = narrationInput?.durationUs ?? visualDurationUs;`。
2. **画面与口播不等长时渲染兜底已存在**：`:765-766` 画面短 → `tpad=stop_mode=clone` 冻结末帧补齐到正文
   时长；画面长 → `trim=duration=` 截断。**但 `:675`**
   `const visualDurationUs = Math.max(snapshot.clips.at(-1)!.timelineEndUs, arrangementTargetDurationUs);`
   把「画面短」的情况吃掉了（分配器产出的画面本来就对齐口播，旧代码无所谓；手动自由编辑后必须修，见 §5.2）。
3. 偏差探针：`:757-764` 画面/口播差 >0.15s 只写 warning 日志，**不阻塞渲染**。
4. **连续性硬约束**：`:325-328` clips 必须从 0 开始、首尾相接，无缺口无重叠——所有编辑操作由**服务端**
   维持该不变量（ripple 平移后续片段，见 §4）。
5. `:294` clips 不能为空——禁止删到最后一条。
6. **封面**：`:717` `cover.timeUs` 必须落在第一片段源区间内，否则渲染失败——改动第一片段后要钳位（§5.1）。
7. 口播是一条整 wav（`narration.audioRelativePath` + 指纹 + 实测时长校验 `:685-690`），字幕 cues 是
   正文绝对时间（`:773-779` 整体后移一个片头叠加）。**编辑不平移、不重算口播与字幕**——按段平移整 wav
   不可行，这是硬约束不是偷懒。
8. 产物时长校验 `:831-845`：probe 时长 ≈ 片头+正文（±0.12s），与画面内容无关，自由编辑不会顶爆。

## 4. 语义决策（ripple / 涟漪式）

- 变长修剪、删除、插入都**平移后续片段**（服务端重排：保持原顺序，从 0 起依次首尾相接，
  每个 clip 的 `timelineEndUs = timelineStartUs + (sourceEndUs - sourceStartUs)`）。
- 口播与字幕保持绝对时间不动。因此删除/缩短片段后，**后面的画面会比口播早出现**（错位）；
  加长/插入则画面比口播晚、超出部分渲染时裁掉；总长不够时结尾定格补齐。这些后果必须让用户
  看得见（§5.1 返回值 warnings + §6 前端摘要行）。
- 不搬单条的「删除留缺口」语义（批量渲染契约不允许缺口；用户要的是"拼接"）。
- **分割是纯结构操作**：两段源区间连续、时间线连续、总长不变 → 画面输出不变。因此 split
  **不递增 editRevision、不清 review、不触发重渲染**（§5.1 的 `visualChanged` 标志）。

## 5. 后端改动

### 5.1 `lib/batch-production/output-arrangement.ts` 扩展编辑类型

`BatchOutputClipEdit` 扩为（保留现有 `trim`/`replace` 语义不变）：

```ts
| { type: 'trim'; clipId: string; sourceStartUs: number; sourceEndUs: number }          // 等长，已有
| { type: 'replace'; clipId: string; assetId: string }                                   // 等长换素材，已有
| { type: 'trim_variable'; clipId: string; sourceStartUs: number; sourceEndUs: number }  // 变长
| { type: 'delete'; clipId: string }
| { type: 'insert'; afterClipId: string | null; assetId: string; durationUs?: number }   // null=插到最前
| { type: 'split'; clipId: string; offsetUs: number }                                    // 相对片段起点的偏移
```

统一规则：

- **最短片段长度 0.5s**（12 帧@24fps = `500_000` µs，与单条 12 帧最短惯例一致）；所有 µs 入参必须是
  安全整数，服务端按 24fps 帧边界规整（`Math.round(us * 24 / 1e6)` 再换回 µs）。
- `trim_variable`：新区间在素材时长内（时长来源沿用现有 `poolAssetDurationUs` 口径）、长度 ≥ 最短；
  允许与原长度不同；ripple。
- `delete`： clips 只剩一条时拒绝（渲染契约 §3.5）；ripple。
- `insert`：素材校验同 replace（冻结池成员、未排除、指纹取池记录写入 clip）；窗口
  `[0, min(素材时长, durationUs ?? 3_000_000)]`，素材不足最短长度拒绝；新 clipId 用
  `manual:<crypto.randomUUID()>`，`segmentId: ''`，`locked: false`；位置：`afterClipId=null` 插最前，
  否则插到该片段之后（afterClipId 必须存在）；ripple。
- `split`：`offsetUs` 相对片段起点，规整后两侧都要 ≥ 最短；前段保留原 clipId（含 locked/segmentId），
  后段新 clipId `manual:<uuid>`，源区间连续（前段 `sourceEndUs` = 后段 `sourceStartUs`）、时间线连续；
  **总长不变、后续片段不动**。
- 公共收尾（仅 `visualChanged` 的操作）：重排连续性；`editRevision+1`；删 `$.review`；
  **封面钳位**：若第一片段源区间变化导致 `arrangement.cover.timeUs` 越界（不在
  `[第一片段 sourceStartUs, sourceEndUs)` 内），重置为新第一片段的 `sourceStartUs`。
- 返回 `BatchOutputClipEditResult` 扩为 `{ outputVersionId, editRevision, changed, visualChanged, warnings: string[] }`：
  - `trim`/`replace`/`trim_variable`/`delete`/`insert` 生效时 `visualChanged=true`；幂等短路时
    `changed=false, visualChanged=false`；
  - `split` 成功时 `changed=true, visualChanged=false`（写库但不重渲染、不清 review、不递增 editRevision）；
  - `warnings` 中文可直读，按需带上：`画面总长比口播长 X.X 秒，超出部分渲染时会被裁掉` /
    `画面总长比口播短 X.X 秒，结尾将定格最后一帧补齐` / `删除的片段对应口播句子仍按原时间播放，注意声画对位` /
    `封面抽帧点已重置到新片段开头`（发生了钳位时）。口播时长读 `arrangement.narration.durationUs`，
    无口播时不发时长类 warning。
- `getBatchOutputArrangementView` 的视图补一个 `visualDurationUs`（末片段 `timelineEndUs`，无片段时 0），
  供前端常驻显示「画面 vs 口播」。

### 5.2 `lib/batch-production/batch-renderer.ts` 一处修正

`:675` 附近：把 `visualDurationUs` 改为**真实画面结尾** `snapshot.clips.at(-1)!.timelineEndUs`
（不再与 `arrangementTargetDurationUs` 取 max），`:765` 的 tpad/trim 分支按真实值判断：
手动自由编辑后画面短于口播是合法状态，必须走到 `tpad=clone` 补齐，而不是把一条 8s 的视频轨
直接 mux 进 10.8s 的容器。改完检查 `arrangementTargetDurationUs` 是否还有其他使用点，没有就删掉
该变量（lint 会报未使用）。`:757-764` 的 0.15s 探针 warning 保持原样（现在它会真正发挥作用）。
无口播（静音候选）路径 `targetDurationUs = visualDurationUs`，改后两边相等、trim 为 no-op，行为不变。

### 5.3 路由

- `app/api/batch-production/batches/[id]/outputs/[planId]/clips/route.ts`：body 校验扩展新 type
  （trim_variable 同 trim 两个安全整数；delete 只要 clipId；insert 要 assetId 字符串 +
  afterClipId 字符串或 null + 可选 durationUs 正整数；split 要 offsetUs 非负安全整数）。
  **只有 `visualChanged=true` 才** `scheduleRenderAfterClipEdit` + `ensureBatchSchedulerStarted()`；
  响应体透传 `{ outputVersionId, editRevision, changed, visualChanged, warnings, renderTaskId }`。
- `arrangement/route.ts` 不用改（视图函数里补字段即可）。

### 5.4 测试（`scripts/batch-output-clip-edit.test.ts` 追加用例，沿用现有夹具风格）

至少覆盖：

1. trim_variable 改长后 ripple：后续片段 timeline 依次后延、从 0 连续；
2. trim_variable 缩短 + 越素材时长 / 短于 0.5s 拒绝；
3. delete 后 ripple 提前；只剩一条时拒绝；
4. insert 到最前 / 中间 / 末尾三种位置的顺序与连续性；非池素材 / 已排除 / 素材短于最短长度拒绝；
   默认窗口 3s 与 `durationUs` 显式值；
5. split：两段源连续、时间线连续、总长不变、后续不动；offset 贴边（任一侧 <0.5s）拒绝；
   **split 后 `$.review` 保留、editRevision 不变、不产生新渲染任务**（用现有 requestKey 用例的查法断言）；
6. 第一片段窗口变化后 `cover.timeUs` 越界 → 被钳到新区间起点（含 response warnings 断言）；
7. 时长 warnings：画面长/短于口播时的中文提示文案；
8. 既有 12 组断言保持全绿（trim/replace 语义不许回退）。

## 6. 前端改动

### 6.1 `components/batch-production/BatchOutputEditor.tsx`

- 摘要行扩为：`本片使用 X/Y 条素材 · 本批次还有 Z 条素材从未被任何成片使用 · 画面 A.As / 口播 B.Bs`
  （口播时长 = 视图 `narration.durationUs`，画面 = 视图 `visualDurationUs`；无口播时只显示画面时长）。
  两者不等时紧随其后一句后果提示（长裁短补，同 §5.1 warnings 口径，前端可自算常驻显示）。
- 片段卡操作扩为三个入口：**截取**（等长，现有 TrimEditor 流程不动）、**修剪**（打开 §6.2 的变长
  修剪面板）、**删除**（confirm 文案说明 ripple 与口播错位后果；`clips.length===1` 时禁用并注明
  「至少保留一条片段」）。
- 素材点击后的确认块扩为三个操作：**替换当前片段**（需已选片段）/ **插入到选中片段之后**（需已选片段）/
  **追加到末尾**。insert 不带 durationUs（用服务端默认 3s），提示「插入后可再用修剪调整长度」。
- 编辑响应的 `warnings[]` 渲染在面板反馈区（warn 色），与现有 editFeedback 并存。
- 提交中 / renderBusy / !editable 的锁定逻辑照旧覆盖所有新按钮。

### 6.2 新建 `components/batch-production/BatchClipTrimEditor.tsx`

批量专用变长修剪面板。**不要改** `components/mixcut/TrimEditor.tsx`（单条在用），从它复制骨架
（`mixcut-content.module.css` 的 trim 样式类可以照用，import 路径相对调整）：

- 源素材胶片条（缩略图平铺，同 TrimEditor 做法）+ 可拖**双手柄**选窗：左柄改入点、右柄改出点、
  拖选窗中间等长整体平移；实时显示选窗时长（秒，一位小数）与起点；最短 0.5s、两端不越素材总长。
- 选窗内叠加一个**分割标记**（细竖线手柄，只能在当前片段窗口内拖动，默认中点）；
  「在标记处分割」按钮提交 split（`offsetUs = 标记位置µs - clip.sourceStartUs`）。
- 「完成」提交 trim_variable（µs 换算 24fps 帧对齐）；「取消」关闭。分割与修剪是两个独立按钮，
  互不捆绑（用户可以先修剪再分割，或只分割）。
- 提交走 BatchOutputEditor 统一的 `submitEdit`，成功后走既有「静默重拉视图 → 预览即改即看」链路。

### 6.3 不需要动

- `BatchTimelinePreview.tsx`（本来就按 clips 的 timeline 区间播任意长度；连续性由服务端保证）。
- `BatchStepReview.tsx`（「调整片段」入口与弹窗结构上一迭代已就位）。
- 口播音频端点 `media?kind=narration`、BGM `/api/final-edit-bgm/[trackId]/file`、素材代理预览
  `preview/[assetId]` 均沿用。

## 7. 红线与 scope cut

- `lib/batch-production/` **只许从 `media-core/` 或本目录导入，绝不从 `final-edit/` 导入**
  （UI 层组件复用 final-edit 的纯函数/组件不受此限，上一迭代已有先例）。
- **不需要新数据库迁移**（全部改 arrangementJson 内部结构）；`lib/batch-production/schema.ts`
  与 `lib/db-migrations.ts` 的已发布条目一个字都不许动。
- 不动单条侧任何文件：`components/mixcut/`、`components/final-edit/`、`lib/final-edit/`。
- **不做**：字幕拖动/改字、字幕样式面板（批量字幕样式冻结在批次版本，属另一功能）、口播重算/重对齐、
  素材上传、gap（黑场）语义。
- 不做 git 操作（add/commit/push 一律禁止）。
- 工作树里 `app/globals.css`、`components/VideoGenerationPanel.tsx`、
  `scripts/video-bulk-prompt-ui-contract.test.mjs` 是另一任务的既有改动，不要碰也不要「顺手清理」。

## 8. 验证清单（全部真跑，不许凭印象声明通过）

```bash
node scripts/batch-output-clip-edit.test.ts        # 新旧用例全绿
node scripts/batch-phase-e-ui-contract.test.mjs    # 若断言源码与新 UI 冲突，按测试本意同步（不许删保护性断言）
node scripts/batch-preparation-workspace.test.mjs
node scripts/batch-phase-e-orchestration.test.ts
node scripts/batch-phase-e-schema.test.ts
node scripts/batch-phase-e-narration-gate.test.ts
node scripts/batch-workspace.test.ts
node scripts/batch-renderer.test.ts
npx tsc --noEmit
npm run lint                                       # 0 error；你触动的文件零 warning（存量基线：37 条 warning 在未触碰文件）
```

**预存失败基线**：`scripts/batch-render-smoke.test.ts` 在本机失败（ffmpeg 环境差异，渲染时长
10.83s vs 断言 10s，2026-08-24 已确认与本次改动无关）。执行前先跑一遍拿到基线；执行后它仍败是
预期，不许把预存失败当成自己改坏的，也不许顺手修它。若它在执行前就是绿的而执行后败了，那才是你的问题。

## 9. 执行纪律与停止点

1. 动手前先跑 §8 的测试拿基线，再读 `docs/reference/批量生产模块.md`、上一迭代文档与
   `lib/batch-production/output-arrangement.ts` 现状代码。
2. 改动最小化：不顺手重构、不改无关格式、不引入新依赖。
3. 完成后：`docs/reference/批量生产模块.md` 的 Phase E 段那条片段编辑 bullet 末尾补一句
   「支持变长修剪/删除/插入/分割（ripple 平移，口播字幕不动，画面短了 tpad 补齐长了裁掉）」。
4. 停下并汇报的情形：发现本文与代码现状冲突（比如行号锚点找不到、契约已变）、需要动 schema/迁移、
   需要改单条侧文件才能达成、或测试出现你无法归因的失败。
5. 汇报格式：改动/新增文件清单（带要点）、新旧 API 字段契约、实际运行的验证命令与结果（贴关键输出）、
   偏离本文档的点及原因。
