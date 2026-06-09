# 2026-06-08 全部改动汇总 — 供 Codex 审查

> 项目路径：`/Users/liangpeijian/for-cc/batch-image-workbench`  
> 改动日期：2026-06-08  
> 构建状态：`npm run build` 通过，TypeScript 无错误，所有路由正常

---

## 改动总览

今日共实施 4 份规范文档：

| # | 文档 | 核心目标 |
|---|---|---|
| 1 | `ratio-bug-diagnosis.md` | 修复比例始终变成 1:1 的 bug |
| 2 | `regenerate-with-prompt-spec.md` | 单图重新生成 + 修改提示词 |
| 3 | `packy-gpt-image-2-optimization-spec.md` | Packy API 作为独立供应商类型 |
| 4 | `provider-activation-control-spec.md` | 供应商启用/禁用 + 唯一启用控制 |

---

## 一、比例 Bug 修复

### 根因
- 本地 `SIZE_PRESETS` 映射表是错的，与 ComfyUI 节点的 `SIZE_MAP` 不一致
- `size` 计算失败时静默回退到 `1024x1024`
- 清晰度 select 显示值与 React state 不同步
- 服务端也静默回退 `size || '1024x1024'`

### 新建
| 文件 | 说明 |
|---|---|
| `lib/gpt-image-2-size-presets.ts` | 从 ComfyUI 节点同步的真实 SIZE_MAP（13 比例 × 3 分辨率）+ `resolveGptImage2Size()` + `isValidGptImage2Size()` |

### 修改
| 文件 | 操作 | 关键改动 |
|---|---|---|
| `app/projects/new/page.tsx` | 删旧映射，导入共享 presets | `resolution` 改为小写 `1k`/`2k`/`4k`；比例切换时自动矫正分辨率；删 `postprocessTarget`；13 种比例全展示；`auto` 比例隐藏清晰度选择；`resolveGptImage2Size` 替代静默回退 |
| `app/api/projects/route.ts` | 服务端重算 size | 用 `aspectRatio+resolution` 解析 `resolvedSize`；非法 size 返回 400；不再写 `postprocessTarget` |
| `lib/queue.ts` | 删后处理 | 移除 `containPadImage` import 和后处理逻辑；移除 `postprocessTarget` 字段 |
| `lib/gpt-image-2-size-presets.ts` | 补充 auto + 500→400 | `'auto'` 加入比例列表；`resolveGptImage2Size('auto')` 返回 `'auto'`；服务端 try/catch → 400 |
| `lib/queue.ts` 命名修复 | | `sanitizeFilenameBase(inputImage.filename \|\| inputImage.path)` |

### Codex 复查后补充修复
| 问题 | 修复 |
|---|---|
| `auto` 比例未实现 | 加入比例列表 + `resolveGptImage2Size('auto')` 返回 `'auto'` |
| 非法比例返 500 | 改为 try/catch → 400 |
| 输出文件名用 `path` 而非 `filename` | 改为 `inputImage.filename \|\| inputImage.path` |
| 前端 size catch 返回空串 | `auto` 不选分辨率时隐藏清晰度下拉，合法选择不会触发 catch |

---

## 二、单图重新生成 + 修改提示词

### 新建
| 文件 | 说明 |
|---|---|
| `app/api/jobs/[id]/regenerate/route.ts` | POST — 基于原 job 创建新 pending job，替换 prompt；原 job 标记 `reviewMark='rework'`；计算 `revision`；限制只允许 succeeded/failed/canceled/needs_check |

### 修改
| 文件 | 关键改动 |
|---|---|
| `lib/db.ts` | jobs 表增加 `parentJobId TEXT`、`revision INTEGER DEFAULT 0` + 迁移 |
| `app/projects/[id]/page.tsx` | 新增 `handleRegenerate(jobId, prompt)`；调用 regenerate API → 启动队列（忽略 409）；Job interface 增加 `prompt`/`parentJobId`/`revision`/`reviewMark`；传 `onRegenerate` 给 ResultGallery |
| `components/ResultGallery.tsx` | Props 增加 `onRegenerate`；modal 操作区增加"🔄 重新生成"按钮；点击后展开紫色提示词编辑面板（textarea 预填原 prompt）；提交后不关闭 modal |
| `lib/queue.ts` | 输出文件名加版本后缀：`output-{name}-r{revision}.png`；JobRecord 增加 `revision?` |

---

## 三、Packy GPT-Image-2 适配

### 核心差异

| | GeekAI | Packy |
|---|---|---|
| 协议 | JSON + async task_id | multipart/form-data |
| 返回 | 轮询 GET /v1/images/{task_id} | 直接返回 data[0].url |
| 轮询 | ✅ | ❌ |
| needs_check | ✅ | ❌ |
| 超时策略 | 可重试 | 不自动重试（防重复扣费） |

### 新建
| 文件 | 说明 |
|---|---|
| `lib/providers/packy-images.ts` | multipart 适配器：`input_fidelity=high`、`response_format=url`、`output_format=png`、`n=1`；参考图附在 prompt 注释中；`remoteImageUrl` 存储在结果中 |
| `outputs/packy-test-checklist.md` | 10 元安全测试清单 |

