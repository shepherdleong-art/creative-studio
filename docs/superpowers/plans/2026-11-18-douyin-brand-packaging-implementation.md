# 抖音品牌包装（E）实施计划

> 日期：2026-11-18
> 权威规格：`docs/superpowers/specs/2026-11-18-douyin-brand-packaging-design.md`
> 当前状态：已纳入首轮 M1–M8、第二轮 R1–R4、第三轮 T1–T3、第四轮 F1–F3、第五轮 V1–V4、第六轮修正与优化；仅完成设计与计划，尚未修改业务代码
> 执行边界：单条与批量最终都交付；按依赖顺序分阶段验收，不提交或推送 Git，除非用户另行明确要求

## 1. 实施原则

- 第五套模板独立，旧 A/B/C/D、classic/1、`lib/film-render` 和 classic 构建资产零视觉改动。
- 不新增数据库表，不建立跨脚本或跨成片内容继承。
- 单条沿用 final-edit group 包装作用域，批量沿用 output version arrangement；初始化后不再读取实时项目产品数据。
- 封面、正文、尾帧共用 `overlay-douyin` 模板，不增加第二套封面 SVG 字体排版或 React 专用导出动画。
- AI 只负责内容与样式建议，时间只来自口播对齐；显式生成命令经候选校验和 CAS 后提交。
- 所有随机结果一次持久化；预览、刷新、撤销重做和正式导出不重抽。
- 每阶段先补失败测试，再实现并运行同名测试；真实导出未完成前不宣称闭环。

## 2. 现状中必须处理的接入点

1. 模板白名单不仅位于 UI，还在 `packaging-vars.ts`、`packaging-runtime.ts`、`production-codes.ts`，必须同步增加 E。
2. 批量独立封面任务目前只跑 FFmpeg/旧标题，不运行 HyperFrames；必须接入共享抖音封面覆盖层生成器。
3. 单条底图和批量底图都可能提前合成旧 `title.png`，抖音模板必须在底图阶段抑制旧标题，而非事后遮盖。
4. 现有 `pointCues` 只有 `{id,text,startSec,endSec}`，抖音使用独立 `douyin.points`，不改旧 cue 语义。
5. 单条包装为组级，批量为 output version 级；本需求不改变这两种所有权。
6. `initialBatchPackagingConfig` 和单条预览当前可能重新读取项目卖点；抖音初始化完成后必须只读持久化 `douyin` 配置。
7. GIF 不能直接参与逐帧正式渲染；必须构建期解帧，并在预览与导出中按时间查帧。
8. 两端都没有现成的“已有成片就地切画幅”命令；E 启用必须新增原子命令，单条还要处理 group 下全部 variants。
9. 批量独立 `coverContractHash` 当前不含包装；必须纳入封面相关 E 字段，正文和尾帧修改不得误触发封面重排。
10. 单条 Canvas 与批量成品 JPG 回退都可能和 E 覆盖层重影；批量结构签名也必须识别 E。
11. 单条预览、保存后和入队前会隐式执行旧卖点提取；E 必须先分流，保证零供应商调用、零数据库写入。
12. 旧卖点均分回退与 `allowPackagingPlaceholder` 不适用于 E；无真实对齐不得生成定时卖点，封面必填不得被旧参数绕过。
13. 单条 variants 可独立剪口播；共享自动卖点只能采用共同可听且映射到相同成片时间的句段，候选要校验全部 variant 音轨修订。
14. 启用／撤销 E 是包装与画幅的复合历史；主动切回 A–D 若保留 9:16，旧 Resolution 必须重验。
15. 批量预览画布与封面编辑器的目标可能不同；分别随 `previewFilm` 与 `activeFilm` 读取尺寸，不能使用整批顶栏值或共用一个目标。
16. 单条 worker 当前先发布裸封面再排包装子任务；E 必须把完整配置与资源身份传入子任务，并延后首次封面发布与登记。
17. 批量 `previewFilm` 与 `activeFilm` 可能不同；画布与封面编辑器必须分别读取各自目标的实际尺寸。
18. 自动卖点提交后音轨仍会变化；必须保存 timingBasisHash，派生 stale 并由用户显式重算，过期项阻断正式导出。
19. 封面下载会回退内部 JPG，包装视频先发布且封面覆盖失败仅警告；E 必须补下载门禁、显式跳过语义和成对中断恢复。
20. 父任务视频下载也会回退内部 MP4；E 的视频与封面必须共享同一交付状态。
21. 重试和跳过可同时通过 failed 前置判断；必须在文件副作用前原子互斥，跳过还要幂等返回首次结果。
22. 单条旧任务按冻结快照完成，批量旧合同结果在 runner 提交时被拒绝；两端不能用同一句验收替代。
23. 批量片段可有独立 preset，启用 E 必须同时处理根与全部显式片段，历史保存各片段原值与继承状态。
24. 普通批量历史缺少命令时的 outputVersionId／预期修订，恢复必须补双侧 CAS，不能读取当前视图 revision 代替。
25. 跳过包装会重新分配无 E 文件名，实际目标与预留必须在任何文件写入前持久化，前端轮询覆盖 publishing_original。
26. 只有启用 E 才能把 E 字段加入封面／完整合同；A–D 历史输入与休眠 E 数据必须沿用旧任务键。
27. 批量显示字幕和 TTS 降级结果都可能被标为 aligned；E 必须读取原始 degraded／来源，不能把标签当真实对齐证明。
28. 两个活跃任务可争用同一文件名；预留锁必须携带 reservationId/jobId/目标路径，成功取锁后才持久化计划并按归属恢复。

