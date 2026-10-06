# 创作画布执行验收与交付清单

日期：2026-09-09。配套[执行任务书](2026-09-09-infinite-canvas-execution.md)与[技术约定](2026-09-09-infinite-canvas-execution-contracts.md)。更新：2026-09-10。环境隔离与旧适配器验证已有通过记录，见第 0 节；新增画布测试 T1–T6、真实样本 R01–R08 与 A01–A22 整体验收仍未跑。

产品预期只在[PRD 第 12 节](../specs/2026-09-09-infinite-canvas-prd.md)维护；下面规定每条预期由什么证据支持。执行者把实际状态与证据填写到执行记录，不把规划的测试名称当成已经存在或通过的测试。

## 0. 已有准备证据与剩余验收

证据来源：[运行隔离记录](../../2026-09-10-画布开发运行隔离.md)与[阶段执行记录](../../2026-09-09-无限画布-执行记录.md)。下面登记的是 2026-09-10 已执行结果，不要求后续每次无变化重跑；运行状态在使用前复核。

| 项目 | 已有结果与层级 | 不代表什么 |
| --- | --- | --- |
| 环境隔离 | 代码／配置已完成：3100 网页、4100 独立代理、画布数据根、Canvas 桌面身份。 | 不代表产品拆仓或 Windows／安装包隔离完成。 |
| 进程停止 | 自动化真实子进程测试通过：异目录监听者保留，同目录监听者停止，父环境中的旧数据根被覆盖。 | 不代表画布生成中故障恢复或任务排空通过。 |
| 应用启停 | 真实网页 HTTP 200、代理健康 200；桌面 instanceId 匹配、独立用户目录得到进程证据；两种入口停止后对应服务退出，旧项目进程保留；用户确认桌面显示。 | 不代表 /canvas 正式界面或三态主题浏览器验收完成。 |
| 必需模型 | 4100 的模型列表含七牛可灵 3.0、Seedance 2.5；旧适配器、补种、尺寸、尾帧、智能分镜和计价对应测试通过。 | 没有本次画布真实生成证据；不将已有 main 成片记录计作 R05/R06 已通过。 |
| 基础构建 | TypeScript、生产构建、桌面编译与相关启停／安全测试通过。 | 未完成全量 lint、正式临时根构建基线；P0 仍为部分准备完成。 |

对应已存在的测试包括 scripts/canvas-isolation.test.mjs、scripts/runtime-process-tree.test.mjs、scripts/runtime-ports.test.mjs、scripts/start-desktop-command.test.mjs、scripts/stop-desktop-command.test.mjs、scripts/electron-shell-security.test.mjs。进程测试在 macOS 需要允许 ps/lsof；使用 TMPDIR=/private/tmp 保持真实路径一致。固定 3100 的隔离测试只在该端口空闲时运行，不停止真实画布来抢端口；不将这些入口测试用于生产任务中的恢复验证。

## 1. 本地测试设施

遵守仓库 Node 22 原生 TypeScript 测试方式，使用 node:assert/strict。新纯模块的测试通过真实函数、数据库事务和故障输入验证行为；不要用源码包含某个字符串代替行为验证。

测试数据库用 :memory: 或新临时文件；双进程、WAL 和恢复测试必须使用临时文件数据库。路径相关测试在子进程启动前设置 CREATIVE_STUDIO_DATA_ROOT。每个进程记录自己创建的资源并有界退出，只清理本次创建的临时资源。

fixture 输出使用本地可读的图片、短视频和音频；既要验证任务状态，也要验证文件确实存在且可以解码。fixture Adapter 不访问真实公司模型和 COS，其请求计数和故障时间由测试控制。

新增 scripts/creative-canvas.playwright.test.mjs，直接使用现有 @playwright/test 的 chromium 能力。脚本须支持 --suite editor、--suite execution、--suite recovery、--suite export、--suite performance 和 --suite all。早期阶段只运行已实现的对应 suite。

