# 核心模型消耗看板设计

日期：2026-08-18

## 目标

- 新增独立页面 `/usage`，与「项目」「供应商」并列为顶部导航 tab。
- 只展示当前实际使用的公司 API 模型与豆包 TTS，不让外接、测试供应商污染统计。
- 以「供应商 + 模型」为主维度，展示今日、本周、本月预估消耗、模型排行、用量、调用次数、占比、近 30 天趋势和调用流水。
- 公司 LLM 优先按响应中的真实 token usage 计量；图片、视频和 TTS 按各自可获得的真实用量或既有预估口径计量。
- 所有金额均为「配置单价 × 记录用量」的预估值，页面固定标注“非上游真实账单”。

## 当前事实

### 已有成本数据

- 图片任务成功时，`lib/queue.ts` 会把 `providers.defaultCostPerImage × 尝试次数` 写入 `jobs.estimatedCost`。
- 首页项目列表会聚合 `jobs.estimatedCost`，但只覆盖图片任务。
- `video_providers.defaultCostPerVideo` 已存在，但视频队列尚未使用。
- `final_edit_tts_providers.costPerThousandCharacters` 已存在，用于成片准备阶段的成本预估。

### 尚未覆盖

- 公司可灵和公司 Seedance 视频任务没有成本流水。
- 公司 `GPT-5-6-Luna-Standard` 的 OpenAI-compatible 响应中可能带 `usage`，当前适配器只返回文本，未保留 token 数据。
- 豆包 TTS 的真实合成、批量口播和设置页试听均未写统一流水。
- 当前没有按模型聚合的 API 和看板页面。

### 时间格式

- 现有任务时间同时存在 SQLite `datetime('now')` 和 JS `toISOString()` 两种格式。
- 新流水统一使用 `new Date().toISOString()`。历史图片回填时把旧格式按 UTC 归一化。

## 统计范围

v1 允许统计的范围固定为下列五个内置供应商：

| 供应商表 | 内置供应商 ID | 模型 | 类型 |
|---|---|---|---|
| `providers` | `company-gateway-image2-medium` | `image2-medium` | 公司图片 |
| `video_providers` | `company-kling-3-0` | `kling-3.0` | 公司视频 |
| `video_providers` | `company-seedance-2-0-fast` | `doubao-seedance-2-0-fast-260128` | 公司视频 |
| `script_providers` | `gpt` | `GPT-5-6-Luna-Standard` | 公司 LLM |
| `final_edit_tts_providers` | `doubao-seed-tts-2` | `seed-tts-2.0` | 豆包 TTS |

Packy、Gemini、Anthropic、V-API、直连可灵、直连即梦以及其他测试或外接供应商不统计，也不在看板中出现。

### 显式统计开关

- `providers`、`video_providers`、`script_providers` 和 `final_edit_tts_providers` 增加 `usageTrackingEnabled INTEGER NOT NULL DEFAULT 0`。
- 记账只认数据库中的开关，不通过供应商名称或模型名称正则判断。
- 新库 seed 仅给上表五个内置供应商写入 `usageTrackingEnabled=1`，其他供应商保持 0。
- 老库通过一次性初始化标记为这五个精确 ID 开启统计。初始化完成后不再重写，用户后续关闭开关不会被下次启动重新开启。
- 设置页只在上述五个供应商卡片提供“计入消耗看板”开关。其他供应商不提供开启入口，v1 不能把它们加入统计。

`final_edit_tts_providers` 的新列走 `lib/final-edit/schema.ts` 独立迁移；其余三张表的列追加到 `CORE_DB_MIGRATIONS`。一次性默认初始化由消耗模块自己的迁移标记控制。

## 定价配置

| 模型 | 计价方式 | 默认单价 | 配置位置 |
|---|---|---|---|
| `image2-medium` | 按张 | ¥1.05/张 | `providers.defaultCostPerImage` |
| `kling-3.0` | 按成功请求 | ¥0.798/次 | `video_providers.defaultCostPerVideo` |
| `doubao-seedance-2-0-fast-260128` | 按成片时长 | ¥0.8/秒，待账单校准 | 新增 `video_providers.costPerSecond` |
| `GPT-5-6-Luna-Standard` | 按 token | 输入 ¥2.8878、输出 ¥12.9952、缓存读 ¥0.28878/1M tokens | `script_providers` 新增三列 |
| `seed-tts-2.0` | 按字符 | ¥0.28/千字符 | `final_edit_tts_providers.costPerThousandCharacters` |

视频供应商增加 `costMode='per_request' | 'per_second'`。脚本供应商增加 `inputCostPerMillionTokens`、`outputCostPerMillionTokens` 和 `cachedInputCostPerMillionTokens`。

