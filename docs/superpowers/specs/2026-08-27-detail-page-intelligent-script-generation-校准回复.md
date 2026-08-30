# 详情页智能脚本生成 PRD · 校准回复

> 日期：2026-08-27
> 校准对象：`docs/superpowers/specs/2026-08-27-detail-page-intelligent-script-generation-prd.md`
> 校准方式：逐条对照仓库代码与 2026-08-21 真机探针产物，每条结论给出 `file:line` 或产物路径
> 代码基线：`feat/video-bulk-prompt` @ `54810de`
> 状态：待评审 · 作为 PRD 下一轮修订的输入

## 0. 这份文件怎么用

PRD §0 声明自己是「下一轮 AI 校准的输入」。本文就是那一轮的回复，结论分三种效力：

- **【事实纠正】** —— PRD 与仓库现状冲突，或会回退已上线功能。这部分**优先于 PRD 原文**，下一轮修订照此改写即可，不需要重新论证。
- **【已结案】** —— PRD §14.3 列为「待校准」，但答案已经在仓库代码或 2026-08-21 实测里。直接写回 PRD，不要重新开题。
- **【仍待决】** —— 真的还需要人拍板的分叉。

PRD 已确认的三页交互、输入最少化、方案/版本语义、事实与创意分层这些产品方向，本文**全部认可，不做改动**。下面只讲需要动的地方。

---

## 1. 结论摘要

| # | 条目 | 效力 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | §5.6 / §9.8 项目脚本可不绑定 `shotSetId` | 事实纠正 | 🔴 阻塞：新脚本对下游 100% 不可见 | 升级为阻塞项，点名四处闸门 |
| 2 | §1.4「现有『采用版本』单选状态」 | 事实纠正 | 问题陈述虚构，会误导下一轮 | 按真实缺口重写整节 |
| 3 | §9.1「读取原图，不使用压缩预处理版本」 | 事实纠正 | 措辞会被实现者误读成跳过缩放 | 改写为「不复用分镜压缩阶梯」 |
| 4 | §5.3.2 / §13 禁止展示 reasoning | 事实纠正 | 会删掉两天前刚上线的功能 | 改为区分透传 delta 与内部提示词 |
| 5 | §14.3 Q1 自动提取安全阈值 | 已结案 | —— | 闸门只能建在服务端可验证的证据上 |
| 6 | §14.3 Q2 资源预算 | 已结案 | —— | 8/21 全部实测完毕，直接抄表 |
| 7 | §14.3 Q3 供应商拆分 | 已结案（附坑） | 用量看板可能记不到账 | 对齐种子身份 `gpt` |
| 8 | §14.3 Q4 持久化任务 | 已结案 | —— | 现状是 `globalThis` 注册表，确认要换 |
| 9 | §14.3 Q5 全量重提取 vs 增量合并 | 已结案 | —— | 实测支持 PRD 的全量重提取推荐 |
| 10 | §14.3 Q6 稳定脚本数据模型 | 已结案（改问法） | 有同名概念撞车风险 | 词汇 `CONTEXT.md` 已定，batch 已实现一半 |
| 11 | §14.3 Q9 编辑版本语义 | 已结案 | —— | 现状没有编辑功能，是白地，无兼容问题 |
| 12 | §14.3 Q7 / Q8 / Q10 | 仍待决 | —— | 见 §4 |
| 13 | 新旧入口关系整份未写 | 补充缺口 | UI 落不了地 | 见 §5.1 |
| 14 | 模板缺 `version` 字段 | 补充缺口 | §5.3.4 要求存不了 | 见 §5.2 |
| 15 | §10.2「原图证据坐标」验收会挂 | 补充缺口 | 实测 `tileRefs` 有系统性偏移 | 见 §5.3 |

---

## 2. 【事实纠正】

### 2.1 🔴 `shotSetId` 是四道已生效的硬闸门，不是「若下游强制要求」

PRD §9.8 的措辞是假设句：「当前下游**若**强制要求脚本在生成时已有非空 `shotSetId`，需要增加兼容路径」，并把它放在「建议实现」层级。实际上这是确定的、正在生效的过滤，而且有四处：