## 3. P0 — 基线、原始素材与视觉标定

### 3.1 基线

- 记录 `git status`，确认不覆盖其他未提交工作。
- 运行现有包装、封面、单条/批量渲染的相关基线测试，记录既有失败，不把历史漂移算成本次回归。
- 确认 Node、Chromium、FFmpeg、sharp 和真实浏览器测试前提。

### 3.2 素材装配

新增 `scripts/build-douyin-packaging-assets.mjs`，通过显式 `--source` 读取用户素材目录，不在代码或 manifest 中保存本机绝对路径。

输出到 `packaging/templates/overlay-douyin/assets/`：

- 三款方正兰亭字体与括号字体；
- 横版 LOGO 黑字／白字 PNG；
- 三色箭头裁切后的 PNG 帧序列；
- `manifest.json`：原始素材 SHA-256、输出文件 SHA-256、尺寸、透明包围框、原始画布锚点、逐帧时长和循环信息。

构建校验：

- 字体可读取，LOGO 为 RGBA 且比例未被改变；
- GIF disposal 与透明合成正确；
- 三色帧数、累计时长和锚点符合源文件；
- 不复制 PSD、Thumbs.db、PDF 或无关源文件。

### 3.3 视觉标定

新增只读标定页／脚本，用真实 Chromium、实际 TTF 和参考文案生成：

- 三张封面样本：一行产品名、两行产品名、不同长度产品卖点；
- 三组正文样本：普通高亮、高亮＋1.35 倍放大、主卖点＋补充小字；
- 尾帧三色箭头与 LOGO 样本，包括“浅封面＋深尾帧”和“深封面＋浅尾帧”；auto 分别按封面与尾帧 LOGO 区域亮度选黑字／白字并冻结解析结果；
- 顶部／右侧／底部安全区参考层。

形成集中式 `visual-tokens` 常量与截图，交由用户确认后再进入完整模板开发。PDF 中的 16–25 不直接作为输出像素。

### 验收

- 素材构建可重复，二次运行哈希一致。
- 所有箭头帧无背景污染、无错位，透明包围框与锚点吻合。
- 用户确认封面、正文和尾帧标定样本。

## 4. P1 — 配置、模板注册与纯领域命令

### 4.1 领域模块

新增：

- `lib/media-core/douyin-packaging.ts`：配置类型、版本、清洗、严格校验、默认值、色板、封面必填校验。
- `lib/media-core/douyin-points.ts`：runs 合并、文本编辑、划词样式、批量选择应用、按条随机配色、放大切换、编辑标记、`timingOrigin/timingBasisHash` 与 stale 派生。
- `lib/media-core/douyin-assets.ts`：字体、LOGO、括号、箭头帧 manifest 解析与资源身份。
- `lib/media-core/packaging-template-capabilities.ts`：集中声明旧卖点、贴纸、v2 自动布局和抖音卖点能力，供预览、保存、入队与导出提前分流。

修改：

- `lib/media-core/packaging-vars.ts`：注册 `overlay-douyin`，持久化 `douyin` 配置，旧模板不读取该字段。
- `lib/media-core/packaging-runtime.ts`：模板目录白名单和时间线变量透传。
- `components/packaging/PackagingTemplates.tsx`：新增 E 模板卡片。
- `lib/media-core/production-codes.ts`：新增生产码 E 及文件命名测试。

