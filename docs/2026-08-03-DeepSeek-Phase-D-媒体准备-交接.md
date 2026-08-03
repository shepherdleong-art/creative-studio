# DeepSeek Phase D 交接：媒体准备（代理缓存与 LUT）

> 日期：2026-08-03
> 仓库：`/Users/liangpeijian/for-cc/creative-studio`
> 分支：`mixcut01`
> 基线提交：`43792e1 feat: complete batch mixcut phase C scheduler`
> 目标：只完成 Phase D，并停在 Phase E 之前等待 Codex 独立验收。

## 1. 接手前先确认现场

不要直接开始写代码。先执行并报告：

```bash
pwd
git status --short --branch
git log -5 --oneline --decorate
```

当前已知现场：

- Phase A、B、C 已提交；Phase C 的持久任务调度基线是 `43792e1`。
- `mixcut01` 当前领先远端，未经用户明确要求不要 push。
- `docs/2026-08-01-DeepSeek-Phase-0.3-交接.md` 是未跟踪的用户文件，不属于 Phase D；不得修改、删除或顺手提交。
- 工作树若出现其他新改动，先判断来源并保护，不要 `git add -A`、不要重置用户工作。

## 2. 必读文档，不要复制参考项目技术栈

按顺序阅读：

1. `AGENTS.md`
2. `docs/superpowers/plans/2026-08-01-batch-mixcut-implementation.md`
3. `docs/superpowers/specs/2026-07-31-batch-mixcut-desktop-prd.md` 的代理、LUT、媒体测试与 Out of Scope 部分
4. `docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/assets/07-集中式代理缓存与LUT链路设计.md`
5. `docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/assets/04-项目素材库与原文件引用设计.md`
6. `docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/assets/05-可恢复任务调度与自动资源控制设计.md`
7. 现有实现：`lib/batch-production/{schema,tasks,scheduler,runner,executors,batch-flow,media-catalog}.ts`、`lib/ffmpeg.ts`、`components/batch-production/BatchPreparationPanel.tsx`

Creative Studio 继续使用 Next.js / React / SQLite / FFmpeg / `dataRoot()` / 现有 final-edit 领域模型。禁止复制参考项目的 Python、Electron renderer、MUI/Tailwind 状态机，也禁止新增 `mixcut_sessions` 或第二套代理任务队列。

## 3. Phase D 的完成定义

Phase D 只负责“媒体准备”：

- 用户默认直接使用原片预览，不自动生成代理。
- 用户可以按当前、选中、当前批次范围明确请求代理。
- 用户可以导入受管 `.cube` LUT，随后对明确选择的素材应用或关闭。
- LUT 选择成为批次版本的冻结输入；普通代理开关只是可重建的本机预览偏好。
- 代理集中写入 `dataRoot()/storage/cache/proxies/<projectId>/<assetId>/<proxyKey>.mp4`，绝不写回原片目录。
- 代理生成复用 Phase C 的 ProductionScheduler，显示真实 FFmpeg 进度，支持任务级暂停、继续、取消和失败重试。
- 预览能在匹配代理和原片间安全解析；LUT 已启用但色彩代理未就绪时必须明确警告。
- 清理选中素材、当前项目或全部代理时，只删除受控缓存；正在读写的文件跳过或延后删除。
- LUT 有历史引用时只能归档；没有引用时才允许物理清理。
- Phase D 建立共享 ColorPipeline 和“正式输出只认原片”的前置合同，但不实现 Phase E 的联合分配、正式 renderer 或 artifact 发布。

## 4. 不可破坏的领域不变量

### 4.1 三种身份严格分离

- 原片／项目素材：身份来自项目素材 ID 与完整内容指纹；正式输出的唯一视频来源。
- 代理：由项目、素材、原片指纹、代理 profile、LUT 指纹和色彩链版本形成的派生缓存；可删除、可重建、不是项目素材。
- LUT：受管内容资产，以完整 SHA-256 为身份；批次版本只引用已验证内容。

禁止把代理注册为新的 `batch_assets`，禁止给代理创建素材分析历史，禁止在原片离线时把代理升级成正式来源。

### 4.2 LUT 是冻结输入，代理请求不是

现有 `createBatchSnapshot` 的输入身份只有脚本、份数、`assetId + analysisId` 和 defaults。Phase D 必须把每份素材的色彩快照加入整体输入比较和冻结：

