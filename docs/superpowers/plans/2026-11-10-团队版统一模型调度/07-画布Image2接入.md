# 07：画布 Image 2 接入

**状态：** `ready-for-human`
**执行进度：** 已完成
**Blocked by:** [04：Image 2 拥堵分流](04-Image2拥堵分流.md)  
**规格覆盖：** A02、A04、A05、A06、A10、A11、A12、A21、A22  
**阅读入口：** [索引与共同约定](README.md)、[功能方案](../../specs/2026-11-10-团队版统一模型调度-功能方案.md)；开始前核对阻塞任务的实际成果与交接记录。

**What to build:** 画布图片节点通过统一模型选项、完整组合规划、持久任务、调度到产物交付使用同一图片规则；已有画布任务快照保持原身份。

## 范围与边界

- 仅接入画布 Image 2 图片节点，完整覆盖模型菜单、能力规划、任务持久化、调度、结果和预览。
- 沿用画布独立模块边界与共享媒体方向，复用统一调度；画布不通过写旧项目任务表来冒充接入。
- 保留已有画布任务的能力键、供应商身份和输入快照，图区分旧执行记录与尚未生成任务的节点草稿。

## 验收标准

- [x] 员工在画布图片节点选择统一 Image 2，并能完成规划、运行、等待、图片预览及产物后续使用。
- [x] 画布规划与执行都校验完整参数组合；仅一家支持时选该家，不支持的组合在提交前拦截。
- [x] 新任务冻结输入素材及顺序、提示词、输出要求、统一模型与规则版本；候选参考图始终属于该画布及授权成员。
- [x] 七牛优先、图片拥堵阈值和双向有限兜底复用已有规则；画布不会再维护独立的错误分类或通道次数口径。
- [x] 受理未知、查询超时、重启及下载失败都能按原尝试恢复，保留名额和费用核对状态，不生成第三次请求。
- [x] 画布调度名额与真实供应商池名额各自按原合同处理，统一模型不能增加共享池容量或绕过成员上限。
- [x] 一次最终成功只登记一次画布产物，来源身份和任务尝试可被统一核对及费用页面识别；中间失败不重复触发下游。
- [x] 已有画布任务和旧能力键按原规则恢复，新规则任务通过明确创建边界识别；迁移重跑不回写旧快照。
- [x] 画布取消意图已经阻止后续付费提交；旧画布功能、关闭模块时的行为、其他模型及个人版通过回归。

## 验证与演示

1. 在隔离画布中演示选择、规划、排队分流、一次失败后成功以及产物使用，检查实际调用和共享池占用。

2. 用旧任务快照、重启、并发重复领取、素材归属错误和补下载样本验证恢复及身份隔离。

验证使用隔离数据和模拟供应商。涉及真实付费调用或生产变更时，以用户另行明确授权为准；没有外部证据的结论在交接中明确标为未验证。

## 交接要求

- 交付画布统一模型到共享路由的桥接合同：创建边界、任务来源、输入冻结、产物关联和恢复入口。
- 说明 08 可直接复用的节点／任务能力，以及 12 需要验证的取消后下游与产物展示行为。
- 在下方 Comments 记录实际完成范围、验证证据、改动说明、剩余限制及后续任务需要的合同；满足全部验收项后，将执行进度改为“已完成”。
- 发现超出本任务的新需求时单独记录，保持本任务边界；阻塞任务未完成时先报告缺失成果，不另造一套替代合同。

## Comments

2026-11-10：用户确认拆分后发布本任务单；当前仅完成任务文档，尚未实施。

2026-11-11：已完成团队模式下创作画布的 Image 2 统一接入。

**实现合同**

