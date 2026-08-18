# 自由素材视频入口 + 分镜组张数上限放宽 — 执行方案

- 日期：2026-08-17
- 版本：**v5（最终 UI 样机确认：逐像复用现有视频生成工作区，只增加首帧入口）**
- 状态：**设计已确认，可执行**（2026-08-18 用户对复刻样机明确回复“yes！就是这样！”；UI 复用边界已升级为验收硬约束，无遗留待确认项）
- **目标基线：`main` @ `6476739`**（已 merge `batch-m7-ui-defects`，领先它 17 个提交；`batch-m7-ui-defects` 领先 main 0 个提交，**不要从它切分支**）
- 工作分支：`feat/free-material-video-entry`
- 执行方式：**C1 → C16 严格串行**，一卡一提交，每卡跑该卡验收命令后再提交。

---

## 修订记录

### v5（本版）—— 现有 UI 逐像复刻，禁止再做界面方案

2026-08-18，用户否决了 A/B/C、多步骤引导、胶片带等重新设计，并提供现有第 4 步截图作为唯一视觉基准。随后确认了直接复刻现有 UI 的样机，原话：**「yes！就是这样！」**。

本版把这次确认落实为执行硬约束：

1. **“复用现有 UI”不是产品概念复用，而是现有 DOM 结构、class、三栏顺序、控件位置和交互状态直接复用。**
2. 生产实现必须以 `components/VideoGenerationPanel.tsx` 和 `app/globals.css` 的现有视频工作区为主体；已确认样机 `/free-material-video-prototype` 只作为视觉与交互验收参考，**不得把样机另做成第二套生产组件**。
3. 左栏仍是 tab + 运镜卡；中栏仍是大预览 + 原播放器控制条；右栏仍是纵向结果卡。允许出现的新东西只有：自由工位下的 `图 N`、`添加图片`、空首帧上传入口，以及 D21 必需的删除动作。
4. 自由工位为空时也必须保留原运镜卡骨架：首帧格显示上传入口，尾帧格提示先添加首帧，其余参数保持原位置；中栏、右栏只切到既有空态。**禁止退化成独立上传页、居中大空态或弹窗。**
5. 上传成功后，首帧恢复为现有只读 `video-frame-source`。D20 不变：**换图 = 添加一张新图**，不提供原地替换按钮。

已确认参考文件：

- 交互样机：`app/free-material-video-prototype/FreeMaterialVideoPrototype.tsx`
- 样机的最小补充样式：`app/free-material-video-prototype/prototype.css`
- 同视口视觉核对：`app/free-material-video-prototype/design-qa.md`

> **执行优先级**：若后文代码片段与本节的视觉合同冲突，以本节、§2.11 和已确认样机为准；执行者应先修文档冲突，不得自行发挥。

### v4 —— 原型确认后的范围收缩

用户看过交互原型后确认了三件事，并给出关键判断：**「确实不是新东西，你直接做成平时那样子就好了，只是原来是有图片放好在首帧，现在留出位置给用户自己添加就好。预览那些都一样。」**

这句话让方案从「新建一套自由素材 UI」塌缩成「**现有视频生成工作区 + 首帧可上传**」：

| v3 的做法 | v4 的做法 | 依据 |
|---|---|---|
| 新写 `FreeMaterialDialog` 弹窗（批量勾选建组） | **整卡删除**，不需要弹窗 | 用户要的是「和平时一样」 |
| 改造 `AssetUploadGrid` 支持 `video_source` | **删除**，只留 `maxFiles` 常量改动 | 不再用这个组件 |
| 新写自由工位的槽位/运镜 UI | **删除**，复用 `VideoGenerationPanel` 现有工作区 | 尾帧+多运镜确认后，自由槽位 ≡ 现有分镜 |
| 首帧固定为分镜图 | **空工位的首帧格改成上传入口**，照抄尾帧那套 `<label>` + 隐藏 file input + 拖拽；上传成功后的首帧仍只读 | `VideoGenerationPanel.tsx:816-844` 已有现成实现；D20 禁止原地替换 |
| — | **新增**：往已有工位追加一张图的接口 | 原方案只能一次性建好，加不了图 |

### 用户拍板的五件事（原型确认）

| # | 议题 | 结论 |
|---|---|---|
| D15 | 一个项目能有几个自由工位 | **只有一个**，单例；里面的图片数量**无上限** |
| D16 | 每个槽位要不要尾帧位 | **都留**，用不用由用户决定 |
| D17 | 同一张图能不能挂多条提示词 | **能**，和分镜组一样多条运镜 |
| D20 | 传错图了怎么改 | **再加一张**，不做原地替换。`shots.sourceImageId` 保持不可变 |
| D21 | 能不能删掉某一张图 | **能，但仅限"还没生成之前"**。判定见 §2.12：只有 `failed` / `canceled` 的任务不算数，其余一律锁死 |

**D16 + D17 的直接后果**：自由槽位在结构上和现有分镜**完全一致**，`components/video-tail-frame-state.ts` 的 `VideoMotionRow` 整套原样复用，`POST /api/shot-sets/[id]/video-jobs/batch` 一行不用改。

### v3 —— 第二轮评审（3 项 P1 + 4 项 P2，全部核实成立，已处理）

| 评审项 | 核验 | 处理 |
|---|---|---|
| A3 让新建空项目返回 400 | ✅ 已复现。`app/projects/new/page.tsx` 全文不含 `shotImageIds` | nullish 分支放进领域函数内部（C2）+ C3 三条回归断言 |
| B1 验收会验错库 | ✅ `CREATIVE_STUDIO_DATA_ROOT`（v3 前拼错）、库在 `<dataRoot>/data/workbench.db`、WAL 热复制会漏 | C1 改用 `.backup()` + 正确临时根目录 |
| 未终态视频任务的删除语义缺失 | ✅ 队列按 `projectId` 领取，删组后继续提交继续计费 | **D14**：非终态任务存在时 DELETE 返回 409 |
| 图片删除吞掉 409 | ✅ `app/api/images/[id]/route.ts:53` | v4 里该弹窗已删除，改为 C8 修 `ShotSetPanel.handleDelete` |
| 删除缺 `deleting` 状态 | ✅ | C15 加 `deletingSet` 锁 + `selectedSetIdRef` 比对 |
| 批量素材行为不确定 | ✅ `verifyAssetSources` 只重验磁盘文件，不重验 shotSetId | **D13** 明确「已登记的保留」 |
| 自动测试缺口 | ✅ | 抽 `lib/shot-set-service.ts` + 内存 SQLite 测试 |

### v2 —— 第一轮评审（3 项 P1 + 5 项 P2 + 4 处误差，全部核实成立，已处理）

删除入口缺失、迁移测试尾条断言必然失败、漏掉 `app/api/projects/route.ts` 建组路径、kind 无领域约束、`apply-scene` 无门禁、A/B 不独立、基线未固定、`ImageUploader` 是整批拒绝而非静默截断、`ADD COLUMN ... CHECK` 实测可用、两处计数错误。

---

## 0. 一句话目标

1. **自由素材工位**：第 4 步「选择分镜组」下拉里多一条「自由素材工位」（一个项目一个，单例）。选中后就是**平时那套视频生成工作区**，唯一差别是首帧那格空着、由用户自己传图，可以一直往里加图。尾帧、多条运镜、供应商、时长、结果预览全部照旧。
2. **分镜组张数上限**：普通分镜组从写死的 9 张放宽到 20 张，上限与校验抽成共享领域函数；自由工位不受这个上限约束。

---

## 1. 决策记录

### 1.1 用户已拍板

| # | 议题 | 结论 |
|---|---|---|
| D1 | 自由上传的视频要不要能进第 5 步混剪 | **要**。走「虚拟分镜组」，不走 `shotSetId = null` 的孤儿任务方案 |
| D2 | 普通分镜组张数上限 | **20 张** |
| D3 | 开放入口位置 | **第 4 步「选择分镜组」下拉里面**（不是旁边加按钮） |
| D11 | 删除自由工位的语义 | **硬删 + 补入口 + 明告后果**。既有的「删组→已完成视频变孤儿」问题排除在本次范围外（§7） |
| D15 | 自由工位数量 | **一个项目一个**，单例 get-or-create；里面图片**无上限** |
| D16 | 尾帧 | 每个槽位都留，用不用随意 |
| D17 | 一图多运镜 | 支持，和分镜组一样 |

### 1.2 执行者不得擅自更改的衍生决策

| # | 决策 | 理由 |
|---|---|---|
| D4 | 用 `shot_sets.kind` 标记，**不新建表** | 下游（混剪、批量生产、导出）全部按 `shotSetId` 组织，复用让下游零改动 |
| D5 | 自由工位 `status` 落 `'approved'` | 枚举见 `lib/db.ts:181`。自由工位没有生成过程，`approved` 最贴近「可直接使用」。**不要动这个 CHECK** |
| D6 | 自由素材图片用 `usage = 'video_source'` | 避免污染第 2 步选图宫格（按 `usage === 'shot_source'` 过滤，`page.tsx:189`）。与尾帧的 `video_tail_frame`（`lib/video-tail-frame.ts:5`）对称 |
| D7 | 第 2 步隐藏 `kind='free'` | 第 2 步是「用场景参考图批量生成分镜图」的工位。**代价：删除入口必须放在第 4 步（C15）** |
| D8 | 第 3 步**不隐藏**自由工位 | 脚本生成只依赖 `shots + image_assets`，自由工位满足。**注意**：自由工位无张数上限，图多时第 3 步画质会降级 —— 由 C14 的软提示兜住，不拦截。要翻只需 `ScriptPanel.tsx:427` 一行 filter |
| D12 | `kind` 加 CHECK 约束 | 已实测支持且强制生效，仓内有先例（§2.8）。非法值在 API 层返回 400，**不许静默降级** |
| D13 | 删组后**已登记**的批量素材「保留」 | `verifyAssetSources`（`media-catalog.ts:488-515`）只重验磁盘文件，从不重验 shotSetId。已登记的 `batch_assets` 与出身工位解耦。**不做连带清理** |
| D14 | 存在非终态视频任务时 DELETE 返回 **409** | 队列按 `projectId` 领任务（`video-queue.ts:518-522`），不看 shotSet。进行中的任务会继续提交、继续计费，产出再也回不到界面 |
| **D18** | **自由工位不受 `MAX_SHOTS_PER_SET` 约束** | D15 明确「无上限」。领域函数用 `max` 选项区分两条路径 |
| **D19** | **首帧上传照抄尾帧的既有实现** | `VideoGenerationPanel.tsx:816-844` 的 `<label>` + `sr-only` file input + 拖拽，以及 `:416-468` 的 `handleTailFrameUpload`（含失败自动清理已上传资源）。**不要另起炉灶** |
| **D22** | **现有第 4 步 UI 是不可改写的视觉合同** | 用户已逐屏确认复刻样机。必须保留左参数 / 中预览 / 右结果三栏及现有 class；新 UI 仅限 `图 N`、`添加图片`、空首帧上传和 D21 删除动作。禁止 A/B/C、引导流、胶片带、弹窗或独立上传页 |

> **⚠️ 行为变更告知（D14）**
> 这是本次唯一改变**既有**功能的地方：今天删一个还有任务在跑的普通分镜组会成功，之后会返回 409。
> 判断依据：防的是真实金钱损失，且「自由工位受保护、普通组不受保护」逻辑上讲不通。
> 终态白名单是 `succeeded / failed / canceled`，其余（`pending / running / needs_check / paused` 及将来任何新状态）一律算进行中 —— 白名单式判定让新状态默认落在安全的一边。
> **不接受这处扩张的话，改成只对 `kind='free'` 生效是 C4 里的一行条件。**

---

## 2. 现状核查（每条都已对过代码）

### 2.1 「9」的全部硬编码位置（7 处）

| 文件:行 | 内容 |
|---|---|
| `app/api/projects/[id]/shot-sets/route.ts:47` | `if (shotImageIds.length > 9)` |
| `app/api/projects/route.ts:137` | 建 `shot_sets` 时**完全没有校验**（第二条建组路径） |
| `components/ShotSetPanel.tsx:192` | `prev.length < 9` |
| `components/ShotSetPanel.tsx:513` | `maxFiles={9}` |
| `components/AssetUploadGrid.tsx:103` | `maxFiles={usage === 'scene_seed' ? 1 : 9}` |
| `app/projects/[id]/page.tsx:1114` | `maxSelection={9}` |
| 文案 ×5 | `ShotSetPanel.tsx:530/548/561`、`page.tsx:1097/1189` |

**`maxFiles` 的真实行为** —— `components/ImageUploader.tsx:71-74` 是 `alert` + **整批拒绝**，不是截断。两处调用都传 `files={[]}`，所以条件等价于 `imageFiles.length > maxFiles`。

### 2.2 两条建组路径

| 路径 | 去重 | 张数校验 | 项目归属校验 |
|---|---|---|---|
| `POST /api/projects/[id]/shot-sets` | ✅ | ✅ `> 9` | ✅ `:51-56` |
| `POST /api/projects`（`:137`） | ❌ | ❌ | 走 `bindProjectImage`（`:18-27`） |

**且 `app/projects/new/page.tsx` 根本不发送 `shotImageIds`**（全文 grep 零命中），所以任何要求它必须是数组的校验都会打爆最基础的建项目流程。C2 的领域函数必须在**函数内部**处理 nullish。

### 2.3 第 3 步视觉预算（软天花板）

`lib/script-vision-image.ts:4-7` 定义 4MB 总预算 + 384KB 单图上限；单图实际预算在 `lib/script-generation-v3-service.ts:69-70` 是 `min(384KB, 4MB / N)`：