浏览器 harness 自行创建临时数据根、准备 fixture、选择空闲回环端口、启动 Next、等待 ready、运行用例并关闭自身子进程。直接调用本地 Next CLI，显式传入临时数据根和空闲回环端口。不得调用 npm run dev、npm run start、.command 或 source canvas-profile.sh：当前入口会将数据根固定回真实画布目录，并启动 4100 公司代理。harness 不继承真实供应商凭据，不连接 3100/4100 已有实例；fixture 通过注入阻断真实 Adapter/COS。不要连接默认端口上已有的未知实例，也不要把旧 HTML 原型的 DOM 替身测试称为正式浏览器验收。

## 2. 分阶段测试组

以下 scripts/creative-canvas-* 均为本任务拟新增文件；对应阶段实现后才运行。名称可调整，但执行记录要保持 T 组、A 编号和实际文件的映射。

### T1：P1 的存储与图模型

```bash
node scripts/creative-canvas-schema.test.ts
node scripts/creative-canvas-graph.test.ts
node scripts/creative-canvas-assets.test.ts
node scripts/creative-canvas-api.test.ts
```

覆盖迁移首次／重复／失败、备份恢复与旧 scope；功能关闭无画布副作用；跨画布 ID 与文件越界拒绝；图保存修订冲突；复制连线与当前结果；导入后源文件移动不失效；视频读取 Range；客户端不能写运行字段。

### T2：P2 的计划与执行

```bash
node scripts/creative-canvas-planner.test.ts
node scripts/creative-canvas-scheduler.test.ts
```

覆盖同 key 重放（包括图已变化或任务已开始后）、不同 key 抢同节点、整份计划预检、上游当前结果与绑定任务的区别、复制无新提交、分支起点复用、失败只阻塞后代。用两个 SQLite 连接／执行实例争抢 11 个任务，断言任何时刻全局占用不超过 10；等待输入不占名额，受限模型不造成其他模型队头阻塞。

### T3：P3 的编辑器浏览器验证

```bash
node scripts/creative-canvas.playwright.test.mjs --suite editor
node scripts/creative-canvas.playwright.test.mjs --suite execution
```

覆盖真实页面的拖入、填写、连线、拉线菜单、Esc、断线、复制粘贴、撤销、刷新、多参排序与失效引用。检查网络请求与数据库状态：编辑不发生成请求；同时启动图片与视频时仍能输入；复制含当时画面和参数但不复制活跃任务，复制后到粘贴前原节点更新不改变副本内容；界面没有历史版本入口。

### T4：P4 的公司合同与兼容

```bash
node scripts/creative-canvas-providers.test.ts
node scripts/creative-canvas-assets.test.ts
```

使用本地 HTTP 上游捕获实际请求，断言模型、顺序、用途、参数、一次 POST、外部 AbortSignal 和原始任务 ID 保存。针对未知能力、缺 COS、格式超限、丢参考、非法组合，断言模型 POST 为零。素材准备失败与 POST 响应不明属于不同情况，错误分类不能混淆。

两个必需模型必须从画布统一请求进入适配器做请求捕获，不能只重复旧适配器测试：

- 七牛可灵 3.0：精确别名、images[0] + end_image_url、Pro、音频参数、1K 名义 size、3–15 整数秒；智能分镜开启用 intelligent，关闭显式 false；缺 COS 或首帧尺寸不可读时 POST 为零；腾讯旧渠道保持原字段。
- Seedance 2.5：精确别名、参考图顺序、1080p size；双图按参考模式校验，不进入严格首尾帧声明；旧 2.0/Fast 行为不被套用 2.5 参数。
- 两者均验证模型选择、冻结输入身份、查询／下载沿用原始远端 ID；测试成功仅更新本地映射证据。

已映射的纯文本输入没有伪造首图；新多参在请求体中确实存在。这个检查仅证明应用构造了预期请求，不证明公司网关继续转发了所有字段。

### T5：P5 的恢复、停止与用量

```bash
node scripts/creative-canvas-recovery.test.ts
node scripts/creative-canvas-usage.test.ts
node scripts/creative-canvas.playwright.test.mjs --suite recovery
```

