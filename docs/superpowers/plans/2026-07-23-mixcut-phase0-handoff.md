# 智能混剪 V1 — Phase 0 执行交接文档

> **这份文件是个指针,不是工作现场。** 真正的工作(4 个 commit、进行中的测试文件)都在 git worktree 里:
> `/Users/liangpeijian/for-cc/creative-studio/.worktrees/mixcut-v1`,分支 `mixcut-v1`。
> 这份文件是同一份内容的副本,放在主仓库方便下一个 session 不管从哪个目录起都能先看到。**改动/继续工作请去 worktree 里做,不要在主仓库这份路径下改代码。**
>
> 写这份文档的原因:上一个 AI session 额度耗尽,中途交接。这不是产品/技术文档,是"现在具体做到哪一步、为什么这么做、下一步做什么"的操作记录。
> 写文档时间:2026-07-23。
> 依据文档(不要改这两份,只读;主仓库和 worktree 里各有一份,内容一致):
> - PRD:`docs/superpowers/specs/2026-07-23-mixcut-prd.md`
> - 技术执行计划:`docs/superpowers/plans/2026-07-23-mixcut-technical-execution.md`(本文档里"§x.x"均指这份计划)

## TL;DR — 接手的 AI 先看这几行

1. 工作目录是 **worktree**,不是主仓库:`/Users/liangpeijian/for-cc/creative-studio/.worktrees/mixcut-v1`,分支 `mixcut-v1`,从 `mixcut01` 分支切出(**不是 main**——原因见下文"worktree 基线"一节,这点判断错了会导致丢失整个 `lib/final-edit/` 基线)。
2. 正在执行技术计划的 **Phase 0**(§12,契约冻结)。Phase 0 有 4 个任务点,3 个已完成并双重审核通过,第 4 个(audio-first-matcher 失败测试)还没开始,第 3 个(export-naming 失败测试)代码已提交但**质量审核还没跑完就被打断**。
3. 执行方式:每个 Phase 的每个任务 = 一个实现子代理 + 一个 spec 合规审核子代理 + 一个代码质量审核子代理,发现问题打回实现子代理修,修完重新审,通过了才算这个任务完成。**同一时间只能有一个实现子代理在跑**(避免同一 worktree 冲突)。这是 `subagent-driven-development` skill 的标准流程,细节见该 skill 的 `implementer-prompt.md`/`spec-reviewer-prompt.md`/`code-quality-reviewer-prompt.md`(路径:`~/.claude/skills/subagent-driven-development/`)。
4. **用户明确要求:Phase 之间要回来跟他确认,不能连续跑完 8 个 Phase。** Phase 0 全部任务通过 + 门禁核对完,必须停下来跟用户汇报确认,才能开始 Phase 1。不要自己接着往下跑。
5. 这份文档所在的 worktree 里,4 个 commit 都还**没有推送/没有合并到任何地方**,是纯本地状态,可以放心继续在这个分支上工作。

## 为什么会有这个 worktree(背景)

用户给了两份文档(PRD + 技术执行计划),问要不要开子代理执行。分析后的结论(已经过用户确认,选的是"按 Phase 分批开子代理"):

- 这是一个 8-Phase(Phase 0-7)的顺序强依赖计划,后一个 Phase 依赖前一个 Phase 冻结的 schema/契约,计划原文明确要求"每个 Phase 通过门禁后再进入下一阶段"——所以不能无脑丢给一个子代理从头跑到尾(会跳过门禁),也不能拆成并行子代理(阶段间不独立)。
- 正确做法:按 Phase 分批,每个 Phase 内部用 `subagent-driven-development` 的"一任务一子代理 + 两阶段审核"模式跑,Phase 与 Phase 之间停下来跟用户确认。

## worktree 基线:为什么从 `mixcut01` 切,不是 `main`

创建 worktree 前发现:`mixcut01` 分支比 `origin/main` 领先几十个 commit,其中包含**整个 `lib/final-edit/` 模块**(21 个文件)——`origin/main` 上完全没有这个目录。技术计划 §1.1"可直接复用"表里列的 `final_edit_groups`、`FinalEditWorkspace`、TTS/Alignment adapters、`lib/final-edit/renderer.ts` 等等,全部只存在于 `mixcut01`。如果用默认参数开 worktree(`EnterWorktree` 默认 `fresh` 策略是从 `origin/<default-branch>` 也就是 `origin/main` 切),会拿到一个没有 final-edit 基线的空仓库,Phase 0 及之后全部作废。所以改用 `git worktree add .worktrees/mixcut-v1 -b mixcut-v1 mixcut01` 手动指定了正确的 base。

