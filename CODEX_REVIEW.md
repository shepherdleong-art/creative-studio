# 批量图片编辑工作台 — Codex 审查文档

> 基于 `batch-image-edit-workbench-spec.md` 搭建的 MVP。  
> 技术栈：Next.js 16 + TypeScript + SQLite (better-sqlite3) + Tailwind CSS + 本地文件存储。  
> 构建工具：Claude Code（本机直接搭建，无 git 历史，首版代码）。

---

## 1. 项目结构总览

```
batch-image-workbench/
├── app/
│   ├── api/
│   │   ├── images/[...path]/route.ts      # 图片服务（路径防穿越）
│   │   ├── jobs/[id]/route.ts             # 标记任务（可用/返工/废弃）
│   │   ├── jobs/[id]/retry/route.ts       # 重试单个任务
│   │   ├── projects/route.ts              # 项目 CRUD (GET 列表, POST 创建)
│   │   ├── projects/[id]/route.ts         # 项目详情 (GET), 删除 (DELETE)
│   │   ├── projects/[id]/run/route.ts     # 队列控制 (start/pause/resume/cancel)
│   │   ├── projects/[id]/export/route.ts  # CSV 导出
│   │   ├── projects/[id]/logs/route.ts    # 运行日志查询
│   │   ├── providers/route.ts             # 供应商列表 (GET) + 创建 (POST)
│   │   ├── providers/[id]/route.ts        # 供应商编辑 (GET/PUT/DELETE)
│   │   ├── upload/route.ts                # 文件上传（保存到本地磁盘）
│   │   └── upload/register/route.ts       # 注册图片资产到 DB
│   ├── projects/[id]/page.tsx             # 项目详情页（队列 + 结果 + 日志）
│   ├── projects/new/page.tsx              # 新建项目页
│   ├── settings/page.tsx                  # 供应商配置管理页
│   ├── layout.tsx                         # 全局布局 + 导航
│   ├── globals.css                        # Tailwind + 自定义组件样式
│   └── page.tsx                           # 首页（项目列表）
├── components/
│   ├── ProviderSettings.tsx               # 供应商选择卡片（用于新建项目页）
│   ├── ImageUploader.tsx                  # 图片上传（拖拽 + 缩略图预览）
│   ├── PromptEditor.tsx                   # 提示词编辑器（含 3 个内置模板）
│   ├── JobQueueTable.tsx                  # 任务队列表格（状态/耗时/成本）
│   ├── ResultGallery.tsx                  # 结果网格 + 原图/结果图对比弹窗
│   └── LogViewer.tsx                      # 运行日志查看器（终端风格）
├── lib/
│   ├── db.ts                              # SQLite 数据库初始化 + 表结构
│   ├── queue.ts                           # 应用内并发队列引擎
│   ├── cost.ts                            # 成本计算 + CSV 生成
│   ├── logger.ts                          # 持久化日志系统（DB + 文件）
│   ├── seed.ts                            # 供应商种子数据
│   └── providers/
│       └── openai-compatible.ts           # OpenAI /v1/images/edits API 适配器
├── storage/                               # 本地文件存储
│   ├── inputs/                            # 上传的待处理图
│   ├── outputs/                           # 生成的结果图
│   ├── references/                        # 上传的参考图
│   ├── logs/                              # 运行日志文件
│   └── workbench.db                       # SQLite 数据库文件
├── .env.local                             # 环境变量（API Key 等）
├── package.json
└── tsconfig.json
```

---

## 2. 数据模型（SQLite 5 张表）

### providers
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| name | TEXT | 供应商名称 |
| baseUrl | TEXT | API 地址 |
| apiKeyEnv | TEXT | 环境变量名（如 PACKY_API_KEY） |
| apiKey | TEXT | **实际密钥（直接存储在 DB 中）** |
| model | TEXT | 默认模型名 |
| type | TEXT | openai-compatible |
| enabled | INTEGER | 0/1 |
| defaultCostPerImage | REAL | 单张预估成本 |

### projects
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| name | TEXT | 项目名称 |
| providerId | TEXT FK | 关联供应商 |
| model | TEXT | 使用的模型 |
| prompt | TEXT | 统一提示词 |
| concurrency | INTEGER | 并发数 |
| maxAttempts | INTEGER | 最大重试次数 |
| status | TEXT | draft/running/completed/partial_failed/canceled |

### image_assets
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| projectId | TEXT FK | 关联项目 |
| role | TEXT | reference/input/output |
| filename | TEXT | 原始文件名 |
| path | TEXT | 本地存储路径 |

### jobs
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| projectId | TEXT FK | 关联项目 |
| inputImageId | TEXT FK | 输入图片 |
| referenceImageIds | TEXT | JSON 数组 |
| providerId | TEXT | 供应商 |
| status | TEXT | pending/running/succeeded/failed/retrying/canceled |
| attempt | INTEGER | 当前尝试次数 |
| latencyMs | INTEGER | 耗时 |
| estimatedCost | REAL | 预估成本 |
| errorMessage | TEXT | 错误信息（已脱敏） |

