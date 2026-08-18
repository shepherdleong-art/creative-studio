# 消耗看板（费控）设计

日期：2026-08-18

## 目标

- 新增独立页面 `/usage`，与「项目」「供应商」并列为顶部导航 tab，集中展示预估消耗。
- 页面包含：今日/本周/本月汇总卡片、按类别构成、近 30 天逐日柱图、可筛选分页的完整流水表。
- 全链路记账：图片生成、视频生成、LLM 文本调用、LLM 视觉调用、TTS 配音五类计费事件全部落流水。
- LLM 按真实 token 记账（读取适配器响应中的 `usage`），不按次估算。
- 所有数字为「单价 × 用量」的预估值，页面明确标注非上游真实账单。

## 当前事实

### 已有记账

- 图片：`providers.defaultCostPerImage`（设置页可改），任务成功时 `lib/queue.ts` 写入 `jobs.estimatedCost = 单价 × (attempt+1)`；失败不写，retry 置 NULL。
- 成片剪辑：`final_edit_jobs.estimatedCost` = TTS（`final_edit_tts_providers.costPerThousandCharacters` × 字符数）+ 视觉分析（`script_providers.visionCostPerRequest` × 素材数）的**预估值**；渲染任务写 0。
- 首页项目列表已聚合 `SUM(jobs.estimatedCost)` 展示项目总成本（只含图片）。

### 缺口

- 视频生成：`video_providers.defaultCostPerVideo` 列存在但无任何代码读写（死列）；`lib/video-queue.ts` 无成本逻辑。视频是成本大头。
- LLM 调用：脚本生成（`lib/script-generation-v3.ts`）、卖点分析（`lib/script-providers/index.ts` 的 `analyzeSellingPoints`）、语义矩阵打分（`lib/batch-production/semantic-match.ts`、`lib/final-edit/runtime.ts`）、视频内容分析（`lib/media-core/adapters/video-analysis.ts`，视觉）全部经 `completeJson` / `analyzeSellingPoints` 统一入口，但四个适配器（`openai-compatible.ts`、`openai-responses.ts`、`anthropic-messages.ts`、`gemini.ts`）的 `chatCompletion` 只返回文本，丢弃了响应中的 `usage` token 数；也没有任何成本落库。
- 批量生产（`lib/batch-production/`）：无任何成本列。其计费构成 = 口播 TTS + 语义打分 LLM + 内容分析视觉 LLM，代理生成与渲染为本地任务不花钱。
- `script_providers.visionCostPerRequest` 只用于成片剪辑的成本预估，未实际记账。
- 无统计/聚合 API 路由；无 dashboard 组件。

### 时间字段现状（聚合的坑）

- 存储全部为 UTC，但格式混合：`jobs.submittedAt/startedAt` 与 `video_jobs.createdAt` 用 SQLite `datetime('now')`（`YYYY-MM-DD HH:MM:SS`），`jobs.finishedAt`、`final_edit_*`、`batch_*` 用 JS `toISOString()`（带 `T`/`Z`）。
- 结论：新流水表统一用 `toISOString()`；回填历史数据时归一化两种格式。

## 定价配置（已与用户对齐）

| 项目 | 模式 | 默认单价 | 存放 |
|---|---|---|---|
| 公司 image2-medium | 按张 | ¥1.05 | `providers.defaultCostPerImage`（现状已一致，不动） |
| 公司 kling-3.0 | 按请求 | ¥0.798/次 | `video_providers`：`costMode='per_request'` + 复用死列 `defaultCostPerVideo=0.798` |
| 公司 seedance-2.0-fast | 按秒估算 | ¥0.8/秒（待用户拿真实账单校准） | `video_providers`：`costMode='per_second'` + 新列 `costPerSecond=0.8` |
| 直连可灵/即梦 | 按秒 | 0（用户自用自填） | 同上 |
| 公司 GPT-5-6-Luna-Standard | 按 token | 入 ¥2.8878 / 出 ¥12.9952 / 缓存读 ¥0.28878（每 1M tokens） | `script_providers` 新增三列 |
| 其他 LLM 供应商 | 按 token | 0（自填） | 同上 |
| 豆包语音合成 2.0（seed-tts-2.0） | 按字符 | ¥0.28/千字符（资源包口径 2.8 元/万字符，以实际购买为准） | `final_edit_tts_providers.costPerThousandCharacters`（已有列，补默认值） |
| V-API Qwen3 TTS | 按字符 | 0（第三方网关价自填） | 同上 |