另外,PRD 和技术计划这两份文档本身、以及 `/mixcut-preview` 评审原型(`app/mixcut-preview/`、`components/mixcut-prototype/`),在主仓库里是**未提交(untracked)**状态,worktree 不会自动带过来(worktree 只共享已提交历史),所以是手动 `cp` 过来的,同样是 untracked 状态。**不要提交这几个文件**——它们是产品/评审材料,不属于这次实现工作,提交与否由用户自己决定。

## worktree 环境状态(已验证)

- Node v22.22.2、npm 10.9.7(满足 CLAUDE.md 对原生模块 ABI 的要求)。
- `npm install` 已跑完。
- 基线测试:`scripts/*.test.ts` 全部 29 个文件,worktree 建好那一刻全部 PASS(不含 `.mjs` 的 Playwright/UI 测试和 `macos-installer.test.mjs`,没跑那几个)。这是 Phase 0 检查项"记录当前 final-edit 相关测试和构建基线"里"测试"部分的依据。**`npm run lint` 和 `npm run build` 当时没跑**,这是 Phase 0 收尾前还要补的动作(见下文"剩余工作")。

## Phase 0 任务拆解与当前进度

Phase 0 原文(计划 §12):

> **目标:** 在改 UI 前锁定上游/下游数据合同。
> - [ ] 为 `script_drafts` V2、`shot_sets`、`video_jobs`、`projects.productCode/createdAt` 写 fixture。
> - [ ] 定义 `MixcutContextResponse`、command 和错误码。
> - [ ] 写 `export-naming` 与 audio-first matcher 的失败测试。
> - [ ] 记录当前 final-edit 相关测试和构建基线。
> **门禁:** 文档字段与真实数据库一致;没有把 `projects.model` 当型号。

这 4 个checklist 项没有一一对应到 4 个独立文件,拆解成了下面 4 个具体子任务(这是我作为 controller 的拆分判断,不是计划原文写死的文件名——如果后续 AI 觉得拆分不合理,可以调整,不是不可更改的契约):

### Task 1 — 类型契约 ✅ 完成(spec 审核通过 + 质量审核通过)

- 内容:在 `lib/final-edit/types.ts` 新增 `MixcutContextResponse`、`ExportIdentity`、`MixcutErrorCode` 三个纯类型导出(对应计划 §5.1 / §11.1 / §11.2)。`MixcutErrorCode` 目前只有一个字面量 `'product_code_required'`——计划里唯一明确写出的错误码,**不要自己加别的错误码**,后续 Phase 实现具体失败场景时再逐步扩展这个联合类型。
- Commit:`4edda07`(worktree 内,基于 `mixcut01`)。
- 审核结论:spec 完全一致(逐字段比对);质量审核 Ready to merge: Yes,仅有一条 Minor 建议(给 `taskDate` 加个时区换算的 JSDoc),非阻塞,未处理。

### Task 2 — schema 契约测试 ✅ 完成(两轮质量审核后通过)

- 内容:新文件 `scripts/final-edit-mixcut-context-contract.test.ts`。这个文件名是我自己起的(计划 §3.1 的新文件表里没有预先列出这一个,因为 Phase 0 阶段大部分正式文件还不存在)。做法:手搭一个内存 SQLite,按真实生产 schema(`projects`/`shot_sets`/`video_jobs`/`script_drafts`,列名对照过 `lib/db.ts` 真实源码)插入多场景 fixture 数据,**直接跑原始 SQL**(不调用任何还不存在的 route/workspace 代码)验证计划 §5.1 的查询规则,以及"`productCode` 不能和 `model` 混用"这条红线。
- Commit:`fa9acd1`(初版)+ `bf6c46b`(修复)。
- 审核过程:spec 审核一次通过。质量审核第一轮提了 3 个 Important 级别缺口(跨项目脚本隔离没测到、V2 校验的四个 AND 条件只有第一个被单独覆盖到、视频规则的注释漏提了"路径安全校验"这个子句),打回实现子代理修复(`bf6c46b`),质量审核复查时**做了 mutation testing**(故意改坏两处逻辑再跑测试,确认真的会报错而不是摆设断言),确认修复真实有效,最终 Ready to merge: Yes。
- 遗留的非阻塞观察项(不需要处理,记录一下就行):banner 注释风格和邻近测试文件不一致;`isUsableV2Draft` 对 `shotSetId` 只查非空字符串,没有校验它在 `shot_sets` 表里真实存在(计划原文"合法"这个词本身有歧义,留给 Phase 1 定)。

### Task 3 — export-naming 失败测试 ⚠️ 代码已提交,**质量审核被打断,还没做完**

