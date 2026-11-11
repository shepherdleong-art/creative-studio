# 工作台版本标记与团队列表易用性：执行索引

**状态：** `ready-for-agent`

唯一产品依据：[功能方案](../../specs/2026-11-11-工作台版本标记与团队列表易用性-功能方案.md)。本目录面向 DeepSeek 实现；完成后由 Codex 审查。2026-11-11 当前交付仅为文档，尚未实现或运行功能验收。

## 任务与顺序

服务端分页牵涉查询、统计和多个调用者，因此从初步四块拆成六票，后端与界面分开验收。推荐依次执行 **01 → 02 → 03 → 04 → 05 → 06**，共用类型/组件由指定票持有，减少返工。

| 票 | 修改目标 | 依赖 | 主要风险 | 实现交付 |
| --- | --- | --- | --- | --- |
| [01 分镜版本标记](01-分镜版本标记.md) | 缩略图版本、大图当前选用提示 | 无 | 版本编号与实际选用不一致 | 已实现 · `ready-for-human`（待 Codex 审查）；证据 `outputs/2026-11-11-工作台版本标记与团队列表易用性/evidence/01/`；逐条验收见票 Comments |
| [02 待核对说明与分流文案](02-待核对说明与分流文案.md) | 简明卡片、折叠详情、正确阈值名称 | 无 | UI 简化误伤核对或调度语义 | 已实现 · `ready-for-human`（待 Codex 审查）；证据 `outputs/2026-11-11-工作台版本标记与团队列表易用性/evidence/02/`；逐条验收见票 Comments |
| [03 全员任务服务端分页](03-全员任务服务端分页.md) | 分组后选页、全历史搜索、详情及统计调用者 | 无 | 拆组、越权、角标截断、旧链接失效 | 已实现 · `ready-for-human`（待 Codex 审查）；证据 `outputs/2026-11-11-工作台版本标记与团队列表易用性/evidence/03/`；公共合同 `notes/03-pagination-contract.md` |
| [04 团队用量服务端分页与汇总](04-团队用量服务端分页与汇总.md) | 明细分类分页、全范围汇总及导出 | 03 公共分页合同 | 错计费用、误判未映射、500 条截断 | 已实现 · `ready-for-human`（待 Codex 审查）；证据 `outputs/2026-11-11-工作台版本标记与团队列表易用性/evidence/04/`；合同 `notes/04-usage-contract.md` |
| [05 团队用量布局与二级页签](05-团队用量布局与二级页签.md) | 图表上移、页签、详情对话框、共用分页控件 | 04 | 表格挤压、请求竞态、金额随页变化 | 已实现 · `ready-for-human`（待 Codex 审查）；证据 `outputs/2026-11-11-工作台版本标记与团队列表易用性/evidence/05/`；分页控件合同 `notes/05-pagination-component.md` |
| [06 全员任务分页交互](06-全员任务分页交互.md) | 分页、服务端搜索、独立详情 | 03、05 分页控件 | 只搜本页、分组重复分页、旧响应覆盖 | 已实现 · `ready-for-human`（待 Codex 审查）；证据 `outputs/2026-11-11-工作台版本标记与团队列表易用性/evidence/06/`；逐条验收见票 Comments |

03 可抽取按 ID 加载统一费用的底层能力；04 在其上去除用量侧截断。两票串行修改共享查询文件，不能各自留一份同义实现。

## 开工入口

每票只需读取：仓库 `AGENTS.md` → 本索引 → 功能方案中该票引用的章节 → 该票；再按“修改范围”查看对应代码与测试，不要求把全仓文档重新读一遍。

所有外观票先读 `docs/reference/界面外观规范.md`；浏览器尺寸检查先读 `docs/reference/界面尺寸验收.md`。03/04 完成后读 `docs/reference/主流程检查.md` 执行最终跨模块检查。统一调度历史规格只用于理解现有产品规则，本次仅改展示/查询，不重新实施调度功能。

## 工作区基线

本工作区已有其他未提交修改，不能重置、覆盖或混入本批交付。每票开工重新看 `git status --short` 和相关 diff。

2026-11-11 已观察到与本批直接交叉的修改文件：`lib/team-console-overview.ts`、`lib/team-service/console-overview.ts`、`lib/team-service/workspace-counts.ts`、`scripts/workspace-badges.test.ts`、`scripts/team-api-auth-matrix.test.ts`。其他改动包括媒体预览、混剪导出、错误诊断和 `lib/queue.ts` 等，不属于本批实现范围。

在这些文件上增量修改，保留已有修复；交付记录写清本票新增内容。不要为通过旧静态文本断言而保留过时 UI；更新真正改变的合同，同时保持权限、核对和账本语义断言。

## 测试与收尾

- 按每票的测试清单运行；新增测试验证实际分页结果、权限、关联和交互，避免只测试源码字符串。
- 使用隔离数据根与假供应商。真实界面数据仅作为问题描述，不用真实任务产生费用来验收。
- 05/06 配合 UI 验收增加带大量记录的 fixtures，空页面截图不能作为分页通过证据。
- 每票末尾 `Comments` 填：改动文件、验收条目结果、运行命令和退出状态、证据路径、未解决问题。临时截图/报告归 `outputs/` 的本批子目录，勿提交运行数据。
- 最终统一跑 `npm run lint`、本地 TypeScript 的 `--noEmit`、`node scripts/ui-appearance-tokens.test.mjs`、`node scripts/ui-14-dark-appearance-contract.test.mjs`、`npm run check:main-path`，以及本批涉及屏幕的尺寸验收。已经跑过且代码未变的检查可复用结果。
- 实现完的票设 `ready-for-human`，表示等待 Codex 审查；不新增 `done/claimed/resolved` 等分诊状态。更新上表“实现交付”列为证据位置及待审状态。