必要故障点：提交意图落库后中断、POST 响应丢失、ID 得到但保存失败、lease 过期后迟到 ID、供应商完成但下载失败、文件完成而发布事务中断、节点删除／撤销后旧回写、进程重启、HMR 换执行器、用户停止和应用停机。

断言原 taskId 与远端 ID 被保留，已提交任务只查询／补下载；uncertain 不重发且保留可能的名额；未提交部分待继续；输入快照不改变；过期 worker 不能发布；同一生成不会重复记账。至少有子进程真实退出后重新启动的用例。

### T6：P6 的下载与整体体验

```bash
node scripts/creative-canvas-export.test.ts
node scripts/creative-canvas.playwright.test.mjs --suite export
node scripts/creative-canvas.playwright.test.mjs --suite performance
node scripts/creative-canvas.playwright.test.mjs --suite all
```

ZIP 测试读取实际压缩包清单并核对内容 hash：选择之外的文件未被打包、重复名称不覆盖、生成过程中切换当前结果不改变 manifest、缺失文件不报告完整成功。单文件下载检查实际 MIME／扩展名／内容，生成调用数保持不变。

性能样本为 50 个节点，至少 20 个媒体节点，跨画布最多 10 个 fixture 任务。连续执行输入、拖拽缩放、切换和保存，至少观察 5 分钟；记录输入完整性、任务更新是否夺焦点、重复长时间卡顿、媒体是否持续解码。视频默认只播放一个，视口外按需加载。记录实际机器、浏览器、素材规格与观察结果，不能只截静态截图判断流畅性。

## 3. 类型、构建与旧模块回归

P0 留一次基线，P6 完整跑一次；中间阶段按改动跑针对性检查。失败后先修复本次引入的问题，复跑相关项；通过后不无原因重复全套检查。

在已经确认隔离的测试／构建数据根中运行：

```bash
node node_modules/typescript/bin/tsc --noEmit
npm run lint
CC_CANVAS_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/creative-canvas-build.XXXXXX")"
CREATIVE_STUDIO_DATA_ROOT="$CC_CANVAS_BUILD_ROOT" CREATIVE_STUDIO_CANVAS_ENABLE=0 CREATIVE_STUDIO_CANVAS_EXECUTOR=disabled npm run build
git diff --check
```

不要在画布桌面正在使用同一 .next 构建产物时覆盖构建：先确认归属并正常停止，或使用独立构建工作区。测试／构建命令不加载 canvas-profile.sh，避免覆盖临时根。

会初始化数据的测试进程同样由执行者或 harness 在启动前设置自己的临时数据根；上面构建命令显式创建独立根并使用完整变量名。开关的保护以 C1 实现并验证生效为前提。git diff --check 对未跟踪文件不提供完整覆盖，新文件还需进入类型／lint 或文档检查。

| 改动范围 | 已存在的相关回归测试 |
| --- | --- |
| 共享升级 scope、备份／审计／恢复 | scripts/schema-upgrade-lock.test.ts、scripts/schema-upgrade-recovery.test.ts、scripts/batch-schema-upgrade.test.ts、scripts/video-provider-schema-upgrade.test.ts、scripts/script-studio-schema.test.ts |
| 图片提交、尺寸与交付 | scripts/gateway-task-image.test.ts、scripts/company-gateway-size.test.ts、scripts/image-output-normalize.test.ts、scripts/gateway-media-url.test.ts |
| COS | scripts/cos-media.test.ts |
| 视频适配与旧恢复 | scripts/video-queue-resume.test.ts，以及执行时发现的对应精确适配器测试 |
| 公司启停与运行检查 | scripts/company-provider-runtime.test.ts；改启动脚本时加 scripts/company-provider-startup.test.mjs；改 LiteLLM 超时配置时加 scripts/litellm-router-timeout.test.mjs |
| 用量、停机与启动接入 | scripts/usage-ledger.test.ts、scripts/usage-schema.test.ts、scripts/graceful-shutdown.test.ts |

按 node scripts/文件名 执行；测试前读头部说明并确认隔离依赖。旧工作台浏览器冒烟只验证受影响的图片／视频输入、主题和页面入口，使用隔离数据与假上游；不顺便提交旧项目的真实生成任务。