| 位置 | 判断 |
| --- | --- |
| `lib/media-core/script-draft-usable.ts:6` | `typeof value.shotSetId === 'string' && value.shotSetId.length > 0` |
| `lib/final-edit/mixcut-context.ts:219` | 调用上面的 helper |
| `lib/final-edit/mixcut-context.ts:221` | **额外**再判 `validShotSetIds.has(script.shotSetId)` |
| `lib/batch-production/script-catalog.ts:80,86` | 调用 helper + 同样再判归属 |
| `app/api/projects/[id]/final-edit/bootstrap/route.ts:21` | **不走 helper**，内联了一份等价判断 |

后果：按 PRD 生成的项目级脚本（`shotSetId` 为空）会被四处全部丢弃，与验收 §11.1.8「所有当前方案都能被下游项目脚本查询读取，不需要采用按钮」直接矛盾。

另外注意 `shotSetId` 不是数据库列，它存在 `script_drafts.outputJson` 里（`lib/db.ts:314-323` 建表无此列），所以放宽闸门改不了表结构，只能改解析侧判断。

**要求下一轮 PRD 做的修改：**

1. 把这条从「建议实现」提到**阻塞项**，写进 §12 风险表的最高一行。
2. 明确改造范围包含上面四处，特别点名 `bootstrap/route.ts` 那份**内联副本**——只改共享 helper 修不好它。
3. 给出闸门的新语义，而不只是「增加兼容路径」。建议口径：
   - `shotSetId` 由「必填」改为「可空」，可空即表示**项目级脚本**；
   - 下游列表查询按 `projectId` 取全部；带 `shotSetId` 的历史脚本**保持原有更窄隔离**（PRD §9.8 已写对，保留）；
   - 真正使用时才创建带 `projectId + shotSetId` 的快照绑定。
4. §10.4 版本测试里补一条：**四处闸门都能读到 `shotSetId` 为空的项目脚本**，且带 `shotSetId` 的历史脚本可见范围不被放大。

### 2.2 §1.4 的问题陈述是虚构的，真实缺口是另外三条

PRD §1.4 称「现有『采用版本』式的单选状态会产生错误暗示……采用方案二会取消方案一」。仓库里没有这个东西：

- 全仓「采用」只出现在 `components/ScriptResultView.tsx:71,197`，是**卖点采用情况**（该卖点有没有写进正文），与版本无关。
- `components/ScriptPanel.tsx:817` 在草稿数 >1 时渲染的是一个**查看用**切换列表，标签由 `buildDraftLabels()` 生成为 `分镜组 · 脚本N`（`:141-163`）。
- 下游本来就读**全部**有效草稿：`mixcut-context.ts:212` 与 `script-catalog.ts:57` 都是 `SELECT ... WHERE projectId = ?` 全量扫描，不存在「只认一条」。
- 交互原型 `outputs/script-generator-detail-page-prototype.html` 里也没有采用按钮。

保留一个虚构的现状问题，会让下一轮把力气花在「拆掉一个互斥状态」上，而真正的三个缺口无人处理：

1. **草稿列表 `LIMIT 10`** —— `app/api/projects/[id]/script/route.ts:88`。一次生成 3 条、跑三四轮就把历史冲掉，与 §5.4.3「再生成一组，旧方案组继续保留」和 §5.5「历史不可静默覆盖」正面冲突。分页或按方案分组是必须的。
2. **草稿行之间没有父子关系** —— `lib/script-generation-v3-service.ts:267` 只有 `INSERT`，每次生成就是一条孤立新行，表达不了「方案 1 的 V2」。这才是 §9.7「当前独立草稿行不足以表达稳定脚本 + 修订 + 当前指针」的真实依据。
3. **用户侧根本没有「方案 / 版本」这组词** —— 现在只有「分镜组 · 脚本N」。

**要求：** §1.4 整节按这三条重写，删除「采用版本」的表述；§9.7 的论据换成第 2 条。

