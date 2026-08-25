# 核心模型消耗看板设计

日期：2026-08-18

## 目标

- 新增独立页面 `/usage`，与「项目」「供应商」并列为顶部导航 tab。
- 只统计公司 API 的 `image2-medium`、`GPT-5-6-Luna-Standard`、`kling-3.0`、`doubao-seedance-2-0-fast-260128`，以及豆包 `seed-tts-2.0`。
- Packy、Gemini、Anthropic、V-API、直连可灵、直连即梦以及其他公网、测试或外接供应商永远不进入看板。
- 以「核心模型」为主维度，展示今日、本周、本月预估消耗、模型排行、原生用量、调用次数、占比、近 30 天趋势和调用流水。
- 公司 LLM 优先按响应中的真实 token usage 计量；图片、视频和 TTS 按本设计规定的固定计费单位计量。
- 五个核心模型的单价由后端统一维护和计算，不提供设置页编辑入口。
- 页面固定标注“预估消耗，非上游真实账单”。

## 当前事实

### 已有成本数据

- 图片任务成功时，`lib/queue.ts` 会把 `providers.defaultCostPerImage × 尝试次数` 写入 `jobs.estimatedCost`。
- 首页项目列表会聚合 `jobs.estimatedCost`，但只覆盖图片任务。
- `video_providers.defaultCostPerVideo` 已存在，但视频队列尚未使用。
- `final_edit_tts_providers.costPerThousandCharacters` 已存在，用于成片准备阶段的容量成本预估。

这些既有字段继续服务原功能，但不再作为核心消耗看板的价格来源。看板只认后端固定计价注册表。

### 尚未覆盖

- 公司可灵和公司 Seedance 视频任务没有统一成本流水。
- 公司 `GPT-5-6-Luna-Standard` 的 OpenAI-compatible 响应中可能带 `usage`，当前适配器只返回文本，未保留 token 数据。
- 豆包 TTS 的真实合成、批量口播和设置页试听均未写统一流水。
- 当前没有按核心模型聚合的 API 和看板页面。

### 时间格式

- 现有任务时间同时存在 SQLite `datetime('now')` 和 JS `toISOString()` 两种格式。
- 新流水统一使用 `new Date().toISOString()`。历史图片回填时把 `YYYY-MM-DD HH:mm:ss` 明确按 UTC 转为 ISO，禁止交给本机时区猜测。

## 固定统计范围

v1 只允许以下五个核心模型进入流水。识别必须同时满足表、稳定供应商 ID、适配器/执行域和精确模型，不能仅按名称或模糊正则判断。

| 核心模型键 | 供应商表与 ID | 必须同时满足的身份条件 | 展示模型 |
|---|---|---|---|
| `company-image2-medium` | `providers.company-gateway-image2-medium` | `type='gateway-task-image'`、`model='image2-medium'` | `image2-medium` |
| `company-kling-3-0` | `video_providers.company-kling-3-0` | `type='openai-video'`、`defaultModel='kling-3.0'` | `kling-3.0` |
| `company-seedance-fast` | `video_providers.company-seedance-2-0-fast` | `type='openai-video'`、`defaultModel='doubao-seedance-2-0-fast-260128'` | `doubao-seedance-2-0-fast-260128` |
| `company-gpt-5-6-luna` | `script_providers.gpt` | `executionScope='company'`、`apiStyle='openai-compatible'`、运行时模型精确为 `GPT-5-6-Luna-Standard` | `GPT-5-6-Luna-Standard` |
| `doubao-seed-tts-2` | `final_edit_tts_providers.doubao-seed-tts-2` | `type='doubao-http-chunked'`、`model='seed-tts-2.0'` | `seed-tts-2.0` |

`lib/usage-pricing.ts` 提供唯一入口 `resolveCoreUsagePlan(providerSnapshot)`：

- 同时满足上表全部条件时返回核心模型键、类别、一项或多项固定价格分项和价格版本。
- 任一条件不符时返回 `null`，调用正常执行但不创建消耗流水。
- 不新增 `usageTrackingEnabled`，不提供手动加入、关闭或扩展统计范围的入口。
- `seed.ts` 必须按稳定 ID 保证三个公司图片/视频核心供应商存在；同模型的公网或手工测试配置不能阻止核心 ID 补种，也不能被误认为核心模型。
- 老库中 `script_providers.gpt` 如果仍是外接配置或非公司执行域，不统计，也不得被迁移强制改写为公司模型。