### 4.2 一次性预填

- 预填优先级为：当前可用且资格合格的详情页修订卖点库 → 旧 `projects.productName/sellingPointsJson` → 留空手填。禁用或不合格条目不采用；旧 `coverTitle`、脚本封面标题及其拆分结果不得充当产品名和产品卖点。
- 把预填结果复制到 `douyin.cover`，并把实际采用的证据文本、`sourceKind`、来源 ID／旧数组索引、库修订、`eligible` 与资格说明冻结到 `douyin.evidence`；只有 eligible 条目进入生成。后续保存、生成、预览和渲染不再调用实时项目数据补齐。
- 产品名称或产品卖点为空时保留必填状态，不从口播正文猜测。
- `inputHash` 包含冻结证据、当前配置与真实口播锚点；修改实时项目卖点库不得改变已有 E 的证据输入。

### 4.3 画幅与模板原子启用

- 新增共享 `assertDouyinAspectRatio`，在保存、预览和导出边界校验 1080×1920。
- 单条新增 `enable_douyin_packaging` 原子命令：携带 group 与相关 variants 的 expectedRevision；存在多个 variants 时明确提示并同事务整组统一 9:16，随后启用 E，任一步失败整组零写入。
- 批量新增对应原子命令：仅修改当前 output version，校验 `expectedOutputVersionId + expectedEditRevision` 并按现有规则清审核、使旧渲染失效；同时处理根 `arrangement.preset` 与全部显式 `clip.preset`，确保每个片段有效输出均为 1080×1920，历史保存各片段原值与显式／继承状态。
- 不调用或假定存在通用画幅命令，不拆成两步，不允许画幅已写而模板冲突的半完成状态；刷新重试重新读取当前 revision。
- 启用命令生成复合 before/after：完整包装、每个受影响 variant 的画幅、随机值、旧布局资源身份；批量快照增加根与各片段 `preset` 及显式／继承状态；每条历史在命令成功时记录 `outputVersionId + expectedEditRevision`，恢复事务同时校验，撤销成功后以返回的新 revision 作为重做条件。
- 撤销启用一次恢复原模板与各成片原画幅，重做恢复同一 E；主动切回 A–D 且保留 9:16 时只恢复内容，旧 Resolution 标 stale 并重验。所有恢复继续 CAS，不覆盖更新编辑。

### 4.4 纯命令测试

新增 `scripts/douyin-packaging.test.ts`：

- 配置清洗、未知版本拒绝、旧模板兼容；
- runs 拆分合并、白色／黑色基础文字、白色放大；
- 文案／样式／位置／时间独立编辑标记，runs 在重生成时作为文案＋样式共同体保护；
- 批量选择使用 pointId＋全文偏移，跨 runs 应用、合并后继续放大原选区，一次生成 before/after；
- 语义配色与随机配色按条统一、色系均衡、结果可注入随机源复现；
- 无卖点时箭头 fallback 在创建写命令中随机一次并固定，同起点卖点按稳定 ID 决胜；
- 原子启用的取消、成功、版本冲突零写入、单条多 variants 与刷新重试；启用→撤销→重做和主动切回后的画幅、随机值、Resolution 与真实导出；
- 数字＋单位、中文、空白与标点的稳定词块边界，刷新与 runs 合并后保持一致；
- E 不进入旧卖点／贴纸／v2 能力，A–D 往返恢复；
- 封面必填门禁不受旧 `allowPackagingPlaceholder` 影响。
- 自动卖点保存后音轨变化派生 stale，手调转 manual、删除恢复、显式重算与过期导出阻断；只改封面不触发 stale；单条冻结任务不追溯，批量旧合同结果被拒绝。

## 5. P2 — 抖音模板与确定性预览运行时

### 5.1 模板

新增 `packaging/templates/overlay-douyin/index.html` 及模板私有运行时：

- 封面：LOGO、产品名、品牌色括号、产品卖点，20 帧内稳定可见。
- 正文：runs 分段渲染、卖点级高亮色、基础色、1.35 倍放大、可选小字、真实换行与基线对齐。
- 尾帧：末 60 帧默认显示 LOGO 和箭头，正文不足时按规格夹取。
- 安全区：自动位置居中偏下；多条同屏只做紧凑平移避让；手动布局优先。
- 编辑桥：卖点选中、拖动、文字定位；手动拖动后不覆盖用户坐标。