| N | 单图预算 |
|---|---|
| ≤ 10 | 384KB（满配，`4MB / 384KB ≈ 10.67`） |
| 11 | 372KB（**开始降质**） |
| 20 | 200KB（仍可用） |
| 40 | 100KB（明显影响判断） |

### 2.4 现有视频生成工作区的结构（v5 的复用基础）

`components/VideoGenerationPanel.tsx`：

| 位置 | 内容 | v5 是否改动 |
|---|---|---|
| `:695-707` | `shot-tab-row` —— 每个分镜一个 tab，文案写死「分镜 {indexNum}」 | **改**：自由工位改文案，并加一个「＋」tab |
| `:728-729` | `video-motion-card` + 「描述 N」 | 不改 |
| `:731-748` | `video-frame-source` —— **首帧，只读**，取 `selectedShotData.imageUrl` | **不改**：上传成功后仍走这段；D20 禁止原地替换 |
| `selectedShot` 分支之前 | 原来没有「空分镜组也显示参数卡」的分支 | **加**：仅自由工位为空时复刻一张禁用的 `video-motion-card` 骨架，首帧格可上传 |
| `:750-752` | `video-frame-bridge` 箭头 | 不改 |
| `:754-849` | 尾帧：已有图 / 可上传 `<label>` / 不支持三态 | 不改 |
| `:816-844` | **尾帧上传格子**：`<label>` + `sr-only` file input + 拖拽覆盖层 | **照抄给首帧** |
| `:416-468` | `handleTailFrameUpload`：上传 → 挂载 → 失败清理已上传资源 | **照抄给首帧** |
| 右侧列 | 结果列表 + 预览播放 | 不改 |

**结论**：自由工位有图后的运镜、尾帧、供应商、时长、结果、预览全部零改动。只增加 shot tab 的图片入口，以及空工位时对同一套运镜卡骨架的只读复刻；已有 `video-frame-source` 不改。

### 2.5 `video_jobs` 与队列

`lib/db.ts:266-298`：`shotSetId` / `shotId` 可空（`ON DELETE SET NULL`），`sourceImageId NOT NULL`。队列 `claimNextVideoJob`（`video-queue.ts:518-522`）只按 `projectId + status='pending'` 领取。

`app/api/shot-sets/[id]/video-jobs/batch/route.ts:88`：`const sourceImageId = shot.latestGeneratedImageId || shot.sourceImageId;`
自由工位的 shot 只有 `sourceImageId`，走 fallback 分支，**这条路由一行都不用改**。

### 2.6 下游三条路

| 下游 | 查询 | 结果 |
|---|---|---|
| 第 4 步任务列表 | `app/api/shot-sets/[id]/video-jobs/route.ts:110` `WHERE vj.shotSetId = ?` | ✅ 正常命中 |
| 第 5 步混剪 | `lib/final-edit/mixcut-context.ts:139` 全项目列 `shot_sets` | ✅ 自动出现，**零改动** |
| 批量生产 | `lib/batch-production/prepare.ts:128-132` 全项目扫 `succeeded` | ✅ **零改动** |

### 2.7 删除的真实后果（三个下游各不相同）

`app/api/shot-sets/[id]/route.ts:163-175` 无条件硬删，配合 `lib/db.ts:293-294` 的 `ON DELETE SET NULL`：

| 下游 | 实际行为 | 依据 |
|---|---|---|
| 视频文件 | 保留在磁盘 | 删除只碰数据库 |
| 第 5 步混剪 | 完全取不到 | `mixcut-context.ts:252` 严格 `AND shotSetId = ?` |
| 批量生产 · 删前**已登记** | **继续保留可用** | `verifyAssetSources`（`media-catalog.ts:488-515`）只重验磁盘文件，不重验 shotSetId |
| 批量生产 · 删前**未登记** | 永远登记不上 | `media-catalog.ts:316` 抛错，`prepare.ts` 降级成 warning，用户看不到 |
| **进行中的视频任务** | **继续提交、继续计费，产出无处可达** | 队列按 `projectId` 领取，执行链路完全不读 `shotSetId`/`shotId` |

前四行是既有行为（D11 排除在本次范围外，§7 另开单子）。最后一行由 **D14** 的 409 挡住。

### 2.8 `ADD COLUMN ... CHECK` 实测

本仓 `better-sqlite3`（SQLite **3.53.1**）：不重建表、默认值正常回填、CHECK 真实生效。仓内先例 `lib/db-migrations.ts:68` 的 `executionScope`。

### 2.9 数据根与 DB 路径（C1 验收依赖）

- 环境变量 **`CREATIVE_STUDIO_DATA_ROOT`**（`lib/data-root.ts:7`）
- DB 路径 **`<dataRoot>/data/workbench.db`**（`lib/db.ts:8`）
- **开着 WAL**（`lib/db.ts:20`），运行期间 `cp` 会漏内容，必须用 `.backup()` 或先完全停掉应用

### 2.10 迁移测试现状

`scripts/db-migrations.test.ts` 夹具（`:9-73`）只建 6 张表、**没有 `shot_sets`**；`:75-79` 只跑一遍；`:91-95` 硬断言尾条是 `tailImageId`。追加迁移会让 `:91` 必然失败，且因夹具缺表，ALTER 会被吞进 catch。

---

### 2.11 最终确认的 UI 视觉合同（D22）

视觉基准不是新设计稿，而是**当前生产第 4 步视频生成工作区本身**。已确认样机只把首帧来源改成用户上传，并用 mock 数据证明交互；正式实现必须继续在 `VideoGenerationPanel` 内完成。

| 区域 | 必须保留 | 自由工位唯一允许的差异 |
|---|---|---|
| 外层 | `video-generation-section` + `video-workspace` | 无 |
| 左栏 | `panel-col left-col`、顶部 tab、`video-motion-card`、首尾帧对、供应商、模板/时长、提示词、添加描述、并发数、生成按钮 | tab 写 `图 N`；末尾增加 `添加图片`；空工位时首帧格是上传入口；D21 删除动作放 tab 下方 |
| 中栏 | `panel-col center-col video-preview-col`、大画面、`stage-controls` | 无；没有结果时只使用既有空态文案 |
| 右栏 | `panel-col right-col`、`result-card` 纵向列表和滚动 | 无；没有结果时只使用既有 `result-empty` |

**空工位首屏也必须长得像原工作区**：

```text
┌ 左栏：原参数区 ─────────┐  ┌ 中栏：原预览区 ───────┐  ┌ 右栏：原结果区 ──┐
│ [＋ 添加图片]          │  │  添加首帧图后开始生成  │  │  先添加首帧图     │
│ ┌ 描述 1 ───────────┐ │  │  原播放器控制条（禁用）│  │  result-empty     │
│ │ [添加首帧图] →     │ │  └─────────────────────┘  └───────────────────┘
│ │ [先添加首帧]       │ │
│ │ 供应商 / 模板 / 时长│ │
│ │ 运镜描述            │ │
│ └────────────────────┘ │
│ 添加描述 / 并发 / 生成 │
└────────────────────────┘
```

这里的字符图只表达层级，**不可拿来另写样式**；实际 DOM、间距、圆角、颜色和字体全部复用现有 class。

**有图 / 有结果状态**必须和用户提供的现有 UI 截图一致：左参数、中预览、右结果三栏位置不变。已确认样机在 `1424 × 803 CSS px`、DPR 2 下的实测基准为：

- 工作区：`1338 × 720 CSS px`
- 三栏宽度：`420 / 626 / 260 CSS px`
- 栅格间距：`16 CSS px`
- 中栏预览为现有居中大画面，右栏仍为窄结果列

这些数值是**桌面参考视口的回归基准**，不是新的全局硬编码；响应式行为继续由 `app/globals.css` 的现有断点负责。

#### 2.11.1 允许与禁止的差异

允许：

- `分镜 N` → `图 N`（仅自由工位）
- tab 末尾增加 `＋ 添加图片`
- 空首帧格支持点击/拖入 PNG、JPEG、WebP
- D21 的「删掉这张图」辅助动作
- 与以上动作直接相关的上传中、禁用、失败提示

禁止：

- A/B/C 方案切换、方案名称或比较器
- 新页面标题、说明 banner、引导步骤、胶片带、状态悬浮窗
- 自由工位专属弹窗、素材宫格、批量勾选或独立上传页
- 调换三栏顺序、把结果区搬到中栏下方、把预览做成另一种播放器
- 新配色、新阴影、新圆角、新字体、新卡片体系
- 上传后提供「更换首帧」：D20 规定必须新增一张图，已有 shot 的 `sourceImageId` 不可变

#### 2.11.2 执行前的视觉预检

开始 C16 前必须先同时打开：

1. 正式 `VideoGenerationPanel.tsx` 当前页面；
2. `/free-material-video-prototype` 已确认样机；
3. 本节允许/禁止清单。

若执行者准备新增一个没有出现在上述两处的布局组件或视觉概念，**立即停止**；这不是“优化”，而是偏离需求。

---

### 2.12 删除单张图的判定（D21）

**规则：一张图（`shots` 行）可以删，当且仅当它名下没有任何「已产出、或可能还在花钱」的视频任务。**

| 该 shot 的 `video_jobs` 状态 | 能删？ | 理由 |
|---|---|---|
| 一条都没有 | ✅ | 传错了、还没点生成，本来就该能撤 |
| 全部是 `failed` / `canceled` | ✅ | 什么产出都没留下。配错供应商试一次就永远删不掉那张图，太难用 |
| 有 `succeeded` | ❌ | 有真实产出。删掉图后 `video_jobs.shotId` 被置 NULL 但 `shotSetId` 还在，视频会继续留在结果列和混剪里、却找不到来源 |
| 有 `pending` / `running` / `needs_check` / `paused` | ❌ | 和 D14 同一个理由：还在花钱，产出即将落地 |

判定式（**注意和 D14 的集合不同**，D14 只挡非终态，这里还要多挡 `succeeded`）：

```sql
SELECT COUNT(*) FROM video_jobs
WHERE shotId = ? AND status NOT IN ('failed', 'canceled')
```

> 大于 0 就返回 409。这个白名单同样是「只列出安全状态」，将来新增任何状态都默认落在挡住的一边。

**连带删除上传的图片资源**：删掉 shot 之后，best-effort 调一次 `DELETE /api/images/{sourceImageId}`。
不需要自己判断能不能删 —— `app/api/images/[id]/route.ts:38-55` 已经在一个事务里查 `IMAGE_REFERENCE_COUNTS_SQL`（含 `video_jobs.sourceImageId`，`lib/image-delete-policy.ts:14`），还有引用就返回 409。所以：

- 同一张图被追加了两次 → 另一条 shot 还在引用 → 409 → 忽略，图保留
- 有 failed 任务引用着 → 409 → 忽略，图保留（可接受：不留可见的僵尸 tab 就够了）
- 干净的 → 删掉，不留存储垃圾

**不做连带删除会怎样**：`usage='video_source'` 的图不出现在第 2 步的宫格里，用户永远看不到、也清不掉，是纯粹的存储泄漏。这和尾帧的 `releaseDraftTailFrameAssets`（`VideoGenerationPanel.tsx:19-29`）是同一套思路。

---

## 3. 任务卡（C1 → C16，严格串行）

**共 16 张卡，四层**：数据基础（C1）→ 领域层（C2–C5）→ 服务端接线（C6–C11）→ UI（C12–C16）。
**不得并行、不得调序。任何一卡验收不过，停下汇报，不要改验收标准、不要跳卡。**

---

### 第一层：数据基础

#### 卡 C1 — 迁移 `shot_sets.kind` + 迁移测试

**改动 1** `lib/db-migrations.ts`：在 `CORE_DB_MIGRATIONS` 末尾（当前最后一条是 `:73` 的 `tailImageId`）**追加一行**：

```ts
  `ALTER TABLE shot_sets ADD COLUMN kind TEXT NOT NULL DEFAULT 'storyboard' CHECK(kind IN ('storyboard','free'))`,
```

**改动 2** `scripts/db-migrations.test.ts`

**(a)** 夹具补一张**旧版** `shot_sets`（**不带 `kind`**）。在 `:56` 的 `CREATE TABLE shots (...)` 之后插入：

```sql
  CREATE TABLE shot_sets (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    productCode TEXT DEFAULT '',
    category TEXT DEFAULT '',
    sceneReferenceId TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

并在 `:72` 最后一条 INSERT 之后补历史数据：

```sql
  INSERT INTO shot_sets (id, projectId, name)
  VALUES ('legacy-set', 'legacy-project', '历史分镜组');
```

**(b)** `:91-95` 的尾条断言改为新尾条，`tailImageId` 降级成 `includes` 守卫：

```ts
assert.ok(
  CORE_DB_MIGRATIONS.includes(`ALTER TABLE video_jobs ADD COLUMN tailImageId TEXT`),
  'the tail-frame migration must remain in the append-only core migration stream',
);
assert.equal(
  CORE_DB_MIGRATIONS.at(-1),
  `ALTER TABLE shot_sets ADD COLUMN kind TEXT NOT NULL DEFAULT 'storyboard' CHECK(kind IN ('storyboard','free'))`,
  'new core migrations must be appended without rewriting published entries',
);
```

**(c)** 文件末尾追加：

```ts
// ── shot_sets.kind:新增列、历史数据回填、CHECK 生效、迁移幂等 ──
const shotSetColumns = db.prepare(`PRAGMA table_info(shot_sets)`).all() as Array<{ name: string }>;
assert.ok(
  shotSetColumns.some((column) => column.name === 'kind'),
  'shot_sets.kind should be added when migrating older installed databases',
);

