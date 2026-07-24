# 智能混剪 V1 — Phase 0 完成 / Phase 1 启动交接文档

> **这份文件是个指针,不是工作现场。** 真正的工作(7 个 commit)都在 git worktree 里:
> `/Users/liangpeijian/for-cc/creative-studio/.worktrees/mixcut-v1`,分支 `mixcut-v1`(从 `mixcut01` 切出,**不是 main**——原因见 2026-07-23 那份 phase0 交接文档的"worktree 基线"一节,判断错了会丢失整个 `lib/final-edit/` 基线)。
> 这份文件放在主仓库和 worktree 各一份(内容一致,均 untracked),方便下一个 session 不管从哪个目录起都能先看到。**改动/继续工作请去 worktree 里做。**
>
> 写文档时间:2026-07-24。**本文档取代 `2026-07-23-mixcut-phase0-handoff.md`**(那份记录的是 Phase 0 做到一半的状态,现已全部完成;旧文档留着作历史记录,不用改)。
> 依据文档(不要改这两份,只读;主仓库和 worktree 里各有一份,内容一致):
> - PRD:`docs/superpowers/specs/2026-07-23-mixcut-prd.md`
> - 技术执行计划:`docs/superpowers/plans/2026-07-23-mixcut-technical-execution.md`(本文档里"§x.x"均指这份计划)

## TL;DR — 接手的 AI 先看这几行

1. **Phase 0(§12,契约冻结)已全部完成**:4 个任务都走完了"实现子代理 → spec 合规审核 → 代码质量审核 → 修复 → 复查"全流程并全部通过。worktree 上现在共 **7 个 commit**(未推送、未合并,纯本地状态)。
2. **当前停在 Phase 0 → Phase 1 的门禁确认点**,已按用户要求汇报并等待确认。**用户明确说过:Phase 之间要回来跟他确认,不能连续跑完 8 个 Phase。** 如果用户让你"继续",指的是开始 Phase 1;Phase 1 完成后同样要停下来汇报。
3. Phase 1 = §12 "分组上下文与素材导入"。任务拆解(把 checklist 拆成几个子任务)是接手 controller 的判断工作,不是计划写死的——参考本文档"Phase 1 启动提示"一节。
4. **基线已记录**:32 个 `scripts/*.test.ts` 中 30 PASS,2 个 FAIL 是 Phase 0 刻意留下的契约红灯(见下,不要试图修绿);`npm run lint` 和 `npm run build` 的红全部来自**未提交的评审原型文件**,与已提交代码无关。
5. 执行纪律与旧版一致(见文末):同一时间只能有一个实现子代理、两阶段审核顺序不能反、审核者必须独立实测(质量审核要做 mutation testing)、计划空档做最小假设并显式标注。

## Phase 0 最终状态

| Commit | 内容 | 审核状态 |
|---|---|---|
| `4edda07` | Task 1:`lib/final-edit/types.ts` 新增 `MixcutContextResponse`/`ExportIdentity`/`MixcutErrorCode` 三个纯类型 | spec ✅ 质量 ✅(2026-07-23 完成) |
| `fa9acd1`+`bf6c46b` | Task 2:`scripts/final-edit-mixcut-context-contract.test.ts`(§5.1 查询规则 + productCode≠model 红线) | spec ✅ 质量两轮后 ✅(2026-07-23 完成) |
| `95c9272`+`1a70bc2` | Task 3:`scripts/final-edit-export-naming.test.ts`(§11.1-11.3/PRD §7.5.2 命名契约,**刻意红灯**) | spec ✅ 质量修复后 ✅(见下) |
| `2777ff3`+`f9c5ae9`+`05f0df2` | Task 4:`scripts/final-edit-audio-first-matcher.test.ts`(§7.4 求解器契约,654 行 9 场景,**刻意红灯**) | spec ✅ 质量修复后 ✅(见下) |

2026-07-24 这个 session 完成的事:Task 3 的 spec+质量审核、Task 4 从零实现+双审。质量审核抓出 3 个真问题,全部修复并经 mutation testing 复查:

1. **Task 3**:`../../../../etc/passwd` 的 POSIX 穿越断言在 POSIX 主机上抓不到 naive-join 变异体(`成片-` 前缀把 `..` 粘成普通段,目录深度恰好抵消)→ `1a70bc2` 加固 dirname 相等断言 + 精确清洗文件名断言,并顺手钉了 relativePath 值和中间点/空格保留。
2. **Task 4 场景 3**:原两素材构造存在"last-wins tie-break + 重复惩罚 λ=0.15、零关键词逻辑"的假绿路径 → `f9c5ae9` 改三素材构造(关键词目标放中间位)。
3. **Task 4 场景 3 残留**:字典序升序 tie-break 仍能蒙对(正确答案 asset-m 恰是字典序最小)→ `05f0df2` 改名 asset-a/b/c(位置序==字典序,字典序决胜坍缩为 first/last-wins,两头都错)。