- 内容:新文件 `scripts/final-edit-export-naming.test.ts`,针对**目前还不存在、也不应该在 Phase 0 创建**的 `lib/final-edit/export-naming.ts`(这个模块是 Phase 6 的工作)写失败测试(对应计划 §11.1/§11.2/§7.5.2/§11.3 的命名规则)。这个测试**现在跑起来必须失败**,且失败原因必须**只能是** `ERR_MODULE_NOT_FOUND`(import 目标不存在),不能是测试文件自身的逻辑 bug。这是刻意的 TDD 红灯状态,不是 bug。
- Commit:`95c9272`。
- 实现子代理自评状态:`DONE_WITH_CONCERNS`(不是 BLOCKED,是主动坦白了几个推断,不是卡住了)。已验证跑起来确实只报 `ERR_MODULE_NOT_FOUND`(用临时 stub 文件单独验证过测试自身逻辑能 typecheck 通过,stub 没有被提交)。
- **接手后第一件事:把 spec 合规审核跑完。** 我原本已经写好了完整的审核子代理 prompt,正准备派发时被用户打断(改成了先写这份交接文档)。审核要重点核实实现子代理自己标注的 5 个判断:

  1. **错误信号机制**:选择了 `throw FinalEditError`(从 `lib/final-edit/workspace.ts` import),理由是 `scripts/final-edit-workspace.test.ts`/`scripts/final-edit-planner.test.ts` 里已经有这个约定——**审核时要真的去这两个文件核实这个先例是不是真的存在**,不能只信实现子代理的话。
  2. **`ReservedPath` 的形状**:计划原文只写了函数签名 `reserveExportPath(storageRoot, identity, extension): ReservedPath`,没定义这个类型长什么样。实现子代理自己定义成 `{ absolutePath, relativePath, filename }`,理由是参照了 `lib/final-edit/` 里其他地方 `relativePath` 字段的命名先例——同样需要核实这个先例真实存在。
  3. **扩展名格式**:一开始猜的是不带点(`'mp4'`),后来在 `lib/zip-download.ts` 里找到 `STORAGE_EXTENSIONS_IMAGE`/`assertStoragePath` 的先例,改成带点(`'.mp4'`)——需要核实这个先例。
  4. **空白字符串算不算"为空"**:计划原文只写"`productCode` 为空时返回...错误",没说空白字符串(`'   '`)算不算。实现子代理判定算,需要审核者判断这个解读是否合理(不是必须驳回,是要有意识地确认)。
  5. **`reserveExportPath` 是否也要独立校验空 `productCode`**(不只是 `buildExportBaseName`):这是实现子代理自己说"最不确定"的一条推断,已经把相关断言隔离在测试文件里单独一块(约 161-174 行附近),方便万一判断错了单独删掉。

  另外实现子代理提到自我审查时发现并修好了一个坑:第一次写文件时把字面 NUL/BEL 控制字节而不是 ` `/`` 转义序列写进了源码里,已经修复并重新扫描确认没有残留。**审核时建议用 `grep -P '[\x00-\x08\x0b\x0c\x0e-\x1f]' scripts/final-edit-export-naming.test.ts` 之类的命令再核实一遍**,这种问题肉眼读代码看不出来。

  质量审核(spec 通过之后再做)按 `~/.claude/skills/requesting-code-review/code-reviewer.md` 模板,`BASE_SHA` 用 `95c9272` 的上一个 commit(`bf6c46b`),`HEAD_SHA` 用 `95c9272`。

### Task 4 — audio-first-matcher 失败测试 ❌ 还没开始

- 内容:新文件 `scripts/final-edit-audio-first-matcher.test.ts`,针对还不存在的 `lib/final-edit/audio-first-matcher.ts`(Phase 3 才实现)写失败测试,和 Task 3 是同一种性质(刻意的红灯测试,不要顺手把实现也写了)。
- 依据计划 §7.4(尤其 §7.4.1 语义分矩阵、§7.4.2 求解器契约、§7.4.3 节拍吸附),核心要断言的点:
  - `AudioFirstMatchInput` 的形状(§7.4.2 已经给出完整 TS 定义,可以直接抄)。**注意**:这个类型里引用了 `TimelineLock[]`(`manualLocks: TimelineLock[]`),但 `TimelineLock` 本身在计划全文里**没有给出定义**——这是计划文档本身的一个空档,不是遗漏没找到。处理方式参照 Task 3 处理 `ReservedPath` 的方式:自己定一个最小合理形状(比如 `{ sentenceId: string; assetKey: string; startUs: number; endUs: number }`),在文件里写清楚"这是假设,Phase 3 定稿",不要卡在这里。
  - 确定性:相同输入必须产生相同输出(计划 §7.4.2 末尾原话:"输出必须是确定性的 `TimelinePlan + MatchDiagnostics`")。
  - 语义地板公式(§7.4.2 第 1 条):`max(0.3, 红线 0.35, 该句最佳分 × 0.85)`,低于地板的候选重罚,记入 `backoffSentences`。
  - LLM 打分失败降级(§7.4.1):全 0.6 均匀矩阵 + 全 0 hook 分,`MatchDiagnostics.semanticFallback = true`,流程不中断。
  - 节拍吸附不变量(§7.4.3):偏移 ≤0.2s、相邻两段等量互补、**Σ 时长不变**、`beatPoints` 为空时跳过、结果记入 `MatchDiagnostics.snappedCuts`。
  - 用户锁定片段是硬约束(§7.4.2 第 7 条)。
  - 素材不足时产生显式 gap/issue,不跨组取材(§7.4.3 末段)。
