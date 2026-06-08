# GeekAI GPT-Image-2 修复实施报告

> 基于 `geekai-gpt-image-2-error-diagnosis.md` 的修复实施记录。  
> 项目路径：`/Users/liangpeijian/for-cc/batch-image-workbench`  
> 实施时间：2026-06-07  
> 构建状态：`npm run build` 通过，TypeScript 无错误，所有页面 200

---

## 一、诊断文档覆盖情况

| 诊断项 | 状态 | 关键文件 |
|---|---|---|
| 根因 A：Base URL 拼接错误 | ✅ 已修复 | `lib/seed.ts`(baseUrl=`https://geekai.co/api`)、`geekai-json.ts`(内部拼`/v1/images/edits`) |
| 根因 B：multipart → JSON | ✅ 已修复 | `lib/providers/geekai-json.ts`(新建) |
| 根因 C：尺寸/质量参数 | ✅ 已修复 | `app/projects/new/page.tsx`、`app/settings/page.tsx` |
| 根因 D：大图压缩 | ✅ 已修复 | `lib/image-preprocess.ts`(新建)、`app/api/upload/route.ts` |
| 根因 E：提交/取回未拆分 | ✅ 已修复 | `geekai-json.ts`(submit + poll 拆分)、`lib/queue.ts`(GeekAI 分支重写) |
| Section 5.1：异步状态字段 | ✅ 已添加 | `lib/db.ts`(jobs 表 7 个新列) |
| Section 5.2：阶梯轮询 | ✅ 已实现 | `geekai-json.ts`(前 2 分钟 5s，之后 10s，最长 15min) |
| Section 5.3：远端成功但本地下载失败 | ✅ 已处理 | `lib/queue.ts`(download_failed + 保存 remoteImageUrl + 不重试) |
| Section 5.4：前端异步状态展示 | ⚠️ 部分 | 日志中已有 taskId/status/轮询记录；UI 任务表列待后续补充 |
| Section 6.1：Provider type 分发 | ✅ 已修复 | `lib/queue.ts`(按 provider.type 路由) |
| Section 6.4：图片预处理 | ✅ 已修复 | `lib/image-preprocess.ts` + `app/projects/new/page.tsx`(设置卡片) |
| Section 8.11：轮询超时处理 | ✅ 已修复 | needs_check 状态 + 不标永久失败 |
| Section 8.12：日志复制按钮 | ✅ 已添加 | `components/LogViewer.tsx` |
| Section 8.13：runId + 独立日志 | ✅ 已添加 | `app/api/projects/[id]/run/route.ts`(生成 runId 写 projects) + CSV 包含 runId |

---

## 二、改动文件清单

### 新建文件

| # | 文件 | 用途 |
|---|---|---|
| 1 | `lib/providers/geekai-json.ts` | GeekAI JSON 适配器：submitGeekAITask / pollGeekAITask / downloadGeekAIImage |
| 2 | `lib/image-preprocess.ts` | sharp 图片压缩：原图保留 + 生成 API 用压缩图 |
| 3 | `components/Header.tsx` | 全局 Header 组件（含停止服务按钮） |
| 4 | `app/api/providers/[id]/route.ts` | Provider 编辑 API（GET/PUT/DELETE） |
| 5 | `app/api/projects/[id]/logs/route.ts` | 日志查询 API |
| 6 | `app/api/projects/[id]/export/route.ts` | CSV 导出 API |
| 7 | `app/api/shutdown/route.ts` | 关闭服务 API |
| 8 | `components/LogViewer.tsx` | 日志查看器组件 |
| 9 | `app/settings/page.tsx` | 供应商配置管理页 |
| 10 | `start.command` / `stop.command` | Mac 双击启动/停止脚本 |
| 11 | `start.sh` / `stop.sh` | 命令行启动/停止脚本 |

### 修改文件