const legacySet = db.prepare(`SELECT kind FROM shot_sets WHERE id = ?`).get('legacy-set') as
  | { kind: string }
  | undefined;
assert.equal(legacySet?.kind, 'storyboard', '历史分镜组必须回填成 storyboard,不能是 NULL');

assert.throws(
  () => db.prepare(
    `INSERT INTO shot_sets (id, projectId, name, kind) VALUES ('bogus-set', 'legacy-project', 'x', 'bogus')`,
  ).run(),
  /CHECK constraint failed/,
  'shot_sets.kind 必须被 CHECK 挡住非法值',
);
db.prepare(
  `INSERT INTO shot_sets (id, projectId, name, kind) VALUES ('free-set', 'legacy-project', '自由素材', 'free')`,
).run();

// 生产环境每次启动都会整条重跑迁移流,必须幂等且不改动已有数据。
for (const sql of CORE_DB_MIGRATIONS) {
  try { db.exec(sql); } catch { /* Match production migration behavior. */ }
}
assert.equal(
  (db.prepare(`SELECT kind FROM shot_sets WHERE id = ?`).get('legacy-set') as { kind: string }).kind,
  'storyboard',
  '重复执行迁移不得改变已有 shot_sets 数据',
);
assert.equal(
  (db.prepare(`SELECT kind FROM shot_sets WHERE id = ?`).get('free-set') as { kind: string }).kind,
  'free',
  '重复执行迁移不得改变自由工位数据',
);
```

**禁止**：不要修改 `CORE_DB_MIGRATIONS` 中任何已发布条目（append-only，CLAUDE.md）；不要修改 `lib/db.ts:174-185` 的 `CREATE TABLE shot_sets`（本仓惯例：新列只走迁移流，对照 `video_jobs.tailImageId`）；不要动 `shot_sets.status` 的既有 CHECK。

**验收 1**：`node scripts/db-migrations.test.ts` 必须退出码 0

**验收 2 — 真实旧库迁移**

```bash
# ① 完全停掉 app（WAL 下热复制会漏数据），用 SQLite 在线备份取完整副本
mkdir -p /tmp/cs-migrate-check/data
node -e "const D=require('better-sqlite3');
const src=new D('data/workbench.db',{readonly:true});
src.backup('/tmp/cs-migrate-check/data/workbench.db')
  .then(()=>{console.log('backup ok');process.exit(0)})
  .catch(e=>{console.error(e);process.exit(1)});"

# ② 用【正确的】环境变量把 dev 指到临时根目录（是 CREATIVE_ 不是 CREATE_），迁移跑完后 Ctrl+C
CREATIVE_STUDIO_DATA_ROOT=/tmp/cs-migrate-check npm run dev

# ③ 只检查临时库
node -e "const D=require('better-sqlite3');
const d=new D('/tmp/cs-migrate-check/data/workbench.db',{readonly:true});
console.log('columns:', d.prepare('PRAGMA table_info(shot_sets)').all().map(c=>c.name).join(','));
console.log('kinds:', d.prepare('SELECT kind, COUNT(*) c FROM shot_sets GROUP BY kind').all());"
```

预期：`columns` 含 `kind`；`kinds` 全部 `storyboard`。
**真实工作库 `data/workbench.db` 在这一步不应被打开** —— 如果它被迁移了，说明步骤 ② 的环境变量没生效，停下汇报。

---

### 第二层：领域层（先写规则、先测，再接线）

#### 卡 C2 — 领域模块

**新建** `lib/shot-set-domain.ts`：

```ts
/**
 * 分镜组的共享领域规则。
 *
 * 建组有两条入口:项目创建时的整包创建(app/api/projects/route.ts)、以及
 * 独立的建组接口(app/api/projects/[id]/shot-sets/route.ts)。历史上两条
 * 路径的校验不一致 —— 独立接口有 9 张上限和去重,项目创建路径两样都没有。
 * 所有校验集中在这里,两条路径都必须走同一个函数。
 */

/**
 * 一个【普通】分镜组最多容纳多少张分镜图。
 *
 * 这个上限来自第 3 步脚本生成的视觉预算,不是存储或渲染约束:
 * lib/script-vision-image.ts 给整批分镜图的原始字节总预算是
 * SCRIPT_VISION_TOTAL_RAW_BYTES(4MB),而单图预算是
 * min(SCRIPT_VISION_IMAGE_MAX_BYTES, 4MB / 张数)
 * (见 lib/script-generation-v3-service.ts 的 readShotVisuals 调用)。
 *
 * 张数超过 SHOT_VISION_FULL_QUALITY_MAX 后单图预算开始低于 384KB 满配,
 * 20 张时每张仍有约 200KB,在 1024px 长边下画质可用。
 *
 * 【自由素材工位不受这个上限约束】(D18)。它的图片数量无上限,代价是
 * 图多时第 3 步会降质 —— 由 ScriptStrategyConfig 的软提示兜住,不拦截。
 */
export const MAX_SHOTS_PER_SET = 20;

/**
 * 超过这个张数,脚本生成会开始压缩每张分镜图的画质。
 * 4MB / 384KB ≈ 10.67,所以 10 张以内是满配。
 */
export const SHOT_VISION_FULL_QUALITY_MAX = 10;

/**
 * 分镜组类型。
 * - storyboard: 常规分镜组,参与第 2 步「用场景参考图批量生成分镜图」
 * - free:       自由素材工位,直接上传图片做视频,不参与第 2 步;一个项目一个
 */
export type ShotSetKind = 'storyboard' | 'free';

export const SHOT_SET_KINDS: readonly ShotSetKind[] = ['storyboard', 'free'];

export function isShotSetKind(value: unknown): value is ShotSetKind {
  return typeof value === 'string' && (SHOT_SET_KINDS as readonly string[]).includes(value);
}

/** 自由素材工位的固定名字。一个项目只有一个,不需要用户命名。 */
export const FREE_SHOT_SET_NAME = '自由素材工位';

export type NormalizeShotImageIdsResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

/**
 * 归一化建组用的图片 id 列表:接受缺省 → 过滤脏值 → 去重 → 校验数量。
 *
 * 去重发生在数量校验之前,所以「21 个 id 里有一个重复」会被算成 20 张
 * 并放行,而不是误杀。
 *
 * 【务必保留 nullish 分支】新建项目页(app/projects/new/page.tsx)根本不
 * 发送 shotImageIds,所以 allowEmpty 场景下 undefined / null 必须当成
 * 空数组放行。把这条规则放在函数内部(而不是让调用方写 `?? []`),是为了
 * 让下一个调用方不必重新踩一遍这个坑。
 *
 * @param options.allowEmpty 项目创建路径和自由工位允许空(表示暂时没有图);
 *                           普通的独立建组接口不允许。
 * @param options.max        数量上限。默认 MAX_SHOTS_PER_SET;传 null 表示
 *                           不限(自由素材工位,见 D18)。
 */
export function normalizeShotImageIds(
  raw: unknown,
  options: { allowEmpty?: boolean; max?: number | null } = {},
): NormalizeShotImageIdsResult {
  const max = options.max === undefined ? MAX_SHOTS_PER_SET : options.max;

  if (raw === undefined || raw === null) {
    return options.allowEmpty
      ? { ok: true, ids: [] }
      : { ok: false, error: 'shotImageIds 必须是数组' };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'shotImageIds 必须是数组' };
  }
  const ids = [...new Set(
    raw.filter((value): value is string => typeof value === 'string' && value.length > 0),
  )];
  if (ids.length === 0) {
    return options.allowEmpty
      ? { ok: true, ids }
      : { ok: false, error: '至少需要 1 张分镜图' };
  }
  if (max !== null && ids.length > max) {
    return { ok: false, error: `分镜图最多 ${max} 张` };
  }
  return { ok: true, ids };
}
```

**验收**：`npx tsc --noEmit`

---

#### 卡 C3 — 领域模块测试

**新建** `scripts/shot-set-domain.test.ts`：

```ts
import assert from 'node:assert/strict';
import {
  MAX_SHOTS_PER_SET,
  SHOT_VISION_FULL_QUALITY_MAX,
  isShotSetKind,
  normalizeShotImageIds,
} from '../lib/shot-set-domain.ts';

// ── 常量自身的不变量 ──
assert.equal(MAX_SHOTS_PER_SET, 20, '上限变动必须是有意的产品决策');
assert.ok(
  SHOT_VISION_FULL_QUALITY_MAX < MAX_SHOTS_PER_SET,
  '满配阈值必须小于上限,否则软提示永远不会触发',
);

// ── 回归:新建项目页不发送 shotImageIds(app/projects/new/page.tsx) ──
// 这三条挡的是一个真实炸过的方案:allowEmpty 下把 undefined 当成非法值,
// 会让每一次「新建空项目」都返回 400。
assert.deepEqual(
  normalizeShotImageIds(undefined, { allowEmpty: true }),
  { ok: true, ids: [] },
  'allowEmpty 时 undefined 必须当成空数组,否则新建空项目会 400',
);
assert.deepEqual(
  normalizeShotImageIds(null, { allowEmpty: true }),
  { ok: true, ids: [] },
);
assert.equal(
  normalizeShotImageIds(undefined).ok,
  false,
  '不带 allowEmpty 时 undefined 仍必须失败',
);

// ── 类型不对 ──
assert.deepEqual(normalizeShotImageIds('nope'), { ok: false, error: 'shotImageIds 必须是数组' });
assert.equal(
  normalizeShotImageIds('nope', { allowEmpty: true }).ok,
  false,
  'allowEmpty 只放宽缺省,不放宽「传了但不是数组」',
);

// ── 脏值过滤 + 去重 ──
assert.deepEqual(normalizeShotImageIds(['a', 'b', 'a']), { ok: true, ids: ['a', 'b'] });
assert.deepEqual(
  normalizeShotImageIds(['a', '', null, 3, { id: 'x' }, 'b']),
  { ok: true, ids: ['a', 'b'] },
);

// ── 空数组的两种契约 ──
assert.equal(normalizeShotImageIds([]).ok, false);
assert.deepEqual(normalizeShotImageIds([], { allowEmpty: true }), { ok: true, ids: [] });

// ── 20 / 21 边界 ──
const twenty = Array.from({ length: MAX_SHOTS_PER_SET }, (_, i) => `img-${i}`);
assert.equal(normalizeShotImageIds(twenty).ok, true, '刚好 20 张必须放行');
const overLimit = normalizeShotImageIds([...twenty, 'img-extra']);
assert.equal(overLimit.ok, false, '21 张必须被挡住');
assert.match(
  overLimit.ok ? '' : overLimit.error,
  new RegExp(String(MAX_SHOTS_PER_SET)),
  '错误信息要带上真实上限,不能写死 9',
);

// ── 去重发生在数量校验之前 ──
assert.equal(
  normalizeShotImageIds([...twenty, twenty[0]]).ok,
  true,
  '21 个 id 里有重复,去重后是 20 张,不能误杀',
);

// ── D18:自由素材工位不限张数 ──
const fifty = Array.from({ length: 50 }, (_, i) => `free-${i}`);
assert.equal(
  normalizeShotImageIds(fifty, { max: null }).ok,
  true,
  'max: null 时不限张数(自由素材工位)',
);
assert.equal(normalizeShotImageIds(fifty).ok, false, '不传 max 时仍走 20 张上限');

// ── kind ──
assert.ok(isShotSetKind('storyboard'));
assert.ok(isShotSetKind('free'));
assert.ok(!isShotSetKind('bogus'));
assert.ok(!isShotSetKind(''));
assert.ok(!isShotSetKind(undefined));

console.log('shot-set-domain.test.ts OK');
```

**验收**：`node scripts/shot-set-domain.test.ts`

---

#### 卡 C4 — 分镜组服务

把建组、取/建自由工位、追加图片、删组的全部规则搬进可测的服务层。路由之后只负责解析请求和映射状态码。

**新建** `lib/shot-set-service.ts`：

```ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  FREE_SHOT_SET_NAME,
  isShotSetKind,
  normalizeShotImageIds,
  type ShotSetKind,
} from './shot-set-domain.ts';