`providerSnapshot` 使用固定结构，不接收整行数据库对象：

```ts
interface CoreUsageProviderSnapshot {
  providerTable: 'providers' | 'video_providers' | 'script_providers' | 'final_edit_tts_providers';
  providerId: string;
  providerName: string;
  providerType: string;
  executionScope?: 'company' | 'external';
  apiStyle?: string;
  configuredModel: string;
  requestModel: string;
}
```

身份字段全部使用大小写敏感的精确字符串比较，不做 trim 之外的别名、大小写或正则归一化。`configuredModel` 来自调用开始时解析完成的供应商运行配置，`requestModel` 是本次真正传给适配器的模型；两者都必须等于表中规定的精确模型。图片和视频任务使用任务行冻结的 `model` 作为 `requestModel`，公司 GPT 使用 `resolveStoredScriptProvider()` 得到的运行时模型。

> **修订（2026-08-25）**：视频两项的 providerId 条件放宽为「canonical 行 id，**或** baseUrl 指向本机回环地址（`127.0.0.1`/`localhost`/`[::1]`，即公司 LiteLLM 网关）」。用户在设置页手工配置的公司网关行（如 `kling-2-5`）与 canonical 行同网关同模型，属于公司消耗；公网直连行的 baseUrl 是公网域名，依旧被排除。为此 `CoreUsageProviderSnapshot` 新增可选 `baseUrl` 字段并随视频快照持久化（reconcile 回放要用它重新过门禁）。配套新增一次性 `video-backfill-v1` 回填：存量无快照的公司视频任务按固定价 `durationSec ÷ 5 × 单价` 补记。图片/LLM/TTS 身份规则不变。

## 后端固定计价

五个核心模型的价格集中定义在 `lib/usage-pricing.ts`，设置页不读取、不展示、也不更新这些价格。

| 核心模型 | 计费数量 | 固定价格 | `priceScale` |
|---|---|---|---|
| `image2-medium` | 计费图片张数 | ¥1.05/张 | 1 |
| `kling-3.0` | 任务请求的 `durationSec` | ¥2.99/5 秒参考价 | 5 |
| `doubao-seedance-2-0-fast-260128` | 任务请求的 `durationSec` | ¥11.73/5 秒参考价 | 5 |
| `GPT-5-6-Luna-Standard` 输入 | 非缓存输入 token | ¥2.8878/1M tokens | 1,000,000 |
| `GPT-5-6-Luna-Standard` 输出 | 输出 token | ¥12.9952/1M tokens | 1,000,000 |
| `GPT-5-6-Luna-Standard` 缓存读 | 缓存读取 token | ¥0.28878/1M tokens | 1,000,000 |
| `seed-tts-2.0` | `Array.from(text).length` 个 Unicode 字符 | ¥0.28/千字符 | 1,000 |

每份价格表带常量 `pricingVersion`。价格调整通过代码发布完成，只影响调整后开始的真实调用；历史流水保留调用开始时的价格和版本，不追溯重算。

两个公司视频价格来自当前 5 秒测试结果，只作为预估参考，实际账单可能有出入。实现固定保存 `2_990_000` 与 `11_730_000` 微元作为各自 5 秒价格，以 `durationSec × 五秒参考价 ÷ 5` 线性折算；页面必须保留“非上游真实账单”提示。

金额统一保存为整数微元。先逐个价格分项计算，再对分项金额求和：

```text
componentCostMicros = round(componentQuantity × componentUnitPriceMicros ÷ componentPriceScale)
costMicros = sum(componentCostMicros)
```

其中 `1 元 = 1,000,000 微元`。图片、视频和 TTS 只有一个价格分项；GPT 有输入、输出、缓存读三个分项，禁止把顶层 `unitPriceMicros=0` 代入分项公式。页面只在展示层换算成人民币，避免 SQLite `REAL` 累计金额产生浮点漂移。

## 设计

### Schema 与迁移边界

