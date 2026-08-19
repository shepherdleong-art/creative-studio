# 核心模型消耗看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为五个固定核心模型建立后端固定计价、可恢复幂等流水、聚合 API 和 `/usage` 看板，同时彻底排除公网/测试供应商及手动价格对看板的影响。

**Architecture:** `usage-pricing` 负责精确身份门禁和版本化微元价格，独立 `usage-schema` 管理流水与调用证据，`usage-ledger` 负责快照、幂等记录、恢复和回填。异步图片/视频在任务行保存价格快照；LLM/TTS 在真实请求前写调用事件并在成功证据出现后转入流水。查询层只读流水，页面不读取供应商价格字段。

**Tech Stack:** Next.js App Router、React 19、TypeScript strict、SQLite/better-sqlite3、原生 SVG/CSS 图表、Node 原生测试。

---

## Task 1：固定身份、价格和金额计算

**Files:**
- Create: `lib/usage-pricing.ts`
- Create: `scripts/usage-pricing.test.ts`

- [ ] 先写失败测试，覆盖五个完整身份的正例及 Packy、Gemini、Anthropic、V-API、直连可灵/即梦、相似 ID/模型、外接 `gpt` 的负例。
- [ ] 固定断言：图片 ¥1.05/张；可灵 ¥2.99/5 秒；Seedance Fast ¥11.73/5 秒；GPT 三类 token 价格；豆包 TTS ¥0.28/千字符。
- [ ] 断言金额逐分项以整数微元四舍五入：两个视频 5 秒分别为 `2_990_000`、`11_730_000` 微元，其他时长按 `durationSec / 5` 线性折算。
- [ ] 运行 `node scripts/usage-pricing.test.ts`，确认模块缺失导致失败。
- [ ] 实现精确 `resolveCoreUsagePlan()`、版本化价格分项、快照类型与纯金额计算函数。
- [ ] 再运行测试，预期通过。

## Task 2：独立 schema 与核心快照列

**Files:**
- Create: `lib/usage-schema.ts`
- Modify: `lib/db.ts`
- Modify: `lib/db-migrations.ts`
- Create: `scripts/usage-schema.test.ts`
- Modify: `scripts/db-migrations.test.ts`

- [ ] 先写 schema 测试，要求独立版本表、`usage_ledger`、`usage_call_events`、唯一键和三个查询索引存在。
- [ ] 扩展 core 迁移测试，要求 `jobs.usageSnapshotJson` 与 `video_jobs.usageSnapshotJson` 为 nullable，供应商表不新增统计/计价列。
- [ ] 运行两个测试，确认失败。
- [ ] 追加两条 core migration；实现只追加的 usage migrations，并在 `getDb()` 初始化中以可降级方式执行，失败不得阻塞旧功能。
- [ ] 再运行测试，预期通过。

## Task 3：幂等流水、调用事件、恢复与历史图片回填

**Files:**
- Create: `lib/usage-ledger.ts`
- Modify: `instrumentation.ts`
- Create: `scripts/usage-ledger.test.ts`

- [ ] 先写测试覆盖：相同 `eventKey` 只写一行；复合 GPT 分项可复算总额；`billable` 能 drain 为 `recorded`；其他实例遗留 `started` 转 `uncertain` 且不计费。
- [ ] 覆盖成功图片/视频由任务快照补记；未知快照版本拒绝按当前价格重算；schema 不可用时不抛出到核心业务。
- [ ] 覆盖 `image-backfill-v1`：只处理精确公司图片核心 ID，历史元金额乘 `1_000_000`，完成标记与流水同事务，且不与实时 eventKey 重复。
- [ ] 运行 `node scripts/usage-ledger.test.ts`，确认失败。
- [ ] 实现调用事件开始/标记 billable/drain、`recordUsage()`、`reconcileUsageLedger()`、实例恢复和一次性回填；在 Node 启动 instrumentation 中触发可降级恢复。
- [ ] 再运行测试，预期通过。

## Task 4：稳定核心供应商补种

**Files:**
- Modify: `lib/seed.ts`
- Modify: `scripts/company-provider-seed.test.ts`

- [ ] 先写测试：同模型手工/公网配置存在时，三个公司图片/视频稳定 ID 仍会补种；原用户配置不覆盖、不删除。
- [ ] 断言老库 `script_providers.gpt` 的外接配置不被强制改成公司执行域。
- [ ] 运行 `node scripts/company-provider-seed.test.ts`，确认当前按模型去重的实现失败。
- [ ] 将公司图片/视频补种条件改为稳定 ID，保留 `ON CONFLICT` 的用户配置保护语义。
- [ ] 再运行测试，预期通过。

## Task 5：图片与视频异步任务记账

**Files:**
- Modify: `lib/queue.ts`
- Modify: `lib/video-queue.ts`
- Create: `scripts/usage-async-jobs.test.ts`

- [ ] 先用内存数据库和假适配器写测试：仅两个精确公司任务在首次真实提交前冻结快照，恢复轮询与重试复用旧快照。
- [ ] 覆盖图片成功按现有尝试张数记账；视频以请求 `durationSec` 计量；失败、`needs_check`、公网/相似模型不记；重复完成幂等。
- [ ] 运行 `node scripts/usage-async-jobs.test.ts`，确认失败。
- [ ] 在真实 submit 前解析固定计价并持久化快照；成功事务后调用幂等记账，失败仅脱敏告警且不回滚任务成功。
- [ ] 再运行测试，预期通过。