所有单价在设置页可编辑。新库直接使用 seed 默认值；老库的默认单价补种和统计开关初始化都只执行一次，不覆盖用户后续修改。

## 设计

### 流水表 `usage_ledger`

```sql
CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  eventKey TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  providerId TEXT NOT NULL,
  providerName TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  callCount INTEGER NOT NULL DEFAULT 1,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  unitPrice REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  detailJson TEXT NOT NULL DEFAULT '{}',
  projectId TEXT,
  refType TEXT NOT NULL DEFAULT '',
  refId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_usage_ledger_createdAt ON usage_ledger(createdAt);
CREATE INDEX idx_usage_ledger_model_createdAt ON usage_ledger(providerId, model, createdAt);
CREATE INDEX idx_usage_ledger_category_createdAt ON usage_ledger(category, createdAt);
```

`category` 仅使用 `image | video | llm_text | llm_vision | tts`。类别用于筛选；看板的主要聚合键是 `providerId + model`。

`lib/usage-ledger.ts` 提供 `recordUsage()`。它先检查调用开始时快照的 `usageTrackingEnabled`，再用 `INSERT OR IGNORE` 写入稳定的 `eventKey`，避免任务恢复、重复完成回调或页面重试产生重复流水。

供应商名称、模型、单价和统计开关都在调用开始时形成快照。调用期间修改设置不会追溯改变该次流水。

### 写入点

#### 公司图片

- 只处理 `usageTrackingEnabled=1` 的图片供应商。
- 在图片任务成功并写入 `jobs.estimatedCost` 后记录流水，沿用现有尝试次数口径。
- `eventKey=image-job:<jobId>:succeeded`，`quantity` 和 `callCount` 为现有成本口径对应的计费张数，`unit=image`。

#### 公司视频

- 在 `lib/video-queue.ts` 把视频任务原子更新为成功后记录一次。
- 可灵：`quantity=1`、`callCount=1`、`unit=request`。
- Seedance Fast：`quantity=durationSec`、`callCount=1`、`unit=second`。
- `eventKey=video-job:<videoJobId>:succeeded`。失败或 `needs_check` 不记；恢复后重复进入完成分支也不会重复。

#### 公司 LLM

- 只改造公司 GPT 使用的 OpenAI-compatible 响应解析，不要求 OpenAI Responses、Anthropic Messages 或原生 Gemini 适配器提供 usage。
- 适配器保留 `usage.prompt_tokens`、`usage.completion_tokens` 和 `usage.prompt_tokens_details.cached_tokens`。
- 归一化为 `uncachedInputTokens=max(promptTokens-cachedReadTokens, 0)`、`cachedReadTokens` 和 `outputTokens`，避免缓存 token 同时按输入价和缓存价重复计算。
- 成本为三类 token 分别乘对应单价后求和；`detailJson` 保存原始及归一化 token 明细。
- `quantity=uncachedInputTokens+cachedReadTokens+outputTokens`、`unit=token`、`callCount=1`；`unitPrice` 保存按总 token 折算的每 1M token 混合价。
- 已收到成功响应时，在业务 JSON 解析前记账。即使模型返回的 JSON 无效，该次上游调用仍进入流水。
- HTTP、网络或中止错误且没有成功响应时不记。若成功响应缺少 usage，则按提示词与输出字符数估算并标记 `detailJson.estimated=true`。
- 每次真实上游请求都有独立调用 ID，`eventKey=llm-call:<callId>`。业务重试若再次请求上游，应作为新的真实消耗记录。
- `completeJson` 和 `analyzeSellingPoints` 增加可选 `usageContext`，尽可能携带 `projectId`、业务引用类型和引用 ID。

#### 豆包 TTS

- 只在 `doubao-seed-tts-2` 真实调用供应商并成功得到音频后记录。
- 成片剪辑已有口播、批量生产复用 `batch-narration` 音频时不记账。
- 设置页试听会真实调用豆包，因此也记录；试听允许 `projectId` 为空。
- `quantity=字符数/1000`、`unit=kchar`、`callCount=1`。每次真实合成使用稳定的任务尝试或调用 ID 组成 `eventKey`。

本地代理生成、FFmpeg 渲染、字幕、LUT、封面和文件导出不调用计费模型，不写流水。

### 历史回填