定价事实来源：公司网关模型页截图（2026-08-18，image2-medium ¥1.05/次、kling-3.0 ¥0.798/次、GPT-5-6 token 价、seedance-2.0-fast ¥36.96/1M tokens）；火山引擎 TTS 计费文档（豆包语音合成 2.0 资源包 28 元/10 万字符）；seedance 按秒折算自公开数据（标准版 ¥46/1M ≈ 720p ¥1/秒，fast 约 0.8 倍），视频轮询响应拿不到 token 数，只能按秒估算。

所有单价都在设置页可编辑（沿用现有单价编辑同款交互，新增视频与 LLM 单价字段）。seed 对已有库的补默认值一律用「仅当目标列为空/0 才 UPDATE」的条件写入，不覆盖用户手改。

## 设计

### 流水表 `usage_ledger`

核心表新建（`lib/db.ts` 的 CREATE TABLE IF NOT EXISTS 区域），其余新列走 `lib/db-migrations.ts` 追加式 `ALTER TABLE`：

```sql
CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,        -- image | video | llm_text | llm_vision | tts | final_edit_legacy
  providerId TEXT NOT NULL DEFAULT '',
  providerName TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL DEFAULT 0,   -- 张 / 秒 / 次 / token / 千字符
  unit TEXT NOT NULL DEFAULT '',      -- image | second | request | token | kchar
  unitPrice REAL NOT NULL DEFAULT 0,  -- 展示用；LLM 行存混合价（cost/quantity×1M）
  cost REAL NOT NULL DEFAULT 0,       -- 金额（元），聚合只信这一列
  detailJson TEXT NOT NULL DEFAULT '',-- LLM token 明细、回填标记等
  projectId TEXT,                  -- 可空：拿不到项目归属的调用留空
  refType TEXT NOT NULL DEFAULT '',   -- job | video_job | llm_call | tts_call | backfill
  refId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL             -- 统一 new Date().toISOString()，UTC
);
CREATE INDEX idx_usage_ledger_createdAt ON usage_ledger(createdAt);
CREATE INDEX idx_usage_ledger_category ON usage_ledger(category);
```

写入帮助函数 `lib/usage-ledger.ts`：`recordUsage({...})` 单点封装（生成 id、写库、失败只记日志不阻塞业务——记账绝不能拖垮主流程）。

### 五个写入点

1. **图片**：`lib/queue.ts` 任务成功写 `jobs.estimatedCost` 的同一位置，追加写 ledger（category=image，quantity=attempt+1，unit=image，unitPrice=defaultCostPerImage，cost 与 estimatedCost 同值，projectId/refId=jobId）。口径不变：成功才计，含失败尝试累乘。
2. **视频**：`lib/video-queue.ts` 任务成功处写 ledger。`costMode='per_request'` → quantity=1、unit=request、unitPrice=defaultCostPerVideo；`per_second` → quantity=durationSec、unit=second、unitPrice=costPerSecond。成功才计，单价 0 也记行（流水完整、金额 0）。
3. **LLM（文本+视觉）**：四个适配器的 `chatCompletion` 返回值由 `string` 改为 `{ text, usage: { promptTokens, completionTokens, cachedTokens? } }`，各自从协议响应提取：
   - openai-compatible：`usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`
   - openai-responses：`usage.input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`
   - anthropic-messages：`usage.input_tokens` / `output_tokens` / `cache_read_input_tokens`
   - gemini：`usageMetadata.promptTokenCount` / `candidatesTokenCount` / `cachedContentTokenCount`

   在 `completeJson` 与 `analyzeSellingPoints`（`lib/script-providers/index.ts`）统一写 ledger：category 按是否带图分 `llm_vision`/`llm_text`；cost = 输入价×promptTokens/1M + 输出价×completionTokens/1M + 缓存读价×cachedTokens/1M（缓存列未配置时按输入价）；quantity=总 token，unit=token，unitPrice=混合价，明细进 detailJson。**上游未返回 usage 时**按字符数估算（prompt/completion 字符 ÷ 4）并标 `detailJson.estimated=true`，保证流水不缺。调用失败不记（上游失败不产出 usage、一般不扣费，与「发出即计」的实际扣费结果一致）。
   - 归因：`completeJson`/`analyzeSellingPoints` 入参增加可选 `usageContext?: { projectId?, refType?, refId? }`，拿得到的调用点都传（脚本生成传 projectId、语义打分传批次/矩阵 id、视频分析传素材 id）；拿不到的留空。
   - 视觉调用按 token 记账后，`visionCostPerRequest` 保留但只用于成片剪辑的成本**预估**，不再作为实际记账依据。
4. **TTS**：在 TTS 实际执行处写 ledger（成片剪辑的配音执行、批量生产的 narration 任务执行，实现时定位两处共用适配器调用点）：quantity=字符数/1000、unit=kchar、unitPrice=costPerThousandCharacters。`final_edit_jobs.estimatedCost` 预估逻辑保持不变（预估与实际各记各的）。
5. **批量生产**：不加独立写入点——口播走 TTS 写入点、语义打分/内容分析走 LLM 写入点、代理与渲染本地免费不记。

