# 04：Image 2 拥堵分流

**状态：** `ready-for-human`
**执行进度：** 已完成
**Blocked by:** [03：Image 2 失败自动兜底](03-Image2失败自动兜底.md)  
**规格覆盖：** A02、A07、A08  
**阅读入口：** [索引与共同约定](README.md)、[功能方案](../../specs/2026-11-10-团队版统一模型调度-功能方案.md)；开始前核对阻塞任务的实际成果与交接记录。

**What to build:** 七牛仅因容量满而阻塞时，达到管理员可调的 30 秒阈值后允许腾讯准入；任务显示真实等待原因，计时和选路不绕过公平、暂停、权限或预算。

## 范围与边界

- 在首次付费提交之前增加按真实容量选择通道的能力；保留 03 已完成的明确失败后兜底。
- Image 2 默认等待阈值为 30 秒，由管理员调整；其他模型不自动继承这一数值。
- 等待原因、计时和准入必须可观测，为可灵的立即分流及其他入口提供共享能力。

## 验收标准

- [x] 七牛兼容、启用且任务仅因其容量满而受阻时，阈值到达前不因拥堵改走腾讯；到达后可使用腾讯空闲名额。
- [x] 任务因预算、权限、个人上限、公平轮次或管理员暂停而不可执行时，不将这类阻塞当作七牛容量等待来绕过。
- [x] 阈值到达时七牛重新可用，仍遵守七牛优先；两家无名额时继续等待，不忙循环或丢失任务。
- [x] 仅腾讯支持当前规格、七牛手动停用或被系统避让时，不额外等待拥堵倒计时。
- [x] 管理员能查看、修改并持久保存图片等待阈值；接口校验非法值，员工不能通过请求参数覆盖服务器规则。
- [x] 持久等待依据在重启后可恢复；记录设置的生效范围和计时规则，避免刷新重置等待或将暂停时间误算成容量等待。
- [x] 首次腾讯分流明确失败后，仍可按 03 的剩余机会走七牛；已经尝试过的通道不会再被容量选择器选中。
- [x] 等待页面准确说明等待资源；取消排队任务后不再准入，不预先同时占用两家名额或为排队预留重复费用。
- [x] 多个 worker 同时发现空位时，真实池准入仍原子且不超售；别名共池、其他成员和其他模型仍受共享容量控制。

## 验证与演示

1. 使用可控时间和模拟池，占满七牛并释放腾讯，验证阈值前后、七牛抢先恢复、暂停及重启场景。

2. 从管理员改阈值到员工排队／接单做完整演示，并验证并发领取和不同阻塞原因。

验证使用隔离数据和模拟供应商。涉及真实付费调用或生产变更时，以用户另行明确授权为准；没有外部证据的结论在交接中明确标为未验证。

## 交接要求

- 说明共享首次选路与容量等待合同，区分是否兼容、是否健康、是否允许尝试、是否可准入。
- 记录阈值与等待时间的持久口径，让 05、06、07、10 复用这一能力而不是复制计时器。
- 在下方 Comments 记录实际完成范围、验证证据、改动说明、剩余限制及后续任务需要的合同；满足全部验收项后，将执行进度改为“已完成”。
- 发现超出本任务的新需求时单独记录，保持本任务边界；阻塞任务未完成时先报告缺失成果，不另造一套替代合同。

## Comments

2026-11-10：用户确认拆分后发布本任务单；当前仅完成任务文档，尚未实施。

2026-11-11：已完成团队普通项目单条 Image 2 的拥堵分流与管理员阈值。

**实现事实**

- 只消费 execution 目标 operation 的精确 `pool_capacity`。处理器还会复核个人生效上限、自动公平份额、未知费用、定价与月度预算；任一后续门禁也会阻塞时，把 operation 的等待原因修正为对应原因，绝不启动 30 秒分池计时。
- 首次七牛容量阻塞写 `execution_media_channels.state='waiting_capacity'`、父任务 `status='waiting'`、`nextEligibleAt` 与 `waitDetailJson`（reason、pool、threshold、waitingSinceAt、deadline）。此时既没有 execution attempt，也没有费用预留或 POST。
- 到点后先沿同一 pending operation 重试七牛；若已恢复则继续七牛。只有七牛仍返回容量满，且腾讯是兼容、启用、凭据/池有效的另一条未用通道时，才把七牛标 `overflowed`（无 POST、不消耗生成机会）并选腾讯。最新 revision 与唯一 operation 关联不允许创建同通道第二条 operation。
- 腾讯容量等待不继承图片 30 秒阈值；父任务仍等待，内部最多每秒重新检查一次以避免忙循环。两家都无名额时保留等待，不丢任务。
- 03 的腾讯溢出后明确失败仍可回七牛：`findNextChannel` 允许复用 `overflowed` 且无真实提交意图的 pending operation，并把 job 的 `executionRevision` 恢复到该通道已存 revision；总真实 POST 仍受 03 的两条通道上限约束。
- 暂停队列时把 `pausedRemainingMs` 持久写入等待详情；继续/重启时按剩余时长平移 `nextEligibleAt`，暂停时间不计入容量阈值。`claimDeferredImageJob` 在 deadline 前不领取该统一任务，worker 只做 500ms 休眠，不忙循环。
- 管理员在「模型与名额」页查看并修改阈值，写入既有 `execution_media_settings`（当前 schema v8 已建表，本任务无需新增迁移）；版本冲突 409、非法值 400、员工 403。阈值范围为 0–3600 秒，默认 30 秒；每个新容量等待开始时读取一次，已经开始的等待不被追溯改写。
- 取消复用 02/03 的 job + parent 意图与付费 POST 前守卫；容量等待中没有 attempt/费用，继续后若已取消也不会准入。正在运行/未知的既有尝试不因拥堵策略改道。

