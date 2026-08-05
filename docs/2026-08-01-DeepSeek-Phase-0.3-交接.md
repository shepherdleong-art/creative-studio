# Creative Studio 批量混剪 Phase 0.3 交接

## 本次交接目标

请在现有 `mixcut01` 分支上继续实施“批量混剪”的 **Phase 0.3：完整批量领域表**。不要重做已经完成的 Phase 0.1／0.2，也不要提前进入素材 UI、任务调度、代理、LUT、联合分配、Electron 或真实供应商联调。

用户不懂技术，希望每一阶段都用通俗中文说明。完成 Phase 0.3 后必须停下来报告并等待用户确认，不能自行继续 Phase A。

## 仓库与当前状态

- 仓库：`/Users/liangpeijian/for-cc/creative-studio`
- 当前分支：`mixcut01`
- 交接时工作区：干净
- 交接时分支状态：本地领先 `origin/mixcut01` 5 个提交，尚未推送
- 最近 5 个批量混剪提交：
  - `bd77297 docs: define batch mixcut implementation roadmap`
  - `1c394c6 feat: add batch schema upgrade gate`
  - `ee6021a fix: harden batch schema upgrade validation`
  - `d27eb8c feat: add guarded batch schema readiness`
  - `478399f fix: harden schema upgrade recovery`

以上状态可能随时间变化。开始前先执行 `git status --short --branch` 和 `git log -7 --oneline`，以当前工作树为准。不要覆盖或顺手提交用户的无关改动。

## 权威文档（按优先级阅读）

不要在本交接文档里重新发明产品规则，以下文件才是完整依据：

1. 实施顺序：`/Users/liangpeijian/for-cc/creative-studio/docs/superpowers/plans/2026-08-01-batch-mixcut-implementation.md`
2. 产品需求：`/Users/liangpeijian/for-cc/creative-studio/docs/superpowers/specs/2026-07-31-batch-mixcut-desktop-prd.md`
3. 技术总图：`/Users/liangpeijian/for-cc/creative-studio/docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/map.md`
4. Phase 0.3 的直接领域依据：
   - `/Users/liangpeijian/for-cc/creative-studio/docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/02-定义批量生产的数据模型.md`
   - `/Users/liangpeijian/for-cc/creative-studio/docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/assets/02-批量生产数据模型.md`
5. 迁移安全依据：
   - `/Users/liangpeijian/for-cc/creative-studio/docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/01-先画出现有工程的安全边界.md`
   - `/Users/liangpeijian/for-cc/creative-studio/docs/superpowers/plans/2026-07-31-batch-mixcut-desktop-wayfinder/10-设计兼容迁移与桌面打包.md`
6. 仓库约束：`/Users/liangpeijian/for-cc/creative-studio/AGENTS.md` 和 `CLAUDE.md`

参考项目 `AI-remix-master` 只证明“多素材＋多文案＋卡片检查＋批量导出”的产品路径，不要复制它的 Python 后端、Electron renderer 或界面技术栈。

## 已完成的代码地基

### Phase 0.1

- `lib/batch-production/schema.ts` 已有独立的 `BATCH_SCHEMA_MIGRATIONS` 和 `batch_schema_migrations` 版本表。
- v1 已创建最小 `batch_productions` 身份表。
- 首次待执行迁移前使用 SQLite Online Backup，校验完整性、外键、文件大小和 SHA-256。
- 单条迁移使用事务；失败进入 `compatibility_only`，旧功能继续可用。

### Phase 0.2

- `lib/schema-upgrade/` 已提供共享备份、跨进程锁、审计、恢复候选、运行路径和通用升级门禁。
- `GET /api/batch-production/readiness` 返回批量 schema 是否可用。
- `GET /api/batch-production/recovery` 只列出并重新验证备份候选；运行中的 API 不允许覆盖主数据库。
- 旧 `video_providers` gateway 表重建已纳入相同的安全升级门禁。
- 真正“恢复备份覆盖主库”的动作仍需以后由桌面壳在工作台完全退出后提供；Phase 0.3 不实现该动作。

重点代码入口：