### job_logs
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| jobId | TEXT | 关联任务 |
| projectId | TEXT | 关联项目 |
| level | TEXT | info/warn/error/debug |
| message | TEXT | 日志内容（已脱敏） |
| attempt | INTEGER | 第几次尝试 |
| createdAt | TEXT | 时间戳 |

---

## 3. 关键架构决策

### 3.1 并发队列（`lib/queue.ts`）

- **模式**：应用内队列，基于 `Promise.allSettled` 的简化并发控制
- **核心参数**：concurrency（默认 3）、maxAttempts（默认 2）、timeoutMs（默认 180000）
- **流程**：
  1. 从 `jobs` 表取 `pending`/`retrying` 状态任务
  2. 同时最多运行 `concurrency` 个任务
  3. 成功 → 保存图片到 `storage/outputs/`，记录 latency/estimatedCost
  4. 失败 → attempt < maxAttempts 进入 retrying；否则标记 failed
  5. 全部完成后更新 Project 状态
- **控制**：支持 pause / resume / cancel（通过 AbortController + 内存状态）

### 3.2 API Key 管理

- **存储**：Key 存储在 SQLite `providers.apiKey` 列中（本地文件）
- **前端配置**：`/settings` 页面可直接填写 Base URL 和 API Key
- **Key 输入**：`type="password"`，已保存的 Key 不回显
- **后端返回**：所有 API 返回 `apiKey: undefined, hasApiKey: boolean`
- **Fallback**：运行时先从 DB 读取，fallback 到 `process.env[apiKeyEnv]`

### 3.3 API 适配器（`lib/providers/openai-compatible.ts`）

- 调用 `/v1/images/edits` 端点
- 使用 Web 原生 `FormData` + `fetch`（不依赖第三方 HTTP 库）
- 支持 `b64_json` 和 `url` 两种返回格式
- `n` 固定为 1，多结果通过多任务实现

### 3.4 文件存储

- 全部本地 `storage/` 目录
- 图片通过 `/api/images/[...path]` 动态路由服务
- 路径做了防穿越检查（`path.resolve` + `startsWith`）

---

## 4. 🔒 API Key 安全措施

### 4.1 已实现的防护

| 措施 | 位置 | 说明 |
|---|---|---|
| 前端脱敏 | 所有 API 路由 | `apiKey: undefined, apiKeyEnv: undefined` |
| 仅返回状态 | 所有 API 路由 | `hasApiKey: boolean` 替代原始 Key |
| Key 不回显 | `app/settings/page.tsx` | `type="password"` + 占位提示 |
| 错误消息脱敏 | `lib/queue.ts:sanitizeErrorMessage()` | 替换 `sk-*`、`Bearer *`、`Authorization: *` |
| 日志脱敏 | `lib/logger.ts:sanitizeMessage()` | 写入前过滤 Key 模式 |
| 消息截断 | `lib/queue.ts` | 错误消息超过 2000 字符截断 |
| CSV 不导出 Key | `app/api/projects/[id]/export/route.ts` | 只导出 providerName |
| 图片路径防穿越 | `app/api/images/[...path]/route.ts` | resolve + startsWith 校验 |

### 4.2 需要 Codex 重点审查

1. **`lib/providers/openai-compatible.ts:74`** — API 调用失败时，响应体原样拼入 Error message。虽然后续有 `sanitizeErrorMessage()` 处理，但如果中转站 API 在错误体中返回了认证信息，需要评估脱敏正则是否覆盖。

2. **`lib/queue.ts`** — `provider.apiKeyEnv` 被包含在 `EditImageRequest.provider` 对象中。它只是环境变量名（如 `PACKY_API_KEY`），不是实际密钥，无泄漏风险，但属于多余数据传递，建议移除。

3. **内存中的 Key** — Key 从 DB 读取后在 `runJob` 函数的局部变量 `apiKey` 中，函数返回后由 GC 回收。没有持久化到闭包或全局变量。

---

## 5. 📋 错误日志体系

### 5.1 日志写入路径

```
runJob() → writeLog() → SQLite job_logs 表
                       → storage/logs/workbench-YYYY-MM-DD.log
```

### 5.2 日志内容

每条任务记录以下事件：
- 任务开始（attempt N/M）
- API 调用（URL + model + size）
- API 成功（latency + cost）
- API 失败（错误消息，已脱敏）
- 重试决策
- 队列控制（start/pause/resume/cancel）

### 5.3 前端查看

- 项目详情页底部 "运行日志" 面板
- 终端深色风格展示
- 支持按 INFO/WARN/ERROR 过滤
- 运行中自动刷新（3 秒间隔）
- 自动滚动到底部（可关闭）

### 5.4 日志文件示例

```
storage/logs/workbench-2026-06-07.log

[2026-06-07T08:00:01.000Z] [INFO] [job:a1b2c3d4] [attempt:1] Job started (attempt 1/2)
[2026-06-07T08:00:01.100Z] [INFO] [job:a1b2c3d4] [attempt:1] Calling API: https://api.packyapi.com/v1/images/edits (model: gpt-image-2, size: 1024x1024)
[2026-06-07T08:00:05.300Z] [INFO] [job:a1b2c3d4] [attempt:1] API call succeeded (latency: 4200ms)
[2026-06-07T08:00:05.500Z] [INFO] [job:a1b2c3d4] [attempt:1] Job completed successfully (cost: $0.5000)
```