- 关闭，或引用一个项目内已验证 LUT。
- 固定 LUT ID、LUT 完整指纹、色彩链版本、`lut3d` 插值策略和 SDR 输出合同。
- LUT 变化后创建新 draft 版本，不得更新 frozen 版本。
- frozen 版本仍引用原来的受管 LUT；同名新 LUT 不能替换旧内容。
- “是否已经生成代理”“代理文件路径”“缓存大小”不得进入正式批次输入身份。

### 4.3 正式输出合同

Phase D 可以实现并验证正式输出前置检查，但不建立正式 render 任务。前置检查必须要求：

- 至少一个原片来源在线，且重新核验的完整内容指纹匹配。
- 冻结 LUT 文件存在且完整内容指纹匹配。
- 当前 FFmpeg 支持冻结的色彩链。

任何一项不满足都返回可操作的阻塞原因；不得回退到代理、关闭 LUT、采用同名新 LUT 或继续读取已经变化的路径。

## 5. 开工前必须先补的技术前提

### 5.1 FFmpeg 真取消

当前 `runFfmpeg` 没有 `AbortSignal`。在接入代理 executor 前，先用回归测试驱动以下合同：

- `runFfmpeg(..., { signal })` 能终止直接 FFmpeg 子进程。
- 中止后等待子进程退出再 reject，错误可区分为 abort。
- 移除 abort listener 和 timeout，禁止重复 settle。
- 代理 executor 在 abort、失败、超时后删除自己的临时文件，不删除其他任务文件。
- 跨平台整棵孙进程树回收仍属于 Phase G；本阶段至少完成直接子进程合作取消并如实报告未验收层。

### 5.2 扩展统一任务模型，不能复用错误语义

现有 SQLite CHECK 和 TypeScript 类型只允许 `asset_prepare | render`。追加新 migration，安全支持：

- `workType = proxy_generate`
- `targetKind = proxy_request`

要求：

- 不修改已发布 migration v1–v13。
- 如果重建 `batch_tasks`，必须保留全部 v13 字段、历史任务、尝试、外键和索引；迁移后跑 `PRAGMA foreign_key_check`。
- 不得把代理任务伪装成 `asset_prepare`。
- 不得新建独立内存队列；proxy executor 必须注册到现有 `BatchTaskExecutor` / runner / scheduler。
- requestKey 基于稳定代理请求身份；同一业务动作重复提交不产生重复任务、重复 attempt 或重复文件。

### 5.3 增加任务级控制

批次级 pause/stop 不能代替单个代理任务控制。扩展现有 scheduler，使心跳同时检查：

- `batch_productions.controlState`
- 当前 `batch_tasks.expectedState`

至少提供代理任务的任务级 pause、resume、cancel；清理代理时只能控制相关 proxy 任务，不能停止整个批次。取消后用户明确重新启用时，可以在同一业务任务上形成新 attempt，不能被历史 cancelled requestKey 永久卡死。

### 5.4 代理重任务安全档

本阶段只实现媒体准备所需的窄资源合同：

- proxy executor 为重本地任务，默认单并发。
- 开始写代理前按 `dataRoot()` 所在磁盘做空间预检；不足时不启动 FFmpeg，并返回可操作阻塞原因。
- 普通 CPU 压力不自动降速；完整的动态内存/性能策略仍不在 Phase D。
- 代理 profile 必须有版本号。不要把当前参数当成永远不变的产品合同。

在真正编码前，先在实施记录中写明首个 profile 的分辨率、codec、pixel format、音轨、GOP/拖动策略和实现版本，并用本机真实 FFmpeg 样例证明可解码、可拖动、时长误差合格。若没有足够样本，停止并报告这个阻塞，不要静默发明“最终规格”。

## 6. 建议的深 Module 与 Interface

名称可以微调，但职责和依赖方向不能打散。

### 6.1 ProxyMediaCache Module

外部 Interface 只表达：

- 为明确选择的素材与色彩快照请求／恢复代理任务。
- 为预览解析当前可用的安全媒体来源，并持有／释放读取租约。
- 查询缓存占用，按选中素材、项目或全局执行安全清理。

Module 内隐藏：proxyKey、路径、来源重新核验、临时文件、原子发布、生成去重、使用锁、pending-delete 和实际释放空间统计。页面、route、分析代码不得自行拼代理路径或重新判断匹配关系。

### 6.2 LutCatalog Module