## 4. PRD 覆盖表

实际状态使用未跑、通过、失败、阻塞；每一条还需写证据层级。多个层级有一项未跑时，不能只填“通过”掩盖缺项。

| PRD | 主阶段／测试组 | 必需证据 | 初始状态 |
| --- | --- | --- | --- |
| A01 | P2/P3/P7；T2/T3 | fixture 并行与浏览器记录；最终两张沙发图的真实图片／视频任务和产物。 | 未跑 |
| A02 | P2/P6；T2/T6 | 11 任务、两画布、两个执行实例的名额峰值与提交计数。 | 未跑 |
| A03 | P2；T2 | 等待输入不占名额、受限模型不阻塞其他就绪任务。 | 未跑 |
| A04 | P2/P3；T2/T3 | 排队／运行后改草稿，实际提交快照与编辑内容分别正确。 | 未跑 |
| A05 | P2/P3；T2/T3 | A 重做时启动 B，B 使用旧图 hash，A 后来完成不能替换它。 | 未跑 |
| A06 | P2；T2 | B 绑定指定上游 taskId，成功用其 outputAssetId，失败时阻塞。 | 未跑 |
| A07 | P2/P3；T2/T3 | 缺上游且无任务时的 UI 提示，生成 POST 为零。 | 未跑 |
| A08 | P3/P5；T3/T5 | 成功覆盖、失败保留、下载失败保留，无版本浏览 UI。 | 未跑 |
| A09 | P1/P3；T1/T3 | 复制后结果和设置相同、节点身份不同、生成计数不增加。 | 未跑 |
| A10 | P1/P3；T1/T3 | 多选副本连线映射及外部输入／输出边界。 | 未跑 |
| A11 | P2/P3；T2/T3 | 预览与实际任务数量一致，起点复用和重新生成两条路径。 | 未跑 |
| A12 | P2；T2 | 依赖支阻塞、独立支成功、已成功节点不自动重跑。 | 未跑 |
| A13 | P1/P3/P4；T1/T3/T4 | 多参提及稳定、断开失效、模型切换不丢输入、无效 POST 为零。 | 未跑 |
| A14 | P3；T3 | 真浏览器连线落点、Esc、撤销／断线的状态与画面。 | 未跑 |
| A15 | P3/P5/P6；T3/T5/T6 | 刷新、关页、换画布后任务推进与恢复，全局定位正确。 | 未跑 |
| A16 | P5；T5 | 独立进程中断／重启，远端身份、下载和用量去重。 | 未跑 |
| A17 | P5；T5 | 丢失响应进入待核查，POST 不重发，可能的名额保留。 | 未跑 |
| A18 | P2/P5；T2/T5 | 重复点击、取消、删节点、迟到回执／回写的执行证据。 | 未跑 |
| A19 | P6；T6 | ZIP 解包清单、内容 hash、缺失文件错误与导出快照。 | 未跑 |
| A20 | P6；T6 | 指定规模下连续交互记录、机器／浏览器／素材信息。 | 未跑 |
| A21 | P4/P7；T4/R01–R08 | 精确模型、真实请求和远端 ID、本地产物及媒体检查；必含七牛可灵与 Seedance 2.5 的画布证据。 | 未跑 |
| A22 | P0/P1/P6；T1/T6/旧回归 | 数据根与进程隔离子项已通过（第 0 节）；仍缺画布旧链路兼容与三态主题浏览器证据。 | 未跑（整项） |

## 5. 真实样本计划：P7 执行前填写

这是最小覆盖模板，不是已经授权的调用清单。Luna 先填具体路径、模型、提示词、次数和额度，再对照会话已有授权；仅在授权缺失时请用户确认具体计划。已获授权的相同范围不重复询问。