export type ShotSetServiceFailure = { ok: false; status: 400 | 404 | 409; error: string };

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 校验一批图片全部属于该项目。这是唯一挡住跨项目图片的关卡。 */
function allImagesBelongToProject(
  db: Database.Database,
  projectId: string,
  imageIds: string[],
): boolean {
  if (imageIds.length === 0) return true;
  const placeholders = imageIds.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM image_assets WHERE id IN (${placeholders}) AND projectId = ?`,
  ).get(...imageIds, projectId) as { cnt: number };
  return row.cnt === imageIds.length;
}

function insertShots(db: Database.Database, shotSetId: string, imageIds: string[], startIndex: number): void {
  const insert = db.prepare(`
    INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, ?, ?)
  `);
  imageIds.forEach((imageId, offset) => {
    insert.run(uuidv4(), shotSetId, startIndex + offset, imageId);
  });
}

/* ────────────────────────── 建组 ────────────────────────── */

export type CreateShotSetResult =
  | { ok: true; id: string; name: string; kind: ShotSetKind }
  | ShotSetServiceFailure;

export interface CreateShotSetInput {
  projectId: string;
  name: unknown;
  shotImageIds: unknown;
  kind?: unknown;
  productCode?: unknown;
  category?: unknown;
}

export function createShotSet(
  db: Database.Database,
  input: CreateShotSetInput,
): CreateShotSetResult {
  // 非法 kind 必须显式报错,不能静默降级成 storyboard —— 静默降级会让调用方
  // 以为建了自由工位,实际建出一个会出现在第 2 步的普通组。
  let kind: ShotSetKind = 'storyboard';
  if (input.kind !== undefined && input.kind !== null) {
    if (!isShotSetKind(input.kind)) {
      return { ok: false, status: 400, error: `非法的 kind 值：${String(input.kind)}` };
    }
    kind = input.kind;
  }

  const name = asText(input.name).trim() || (kind === 'free' ? FREE_SHOT_SET_NAME : '');
  if (!name) return { ok: false, status: 400, error: '名称不能为空' };

  const normalized = normalizeShotImageIds(input.shotImageIds, {
    // 自由工位可以先建空的,之后一张张追加(D15);普通组必须至少 1 张。
    allowEmpty: kind === 'free',
    max: kind === 'free' ? null : undefined,
  });
  if (!normalized.ok) return { ok: false, status: 400, error: normalized.error };
  const shotImageIds = normalized.ids;

  if (!allImagesBelongToProject(db, input.projectId, shotImageIds)) {
    return { ok: false, status: 400, error: '部分图片不存在或不属于当前项目' };
  }

  const setId = uuidv4();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO shot_sets (id, projectId, name, productCode, category, kind, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      setId, input.projectId, name,
      asText(input.productCode), asText(input.category), kind,
      // 自由工位没有场景图生成过程,直接落 approved 表示可用;
      // 普通分镜组保持既有的 draft。
      kind === 'free' ? 'approved' : 'draft',
    );
    insertShots(db, setId, shotImageIds, 1);
  })();

  return { ok: true, id: setId, name, kind };
}

/* ──────────────── 自由工位:一个项目一个,取不到就建 ──────────────── */

export type FreeShotSetResult = { ok: true; id: string; created: boolean } | ShotSetServiceFailure;

/**
 * D15:一个项目只有一个自由素材工位。前端在下拉里选中它时调用本函数,
 * 第一次会建一个空的,之后每次都返回同一个。
 */
export function getOrCreateFreeShotSet(db: Database.Database, projectId: string): FreeShotSetResult {
  const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
  if (!project) return { ok: false, status: 404, error: '项目不存在' };

  const existing = db.prepare(`
    SELECT id FROM shot_sets WHERE projectId = ? AND kind = 'free' ORDER BY createdAt LIMIT 1
  `).get(projectId) as { id: string } | undefined;
  if (existing) return { ok: true, id: existing.id, created: false };

  const created = createShotSet(db, {
    projectId,
    name: FREE_SHOT_SET_NAME,
    shotImageIds: [],
    kind: 'free',
  });
  if (!created.ok) return created;
  return { ok: true, id: created.id, created: true };
}

/* ────────────────────── 往自由工位追加一张图 ────────────────────── */

export type AppendShotResult =
  | { ok: true; shotId: string; indexNum: number }
  | ShotSetServiceFailure;

/**
 * 自由工位的「再加一张图」。只允许 kind='free' —— 普通分镜组的分镜由
 * 第 2 步的场景生成流程产生,不能从这里塞。
 */
export function appendShotToFreeSet(
  db: Database.Database,
  shotSetId: string,
  imageId: unknown,
): AppendShotResult {
  const set = db.prepare(`SELECT id, projectId, kind FROM shot_sets WHERE id = ?`).get(shotSetId) as
    | { id: string; projectId: string; kind: string }
    | undefined;
  if (!set) return { ok: false, status: 404, error: '分镜组不存在' };
  if (set.kind !== 'free') {
    return { ok: false, status: 400, error: '只有自由素材工位可以直接追加图片' };
  }

  const id = asText(imageId).trim();
  if (!id) return { ok: false, status: 400, error: '缺少图片 id' };
  if (!allImagesBelongToProject(db, set.projectId, [id])) {
    return { ok: false, status: 400, error: '图片不存在或不属于当前项目' };
  }

  const shotId = uuidv4();
  let indexNum = 1;
  db.transaction(() => {
    const maxRow = db.prepare(
      `SELECT COALESCE(MAX(indexNum), 0) AS maxIndex FROM shots WHERE shotSetId = ?`,
    ).get(shotSetId) as { maxIndex: number };
    indexNum = Number(maxRow.maxIndex) + 1;
    db.prepare(`
      INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, ?, ?)
    `).run(shotId, shotSetId, indexNum, id);
  })();

  return { ok: true, shotId, indexNum };
}

/* ─────────────────── 删掉自由工位里的某一张图 ─────────────────── */

/**
 * 「没留下任何东西」的视频任务状态。只有这两种不算数(D21)。
 *
 * 注意这个集合比 TERMINAL_VIDEO_JOB_STATUSES 少一个 succeeded ——
 * 删整个工位时 succeeded 是可以放行的(视频文件留着,只是脱离工位);
 * 删单张图时 succeeded 必须挡住,否则结果列里会留下一条找不到来源的视频。
 */
export const DISCARDABLE_VIDEO_JOB_STATUSES = ['failed', 'canceled'] as const;

export type DeleteShotResult =
  | { ok: true; sourceImageId: string }
  | ShotSetServiceFailure;

/**
 * D21:自由工位的「删掉这张图」。只允许在还没生成之前删。
 *
 * 返回被删 shot 的 sourceImageId,调用方(路由/前端)据此再 best-effort 删
 * 图片资源 —— 图片本身能不能删由 /api/images/[id] 自己的引用检查决定,
 * 这里不重复判断。
 */
export function deleteShotFromFreeSet(
  db: Database.Database,
  shotSetId: string,
  shotId: string,
): DeleteShotResult {
  const set = db.prepare(`SELECT id, kind FROM shot_sets WHERE id = ?`).get(shotSetId) as
    | { id: string; kind: string }
    | undefined;
  if (!set) return { ok: false, status: 404, error: '分镜组不存在' };
  if (set.kind !== 'free') {
    return { ok: false, status: 400, error: '只有自由素材工位可以删除单张图片' };
  }

  const shot = db.prepare(`SELECT id, sourceImageId FROM shots WHERE id = ? AND shotSetId = ?`)
    .get(shotId, shotSetId) as { id: string; sourceImageId: string } | undefined;
  if (!shot) return { ok: false, status: 404, error: '这张图不在该工位里' };

  // D21:只有 failed / canceled 不算数,其余(succeeded 以及所有非终态)都挡住。
  const placeholders = DISCARDABLE_VIDEO_JOB_STATUSES.map(() => '?').join(',');
  const blocking = db.prepare(
    `SELECT COUNT(*) AS count FROM video_jobs
     WHERE shotId = ? AND status NOT IN (${placeholders})`,
  ).get(shotId, ...DISCARDABLE_VIDEO_JOB_STATUSES) as { count: number };
  if (blocking.count > 0) {
    return {
      ok: false,
      status: 409,
      error: '这张图已经生成过视频了，不能删除。如果不想要，删掉对应的视频任务即可。',
    };
  }

  // indexNum 故意不重排:重排会让「图 3」在用户眼前变成「图 2」,而且
  // 已存在的 video_jobs 也没有 indexNum 可跟。tab 顺序按 indexNum 排,
  // 中间空一个号不影响任何东西。
  db.prepare(`DELETE FROM shots WHERE id = ?`).run(shotId);
  return { ok: true, sourceImageId: shot.sourceImageId };
}

/* ────────────────────────── 删组 ────────────────────────── */

/**
 * 视频任务的终态。终态之外的一切(pending / running / needs_check / paused,
 * 以及将来新增的任何状态)都算「进行中」—— 白名单式判定让新状态默认落在
 * 安全的一边。
 */
export const TERMINAL_VIDEO_JOB_STATUSES = ['succeeded', 'failed', 'canceled'] as const;

export type DeleteShotSetResult = { ok: true } | ShotSetServiceFailure;

export function deleteShotSet(db: Database.Database, shotSetId: string): DeleteShotSetResult {
  const existing = db.prepare(`SELECT id FROM shot_sets WHERE id = ?`).get(shotSetId);
  if (!existing) return { ok: false, status: 404, error: '分镜组不存在' };

  // 删组会把 video_jobs.shotSetId / shotId 置空(ON DELETE SET NULL),但视频
  // 队列是按 projectId 领任务的(lib/video-queue.ts claimNextVideoJob),完全
  // 不看 shotSet。所以进行中的任务在删组后会继续向供应商提交、继续计费,
  // 产出却再也回不到任何界面。必须先挡住。
  const placeholders = TERMINAL_VIDEO_JOB_STATUSES.map(() => '?').join(',');
  const active = db.prepare(
    `SELECT COUNT(*) AS count FROM video_jobs
     WHERE shotSetId = ? AND status NOT IN (${placeholders})`,
  ).get(shotSetId, ...TERMINAL_VIDEO_JOB_STATUSES) as { count: number };
  if (active.count > 0) {
    return {
      ok: false,
      status: 409,
      error: `还有 ${active.count} 个视频任务没有结束，请先取消或等它们跑完再删除分镜组。`,
    };
  }

  db.prepare(`DELETE FROM shot_sets WHERE id = ?`).run(shotSetId);
  return { ok: true };
}
```

> **D14 的收窄开关**：若决定 409 只对自由工位生效，在 `deleteShotSet` 的 `existing` 查询里一并取 `kind`，把活跃任务检查包进 `if (existing.kind === 'free') { ... }`。默认按 D14 对所有分镜组生效。

**验收**：`npx tsc --noEmit && npm run lint`

---

#### 卡 C5 — 服务层测试（内存 SQLite）

**新建** `scripts/shot-set-service.test.ts`：

```ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { FREE_SHOT_SET_NAME, MAX_SHOTS_PER_SET } from '../lib/shot-set-domain.ts';
import {
  appendShotToFreeSet,
  createShotSet,
  deleteShotFromFreeSet,
  deleteShotSet,
  getOrCreateFreeShotSet,
} from '../lib/shot-set-service.ts';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);

    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY, projectId TEXT,
      role TEXT NOT NULL DEFAULT 'input', usage TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      productCode TEXT DEFAULT '',
      category TEXT DEFAULT '',
      sceneReferenceId TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','generating','reviewing','approved','video_ready')),
      kind TEXT NOT NULL DEFAULT 'storyboard' CHECK(kind IN ('storyboard','free')),
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE shots (
      id TEXT PRIMARY KEY,
      shotSetId TEXT NOT NULL,
      indexNum INTEGER NOT NULL,
      sourceImageId TEXT NOT NULL,
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE CASCADE
    );

    CREATE TABLE video_jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      shotSetId TEXT,
      shotId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE SET NULL,
      FOREIGN KEY (shotId) REFERENCES shots(id) ON DELETE SET NULL
    );

    INSERT INTO projects (id, name) VALUES ('p1', '项目一'), ('p2', '项目二');
  `);
  const insertImage = db.prepare(`INSERT INTO image_assets (id, projectId) VALUES (?, ?)`);
  for (let i = 0; i < 60; i++) insertImage.run(`p1-img-${i}`, 'p1');
  insertImage.run('p2-img-0', 'p2');
  return db;
}

/* ── 建组:普通组 ── */
{
  const db = freshDb();
  const r = createShotSet(db, { projectId: 'p1', name: '  卧室分镜  ', shotImageIds: ['p1-img-0', 'p1-img-1'] });
  assert.ok(r.ok);
  assert.equal(r.name, '卧室分镜', '名称必须 trim');
  assert.equal(r.kind, 'storyboard');
  const row = db.prepare(`SELECT kind, status FROM shot_sets WHERE id = ?`).get(r.id) as { kind: string; status: string };
  assert.deepEqual(row, { kind: 'storyboard', status: 'draft' });
  assert.deepEqual(
    db.prepare(`SELECT indexNum, sourceImageId FROM shots WHERE shotSetId = ? ORDER BY indexNum`).all(r.id),
    [{ indexNum: 1, sourceImageId: 'p1-img-0' }, { indexNum: 2, sourceImageId: 'p1-img-1' }],
    'shots 必须按选择顺序编号',
  );
}

/* ── 建组:普通组不接受空,自由工位接受空 ── */
{
  const db = freshDb();
  assert.equal(createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: [] }).ok, false);
  const free = createShotSet(db, { projectId: 'p1', name: '', shotImageIds: [], kind: 'free' });
  assert.ok(free.ok, '自由工位可以先建空的');
  assert.equal(free.name, FREE_SHOT_SET_NAME, '不传名字时用固定名');
  const row = db.prepare(`SELECT kind, status FROM shot_sets WHERE id = ?`).get(free.id) as { kind: string; status: string };
  assert.deepEqual(row, { kind: 'free', status: 'approved' });
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM shots WHERE shotSetId = ?`).get(free.id).c, 0);
}

/* ── 建组:非法 kind → 400,不留残留 ── */
{
  const db = freshDb();
  const r = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0'], kind: 'bogus' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM shot_sets`).get().c, 0, '失败时不得留下半个分镜组');
}

/* ── 建组:跨项目图片 → 400 ── */
{
  const db = freshDb();
  const r = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0', 'p2-img-0'] });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM shot_sets`).get().c, 0);
}

/* ── 建组:20 / 21 边界,以及自由工位不限张数(D18) ── */
{
  const db = freshDb();
  const tooMany = Array.from({ length: MAX_SHOTS_PER_SET + 1 }, (_, i) => `p1-img-${i}`);
  assert.equal(createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: tooMany }).ok, false);
  const justEnough = Array.from({ length: MAX_SHOTS_PER_SET }, (_, i) => `p1-img-${i}`);
  assert.equal(createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: justEnough }).ok, true);
  const fifty = Array.from({ length: 50 }, (_, i) => `p1-img-${i}`);
  assert.equal(
    createShotSet(db, { projectId: 'p1', name: 'f', shotImageIds: fifty, kind: 'free' }).ok,
    true,
    '自由工位不受 20 张上限约束',
  );
}