**共享合同（供 05/06/07/10）**

- 设置：`lib/media-core/unified-media/settings.ts` 的 `readUnifiedImageCongestionSettings` / `updateUnifiedImageCongestionSettings`；管理员服务入口 `updateUnifiedImageCongestion`，继续经 `/api/team/pools` 的 admin/CSRF 策略。
- 首次容量等待/溢出：`handleUnifiedImageCapacityDeferral(db, jobId, now?)`。返回 `waiting | overflowed | not_capacity | ignored | canceled`；所有入口应共用该处理器，不能自行复制计时器。
- 重启等待：`prepareUnifiedImageExecution(db, jobId, now?)` 在 deadline 前抛 `UnifiedImageWaitingError`；队列用 `waitDetail.channelKey` 展示七牛/腾讯真实等待。
- 暂停：`pauseUnifiedImageQueueWaits` / `resumeUnifiedImageQueueWaits`；等待详情保存在父任务 `waitDetailJson`，无需新增暂停表。
- 后续 Kling 可复用同一 `UnifiedImageCapacityDecision`/`imageCongestionDeadline` 结构，但 06 的“七牛满立即分流”应传 0 阈值且不写入图片模型设置；07 画布桥接同样调用本处理器，10 的优先级仍必须放在 execution 公平轮次之后。

**验证证据（隔离数据根 + 模拟供应商，真实付费 0 次）**

- `node scripts/unified-image-congestion.test.ts`：通过。覆盖 30 秒前零腾讯 POST、deadline 后七牛仍满才腾讯成功、deadline 前七牛恢复仍七牛、两家全满持续 waiting 且释放后仅一次 POST、腾讯溢出后明确失败回七牛成功且总 POST=2、月度预算/个人上限不被误判为容量、暂停 7 秒后 deadline 精确后移、等待期间不被重复 claim。
- `node scripts/unified-image-fallback.test.ts`、`unified-image-queue.test.ts`、`unified-media-contract.test.ts`：通过；03 原有双向兜底、未知不换道、下载补抓、重启续查未回退。
- `node scripts/execution-admission.test.ts`、`execution-attempts.test.ts`、`execution-reconciliation.test.ts`、`legacy-media-execution.test.ts`、`image-queue-terminal-failure.test.ts`、`gateway-task-image.test.ts`、`company-gateway-size.test.ts`、`workbench-progress.test.ts`：通过。
- `node scripts/team-pools-admin-view.test.ts`、`team-pool-config.test.ts`、`team-first-run.test.ts`、`team-console-routes.test.ts`、`team-console-overview.test.ts`、`team-task-display.test.ts`、`team-usage-admin.test.ts`、`team-usage-routes.test.ts`、`team-api-auth-matrix.test.ts`、`team-api-coverage.test.mjs`、`db-migrations.test.ts`、`team-service-schema.test.ts`：通过。
- `npx tsc --noEmit --pretty false`：通过。改动文件 ESLint：0 error / 0 warning。
- `scripts/team-pools-panel.playwright.test.mjs` 已加入“页面保存阈值并回读”的断言，但本隔离工作树的 `node_modules` 必须通过指向主树的 junction 才能运行 Next；Turbopack 明确拒绝跨根 symlink，故本轮未在该工作树执行浏览器用例。需在合并后的主工作树运行 `TEAM_POOLS_BROWSERS=chromium node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/team-pools-panel.playwright.test.mjs` 补证。

**剩余限制**

- 真实七牛/腾讯容量、暂停时间与账单仍需内网部署核验；模拟池不能证明两家的上游配额独立。
- 自动公平份额的容量-only 复核使用当前待执行 operation 与 held reservation 的保守近似，最终是否可执行仍由 execution 原子准入裁决；不会因近似而绕过准入。
- 管理员修改阈值只影响之后开始的容量等待，已在等待中的 deadline 保持不变；如产品要求追溯缩短，应另开任务明确是否重算。
- 11 的通道健康过滤已在本分支合并时叠加在同一 `findNextChannel`：七牛被系统避让时不会启动 30 秒拥堵等待；健康过滤只影响未来选路，容量等待中的原任务仍按 deadline 收尾。