- `lib/batch-production/schema.ts`
- `lib/batch-production/readiness.ts`
- `lib/batch-production/runtime-readiness.ts`
- `lib/schema-upgrade/gate.ts`
- `lib/schema-upgrade/backup.ts`
- `lib/schema-upgrade/lock.ts`
- `lib/schema-upgrade/audit.ts`
- `lib/schema-upgrade/recovery.ts`

## Phase 0.3 要实现什么

目标是把已确认的领域对象变成可迁移、可验证、可由公开模块接口使用的数据结构：

- 项目素材
- 素材分析版本
- 项目脚本版本
- 批次与批次版本
- 批次素材池
- 脚本快照
- 成片计划
- 成片版本
- 生产任务
- 任务尝试
- 正式产物及其来源／当前成片指向

注意：领域文档明确说“领域对象不自动等于一张数据库表”。先对照现有项目表、脚本表、`final_edit_*` 表和产物结构，决定哪些需要新表、哪些只需要稳定引用。不要为了表面完整机械地建立十一张孤立表。

实施建议：

1. 先只读审计现有 schema 和对应访问接口，列出新旧对象映射及命名。
2. 把 Phase 0.3 拆成连续的追加 migration（v2、v3……）；已发布 v1 绝不能修改。
3. 每次只做一个有公开 TypeScript 接口和测试的垂直切片，不一次塞入无法使用的大表集合。
4. 先写失败测试，再加 migration、结构验证和模块接口。
5. 新 migration 必须继续经过 Phase 0.1／0.2 的备份、锁、审计与兼容模式门禁。
6. 完整模型完成后更新实施计划，把 0.3 标成已完成，并同步 `AGENTS.md`／`CLAUDE.md` 中确实发生变化的架构说明。

## 必须守住的业务不变量

- 用户设置生成 N 条，就只建立 N 条稳定成片计划；失败重试只能增加任务尝试，不能多出第 N+1 张卡片。
- 项目素材和项目脚本可以继续变化；批次第一次开始后，素材、采用的分析版本、脚本文本、标题、份数和默认设置必须形成不可静默漂移的快照。
- 修改整个批次输入形成新批次版本；只修改一条成片形成新成片版本。
- 正式产物追加保存，不覆盖历史；成片计划只维护一个“当前成片”指向。
- 部分成功必须可表达，例如 20 条中 18 条成功、2 条失败；成功结果不能因其他项失败被回滚。
- 素材身份不能依赖文件路径；离线、归档、代理清理、正式产物删除是不同状态。
- 链接素材不能因项目清理而删除用户手机、相机或移动硬盘里的原文件。
- 现有单条精准混剪的 `final_edit_*`、`FinalEditWorkspace`、`projectId + shotSetId` 隔离和历史版本规则不变。
- 不新增 `mixcut_sessions`；不要用 `projects.model` 承载新领域含义；保留 `projects.productCode`。
- 所有运行数据路径必须通过 `dataRoot()`，不能硬编码 `data/` 或 `storage/`。

## 本阶段禁止事项

- 不做 UI，不把按钮塞进现有大组件。
- 不实现调度器、暂停／恢复、自动并发或 FFmpeg 批量执行。
- 不实现代理、LUT、联合分配或批量导出。
- 不修改 LiteLLM、Cloudflare 或腾讯云链路。
- 不新增 Electron 依赖，不构建安装包。
- 不调用真实 AI、TTS、视频分析或公司供应商。
- 不上传项目派生媒体。
- 不修改用户真实数据库；旧库验证只能使用 SQLite online backup 副本或临时数据根。
- 不推送远端分支，除非用户再次明确授权。

## 测试与验收要求

至少覆盖：

- 从 v1 逐步升级到 Phase 0.3 最终版本，先备份后迁移。
- 重复启动幂等。
- 中途失败时单个 migration 事务回滚，批量入口进入兼容模式，旧功能仍可用。
- 结构、索引、外键和版本历史校验。
- N 条计划与重试不增卡片。
- 脚本／素材快照不被上游修改覆盖。
- 批次版本、单条成片版本和正式产物历史均可追溯。
- 部分完成状态或其必要数据事实可以被正确表达。
- 在真实旧数据库的在线备份副本上升级，并核对旧表、旧行数和关键数据不变。
- Phase 0.1／0.2 的所有回归测试继续通过。

现有相关测试：