/* ── 自由工位:单例(D15) ── */
{
  const db = freshDb();
  const a = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(a.ok);
  assert.equal(a.created, true, '第一次调用要建');
  const b = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(b.ok);
  assert.equal(b.created, false, '第二次调用不能再建');
  assert.equal(b.id, a.id, '必须返回同一个工位');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM shot_sets WHERE kind='free'`).get().c, 1);

  const other = getOrCreateFreeShotSet(db, 'p2');
  assert.ok(other.ok);
  assert.notEqual(other.id, a.id, '不同项目各有各的自由工位');

  assert.equal(getOrCreateFreeShotSet(db, 'nope').ok, false, '项目不存在要 404');
}

/* ── 追加图片 ── */
{
  const db = freshDb();
  const free = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(free.ok);

  const first = appendShotToFreeSet(db, free.id, 'p1-img-0');
  assert.ok(first.ok);
  assert.equal(first.indexNum, 1, '空工位追加的第一张是 1');
  const second = appendShotToFreeSet(db, free.id, 'p1-img-1');
  assert.ok(second.ok);
  assert.equal(second.indexNum, 2, 'indexNum 必须递增');

  // 同一张图可以重复追加(用户可能想用同一张图配不同批运镜)
  assert.equal(appendShotToFreeSet(db, free.id, 'p1-img-0').ok, true);

  // 跨项目图片挡住
  const cross = appendShotToFreeSet(db, free.id, 'p2-img-0');
  assert.equal(cross.ok, false);
  assert.equal(cross.ok === false && cross.status, 400);

  // 空 id 挡住
  assert.equal(appendShotToFreeSet(db, free.id, '  ').ok, false);

  // 普通分镜组不能从这里塞
  const sb = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-5'] });
  assert.ok(sb.ok);
  const rejected = appendShotToFreeSet(db, sb.id, 'p1-img-6');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false && rejected.status, 400);

  // 工位不存在 → 404
  assert.equal(appendShotToFreeSet(db, 'nope', 'p1-img-0').ok, false);
}

/* ── 删单张图(D21) ── */
{
  const db = freshDb();
  const free = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(free.ok);

  // 没有任何任务 → 可删,并回传 sourceImageId 供调用方清理图片
  const clean = appendShotToFreeSet(db, free.id, 'p1-img-0');
  assert.ok(clean.ok);
  const removed = deleteShotFromFreeSet(db, free.id, clean.shotId);
  assert.ok(removed.ok);
  assert.equal(removed.sourceImageId, 'p1-img-0');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM shots WHERE id = ?`).get(clean.shotId).c, 0);

  // 只有 failed / canceled → 仍可删
  for (const discardable of ['failed', 'canceled']) {
    const s2 = appendShotToFreeSet(db, free.id, 'p1-img-1');
    assert.ok(s2.ok);
    db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, status) VALUES (?, 'p1', ?, ?, ?)`)
      .run('j-' + discardable, free.id, s2.shotId, discardable);
    assert.equal(
      deleteShotFromFreeSet(db, free.id, s2.shotId).ok, true,
      `只有 ${discardable} 任务时应该还能删,否则配错供应商试一次就永远删不掉`,
    );
  }

  // succeeded 或任何非终态 → 409,且 shot 必须原封不动
  for (const blocking of ['succeeded', 'pending', 'running', 'needs_check', 'paused']) {
    const s3 = appendShotToFreeSet(db, free.id, 'p1-img-2');
    assert.ok(s3.ok);
    db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, status) VALUES (?, 'p1', ?, ?, ?)`)
      .run('jb-' + blocking, free.id, s3.shotId, blocking);
    const r = deleteShotFromFreeSet(db, free.id, s3.shotId);
    assert.equal(r.ok, false, `${blocking} 必须挡住删除`);
    assert.equal(r.ok === false && r.status, 409);
    assert.equal(
      db.prepare(`SELECT COUNT(*) c FROM shots WHERE id = ?`).get(s3.shotId).c, 1,
      '409 之后这张图必须还在',
    );
  }

  // 普通分镜组不允许删单张
  const sb = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-9'] });
  assert.ok(sb.ok);
  const sbShot = db.prepare(`SELECT id FROM shots WHERE shotSetId = ?`).get(sb.id) as { id: string };
  const sbReject = deleteShotFromFreeSet(db, sb.id, sbShot.id);
  assert.equal(sbReject.ok, false);
  assert.equal(sbReject.ok === false && sbReject.status, 400);

  // 工位不存在 / shot 不属于这个工位 → 404
  assert.equal(deleteShotFromFreeSet(db, 'nope', sbShot.id).ok, false);
  const foreign = deleteShotFromFreeSet(db, free.id, sbShot.id);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.status, 404);
}

/* ── 删单张图后,indexNum 不重排 ── */
{
  const db = freshDb();
  const free = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(free.ok);
  const a = appendShotToFreeSet(db, free.id, 'p1-img-0');
  const b = appendShotToFreeSet(db, free.id, 'p1-img-1');
  const c = appendShotToFreeSet(db, free.id, 'p1-img-2');
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(deleteShotFromFreeSet(db, free.id, b.shotId).ok, true);
  assert.deepEqual(
    db.prepare(`SELECT indexNum FROM shots WHERE shotSetId = ? ORDER BY indexNum`).all(free.id),
    [{ indexNum: 1 }, { indexNum: 3 }],
    '中间空号是有意的:重排会让用户眼前的「图 3」突然变成「图 2」',
  );
  // 删完再加,新号必须继续往后走,不能填回空缺
  const d = appendShotToFreeSet(db, free.id, 'p1-img-3');
  assert.ok(d.ok);
  assert.equal(d.indexNum, 4);
}

/* ── 删组:不存在 → 404 ── */
{
  const db = freshDb();
  const r = deleteShotSet(db, 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 404);
}

/* ── 删组:全部终态 → 放行 ── */
{
  const db = freshDb();
  const created = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0'] });
  assert.ok(created.ok);
  const insertJob = db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, status) VALUES (?, 'p1', ?, ?)`);
  insertJob.run('j1', created.id, 'succeeded');
  insertJob.run('j2', created.id, 'failed');
  insertJob.run('j3', created.id, 'canceled');
  assert.equal(deleteShotSet(db, created.id).ok, true, '终态任务不应挡住删除');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM shot_sets`).get().c, 0);
}

/* ── 删组:任一非终态 → 409,分镜组必须还在 ── */
for (const activeStatus of ['pending', 'running', 'needs_check', 'paused']) {
  const db = freshDb();
  const created = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0'] });
  assert.ok(created.ok);
  db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, status) VALUES ('j1', 'p1', ?, ?)`)
    .run(created.id, activeStatus);
  const r = deleteShotSet(db, created.id);
  assert.equal(r.ok, false, `${activeStatus} 必须挡住删除`);
  assert.equal(r.ok === false && r.status, 409);
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM shot_sets WHERE id = ?`).get(created.id).c, 1,
    '409 之后分镜组必须原封不动',
  );
}

console.log('shot-set-service.test.ts OK');
```

**验收**：`node scripts/shot-set-service.test.ts`

> 若 `better-sqlite3` 的类型在 `--experimental-strip-types` 下报错，参照 `scripts/db-migrations.test.ts` 的既有写法调整 import，**不要改服务实现**。

---

### 第三层：服务端接线

#### 卡 C6 — 建组路由改用服务

**文件** `app/api/projects/[id]/shot-sets/route.ts`，import 区加 `import { createShotSet } from '@/lib/shot-set-service';`，整个 `POST`（`:27-78`）函数体改为：

```ts
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const result = createShotSet(getDb(), {
      projectId: id,
      name: body.name,
      shotImageIds: body.shotImageIds,
      kind: body.kind,
      productCode: body.productCode,
      category: body.category,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ id: result.id, name: result.name, kind: result.kind });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

**禁止**：不要动 `GET`（`:5-25`），`SELECT ss.*` 会自动带 `kind`。改完后若 `uuidv4` 在该文件不再被使用，删掉它的 import。

**验收**：`npx tsc --noEmit && npm run lint`

---

#### 卡 C7 — 项目创建路径补上校验

**文件** `app/api/projects/route.ts`，import 区加 `import { normalizeShotImageIds } from '@/lib/shot-set-domain';`

`:101` 原文 `const shotImageIds = asStringArray(body.shotImageIds);` 改为：

```ts
    // 这条路径历史上既不去重也不限张数,和独立建组接口不一致。统一走共享
    // 领域函数;allowEmpty 覆盖「新建空项目根本不发 shotImageIds」的情况
    // (见 app/projects/new/page.tsx)。
    const normalizedShotImageIds = normalizeShotImageIds(body.shotImageIds, { allowEmpty: true });
    if (!normalizedShotImageIds.ok) {
      return NextResponse.json({ error: normalizedShotImageIds.error }, { status: 400 });
    }
    const shotImageIds = normalizedShotImageIds.ids;
```

> 这行位于 `db.transaction()` 之前，可以直接 `return`，无需回滚。

**同时**：`grep -n "asStringArray" app/api/projects/route.ts` —— 若已无调用者，删掉 `:13-16` 的定义。
**禁止**：不要改 `:103` 的 `genCount` `Math.min(9, ...)`（那是场景图生成张数，与分镜组容量无关）。

**必须手测**（这是最容易炸的地方）：改完后在浏览器里走一遍「新建项目」，**不选任何分镜图**，必须能建成功。

**验收**：`npx tsc --noEmit && npm run lint` + 上述手测

---

#### 卡 C8 — 删除路由改用服务（409 守卫）

**文件** `app/api/shot-sets/[id]/route.ts`，import 区加 `import { deleteShotSet } from '@/lib/shot-set-service';`，`:163-175` 的 `DELETE` 改为：

```ts
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = deleteShotSet(getDb(), id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

**同时必须修** `components/ShotSetPanel.tsx:210-218` 的 `handleDelete` —— 它目前不检查 `res.ok`，收到 409 后用户只会看到「点了没反应」：

```ts
    const res = await fetch(`/api/shot-sets/${setId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert('删除失败：' + (data.error || `HTTP ${res.status}`));
      return;
    }
```

**验收**：`npx tsc --noEmit && npm run lint`，外加 §5.3 手测

---

#### 卡 C9 — 场景生成拒绝自由工位

**文件** `app/api/shot-sets/[id]/apply-scene/route.ts`，`:21-24` 的结果类型加 `kind`，并在 `if (!set)` 之后加门禁：

```ts
    const set = db.prepare(`SELECT ss.*, p.providerId, p.model, p.size, p.quality, p.maxAttempts FROM shot_sets ss JOIN projects p ON ss.projectId = p.id WHERE ss.id = ?`).get(id) as {
      projectId: string; status: string; kind?: string; providerId: string; model: string; size: string; quality: string; maxAttempts: number;
    } | undefined;
    if (!set) return NextResponse.json({ error: '分镜组不存在' }, { status: 404 });
    // 自由素材工位没有「用场景参考图重绘分镜图」这个动作。前端已经不展示
    // 入口,这里是服务端兜底:直接打接口不能把自由工位推进 generating。
    if (set.kind === 'free') {
      return NextResponse.json({ error: '自由素材工位不支持分镜生成' }, { status: 400 });
    }
```

**验收**：`npx tsc --noEmit && npm run lint`，外加 §5.3 手测

---

#### 卡 C10 — 上传 usage 白名单

**文件** `app/api/upload/route.ts`，`:57`：

```ts
    const allowedUsage = ['', 'scene_seed', 'shot_source', 'video_source', VIDEO_TAIL_FRAME_USAGE];
```

**验收**：`npx tsc --noEmit && npm run lint`

---

#### 卡 C11 — 自由工位接口：取/建 + 追加图片 + 删图片

**新建** `app/api/projects/[id]/free-shot-set/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getOrCreateFreeShotSet } from '@/lib/shot-set-service';

// 前端在第 4 步下拉里选中「自由素材工位」时调用。
// 一个项目只有一个(D15):第一次会建一个空的,之后每次返回同一个。
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = getOrCreateFreeShotSet(getDb(), id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ id: result.id, created: result.created });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

**新建** `app/api/shot-sets/[id]/shots/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { appendShotToFreeSet } from '@/lib/shot-set-service';

// 自由素材工位的「再加一张图」。只允许 kind='free'——普通分镜组的分镜
// 由第 2 步的场景生成流程产生,不能从这里塞。
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = appendShotToFreeSet(getDb(), id, body.imageId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ shotId: result.shotId, indexNum: result.indexNum });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

**新建** `app/api/shot-sets/[id]/shots/[shotId]/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deleteShotFromFreeSet } from '@/lib/shot-set-service';

// D21:自由素材工位的「删掉这张图」,只允许在还没生成之前删。
// 返回 sourceImageId,前端据此再 best-effort 删图片资源——图片能不能删
// 由 /api/images/[id] 自己的引用检查决定(和尾帧 deleteTailFrameAsset 同一套)。
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; shotId: string }> }
) {
  try {
    const { id, shotId } = await params;
    const result = deleteShotFromFreeSet(getDb(), id, shotId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true, sourceImageId: result.sourceImageId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

**验收**：`npx tsc --noEmit && npm run lint`，外加 §5.3 手测

---

### 第四层：UI

#### 卡 C12 — `ShotSetPanel`：张数五处 + 隐藏自由工位

**文件** `components/ShotSetPanel.tsx`，import 区（`:12` 之后）加 `import { MAX_SHOTS_PER_SET } from '@/lib/shot-set-domain';`

`:54-65` 的 `ShotSet` interface 加 `kind?: string;`

`:117-124` 的 `loadSets` 改为：

```ts
  const loadSets = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/shot-sets`);
      const data = await res.json();
      // 自由素材工位没有「用场景参考图生成分镜图」这个动作,不属于本工位。
      // 它只在第 3 步(脚本)、第 4 步(视频生成)、第 5 步(智能混剪)和
      // 批量生产里出现;删除入口在第 4 步(见卡 C15)。
      if (Array.isArray(data)) setSets((data as ShotSet[]).filter((set) => set.kind !== 'free'));
    } catch { /* ignore */ }
    return undefined;
  }, [projectId]);
```

