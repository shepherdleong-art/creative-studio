# 02：单条 Image 2 统一模型生成

**状态：** `ready-for-human`
**执行进度：** 已完成
**Blocked by:** [01：统一提交结果确认](01-统一提交结果确认.md)  
**规格覆盖：** A01、A04、A05、A15、A21  
**阅读入口：** [索引与共同约定](README.md)、[功能方案](../../specs/2026-11-10-团队版统一模型调度-功能方案.md)；开始前核对阻塞任务的实际成果与交接记录。

**What to build:** 从团队项目的一条场景图切入，员工只选 Image 2，系统校验完整规格组合、统一模型权限、选择兼容通道并交付图片；保存新规则身份并保留旧任务原合同。

## 范围与边界

- 以团队项目的一条场景图完成最小端到端路径。其余图片入口由 05 接入，跨通道失败兜底由 03 增加。
- 只合并已确认的 Image 2 通道身份，保留其他模型和个人本地供应商选择。
- 新任务采用可扩展的统一模型身份和规则版本，首次实际尝试仍保存精确通道身份。

## 验收标准

- [ ] 员工从场景图入口只选择一个 Image 2，并能完成提交、进度查看、图片预览和下载。
- [ ] 清晰度与比例按完整可执行组合提供和校验；不能从两家参数表拼出实际无人支持的组合，例如当前能力下的 1K＋9:16。
- [ ] 两家均满足请求且可用时选择七牛；仅腾讯满足请求或七牛被管理员停用时可直接使用腾讯；没有兼容通道时在提交前解释原因。
- [ ] 输入图及参考图顺序、提示词、清晰度和比例随任务冻结；候选通道必须满足同一业务要求。
- [ ] 团队管理员与员工使用统一模型授权；旧的任一可信 Image 2 通道授权映射为 Image 2 授权，未授权用户不能通过直接调用接口绕过。
- [ ] 账号暂停、个人限制、真实池容量和费用预算依然生效；等待名额不凭空占用两家容量，也不把别名视为独立池。
- [ ] 新任务的一次实际生成有稳定任务尝试和价格快照，员工看到统一模型及可辨识的估算费用，管理员可以追溯真实通道。
- [ ] 明确记录新旧规则边界；上线前已经创建的任务及其恢复／原语义重试不被改道，真正重新生成的新任务可以采用新规则。
- [ ] 新增结构采用兼容的追加升级与仓库规定的安全机制；重启、重复提交和迁移重跑不重复创建任务、扩权或覆盖后续管理员配置。
- [ ] 该最小路径每条通道的生成提交次数已经受控；在 03 完成前不会偷偷沿用多次自动生成重试来模拟兜底。

## 验证与演示

1. 用隔离团队账号，从模型选择到实际落盘完成七牛成功、腾讯单通道规格成功和非法组合拒绝三条演示。

2. 加入授权迁移、跨成员访问、预算不足及升级前旧任务恢复样本，核对任务与尝试记录。

验证使用隔离数据和模拟供应商。涉及真实付费调用或生产变更时，以用户另行明确授权为准；没有外部证据的结论在交接中明确标为未验证。

## 交接要求

- 说明统一模型与真实通道的身份映射、任务创建边界、完整组合能力查询及授权兼容规则。
- 为 03 保留能追加第二条通道尝试的关联关系，说明实际计价和池准入如何绑定尝试；不要预先覆盖原尝试身份。
- 在下方 Comments 记录实际完成范围、验证证据、改动说明、剩余限制及后续任务需要的合同；满足全部验收项后，将执行进度改为“已完成”。
- 发现超出本任务的新需求时单独记录，保持本任务边界；阻塞任务未完成时先报告缺失成果，不另造一套替代合同。

## Comments

2026-11-10：用户确认拆分后发布本任务单；当前仅完成任务文档，尚未实施。

2026-11-10：已完成团队普通项目单条场景图的最小 Image 2 端到端。

**实现合同**