### 5.2 箭头播放器

- 预加载并 `decode()` 当前色系的 PNG 帧。
- 根据累计帧时长表，把输出时间映射到唯一帧索引。
- 按 manifest 的原始锚点贴回 1080×1920 画布。
- seek、暂停、撤销重做和正式逐帧渲染共用同一纯函数。
- 自动颜色按 startSec、稳定 ID 取最后一条带高亮卖点的色系；无可用高亮时读持久化 fallback；手动模式只读手动色。
- 开始时间最晚为全片最后一个可见帧，动画相位从箭头自身开始帧计算；预览使用实际时间线总帧数，正式包装使用实际渲染总帧数，覆盖第 19／20 帧、短于 60 帧正文和中间 seek。

### 5.3 预览接入

修改：

- `lib/media-core/packaging-preview.ts`、`packaging-runtime.ts`；
- 单条 `app/api/final-edit-groups/[id]/packaging-preview/route.ts`；
- 批量 `app/api/batch-production/batches/[id]/outputs/[planId]/packaging-preview/route.ts`；
- `app/api/packaging/templates/[...path]/route.ts` 的允许资源类型（仅增加实际需要的帧／manifest 类型，不开放任意文件）。

预览行为同步修改：

- E 在旧 `ensurePackagingPointCues`、贴纸资源解析和 v2 布局门禁之前分流，预览 GET 零供应商调用、零数据库写入。
- 单条 `FinalEditPreview` 在 E 下不绘制旧 Canvas 标题。
- 批量 `BatchTimelinePreview` 区分裸底图和已含 E 标题的成品 JPG，回退分支不得重复叠加。
- `BatchReviewPreviewDock` 与单条 overlay key 纳入 E 的封面、runs、样式和尾帧结构；样式可经编辑桥实时更新，几何编辑不重载 iframe。

### 验收

新增 `scripts/douyin-template.test.ts`、`scripts/douyin-arrow-runtime.test.mjs`：

- 三种高亮色、黑色基础文字、白色放大、两行卖点、小字；
- 封面 20 帧稳定，正文与箭头不进入片头；
- 箭头在各时间点、seek 和循环边界帧号一致；
- 无卖点时箭头存在；
- 用一张封面、一条卖点和一种箭头完成冻结副本的 seek 与真实渲染试通，提前验证资源身份和运行目录，不等 P6 才暴露；
- 旧标题开启与成品 JPG 回退均无重影，连续改色立即可见且播放头稳定；
- 旧四套模板预览回归。

## 6. P3 — 共享 AI 生成与只读小样评测

### 6.1 共享生成器

新增 `lib/media-core/douyin-points-generator.ts`：

- 复用现有 script-provider 配置、日志脱敏和口播对齐数据；
- 输入当前成片真实对齐句段、持久化产品信息与 `douyin.evidence`，不得重读实时卖点库；
- 批量口播快照保留原始 `degraded` 和来源粒度；只有未降级句级／词级依据可用，显示字幕按字数拆分的 aligned 标签与历史不明快照均不可信；
- 要求结构化返回来源句段 IDs、runs、色系、小字、放大建议和证据锚点；
- 服务端根据真实口播对齐计算起止时间、片头偏移、音轨修剪、实际可听见区间、倍速与 24fps 量化；有效锚点在倍速下正确换算，估算字幕、均分回退、剪掉或静音句段不得生成自动时间；
- 单条多 variants 先求共同可听句段，再要求映射到相同成片时间区间；分歧句段跳过并说明，不把当前 variant 的时间强加给组内其他成片；
- 硬校验结构、色板、字数和来源归属；数字／价格／单位必须与对应属性共同出现在精确事实锚点中，“靠背高 61cm”不得证明“坐深 61cm”，无法可靠确认的改写只提示；
- 同义改写只形成“请核对”提示；
- 无供应商或失败时返回明确降级结果，不写半份候选。

### 6.2 候选命令

- 捕获 scopeId、expectedRevision、inputHash、clientOperationId。
- 用户点击生成后执行；候选成功且 CAS 匹配才自动提交。
- 候选期间允许取消；迟到响应不能覆盖新修订。
- 新旧卖点优先按 `originPointId`，其次按 `sourceCueIds` 唯一匹配；歧义时不自动覆盖，不按改写文案猜 ID。
- 默认只替换未编辑内容；`textEdited` 或 `styleEdited` 任一为真时保护整组 runs，位置和时间可独立处理；涉及已编辑内容时先确认并保存整体历史。
- 候选重试重新验证 revision、冻结证据和真实来源锚点；单条同时记录并复验全部参与计算的 variant IDs、revisions 和音轨输入哈希，任一变化旧候选零写入。
- 批量和单条复用同一生成器，不建立跨片缓存或共享内容层。