- 模型菜单：`COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY`（`unified-image2`）只在 server/company 执行器且至少一个精确通道已配置时进入可选列表；`image2-medium` 与 `qiniuyun/gpt-image-2-medium` 仍注册在能力表供旧任务恢复，但从员工可选列表移除。local 模式保持原精确通道列表。
- 规划冻结：`CanvasPlanTask` 新增 `unifiedModel/unifiedRuleVersion`；计划指纹自动覆盖。规划和执行都调用 `resolveUnifiedImageOutput` 校验完整 `(tier, ratio)`，`1K + 9:16` 在计划与执行边界均拒绝。
- 任务桥接：新增 `lib/creative-canvas/unified-image.ts`。画布任务建立共享 `execution_media_tasks` 父任务（`module=canvas`、`sourceType=canvas_node`、`sourceId=canvasId`）；父任务冻结完整输入顺序、提示词、档位、比例、尺寸、规则版本和来源；画布仍不写旧 `jobs/video_jobs/projects/shot_sets`。
- 通道尝试：每次真实通道提交使用 `execution_operations.mediaTaskId/channelKey` 与独立 revision/permit；operation/task attempt 保存真实 provider/model/baseUrl 与价格快照，画布任务快照仍保存统一身份。成功只登记一份 `creative_canvas_assets` 并发布一次节点结果。
- 共享路由：候选选择复用 `selectUnifiedImageChannelForTask`，不复制精确身份、完整能力、池映射或通道健康逻辑；七牛优先、图片 30 秒持久等待、到点先重试七牛、仍满才溢出腾讯、双向明确失败各一次均复用 03/04/11 合同。
- 恢复与取消：有远端 ID 只续查/补下载；未知保留原通道和占用；下载失败只重试原结果。`creative_canvas_tasks.cancelRequestedAt` 与父任务取消意图同时生效，提交前及 transmit 前复核 current channel/revision/provider，取消或切道竞态下不发 POST。已受理后的晚到结果/下游阻断仍归任务 12。
- 旧任务：判断只依据新任务快照中的 `unifiedModel + unifiedRuleVersion`；旧精确能力键、供应商身份和快照不回写。画布 schema 未新增迁移，因为统一身份与合同已冻结在任务快照和共享 media task 中。

**主要文件**

- `lib/creative-canvas/unified-image.ts`、`adapters/company-capabilities.ts`、`capabilities-bootstrap.ts`
- `lib/creative-canvas/{planner,tasks,runner,recovery,usage}.ts`
- `lib/media-core/unified-media/execution.ts`（只导出共享选路/选中标记及 provider 类型，供画布复用）
- `scripts/unified-canvas-image.test.ts`
- `docs/reference/创作画布.md`

**验证（真实付费调用 0 次）**

- `node scripts/unified-canvas-image.test.ts`：通过。覆盖统一模型-only 菜单、完整组合计划/执行双重拒绝、七牛成功与真实 attempt 快照、七牛明确失败转腾讯、腾讯溢出失败回七牛、容量等待与七牛恢复优先、未知不切通道、健康避让、受理后续查重启、下载失败原结果补抓、等待取消零 POST、旧精确任务不建父任务。
- `node scripts/creative-canvas-planner.test.ts`、`creative-canvas-execution.test.ts`、`creative-canvas-recovery.test.ts`、`creative-canvas-scheduler.test.ts`、`creative-canvas-api.test.ts`、`creative-canvas-bootstrap.test.ts`、`creative-canvas-usage.test.ts`、`creative-canvas-review-regressions.test.ts`、`creative-canvas-external-recovery.test.ts`：通过。
- `node scripts/creative-canvas-capabilities-bootstrap.test.ts`、`creative-canvas-configured-videos.test.ts`、`creative-canvas-providers.test.ts`：通过（供应商测试只连本机模拟上游并调用本机 ffmpeg）。
- `node scripts/unified-image-queue.test.ts`、`unified-image-fallback.test.ts`、`unified-image-congestion.test.ts`、`unified-image-health-routing.test.ts`、`unified-reconcile.test.ts`：通过。
- `npx tsc --noEmit --pretty false`：通过。改动文件 ESLint：0 error/0 warning。

**剩余限制与交接**

- 未连接真实七牛/腾讯上游；画布统一模型的真实吞吐、失败计费与切换效果仍需内网/账单证据。
- 08 可直接复用统一桥接：新增视频父任务/通道能力，但画布本地 slot、父任务 contract 与 attempt 边界保持不变。
- 12 需要在统一画布任务上补：取消后的晚到成品展示、明确“已停止后续生成但已受理仍收尾”的 UI、以及 `resolveCanvasTaskInputs` 对已取消上游的自动下游阻断。
- 当前完整组合已在计划/执行拒绝；节点参数控件仍可能短暂展示不可执行的档位组合，提交前不会放行。若后续要做参数联动过滤，应只改 UI，不放宽服务端合同。

