# 批量混剪实施计划

- 日期：2026-08-01
- 分支：`mixcut01`
- 产品依据：[批量混剪与桌面化 V1 PRD](../specs/2026-07-31-batch-mixcut-desktop-prd.md)
- 技术依据：[批量混剪与桌面化技术路线图](./2026-07-31-batch-mixcut-desktop-wayfinder/map.md)
- 当前边界：先实施不依赖腾讯云的批量核心；公司媒体传输、真实公司链路和安装包保留为后续门禁。

## 给非技术人员的执行顺序

1. 先给数据库加安全备份和独立批量升级门禁。
2. 再建立项目素材库与项目脚本目录。
3. 建立批次、脚本快照和用户要求的准确成片数量。
4. 加入持久任务调度、真实进度、暂停、恢复和失败重试。
5. 接入联合分配、代理、LUT、卡片工作区和正式导出。
6. 公司侧信息明确后，补齐 LiteLLM 健康检查和腾讯云媒体传输 Adapter。
7. 核心稳定后再做 Electron 与 macOS／Windows 安装包。

每一阶段结束都停下来报告：改了什么、验证到哪一层、还缺什么。未经用户另行授权，不调用真实供应商、不上传项目派生媒体、不推送远端分支。

## Phase 0：安全数据地基

### 0.1 批量 schema 升级门禁（已完成）

- 新建独立 `BatchProduction` schema Module，不修改已发布的核心迁移和 `final_edit_*` 迁移。
- 没有待执行批量迁移时直接返回，不生成无意义备份。
- 首次批量迁移前使用 SQLite Online Backup 生成一致快照。
- 独立打开备份，验证完整性、外键、大小和 SHA-256，再发布备份 manifest。
- 每个批量 migration 在事务中执行并记录版本；失败返回兼容模式，不影响旧功能。
- 第一版只建立最小批次身份表，不接 UI、不启动任务。

验收 seam：

```text
ensureBatchSchemaReady(db, backupRoot) -> current | ready | compatibility_only
```

聚焦测试必须证明：先备份再迁移、重复调用幂等、无效备份不迁移、迁移失败不留下半张表。

### 0.2 启动锁、恢复入口与批量可用状态（已完成）

- 增加跨进程升级锁。
- 让批量 API 等待升级门禁并返回明确可用状态。
- 持久记录备份、迁移、验证、失败与兼容模式结果，供任务详情审计。
- 补磁盘不足、进程崩溃和第二实例故障注入，并在真实旧数据库副本上验证旧项目、设置、密钥、脚本和成片不变。
- 把当前 gateway 引入的旧表重建纳入一致备份与旧库回归审计。

本阶段的恢复入口只列出并重新校验可恢复备份，不在工作台运行时覆盖主数据库。真正恢复仍要求完全退出工作台、再次确认备份和版本，再由后续桌面运行壳提供明确动作；这条安全限制不能由普通 API 绕过。

### 0.3 完整批量领域表（已完成）

- 按已确认模型逐个加入项目素材、分析版本、项目脚本版本、批次版本、脚本快照、成片计划、成片版本、任务、尝试和产物来源。
- 每次只增加一个可由公开 Interface 使用的垂直切片，不一次性建立无法验证的大表集合。
- 共追加 migration v2–v9，领域表全部带 `batch_` 前缀，与单条混剪 `final_edit_*` 隔离：
  - v2 `batch_assets` + `batch_asset_analysis`（素材身份不依赖路径，分析版本可跨批次复用）
  - v3 批次表扩展列 + `batch_production_versions` + `batch_asset_pool_items`（整体输入快照、素材池锁定分析版本）
  - v4 `batch_scripts` + `batch_script_snapshots`（项目脚本稳定身份、开跑后快照不漂移）
  - v5 `batch_output_plans` + `batch_output_versions`（份数决定 N 条计划、单条调整形成新成片版本）
  - v6 `batch_tasks` + `batch_task_attempts`（重试只增加任务尝试）
  - v7 `batch_artifacts` + 成片计划当前成片指向（产物追加保存、最新导出自动成为当前成片）
  - v8 重建 `batch_artifacts` 约束（同一成片版本可按不同路径反复导出，批次/版本/计划谱系受删除保护）
  - v9 批次逻辑删除 + 批次版本 `inputState`/`frozenAt` + 外部文案批次版本所有权（首次开跑后旧版本不可逆冻结，修改整体输入必须新建版本；外部文案显式保存到项目时复制成新项目脚本）