- 新增 `lib/usage-schema.ts`，用独立的 `usage_schema_migrations` 版本表创建和升级 `usage_ledger`；已发布迁移只追加、不修改。
- 同一 usage schema 同时管理 `usage_call_events`，为没有稳定业务任务行的 LLM/TTS 调用保存可恢复证据。
- `CORE_DB_MIGRATIONS` 只追加 `jobs.usageSnapshotJson TEXT` 与 `video_jobs.usageSnapshotJson TEXT`，用于持久化异步调用的价格快照。
- 四类供应商表都不增加统计开关、价格版本或新的计价列；`lib/final-edit/schema.ts` 不为消耗看板修改 `final_edit_tts_providers`。
- 消耗 schema 未就绪时只关闭 `/usage` 与新流水写入，不能阻塞既有图片、视频、脚本、TTS 和成片功能。

### 流水表 `usage_ledger`

```sql
CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  eventKey TEXT NOT NULL UNIQUE,
  coreModelKey TEXT NOT NULL,
  category TEXT NOT NULL,
  providerId TEXT NOT NULL,
  providerName TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  pricingVersion TEXT NOT NULL,
  callCount INTEGER NOT NULL DEFAULT 1,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL,
  priceScale INTEGER NOT NULL DEFAULT 1,
  unitPriceMicros INTEGER NOT NULL DEFAULT 0,
  costMicros INTEGER NOT NULL DEFAULT 0,
  detailJson TEXT NOT NULL DEFAULT '{}',
  projectId TEXT,
  refType TEXT NOT NULL DEFAULT '',
  refId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_usage_ledger_createdAt ON usage_ledger(createdAt);
CREATE INDEX idx_usage_ledger_model_createdAt ON usage_ledger(coreModelKey, createdAt);
CREATE INDEX idx_usage_ledger_category_createdAt ON usage_ledger(category, createdAt);

CREATE TABLE IF NOT EXISTS usage_call_events (
  eventKey TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('started','billable','recorded','uncertain')),
  ownerInstanceId TEXT NOT NULL,
  snapshotJson TEXT NOT NULL,
  usageJson TEXT NOT NULL DEFAULT '{}',
  projectId TEXT,
  refType TEXT NOT NULL DEFAULT '',
  refId TEXT NOT NULL DEFAULT '',
  errorMessage TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX idx_usage_call_events_status ON usage_call_events(status, updatedAt);
```

`category` 仅使用 `image | video | llm_text | llm_vision | tts`。类别用于筛选；看板主要聚合键是稳定的 `coreModelKey`，不受供应商显示名称变化影响。

### 调用与价格快照

- 在真实上游请求开始前调用 `resolveCoreUsagePlan()`。
- 返回 `null` 时不产生任何看板数据。
- 返回计价方案时，必须形成包含供应商名称、模型、核心模型键、计费单位、固定价格和 `pricingVersion` 的快照。
- 图片、视频等异步任务把快照持久化到任务行的 `usageSnapshotJson`；崩溃恢复、继续轮询和失败重试复用原快照，不重新读取新价格。
- `usageSnapshotJson` 使用版本化的 `CoreUsageSnapshotV1`；解析未知版本时停止该笔记账并记录错误，不能回退当前价格：

  ```ts
  interface CoreUsagePriceComponentV1 {
    key: 'image' | 'request' | 'second' | 'input_token' | 'output_token' | 'cached_input_token' | 'character';
    unit: 'image' | 'request' | 'second' | 'token' | 'character';
    unitPriceMicros: number;
    priceScale: number;
  }

  interface CoreUsageSnapshotV1 {
    schemaVersion: 1;
    provider: CoreUsageProviderSnapshot;
    coreModelKey: string;
    pricingVersion: string;
    priceComponents: CoreUsagePriceComponentV1[];
    startedAt: string;
    projectId?: string;
    refType: string;
    refId: string;
  }
  ```

  图片、视频和 TTS 的 `priceComponents` 恰好一项；GPT 恰好包含 `input_token`、`output_token`、`cached_input_token` 三项。数量在成功响应或任务完成时确定，不写入调用开始快照。
- LLM 和 TTS 每次真实上游请求生成独立 `callId`，在发出请求前先以 `eventKey` 和价格快照创建 `usage_call_events.status='started'`。

### 可靠写入与幂等

`lib/usage-ledger.ts` 提供 `recordUsage()` 与可重复执行的 `reconcileUsageLedger()`；最终流水使用 `INSERT OR IGNORE` 写入稳定的 `eventKey`。