```bash
node scripts/batch-schema-upgrade.test.ts
node scripts/batch-production-readiness.test.ts
node scripts/batch-production-crash-recovery.test.ts
node scripts/batch-schema-real-database-copy.test.ts
node scripts/schema-upgrade-lock.test.ts
node scripts/schema-upgrade-recovery.test.ts
node scripts/video-provider-schema-upgrade.test.ts
node scripts/video-provider-schema-readiness.test.ts
node scripts/db-migrations.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

交接时最近一次证据：TypeScript 通过；Lint 0 错误、41 个既有警告；生产构建通过但有一个既有 Turbopack upload route tracing 警告；非 Playwright 测试 93/94 通过。唯一失败是 `scripts/final-edit-mixcut-flow.test.ts` 的旧测试夹具缺少 `projects.productCategory`，与 Phase 0.2 无关。开始工作后仍需重新验证，不能把这段旧结果当作当前通过证明。

## 验证责任与交回材料

DeepSeek 负责实现、编写测试和完成第一轮自检，但 **无权代替最终验收方宣布 Phase 0.3 已验收通过**。实现完成后由用户把结果交回 Codex；Codex 将基于实际工作树和提交独立复验，再向用户给出“通过、部分通过或需要返工”的结论。

DeepSeek 交回时必须提供：

- 当前分支、`git status --short --branch` 和本阶段 commit hash。
- 本阶段新增、修改文件清单，以及每个 migration 版本对应的领域切片。
- 所有聚焦测试的完整命令和通过／失败结果，不能只写“测试通过”。
- `npx tsc --noEmit`、`npm run lint`、`npm run build` 和非 Playwright 全量回归结果。
- 真实旧数据库在线备份副本的来源说明、迁移前后表数／行数／关键数据核对结果；不得包含 API Key 或其他敏感值。
- 所有未通过项、既有基线问题、未运行的测试层级和原因。
- 明确声明是否调用过真实供应商、是否修改过用户真实数据库、是否推送远端。

Codex 最终复验至少包括：

1. 核对实际分支、脏工作区、提交范围和 diff，排除无关或危险改动。
2. 对照 PRD、领域模型和实施计划检查表结构、版本关系及业务不变量。
3. 检查 v1 未被改写，新增 migration 可重复、失败可回滚，并继续经过备份、锁、审计和兼容模式门禁。
4. 独立重跑聚焦测试、TypeScript、Lint、Build 和非 Playwright 全量回归。
5. 使用新的临时在线备份副本复验旧数据库迁移；不复用 DeepSeek 的临时数据库作为唯一证据。
6. 分开报告代码、逻辑／数据库、真实媒体、真实供应商、macOS、Windows 和用户操作验收，未验证的层级不能写成通过。

只有 Codex 独立复验通过并向用户报告后，Phase 0.3 才算最终验收完成。用户确认之前，任何代理都不能继续 Phase A。

## 完成与交付方式

Phase 0.3 只有在代码、聚焦测试、真实旧库副本验证、TypeScript、Lint、Build、非浏览器全量回归和代码审查都完成后才能报告完成。

提交时：

- 先检查脏工作区，只显式暂存本阶段文件，不使用 `git add -A`。
- 建议按可回滚的小步提交；最终列出 commit hash。
- 不推送。
- 用通俗中文告诉用户：新增了哪些“账本”、保护了哪些旧数据、验证到了哪一层、仍未做 UI／真实媒体／真实供应商／安装包。
- 完成后停在 Phase 0.3，等待用户确认是否进入 Phase A。

## 建议技能

如果当前代理环境提供这些仓库技能，建议按顺序使用：

1. `domain-modeling`：把领域文档映射成稳定身份、版本与引用，不机械地一对象一表。
2. `codebase-design`：先确认新批量模块与 `final_edit_*`、核心项目表之间的边界。
3. `tdd`：先写迁移和业务不变量失败测试。
4. `implement`：按 Phase 0.3 的垂直切片实施并完成验证。
5. `code-review`：提交前分别做规范审查和规格符合性审查。

## 建议给用户的开场说明

“我已经核对交接文档、当前分支和 Phase 0.3 的领域模型。接下来只实现批量生产的数据账本，不做界面、不调用真实供应商、不动你的真实数据库，也不会推送。完成本阶段后我会停下来，用通俗语言汇报并等你确认。”