- 公开领域接口：`lib/batch-production/{assets,versions,scripts,plans,tasks,artifacts}.ts`，每个切片均有独立聚焦测试。
- 真实旧库在线备份副本升级核对：33 张旧表、4567 行数据不变。

### Phase A 项目输入（已完成）

- 脚本目录 `ProjectScriptCatalog`：`syncProjectScripts` 以 `script_drafts.id` 为稳定来源身份，保存正文、普通标题、结构化封面标题、shotSetId 与内容修订哈希；缺少结构化标题的旧 V2 草稿复用 `splitCoverTitle` 确定性拆分。v11 增加脚本/快照元数据，v12 增加来源可用性和目录同步所有权；可正向证明来自目录同步的上游草稿删除、失效或脱离项目分镜组后退出准备区，独立项目脚本和历史快照不被删除。升级前已删除且没有修订身份的旧同步行无法与独立项目脚本可靠区分，因此保守保留。
- 素材库 `ProjectMediaCatalog`：v10 来源表 `batch_asset_sources` 是多来源权威数据（module4/managed/linked，各自独立健康状态）；`media-catalog.ts` 提供模块 4 登记（只信 `video_jobs` 记录：任务存在、成功状态、真实 shotSetId 与产物路径，拒绝跨项目/伪造路径）、链接来源登记（永不删除用户原文件）、托管复制（目录由 `dataRoot()` 推导，目标已存在重新核验完整 SHA-256）、来源健康核验（按可判别 kind 结构解析路径，旧 v10 托管位置按 `dataRoot()/storage/batch-media` 根恢复）与链接重新定位（完整指纹核验，内容不同拒绝替换）。完整 SHA-256 确认内容身份，同一内容多来源只建一份素材；记录级 `batch_assets.sourceKind/locationJson` 只由首个来源写入，新来源不得覆盖。
- 批量准备区入口：`components/mixcut/MixcutWorkspace.tsx` 在项目第五步提供“单条精准混剪/批量生产”模式切换；批量模式先等待共享 readiness gate，再调用 `GET /api/batch-production/prepare?projectId=…` 自动同步脚本、登记成功视频、核验来源健康并展示项目输入。单条失败只记 warning；Phase A 不建立批次快照、不开始生产。
- 门禁验证：项目隔离（项目 2 的素材/脚本不进项目 1）、原文件安全（链接素材登记永不删除原文件）、脚本稳定身份（同一来源重复同步只保留一份）、来源聚合（全部离线素材才不可用，任一恢复即可用）。

### Phase B 批次快照（已完成）

> 范围说明：Phase 0.3 交接停点后，Phase B 由用户明确授权（“继续做 phase B”）后实施；批次 API 全部通过 readiness 门禁，旧库/升级锁失败/兼容模式下统一返回 503，不得绕过备份、锁、审计与迁移。

- `lib/batch-production/batch-flow.ts` 的 `createBatchSnapshot`：一次调用确认可检查的 draft 整体输入——脚本选择与份数、素材池（锁定素材与分析版本）、成片计划（份数总和 = N 张卡片），整个确认过程在单个事务内完成，任一失败全部回滚；完全相同的整体输入幂等复用版本与稳定计划，输入变化才形成新批次版本。
- 版本语义：未确认且没有选择的 draft 版本可直接复用；已有整体输入时，只有脚本、份数、素材、分析版本或默认设置发生变化才形成新版本（旧版本及其结果永远保留）。开跑后的相同输入仍幂等，修改整体输入才新建 draft 版本，旧版本保持冻结。
- `startBatchProduction` 开跑：在同一事务内先同步并读取最新项目脚本，刷新 draft 快照，再校验至少一份素材以及逐脚本和全版本精确 `N` 条计划；校验通过后批次进入 running，当前版本永久冻结（`inputState = 'frozen'`）。
- 批次 API：`POST /api/batch-production/batches`（创建）、`GET /api/batch-production/batches?projectId=`（列表）、`GET /api/batch-production/batches/[id]?projectId=`（详情：版本/快照/素材池/计划）、`POST /api/batch-production/batches/[id]/snapshot`（确认输入，返回计划总数）、`PUT /api/batch-production/batches/[id]/start`（开跑）。
- 不变量验证：A 2 份 + B 1 份 = 3 张卡片；相同整体输入重复确认不增加版本或计划；失败重试只增加同一任务的 attempt，不增加版本或第 N+1 张卡；开跑时固定最新正文/标题/元数据，冻结后的上游更新不改写快照；跨项目脚本/素材/批次全部拒绝；素材写入中途失败会回滚版本指针和全部子记录。
- 第五步用户链路：批量准备区可创建/选择批次、勾选多份脚本并分别设置份数、明确选择至少一份已有分析版本的素材、确认 draft 输入、查看精确 N 张成片卡片并开始生产；刷新后从批次详情恢复选择与卡片。
### Phase C 持久调度（已完成本地实现与自动化验收）