### 6.3 只读小样评测

新增独立评测脚本，只读用户选择的真实成片数据，输出：原句、AI 卖点、高亮、放大、证据、计算时间、校验结果。不得写项目数据库。

评测使用 `better-sqlite3` 的 `readonly: true, fileMustExist: true` 连接，供应商配置与成片数据显式注入生成器；不得经过会初始化、迁移或补种的 `getDb()`／供应商 store。网络成功与失败路径都只能写独立评测输出，不能通过默认连接回写项目库。

用户确认小样质量后再接正式 UI 生成命令。

### 验收

新增 `scripts/douyin-points-generator.test.ts`：

- AI 不掌握时间字段，有效真实锚点在倍速与片头偏移下换算正确；
- 非当前成片句段、虚构数字、非法色板和越界时间被拒绝；
- 无真实对齐、仅估算字幕、来源句被剪掉或静音时不生成定时卖点，已有手动内容和箭头保留；
- 长句拆两条显示字幕时第二条按字数推算的起点不可信；真实与降级词时间混合时仅可信句段生成，历史不明快照跳过；
- 同组两条 variants 只从共同可听且共同时间区间生成，AI 等待期间再剪任一 variant 音轨，旧候选零写入；
- 保存成功后改为 1.5 倍速或删除来源句，自动卖点 stale、显式重算与导出预检行为正确；只改封面不误报；单条已入队任务保持原快照，批量旧合同结果不得提交；
- 用只读打开的测试库分别跑供应商成功与失败，均能输出评测且项目库零写入；
- 手调时间后 AI 改写同一句、来源歧义、runs 手改保护和候选重试身份复验；
- 同义改写只警告；
- CAS 冲突、取消和迟到响应零写入；
- 无供应商降级标识明确。

## 7. P4 — 单条命令与全卖点清单编辑

### 7.1 后端

修改：

- `lib/final-edit/workspace.ts`：组级抖音配置保存、AI 生成命令、原子启用命令、revision/CAS、历史恢复与任务快照白名单。
- `lib/final-edit/packaging-cues.ts`：重写时显式保留 `douyin`；更重要的是预览、保存后和入队前按模板能力提前跳过旧提取，而不是仅在重写后补回字段。
- `app/api/final-edit-groups/[id]/route.ts`：接入显式生成、保存和原子启用命令，复用现有错误映射。
- `lib/final-edit/workspace.ts` 入队：直接校验 `douyin.cover`，旧 `allowPackagingPlaceholder` 不得绕过；跳过旧 v2 门禁并冻结完整抖音配置、冻结证据与资源身份。
- 音轨编辑后按 `timingBasisHash` 派生自动卖点 stale，不后台改写；显式重新对齐、手调转 manual、删除恢复均走现有 revision／历史，存在 stale 时入队预检阻断。
- `components/final-edit/FinalEditPreview.tsx`：E 下抑制旧 Canvas 标题。

### 7.2 共享编辑组件

新增：

- `components/packaging/DouyinPointsEditor.tsx`：全部卖点清单、空清单手动新增、词块、划词、单点即改、批量选择、批量应用；手动新增写入 `douyin.points`、`timingOrigin='manual'`，刷新可见且一次撤销回到空清单；选区绑定 pointId＋全文偏移，不绑定 run 下标；词块由全文确定性派生，数字＋单位为整体，中文分词、空白和标点规则统一。
- `components/packaging/DouyinCoverEditor.tsx`：产品名称、产品卖点和 LOGO 版本。
- `components/packaging/DouyinEndingEditor.tsx`：箭头颜色模式、色系和开始时机。

修改：

- `components/mixcut/PreviewStep.tsx`：接入封面／卖点／尾帧版块与生成 pending。
- `components/packaging/PackagingOverlay.tsx` 和编辑桥：位置拖动、清单联动、不强制跳播放头。
- `components/mixcut/MixcutTimeline.tsx`：复用现有卖点轨道调整时间，不引入贴纸轨道。

### 7.3 保存与历史