外部 Interface 只表达导入并验证、列出项目可用 LUT、读取已核验受管内容、归档和安全清理。

当前 Phase D 允许浏览器文件选择后上传文件内容；服务端不得接受任意本机绝对路径。未来 Phase G 的桌面文件选择器是另一 Adapter，不要现在引入 Electron。

LUT 导入至少完成：普通文件／扩展名／大小限制、完整 SHA-256、重复内容复用、同名不同内容不覆盖、FFmpeg `lut3d` 小样真实验证、临时文件加原子落位。

### 6.3 ColorPipeline Module

外部 Interface 接受已冻结且验证过的色彩快照，返回代理、抽帧和未来 renderer 共用的 FFmpeg filter 描述。LUT 路径转义、插值、滤镜顺序、版本和 SDR 约束只在此 Implementation 中维护。

Phase D 的代理 executor 必须消费它；Phase E 的正式 renderer 后续也只能消费同一 Interface，不能另写一套 LUT 逻辑。

## 7. 数据模型只规定行为，不预设随意表名

追加 migration 时至少需要表达：

- 项目作用域的 LUT 内容身份、受管相对路径、显示名、验证信息、active/archived 状态。
- 批次版本中每份素材的显式色彩快照；关闭也必须是确定状态。
- 代理缓存项：proxyKey、项目、素材、profile/color 版本、受管相对路径、生成状态、媒体元数据、大小、校验和、pending-delete。
- 每个批次版本／素材对缓存的明确代理使用请求，使清理后不会自动重建。
- 正在生成与正在读取的占用信息；Phase D 至少保证单进程内不会一边使用一边删除，并持久化 pending-delete。跨进程第二实例验收属于 Phase G。

所有数据库路径保存为相对 `dataRoot()/storage` 的受管路径。用户 linked 原片定位只经 `media-catalog.ts` 解析和重新验指纹，不把未核验绝对路径写进任务 result、批次快照或日志。

## 8. 推荐实施顺序（严格串行）

### D0：先写红测试并冻结合同

新增测试，证明当前实现缺少：FFmpeg abort、proxy task schema、任务级取消、LUT 冻结身份、代理缓存清理安全。先运行并记录预期失败，再实现。

### D1：迁移与纯领域接口

- 追加 migration 与完整 schema 验证。
- 实现 LUT 身份、色彩快照、代理请求／缓存领域接口。
- 把 LUT 快照纳入 `createBatchSnapshot` 的幂等比较、创建和详情恢复。
- frozen 版本修改必须失败；同输入重复确认保持幂等。

### D2：FFmpeg、调度和代理缓存

- 为 `runFfmpeg` 增加真 abort。
- 扩展现有任务类型、任务级控制和重本地单并发。
- 实现 ProxyMediaCache、proxy executor、真实进度、临时文件与原子发布。
- 原片、LUT、profile 或 color pipeline 变化后形成新 proxyKey，旧缓存不再匹配。

### D3：LUT 与预览来源

- 实现 LutCatalog 与 ColorPipeline。
- LUT 导入只进入项目列表，不自动应用。
- 应用 LUT 后请求匹配色彩代理；就绪前显示“尚未应用 LUT”的原片警告。
- 原片离线但代理在线时允许预览并明确标注正式输出不可用。
- 预览 route 必须验证项目／批次／素材所有权，并通过 ProxyMediaCache 的读取租约提供媒体。

### D4：最小 UI 与清理入口

- 在现有批量准备区支持当前／选中／当前批次素材代理请求。
- 支持 LUT 导入、列表、对选中素材应用和关闭。
- 显示真实任务状态、完成数量、单文件进度、失败与重试。
- 支持清理选中素材和当前项目代理；设置页提供显示预计释放空间后的全局清理。
- 清理返回实际删除数量、实际释放空间和跳过数量；使用中的文件进入 pending-delete，释放后完成。

不要在 Phase D 重做完整批次工作区视觉，也不要实现 Phase E 成片卡片编辑器。

### D5：独立验证后停下

必须验证：