### 2.3 §9.1「读取原图」的措辞会被实现者误读

PRD §9.1 写「生成服务读取原图，不使用工作台可能存在的压缩预处理版本」。这句话有两种读法，其中一种已经被实测否掉了：

2026-08-21 的 A/B（`scripts/probe-detail-page-ocr-ab.ts`，结论记在 `2026-08-20-detail-page-selling-point-extraction-design.md` 文末）：

| 变体 | 转写结果 | total_tokens |
| --- | --- | --- |
| A：1024 宽（切片管线）· 第 1 次 | ✓ 正确 | 690 |
| A：1024 宽 · 第 2 次 | ✓ 正确 | 720 |
| B：原生 1200 宽不缩放 | ✓ 正确 | 930（+35%） |
| C：1024 宽 + `detail: high` | ✓ 正确 | 637 |

结论：**误读不是分辨率造成的**，是 `temperature=1` + 33 张图长上下文下的随机字形错误（朦/膨形近）；送大图只多烧 35% token，50 张/请求的上限不变，误读风险照旧。

这句真正要表达的是：**不要复用 `lib/script-vision-image.ts` 的分镜压缩阶梯**。那条阶梯（`:24-32`，先降 JPEG 质量、后降分辨率，长边上限 1024）服务的是分镜图；它对 1200×34683 的长图会把长边压到 1536，宽只剩 53px，整图报废——08-20 设计里 `preprocessEnabled=false` 就是为这个。

**要求：** §9.1 首条改写为「详情页走独立切片管线（长边 1024、片高 1024、重叠 12%、JPEG q88），**不复用 `prepareScriptVisionImage` 的分镜压缩阶梯**」，删除「读取原图」这个容易被读成「跳过缩放」的说法。

### 2.4 §5.3.2 / §13 的 reasoning 禁令会回退两天前刚上线的功能

PRD §5.3.2 列「页面不得展示：模型的隐藏思维链或原始 reasoning token」，§13 Out of Scope 复述一遍。但：

- `3ba783f`（2026-08-26 合入）做的就是这件事：`components/script-generation-live-view.tsx:127,183-207` 用打字机效果展示 `progress.reasoningTail`，数据来自 `lib/script-generation-v3.ts:1206-1207`。
- `docs/2026-08-25-script-generation-streaming-prd.md` §1.4 把「思考过程流式」定为 **P0**，依据是实测：推理模型 **83–96% 的等待时间是纯推理段**（qwen3.6-max 96%、kimi-k3 83%），删掉它等于把最长的那一段还给黑箱。

按新 PRD 字面实现，就是把它删掉；而新流程等得更久（分页提取约 2 分钟 + 生成 + 校验重试），对过程反馈的需求只增不减。

有个巧合让这条**看起来**成立：公司 Luna 走 `openai-compatible`，但**上游不透传推理**（2026-08-26 实测，记在流式 PRD §1.3 表格与 §5.7 第 7 条）。所以详情页这条链路的推理覆盖率本来就是 0%，靠已用时长计时兜底。但这是单一供应商的现状，不能写成通用产品规则——脚本生成阶段仍可能配到别的供应商。

**要求：** §5.3.2 和 §13 的口径改成区分两类东西：

- **保留（已上线）**：供应商主动透传的 reasoning delta / 思考摘要，经服务端截断与脱敏后展示；
- **永不展示**：系统提示词、内部安全规则、完整供应商请求、鉴权信息、图片 base64。

并在 §9.5 补一句：详情页视觉提取段走公司 Luna 时推理不透传，该段的过程反馈由服务端编排阶段 + 已用时长承担。

---

## 3. 【已结案】§14.3 十问逐条回复

证据统一来自 `scripts/probe-detail-page-extract.ts` / `scripts/probe-detail-page-ocr-ab.ts` 的 2026-08-21 真机运行，产物在 `outputs/detail-page-probe*/`。

### Q1 自动提取安全阈值 —— 结案（但结论和 PRD 的设想不同）

实测两面：