### Task 4 测试里的关键契约假设(Phase 3 实现 matcher 前必读)

`scripts/final-edit-audio-first-matcher.test.ts` 头部有 7 个编号 JUDGMENT CALL 注释块,这些是计划文档的空档、测试自定假设,**Phase 3 实现 `lib/final-edit/audio-first-matcher.ts` 时必须先看并对齐**:

1. 导出形状 `matchAudioFirst(input): { plan, diagnostics }` 单一纯函数(调用点都走 `await`,异步签名兼容)。
2. `TimelineLock = { sentenceId, assetKey, startUs, endUs }`,startUs/endUs 解释为**源侧**区间。
3. 输入加必填布尔字段 `semanticFallback`(计划接口没定义如何传入降级态;明确拒绝"探测全 0.6 矩阵"的启发式)。
4. plan/diagnostics 最小形状:段含 `sentenceId/assetKey/startUs/endUs/sourceStartUs/sourceEndUs`,audio-first 不变量(源侧时长==口播侧时长、源区间 ⊆ 单场景);diagnostics 含 `semanticFallback/backoffSentences/snappedCuts/gaps/issues`,后三者条目形状不透明。
5. 语义矩阵列序 = 素材输入顺序 → 素材内场景顺序扁平化。
6. 场景 4 的源窗口放置假设("永远尾对齐"之外的合理放置都应可吸附)。
7. `snappedCuts` 只记成功吸附;最短段长不钉数值。

另有一处**刻意的解读钉子**:场景 1 钉"语义地板作用于原始语义分,hook 不能救地板外候选"——移植规格 §5.6 源求解器存在"hook 加权后再算地板"的另一解读,但计划 §7.4.2 措辞("语义可接受集合内""集合外自动回退")支持测试的读法。Phase 3 若在这里挂测试,先回计划澄清,不要直接改测试。

Task 3 测试(`scripts/final-edit-export-naming.test.ts`)同样头部有 5 个 JUDGMENT CALL(错误机制走 `FinalEditError`、`ReservedPath={absolutePath,relativePath,filename}`、扩展名带点、空白算为空、reserveExportPath 独立校验空 productCode),**Phase 6 实现 `lib/final-edit/export-naming.ts` 前必读**。

## 基线记录(Phase 0 checklist 第 4 项,2026-07-24 实测)

- **测试**:`for f in scripts/*.test.ts; do node "$f"; done` → 32 个文件,**30 PASS**。2 个 FAIL 是 Task 3/4 的刻意红灯,均只报 `ERR_MODULE_NOT_FOUND`——Phase 3(matcher)/Phase 6(export-naming)实现后自然变绿,**在此之前不要把它们修绿,也不要因此认为回归**。
- **lint**:`npm run lint` → 46 problems(1 error + 45 warnings)。唯一 error 是 `react-hooks/set-state-in-effect`,位于**未提交**的评审原型 `components/mixcut-prototype/MixcutReviewPrototype.tsx:626`;45 个 warnings 是 tracked 代码的既有 unused-vars 等。7 个 commit 新增的文件 lint 全部干净。
- **build**:`npm run build` → 失败,原因是同一个未提交原型硬编码 `import ... from '@/storage/final-edits/previews/thumbnails/...'`(主仓库本地 storage 里的缩略图,worktree 里没有)。与已提交代码无关。另注:两个红灯测试在 `next build` 的全量 typecheck(tsconfig `**/*.ts`)下会报 TS2307,这是契约冻结测试的固有代价,模块实现后消失。
- 结论:Phase 0 没有引入任何新的 lint/build/测试回归;所有红都来自未提交原型或刻意红灯。

## Phase 0 门禁核对(§12 原文:"文档字段与真实数据库一致;没有把 projects.model 当型号")

- ✅ Task 2 用内存 SQLite 按 `lib/db.ts` 真实 schema 跑原始 SQL 验证 §5.1 查询规则(列名对照过真实源码),质量审核做过 mutation testing。
- ✅ `ExportIdentity` 注释明文禁止 `projects.model`;Task 2 测试把 productCode≠model 落成可执行断言;export-naming 测试零 `projects.model` 引用。

## 遗留非阻塞观察项(不需要处理,后续 Phase 留意即可)