- 相同计费事件重复完成、恢复或页面重试最多生成一条流水。
- 图片和视频成功任务以“成功任务行 + `usageSnapshotJson` + 稳定 `eventKey`”作为可重放证据。任务完成后立即尝试写流水；写入失败不回滚成功任务，`reconcileUsageLedger()` 在启动和 `/usage` 读取前扫描缺少对应流水的成功任务补写。
- LLM 在收到成功 HTTP 响应、业务 JSON 解析之前，把原始/归一化 usage 写入 `usage_call_events` 并改为 `billable`；TTS 在真实音频校验成功后把预先保存的字符数量写为 `billable`。随后 drain 将 `billable` 幂等转入 `usage_ledger` 并标为 `recorded`。
- `usage_call_events.ownerInstanceId` 记录创建调用的应用实例。启动恢复时把其他实例遗留的 `started` 事件改为 `uncertain`；`uncertain` 是 v1 的终态审计记录，永不自动计费、永不自动重试上游，并计入 `/api/usage` 的 `unresolvedCount` 提示，不进入金额与调用次数聚合。TTS 的字符数量即使已知，没有成功证据时仍不计费。
- usage schema 在调用开始前不可用时，核心业务仍可执行，但不写 `usageSnapshotJson`、不创建 `usage_call_events`，并记录脱敏错误和“本次未进入消耗统计”的告警。`reconcileUsageLedger()` 只扫描非空且可解析的快照，因此这类调用以后也不会被补计；不得临时回退供应商表价格。
- 一次性历史回填和完成标记必须在同一事务提交，部分失败不能写入完成标记。

### 写入点

#### 公司图片

- 仅 `resolveCoreUsagePlan()` 识别为 `company-image2-medium` 时处理。
- 图片任务成功时记录，沿用现有尝试次数成本口径。
- `eventKey=image-job:<jobId>:succeeded`。
- `quantity` 和 `callCount` 均为该成功任务计入现有 `jobs.estimatedCost` 的尝试张数，`unit=image`。

#### 公司视频

- 仅处理两个公司 `openai-video` 核心模型。
- 在 `lib/video-queue.ts` 把视频任务原子更新为成功时记录。
- 可灵：`quantity=job.durationSec`、`callCount=1`、`unit=second`、`unitPriceMicros=2_990_000`、`priceScale=5`。
- Seedance Fast：`quantity=job.durationSec`、`callCount=1`、`unit=second`、`unitPriceMicros=11_730_000`、`priceScale=5`；两个模型都使用请求时长，不使用下载后探测时长。
- `eventKey=video-job:<videoJobId>:succeeded`。失败或 `needs_check` 不记；恢复后重复进入完成分支也不会重复。

#### 公司 LLM

- 只改造满足公司执行域和精确模型条件的 OpenAI-compatible 响应解析。
- 不要求 OpenAI Responses、Anthropic Messages、原生 Gemini 或其他公网适配器提供 usage。
- 保留 `usage.prompt_tokens`、`usage.completion_tokens` 和 `usage.prompt_tokens_details.cached_tokens`。
- 归一化为 `uncachedInputTokens=max(promptTokens-cachedReadTokens, 0)`、`cachedReadTokens` 和 `outputTokens`，避免缓存 token 同时按输入价和缓存价计算。
- 三类 token 分别按自己的固定价格计算微元后求和；`detailJson` 保存原始及归一化 token 明细。
- `quantity=uncachedInputTokens+cachedReadTokens+outputTokens`、`unit=token`、`callCount=1`。GPT 是复合价格事件，顶层固定写 `unitPriceMicros=0`、`priceScale=1`，表示不能用单一价格复算；三类 token 的 `quantity`、`unitPriceMicros`、`priceScale=1_000_000` 和分项金额保存在 `detailJson.priceComponents`，顶层 `costMicros` 保存分项总额。
- 成功响应缺少 usage 时，用 `Array.from(serializedPrompt).length` 和 `Array.from(rawOutput).length` 作为输入、输出 token 的保守估算，缓存读为 0，并标记 `detailJson.estimated=true`。
- 已收到成功响应时，在业务 JSON 解析前记账；模型返回无效 JSON仍计入。HTTP、网络或中止错误且没有成功响应时不记。
- 每次真实上游请求都有独立调用 ID，`eventKey=llm-call:<callId>`。业务重试再次请求上游时形成新的真实消耗。
- `completeJson` 和 `analyzeSellingPoints` 增加可选 `usageContext`，尽可能携带 `projectId`、业务引用类型和引用 ID。
- 有图片输入时记为 `llm_vision`，否则记为 `llm_text`。