- **逐字质量很好**：参数表与数字标注全对（`50×32×15.5cm`、`50000次`、`30kg`、`30-90cm`），59 条候选中仅 1 条单字误读；三次运行 0 校验问题。
- **但 `temperature=1` 下自身不稳定**：同输入连跑第 1 页两次，标题**字面重合仅 16/29**，其余为同义改写；还有召回差异（第二次多出「零贴皮零人造板」「VOC优于国家标准」）。

含义：**不能拿模型自报的 confidence 当闸门**——它自己就在抖。可用的闸门必须是服务端能独立验证的：

1. `evidence` 字段必须是逐字原文，且能在该切片的文本里精确匹配上；匹配不上直接判为不可用；
2. 促销/价格/限时/销量类目按关键词与句式分类排除（PRD §5.3.3 已写，保留）；
3. 高风险功效承诺走独立分类器或关键词表，不进事实池（PRD 已写，保留）；
4. 模型自报 confidence 只用于**排序和 UI 展示**，不作为准入。

另有一个必须单独定的产品分歧：**08-20 设计把人工确认写成 E 节「不可跳过」**，新 PRD §5.3.3 直接删除了这个环节。上面的字面抖动数据正是当时写「不可跳过」的依据。建议折中：默认自动通过不打断主流程（保住 PRD 的一次点击），但结果页保留卖点库的**回看与编辑入口**，让错误可纠正而不是不可见。此项列入 §4 待决。

### Q2 资源预算 —— 全部实测完毕，直接抄表

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| Luna 单请求图片上限 | **硬上限 50 张**（第 51 张 400：`Too many images in request: 51, maximum allowed: 50`） | 57 片一次请求被拒 |
| 单片 token | ~**1200**（1024×1024） | 网关不回拆 image 明细，按总量倒算 |
| 单页 33 片 | prompt 41,132 / completion 4,334 / total 45,466 | `outputs/detail-page-probe-p1/` |
| 两页合计 | ~**7 万** input token | p1 + p2 |
| 端到端耗时 | 51.2s（33 片）/ 46.6s（24 片）/ 复跑 64.4s；分页串行 ≈ **2 分钟** | 含 COS 上传与排队 |
| 切片参数 | 长边 1024、片高 1024、重叠 12%、JPEG q88、默认 `detail`（不需要 `high`） | A/B 已验 |
| `maxTokens` | **8000**（30 条候选 completion 实测 4334，4000 不够） | —— |
| 源图上限 | `MAX_SOURCE_PIXELS=60M`（样本 41.6M / 30.4M 均通过） | —— |
| 解码内存 | 1200×34683 原生 ≈ 125MB raw，缩到 1024 后 ≈ 91MB，缓冲按 **150MB** 估 | —— |

派生结论：

- **分页请求是硬性的，不是优化**：单页 33 片、24 片都在 50 内，但两页拼接 57 片必被拒。PRD §9.1「每页独立或按资源预算分批请求」方向正确，应改成「**按页各发一次请求**，服务端合并后再归一化去重；单页超 50 片才走放大切片高度的降级」。
- **§3.2「完整生成时长暂不设绝对 SLA」可以收紧**：首次提取每页 P50 ≈ 50s，两页 ≈ 2 分钟，超过这个量级一倍即可判异常。试运行只需要补「提取 + 生成 + 校验重试」的端到端分布。
- UI 不写死张数是对的，但**后端必须按「总切片数 ≤ 50/请求」和「总页数 × 单页耗时」两个维度做提交前预检**，这正是 PRD §5.2.1 要的「具体可处理范围」。

### Q3 供应商拆分 —— 结案，附一个记账的坑

- 视觉侧目前**只有 Luna 一条验证过的路**：`GPT-5-6-Luna-Standard`，`executionScope='company'`，`supportsVision=1`（`lib/seed.ts:373`）。`temperature=1` 由 `lib/script-providers/openai-compatible.ts:29,113-114` 对 `^GPT-5-6-Luna` 前缀强制。
- 8/21 探针期间本机 `config.yaml` 只有 Kimi-K3（非视觉）与 GPT-5-5，公司 token 对两者均无权限——即**可选视觉供应商在实际环境里可能为零**。PRD §9.2「如果没有可用视觉模型，应在提交前给出配置错误」是必要的，保留。
- 视觉提取与文本生成分成两个能力阶段、可分别配置适配器（PRD §9.2）—— 认可，无异议。