### 历史回填

启动时一次性幂等回填（标记 `refType='backfill'`，已回填则跳过）：

- `jobs` 中 `estimatedCost` 非空的行 → category=image，时间取 `COALESCE(finishedAt, startedAt, submittedAt)` 并归一化为 ISO UTC（`replace(substr(col,1,19),'T',' ')` 后按 UTC 处理）。
- `final_edit_jobs` 中 `estimatedCost > 0` 的行 → category=`final_edit_legacy`（历史预估混合口径，不在新写入中使用；页面类别显示为「剪辑（历史预估）」）。
- 视频/LLM/TTS 无历史数据，从上线起记。

### 聚合 API

- `GET /api/usage`：汇总卡片数据。今日/本周/本月的总额 + 按类别小计 + 近 30 天逐日序列。
  - 日=本地自然日，周=周一至周日，月=自然月；本地偏移固定 +8。
  - 实现：在 JS 侧算好本地日/周/月的边界再转 UTC 做 `WHERE createdAt BETWEEN`，逐日序列用 `date(datetime(createdAt, '+8 hours'))` 分组。
- `GET /api/usage/records?from&to&category&page&pageSize`：流水分页查询，按时间倒序。
- 写法参照 `app/api/projects/route.ts` 的聚合子查询模式。

### 页面与导航

- `app/usage/page.tsx`（client component）：自上而下——
  1. 三张汇总卡：今日 / 本周（周一至周日）/ 本月预估消耗（金额 + 环比小字）。
  2. 类别构成条：五类占比（含 final_edit_legacy 时六段）。
  3. 近 30 天逐日柱图（纯 CSS 柱，跟首页 Stats 同款 tile 风格）。
  4. 流水表：日期范围 + 类别筛选 + 分页；列：时间、类别、供应商、模型、用量、单价、金额、项目。LLM 行单价列显示「¥x/1M tok（混合）」，hover/展开可见 token 明细。
  5. 页面顶部固定标注：「预估消耗 = 单价 × 用量，非上游真实账单」。
- `components/Header.tsx` 导航在「项目」与「供应商」之间加「消耗」。
- 设置页：视频供应商卡片增加计费模式（按次/按秒）与单价编辑；脚本供应商卡片增加输入/输出/缓存读 token 单价编辑；TTS 单价编辑已有，仅补默认值。

## 数据流

1. 各计费事件发生（图片/视频任务成功、LLM 调用返回、TTS 合成完成）→ 写入点向 `usage_ledger` 插一行，失败只记日志。
2. 用户打开「消耗」tab → `/usage` 页调 `/api/usage` 与 `/api/usage/records`。
3. API 按 +8 本地边界聚合与筛选，返回卡片数据与流水分页。

## 错误与兼容性

- 记账写库失败只记日志、绝不阻塞或失败化业务任务。
- 单价为 0 的供应商照常记流水（金额 0），不产生脏数据问题。
- 既有 `jobs.estimatedCost`、`final_edit_jobs.estimatedCost` 及其 UI（项目总成本、任务表）完全不动；看板是新口径的独立视图。
- 适配器 `chatCompletion` 返回类型变更涉及所有调用方同步调整（`parseJsonResponse` 等下游只接 text 部分）；不改变任何提示词与协议行为。
- 缓存 token 价未配置时按输入价计；usage 缺失时估算并标记，不虚报精确。
- 桌面打包断言不受影响（无新依赖、无新本机数据目录）。

## 测试与验收

- `scripts/usage-ledger.test.ts`：写入、聚合（日/周/月 +8 边界、周一起算）、类别小计、30 天序列、幂等回填（jobs/final_edit_jobs、混合时间格式归一化）。
- 适配器 usage 提取测试：四个适配器各自响应形状 → 正确 token 数；缺 usage → 估算路径标记 estimated。
- 视频成本测试：per_request（kling-3.0 ¥0.798 与时长无关）与 per_second（seedance 0.8×durationSec）两种模式。
- API 测试：`/api/usage` 汇总与 `/api/usage/records` 筛选分页。
- UI 合同测试：`/usage` 页面版块与 Header 新 tab。
- 迁移测试：新列/新表存在、seed 条件更新不覆盖用户值。
- 运行相关独立测试与 ESLint。

## 非目标

- 不对接上游真实账单对账；不做预算告警或限额熔断。
- v1 不做按项目维度的深度分析（流水表保留 projectId 列，归因齐全的调用自然可见）。
- 不做 CSV 导出按钮（`lib/cost.ts` 的 `generateCSV` 留待后续接）。
- 不改造既有 `estimatedCost` 预估口径与展示。