### 修改
| 文件 | 关键改动 |
|---|---|
| `lib/seed.ts` | Packy 改为 `type: 'packy-images'`，`baseUrl: 'https://www.packyapi.com'`，默认 disabled |
| `lib/queue.ts` | import `editImagePacky`；新增 `packy-images` 路由分支；timeout 类错误检测 `isTimeoutLikeError()` → 不自动重试；`result` 类型增加 `remoteImageUrl?`；success SQL 写入 `remoteImageUrl` |
| `app/settings/page.tsx` | 类型下拉增加 `Packy Images API (multipart, no polling)` |
| `app/api/providers/route.ts` | 手动创建默认类型改为 `openai-compatible` |
| `components/ProviderSettings.tsx` | 卡片显示 `类型: {p.type}` |
| `.env.local` | `PACKY_BASE_URL` 改为 `https://www.packyapi.com` |

---

## 四、供应商激活控制

### 新建
| 文件 | 说明 |
|---|---|
| `app/api/providers/[id]/activate-only/route.ts` | POST — 原子事务：禁用所有其他供应商，仅启用目标 |
| `outputs/provider-activation-test-checklist.md` | no-paid 测试清单 |

### 修改
| 文件 | 关键改动 |
|---|---|
| `app/settings/page.tsx` | 每张供应商卡片增加 `启用/禁用` 切换按钮 + `设为唯一启用` 按钮；新增 `handleToggleEnabled()` / `handleActivateOnly()`；修复成本显示 bug（`¥{p.defaultCostPerImage}/张` → `¥${p.defaultCostPerImage}/张`）；页面顶部增加使用说明 |
| `components/ProviderSettings.tsx` | 自动选中逻辑改为 `data.filter(p => p.enabled && p.hasApiKey)`；新增两种空状态提示：无启用供应商（黄色）/ 有启用的但无 Key（橙色） |
| `app/api/projects/route.ts` | 创建项目前校验：供应商必须存在、已启用、且已配置 API Key；任一失败返回 400 |

---

## 五、当前项目路由表

```
┌ ○ /                                        静态首页
├ ƒ /api/images/[...path]                    图片服务（5 子目录白名单）
├ ƒ /api/jobs/[id]                           任务标记
├ ƒ /api/jobs/[id]/regenerate                单图重新生成（NEW）
├ ƒ /api/jobs/[id]/resume-poll               补抓结果（GeekAI only）
├ ƒ /api/jobs/[id]/retry                     任务重试
├ ƒ /api/projects                            项目列表/创建
├ ƒ /api/projects/[id]                       项目详情/删除
├ ƒ /api/projects/[id]/export                CSV 导出
├ ƒ /api/projects/[id]/logs                  运行日志
├ ƒ /api/projects/[id]/run                   队列控制
├ ƒ /api/providers                            供应商列表/创建
├ ƒ /api/providers/[id]                      供应商编辑
├ ƒ /api/providers/[id]/activate-only        设为唯一启用（NEW）
├ ƒ /api/shutdown                             关闭服务
├ ƒ /api/upload                               图片上传+预处理
├ ƒ /projects/[id]                            项目详情页
├ ○ /projects/new                             新建项目页（静态）
└ ○ /settings                                 供应商配置页（静态）
```

---

## 六、数据模型当前状态

### providers
`id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage`

### projects
`id, name, createdAt, providerId, model, prompt, negativePrompt, size, quality, concurrency, maxAttempts, status, runId`

### jobs
`id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, startedAt, finishedAt, latencyMs, estimatedCost, errorMessage, reviewMark, outputImageId, providerTaskId, providerStatus, providerRawResponse, submittedAt, lastPolledAt, pollCount, remoteImageUrl, parentJobId, revision`

### image_assets
`id, projectId, role, filename, path, originalPath, processedPath, mimeType, width, height, originalWidth, originalHeight, processedWidth, processedHeight, originalSizeBytes, processedSizeBytes, preprocessingEnabled, createdAt`

### job_logs
`id, jobId(NULL allowed), projectId, level, message, attempt, createdAt`

---

## 七、Codex 建议审查点

1. **Provider 路由完整性** — `geekai-json` / `packy-images` / `openai-compatible` 三路分发是否正确；`packy-images` 和 `openai-compatible` 是否有重复代码可合并
2. **Packy 超时保护** — `isTimeoutLikeError()` 的匹配范围是否合理；是否会误拦截合法的重试需求
3. **regenerate API** — `INSERT INTO jobs ... SELECT FROM jobs WHERE id = ?` 的 SQL 是否正确复制所有字段（尤其是 `size` 是否会因 resolvedSize 而错位）；`revision` 计算是否考虑了并发安全
4. **activate-only** — 事务是否正确处理了并发（两个请求同时 activate-only 不同供应商）
5. **output 命名** — `ensureUniqueFilename` + revision 后缀是否在并发写入时可靠
6. **provider 校验** — 后端 `api/api/projects/route.ts` 的校验在 `resolvedSize` 计算之后、`projectId` 生成之前，顺序正确
7. **auto 比例** — 选择了 `auto` 后，`resolvedSize='auto'`，GeekAI 能否正确处理这个值
8. **packy-images.ts** — 参考图处理方式（附在 prompt 注释中）是否符合 Packy 实际 API 行为；需实测验证
9. **settings/page.tsx** — `handleToggleEnabled` 的 `saving` 状态为全局，快速点击多个按钮时是否会相互阻塞
10. **ResultGallery** — `onRegenerate` 回调中先调用 regenerate API 再调用 run API，如果 regenerate 返回 500 仍会尝试启动队列