**坑**：脚本侧用量计价走**精确身份匹配**，`lib/usage-pricing.ts:319-327` 要求 `providerTable='script_providers'` **且 `providerId === 'gpt'`** 且 model 恰为 `GPT-5-6-Luna-Standard`，没有视频侧那种回环兜底（`:247` 的放宽只给了 `video_providers`）。8/21 探针那次就是因为供应商行 id 不是种子身份 `gpt`，调用**没落进用量表**。PRD §3.3 要统计「模型调用次数与 token 消耗」，实现时必须对齐种子身份，否则指标是空的。

### Q4 持久化任务 —— 现状确认，PRD 判断正确

`lib/script-generation-manager.ts:63-80` 是挂在 `globalThis` 的 `Symbol.for` 键上的**进程内注册表**（注释写明是为了跨 Next 路由模块重载共用一份）。刷新页面能续上，进程重启就丢。PRD §9.4 的判断成立。

迁移注意：现有 `ScriptGenerationSnapshot` 已经有 `state / progress / draftId / error / cancellationReason / startedAt / finishedAt` 这套字段，持久化时应**沿用同一形状**落 SQLite，而不是另起一套；`ScriptGenerationErrorDetails`（`:14-22`）的白名单机制也要保留——它是控制透传给前端的错误明细的现成闸门。核心表迁移追加到 `CORE_DB_MIGRATIONS`（`lib/db-migrations.ts`），不改已发布条目。

### Q5 全量重提取 vs 增量合并 —— 结案，采纳 PRD 的 MVP 推荐

PRD 自己推荐全量重提取并保留旧修订。实测支持这个选择：同输入连跑两次召回都不一致（多出两条卖点、标题字面重合 16/29），**增量合并没有稳定基线可对齐**，做出来的结果不可复现。全量重提取 + 保留旧修订，MVP 定案。

### Q6 稳定脚本数据模型 —— 结案，但问法要改

PRD §9.7 说「建议增加正式领域层」，像是要从零发明。实际上：

**词汇早就定了**，`CONTEXT.md:63-79`：

- **项目脚本（Project Script）**：由第 3 步保存、拥有稳定身份、可在第 4 步与智能混剪复用；同一项目脚本可以持续产生新版本。
- **项目脚本版本（Project Script Revision）**：某次明确保存后形成的正文与标题版本；新批次可以采用最新版，已经开始的批次仍保留自己采用的旧版本。
- **脚本快照（Script Snapshot）**、**批次脚本（Batch Script）** 亦有定义。

PRD §6.1 自造的「项目脚本 / 项目脚本修订 / 脚本快照」语义与之**基本一致**，直接改用 `CONTEXT.md` 的既有词即可，不要新造术语。

**而且已经实现了一半**，在 `lib/batch-production/`：

- `batch_scripts`（`schema.ts:110-122`）：`UNIQUE(projectId, sourceId)` 做稳定身份，`sourceVersion` 存内容修订（`script-catalog.ts:22-24`，outputJson 的 SHA-256）；
- `batch_script_snapshots`（`schema.ts:124-133`）：批次开始时冻结，「已开始批次只读自己的快照」（`script-catalog.ts:41-43`）；
- `syncProjectScripts()` 已经在做 `script_drafts` → 项目脚本的同步，且注释已预留「草稿更新后再次同步会更新当前内容与修订身份」。

**所以 Q6 的真正问法应该是**：新的核心层「项目脚本」与 `batch_scripts` 里那套是**同一个概念**还是两个同名概念？

建议答案：同一个。领域层放 `lib/media-core/`，batch 改成消费它——这也符合 AGENTS.md 的红线（批量生产**只从 `media-core/` 导入**）。具体路径：