- 连续文本输入防抖合并为一次命令；切换成片或审核前显式 flush 当前片最后输入，使用编辑发起时的 planId/outputVersionId/editRevision，保存成功后才审核或自动推进，失败停留当前片并提示。
- 每轮批量样式应用一次提交、一次 revision、一次历史。
- 应用高亮后保留选择，继续放大不需要重选。
- 编辑样式不重建底片视频组件，不把包装编辑态加入底片 key。

### 验收

新增／扩展单条工作区测试与 Playwright：

- 清单内不选中卖点也能直接编辑；
- 单词、划词、跨卖点批量选择、随机配色、连续放大；
- 撤销重做、刷新、关闭再开启包装保持结果；
- AI 生成不覆盖手动编辑，CAS 冲突可恢复；
- 相邻高亮 runs 合并后仍只放大原选区，等待 AI 时再次编辑不会被迟到响应覆盖；
- 已有 v2 贴纸的 A 切到 E 再切回，E 预览零提取零写入，A 的贴纸与 Resolution 恢复；
- 编辑过程中底片不闪封面。

## 8. P5 — 批量统一审片接入

### 8.1 后端

修改：

- `lib/batch-production/packaging.ts`：初始化一次预填；保存后不再从项目实时数据重建抖音内容。
- `lib/batch-production/output-arrangement.ts`：新增抖音生成／保存／原子启用子命令，校验 `outputVersionId + editRevision`，实质修改清审核；音轨变化后派生 stale，显式重算，过期自动卖点阻断导出。
- `app/api/batch-production/batches/[id]/outputs/[planId]/clips/route.ts`：复用当前 arrangement 命令入口。
- `lib/batch-production/cover-contract.ts`：仅当包装启用且当前模板为 E 时才把 E 字段加入完整或独立封面合同；A–D 历史输入与携带休眠 E 数据的输入沿用改造前任务键。E 下完整合同包含完整配置与资源身份，独立封面合同只包含启用状态、模板、`douyin.cover`、画幅和封面资源身份。
- `lib/batch-production/export-orchestrator.ts`：入队前直接校验 `douyin.cover`，旧 `allowPackagingPlaceholder` 对 E 无效。
- `components/batch-production/review/BatchReviewPreviewDock.tsx`：结构签名识别 E，画布 outputPreset 改从实际显示的 `previewFilm` 读取；`BatchTimelinePreview.tsx` 区分裸底图与成品 JPG，避免重复叠字。
- 画布内拖动与安全区使用 `previewFilm`；右栏检查器和封面抽屉使用实际编辑的 `activeFilm`，并保存到同一 output version，不读整批顶栏画幅，也不混用两个目标。
- `lib/batch-production/sticker-copy.ts` 与目标选择 UI：来源和全部目标都做贴纸能力检查，任一不支持整批零写入。

### 8.2 前端

修改：

- `components/batch-production/BatchPackagingEditor.tsx`；
- `components/batch-production/BatchPackagingOverlay.tsx`；
- `components/batch-production/review/BatchPackagingTrack.tsx`；
- `components/batch-production/review/BatchUnifiedReviewWorkspace.tsx`：历史条目在命令成功时保存 outputVersionId 与预期 editRevision，撤销／重做不再从刷新后的当前视图补取旧条件。

直接复用 P4 的三个共享编辑组件。切换当前成片只切换该 output version 的清单，不读取其他成片内容，也不做跨片批量应用。

### 验收

扩展 `batch-packaging-stickers.test.ts` 或新增 `batch-douyin-packaging.test.ts`，并新增批量抖音 Playwright：

- 多条成片彼此独立，无跨片继承；眼睛停在 3:4 A、选中 9:16 E 打开封面抽屉时，编辑器使用 E 尺寸并保存到 E，切到包装页签后画布按既有优先级切到 E；
- 分别从只有根画幅、根与片段均有画幅启用 E，导出 1080×1920，撤销按原画幅渲染、重做按同一 E 导出；
- V1 换成同 revision 的 V2、另一窗口修改 V1 后刷新再撤销均零写入；连续撤销重做使用返回的新 revision；
- 保存 A–D 改造前哈希基线，历史输入与休眠 E 数据沿用旧键；E 下正文修改只更新完整键，封面修改同时更新两键；
- A 同时复制到 B 与 E 时整批拒绝，B 的贴纸与审核态保持原值；
- 编辑／AI 生成递增 editRevision 并清审核，后台无静默写入；已入队后改音轨时，runner 重算当前 requestKey 并拒绝旧合同结果成为当前候选或正式发布；
- 撤销重做恢复同一份 runs、随机色与箭头 fallback；
- 连续改两次封面并令第一次任务迟到返回，工作台和正式发布只采用第二次结果；只改正文 runs 或尾帧不重排独立封面；
- 行筛选、眼睛预览、选择、审核和导出 v14 契约不变；
- 卖点编辑不触发底片重载。