---

## 6. 完整文件清单（按创建顺序）

| # | 文件 | 操作 | 说明 |
|---|---|---|---|
| 1 | `.env.local` | 新建 | 环境变量模板 |
| 2 | `lib/db.ts` | 新建 | 数据库初始化 + 5 张表 |
| 3 | `lib/cost.ts` | 新建 | 成本计算 + CSV 生成 |
| 4 | `lib/queue.ts` | 新建 | 并发队列引擎 |
| 5 | `lib/providers/openai-compatible.ts` | 新建 | API 适配器 |
| 6 | `lib/seed.ts` | 新建 | 供应商种子数据 |
| 7 | `app/api/providers/route.ts` | 新建 | 供应商列表 API |
| 8 | `app/api/upload/route.ts` | 新建 | 文件上传 API |
| 9 | `app/api/projects/route.ts` | 新建 | 项目 CRUD API |
| 10 | `app/api/projects/[id]/route.ts` | 新建 | 项目详情 API |
| 11 | `app/api/projects/[id]/run/route.ts` | 新建 | 队列控制 API |
| 12 | `app/api/projects/[id]/export/route.ts` | 新建 | CSV 导出 API |
| 13 | `app/api/jobs/[id]/retry/route.ts` | 新建 | 任务重试 API |
| 14 | `app/api/images/[...path]/route.ts` | 新建 | 图片服务 API |
| 15 | `app/api/jobs/[id]/route.ts` | 新建 | 任务标记 API |
| 16 | `app/globals.css` | 覆写 | 全局样式 + 组件 class |
| 17 | `app/layout.tsx` | 覆写 | 全局布局 + 导航 |
| 18 | `app/page.tsx` | 覆写 | 首页（项目列表） |
| 19 | `components/ProviderSettings.tsx` | 新建 | 供应商选择组件 |
| 20 | `components/ImageUploader.tsx` | 新建 | 图片上传组件 |
| 21 | `components/PromptEditor.tsx` | 新建 | 提示词编辑器 |
| 22 | `components/JobQueueTable.tsx` | 新建 | 任务队列表格 |
| 23 | `components/ResultGallery.tsx` | 新建 | 结果预览画廊 |
| 24 | `app/projects/new/page.tsx` | 新建 | 新建项目页 |
| 25 | `app/projects/[id]/page.tsx` | 新建 | 项目详情页 |
| 26 | `app/api/upload/register/route.ts` | 新建 | 图片资产注册 API |
| 27 | `app/api/providers/[id]/route.ts` | 新建 | 供应商编辑 API |
| 28 | `app/settings/page.tsx` | 新建 | 供应商配置管理页 |
| 29 | `lib/logger.ts` | 新建 | 持久化日志系统 |
| 30 | `app/api/projects/[id]/logs/route.ts` | 新建 | 日志查询 API |
| 31 | `components/LogViewer.tsx` | 新建 | 日志查看器组件 |

---

## 7. 给 Codex 的审查建议

### 7.1 高优先级

1. **并发队列正确性**（`lib/queue.ts`）
   - `runQueue` 的 while 循环是否会死循环？
   - Promise.allSettled 下的任务去重（同一 job 是否会并发执行两次）？
   - abort 信号传播是否正确？

2. **API Key 泄漏路径**
   - 搜索所有 `console.log` / `console.error` 是否有输出 Key
   - 检查 Next.js 开发模式下的错误页面是否可能暴露 Key
   - 审查 `sanitizeErrorMessage` 的正则是否遗漏常见 Key 格式

3. **SQLite 并发安全**
   - better-sqlite3 是同步的，多个 API 路由并发访问 DB 是否安全？
   - WAL 模式下读写是否有潜在冲突？

### 7.2 中优先级

4. **错误恢复**
   - 服务重启后，`runningQueues` Map 丢失，正在运行的任务如何恢复？
   - 异常退出后 `status='running'` 的 job 如何检测并清理？

5. **文件上传**
   - 文件大小无限制
   - 文件类型仅前端过滤（`accept="image/*"`），后端未校验 magic bytes

6. **性能**
   - 50 张图片同时轮询（2 秒间隔）下的前端渲染性能
   - 数据库查询未分页，jobs 表可能很大

### 7.3 低优先级 / 后续改进

7. API 适配器未重试瞬时网络错误（timeout 除外）
8. 没有单元测试和集成测试
9. 供应商 API Key 明文存储在 SQLite 中（本地工具可接受）
10. 未实现余额差额成本记录（文档第 11.2 节）

---

## 8. 构建与运行

```bash
cd batch-image-workbench

# 配置 API Key（二选一）
# 方式 A：编辑 .env.local 填入 Key
# 方式 B：启动后在 /settings 页面填写

# 启动开发服务器
npm run dev
# → http://localhost:3000

# 生产构建
npm run build && npm start
```

---

*文档生成时间：2026-06-07*
*构建工具：Claude Code (Next.js 16.2.7 + Turbopack)*