- Task 1 Minor:`taskDate` 的时区换算 JSDoc 未加。
- Task 2:banner 注释风格与邻近测试文件不一致;`isUsableV2Draft` 对 `shotSetId` 只查非空字符串、不校验在 `shot_sets` 表真实存在——计划原文"合法"一词有歧义,**Phase 1 实现 context route 时要定这个词**(选了更严的解释就回头补 Task 2 测试)。
- Task 3:临时目录清理无 try/finally(与邻近测试同风格,失败后留现场便于调试);控制字符断言只覆盖 C0(DEL `\u007F` 未覆盖)。
- Task 4:`maxReuse` 触顶语义、shotId 匹配先验(item 2)刻意未钉(§13 测试矩阵未列);场景 9 不排除"按 assetKey 字典序决胜"的极端 tie-break(信息性,场景 3 已封死)。
- "command"类型:Phase 0 checklist 提到"定义 MixcutContextResponse、command 和错误码",但计划全文没有给出可冻结的 command TS 定义(§6 只在 API 表里提到 group/framing command,实现属后续 Phase),Task 1 双审按此口径通过。Phase 2/4 实现 PATCH 路由时自行定义 command 形状。

## 待用户决策的两件事(接手 AI 见到用户先提醒)

1. **未提交原型的 lint/build 报错**:评审原型(`app/mixcut-preview/`、`components/mixcut-prototype/`,untracked,产品/评审材料)导致 1 个 lint error 和 build 失败。选项:把原型移出构建路径(next.config 排除)、给原型补上 storage 图片、或先把原型挪出 worktree。**不要擅自提交或删除这几个文件。**
2. **untracked 文件是否提交**:worktree 里有 5 个 untracked 项——PRD、技术计划、phase0 交接文档、本文档、两个原型目录。按纪律一直没提交,等用户决定(建议至少把 PRD + 技术计划提交了,后续 Phase 的子代理引用方便;原型由用户定)。

## Phase 1 启动提示

Phase 1 原文(§12):

> **目标:** 第一步使用真实模块 4 分组和视频。
> - [ ] 实现 context route,按 `shotSetId` 聚合脚本和视频。
> - [ ] 增加外部素材迁移、工作区方法、FormData 路由、probe 和缩略图。
> - [ ] 实现左辅栏分组选择和 MaterialStep。
> - [ ] 加入文件丢失、重复导入、跨组访问测试。
> **门禁:** 两个分镜组的数据在 API、UI 和自动选择中均无法串组。

接手 controller 需要自己做任务拆解(同 Phase 0 的做法:每个子任务 = 实现 + spec 审核 + 质量审核)。密切相关的计划章节:§3.1 新文件表、§3.2 修改表、§4.1 外部素材迁移、§5.1 Context 查询(**Task 2 的契约测试已钉住查询规则,route 实现必须满足它**)、§5.2 当前组切换、§6 API 规划、§7.1 状态机(prepare job 相关部分)、§14 安全红线(FormData 文件直读、路径安全、禁止客户端绝对路径)。

注意:

- §5.1 的 `MixcutContextResponse` 类型已在 `lib/final-edit/types.ts` 冻结(4edda07),route 返回必须逐字段对上。
- 外部素材迁移走 `lib/final-edit/schema.ts` 的版本化迁移(追加 `{version, sql}`,不要改已有条目);核心表走 `CORE_DB_MIGRATIONS` 追加式。
- 两个红灯测试与 Phase 1 无关,保持红。
- UI 文案中文;视觉风格 Apple 式精致极简。

## 通用执行纪律(沿用,与旧文档一致)

- 同一 worktree 里实现类子代理严格串行;审核子代理(只读+临时 stub)可与一个实现子代理并行。
- 实现子代理 prompt 必须含任务**完整原文**(计划章节直接摘录粘贴),包括 schema、类型定义、红线原文。
- 两阶段审核顺序:先 spec 合规,过了再质量审核;Important/Critical 打回修,修完必须复查。
- 审核者不信实现者自我报告,必须自己读代码跑命令;**质量审核要做 mutation testing**(本 session 三个真问题都是这么抓出来的,值得延续)。
- 计划空档 → 最小合理假设 + JUDGMENT CALL 注释 + 报告显式标注,不卡死不悄悄埋。
- 安全红线(§14):路径过 `dataRoot()`+安全 relative-path 解析;禁客户端绝对路径/目录穿越;FFmpeg 异步;API Key 只显示配置状态。
- 子代理 commit 用显式路径 `git add <file>`,严禁 `git add -A`(worktree 长期有 untracked 材料)。
- 写测试文件防字面控制字节(用 `` 转义),提交前 `perl -ne 'print "$.:$_" if /[\x00-\x08\x0b\x0c\x0e-\x1f]/' <file>` 扫一遍(macOS 无 `grep -P`)。
- **每个 Phase 完成后停下来向用户汇报,等确认再进下一个。**

## 关于子代理 agent ID

本 session 用过的子代理 ID(agent-0 到 agent-10)只在当前 conversation 有效,新 session 直接重新派发即可,找不到旧 ID 是正常的。
