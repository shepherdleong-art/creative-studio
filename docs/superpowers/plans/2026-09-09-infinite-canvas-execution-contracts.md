# 创作画布执行技术约定

日期：2026-09-09。本文供[执行任务书](2026-09-09-infinite-canvas-execution.md)的 P1、P2、P4、P5、P6 按需读取；产品行为以[PRD](../specs/2026-09-09-infinite-canvas-prd.md)为准。

更新：2026-09-10。除下述已完成的开发运行隔离与既有模型适配外，下面的画布模块、表、接口与功能开关仍为拟新增设计，不是现有实现。允许在不改变行为与约束的前提下调整内部命名，并在执行记录中留下对应关系。

## C1. 模块与运行模式

### 已完成的开发运行隔离（2026-09-10）

macOS 源码启动统一使用 scripts/canvas-profile.sh：网页 3100、LiteLLM 4100、数据根为当前画布目录；桌面私有服务仍为独立回环随机端口，用户目录 CreativeStudioCanvas，单实例身份在申请锁之前设置。网页与桌面共享画布数据，入口持有同一启动锁；停止只作用于所属进程，桌面还校验 instanceId。实现与证据见[运行隔离记录](../../2026-09-10-画布开发运行隔离.md)。

这是开发运行边界，产品是否拆分尚未决定；保持现有 Next 应用与模块化实现，不据此新建第二个产品工程。Windows／安装包未按本配置验收。

测试 harness 不得 source canvas-profile.sh，也不得调用 npm run dev、npm run start 或 .command 启动入口：这些入口会固定真实画布数据根并启动 4100 代理。测试必须直接启动本地 Next CLI，在导入应用前设置临时数据根、独立回环端口和 fixture 注入；不能依赖尚未实现的功能开关阻止真实 I/O。当前内测数据库不得被用作 fixture 库。

新增模块使用 lib/creative-canvas/。建议分为 types、schema、readiness、runtime-readiness、repository、graph、planner、scheduler、runner、recovery、bootstrap、assets、export、usage 与 adapters；不要求为凑清单建立空文件。

客户端放在 components/creative-canvas/，页面放在 app/canvas/，HTTP 接口放在 app/api/canvas/。依赖方向为页面／路由 → 画布服务 → 纯模型、存储与适配器。纯图操作与规划器可以注入数据库和模型能力表测试，不导入浏览器、真实网关或进程级调度器。

采用服务端运行模式，拟新增：

| 配置 | 默认与效果 |
| --- | --- |
| CREATIVE_STUDIO_CANVAS_ENABLE | 默认关闭；为 1 时开放画布入口、页面与 API，并允许执行画布 readiness。关闭时不创建画布表、不启动画布 worker。 |
| CREATIVE_STUDIO_CANVAS_EXECUTOR | 默认 disabled。disabled 允许编辑但不启动生成；fixture 只用于隔离测试；company 使用公司适配器。非法值按 disabled 处理。 |

这些变量必须先实现并测试，才能作为保护措施使用。API 与 bootstrap 均执行服务端检查，不能只隐藏按钮。company 模式还需通过公司运行环境、模型能力及素材交付校验。

fixture 通过依赖注入提供提交／轮询／下载，不调用真实 Adapter 或 COS。仅限测试 harness 创建且标记的临时数据根，并在 UI 标明测试模式；生产环境拒绝 fixture。测试开始时注入时钟、任务结果和失败脚本，不在正式界面暴露“制造成功”操作。

## C2. 数据所有权与迁移

使用当前内测数据根中的 SQLite，并给画布新增独立表和追加式迁移流。不要把自由画布写入旧 jobs、video_jobs、projects 或 shot_sets。

建议的最小持久化模型：

| 表／记录 | 必需字段与职责 |
| --- | --- |
| creative_canvases | id、name、graphRevision、graphJson、viewport、createdAt、updatedAt。graphJson 只含编辑定义，有 schemaVersion。 |
| creative_canvas_node_states | canvasId + nodeId、nodeEpoch、deletedAt、activeTaskId、currentAssetId、resultTaskId。当前结果和执行状态由服务端维护，独立于自动保存的图 JSON。 |
| creative_canvas_runs | id、canvasId、requestKey、requestHash、mode、planSnapshot、status、resumeRequired、创建时间。单节点与分支统一用一次运行表达。 |
| creative_canvas_tasks | id、runId、canvasId、nodeId、nodeEpoch、phase、providerSnapshot、parameterSnapshot、providerTaskId、submissionState、slotHeld、quotaKey、leaseOwner、leaseUntil、fence、取消意图、错误和轮询时间。 |
| creative_canvas_task_inputs | taskId、refId、顺序、用途、说明、sourceNodeId；已有素材固定 assetId，等待输入固定 upstreamTaskId，文本固定正文。上游任务完成后只能解析到该次任务的 outputAssetId。 |
| creative_canvas_assets | id、canvasId、mediaKind、relativePath、hash、MIME、字节数、尺寸／时长、sourceTaskId、ready 状态与时间。文件内容不可变。 |
| creative_canvas_exports | id、canvasId、manifest、status、临时 ZIP 路径、错误。manifest 固定所选节点和 assetId，支持导出期间保留引用。 |