## 9. P6 — 共享封面、正式导出与资源冻结

### 9.1 共享封面生成器

新增 `lib/media-core/douyin-cover.ts`：

- 用同一抖音模板和冻结资源生成封面静态透明覆盖层；
- 只渲染封面参考帧，不渲染整段正文；
- 输出尺寸、字体、文案、LOGO、括号和资源哈希均可校验。

接入：

- `lib/final-edit/renderer.ts`：抖音底图阶段跳过旧标题。
- `lib/final-edit/packaging.ts`：正式包装后封面使用共享生成器。
- `lib/media-core/packaging-render.ts`：批量完整渲染封面使用共享生成器。
- `lib/batch-production/batch-renderer.ts`：独立封面任务也调用共享生成器，并跳过旧标题；任务键使用更新后的独立封面合同，迟到旧合同结果不得提交。
- `lib/final-edit/worker.ts`：E 的完整配置、冻结证据与资源身份必须随首次快照传入包装子任务；裸封面留在任务临时目录，包装封面通过校验后才首次发布和登记，包装失败不得留下半套正式产物。
- `app/api/final-edit-jobs/[id]/cover/route.ts`、`video/route.ts` 与任务详情：E 包装运行中或失败未处理时，视频与封面均返回未就绪，不回退内部 MP4/JPG；成功返回同一次 E 产物，显式跳过成功返回同一次无 E 生产码的原片产物。
- `lib/final-edit/packaging.ts`：E 使用现有成对发布、预留与失败清理能力，视频和封面缺一不可；封面失败不得保留包装视频＋素封面的组合。
- `app/api/final-edit-jobs/[id]/publish-original/route.ts`／`publish-original.ts`：只允许用户显式跳过，标记 skipped，按无 E 生产码登记原片与封面。
- `app/api/final-edit-jobs/[id]/retry/route.ts` 与跳过端点：在任何文件副作用前，用同一失败任务原子状态转换互斥；重试 `failed → queued`，跳过 `failed → publishing_original`，只有一方成功。
- 取得跳过执行权后先生成任务级 reservationId；`reserveProjectExportTarget` 用 `wx` 创建包含 reservationId、jobId、实际目标路径的锁元数据，成功取得锁后才持久化实际 MP4/JPG、来源与预期 SHA-256 发布计划，再复制文件。
- 争用失败方继续下一个候选名，不得覆盖或删除他人锁；恢复同时校验 reservationId、jobId、锁内目标与数据库计划，锁已建但计划未写时按锁元数据重建，只有归属匹配才清理。
- 跳过成功后重复请求幂等返回首次输出，不重复发布或登记；`publishing_original` 中断后按持久化发布计划恢复或回滚，前端轮询把该状态纳入进行中，完成前两路下载未就绪。
- E 的恢复就绪判断使用 SHA-256，不能只比较文件大小；同字节错误 JPG 不得通过。
- 单条 worker 与批量发布前按冻结快照复验 `douyin.cover`，不接受旧占位放行参数。

### 9.2 正式包装与资源

修改：

- `packaging/package-video.mjs`：复制并逐文件校验抖音模板、字体、LOGO、括号与箭头帧，按帧序列渲染箭头。
- `lib/media-core/packaging-render.ts`、`lib/final-edit/packaging.ts`：任务只读冻结配置与物化资源。
- `next.config.ts`、`scripts/sync-standalone-assets.mjs` 和打包守护：纳入新模板和资源；保持禁入清单断言。
- 资源缺失、哈希异常、非 9:16、封面必填缺失或帧 manifest 不完整均 fail closed。

### 验收

新增 `scripts/douyin-packaging-render.test.ts`：