## Codex 最终审查清单

- [ ] 01：V 标签能还原实际选中 asset，切旧版刷新后保持，失败不假切换。
- [ ] 02：普通人能读懂摘要；未知结果、费用、备用通道解释准确；人工核对能力和安全约束保留。
- [ ] 03：503 任务 / 505 执行记录完整遍历，搜索旧记录、深链接、角标及总览都不依赖当前页。
- [ ] 04：金额与趋势不随页变；页外/跨账期父任务不误判未映射；完整导出与权限正确。
- [ ] 05：图表固定在明细前；详情不挤表格；页签只加载所需列表，员工字段边界有效。
- [ ] 06：分页、筛选、防抖、请求竞态、分组和平铺、详情关闭及重试后刷新均正常。
- [ ] 回归命令和真实浏览器证据齐全；未混入原有改动，未更改调度默认值、账本或生产数据。

## 可直接交给 DeepSeek 的任务说明

> 请按 `docs/superpowers/plans/2026-11-11-工作台版本标记与团队列表易用性/README.md` 实现六张票，产品行为以链接的功能方案为准。先核对工作区已有改动，逐票增量实现和验收。任务与用量明细必须服务端分页，覆盖 500 条之外的历史；费用统计和权限不受分页影响。不要部署。每票记录改动、测试与证据，完成后标为 `ready-for-human`，最后由 Codex 审查。

## Comments

- 2026-11-11：已完成规格与拆票；尚无实现交付。
- 2026-11-11（批次实现，DeepSeek 子代理组，Lead 汇总）：**六票全部实现，票状态均为 `ready-for-human`，等待 Codex 审查。**
  - **交付形态**：工作区增量 + 票内 Comments + 证据目录；**未建分支、未 commit**。原因：开工时工作区已有其他未提交改动，实现期间另一会话仍在修改与本批无关的文件（media preview、mixcut、final-edit、batch-production、creative-canvas 等）。本批不重置、不覆盖、不混入；开工前快照在 `notes/baseline-dirty.diff`、`notes/baseline-git-status.txt`，核对「本批改动 vs 他人并行改动」从这里起算。未部署、未打包。
  - **合同指针**（04/05/06 共用，审查时先读）：`notes/03-pagination-contract.md`（服务端分页参数/响应/调用者）、`notes/04-usage-contract.md`（section 拆分/摘要口径/权限/CSV）、`notes/05-pagination-component.md`（共用分页控件与状态约定）。
  - **最终统一检查**（最后一次 `npm run build` 之后 app 代码未再变）：`npx tsc --noEmit` = 0；`npm run check:main-path` = 0（真实付费调用 0 次）；`node scripts/ui-appearance-tokens.test.mjs` = 0；`node scripts/ui-14-dark-appearance-contract.test.mjs` = 0；本批 25 个单元/合同脚本汇总复跑全部 exit 0。全仓 `npm run lint` 仍为 52 errors / 1286 warnings（与开工基线完全一致，全部来自既有打包产物与压缩库 `packaging/**/gsap.min.js`、`packaging/win-hide-spawn.cjs`，本批未新增）；本批改动文件 `npx eslint` = 0 errors（6 个既有 warning）。
  - **浏览器/尺寸证据**（代码此后未变，可复用）：01 `project-storyboard*` 36 次测量；02 `admin-reconcile` 12 次测量/48 张截图；05 `admin-usage/usage-employee/admin-usage-channels` 36 次测量、4 项检查 72 passed；06 `admin-tasks/admin-tasks-detail/tasks-employee` 36 次测量、72 passed；03/04 为真实 SQLite 回归（503 制作任务/505 执行记录、大于 500 的用量与跨页/跨账期关联）。证据均在 `outputs/2026-11-11-工作台版本标记与团队列表易用性/evidence/<票>/`。
  - **已知缺口/未验证**：02 的服务端 400 文案仍是旧称（`lib/media-core/unified-media/settings.ts` 属该票只读范围；客户端已按新文案拦截，正常操作不可见）；03/04 未新增索引或迁移（503 任务/517 尝试毫秒级，历史继续增长再评估追加）；06 员工侧 fixture 只有 2 个制作任务（单页禁用态，员工多页由 03 合同测试覆盖），`taskHistory` fixture 会额外建一个超长名项目（预期）；05 dev 模式首次编译在本机负载下 Turbopack panic 过一次（PostCSS worker 超时，非代码问题，证据改用 `TEAM_ACCEPTANCE_UI_PRODUCTION=1` + standalone）；06 因本机 dev 首编译超过脚本 120s，给 `team-console-page.playwright.test.mjs` 加了 `TEAM_CONSOLE_TEST_PRODUCTION=1` 开关（默认仍 dev）。真实付费模型、生产账本、部署与打包本次均未触碰。
  - **审查入口**：本文件实施列 → 各票 Comments（逐条验收/命令/证据）→ `notes/03/04/05` 合同 → 证据目录。