任务也保存自己的 outputAssetId，不能通过节点的 currentAssetId 反查过去任务的产物。复制可共享不可变文件，但具有各自的节点当前结果指针。首版不实现自动物理清理。

必要数据库约束：同画布 requestKey 唯一；同一节点至多一个未结束任务；同一次任务只关联一个正式输出；输入同时具有 assetId 和未解析 upstreamTaskId 等非法组合必须被拒绝。服务端验证所有 nodeId、assetId、runId 的画布归属，不能仅信任请求中传来的 canvasId。

迁移接入参考[Script Studio readiness](../../../lib/script-studio/readiness.ts)、[升级 gate](../../../lib/schema-upgrade/gate.ts)和[升级路径](../../../lib/schema-upgrade/runtime.ts)。新增 creative-canvas scope 时需要一起检查：

1. [backup.ts](../../../lib/schema-upgrade/backup.ts)：Scope 联合类型、备份前缀映射、未完成备份清理匹配。
2. [audit.ts](../../../lib/schema-upgrade/audit.ts)：scope 类型和运行时记录校验。
3. [recovery.ts](../../../lib/schema-upgrade/recovery.ts)：备份 manifest 的 scope 校验。
4. 画布版本表、迁移执行、经验证备份、共享锁、审计与 readiness 缓存。

保持旧 scope、旧备份和已发布迁移仍可使用。画布升级失败时仅禁用画布。迁移测试使用内存库与临时数据库；修改内测现有库前通过一致性备份设施，禁止只复制正在使用的 WAL 主文件。

dataRoot() 在模块首次加载时固定。测试需要在启动子进程前设置数据根，或注入路径／数据库依赖；不能在静态 import 完成后才改环境变量并认为已隔离。

## C3. 编辑、输入快照与幂等

保存图定义使用 expectedGraphRevision 比较更新。后台任务回写只修改任务记录及 node_states，不把旧 graphJson 整份写回。保存冲突返回 409，前端保留未保存编辑并提示重试／重新加载，不静默覆盖。

点击生成前先完成当前编辑保存，再携带图修订号与 requestKey 启动。服务端重新校验图、能力及输入，在同一事务中建立运行、任务、输入快照和节点活跃关联。

- 同一 requestKey、同一内容重复请求，返回原 runId／taskId；同 key 不同内容返回冲突。
- 请求重放先查询已有幂等记录，再做当前图和活跃状态检查；不能因为图后来修改或任务已经开始，就拒绝本应返回原结果的同一请求重放。
- 不同 requestKey 同时指向已有活跃任务的节点，返回冲突，数据库约束兜底。
- 分支预览返回图修订、运行范围、复用项、任务数和计划指纹；确认时重验。图或相关输入／能力已变化，更新预览后再提交，不能按照旧数量创建新范围。
- 单点运行：有当前结果的输入立即固定 assetId；没有结果但有活跃上游，固定 upstreamTaskId；两者都没有则拒绝。
- 分支运行：范围内输入绑定本次上游 taskId；复用起点与范围外输入固定已有 assetId；范围外缺结果时不扩充计划。
- 等待期间改连线、改提示词或上游开始另一任务，不改变已固定的输入。上游失败阻塞该次依赖，不改等后来的任务。

参考身份用 nodeId + refId 表达，顺序与显示编号独立。提示词提及关联 refId，不能靠每次渲染重新编号重新猜对象。复制时为新节点建立完整对应关系，内部连线指向副本、外部输入继续引用原来源、外部输出不额外复制。不要复制任务、lease、activeTaskId。

复制／粘贴使用独立服务端命令。复制时固定剪贴板中的编辑定义、当前结果 assetId 和输入引用，粘贴时原子创建副本。服务端验证素材可用性与归属，只通过该操作初始化副本结果，普通图 PATCH 仍不能写运行字段。复制后原节点又生成新结果，粘贴仍使用复制时保留的结果；不要到粘贴时重新取原节点最新结果。

