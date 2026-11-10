# 03：Image 2 失败自动兜底

**状态：** `ready-for-human`

**执行进度：** 已完成

**Blocked by:** [02：单条 Image 2 统一模型生成](02-单条Image2统一模型生成.md)  
**规格覆盖：** A06、A07、A08、A09、A14、A22  
**阅读入口：** [索引与共同约定](README.md)、[功能方案](../../specs/2026-11-10-团队版统一模型调度-功能方案.md)；开始前核对阻塞任务的实际成果与交接记录。

**What to build:** 同一图片任务可在明确失败后换另一通道，双向各一次；备用排队、预算复核、每次真实费用、取消后的禁止新提交和重启幂等同时成立。

## 范围与边界

- 在 02 的单条图片路径上完成有限兜底，不承担主动因拥堵分流的 30 秒策略。
- 任务仍是一条员工制作任务；尝试、费用、远端身份和产物归属分别可追溯。
- 取消后禁止新提交、未知状态不重发及基本幂等是本任务的完成条件，不能推迟到 12。

## 验收标准

- [x] 首条通道明确未创建或远端明确失败时，另一条兼容、启用且未尝试的通道可以接手；审核拒绝使用原素材、提示词和参数，不自动改写。
- [x] 支持七牛到腾讯以及腾讯到七牛；同一任务每条通道最多一次生成提交，总共最多两次，不双发、不循环。
- [x] 第二通道名额不足时保留同一任务等待，员工看到“等待可用资源”；未实际提交不消耗该通道机会。
- [x] 每次尝试重新检查模型授权、账号状态、预算和目标池名额；不能携带原池许可向另一池执行。
- [x] 第二次尝试前预算不足或权限被撤销时不提交，并给出明确原因；第一次费用及未核清占用完整保留。
- [x] 两次尝试分别保留真实通道、配置引用、远端 ID、价格快照、费用状态和结果；员工任务合计与管理员明细能对上。
- [x] 两条可用通道都明确失败后展示最终失败；下载失败走原结果补抓，受理未知保持确认状态，不消耗另一通道。
- [x] 同请求重复点击、并发领取、进程重启、管理员或自动恢复都不能重置已用通道、产生第三次生成或重复结算。
- [x] 取消意图在付费提交前可见且持久化；取消与备用提交竞争时，只能得到可解释的未提交或已受理收尾结果，不能继续新一轮生成。
- [x] 一次最终成功只登记一份该任务产物，不重复推进场景图后续动作；旧任务及个人版保持原次数合同。
- [x] 共享任务尝试关联能被后续入口、管理员核对与费用页面复用，包含来源归属、取消意图和可恢复的交付关联。

## 验证与演示

1. 用模拟供应商演示双向兜底、备用满后接单、两家失败、未知结果、预算撤销和下载补抓；核对提交计数与两次费用。

2. 在首条失败、第二条领取、付费 POST 边界及产物登记前后注入崩溃和重复请求，验证恢复与取消竞争。

验证使用隔离数据和模拟供应商。涉及真实付费调用或生产变更时，以用户另行明确授权为准；没有外部证据的结论在交接中明确标为未验证。

## 交接要求

- 交付共享路由与任务尝试合同，明确谁负责准入、提交、确认、结算、结果登记和恢复；供 04、11、13、14 独立接入。
- 给出取消意图、来源身份和结果交付关联的读取／更新边界，后续入口不得各建一套计数。
- 在下方 Comments 记录实际完成范围、验证证据、改动说明、剩余限制及后续任务需要的合同；满足全部验收项后，将执行进度改为“已完成”。
- 发现超出本任务的新需求时单独记录，保持本任务边界；阻塞任务未完成时先报告缺失成果，不另造一套替代合同。

## Comments

2026-11-10：用户确认拆分后发布本任务单；当前仅完成任务文档，尚未实施。

2026-11-10：已完成团队普通项目单条 Image 2 的有限失败兜底。

**实现事实**

- 只在 01 的结构化提交证据上换道：`confirmed_not_created` 与 `terminal_failed` 才进入备用路由；`unknown`、轮询查询失败、下载失败都不调用备用 handler。`LegacyMediaNotCreatedError` 与新增的 `LegacyMediaRemoteFailedError` 携带 `SubmissionEvidence`、attempt/operation/channel 身份；非统一任务仍走旧显示与重试语义。
- `handleUnifiedImageExplicitFailure` 在单个 SQLite 事务内封存旧 channel/operation，保留其 operationId、remoteId、attempt、价格快照和费用状态，再按真实 `intentJournalSeq` 计算已提交通道，只选未提交、兼容、启用且凭据完整的另一条通道。切换时 `jobs.executionRevision + 1`、job 回 `pending` 并只清理上一通道的 `providerTaskId/providerStatus/providerRawResponse/remoteImageUrl/submittedAt/poll*/finishedAt/startedAt/latency/usageSnapshot/estimatedCost`；旧 attempt 和 reservation 不动。
- 首轮七牛、腾讯任一先执行都可反向兜底；初始因停用/缺行被记为 `skipped` 的通道会在失败后重新核验，管理员重新启用后可被选中。每通道机会按真实尝试中的提交意图计，不依赖可被 UI 投影覆盖的 channel state；总提交最多两次，第三次由 handler 和 operation/channel 唯一约束共同阻断。
- 首条通道完成明确失败结算后、handler 选路前若进程重启，`prepareUnifiedImageExecution` 会从持久 attempt 重建同一 `SubmissionEvidence` 并推进备用通道，再抛 `UnifiedImageRecoveryPendingError` 让 worker 释放本轮、重新领取 pending job；不会把 `not_created` 重置出的 pending operation 当成未提交任务再次发送同一通道。
- 第二通道的 execution operation 是新 revision、新 permit、新价格快照，重新走 actor/paused/model/budget/pool/capacity；容量不足时 job 保持 `deferred`、parent `waiting`、channel `waiting_capacity`，没有 attempt 也不消耗机会。`execution_operations.waitReason/waitDetail` 与 ledger 的 `operationWaitReason/operationWaitDetail` 保留可扩展等待原因；员工 `pool_capacity` 文案为“等待可用资源（供应商名额已满，释放后自动继续）”。
- 取消意图沿用 `jobs.cancelRequestedAt` + parent `cancelRequestedAt`。选路事务、`submitLegacyMediaOperation` 的 markSubmitting 之后/真实 POST 之前均有守卫；备用排队中取消会在领取时收尾为零 POST，首个失败回调中取消则只封存已失败通道，不再选下一条。已受理后的晚到结果与下游阻断仍归任务 12。
- 统一任务每次真实通道使用独立、不落 `jobs.usageSnapshotJson` 的渠道价格快照；最终成功才把成功渠道快照用于 job 展示。`jobs.estimatedCost` 取全部 attempt 的实际/预留估算之和（释放的未创建记 0），不再用 `attempt` 次数乘成功通道单价；成功只登记一份 `image_assets` 与一条 `shot_result_candidates`。
- 本次没有新增数据库迁移；02 的 parent/channel 和 execution operation/attempt 结构足以承载第二尝试。`maxAttempts` 仍为 1，多通道机会完全由 parent submissions 控制。