> 范围说明：Phase C 由用户明确授权（“现在执行phase C”）后实施；调度器只接管批量生产任务，模块 1–4 的图片/视频队列与单条混剪 final_edit 队列不在本轮迁移范围。本阶段已通过 Codex 独立代码复审、批量专项测试、全仓非浏览器测试、TypeScript、lint 与生产构建；浏览器测试因本次执行环境禁止监听本地端口而未运行，不等同于浏览器验收通过。

- v13 迁移：任务尝试重建（status 增加 `interrupted`，新增 `claimedBy`/`leaseExpiresAt`/`heartbeatAt`/`adapterVersion`/`remoteTaskId`）；任务增加幂等 `requestKey` 与 `expectedState`；批次增加 `controlState`（running/paused/stopped）。
- `lib/batch-production/scheduler.ts`：原子领取（单事务：条件更新 + 创建带有限期租约的尝试，多 worker 竞争只有一个成功）、续租、完成回调（持有者+租约+持久控制状态三重校验，过期或停止后的迟到成功均拒绝）、过期/启动恢复（尝试 → interrupted；运行批次任务回 queued，暂停批次保持 paused，停止批次收敛 cancelled）、失败重试（只增加任务尝试）；批次暂停/继续/停止（持久化期望状态，停止保留成功结果且未完成任务进入不可逆取消终态）。
- `lib/batch-production/executors.ts`：统一任务执行 Adapter 接口与真实进度报告（阶段/完成数/0–1 百分比，不可测阶段 percent=null 不伪造）；素材分析执行器用 ffprobe 真实探测并写入分析版本。
- `lib/batch-production/runner.ts`：`runPendingOnce` 领取-执行-落账单轮循环（并发上限、独立心跳、进度节流落库、租约丢失安全恢复、未注册执行器明确失败）；用户停止中止为 cancelled，应用关闭中止为可恢复 queued。`startBatchScheduler` 是进程内单例，`stop()` 会中止并等待在途尝试安全落账后才允许重启，避免两个调度器并存。
- 启动接线：Next.js `instrumentation.ts` 在 Node 运行时通过 readiness gate 后启动恢复；批次开跑和任务读取 API 也会幂等兜底启动。门禁失败只关闭批量入口，不阻塞旧项目与单条精准混剪。
- 控制与进度 API：`GET /api/batch-production/batches/[id]/tasks`（任务/尝试/真实进度）、`POST .../control`（pause/resume/stop）、`POST /api/batch-production/tasks/[taskId]/retry`，全部经 readiness 门禁。
- 未实现（后续阶段）：真实供应商取消/远端确认、磁盘/内存红线自动保护、跨平台进程树回收、正式渲染执行器（Phase E）。

## 后续阶段

| 阶段 | 可见结果 | 关键门禁 |
|---|---|---|
| Phase A 项目输入 | 项目素材和脚本自动进入批量准备区 | 项目隔离、原文件安全、脚本稳定身份 |
| Phase B 批次快照 | 多文案分别设置份数，准确建立 `N` 张卡片 | 重试不改变 `N`、开跑后快照不漂移 |
| Phase C 持久调度 | 刷新或重启后继续，分析与导出显示真实进度 | 原子领取、租约、暂停、停止、资源保护 |
| Phase D 媒体准备 | 用户按需批量开代理、选择 LUT 并安全清理 | 原片不改、代理集中、导出读原片 |
| Phase E 联合分配与导出 | 多脚本和多素材联合生成差异成片 | 用户锁定优先、素材不足可解释降级、正式产物不覆盖 |
| Phase F 公司供应商 | 一键联动 LiteLLM；失败只影响公司供应商 | 等腾讯云约束、受控临时媒体、真实调用逐次授权 |
| Phase G 桌面交付 | Electron、macOS 与 Windows 候选安装包 | 核心稳定后实施、双平台真实规模验收 |

## 当前不做

- 不实现 Cloudflare 到腾讯云的替换。
- 不改当前一键启动脚本。
- 不发起真实 AI、TTS 或媒体网关请求。
- 不新增 Electron 依赖或构建安装包。
- 不重写或迁移现有单条精准混剪。