- 这个任务比 Task 3 更需要"标准模型"甚至更高判断力的模型去写(算法契约密度高,写出无意义断言的风险比 Task 3 大),建议不要用最便宜的模型。
- 走同样的流程:实现子代理 → spec 审核 → 质量审核 → 有问题打回修 → 复查。

## Phase 0 收尾前还要做的事(除了 Task 3 审核 + Task 4)

1. Task 3 质量审核跑完(如果有 Important 级别问题,走修复循环)。
2. Task 4 全流程跑完。
3. 补跑 `npm run lint` 和 `npm run build`(worktree 建好时只跑了 `node scripts/*.test.ts`,这两个命令还没跑过,是"记录基线"这个 checklist 项里缺的部分)。
4. 对照 Phase 0 门禁自查:"文档字段与真实数据库一致;没有把 `projects.model` 当型号"——Task 1/2 已经通过测试把这条落实成了可执行断言,这一步主要是汇总确认,不是重新做一遍。
5. **停下来,向用户汇报 Phase 0 完成情况,等确认后再开始 Phase 1。不要自己继续往下跑。** 汇报内容建议包括:4 个 commit 的 SHA、测试/lint/build 结果、还剩下哪些非阻塞的 Minor/Recommendation 观察项(比如 Task 2 遗留的两条)。

## 关于子代理 agent ID 的重要提醒

之前这个 session 里派发过的子代理(实现 Task 1/2/3、审核 Task 1/2)都有形如 `ade73b0519891b86c` 这样的 agent ID,可以用 `SendMessage` 续接对话。**这些 agent ID 是当前 session 绑定的,新开一个 conversation/session 大概率续不上**——如果接手的是新 session,直接用 `Agent` 工具重新派发新的子代理即可,不用尝试去找这些旧 ID,找不到是正常的,不代表出了问题。

## 通用执行纪律(贯穿所有 Phase,不只是 Phase 0)

- 同一 worktree 里,实现类子代理必须严格串行派发,不能并行(会冲突)。
- 每个任务:实现子代理必须拿到任务的**完整原文**(不能让子代理自己去读计划文件),包括相关 schema、类型定义、redline 原文引用——直接把原文摘录粘进 prompt。
- 两阶段审核顺序不能反:先 spec 合规审核(核实做的是不是要求的东西,有没有多做/少做/理解错),通过了才做代码质量审核。质量审核发现 Important/Critical 问题要打回修,修完重新审,不能跳过复查。
- 审核子代理的通用原则:不相信实现子代理的自我报告,必须自己读代码、自己跑命令验证。上面 Task 2 质量审核用 mutation testing 验证修复是否真实有效,是个值得延续的做法。
- 遇到计划文档本身有空档(比如 `TimelineLock` 没定义、`ReservedPath` 没定义)时,允许实现子代理做一个**最小、合理、写明是假设**的判断,不要卡死等人确认——但必须在报告里明确标注,不能悄悄埋掉。
- 涉及的安全红线(§14,全 Phase 通用,不只是命名相关的):所有磁盘路径必须过 `dataRoot()` 和安全 relative-path 解析;禁止接受客户端绝对路径;禁止目录穿越;FFmpeg/FFprobe 必须异步;API Key 只显示配置状态不回显。这些在写测试/实现时都要留意。

## 这份文档还没提交

`git status` 目前显示这份文件本身、以及 5 个 PRD/原型相关的 untracked 文件都还没有 commit(worktree 那边)。按操作规范"不提交用户没明确要求提交的内容",这几个都先留着不动。建议接手时先跟用户确认一下要不要把 worktree 里的交接文档和已经完成的 4 个 commit 一起提交/整理。主仓库这份副本本身也是 untracked 状态。