删除节点保留 tombstone 或等效身份记录；撤销恢复时仍不能让已经失去发布权的旧任务覆盖节点。nodeEpoch 与 activeTaskId 用于区分删除／恢复／新任务的归属。撤销只恢复编辑定义，不恢复旧运行状态或触发新请求。

## C4. 状态、名额与远端提交

任务 phase 至少区分 waiting_input、queued、preparing、submitting、polling、downloading、download_failed、succeeded、failed、blocked、cancelled、uncertain、resume_pending。可调整名字，但不能合并掉会影响重提和名额的区别。

submissionState 独立记录 not_sent、maybe_sent、accepted、terminal。lease 是本地工作权；slotHeld 是持久化并发名额；两者不能混为一个到期就删除的标记。

| 阶段 | 占全局名额 | 恢复行为 |
| --- | --- | --- |
| waiting_input、queued | 否 | 进程重启后尚未提交部分等待用户继续；先按固定输入恢复，不重新读草稿。 |
| preparing 且确定未提交 | 是 | 本地工作中断后可清理准备状态，转入待继续。 |
| submitting／maybe_sent | 是 | 没有可靠远端身份时进入 uncertain，不自动重发。 |
| polling 或取消请求后远端仍运行 | 是 | 用已保存远端 ID 续查，名额不能因本地超时或租约到期而释放。 |
| downloading | 是 | 补下载同一结果；本次下载停止或失败后可以释放本地名额，再次下载时重新领取。 |
| download_failed | 否 | 保留远端任务、输出定位与资产身份；用户触发补下载，不重新生成。 |
| uncertain | 是，按可能仍占用处理 | 核查原提交；确认结束／未创建后才能释放。不以任务年龄推定远端失败。 |
| succeeded、确认终止的 failed／cancelled、blocked | 否 | 新生成必须是显式新任务；不自动重放失败请求。 |

全局名额默认 10，范围是当前数据库中所有创作画布的图片与视频任务。使用 SQLite 写事务完成计数、领取与 slotHeld 更新，跨两个调度器实例测试也不得超过 10。供应商较小上限在同一领取过程中检查；quotaKey 根据实际路由／模型配额身份归一，避免同模型重复供应商条目分别算一套额度。

按进入时间选择当前可执行任务，跳过缺输入或模型名额不足的项继续扫描。等待下游不占名额。重启先恢复已占名额，再领取新任务。

一次提交的顺序：

1. 领取任务和名额，固定本地 lease／fence；校验素材并生成临时交付地址。
2. 在任何生成 POST 前，以当前 fence、leaseOwner 和取消状态为条件持久化 submitting + maybe_sent；只有本次条件更新成功才执行一次提交，失去所有权的 worker 不继续发送。
3. 得到远端任务 ID 后立即保存原始 ID 及服务端恢复所需信息，之后才查询／下载。地址缺失时仍保留已获得的 ID。
4. 响应不明保守记 uncertain；只有明确证明请求未发送／被拒且没有远端任务时才按普通失败结束。
5. 即使 lease 已过期，迟到的远端 ID 也必须写入与原 taskId 关联的回执或原任务记录供调和，不能简单丢掉。它不因此获得发布当前结果的权利。

worker 每次领取递增 fence；状态推进及结果发布检查当前持有者。lease 过期只允许接管安全的查询／下载，不能把可能已提交的工作变回“可以再 POST”。首次实现就测试这些事务行为，不能用进程内 Set 代替数据库约束。

## C5. 输出发布、恢复与停止

输出写入任务专属临时文件，校验 MIME／可读性和必要尺寸／时长，按原交付规则规整，再原子发布到不可变资产路径。不要覆盖复用中的同一文件。下载定位信息只在服务端保存并脱敏，临时签名 URL 不作为资产身份或图字段。

输出登记与节点发布在受控事务中完成：任务 outputAssetId 唯一；仅当节点仍存在、epoch 匹配且 activeTaskId 指向本任务时更新 currentAssetId／resultTaskId。新草稿、其他节点和副本不变。保存文件后崩溃可检查并接管同一文件，不能再次生成。

恢复按事实处理：有 providerTaskId 则查询原任务；已确认远端完成则下载原产物；可能已提交但无 ID 则核查；确定未提交的旧队列进入 resume_pending。供应商身份／路由配置变化时核对原身份，不能拿旧任务 ID 发到另一供应商。