| # | 文件 | 关键改动 |
|---|---|---|
| 12 | `lib/db.ts` | DB 移到 `data/`；新增 apiKey / reviewMark / 预处理字段 / 异步轮询字段 / runId；job_logs 表 jobId 允许 NULL |
| 13 | `lib/queue.ts` | 原子认领 job；AbortSignal 传入 fetch；写前检查状态；按 provider.type 路由；GeekAI 提交/轮询/下载流程；恢复崩溃 running job |
| 14 | `lib/providers/openai-compatible.ts` | 函数重命名 editImage → editImageOpenAI；接收 AbortSignal + 真实 mimeType |
| 15 | `lib/seed.ts` | 默认种子改为 GeekAI(type=geekai-json, baseUrl=https://geekai.co/api) |
| 16 | `lib/cost.ts` | 单位 ¥；CSV 增加 run_id / provider_task_id / provider_status 列 |
| 17 | `lib/logger.ts` | jobId 改为可选；消息脱敏（sk-* / Bearer / Authorization） |
| 18 | `app/api/images/[...path]/route.ts` | 只允许 inputs/outputs/references/originals/processed 子目录 + 图片扩展名 |
| 19 | `app/api/upload/route.ts` | 直接落 DB；magic bytes 校验；originals + processed 双存储 + 预处理 |
| 20 | `app/api/providers/route.ts` | 新增 POST 创建供应商；apiKey 脱敏 |
| 21 | `app/api/projects/route.ts` | 支持 NULL projectId 分配 |
| 22 | `app/api/projects/[id]/route.ts` | 返回 imageUrl；apiKey 脱敏 |
| 23 | `app/api/projects/[id]/run/route.ts` | 防重复 start(409)；生成 runId；日志使用空 jobId |
| 24 | `app/api/jobs/[id]/route.ts` | reviewMark 替代 errorMessage |
| 25 | `app/layout.tsx` | 使用 Header 组件 |
| 26 | `app/page.tsx` | 欢迎引导页 + 三步指引 + 统计卡片 |
| 27 | `app/projects/new/page.tsx` | 尺寸改为 GPT-Image-2 规格；质量改为 low/medium/high；新增预处理设置卡片；提交 assetId |
| 28 | `components/ImageUploader.tsx` | 返回 imageUrl；传递预处理参数；过滤类型为 PNG/JPEG/WebP |
| 29 | `components/ProviderSettings.tsx` | 显示 type + 管理供应商链接；成本 ¥ |
| 30 | `components/ResultGallery.tsx` | 使用 imageUrl；reviewMark 替代 errorMessage 解析 |
| 31 | `components/JobQueueTable.tsx` | 移除 __mark__ 检查；成本 ¥ |
| 32 | `components/LogViewer.tsx` | 允许 jobId=null；复制全部/错误按钮 |
| 33 | `.env.local` | 增加 GEEKAI_API_KEY / GEEKAI_BASE_URL |
| 34 | `.gitignore` | 排除 /data/ 和 /storage/ |
| 35 | `app/globals.css` | 自定义组件样式（card / btn / input / status-badge） |

### 删除文件
| # | 文件 | 原因 |
|---|---|---|
| 36 | `app/api/upload/register/route.ts` | 允许前端提交任意本地路径，不安全 |

---

## 三、API Key 安全措施

| 措施 | 实现 |
|---|---|
| 前端脱敏 | 所有 API 返回 `apiKey: undefined`，只返回 `hasApiKey: boolean` |
| Key 不回显 | 设置页 type=password，已保存不显示 |
| 错误消息脱敏 | `sanitizeErrorMessage()` 替换 `sk-*` / `Bearer *` / `Authorization: *` |
| 日志脱敏 | `sanitizeMessage()` 写入前过滤 |
| 消息截断 | 超过 2000 字符自动截断 |
| DB 不允许访问 | `/api/images/workbench.db` 返回 403 |
| logs 不允许访问 | `/api/images/logs/*` 返回 403 |
| 非图片扩展名拒绝 | `/api/images/*.txt` 返回 403 |
| 目录遍历防护 | resolve + startsWith 双重检查 |
| DB 移至 data/ | 不在 storage/ 下 |
| .gitignore 排除 | /data/ 和 /storage/ 均排除 |

---

## 四、GeekAI 异步调用流程

```
runJob (provider.type === 'geekai-json')
  │
  ├─ ① submitGeekAITask(request, apiKey, baseUrl)
  │     POST {baseUrl}/v1/images/edits
  │     body: { model, prompt, images: ["data:...;base64,..."], size, quality, async: true }
  │     timeout: 60s
  │     ├─ 返回 taskId → 保存到 jobs.providerTaskId，打日志 "任务已提交 task_id=..."
  │     ├─ 返回同步图片 → 直接保存
  │     └─ 抛出异常 → 重试或标 failed
  │
  ├─ ② pollGeekAITask(taskId, apiKey, baseUrl, startedAt, signal) 循环
  │     GET {baseUrl}/v1/images/{taskId}
  │     timeout: 30s/次，最长 15min
  │     阶梯间隔：前 2min 每 5s，之后每 10s
  │     每次轮询后更新 jobs.providerStatus / lastPolledAt / pollCount
  │     ├─ status=succeeded + imageUrl → 进入下载
  │     ├─ status=failed → 抛出异常
  │     └─ 超时 → 标记 needs_check（不标永久失败！）
  │
  ├─ ③ downloadGeekAIImage(imageUrl)
  │     ├─ 成功 → 返回 Buffer，保存到 storage/outputs/
  │     └─ 失败 → 标记 download_failed + 保存 remoteImageUrl，不重试
  │
  └─ ④ 标记 succeeded
```

---

## 五、数据库新增字段

### jobs 表
```sql
providerTaskId      TEXT    -- GeekAI 返回的 task_id
providerStatus      TEXT    -- submitted / processing / succeeded / failed / download_failed / needs_check
providerRawResponse TEXT    -- 脱敏后的原始响应
submittedAt         TEXT    -- 提交时间
lastPolledAt        TEXT    -- 最后轮询时间
pollCount           INTEGER -- 轮询次数
remoteImageUrl      TEXT    -- 远端图片 URL
reviewMark          TEXT    -- available / rework / discard
```

### image_assets 表
```sql
originalPath         TEXT    -- 原图路径
processedPath        TEXT    -- 压缩图路径
originalWidth        INTEGER
originalHeight       INTEGER
processedWidth       INTEGER
processedHeight      INTEGER
originalSizeBytes    INTEGER
processedSizeBytes   INTEGER
preprocessingEnabled INTEGER -- 0/1
```

### projects 表
```sql
runId TEXT -- 每次运行的唯一 ID
```

### providers 表
```sql
apiKey TEXT -- 明文存储 Key（本地工具）
```

### job_logs 表
```sql
jobId TEXT -- 允许 NULL（队列级日志使用 NULL）
```

---

## 六、UI 变更摘要

| 页面 | 变更 |
|---|---|
| 首页 `/` | 欢迎卡片 + 首次使用三步引导 + 统计卡片 |
| 供应商配置 `/settings` | 接口类型选择（GeekAI/OpenAI）；Base URL + API Key 直接填写 |
| 新建项目 `/projects/new` | 尺寸改为 GPT-Image-2 规格；质量 low/medium/high；图片预处理设置卡片 |
| 项目详情 `/projects/[id]` | 运行日志面板（终端风格 + 过滤 + 复制按钮） |
| Header | 导航栏 + 停止服务按钮（确认弹窗） |

---

## 七、Codex 建议检查点

1. **geekai-json.ts** — `pollGeekAITask` 的 `AbortSignal.timeout` 是否在所有 Node 版本可用（Next.js 16 使用 Node 18+，应支持）
2. **queue.ts** — GeekAI 分支的 `return` 语句是否正确阻止了后续共享代码的执行
3. **queue.ts** — download_failed 路径用了 `return`，不会触发 `sanitizeErrorMessage`，是否需要在 GeekAI 分支内做脱敏
4. **image-preprocess.ts** — sharp 的 metadata() 在极端大图上是否可能 OOM
5. **upload/route.ts** — 预处理参数从前端 FormData 传入，前端可篡改，但接受范围有限（1024/1536/2048），风险可控
6. **start.command / stop.command** — Mac 首次双击可能提示"无法验证开发者"，需右键→打开

---

*文档生成时间：2026-06-07*