1. 把稳定身份 + 修订 + 当前指针的领域模型放 `media-core/`；
2. `script_drafts` 降级为「修订内容表」或由新表承接，历史行只做兼容读取，**不批量回写**（PRD §9.7 已写对）；
3. `batch_scripts` 保留为「被选入批次的项目脚本」这层含义（`CONTEXT.md:73-75` 的定义），不再自己承担稳定身份的职责，或明确它继续只做批次侧投影。

第 3 步怎么切，是本项目最大的一处架构决策，建议单独出技术方案，不要塞进 PRD。

### Q9 编辑版本语义 —— 结案，是白地，没有兼容问题

PRD 问「人工编辑保存为新修订是否与现有结果卡交互完全兼容」。答案：**现状根本没有脚本编辑功能**。

- `components/ScriptResultView.tsx` 只有复制（`:17-24` 的 textarea 是剪贴板兜底，不是编辑器）；
- 全仓没有 `UPDATE script_drafts`，`lib/script-generation-v3-service.ts:267` 只有 `INSERT`。

所以「编辑保存 = 新修订」是全新能力，不存在要兼容的旧交互。附带好消息：`script-catalog.ts` 的同步逻辑已经预设了「草稿会被更新」这种情况，编辑落地后 batch 侧不需要额外改造。

---

## 4. 【仍待决】需要人拍板

1. **人工确认是彻底删除，还是降级为可选回看？**（关联 Q1）
   08-20 设计写「不可跳过」，新 PRD 删掉了。建议：主流程不打断（保住一次点击），但结果页保留卖点库的回看与编辑入口。**需要产品定。**
2. **§14.3 Q7 下游隔离的具体闸门形状。** §2.1 给了建议口径（`shotSetId` 可空 = 项目级，历史窄隔离不变），但四处改造中 `bootstrap/route.ts` 的内联副本是否顺手收敛到共享 helper，属于技术方案范畴。
3. **§14.3 Q8 部分成功补齐：补入原批次还是新建补充批次？** 仓库里没有可参照的既有事实。PRD 自己推荐补入原批次并保留独立任务记录，合理，但需要确认结果页怎么表达「这条是补跑的」。
4. **§14.3 Q10 真实性指标的样本规模与抽查标准。** 现有基线只有一套样本（`PK4X-A组合-商品详情1200-四件套` 两张，1200×34683 / 1200×25333）。08-20 已注明「结论目前只基于这一套样本，新样本进来要复核」。需要定：几个商品、几个品类、抽查比例。
5. **新旧入口是替换还是并存**（见 §5.1）。

---

## 5. 【补充缺口】PRD 没写但实现绕不开

### 5.1 新旧脚本生成入口的关系整份没有交代

现状第 3 步是：**选分镜组 → 手填卖点 → 分析 → 生成**。

- `lib/script-generation-v3-service.ts:137` 强制 `shotSetId`，缺失直接 400「请选择要生成脚本的分镜组」；
- `:187-192` 还 `JOIN shot_sets` 读分镜图，用于卖点↔图片匹配（结果就是 `ScriptResultView.tsx:197` 那个「图片暂不支持」状态）——这正是 PRD §1.3 要拆掉的耦合，那节写得对。

新流程不要分镜组、不要手填卖点。那么：是**替换**旧入口、**并存**、还是并存但默认走新的？PRD §13 Out of Scope 也没排除这个问题。不定这一条，第 3 步的 UI 无法落地，`ScriptStrategyConfig` / `ScriptPanel` 的去留也没法判断。**建议 PRD 增设一节明确取舍。**

### 5.2 模板缺 `version` 字段

PRD §5.3.4 要求「每个方案保存模板 ID、模板版本和选择说明」。`lib/script-templates.ts:1-11` 的 `ScriptTemplateDefinition` 有 `id / name / slogan / example / suitable / objective / narrativeStructure / writingRules / desiredAudienceResponse`——**没有 `version`**。