取消与停机：

- 用户停止尚未提交的任务，置取消并停止相应后代，不影响独立分支。
- 支持远端取消时发送真实取消请求并核验；取消未被确认前仍记录远端任务和名额。
- 不支持远端取消时显示仍可能继续；保留查询／归档路径，停止尚未启动的后代。已生成结果是否还能更新原节点仍须通过同一发布检查。
- 应用停机先停止领取，再中止本地 I/O 并持久化恢复状态，最后关闭数据库和受控 sidecar。接入唯一的 [gracefulShutdown](../../../lib/shutdown.ts)，不新建第二套进程信号退出流程。
- 在 [instrumentation.ts](../../../instrumentation.ts) 的 Node runtime 中接入 gated bootstrap；关闭功能时不启动画布模块。HMR 复用全局单例，执行器版本改变时先停旧实例再换新实例。

真实恢复不能由浏览器页面是否打开决定。即使页面已关闭，服务仍在时也要继续查询、下载和调度已允许推进的任务。

## C6. 适配器与模型能力

画布统一请求至少包含 mediaKind、显式 generationMode、精确模型与供应商身份、prompt、ordered typed references、outputParams。媒体项具有 assetId、kind、role、order 与说明；临时 URL 在提交准备阶段产生。

适配器分开提供 prepare、submit、poll、download 与可选 cancel，测试可分别替换。prepare 只做素材交付，submit 是可以精确计数的单次生成 POST。现有入口保留为兼容包装，以共享的准备、请求构建和 I/O 原语承接新旧调用，避免复制两套会漂移的协议。

当前需要明确扩展的点：

| 现有文件 | 已核对约束 | 实现要求 |
| --- | --- | --- |
| [gateway-task-image.ts](../../../lib/providers/gateway-task-image.ts) | 请求强制 inputImagePath；提交函数内完成上传与 POST，当前没有外部 AbortSignal 参数。 | 新增显式无图／多参考合同，拆清准备与生成边界；向提交及素材交付传递外部取消信号，旧签名可通过兼容包装保留。 |
| [video-providers/types.ts](../../../lib/video-providers/types.ts) | SubmitVideoRequest 强制首图，已有调用依赖这一合同。 | 新画布使用可辨识的输入模式，旧调用保持编译和行为兼容；不要只把必填字段变可选后到处容忍 undefined。 |
| [openai-video.ts](../../../lib/video-providers/openai-video.ts) | 公司视频经 /v1/videos；既有首尾帧字段已实测。 | 复用并扩展公司适配逻辑；单独覆盖文本、多参考模式和各模型参数。 |
| [cos-media.ts](../../../lib/cos-media.ts) | 当前以图片 MIME／压缩准备为主。 | 视频／音频走正确 MIME、格式和时长检查，不能送进图片压缩函数；保留既有图片阈值与已验证内联路径。 |
| [gateway-media-url.ts](../../../lib/gateway-media-url.ts) | 结果 URL 归一化、限定网关源附鉴权和下载脱敏。 | 复用下载边界；遵守提交时原始远端 ID 回退下载规则。 |

能力表以供应商类型、路由身份、精确别名、合同版本为键，记录模式、媒体组合、数量／大小／时长、输出参数、取消能力及证据。示例模型别名与上限不能从 HTML 原型复制。

既有验证过的参数由代码及案例支撑；原生文档新增字段先标 candidate，完成请求映射只代表 mapped，只有实际公司链路样例支持才标 verified。测试 fixture 的通过不能提升真实能力状态。产品界面只开放有足够依据的组合；受控验证 candidate 使用独立诊断入口与明确样本计划，不能通过放宽正式 API 校验来测试。

协议细节按需读[公司接口核对](../../2026-09-08-无限画布-公司模型接口核对.md)、[公司网关与 COS](../../reference/公司网关与COS中转.md)、[供应商与队列](../../reference/供应商与队列.md)。腾讯 VOD 原生 FileInfos 等字段不直接等于公司网关已转发；可灵 LastFrameUrl／OutputConfig 与 Seedance 首尾图顺序保留既有验证；模型版本能力不互相套用。

### 首版必需模型的画布接入

能力注册必须包含 `company-qiniuyun-kling-3-0` / `qiniuyun/kling-3.0` 与 `company-seedance-2-5` / `doubao-seedance-2-5-260628`。七牛使用 `images[0]` + `end_image_url`，默认 Pro、音频开启、1K 名义尺寸映射，时长限定 3–15 整数秒，智能分镜关闭必须显式传 false。Seedance 2.5 使用 `images` 参考图与 1080p size；双图模式不得声明为严格首尾帧锚定。能力证据分别引用 main 的七牛成片记录与公司网关参考，未验证的纯文本、多模态组合不随模型补种自动开放。