- 只回填能精确关联到 `company-gateway-image2-medium`、`status='succeeded'` 且 `jobs.estimatedCost IS NOT NULL` 的历史图片任务。
- 回填使用与实时写入相同的 `eventKey=image-job:<jobId>:succeeded`，即使启动边界重叠也不会重复。
- 消耗模块写入 `image-backfill-v1` 一次性完成标记。已完成后不再扫描，避免未来的新任务被当成历史记录。
- 历史视频、LLM 和 TTS 没有可靠用量，从功能上线后开始统计。
- 不回填 `final_edit_jobs.estimatedCost`，因为其中混合了 TTS 与视觉分析预估，无法可靠归属到指定模型。

## 聚合 API

### `GET /api/usage`

返回：

- 今日、本周和本月预估总额；
- 当前筛选周期内按 `providerId + model` 聚合的金额、调用次数、原生用量和占比；
- 近 30 个上海自然日按模型拆分的逐日金额序列；
- 可选的类别小计，供筛选和辅助展示使用。

本地日按 UTC+8 自然日计算，周从周一开始。JS 先计算 UTC 边界再查询 ISO 时间；逐日序列补齐没有流水的日期为 0。

### `GET /api/usage/records`

支持 `from`、`to`、`providerId`、`model`、`category`、`page` 和 `pageSize`。结果按 `createdAt DESC, id DESC` 稳定分页，`pageSize` 设置上限。

## 页面与导航

- `components/Header.tsx` 在「项目」和「供应商」之间增加「消耗」。
- `app/usage/page.tsx` 顶部固定说明：“仅统计已开启的核心模型；预估消耗 = 配置单价 × 记录用量，非上游真实账单。”
- 第一屏展示今日、本周、本月三张总额卡片。
- 主区域展示模型消耗排行，列出供应商、模型、类型、调用次数、原生用量、预估金额和占比。
- 近 30 天图表按模型区分颜色，支持只查看某个模型。
- 流水表提供日期、模型和类别筛选；LLM 行可展开查看输入、输出、缓存读 token。
- 金额为 0 的已追踪调用仍展示，便于发现单价未配置。

## 数据流

1. 调用开始时读取供应商、模型、单价和 `usageTrackingEnabled` 快照。
2. 未开启统计的供应商正常执行，但不创建流水。
3. 已开启统计的图片/视频/TTS 在规定成功点写入；公司 LLM 在收到成功响应后、业务解析前写入。
4. `eventKey` 冲突视为已记录，不重复累计。
5. `/usage` 页面请求模型聚合与流水 API，并按上海本地时间展示。

## 错误与兼容性

- 流水写入失败只记录脱敏日志，不把已经成功的模型任务改成失败。
- 唯一 `eventKey` 保证相同计费事件最多记一次；真正再次调用上游必须使用新的调用或尝试 ID。
- 关闭统计只影响之后的新调用，不删除或隐藏已经产生的历史流水。
- 删除供应商后，流水中的名称、模型和金额快照仍可独立展示。
- 既有 `jobs.estimatedCost`、`final_edit_jobs.estimatedCost` 及其 UI 保持不变。
- 不新增图表依赖和本机数据目录，不改变桌面打包边界。

## 测试与验收

- 迁移测试：四类供应商表均有 `usageTrackingEnabled`；老库默认初始化只执行一次，用户关闭后重启不会被重新开启。
- 范围测试：五个指定内置供应商默认开启；Packy、Gemini、Anthropic、V-API 和直连视频供应商默认关闭且不写流水。
- 幂等测试：相同 `eventKey` 重复写入只保留一行，不重复累计金额和调用次数。
- 图片测试：公司 `image2-medium` 成功任务写流水；一次性历史回填只处理精确供应商且不会与实时写入重复。
- 视频测试：可灵按 ¥0.798/成功请求；公司 Seedance Fast 按 `0.8 × durationSec`；重复完成回调不重复。
- LLM 测试：公司 OpenAI-compatible usage 正确拆分非缓存输入、缓存读和输出；缺 usage 标为估算；JSON 解析失败仍保留调用流水。
- TTS 测试：真实豆包合成和试听写流水；成片或批量口播命中缓存时不写。
- 聚合测试：UTC+8 今日/周/月边界、周一起算、模型排行、占比、30 天补零和多模型序列正确。
- API/UI 合同测试：模型与日期筛选、稳定分页、顶部范围说明、三张汇总卡、模型排行、趋势和流水存在。
- 运行相关独立测试与 ESLint。

## 非目标

- 不统计外接或测试供应商，v1 不提供把它们加入看板的入口。
- 不对接或核对上游真实账单，不保证与供应商最终结算完全一致。
- 不做预算告警、额度限制或自动熔断。
- v1 不做项目维度的深度成本分析。
- 不做 CSV 导出。
- 不改造 OpenAI Responses、Anthropic Messages、原生 Gemini 等无关适配器的 usage 链路。