好消息是 `suitable`（适用卖点类型）和 `objective`（表达目标）这些元数据已经足够喂给 AI 选型器，7 个内置模板（`pain_point` / `scene_seeding` / `feature_showcase` / `emotional` / `comparison` / `unboxing` / `problem_solving`）不用重写。要补的只是：新增 `version` 字段 + 定 bump 规则（改动 `narrativeStructure` 或 `writingRules` 就 bump）。

### 5.3 §10.2「切片保持原图证据坐标」这条验收会挂

实测：模型返回的 `tileRefs` **有 2–4 片系统性偏移**（08-20 待验证清单 #4）。如果验收按字面要求「证据坐标准确」，必挂。

建议改写为：

- 证据定位以 **`evidence` 逐字原文**为准（服务端在切片 OCR 文本里反查真实位置）；
- 模型返回的片号只作提示，展示时容忍 ±N 片（展示该片及相邻片）；
- §3.2 的「100% 保留详情页证据引用」保持不变——它要的是**引用存在且可追溯**，逐字原文能满足；坐标精度不进硬指标。

### 5.4 抬头引用路径建议写全

PRD 开头的 `2026-08-20-detail-page-selling-point-extraction-design.md` 与 `2026-07-27-script-generation-v3-prd.md` 都在 `docs/superpowers/specs/`（与 PRD 同目录），同目录相对引用没错，但建议写成仓库根相对路径，免得下一轮 AI 去 `docs/` 下找不到。

---

## 6. 证据索引

**代码**

| 断言 | 位置 |
| --- | --- |
| `shotSetId` 非空闸门 | `lib/media-core/script-draft-usable.ts:6` |
| 闸门四处调用 | `lib/final-edit/mixcut-context.ts:219,221`；`lib/batch-production/script-catalog.ts:80,86`；`app/api/projects/[id]/final-edit/bootstrap/route.ts:21` |
| 草稿表无 `shotSetId` 列 | `lib/db.ts:314-323` |
| 草稿列表 `LIMIT 10` | `app/api/projects/[id]/script/route.ts:88` |
| 草稿只有 INSERT，无编辑 | `lib/script-generation-v3-service.ts:267`（全仓无 `UPDATE script_drafts`） |
| 现无「采用版本」 | `components/ScriptPanel.tsx:817`、`components/ScriptResultView.tsx:71,197` |
| 生成强制分镜组 | `lib/script-generation-v3-service.ts:137,187-192` |
| 分镜压缩阶梯 | `lib/script-vision-image.ts:3-32` |
| reasoning 已上线 | `components/script-generation-live-view.tsx:127,183-207`；`lib/script-generation-v3.ts:1206-1207`；提交 `3ba783f` |
| 任务状态在进程内存 | `lib/script-generation-manager.ts:63-80` |
| Luna 强制 `temperature=1` | `lib/script-providers/openai-compatible.ts:29,113-114` |
| 用量精确身份匹配 | `lib/usage-pricing.ts:319-327`（对比 `:247` 视频侧回环放宽） |
| 项目脚本词汇 | `CONTEXT.md:63-79` |
| batch 侧已有一半实现 | `lib/batch-production/schema.ts:110-133`；`lib/batch-production/script-catalog.ts:22-24,41-43` |
| 模板库无 version | `lib/script-templates.ts:1-11` |

**实测产物（2026-08-21，公司 Luna / `GPT-5-6-Luna-Standard`）**

- 探针：`scripts/probe-detail-page-extract.ts`、`scripts/probe-detail-page-ocr-ab.ts`
- 产物：`outputs/detail-page-probe/`、`-p1/`、`-p1b/`、`-p2/`（切片、提示词、原始返回、`summary.json`）
- 结论沉淀：`docs/superpowers/specs/2026-08-20-detail-page-selling-point-extraction-design.md` §「待验证清单」与文末实测记录

**相关文档**

- `docs/2026-08-25-script-generation-streaming-prd.md`（流式透明化 PRD，§1.2 供应商实测表、§1.4 优先级）
- `docs/2026-08-26-script-generation-streaming-执行方案.md`