| 样本 | 覆盖目标 | 建议最小输入 | 预期检查 |
| --- | --- | --- | --- |
| R01 | 文生图 | 纯文本，无伪造底图。 | 可用本地图片、正确任务身份与交付规格。 |
| R02 | 图生图与图片多参考 | 一张沙发底图加一张参考图，提示词区分用途。 | 两图及顺序确实进入请求，当前结果可复制和继续生成。 |
| R03 | 文生视频 | 纯文本、明确比例／时长。 | 无伪造首帧，有可播放本地视频。 |
| R04 | 图生视频与双任务业务场景 | 另一张沙发图作首帧；可与 R02 的独立任务并行。 | 图片与视频各自推进、输出归属正确。 |
| R05 | 七牛可灵 3.0 严格首尾帧 | qiniuyun/kling-3.0，两张不同图片，经画布映射 images[0] 与 end_image_url；优先复用既有 3:4／3 或 6 秒合同。 | 画布输入身份、首尾对应、实际时长／尺寸和本地交付；不宣称逐像素无损或智能分镜独立因果。 |
| R06 | Seedance 2.5 双图参考 | doubao-seedance-2-5-260628，两张参考图，1080p 参数，从画布提交。 | 类型、顺序、用途、实际尺寸与本地交付；允许首帧重构，不以严格首尾帧锚定作为通过要求。 |
| R07 | 图片加参考视频 | 一张图与一段合规短视频，可复用前面已保存且适用的产物。 | 视频参考没有丢失，生成结果可播放。 |
| R08 | 图片或视频加参考音频 | 与模型支持条件一致的视觉素材和短音频。 | 音频参考实际传入，与输出声音开关分别记录。 |

R05/R06 是两个必需模型的画布验收，不因代理健康或旧成片存在而跳过；既有素材与合同可以复用。R01/R03/R07/R08 按实际已验证公司能力选模型，不要求这两个模型承担所有模式，不因新增模型就自动开放纯文本或音视频参考。

一个样本可以覆盖多个 A 编号；不要为覆盖表重复创建相同生成任务。每个样本建议先做一次提交，先复用合适已有素材或前序产物，不直接展开成多个模型与尺寸的笛卡尔积。失败追加请求需说明原因、处理前一次远端状态并遵守已授权次数／额度。

每条样本在执行前完整填写：

- 样本 ID、对应 A 编号、精确供应商／模型别名、输入模式与能力证据状态。
- 本地素材绝对路径、内容 hash、媒体规格、是否需要 COS；图片／视频／音频分别列出顺序与用途。
- 实际提示词、输出参数、期望生成调用次数、可接受额度以及已有授权依据。未知费用明确写未知，不编造价格。
- 启动方式、输入是否合法的本地检查、正在占用的任务与端口／进程归属。
- 失败后的查询／补下载方案；提交不明时不自动重新生成。

执行后追加：本地 taskId、远端 ID、开始结束时间、真实终态、本地产物路径、实际尺寸／时长／MIME、预览结论、计费记录状态。截图或响应摘要脱敏，临时签名参数和密钥不进证据文件。

候选组合只有实际公司链路验证后才标 verified。没有映射依据的字段应先核对公司转发合同；不能用试出 HTTP 200 代替素材生效和结果可用的检查。

## 6. 执行回执模板

Luna 在 docs/2026-09-09-无限画布-执行记录.md 按阶段填写以下内容，原始产物放在本次独立的 outputs/canvas-validation/ 子目录：

```text
阶段：P__
状态：未开始 / 进行中 / 通过 / 失败 / 阻塞
工作区与 HEAD：
实际改动文件：
对应 PRD 验收编号：
执行命令、退出码与结果摘要：
自动化证据路径：
浏览器证据路径：
真实模型证据或“未执行”：
旧模块回归与基线遗留问题：
与计划的必要调整及理由：
下一条具体动作：
```

最终交付必须包含：可复核的工作区／提交状态、准确启动方式、P0–P7 状态、A01–A22 覆盖、已验证模型组合、恢复／停止说明、用户体验验收及未跑项。没有真实样本时只能交付“本地实现与 fixture 验证完成，真实验收待办”；没有浏览器验收时不能用 build 通过替代。

本计划不附带工期保证；按实际阶段证据判断进度。中断、预算变化或平台不可用时保留可继续的代码与记录，不以省略功能的方式宣称任务完成。
