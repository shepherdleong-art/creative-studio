# 公司可灵 3.0 智能分镜开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只为公司 `openai-video` 的精确模型 `kling-3.0` 增加默认开启、可关闭且能跨重试继承的智能分镜开关。

**Architecture:** 新建一个无副作用的精确能力模块，供创建 API、供应商能力响应、队列和适配器复用。任务创建时把受管状态冻结为 nullable SQLite 整数；公司网关适配器只对精确模型读取该状态，直连可灵保持原状。

**Tech Stack:** Next.js App Router、React 19、TypeScript strict、SQLite/better-sqlite3、Node 原生测试。

---

## Task 1：精确能力与持久化语义

**Files:**
- Create: `lib/video-multi-shot.ts`
- Create: `scripts/video-multi-shot.test.ts`

- [ ] 先写失败测试，覆盖唯一受管组合、相似模型负例、缺省/布尔输入归一化，以及 `1/0/NULL` 到适配器可选布尔值的映射。
- [ ] 运行 `node scripts/video-multi-shot.test.ts`，确认因模块缺失而失败。
- [ ] 实现 `supportsCompanyKlingMultiShot()`、`normalizeVideoMultiShot()` 和 `videoMultiShotFromDb()`；所有字符串比较均大小写敏感且精确。
- [ ] 再运行测试，预期通过。

## Task 2：nullable 数据库迁移

**Files:**
- Modify: `lib/db-migrations.ts`
- Modify: `scripts/db-migrations.test.ts`

- [ ] 先扩展迁移测试，要求 `video_jobs.multiShot` 存在、允许 `NULL`、没有默认值，且历史行升级后保持 `NULL`。
- [ ] 运行 `node scripts/db-migrations.test.ts`，确认新断言失败。
- [ ] 在 `CORE_DB_MIGRATIONS` 末尾追加 `ALTER TABLE video_jobs ADD COLUMN multiShot INTEGER`，不改已发布迁移。
- [ ] 再运行测试，预期通过。

## Task 3：公司网关请求合同

**Files:**
- Modify: `lib/video-providers/types.ts`
- Modify: `lib/video-providers/openai-video.ts`
- Modify: `scripts/openai-video-adapter.test.ts`

- [ ] 先添加适配器测试：`kling-3.0` 缺省/`true` 发送 JSON boolean 字段，`false` 两字段均省略；`kling-v3`、`kling-v3.0`、`kling-3.0-fast`、Omni 和 Seedance 不注入。
- [ ] 运行 `node scripts/openai-video-adapter.test.ts`，确认宽松正则导致负例失败。
- [ ] 给 `SubmitVideoRequest` 增加 `multiShot?: boolean`，用精确模型判断替换公司网关适配器里的宽松正则。
- [ ] 不修改 `lib/video-providers/kling.ts`。
- [ ] 再运行适配器测试，预期通过。

## Task 4：创建 API 冻结参数

**Files:**
- Modify: `app/api/shot-sets/[id]/video-jobs/route.ts`
- Modify: `app/api/shot-sets/[id]/video-jobs/batch/route.ts`
- Create: `scripts/video-multi-shot-api.test.mjs`

- [ ] 先写 API 合同测试，覆盖单条和批量入口都调用共享归一化函数、INSERT 包含 `multiShot`，且客户端不能让非目标组合写入受管值。
- [ ] 运行 `node scripts/video-multi-shot-api.test.mjs`，确认失败。
- [ ] 两条路由都接受可选 `multiShot`，读取任务实际供应商类型和冻结模型后归一化：目标缺省为 `1`，显式关闭为 `0`，其他组合为 `NULL`。
- [ ] 再运行 API 合同测试，预期通过。

## Task 5：队列透传与重试继承

**Files:**
- Modify: `lib/video-queue.ts`
- Modify: `app/api/video-jobs/[id]/retry/route.ts`
- Create: `scripts/video-queue-multi-shot.test.ts`

- [ ] 先写队列测试，用假适配器捕获提交请求，覆盖数据库 `1/0/NULL` 分别变成 `true/false/字段省略`。
- [ ] 添加重试合同断言：重试只重置执行状态，不接受智能分镜覆盖值，也不把任务模型改成供应商当前默认模型。
- [ ] 运行 `node scripts/video-queue-multi-shot.test.ts`，确认失败。
- [ ] 扩展 `VideoJobRecord` 并在 submit 请求中使用共享 DB 映射；修改重试 SQL 保留原行 `model` 和 `multiShot`。
- [ ] 再运行测试，预期通过。

## Task 6：能力响应与界面

**Files:**
- Modify: `app/api/providers/video/route.ts`
- Modify: `app/api/providers/video/[id]/route.ts`
- Modify: `components/video-tail-frame-state.ts`
- Modify: `components/VideoGenerationPanel.tsx`
- Create: `scripts/video-multi-shot-ui-contract.test.mjs`

- [ ] 先写 UI/API 合同测试，要求仅精确公司模型下发可用能力、仅该运镜行出现默认开启的「智能分镜」勾选框，其他行无禁用占位且 payload 省略字段。
- [ ] 运行 `node scripts/video-multi-shot-ui-contract.test.mjs`，确认失败。
- [ ] 能力接口使用共享谓词；运镜行状态默认 `multiShot: true`；面板只在目标行渲染和提交该字段。
- [ ] 再运行合同测试，预期通过。

## Task 7：回归与验收

**Files:**
- Verify only.

- [ ] 运行：`node scripts/video-multi-shot.test.ts`。
- [ ] 运行：`node scripts/db-migrations.test.ts`。
- [ ] 运行：`node scripts/openai-video-adapter.test.ts`。
- [ ] 运行：`node scripts/video-multi-shot-api.test.mjs`。
- [ ] 运行：`node scripts/video-queue-multi-shot.test.ts`。
- [ ] 运行：`node scripts/video-multi-shot-ui-contract.test.mjs`。
- [ ] 运行尾帧与恢复回归：`node scripts/video-tail-frame-api.test.mjs`、`node scripts/video-tail-frame-ui-state.test.ts`、`node scripts/video-tail-frame-ui-contract.test.mjs`、`node scripts/video-queue-resume.test.ts`。
- [ ] 运行 `npm run lint`，修复本功能引入的问题。
- [ ] 检查 `git diff --check`，确认没有修改直连 `lib/video-providers/kling.ts` 或用户无关文件。