- 单条、批量完整渲染、批量独立封面三入口在相同底图、裁切、资源与配置下覆盖层像素一致，最终 JPG 分别验证裁切与合成；
- 包装运行中、失败未处理、包装成功、显式跳过成功四种状态下，父任务详情与直接视频／封面请求均只返回对应正式产物或未就绪，不回退内部底片；
- 两个窗口同时重试与跳过只有一方执行；跳过成功后响应丢失再提交，幂等返回第一次结果且文件与登记不重复；
- 两个不同失败任务同时发布同基础名原片，分别在一方取得预留前后中断；重启后各自得到正确文件对，不覆盖他人文件、不删他人锁，重发幂等返回各自首次结果；
- 分别在“正式 MP4 已写入、JPG 尚未发布”和“两文件已落盘、数据库尚未登记”中断并重启，按持久化发布计划与内容指纹恢复，文件、任务状态和素材登记一致，无重复或缺件；
- 预先放入同名历史成片迫使改名，分别在刚预留、仅写完 MP4、两文件完成但未登记时中断；原同名成片完好，本次只发布并登记一对文件，预留清理且另一窗口持续显示进度；
- 显式跳过包装后为 skipped 且无 E 生产码；封面发布失败不得留下包装视频＋素封面；
- 放入同字节但内容不同的错误 JPG 后重试，SHA-256 不匹配，错误文件不得登记或呈现为成功 E 封面；
- 无旧标题重影，首 20 帧无正文卖点和箭头；
- 三种高亮色、白色放大、可选小字、无卖点箭头完成真实 MP4＋JPG；
- 尾帧视频总时长不增加，箭头位置与帧动画和预览一致；
- 移走在线源目录后，冻结副本仍可导出；篡改任一资源被阻断；
- 旧四套模板与 classic 回归。

## 10. P7 — 全量验收与文档

### 10.1 浏览器矩阵

- 单条与批量：初始化、AI 生成、全部清单编辑、批量应用、拖动、时间调整、历史、刷新。
- 封面一行／两行、不同长度文案、LOGO 明暗版本。
- 无卖点、无高亮、手动箭头色、随机 fallback、短正文边界。
- 非 9:16 的取消、原子启用成功、版本冲突零写入与刷新重试；单条多 variants 不出现部分 9:16。
- 在正文中段编辑 E，同时观测播放头、封面图层、包装 iframe 和实际可见画面；与现有批量闪动基线对照，不以 E2E 通过代替视觉验收。
- 回放历史 `overlay-basic` 快照，旧模板可加载且新选择器不出现 basic 卡片。
- Windows x64 与 macOS arm64 各从隔离交付产物完成一对 E MP4/JPG 离线导出，核对字体、LOGO、箭头帧和运行时；交付记录标明实际运行平台，没有对应构建机时标记未验证，不用开发目录回退冒充通过。
- 无页面异常、无失败 API、无 console error；不得只凭启动日志宣称通过。

### 10.2 工程检查

按改动模块运行同名测试，并执行：

```bash
npx tsc --noEmit --pretty false
npm run build
git diff --check
git diff --exit-code -- packaging/templates/classic lib/film-render
```

变更文件单独 ESLint；全量 lint 与历史测试漂移只如实记录。

### 10.3 文档

- 更新 `docs/reference/视频包装.md`：E 模板、配置模型、清单编辑、共享封面、箭头帧运行时与测试入口。
- 更新 `docs/reference/批量生产模块.md`：批量保存、审核、独立封面任务与渲染合同变化。
- 在本计划记录真实测试、真实导出和未通过的历史基线。
- 不把源 PSD、本机路径、用户数据库、临时媒体、日志或评测隐私内容写入 Git 或安装包。

## 11. 高耦合顺序控制

1. P0 字体／安全区标定未确认前，不完整开发模板和 UI。
2. P1 配置、模板能力分流、稳定选区、随机契约、原子启用、多 variant 共同时间、复合撤销与 stale 模型未稳定前，不接 AI 和命令保存。
3. P2 箭头查帧、预览去重与冻结资源试通未验证前，不接正式导出。
4. P3 只读小样未获用户认可前，不开放正式 AI 生成按钮。
5. P4 单条编辑闭环后，再复用到批量，避免两条链路同时返工。
6. P6 三入口封面与真实导出未完成前，不宣称整套包装完成。

## 12. 完成定义

只有同时满足以下条件才可交付：

- 单条与批量均可选择 E 模板并完成编辑、审核和正式导出；
- 封面三入口一致，正文高亮／放大与预览一致，尾帧箭头独立可用；
- 无卖点、随机结果、撤销重做、刷新和冻结任务均符合契约；
- 旧模板与 classic 无回归；
- 真实测试、构建、打包负载和已知限制已如实记录。