#### 豆包 TTS

- 只在 `doubao-seed-tts-2` 真实调用供应商并成功得到有效音频后记录。
- 成片剪辑已有口播、批量生产复用 `batch-narration` 音频、设置页复用已有试听缓存时均不记账。
- 设置页试听首次真实调用豆包时记录，允许 `projectId` 为空。
- `quantity=Array.from(text).length`、`unit=character`、`priceScale=1000`、`callCount=1`。
- 每个真实豆包 HTTP 合成请求（包括长口播拆分后的每个 chunk）在请求前生成 `callId=crypto.randomUUID()` 并先持久化调用证据，统一使用 `eventKey=tts-call:<callId>`；该笔 `quantity` 只计算本次请求的 chunk 文本。批量/成片任务的任务 ID、尝试号只写入 `refType/refId/detailJson`，不替代 `callId`；真正再次请求上游必须生成新 `callId`，缓存命中不生成调用事件。

本地代理生成、FFmpeg 渲染、字幕、LUT、封面和文件导出不调用计费模型，不写流水。

### 历史回填

- 只回填能精确关联到核心 ID `company-gateway-image2-medium`、模型为 `image2-medium`、`status='succeeded'` 且 `jobs.estimatedCost IS NOT NULL` 的历史图片任务。
- 回填使用与实时写入相同的 `eventKey=image-job:<jobId>:succeeded`，即使启动边界重叠也不会重复。
- 历史 `jobs.estimatedCost` 的单位明确为人民币元；回填使用 `costMicros=Math.round(estimatedCost × 1_000_000)`，`pricingVersion='legacy-image-estimated-cost-v1'`。不得用当前固定价格反推并改写历史金额。
- 消耗模块写入 `image-backfill-v1` 一次性完成标记。事务完整成功后才写标记，之后不再扫描。
- 历史视频、LLM 和 TTS 没有可靠用量，从功能上线后开始统计。
- 不回填 `final_edit_jobs.estimatedCost`，因为其中混合了 TTS 与视觉分析预估，无法可靠归属到指定核心模型。

## 聚合 API

### `GET /api/usage`

支持可选的 `from`、`to`、`coreModelKey` 和 `category`；时间区间统一为左闭右开 `[from, to)`。

返回：

- 今日、本周和本月预估总额；
- 当前筛选周期内按 `coreModelKey` 聚合的金额、调用次数、原生用量和占比；
- 近 30 个上海自然日按核心模型拆分的逐日金额序列；
- 类别小计；
- 不计入金额的 `uncertain` 调用数量 `unresolvedCount`，供页面提示存在无法确认的调用。

本地日按 UTC+8 自然日计算，周从周一开始。JS 先计算 UTC 边界再查询 ISO 时间；逐日序列补齐没有流水的日期为 0，总金额为 0 时占比统一为 0。

### `GET /api/usage/records`

支持 `from`、`to`、`coreModelKey`、`category`、`page` 和 `pageSize`。日期同样使用 `[from, to)`；结果按 `createdAt DESC, id DESC` 稳定分页，`pageSize` 上限为 100。

## 页面与导航

- `components/Header.tsx` 在「项目」和「供应商」之间增加「消耗」。
- `app/usage/page.tsx` 顶部固定说明：“仅统计固定核心模型；预估消耗由后台固定单价与记录用量计算，非上游真实账单。”
- 第一屏展示今日、本周、本月三张总额卡片。
- 主区域展示模型消耗排行，列出核心模型、类型、调用次数、原生用量、预估金额和占比。
- 近 30 天图表按核心模型区分颜色，支持只查看某个模型。
- 流水表提供日期、模型和类别筛选；LLM 行可展开查看输入、输出、缓存读 token 及是否为估算。
- 设置页不新增“计入消耗看板”开关，也不展示这五个核心模型的看板单价编辑框。
- 既有供应商成本字段即使仍为兼容目的保留，也不能影响 `/usage` 的金额。

## 数据流