4100 的代理模型列表与旧适配器测试已通过；这是运行环境和旧合同证据，不是画布能力注册或 A21 验收完成。七牛 1080P 档既有实测为 3:4，其他比例映射不能声称逐格实测；智能分镜切镜效果未做独立因果验证。T4 覆盖两者的画布请求合同；R05 验证七牛首尾帧，R06 验证 Seedance 2.5 双图参考。

## C7. 路由与前端边界

拟定 API；路由可以调整，但以下语义必须全部落地：

| 方法／路径 | 合同 |
| --- | --- |
| GET／POST /api/canvas | 列表／创建；无旧 projectId 要求。 |
| GET／PATCH /api/canvas/:id | 读取定义及运行投影／按 expectedGraphRevision 保存编辑。客户端不能写 currentAssetId、activeTaskId。 |
| POST /api/canvas/:id/copies | 接收已固定的复制快照，验证素材与来源归属后原子创建副本及连线；幂等处理粘贴重试，不复制任务。 |
| POST /api/canvas/:id/assets | 导入并校验本地素材，返回资产身份；只接受上传文件，不接受客户端任意本机路径。 |
| GET /api/canvas/assets/:assetId | 经过所属画布与文件边界检查读取媒体；支持视频按需读取需要的 Range。 |
| GET /api/canvas/models | 脱敏的可用模型及能力；不返回密钥、私密配置或完整鉴权 URL。 |
| POST /api/canvas/:id/plan | 单点／分支计划预检，返回范围、复用项、数量及计划指纹。 |
| POST /api/canvas/:id/runs | 幂等启动，校验修订与计划；数据事务成功后由 worker 推进。 |
| GET /api/canvas/tasks | 全局任务与可分页的近期状态；仅返回 UI 所需字段。 |
| POST /api/canvas/tasks/:taskId/cancel | 执行停止语义，返回真实本地与远端状态。 |
| POST /api/canvas/runs/:runId/resume | 继续已冻结且确定尚未提交的部分；不会重跑已成功或 uncertain 的任务。 |
| POST /api/canvas/tasks/:taskId/download-retry | 补下载原任务产物，不新增生成。 |
| POST /api/canvas/:id/exports | 固定当前选中 assetId 清单并生成导出。 |
| GET /api/canvas/exports/:exportId | 查询导出状态；就绪后取得 ZIP 下载入口。 |

HTTP 错误采用 code、message、节点／引用问题列表，明确区分无效输入、冲突、能力未开放、运行环境不可用和提交待核查。循环、越界文件、跨画布 ID 或禁用功能的请求在模型 POST 前结束。

React Flow 负责节点编辑与视口，后端负责执行。定义、运行投影、选择／视口分别管理；任务轮询不能重建整个画布并夺走输入焦点。组件使用稳定节点 ID，按需订阅任务变化，保持节点和事件引用稳定。[官方性能说明](https://reactflow.dev/learn/advanced-use/performance)

前端不暴露执行器模式开关。fixture 标识只在测试实例显示；输入模型和参数集中在节点内，引用详情与任务抽屉按需展开。

## C8. 导出与消耗

导出在服务端事务中固定选中节点名称与 currentAssetId，形成 manifest 并保留资产引用。预检文件可读性，生成完整临时 ZIP 后再提供下载；失败时返回具体文件，不以部分内容冒充完成。文件名清洗并解决重名，路径从受控资产身份解析。ZIP 不含未选中的输入、历史产物、密钥或签名 URL。

复用 archiver；单文件下载输出实际成品，保留已验证图片规整与原生画质，不用缩略图代替。导出不占生成名额，不调用模型。

画布自己的 usage 包装调用 [recordUsage](../../../lib/usage-ledger.ts) 等通用账本设施，refType 使用画布任务语义，refId 指向 taskId，projectId 可为空。旧 [usage-async-jobs.ts](../../../lib/usage-async-jobs.ts) 直接读取旧 jobs／video_jobs，不能套用来伪造画布记录。

按任务及实际提交尝试生成稳定 eventKey；账本失败补记，不能触发重新生成。查询、下载重试、复制、切换画布与导出都不增加生成调用数。账本的 uncertain 是计费记录状态，不是远端任务恢复的替代品。