- v13 临时旧库升级到新版本，数据、外键、索引和历史 attempt 保留。
- migration 幂等、SQL 注入失败回滚、共享 readiness/备份/锁/审计仍有效。
- 项目 A 不能读取、应用或清理项目 B 的 LUT／代理。
- 同 proxyKey 重复请求只形成一份有效缓存；失败重试只增加 attempt。
- 真实 FFmpeg 代理有真实进度；暂停／取消后 FFmpeg 停止且无正式半成品。
- 横竖视频时间从零开始，代理时长与原片在冻结误差合同内。
- 合法／损坏 `.cube` 走真实 `lut3d` 验证；同内容复用、同名不同内容不覆盖。
- LUT 变化形成新色彩快照和 proxyKey，不改 frozen 版本。
- 原片与 LUT 文件执行前后 SHA-256 不变。
- 清理仅作用于受控代理根；符号链接、路径越界、任意绝对路径全部拒绝。
- 使用中清理不会竞争删除；释放后 pending-delete 完成。
- 清空代理后，冻结输入和正式输出前置检查仍指向原片与受管 LUT。
- API 继续统一 readiness、no-store 和 400/404/409/503 错误语义。
- 单条精准混剪、模块 1–4 和既有 final-edit 回归不受影响。

## 9. 验证命令

按改动补同名专项测试，并至少执行：

```bash
node scripts/<新增的-phase-d-测试>.test.ts
node scripts/batch-schema-upgrade.test.ts
node scripts/batch-schema-rollback-versions.test.ts
node scripts/batch-scheduler.test.ts
node scripts/batch-runner.test.ts
node scripts/batch-batch-flow.test.ts
node scripts/batch-media-catalog.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

最后运行全部非 Playwright 测试。若环境允许，再跑对应 Playwright；如果本地监听权限阻塞，必须明确报告 blocked，不能写成 passed。

真实手机 4K、相机 LOG、外置磁盘、Windows 安装包和跨平台进程树属于更高验收层。使用合成短视频或少量本机样例通过，只能报告为本地真实 FFmpeg 证据，不能冒充这些层已经验收。

## 10. 本阶段禁止事项

- 不实现联合素材分配、差异性时间线、锁定／排除和重新分配。
- 不建立正式 render 任务，不发布视频／封面 artifact，不修改正式导出命名。
- 不新增供应商，不发起真实 AI、TTS、腾讯云或媒体网关请求。
- 不实现 Electron、安装包、桌面生命周期或跨平台整棵进程树回收。
- 不实现 HDR、ACES、专业调色面板或自动识别 Log 并替用户选择 LUT。
- 不修改、移动、覆盖或删除任何原片和用户原始 LUT。
- 不修改已发布 migration；只追加。
- 不 push；没有明确授权时也不要提交。

## 11. 交付报告与强制停点

完成后报告：

1. 修改文件清单与各自职责。
2. 新 migration 版本及旧库保留证据。
3. 每条测试命令和准确结果。
4. 真实 FFmpeg 使用了什么样例、证明了什么。
5. 没有运行或被环境阻塞的层。
6. 与本交接文档仍有差异的判断和理由。
7. `git status --short` 与 `git diff --check`。

然后停下：

> Phase D 实现和自测完成，等待 Codex 独立 review。不得继续 Phase E，不得自行扩大范围。

## 12. 可直接粘贴给 DeepSeek V4 Flash 的启动提示词

```text
请在 /Users/liangpeijian/for-cc/creative-studio 的 mixcut01 分支执行 Phase D 媒体准备。

开始前完整阅读并严格遵守：
/Users/liangpeijian/for-cc/creative-studio/docs/2026-08-03-DeepSeek-Phase-D-媒体准备-交接.md

先检查 pwd、git status --short --branch、git log -5 --oneline --decorate，并保护所有既有或未跟踪用户文件。按交接文档 D0→D5 串行实施，先写会失败的行为测试，再实现。必须复用现有 batch-production schema/readiness/ProductionScheduler/dataRoot/FFmpeg/final-edit 模型；不得新增第二套队列、mixcut_sessions、Electron、正式 render 或真实外部供应商调用。

重点不能遗漏：FFmpeg 真 AbortSignal；proxy_generate/proxy_request 的追加迁移；任务级暂停/继续/取消；LUT 进入批次版本冻结身份而代理请求不进入；ProxyMediaCache/LutCatalog/ColorPipeline 三个深 Module；集中代理目录、原子发布、使用锁与安全清理；最终输出只认指纹一致原片的前置合同。

完成全部专项测试、非 Playwright 全量测试、TypeScript、lint、build 后，按交接文档格式报告证据并停在 Phase D，等待 Codex 独立 review。不要进入 Phase E，不要 push；未经明确授权不要 commit。
```