张数五处：

| 行 | 原文 | 改为 |
|---|---|---|
| `:192` | `prev.length < 9 ? [...prev, imgId] : prev` | `prev.length < MAX_SHOTS_PER_SET ? [...prev, imgId] : prev` |
| `:513` | `maxFiles={9}` | `maxFiles={MAX_SHOTS_PER_SET}` |
| `:530` | `选择分镜图（1-9 张，顺序无所谓）` | `` {`选择分镜图（1-${MAX_SHOTS_PER_SET} 张，顺序无所谓）`} `` |
| `:548` | `已选 {selectedImageIds.length}/9 张，…` | `已选 {selectedImageIds.length}/{MAX_SHOTS_PER_SET} 张，…` |
| `:561` | `暂无分镜组。选择 1-9 张原始分镜图…` | `暂无分镜组。选择 1-{MAX_SHOTS_PER_SET} 张原始分镜图…` |

> `:530` 是 `<label>` 的纯文本子节点，改成模板字符串要用 `{...}` 包住。
> `handleDelete` 的 409 处理已在 C8 完成，本卡不要重复改。

**验收**：`npx tsc --noEmit && npm run lint`

---

#### 卡 C13 — `AssetUploadGrid` 一处 + 项目页三处

**文件 1** `components/AssetUploadGrid.tsx`，import 区加 `import { MAX_SHOTS_PER_SET } from '@/lib/shot-set-domain';`，`:103` 改为：

```tsx
            maxFiles={usage === 'scene_seed' ? 1 : MAX_SHOTS_PER_SET}
```

> **不要**改 `:19` 的 `usage` 联合类型、也**不要**动 `USAGE_LABELS` —— v3 曾计划让这个组件支持 `video_source`，v5 已确认不走这个组件。

**文件 2** `app/projects/[id]/page.tsx`，import 区加同一行：

| 行 | 原文 | 改为 |
|---|---|---|
| `:1097` | `上传后在宫格里按顺序选择 1-9 张，再创建分镜组。` | `` {`上传后在宫格里按顺序选择 1-${MAX_SHOTS_PER_SET} 张，再创建分镜组。`} `` |
| `:1114` | `maxSelection={9}` | `maxSelection={MAX_SHOTS_PER_SET}` |
| `:1189` | `已选择 {selectedImageIds.length}/9 张。…` | `已选择 {selectedImageIds.length}/{MAX_SHOTS_PER_SET} 张。…` |

**验收**：`npx tsc --noEmit && npm run lint`

---

#### 卡 C14 — 脚本生成画质降级软提示

**文件** `components/ScriptStrategyConfig.tsx`，import 区加 `import { SHOT_VISION_FULL_QUALITY_MAX } from '@/lib/shot-set-domain';`

组件函数体内（`hasShotSets` 附近）加：

```ts
  const selectedShotSet = shotSets.find((ss) => ss.id === selectedShotSetId);
  const shotVisionDowngraded =
    !!selectedShotSet && selectedShotSet.shotCount > SHOT_VISION_FULL_QUALITY_MAX;
```

`:226-238` 的真分支目前只有一个 `<select>`，**必须用 Fragment 包住**才能加兄弟节点：

```tsx
          {hasShotSets ? (
            <>
              <select
                value={selectedShotSetId}
                onChange={(e) => onShotSetIdChange(e.target.value)}
                className="input-field text-sm"
              >
                <option value="">-- 选择分镜组 --</option>
                {shotSets.map((ss) => (
                  <option key={ss.id} value={ss.id}>
                    {ss.name}（{ss.shotCount} 个分镜）
                  </option>
                ))}
              </select>
              {shotVisionDowngraded && (
                <p className="mt-2 rounded-lg bg-warn-tint px-2.5 py-2 text-xs text-warn">
                  这个分镜组有 {selectedShotSet?.shotCount} 张分镜，超过 {SHOT_VISION_FULL_QUALITY_MAX} 张后
                  脚本生成会自动压低每张图的画质来控制请求体积，AI 对细节的判断会变弱。
                  不影响生成，介意的话可以拆成更小的分镜组。
                </p>
              )}
            </>
          ) : (
```

> 自由素材工位没有张数上限（D18），图多时会命中这条提示 —— 这正是它存在的意义，**不要**改成只对普通分镜组显示。

**禁止**：不要改 `lib/script-vision-image.ts` 的常量，不要给脚本生成加拦截。

**验收**：`npx tsc --noEmit && npm run lint`

---

#### 卡 C15 — 第 4 步下拉：自由工位入口 + 删除

**文件** `components/VideoGenerationPanel.tsx`

**(1)** `:3` 的 react import 加 `useCallback`。

**(2)** `:88` 的 `availableSets` 类型加 `kind`，并新增删除态：

```ts
  const [availableSets, setAvailableSets] = useState<Array<{ id: string; name: string; shotCount: number; kind?: string }>>([]);
  const [deletingSet, setDeletingSet] = useState(false);
```

**(3)** `:221-234` 抽成可复用 callback：

```ts
  // Load shot sets for selector
  const loadAvailableSets = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/shot-sets`);
    const data = await res.json();
    return Array.isArray(data)
      ? data as Array<{ id: string; name: string; shotCount: number; kind?: string }>
      : [];
  }, [projectId]);

  useEffect(() => {
    if (shotSetId) return; // Already have a specific set
    let active = true;
    (async () => {
      try {
        const sets = await loadAvailableSets();
        if (active) setAvailableSets(sets);
      } catch { /* ignore */ }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [loadAvailableSets, shotSetId]);
```

**(4)** `handleSelectSet` 定义之后（约 `:295`）加：

```ts
  // 下拉里的「自由素材工位」用一个固定的哨兵值。真正的 shotSetId 要等
  // 后端 get-or-create 之后才知道(D15:一个项目一个)。
  const FREE_SET_OPTION = '__free__';

  const handleSelectFreeSet = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/free-shot-set`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert('打开自由素材工位失败：' + (data.error || `HTTP ${res.status}`)); return; }
      try { setAvailableSets(await loadAvailableSets()); } catch { /* ignore */ }
      handleSelectSet(String(data.id));
    } catch (err) {
      alert('打开自由素材工位失败：' + String(err));
    }
  };

  const selectedSetMeta = availableSets.find((set) => set.id === selectedSetId);
  const isFreeSet = selectedSetMeta?.kind === 'free';
  const canDeleteSelectedSet = !shotSetId && isFreeSet;
  const selectorLocked = creating || deletingSet;

  const handleDeleteFreeSet = async () => {
    if (!canDeleteSelectedSet || !selectedSetMeta || selectorLocked) return;
    // 记住目标 id:删除是异步的,期间用户可能已经切到别的组。
    const targetId = selectedSetId;
    const confirmed = window.confirm(
      `删除自由素材工位「${selectedSetMeta.name}」？\n\n` +
      '· 视频文件保留在本地磁盘上，不会被删除\n' +
      '· 已经登记到批量生产素材库的视频会继续保留\n' +
      '· 尚未登记的视频将无法再登记，也不再出现在第 5 步智能混剪里\n' +
      '· 这个操作不可撤销',
    );
    if (!confirmed) return;
    setDeletingSet(true);
    try {
      const res = await fetch(`/api/shot-sets/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // 还有任务没跑完时服务端返回 409(D14),把原因原样告诉用户。
        alert('删除失败：' + (data.error || `HTTP ${res.status}`));
        return;
      }
      // 只有当前仍停在被删的那个组时才清空选择,否则会把用户刚切过去的
      // 新组一起清掉。selectedSetIdRef 在 handleSelectSet 里是同步更新的。
      if (selectedSetIdRef.current === targetId) handleSelectSet('');
      try { setAvailableSets(await loadAvailableSets()); } catch { /* ignore */ }
    } catch (err) {
      alert('删除失败：' + String(err));
    } finally {
      setDeletingSet(false);
    }
  };
