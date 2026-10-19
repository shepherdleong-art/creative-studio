# Gateway Media Local Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不伪造网关能力的前提下，阻止 openai-video 提交已知不可用的本地图片引用，并让媒体下载失败可诊断且不会跨域泄露 Bearer。

**Architecture:** `local-image-url.ts` 负责解析 URL 来源和纯函数私网判断；`openai-video.ts` 在网络请求前执行视频专用预检；`gateway-media-url.ts` 负责逐跳安全下载并返回判别联合。图片/视频主队列和补抓路由只消费统一结果，不复制鉴权或脱敏逻辑。

**Tech Stack:** TypeScript strict、Node.js 22 原生测试、Next.js App Router、内置 Fetch API。

---

### Task 1: 视频输入 URL 预检

**Files:**
- Modify: `scripts/local-image-url.test.ts`
- Modify: `scripts/openai-video-adapter.test.ts`
- Modify: `lib/local-image-url.ts`
- Modify: `lib/video-providers/openai-video.ts`

- [ ] **Step 1: 在 `local-image-url.test.ts` 写失败测试**

新增断言，要求带来源解析接口能区分 `configured` 与 `network`，并要求纯函数把 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`127.0.0.0/8`、`169.254.0.0/16` 判为非公网，把 `8.8.8.8` 判为公网。

- [ ] **Step 2: 在 `openai-video-adapter.test.ts` 写失败测试**

将成功路径图片放在临时 `storage/` 下并配置 `CREATIVE_STUDIO_PUBLIC_BASE_URL=https://media.example.com`，断言请求体使用真实 HTTPS URL；删除配置后使用无法解析为媒体 URL 的文件，断言 `submit()` 在 fetch 前抛出包含 `CREATIVE_STUDIO_PUBLIC_BASE_URL` 的错误且 fetch 次数不增加。

- [ ] **Step 3: 运行 RED 测试**

Run: `node scripts/local-image-url.test.ts`
Expected: FAIL，缺少带来源解析/私网判断接口。

Run: `node scripts/openai-video-adapter.test.ts`
Expected: FAIL，当前代码仍回退 data URL 并执行 fetch。

- [ ] **Step 4: 写最小实现**

在 `local-image-url.ts` 增加：

```ts
export type PublicImageUrlSource = 'configured' | 'network';
export type PublicImageUrlResolution = { url: string; source: PublicImageUrlSource };

export function resolvePublicImageUrlWithSource(filePath: string): PublicImageUrlResolution | null;
export function isPrivateOrLocalHttpUrl(url: string): boolean;
```

保留 `resolvePublicImageUrl(filePath)`，让它返回新接口的 `.url`。在 `openai-video.ts` 删除 data URL 回退；无 URL 或 `source === 'network' && isPrivateOrLocalHttpUrl(url)` 时抛出中文配置错误。

- [ ] **Step 5: 运行 GREEN 测试**

Run: `node scripts/local-image-url.test.ts`
Expected: PASS。

Run: `node scripts/openai-video-adapter.test.ts`
Expected: PASS。

### Task 2: 结构化、安全的网关媒体下载

**Files:**
- Create: `scripts/gateway-media-url.test.ts`
- Modify: `lib/gateway-media-url.ts`
- Modify: `lib/providers/gateway-task-image.ts`
- Modify: `scripts/gateway-task-image.test.ts`

- [ ] **Step 1: 创建下载器失败测试**

覆盖以下期望 API：

```ts
const result = await downloadGatewayMedia(url, baseUrl, apiKey);
if (result.ok) assert.deepEqual(result.buffer, expected);
else assert.match(result.errorMessage, /HTTP 403/);
```

测试场景：网关同源请求携带 Bearer；403 返回状态与响应摘要；摘要不含 API Key/Bearer/signature；网关 302 到 CDN 后第二跳不带 Authorization；超过 5 跳返回失败；`redactMediaUrlForLog()` 删除查询串。

- [ ] **Step 2: 运行 RED 测试**

Run: `node scripts/gateway-media-url.test.ts`
Expected: FAIL，当前返回 `Buffer | null` 且使用自动重定向。

- [ ] **Step 3: 写最小下载器实现**

在 `gateway-media-url.ts` 定义：

```ts
export type GatewayMediaDownloadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; status?: number; errorMessage: string };

export function redactMediaUrlForLog(url: string): string;
```

实现最多 5 跳的 `redirect: 'manual'` 循环，每跳按 `isGatewayOriginUrl()` 重建 headers；非 2xx 读取并脱敏最多 500 字符正文；网络异常返回无状态失败。让 `downloadGatewayTaskImage()` 转发新结果。

- [ ] **Step 4: 更新图片适配器测试并运行 GREEN**

将 `gateway-task-image.test.ts` 的 Buffer 断言改为判别联合断言，并保留网关同源/CDN 无鉴权验证。

Run: `node scripts/gateway-media-url.test.ts`
Expected: PASS。

Run: `node scripts/gateway-task-image.test.ts`
Expected: PASS。

### Task 3: 主队列与补抓调用方接入诊断结果

**Files:**
- Modify: `lib/queue.ts`
- Modify: `app/api/jobs/[id]/resume-poll/route.ts`
- Modify: `lib/video-queue.ts`
- Modify: `app/api/video-jobs/[id]/resume-poll/route.ts`

- [ ] **Step 1: 更新图片调用方**

图片主队列按 `download.ok` 分支；失败时用 `download.errorMessage` 写入 `download_failed`，日志 URL 使用 `redactMediaUrlForLog()`，并保持远端已完成后直接返回、不重新提交。补抓路由在下载失败时写回诊断并结束本次补抓。

- [ ] **Step 2: 更新视频调用方**

`openai-video` 主队列和补抓路由改用 `downloadGatewayMedia()`；其他视频供应商继续使用原 `downloadVideo()`。网关下载失败保存/返回结构化错误，日志 URL 使用脱敏形式。

- [ ] **Step 3: 运行 TypeScript/定向回归**

Run: `node scripts/gateway-media-url.test.ts`
Expected: PASS。

Run: `node scripts/gateway-task-image.test.ts`
Expected: PASS。

Run: `node scripts/openai-video-adapter.test.ts`
Expected: PASS。

### Task 4: 全量静态验证与交付检查

**Files:**
- Verify only: all modified files

- [ ] **Step 1: 运行全部相关测试**

Run: `node scripts/local-image-url.test.ts`
Run: `node scripts/openai-video-adapter.test.ts`
Run: `node scripts/gateway-media-url.test.ts`
Run: `node scripts/gateway-task-image.test.ts`
Expected: 全部 PASS。

- [ ] **Step 2: 运行 lint**

Run: `npm run lint`
Expected: exit 0，无 ESLint error。

- [ ] **Step 3: 运行生产构建**

Run: `npm run build`
Expected: exit 0，standalone 资源同步完成。

- [ ] **Step 4: 检查差异与安全边界**

Run: `git diff --check`
Expected: 无空白错误。

确认差异中没有 API Key、Bearer、签名 URL，没有修改数据库 schema，没有改变图片网关输入行为，也没有覆盖工作区原有改动。

> 本计划不自动创建 Git commit：当前工作区已有用户未提交改动，且用户仅授权本地修改。提交应在用户明确要求后单独进行。