1. 真实调用开始前，用供应商完整身份调用 `resolveCoreUsagePlan()`。
2. 非五个核心模型正常执行，但不生成消耗快照或流水。
3. 核心模型固定价格、版本和调用身份形成快照；异步任务持久化快照。
4. 图片、视频和 TTS 在规定成功点写入；公司 LLM 在收到成功响应后、业务解析前写入。
5. `eventKey` 冲突视为已记录，不重复累计。
6. `/usage` 页面请求聚合与流水 API，并按上海本地时间展示微元换算金额。

## 错误与兼容性

- 公网或测试供应商即使使用相似名称，也不能通过精确身份门禁，不写流水。
- 用户修改供应商名称不影响稳定核心模型键；修改模型、适配器或公司执行域后不再满足核心身份，从下一次真实调用开始不统计。
- 固定价格调整只影响新调用，历史流水不追溯。
- 唯一 `eventKey` 保证相同计费事件最多记一次；真正再次调用上游必须使用新的调用或尝试 ID。
- 删除供应商后，流水中的名称、模型、价格版本和金额快照仍可独立展示。
- 既有 `jobs.estimatedCost`、`final_edit_jobs.estimatedCost` 及其 UI 保持不变，但不作为新看板实时价格来源。
- 不新增图表依赖和本机数据目录，不改变桌面打包边界。

## 测试与验收

- Schema 测试：usage 独立迁移创建 `usage_ledger`、`usage_call_events` 和索引；core 迁移只给 `jobs`/`video_jobs` 增加 nullable `usageSnapshotJson`，供应商表不出现统计或计价新列。
- 固定范围测试：只有五个核心模型的完整身份组合能解析出计价方案。
- 负向范围测试：Packy、Gemini、Anthropic、V-API、直连可灵、直连即梦、相似名称、相似模型和老库外接 `gpt` 均返回 `null` 且不写流水。
- 设置页合同测试：不存在统计开关；五个核心模型不存在看板单价编辑入口。
- 价格测试：固定价格、`pricingVersion`、`priceScale` 和微元舍入结果正确；修改既有供应商成本字段不影响看板金额。
- 快照测试：调用开始后即使代码价格版本变化或任务跨重启恢复，任务仍使用原快照。
- 幂等与恢复测试：相同 `eventKey` 重复写入只保留一行；成功图片/视频缺流水时 reconciler 能从任务快照补写；`billable` 调用事件能 drain，超时 `started` 事件转 `uncertain` 且不重新调用上游。
- 图片测试：公司 `image2-medium` 成功任务写流水；一次性历史回填只处理精确核心供应商，且不会与实时写入重复。
- 视频测试：5 秒公司可灵精确得到 ¥2.99、5 秒公司 Seedance Fast 精确得到 ¥11.73；其他时长按 `durationSec ÷ 5` 线性折算，重复完成回调不重复。
- LLM 测试：公司 OpenAI-compatible usage 正确拆分非缓存输入、缓存读和输出；复合价格事件顶层价格字段为 `0/1`、分项可复算总额；缺 usage 按固定字符公式估算；JSON 解析失败仍保留调用流水。
- TTS 测试：每个真实豆包 HTTP/chunk 请求使用新的持久 `callId` 且只计算该 chunk 字符；首次试听写流水，成片、批量口播或试听命中缓存时不创建调用事件。
- 回填测试：历史图片成本按人民币元乘 `1_000_000` 并四舍五入；事务失败不写 `image-backfill-v1` 完成标记。
- 聚合测试：UTC+8 今日/周/月边界、周一起算、左闭右开区间、模型排行、占比、30 天补零和多模型序列正确。
- API/UI 合同测试：固定范围说明、三张汇总卡、模型排行、趋势、筛选和稳定分页存在。
- 运行相关独立测试与 ESLint。

## 非目标

- 不统计或展示任何公网、测试、外接供应商。
- v1 不提供扩展统计范围、关闭核心模型统计或手动修改看板单价的入口。
- 不对接或核对上游真实账单，不保证与供应商最终结算完全一致。
- 不做预算告警、额度限制或自动熔断。
- v1 不做项目维度的深度成本分析。
- 不做 CSV 导出。
- 不改造 OpenAI Responses、Anthropic Messages、原生 Gemini 等无关适配器的 usage 链路。