```

**(5)** `:653-662` 的 `shotSetSelector` 改为：

```tsx
  const storyboardSets = availableSets.filter((s) => s.kind !== 'free');
  const freeSet = availableSets.find((s) => s.kind === 'free');

  const shotSetSelector = !shotSetId ? (
    <div className="mb-4">
      <label className="label">选择分镜组</label>
      <div className="flex items-center gap-2">
        <select
          value={selectedSetId}
          onChange={(e) => {
            const value = e.target.value;
            if (value === FREE_SET_OPTION) { void handleSelectFreeSet(); return; }
            handleSelectSet(value);
          }}
          className="input-field text-sm"
          disabled={selectorLocked}
        >
          <option value="">-- 选择分镜组 --</option>
          {storyboardSets.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.shotCount} 张)</option>
          ))}
          {/* D15:一个项目一个自由工位。已经建过就直接列出来,没建过用哨兵值,
              选中时才 get-or-create。 */}
          {freeSet
            ? <option value={freeSet.id}>＋ 自由素材工位（{freeSet.shotCount} 张）</option>
            : <option value={FREE_SET_OPTION}>＋ 自由素材工位（直接传图做视频）</option>}
        </select>
        {canDeleteSelectedSet && (
          <button
            type="button"
            onClick={handleDeleteFreeSet}
            disabled={selectorLocked}
            className="icon-btn text-ink-tertiary hover:text-fail"
            title="删除这个自由素材工位"
            aria-label="删除这个自由素材工位"
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
      {availableSets.length === 0 && (
        <p className="mt-1 text-xs text-ink-tertiary">
          还没有分镜组。可以在分镜生成里创建，也可以直接选「自由素材工位」传图做视频。
        </p>
      )}
    </div>
  ) : null;
```

**禁止**：不要改 `handleSelectSet` 的既有逻辑（它负责释放尾帧草稿资源、清 per-shot 缓存、写 localStorage）。

**验收**：`npx tsc --noEmit && npm run lint`

---

#### 卡 C16 — 第 4 步工作区：原 UI 原样复用 + 首帧上传

这张卡**不是设计新 UI**。它只能在现有 `VideoGenerationPanel` 上增加数据入口，并严格满足 D22 / §2.11：原三栏、原运镜卡、原播放器、原结果列、原 class 全部保留。首帧上传交互照抄尾帧的既有实现（D19），不得再出现 A/B/C、引导页、胶片带或独立上传卡。

**文件** `components/VideoGenerationPanel.tsx`

**(1)** 新增首帧上传处理。**照抄 `handleTailFrameUpload`（`:416-468`）的结构**：先上传拿到 `imageId`，再挂到后端；任何一步失败都要把已上传的资源删掉，不留孤儿图片。

```ts
  const [headFrameBusy, setHeadFrameBusy] = useState(false);

  /**
   * 自由素材工位专用:上传一张图并作为新的一「张」加进工位。
   * 上传走和尾帧同一条 /api/upload,只是 usage 用 video_source(D6),
   * 这样它不会跑到第 2 步的原始分镜图宫格里去。
   */
  const handleAppendFreeShot = async (file: File) => {
    if (!effectiveSetId || headFrameBusy || creatingRef.current) return;
    setHeadFrameBusy(true);
    let uploadedId: string | null = null;
    try {
      const formData = new FormData();
      formData.append('files', file);
      formData.append('role', 'input');
      formData.append('projectId', projectId);
      formData.append('usage', 'video_source');
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json().catch(() => ({})) as {
        error?: string;
        files?: Array<{ id: string }>;
      };
      if (!uploadRes.ok) throw new Error(uploadData.error || `HTTP ${uploadRes.status}`);
      const uploaded = uploadData.files?.[0];
      if (!uploaded) throw new Error('上传接口没有返回图片');
      uploadedId = uploaded.id;

      const appendRes = await fetch(`/api/shot-sets/${encodeURIComponent(effectiveSetId)}/shots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId: uploaded.id }),
      });
      const appendData = await appendRes.json().catch(() => ({}));
      if (!appendRes.ok) throw new Error(appendData.error || `HTTP ${appendRes.status}`);

      // 重新拉一次分镜列表,新的一张会作为最后一个 tab 出现并自动选中。
      await loadShotsForSet(effectiveSetId);
      const newShotId = String(appendData.shotId);
      replaceSelectedShot(newShotId);
      replaceActiveMotionRows([makeEmptyRow()]);
    } catch (error) {
      // 挂载失败就把刚上传的图删掉,不留孤儿资源(和尾帧同一套处理)。
      if (uploadedId) {
        await fetch(`/api/images/${encodeURIComponent(uploadedId)}`, { method: 'DELETE' }).catch(() => undefined);
      }
      alert('添加图片失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setHeadFrameBusy(false);
    }
  };
```

> **执行前确认**：`loadShotsForSet`（`:248`）、`replaceSelectedShot`、`replaceActiveMotionRows`、`makeEmptyRow` 这四个在本文件里的确切名字与签名。不一致就停下汇报，**不要自己造新函数**。

**(2)** `:694-708` 的 shot tab 区改为：自由工位时 tab 文案换成「图 N」，并在末尾追加一个「＋ 添加图片」tab。这个 tab 继续使用 `shot-tab-item`，不得另造按钮体系。

```tsx
            {(safeShots.length > 0 || isFreeSet) && (
              <div className="shot-tab-row">
                {safeShots.map((shot) => (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => activate(shot.id)}
                    disabled={creating}
                    className={`shot-tab-item ${selectedShot === shot.id ? 'active' : ''}`}
                  >
                    {isFreeSet ? `图 ${shot.indexNum}` : `分镜 ${shot.indexNum}`}
                  </button>
                ))}
                {isFreeSet && (
                  <label
                    className={`shot-tab-item shot-tab-add ${headFrameBusy ? 'is-busy' : ''}`}
                    title="再加一张图"
                  >
                    <Icon name="plus" size={13} />
                    {headFrameBusy ? '上传中…' : '添加图片'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      disabled={headFrameBusy || creating}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = '';
                        if (file) void handleAppendFreeShot(file);
                      }}
                    />
                  </label>
                )}
              </div>
            )}
```

**(3)** 自由工位且一张图都没有时，**仍然渲染原来的左侧参数区和第一张 `video-motion-card` 骨架**。只把原 `video-frame-source` 换成上传格；尾帧格进入禁用提示。禁止使用旧版 `style={{ maxWidth: 280 }}` 的孤立上传卡，也禁止把左栏替换成大面积居中空态。

在 `:712` 的 `{selectedShot && (` 之前加一个空工位分支，DOM 层级必须如下（可按执行时真实变量名调整数据绑定，但 class、顺序和文案不得改）：

```tsx
          {isFreeSet && safeShots.length === 0 && (
            <div className="panel-scroll-area">
              <div className="space-y-3">
                <div className="video-motion-card">
                  <span className="video-motion-label">描述 1</span>

                  <div className="video-frame-pair" data-testid="video-frame-pair">
                    <label
                      className={`video-frame-tile video-frame-empty ${headFrameBusy ? 'is-busy' : ''}`}
                      onDragOver={(event) => {
                        if (!headFrameBusy && !creating) event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const file = event.dataTransfer.files?.[0];
                        if (file && !headFrameBusy && !creating) void handleAppendFreeShot(file);
                      }}
                    >
                      <span className="video-frame-empty-icon">
                        <Icon name="image" size={25} />
                        <span><Icon name="plus" size={10} /></span>
                      </span>
                      <strong>{headFrameBusy ? '上传中…' : '添加首帧图'}</strong>
                      <small>点击或拖入</small>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="sr-only"
                        disabled={headFrameBusy || creating}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          if (file) void handleAppendFreeShot(file);
                        }}
                      />
                    </label>

                    <div className="video-frame-bridge" aria-hidden="true">
                      <Icon name="chevron-right" size={18} />
                    </div>

                    <div className="video-frame-tile video-frame-empty is-disabled">
                      <span className="video-frame-empty-icon"><Icon name="image" size={25} /></span>
                      <strong>先添加首帧</strong>
                      <small>添加后可选</small>
                    </div>
                  </div>

                  {/* 这三块继续占据原位置；没有真实 shot 前禁用，不提交草稿。 */}
                  <select className="input-field video-control" disabled>
                    <option>选择视频供应商</option>
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <select className="input-field video-control" disabled>
                      <option>模板（可选）</option>
                    </select>
                    <input className="input-field video-control text-center" value={5} disabled readOnly />
                  </div>
                  <textarea
                    className="input-field video-prompt-field"
                    placeholder="运镜描述（提示词）"
                    disabled
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button className="btn-secondary btn-sm w-full video-add-action" disabled>
                  <Icon name="plus" size={12} /> 添加描述
                </button>
                {/* 并发数继续复用现有 generation-label / generation-control / generation-helper。 */}
                <div>
                  <label className="label generation-label">并发数</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={videoConcurrency}
                    onChange={(event) => handleVideoConcurrencyChange(Number(event.target.value))}
                    className="input-field generation-control generation-number"
                  />
                  <p className="generation-helper">失败或限流时调回 1。</p>
                </div>
                <button className="btn-primary btn-sm w-full video-create-action" disabled>
                  生成 0 条视频
                </button>
              </div>
            </div>
          )}
```

> 拖拽进入时要复用尾帧的 `video-frame-drop-overlay` 反馈；上面只写最小事件骨架，执行时应直接复用同文件已有的 drag state/helper，**不要为首帧发明另一套拖拽视觉**。

中栏和右栏不加新组件：继续用现有 `VideoGenerationPreview` / `VideoGenerationResults`，分别显示「添加首帧图后开始生成」和既有 `result-empty`。上传第一张图成功后，立即回到正常 `selectedShot` 分支，首帧使用现有只读 `video-frame-source`。

**(3.5)** 删掉这张图（D21）。

判定放前端算即可 —— `videoJobs` 已经是整个工位的任务列表，`VideoJob` 接口（`:48`）带 `shotId`：

```ts
  // D21:只有 failed / canceled 不算数。和服务端 DISCARDABLE_VIDEO_JOB_STATUSES
  // 必须保持一致;服务端仍会再判一次,这里只是把按钮先禁掉。
  const DISCARDABLE_JOB_STATUSES = new Set(['failed', 'canceled']);
  const canDeleteShot = (shotId: string) =>
    isFreeSet && !videoJobs.some((job) => job.shotId === shotId && !DISCARDABLE_JOB_STATUSES.has(job.status));

  const [deletingShot, setDeletingShot] = useState(false);

  const handleDeleteFreeShot = async (shotId: string) => {
    if (!effectiveSetId || !canDeleteShot(shotId) || deletingShot || creatingRef.current) return;
    if (!window.confirm('删掉这张图？它下面还没生成过视频，删了不影响其他图。')) return;
    setDeletingShot(true);
    try {
      const res = await fetch(
        `/api/shot-sets/${encodeURIComponent(effectiveSetId)}/shots/${encodeURIComponent(shotId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 前端算完到点下去这段时间里任务可能已经跑起来了,服务端会返回 409。
        alert('删除失败：' + (data.error || `HTTP ${res.status}`));
        return;
      }
      // best-effort 清掉上传的图片资源。还被别处引用时接口会返回 409,忽略即可
      // —— 和尾帧的 deleteTailFrameAsset 同一套处理。
      if (data.sourceImageId) {
        await fetch(`/api/images/${encodeURIComponent(String(data.sourceImageId))}`, { method: 'DELETE' })
          .catch(() => undefined);
      }
      perShotMotionCache.current.delete(shotId);
      await loadShotsForSet(effectiveSetId);
    } catch (err) {
      alert('删除失败：' + String(err));
    } finally {
      setDeletingShot(false);
    }
  };
```

> `loadShotsForSet`（`:248`）会重新拉一遍分镜并把选中项落到第一张，所以删掉当前选中的那张不会留下空指向。**执行前确认这一点**——如果它的行为不是这样，停下汇报，不要自己改 `loadShotsForSet`。

UI 放在 tab 行下面，**不要塞进 tab 里**（`shot-tab-item` 本身是 `<button>`，往里嵌按钮是非法 HTML）。在 `panel-col-header` 内、tab 行之后加：

```tsx
            {isFreeSet && selectedShot && (
              <div className="free-shot-actions">
                <span>当前：图 {selectedShotData?.indexNum}</span>
                <button
                  type="button"
                  onClick={() => void handleDeleteFreeShot(selectedShot)}
                  disabled={!canDeleteShot(selectedShot) || deletingShot || creating}
                  title={canDeleteShot(selectedShot)
                    ? '删掉这张图'
                    : '这张图已经生成过视频了，不能删除'}
                  className="free-shot-delete"
                >
                  <Icon name="trash" size={12} /> {deletingShot ? '删除中…' : '删掉这张图'}
                </button>
              </div>
            )}
```

**(4)** 新增样式。`app/globals.css` 里 `.shot-tab-item`（`:460`）之后加：

```css
  .shot-tab-add { flex: 0 0 auto; min-width: 0; display: inline-flex; align-items: center; gap: 4px; color: var(--color-accent); cursor: pointer; }
  .shot-tab-add.is-busy { opacity: .55; cursor: progress; }
  .free-shot-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--color-ink-tertiary); }
  .free-shot-delete { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; padding: 4px 6px; border-radius: 8px; color: var(--color-ink-tertiary); font-family: inherit; font-size: 12px; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .free-shot-delete:hover:not(:disabled) { background: var(--color-fail-tint); color: var(--color-fail); }
  .free-shot-delete:disabled { opacity: .4; cursor: not-allowed; }
```

**明确不做**：
- **不新增**自由工位专属的页面头、说明栏、方案切换、引导步骤、胶片带、素材宫格、浮层状态卡或播放器。C16 只能使用现有 `video-*` / `result-*` / `shot-tab-*` 结构和 class。
- **不改** `video-frame-source`（`:731-748`）的只读渲染。这是 **D20**（用户已确认）：自由工位的首帧由 shot 的 `sourceImageId` 决定，通过既有的 `selectedShotData.imageUrl` 正常显示；**换图 = 加一张新的**（tab 多一个），不是原地替换。`shots.sourceImageId` 保持不可变，因此不需要任何更新路径，已提交任务的溯源也不会被打断。
  - 传错图的撤销路径由 **D21** 的「删掉这张图」覆盖（本卡 (3.5)）：还没生成过就能删干净，生成过了就锁住。两条合起来才是完整的：**加错了能删，生成过了只能加新的。**
- **不重排 `indexNum`**。删掉中间某张后号码留空（1、3、4…）。重排会让用户眼前的「图 3」突然变成「图 2」，而已存在的 `video_jobs` 也没有 `indexNum` 可跟。C5 有专门一条测试钉住这个行为。
- **不改**尾帧、运镜、供应商、时长、结果列表、预览列的任何代码。

**验收**：`npx tsc --noEmit && npm run lint`，并执行 §5.4 的同视口视觉回归；只跑静态检查不能判定 C16 完成。

---

## 4. 明确不做的事（禁止清单）

| 不做 | 原因 |
|---|---|
| 新写自由素材的弹窗 / 槽位 / 运镜 UI | v5 / D22：用户已确认现有第 4 步的逐像复刻，必须直接复用 |
| 增加 A/B/C、引导步骤、胶片带、独立上传页、状态悬浮窗或自由工位专属播放器 | 这些方案已被用户明确否决；已确认样机没有它们 |
| 改三栏顺序、宽度逻辑、断点或把右侧结果搬到别处 | 现有 `video-workspace` 是验收合同，不是待优化对象 |
| 为自由工位另造配色、字体、圆角、阴影或卡片 class | 必须复用 `app/globals.css` 现有视觉令牌和 `video-*` / `result-*` class |
| 改 `AssetUploadGrid` 的 `usage` 联合类型和 `USAGE_LABELS` | v5 不走这个组件，只留 `maxFiles` 常量改动 |
| 改 `video-frame-source` 的只读渲染 | C16 已说明：换图 = 加新的一张，不原地替换 |
| 改尾帧 / 运镜 / 结果 / 预览的任何代码 | 结构已经对上，零改动 |
| 改 `lib/final-edit/mixcut-context.ts` | 自由工位自动出现在第 5 步 |
| 改 `lib/batch-production/**` | 批量生产全项目扫成功视频，零改动 |
| 删组时连带清理 `batch_assets` | D13：已登记的保留，跨模块删用户数据风险更大 |
| 改 `app/api/shot-sets/[id]/video-jobs/batch/route.ts` | `latestGeneratedImageId \|\| sourceImageId` 已兼容 |
| 改 `lib/db.ts` 的 `CREATE TABLE shot_sets` | 本仓惯例：新列只走迁移流 |
| 动 `shot_sets.status` 的既有 CHECK | 与本需求无关，改它需要重建表 |
| 改 `lib/script-vision-image.ts` 常量 | 4MB 预算是上游模型限制 |
| 改 `app/api/projects/route.ts:103` 的 `genCount` | 那是场景图生成张数 |
| 修「删组 → 已完成视频变孤儿」 | D11：既有行为，另开单子（§7） |
| 给自由工位加张数上限 | D18：用户明确要无上限 |
| 给第 3 步过滤自由工位 | D8 决策 |
| 动 `video_providers` 表 / `video-provider-schema.ts` | 与本需求无关，有独立备份门禁 |

---

## 5. 验收清单

### 5.1 静态检查

```bash
npx tsc --noEmit
npm run lint
```

### 5.2 自动测试

```bash
node scripts/shot-set-domain.test.ts     # C3
node scripts/shot-set-service.test.ts    # C5
node scripts/db-migrations.test.ts       # C1
```

自动覆盖范围：

| 场景 | 覆盖方式 |
|---|---|
| 20/21 边界、去重先于计数、脏值过滤 | **自动** `shot-set-domain` |
| **缺省 `shotImageIds`（新建空项目回归）** | **自动** `shot-set-domain` |
| 自由工位不限张数（D18） | **自动** `shot-set-domain` + `shot-set-service` |
| 非法 kind → 400 且不留残留 | **自动** `shot-set-service` |
| 跨项目图片 → 400（建组和追加两条路径） | **自动** `shot-set-service` |
| 自由工位落 `approved`、可先建空的 | **自动** `shot-set-service` |
| 自由工位单例（D15）、跨项目各一个、项目不存在 404 | **自动** `shot-set-service` |
| 追加图片：indexNum 递增、允许重复图、拒绝普通组、404 | **自动** `shot-set-service` |
| 删单张图（D21）：无任务可删、只有 failed/canceled 可删、succeeded 与 4 种非终态各自 409、拒绝普通组、跨工位 404 | **自动** `shot-set-service` |
| 删单张后 indexNum 不重排、后续追加不填空缺 | **自动** `shot-set-service` |
| 非终态任务 → 409 且分镜组原封不动（4 种状态） | **自动** `shot-set-service` |
| 新列、默认值回填、CHECK 生效、迁移幂等 | **自动** `db-migrations` |
| 路由状态码映射、apply-scene 门禁 | **接口手测**（§5.3） |
| UI 交互、混剪与批量登记、并发删除 | **手工 E2E**（§5.4） |

最后两行走手测，是因为本仓没有 Next.js route handler 的测试夹具（现有 `scripts/*.test.*` 只测纯函数或内存 SQLite）。搭这套夹具是独立基建任务，**需要的话单独提出**，不要顺手塞进本次 feature。

### 5.3 接口手测（`npm run dev` 起着；`<PID>` / `<IMG*>` 换成真实 id）

```bash
# 1. 非法 kind → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/projects/<PID>/shot-sets \
  -H 'Content-Type: application/json' -d '{"name":"x","shotImageIds":["<IMG1>"],"kind":"bogus"}'   # 400

# 2. 自由工位单例：连调两次必须返回同一个 id，第二次 created=false
curl -s -X POST http://localhost:3000/api/projects/<PID>/free-shot-set
curl -s -X POST http://localhost:3000/api/projects/<PID>/free-shot-set

# 3. 追加图片
curl -s -X POST http://localhost:3000/api/shot-sets/<自由工位ID>/shots \
  -H 'Content-Type: application/json' -d '{"imageId":"<IMG1>"}'                                     # {shotId, indexNum}

# 3.5 删掉一张还没生成过的图 → 200 且回传 sourceImageId
curl -s -X DELETE http://localhost:3000/api/shot-sets/<自由工位ID>/shots/<干净的SHOT_ID>

# 3.6 D21：删一张已经生成过视频的图 → 409
curl -s -X DELETE http://localhost:3000/api/shot-sets/<自由工位ID>/shots/<生成过的SHOT_ID>

# 4. 往普通分镜组追加 → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/shot-sets/<普通组ID>/shots \
  -H 'Content-Type: application/json' -d '{"imageId":"<IMG1>"}'                                     # 400

# 5. 跨项目图片 → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/projects/<PID>/shot-sets \
  -H 'Content-Type: application/json' -d '{"name":"x","shotImageIds":["<别的项目的IMG>"]}'          # 400

# 6. 场景生成拒绝自由工位 → 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/shot-sets/<自由工位ID>/apply-scene \
  -H 'Content-Type: application/json' -d '{"sceneReferenceId":"<REF>","prompt":"x"}'                # 400

# 7. 删除不存在的组 → 404
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://localhost:3000/api/shot-sets/does-not-exist  # 404

# 8. D14：有活跃任务时删除 → 409
curl -s -X DELETE http://localhost:3000/api/shot-sets/<有活跃任务的组ID>                            # 409 + 中文提示
```

### 5.4 手动 E2E（必须全部通过）

**新建项目回归（最容易炸，第一个跑）**

- [ ] 新建项目页**不选任何分镜图**，能正常创建成功（不是 400）
- [ ] 选了分镜图的完整流程仍正常
- [ ] 该路径传含重复 id 的列表会被去重；传 21 张会被拒

**张数上限**

- [ ] 第 2 步能一次选中 20 张并成功建组（第 10 张不再被卡住）
- [ ] 选到第 21 张时点击无反应
- [ ] 一次拖拽 20 个文件上传全部成功（改前会弹「最多上传 9 张图片」并整批拒绝）
- [ ] 20 张的组能正常「应用场景参考图」，生成 20 个图片任务并跑完
- [ ] 第 3 步选中 11 张以上的组出现黄色降质提示；选 10 张以内提示消失

**自由素材工位**

- [ ] 第 4 步下拉最后一条是「＋ 自由素材工位（直接传图做视频）」
- [ ] 选中它 → **仍是原三栏视频工作区**，不能跳到独立上传页或大面积居中空态
- [ ] 空工位左栏仍显示原 `video-motion-card` 骨架：`描述 1`、首尾帧对、供应商、模板/时长、运镜描述、添加描述、并发数和生成按钮都在原位置
- [ ] 空工位首帧格写「添加首帧图 / 点击或拖入」，尾帧格写「先添加首帧 / 添加后可选」；生成按钮为「生成 0 条视频」且禁用
- [ ] 空工位中栏使用原预览列和禁用播放器控制条；右栏使用原 `result-empty`，没有新增播放器或结果布局
- [ ] 传第一张图 → 出现「图 1」tab 并自动选中，首帧格子显示这张图
- [ ] 上传成功后的首帧仍是只读 `video-frame-source`，没有「更换」按钮；换图只能点「添加图片」新建一个 tab（D20）
- [ ] 首帧右边的**尾帧格子照常可用**（可灵 3.0 / Seedance 下可上传，其他模型显示"暂不支持尾帧"）
- [ ] **一张图挂多条运镜**：加第二条描述，两条能各自选供应商/时长并并行提交
- [ ] shot tab 末尾有「＋ 添加图片」，点它能继续加第 2、3、…张，**没有张数上限**
- [ ] **D21 能删**：传错一张、还没点生成 → tab 下方「删掉这张图」可点，删完 tab 消失
- [ ] **D21 锁死**：这张图生成过视频后，「删掉这张图」变灰，悬停提示「已经生成过视频了，不能删除」
- [ ] **D21 只有失败**：这张图的任务全部失败 → 仍然能删（配错供应商试一次不应该把图锁死）
- [ ] **D21 竞态**：按钮可点时，另开一个标签页把任务跑起来，再点删除 → 弹服务端 409 的中文提示，图还在
- [ ] 删掉中间某张后，剩下的 tab **号码留空**（图 1、图 3），不重排
- [ ] 删完再「＋ 添加图片」，新的一张接着最大号往后排，不填回空缺
- [ ] 删掉一张干净的图后，它的图片资源也被清掉（第 2 步宫格里本来就看不到它，用 `SELECT COUNT(*) FROM image_assets WHERE usage='video_source'` 核对数量减少）
- [ ] 同一张图被追加了两次时，删掉其中一个 tab，另一个 tab 的图**仍然正常显示**（图片资源被 409 挡住没删，符合预期）
- [ ] 上传中「＋ 添加图片」显示"上传中…"且不可重复点
- [ ] 视频跑完后在右侧结果区和预览列**表现和普通分镜组完全一致**
- [ ] 再次打开下拉，那一条变成「＋ 自由素材工位（N 张）」，且选中它回到同一个工位
- [ ] **单例验证**：反复在自由工位和普通分镜组之间切换，不会建出第二个自由工位
- [ ] **第 2 步**：分镜组列表**看不到**自由工位（D7）
- [ ] **第 3 步**：脚本生成的下拉里**能看到**自由工位（D8）；图多时出现降质提示
- [ ] **第 5 步**：混剪的分镜组列表能看到它，且能取到它的成功视频
- [ ] **批量生产**：它的成功视频出现在项目素材库里
- [ ] 自由素材图片**不出现**在第 2 步的「原始分镜图」宫格里（D6）
- [ ] **上传失败清理**：断网后点「添加图片」，报错，且不留下孤儿图片（第 2 步宫格里看不到多出来的图）

**D22 视觉回归（C16 完成门禁）**

- [ ] 在 `1424 × 803 CSS px` 桌面视口分别截取「空工位」和「1 张图 + 至少 3 条结果」两种状态
- [ ] 与 `/free-material-video-prototype` 同状态并排比较；参考工作区为 `1338 × 720`，三栏约 `420 / 626 / 260`，间距 `16`
- [ ] 左栏、中栏、右栏顺序和现有生产页面一致；没有 A/B/C、引导步骤、胶片带、页面说明 banner、素材宫格、悬浮状态卡
- [ ] 字体、配色、圆角、阴影、控件高度全部来自现有 `app/globals.css`；没有自由工位专属视觉体系
- [ ] 中栏播放器控制条、右栏 `result-card` 的激活/播放/下载状态与普通分镜组逐项一致
- [ ] 浏览器控制台无 error；上传、添加描述、生成、切换结果、再添加一张图五个主交互均实际操作通过
- [ ] 把截图路径、视口、实测三栏宽度、交互结果和最终 `passed / blocked` 写入本次交付记录；没有浏览器证据不能宣称 C16 完成

**删除（D11 / D13 / D14）**

- [ ] 选中自由工位后下拉旁出现删除按钮；选中普通分镜组时**不出现**
- [ ] 确认框完整列出四条后果
- [ ] **有任务在跑时删除 → 弹 409 的中文提示，工位仍在**
- [ ] 任务全部跑完后再删 → 成功
- [ ] 删除期间下拉和删除按钮都禁用
- [ ] **并发用例**：点删除后立刻切到另一个组，删除完成后**不能**把新选的组清空
- [ ] 删除后 localStorage 记忆被清掉，刷新页面不会再选回它
- [ ] 删除后视频文件仍在 `storage/videos/` 下
- [ ] **D13-A**：删除前先打开批量准备区完成登记 → 删除后素材**仍在**批量素材库里
- [ ] **D13-B**：删除前未登记 → 之后打开批量准备区，该视频**不会**出现（且不报错）
- [ ] 删掉之后再选下拉里的「＋ 自由素材工位」→ 能重新建一个空的
- [ ] **第 2 步的普通分镜组**：有任务在跑时删除 → 也会弹 409（D14 的行为变更）

### 5.5 回归重点

- [ ] 既有分镜组的第 2 → 3 → 4 → 5 步全链路无变化
- [ ] 普通分镜组的 shot tab 文案仍是「分镜 N」，**没有**多出「＋ 添加图片」
- [ ] 既有项目的导出 ZIP 正常
- [ ] 第 4 步的 localStorage 记忆（`creative-studio:video-shot-set:<projectId>`）在自由工位上也能正确恢复
- [ ] 用一个**改动前**的项目验证：分镜组数量、名称、状态与改动前完全一致

---

## 6. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `ALTER TABLE` 在大 DB 上耗时 | 首次启动变慢 | 实测：带 DEFAULT 的 ADD COLUMN 是元数据操作，不重写行（§2.8） |
| CHECK 挡住历史脏数据 | 迁移失败 | `kind` 是新列，历史行全部走 DEFAULT；C1 的测试验证回填 |
| **D14 改变了既有删除行为** | 删有任务在跑的普通分镜组会被 409 挡住 | 有意为之（防金钱损失）；错误信息是中文可操作提示；§1.2 有收窄开关 |
| 自由工位图片太多 → shot tab 横向滚动很长 | 体验 | `.shot-tab-row` 本来就是 `overflow-x: auto`（`globals.css:459`），9 张时已经在滚。先不动，实际用着难受再单独处理 |
| 自由工位图片太多 → 第 3 步画质降级 | 脚本质量 | C14 的软提示；D18 明确不拦截 |
| 删组后未登记的视频静默缺失 | 数据可见性 | D13 + 确认框四条后果；根因另开单子（§7） |
| 上传成功但追加失败 → 孤儿图片 | 存储 | C16 照抄尾帧的失败清理；E2E 有专门一条 |

**回滚**：改动全部是加法。`kind` 有默认值且 CHECK 只约束新写入，即使代码回滚：旧代码 `SELECT ss.*` 多带一个字段不报错；旧代码 `INSERT` 不指定 `kind` 走 DEFAULT `'storyboard'`，满足 CHECK。**数据库不需要回滚。**

---

## 7. 需要另开的后续单子

执行完 C16 后请登记：

> **「删除分镜组会让已生成但未登记的视频静默退出混剪与批量生产」**
>
> 现状：`app/api/shot-sets/[id]/route.ts` 硬删，配合 `lib/db.ts:293-294` 的 `ON DELETE SET NULL`，被删组的 `video_jobs.shotSetId` 变 NULL。此后 `lib/final-edit/mixcut-context.ts:252` 取不到；`lib/batch-production/media-catalog.ts:316` 抛「视频任务没有分镜组归属」并被 `prepare.ts` 降级成 warning，用户看不到提示。
> 注意分叉：**删除前已登记**进 `batch_assets` 的素材会继续保留（`verifyAssetSources` 只重验磁盘文件，不重验 shotSetId），**未登记**的则永远登记不上。
>
> 影响范围：**所有分镜组**，不限自由素材工位。本次 feature 之前就存在。
> （进行中任务的部分已由 D14 的 409 挡住，不在此单子内。）
>
> 候选方案：(a) 逻辑归档，加 `archivedAt` 保留 `shotSetId`；(b) 删除前提供「把视频转移到另一个分镜组」；(c) 维持现状但统一在删除确认框明示（本次已对自由工位这样做）。

---

## 8. 提交建议

```
C1   feat: add shot_sets.kind with migration coverage
C2   chore: add a shared shot-set domain module
C3   test: cover the shot-set domain rules
C4   refactor: move shot-set rules into a service layer
C5   test: cover the shot-set service against in-memory sqlite
C6   refactor: create shot sets through the service layer
C7   fix: apply shot-set limits to the project-creation path
C8   fix: block shot-set deletion while video jobs are still active
C9   fix: reject scene generation for free-material sets
C10  feat: allow video_source uploads
C11  feat: add free-workstation, append-shot and delete-shot endpoints
C12  feat: raise the shot-set limit and hide free sets in step 2
C13  feat: raise the shot-set limit in the upload grid and project page
C14  feat: warn when script generation will downscale storyboard images
C15  feat: add the free-workstation entry to the step 4 selector
C16  feat: let the free workstation add and drop head-frame images
```