- 统一身份：`image2`，规则版本 `unified-media-2026-11-10-v1`；仅识别精确通道 `company-gateway-qiniuyun-gpt-image-2-medium` / `qiniuyun/gpt-image-2-medium` 与 `company-gateway-image2-medium` / `image2-medium`，不按显示名或前缀匹配。
- 完整能力：按精确模型的 `(tier, ratio)` 格子判断，七牛 4K 3:4 使用已验证的 4K 9:16 donor 裁切；UI 与创建接口使用同一份 23 个可执行组合，`1K + 9:16` 在任务落库和提交前均拒绝。
- 创建冻结：`jobs` 追加 `unifiedModel/unifiedRuleVersion/unifiedTaskId/unifiedRequestJson/cancelRequestedAt`；冻结输入图、参考图顺序、提示词、清晰度、比例、尺寸、质量和规则版本。业务行 `providerId/model` 保持统一锚点，真实通道只在局部执行快照中出现。
- 逻辑任务：execution schema v8 新增 `execution_media_tasks/execution_media_channels/execution_media_settings`，`execution_operations` 增加 `mediaTaskId/channelKey` 与唯一索引。父任务保存冻结合同、来源、状态、取消意图和当前通道；通道保存真实 provider/model、状态、executionRevision、operation/remote/evidence。
- 选路：首个兼容、启用、凭据可用且池映射已核验的通道；优先七牛。七牛缺失或停用会记录 `skipped` 并直接使用腾讯；七牛/腾讯行存在但精确身份漂移则整条失败，避免配置漂移下误投。缺池、映射未核验或无可用通道均在 POST 前失败。统一任务 `maxAttempts` 为 1，不跨通道自动重试，也不触发队列级重复生成。
- 授权：`actorModelAllowed` 支持统一 key，并按精确可信映射让 `image2-medium`、`qiniuyun/gpt-image-2-medium` 与 `image2` 双向兼容；不扩前缀。暂停、预算、池与准入继续由 execution 层裁决。
- 费用与投影：真实 attempt 使用真实通道价格快照；员工任务显示 `Image 2`，task/usage 投影增加 `unifiedModel`。旧 attempt、远端身份、历史价格未改写。
- 取消最小守卫：取消意图写入 job/parent；未受理任务不再选路或 POST，已受理/未知任务保留原通道身份，不在本任务删除晚到结果。完整收尾由 12 接续。
- 模型列表：server 返回统一 Image 2 锚点与原有其他图片模型，仅隐藏两个真实 Image 2 通道；local 保持原列表并隐藏锚点。

**主要文件**

- `lib/media-core/unified-media/{catalog,requests,execution,model-list}.ts`
- `lib/media-core/execution/{schema,operations,pools,records,context}.ts`
- `lib/{queue,legacy-media-execution,media-queue-workers,db-migrations,seed,company-gateway-size}.ts`
- `app/api/projects/route.ts`、`app/api/projects/[id]/scene-jobs/route.ts`、`app/api/team/models/route.ts`
- `app/(workspace)/projects/new/page.tsx`、`components/workbench/{SceneStep,types}.tsx|ts`
- `lib/team-service/{tasks,usage}.ts`

**验证**

- `node scripts/unified-media-contract.test.ts`：通过。覆盖组合并集、4K 3:4 donor、无效 1K+9:16、exact 授权映射、锚点/API 投影与凭据不泄露。
- `node scripts/unified-image-queue.test.ts`：通过（0 付费）。真实 SQLite + 模拟 HTTP 覆盖七牛优先并成功、腾讯单通道成功、七牛停用/缺失自动走腾讯、身份漂移 fail closed、缺池/无通道零 POST、旧任务不变、取消意图零 POST、重复运行不二次 POST；并核对真实 attempt 价格 25/158 minor。
- `node scripts/execution-operations.test.ts`、`execution-admission.test.ts`、`legacy-media-execution.test.ts`、`image-queue-terminal-failure.test.ts`：通过。
- `node scripts/db-migrations.test.ts`、`team-service-schema.test.ts`、`company-provider-seed.test.ts`、`company-gateway-size.test.ts`、`image-generation-contract.test.ts`、`image-provider-selection.test.ts`、`media-queue-workers.test.ts`、`team-task-display.test.ts`、`team-usage-admin.test.ts`、`team-usage-routes.test.ts`、`team-api-auth-matrix.test.ts`、`project-production-identity-route.test.ts`、`team-atomic-create.test.ts`、`production-defaults-route.test.ts`、`project-scene-prompt-sync.test.mjs`：通过。
- `npx tsc --noEmit --pretty false`：通过。
- 改动文件 ESLint：0 error（仅存量 warning）。仓库级 `npm run lint` 仍因既有 `docs/`、`packaging/` 等 52 个历史错误失败，不是本任务引入。

**剩余风险与交接**

- 未调用真实七牛/腾讯上游；真实价格、通道可用性与部署池绑定仍需内网环境核验。若两家共用同一 baseUrl+凭据，必须继续按同一个受控池计量，不能假定独立容量。
- 任务 03：直接复用 parent/channel 与 `execution_operations.mediaTaskId/channelKey`；换通道前递增 `jobs.executionRevision`，不要覆盖旧 attempt/remote/计价。
- 任务 04：`execution_media_settings.imageCongestionThresholdSec` 已建表；当前七牛容量满只进入等待，不按 30 秒溢出。
- 任务 05：复用 `freezeUnifiedImageRequest` 与完整组合目录；场景批量每条已是独立 job。统一任务的失败重试/重新生成入口当前禁用，等 05 正式接入，避免绕过新入口。
- 任务 07：可复用纯目录与逻辑任务合同；画布尚未接入。
- 任务 12：当前只阻止取消后的新通道与 POST；已受理晚到结果、费用和下游阻断仍待完整收尾。

2026-11-10：合并审查修正统一任务首次选路未把数据库 `executionRevision` 回写到内存作业的问题，确保 execution operation 键与业务行/通道轮次一致，重启恢复能命中同一尝试；队列合同测试增加 operation 键及旧任务投影断言。