**共享接口指针**

- 选路/恢复：`prepareUnifiedImageExecution`（`lib/media-core/unified-media/execution.ts`）仍是唯一入口；内部 `findNextChannel` 负责兼容/启用/未提交判断。若它从已结算终态 attempt 补推进备用通道，会抛 `UnifiedImageRecoveryPendingError`，调用方必须保留已写入的 pending job 并释放本轮 worker。04 在这里增加 30 秒容量溢出与持久 `nextEligibleAt`，11 在这里叠加通道健康过滤；不要在其他入口复制选路。
- 明确失败决策：`handleUnifiedImageExplicitFailure(db, jobId, { evidence, attemptId?, operationId?, channelKey? })`。输入必须是 01 的 `SubmissionEvidence`，且对应 attempt 已完成同终态结算；13 的 operator 证据应先走 `facade.reconcile`，再调用本函数。返回 `next_channel | exhausted | canceled | ignored` 及 `previousChannelKey/nextChannelKey/nextExecutionRevision/submissionCount/usedChannelCount`。
- 提交前最后守卫：`assertUnifiedImageSubmissionStillCurrent`；核对 current channel、executionRevision、cancel intent、provider enabled/凭据。04/其他入口在付费 POST 前复用它，不能只看内存 job。
- 只读尝试账本：`listUnifiedImageChannelAttempts(db, jobId)` 返回 parent 状态、取消意图、每通道 state/operation/remote/evidence 与每个 execution attempt 的 provider/pricing/terminal/cost；14 直接以此投影员工任务合计与管理员通道明细。`unifiedImageAttemptCostMinor` 提供同一口径的估算合计。
- 容量等待继续使用 execution operation 的 `waitReason/waitDetail`，ledger 已暴露为 `operationWaitReason/operationWaitDetail`；新增 reason 不需要改父表或复制队列状态。

**验证证据（全部使用隔离数据根与模拟 HTTP，真实付费调用 0 次）**

- `node scripts/unified-image-fallback.test.ts`：通过。覆盖七牛明确未创建→腾讯成功、腾讯先执行→七牛成功、七牛异步终态失败→腾讯成功、明确未创建结算后模拟重启仍只进备用通道、备用池 0→waiting→释放后仅一次提交、未知 5xx、轮询查询失败、下载失败原地址补抓、两通道均失败且无第三次、备用预算/权限失败、`cost_unknown` 保留 held 预留、取消竞态零备用 POST、备用等待中取消零 POST、重复 run 不重置；同时断言两次 attempt 的 provider/permits/operation/price/cost、`maxAttempts=1`、单产物与单 shot candidate。
- `node scripts/unified-image-queue.test.ts`：02 合同回归通过，并扩展断言 `listUnifiedImageChannelAttempts` 的单次尝试投影。
- `node scripts/unified-media-contract.test.ts`、`execution-attempts.test.ts`、`execution-reconciliation.test.ts`、`execution-admission.test.ts`、`legacy-media-execution.test.ts`、`image-queue-terminal-failure.test.ts`、`gateway-task-image.test.ts`、`media-queue-workers.test.ts`、`team-task-display.test.ts`、`team-usage-admin.test.ts`、`team-usage-routes.test.ts`、`db-migrations.test.ts`、`team-service-schema.test.ts`、`workbench-progress.test.ts`：通过。
- `npx tsc --noEmit --pretty false`：通过。改动文件 ESLint：0 error。`npm run check:main-path`：通过（需在沙箱外启动本机 ffmpeg；主流程真实付费调用 0 次）。

**剩余限制与后续**

- 未连接真实七牛/腾讯上游；失败计费、审核拒绝文案与真实通道健康仍需内网/账单证据。恢复契约只重建已结算终态；若崩溃发生在回执已落库但尚未结算的费用预留阶段，仍按 unknown/管理员核对处理，不会猜测另一通道。
- 员工任务级费用聚合仍是 14 的交付；当前 execution attempt ledger 已完整，但任务中心暂按 operation 展示两条真实尝试。取消后的晚到成品、界面收尾与下游阻断仍归 12。04 的 30 秒拥堵分流、11 的健康避让均未提前实现。