## Task 6：公司 GPT 用量保留与记账

**Files:**
- Modify: `lib/script-providers/openai-compatible.ts`
- Modify: `lib/script-providers/index.ts`
- Modify: `scripts/openai-compatible-adapter.test.ts`
- Create: `scripts/usage-llm.test.ts`

- [ ] 先写测试覆盖公司精确运行身份、有/无图片的类别、成功响应 usage、缓存 token 拆分、缺 usage 字符估算、业务 JSON 解析失败仍计费、网络失败不计费。
- [ ] 断言每次真实上游重试产生新的 `llm-call:<callId>`，非公司或非精确模型不创建调用事件。
- [ ] 运行两个测试，确认失败。
- [ ] 在保持现有 `chatCompletion(): Promise<string>` 外部合同的前提下保留响应 usage；`completeJson` 和 selling-points 入口透传可选 `usageContext`。
- [ ] 成功 HTTP 响应后、JSON 解析前把事件标记 billable 并 drain；日志不得包含提示词、密钥或鉴权串。
- [ ] 再运行测试，预期通过。

## Task 7：豆包 TTS 真实调用记账

**Files:**
- Modify: `lib/final-edit/runtime.ts`
- Modify: `lib/batch-production/narration-executor.ts`
- Modify: `lib/media-core/adapters/tts-registry.ts`
- Modify: `lib/media-core/adapters/doubao-tts.ts`
- Modify: `app/api/providers/tts/[id]/preview/route.ts`
- Create: `lib/usage-tts.ts`
- Create: `scripts/usage-tts.test.ts`

- [ ] 先写测试：成片、批量和首次试听中每个真实豆包上游请求（包括分段/chunk 请求）各生成新 `tts-call:<callId>`；有效音频后 billable；供应商失败不计费。
- [ ] 覆盖成片已有口播、批量音频复用、试听缓存命中和 V-API 路径均不创建调用事件。
- [ ] 运行 `node scripts/usage-tts.test.ts`，确认失败。
- [ ] 把可选 usage context 从成片、批量和试听入口传到豆包适配器，在低层真实 HTTP 请求边界创建/完成调用事件；缓存命中不会到达该边界。每个请求按 `Array.from(chunkText).length` 记字符，任务 ID 仅作引用而不代替 callId。
- [ ] 再运行测试，预期通过。

## Task 8：查询、上海时区边界与 API

**Files:**
- Create: `lib/usage-query.ts`
- Create: `app/api/usage/route.ts`
- Create: `app/api/usage/records/route.ts`
- Create: `scripts/usage-query.test.ts`
- Create: `scripts/usage-api-contract.test.mjs`

- [ ] 先写纯查询测试，覆盖 UTC+8 今日/周一/月边界、左闭右开、金额/调用/原生用量聚合、占比、分类小计、30 日补零和多模型序列。
- [ ] 写 API 合同测试，覆盖筛选白名单、`unresolvedCount`、稳定 `createdAt DESC, id DESC` 分页和 `pageSize <= 100`。
- [ ] 运行两个测试，确认失败。
- [ ] 实现参数校验、聚合和明细查询；读取前执行可降级 reconciler，schema 不可用时返回明确的 503 JSON，不影响其他 API。
- [ ] 再运行测试，预期通过。

## Task 9：看板页面、导航和设置页边界

**Files:**
- Create: `app/usage/page.tsx`
- Create: `components/UsageDashboard.tsx`
- Modify: `components/Header.tsx`
- Modify: `app/settings/page.tsx`
- Modify: `app/api/providers/[id]/route.ts`
- Modify: `app/api/providers/tts/[id]/route.ts`
- Create: `scripts/usage-ui-contract.test.mjs`

- [ ] 先写合同测试，要求「消耗」导航、三张汇总卡、模型排行、30 天趋势、模型/日期/类别筛选、稳定流水表和固定“非上游真实账单”提示。
- [ ] 断言设置页对公司图片核心卡和豆包核心 TTS 卡不显示/提交手动价格，更新 API 也忽略这两个核心 ID 的价格字段；视频与公司 GPT 本来就不新增价格窗口。
- [ ] 运行 `node scripts/usage-ui-contract.test.mjs`，确认失败。
- [ ] 使用 CSS 与原生 SVG 实现响应式中文看板，不增加图表依赖；金额仅在展示层把微元换成人民币。
- [ ] 修改导航与设置/API 边界，兼容旧成本字段继续服务原功能但不影响看板。
- [ ] 再运行合同测试，预期通过。

## Task 10：综合验证

**Files:**
- Verify only.

- [ ] 逐个运行 Task 1–9 新增及修改的测试。
- [ ] 运行相关回归：`node scripts/company-provider-seed.test.ts`、`node scripts/openai-compatible-adapter.test.ts`、`node scripts/final-edit-doubao-tts.test.ts`、`node scripts/batch-narration-word-timings.test.ts`、`node scripts/video-queue-resume.test.ts`。
- [ ] 运行 `npm run lint`。
- [ ] 运行 `npm run build`，确认 Next.js route、客户端组件和 strict TypeScript 一起通过。
- [ ] 运行 `git diff --check` 并复核：仅五个核心模型可进入流水；所有价格来自代码注册表；5 秒参考价标注为估算；没有触碰用户未跟踪文件。
