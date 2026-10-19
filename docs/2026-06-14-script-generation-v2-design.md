# 脚本生成系统 v2 设计文档

> 日期：2026-06-14  
> 状态：设计阶段，待实现

## 一、概述

### 1.1 目标

将当前"填信息→一键生成→表格展示"的简单脚本工具，升级为**四步专业工作流**：卖点分析 → 策略配置 → 脚本生成 → 图文审阅。

### 1.2 核心改进

| 维度 | v1（现状） | v2（目标） |
|---|---|---|
| 卖点处理 | 纯文本列表硬塞 prompt | AI 分析排名 + 用户选择 + 卖点→分镜映射 |
| 人群洞察 | 无 | 基于人群画像分析卖点优先级和叙事角度 |
| 图片参考 | 不可见 | 分镜图片与脚本左右对照 |
| 脚本模版 | 无 | 7 种叙事模版可选 |
| 时长控制 | 固定 15s | 15s/20s/30s/60s 可选 |
| 模型选择 | 仅 Gemini | Gemini / 通义千问 / Kimi / GPT |
| 平台 | 抖音/小红书/视频号/通用 | 新增淘宝/天猫，共 6 个平台 |
| 复制导出 | 简单复制 | 剪映友好格式，纯文本一键复制 |

---

## 二、工作流

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ ① 卖点分析 │ ─→ │ ② 策略配置 │ ─→ │ ③ 生成脚本 │ ─→ │ ④ 图文审阅 │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
 用户输入卖点      AI 返回排名      用户确认选择      分镜图片+脚本
 人群+平台         理由+推荐模版     模版+时长+模型     左右对照
 选择分析模型      用户勾选卖点      所选模型生成     一键复制全文
```

### 2.0 关键实现约束

1. **脚本生成必须绑定一个明确的分镜组 `shotSetId`**。当前项目允许一个项目下存在多个 `shot_sets`，且每个分镜组内的 `shots.indexNum` 都会从 1 开始。v2 不应再把项目下所有分镜混在一起生成脚本，否则不同分镜组的 `shotIndex=1` 会互相错配。
2. **脚本和图片的稳定绑定必须使用 `shotId`**。`shotIndex` 只用于展示排序，不作为数据关联主键。脚本输出、图文审阅、创意包导出都应通过 `shotId` 找到对应分镜图。
3. **生成结果需要同时保留展示顺序和稳定 ID**。建议 API 给模型的上下文使用 `displayIndex` / `shotIndex` 帮助写文案，但服务端保存结果时保留 `shotId`、`shotSetId`、`sourceImageId`、`latestGeneratedImageId`。

### 2.1 步骤①：卖点分析

用户操作：输入卖点（一行一条）+ 目标人群 + 平台 + 选择分析模型。

AI 返回：每个卖点的优先级排名、理由、推荐模版、目标人群 hook。

模版推荐必须返回稳定 ID。中文名称只做展示，不能作为后续生成逻辑的唯一依据。

输出 JSON schema：

```json
{
  "rankings": [
    {
      "rank": 1,
      "title": "奶油色百搭，适合小户型",
      "priority": "highest",
      "reason": "小红书女性用户第一关注点是颜值和空间感，奶油色是当下热门家居色，天然适合首图封面",
      "recommendedTemplateId": "scene_seeding",
      "recommendedTemplateName": "场景种草",
      "targetHook": "独居女性对'治愈感卧室'有强烈向往"
    }
  ],
  "audienceInsight": "25-35岁独居女性的核心决策链：颜值 > 舒适 > 性价比 > 安装便利性",
  "platformAdvice": "小红书适合温柔种草语气，强调视觉氛围和情感共鸣，避免硬核参数轰炸"
}
```

分析结果需要**持久化到 DB**，避免刷新丢失。可在 `projects` 表加 `sellingPointAnalysisJson TEXT` 字段。

### 2.2 步骤②：策略配置

用户在分析结果基础上做四个决策：

1. **勾选重点卖点**（默认勾选前 3 名优先级的）
2. **选择脚本模版**（7 选 1）
3. **选择时长**（15s / 20s / 30s / 60s）
4. **选择生成模型**（可与分析模型不同）

### 2.3 步骤③：脚本生成

AI 入参：

- 选中的卖点（含优先级和分析理由）
- 选中的脚本模版（叙事结构指令）
- 时长
- 平台 + 人群 + 语气
- 选中的 `shotSetId`
- 分镜列表（从该 `shotSetId` 下的 `shots` 加载，含 `shotId`、展示序号、图片文件名/图片描述）
- 场景参考名称
- 运镜模板名称

输出：

```json
{
  "title": "奶油色卧室｜独居女孩的治愈角落",
  "platform": "小红书",
  "tone": "种草",
  "duration": "30s",
  "template": "场景种草",
  "shotSetId": "shot-set-id",
  "sellingPointMap": [
    { "shotId": "shot-id-1", "shotIndex": 1, "sellingPoint": "奶油色百搭" },
    { "shotId": "shot-id-2", "shotIndex": 2, "sellingPoint": "软包靠背" }
  ],
  "shots": [
    {
      "shotId": "shot-id-1",
      "shotIndex": 1,
      "duration": "0-5s",
      "voiceover": "...",
      "subtitle": "...",
      "visualIntent": "..."
    }
  ],
  "fullScript": "连续口播全文，纯文本无标记"
}
```

### 2.4 步骤④：图文审阅

每个分镜卡片：

- **左**：分镜生成图（latestGeneratedImageId）或原始图（sourceImageId）或占位符
- **右**：该分镜的卖点标签 + 口播 + 字幕 + 视觉意图

图文审阅必须用 `shotId` 匹配脚本文案和分镜图。`shotIndex` 仅作为排序/标题展示，避免多个分镜组或重新排序后出现错配。

底部：完整口播稿（纯文本，中文标点，按句断行），一键复制到剪映。

---

## 三、平台

| 平台 | 内容风格 | Prompt 指令要点 |
|---|---|---|
| 抖音 | 快节奏、前 3 秒钩子 | 口语化、节奏感、BGM 配合联想 |
| 小红书 | 精致审美、信任感 | "姐妹"口吻、细节控、温柔治愈 |
| 视频号 | 偏熟龄、重信任 | 稳重真诚、适合深度讲解 |
| 淘宝 | 转化导向、商品详情页 | 功能点密集、促单话术、直接 |
| 天猫 | 品牌感、旗舰店调性 | 高级感、品宣大于促销、克制 |
| 通用 | 不限平台 | 中性自由 |

---

## 四、模型 / Provider 架构

### 4.1 目录结构

```
lib/script-providers/
├── index.ts              ← 统一入口 + Provider 注册表
├── types.ts              ← 共享类型（ScriptInput, ScriptOutput, AnalysisResult 等）
├── openai-compatible.ts  ← 通用 OpenAI 兼容适配器（Qwen / Kimi / GPT 共用）
└── gemini.ts             ← Gemini 原生 API
```

### 4.2 Provider 注册表

| ID | 名称 | API 类型 | 环境变量 |
|---|---|---|---|
| `gemini` | Gemini | Gemini 原生 / OpenAI 兼容代理 | `GEMINI_API_KEY` `GEMINI_BASE_URL` `GEMINI_MODEL` `GEMINI_API_STYLE` |
| `qwen` | 通义千问 | OpenAI 兼容 | `QWEN_API_KEY` `QWEN_BASE_URL` `QWEN_MODEL` |
| `kimi` | Kimi (月之暗面) | OpenAI 兼容 | `KIMI_API_KEY` `KIMI_BASE_URL` `KIMI_MODEL` |
| `gpt` | GPT / OpenAI | OpenAI 兼容 | `GPT_API_KEY` `GPT_BASE_URL` `GPT_MODEL` |

兼容现状：

- 当前 `lib/script-providers/gemini.ts` 同时支持 `native` 和 `openai-compatible` 两种调用方式，并通过 `GEMINI_API_STYLE` 切换。
- v2 重构不能把 Gemini 固定成原生 API，否则会破坏当前通过 OpenAI 兼容代理使用 Gemini 的路径。
- `openai-compatible.ts` 应抽出通用请求/解析逻辑，Gemini provider 可以在 `GEMINI_API_STYLE=openai-compatible` 时复用它，也可以在 `native` 时走 Gemini 原生 adapter。

### 4.3 模型参数

| 模型 | 上下文窗口 | 建议 max_tokens |
|---|---|---|
| Gemini 3.5 Flash | 1M | 8192 |
| Qwen-Max | 32K | 8192 |
| Kimi (moonshot-v1) | 128K | 4096 |
| GPT-4o | 128K | 16384 |

### 4.4 API 设计

Provider 统一接口：

```typescript
interface ScriptProvider {
  id: string;
  name: string;
  isConfigured: () => boolean;
  analyzeSellingPoints(input: AnalysisInput): Promise<AnalysisResult>;
  generateScript(input: ScriptInput): Promise<ProviderScriptResult>;
}

interface ProviderScriptResult {
  script: ScriptOutput;
  provider: string;
  model: string;
}
```

`index.ts` 暴露两个函数：

```typescript
export async function analyzeSellingPoints(input: AnalysisInput, providerId: string): Promise<AnalysisResult>;
export async function generateScript(input: ScriptInput, providerId: string): Promise<ProviderScriptResult>;
export function getAvailableProviders(): ProviderMeta[];
export function getProvider(providerId: string): ScriptProvider;
```

### 4.5 配置状态可视化

ScriptPanel 中展示各模型配置状态，避免用户选了模型但没配 Key：

```
Gemini:    ✅ 已配置 (gemini-3.5-flash)
通义千问:   ❌ 未配置 — 请在 .env.local 设置 QWEN_API_KEY
Kimi:      ✅ 已配置 (moonshot-v1-8k)
GPT:       ❌ 未配置
```

短期可继续使用环境变量作为脚本模型配置来源，但需要明确这是 v2 第一阶段取舍。项目现有图片供应商已经在 Settings 页面通过 SQLite 管理 Base URL、模型和 Key；如果脚本模型长期只依赖 `.env.local`，会和现有配置体验分叉。

建议阶段划分：

1. v2 第一阶段：脚本 provider 使用环境变量，`/script/models` 只返回服务端检测到的配置状态，前端不暴露 Key。
2. 后续阶段：将脚本 provider 纳入 Settings，或抽象成通用 provider 表，统一图片/脚本/视频模型配置入口。

---

## 五、脚本模版（7 种）

每个模版都有固定的叙事结构，注入到生成 prompt 的 system 指令中。

### 5.1 模版清单

| 模版 ID | 名称 | 叙事公式 | 适合卖点类型 |
|---|---|---|---|
| `pain_point` | 直击痛点 | "你是不是也…" → 放大痛点 → 产品拯救 | 功能型卖点 |
| `scene_seeding` | 场景种草 | 打造生活场景 → 产品自然出现 → 向往感 | 颜值/氛围型 |
| `feature_showcase` | 功能展示 | 参数/细节逐一亮相 → 每个镜头讲一个核心功能 | 硬核参数型 |
| `emotional` | 情感共鸣 | 情绪故事先行 → 产品作为陪伴/解决方案出场 | 生活方式型 |
| `comparison` | 对比测评 | 使用前 vs 使用后 / A产品 vs B产品 → 差异可视化 | 有明确对比点 |
| `unboxing` | 开箱体验 | 拆包 → 安装 → 第一印象 → 使用感受 | 安装简单/包装精致 |
| `problem_solving` | 问题解决 | 抛出具体问题 → 产品如何解决 → 效果验证 | 实用功能型 |

### 5.2 模版选择 UI

每个模版以卡片展示，包含：
- 名称
- 一句 slogan（如"你是不是也…？"）
- 2-3 句口播示意（极简示例）
- 适合什么类型的卖点提示

---

## 六、数据库变更

### 6.1 新增字段（projects 表）

```sql
ALTER TABLE projects ADD COLUMN sellingPointAnalysisJson TEXT DEFAULT '';
```

存储步骤①的分析结果，刷新页面后不丢失。

落地要求：

- `lib/db.ts` 中 `CREATE TABLE IF NOT EXISTS projects` 的新库路径需要包含该字段。
- `lib/db.ts` 中 migrations 数组需要加入同一条 `ALTER TABLE`，兼容已有本地 SQLite 数据库。
- `app/api/projects/[id]/route.ts` 的 `GET` 会自然返回该字段；若前端需要单独保存/清空分析结果，`PATCH` 白名单也需要允许 `sellingPointAnalysisJson`。
- 分析结果建议保存为完整 JSON 字符串，包含输入摘要，例如 `sellingPointsHash`、`targetAudience`、`platform`、`providerId`、`model`、`analyzedAt`，便于页面判断分析结果是否仍匹配当前输入。

### 6.2 已有字段复用

| 字段 | 用途 | 现状 |
|---|---|---|
| `sellingPointsJson` | 存储卖点列表 | 已有，格式 `[{title, priority}]` |
| `targetAudience` | 目标人群 | 已有 |
| `scriptTone` | 语气 | 已有 |
| `scriptPlatform` | 平台 | 已有，需扩展选项值支持淘宝/天猫 |
| `script_drafts` | 历史草稿 | 已有 |

### 6.3 草稿表补充约定

`script_drafts` 继续保存生成脚本历史。v2 需要在 `inputSnapshot` 中加入：

- `shotSetId`
- `selectedSellingPoints`
- `templateId`
- `duration`
- `providerId`
- `model`

`outputJson` 中的每条分镜脚本需要包含 `shotId`，方便图文审阅和创意包导出稳定匹配。

---

## 七、API 路由变更

### 7.1 当前

```
GET  /api/projects/[id]/script   → 获取草稿列表
POST /api/projects/[id]/script   → 生成脚本
```

### 7.2 变更后

```
GET  /api/projects/[id]/script          → 获取草稿列表 + 分析结果（如有）
GET  /api/projects/[id]/script/models   → 获取可用模型列表及配置状态
POST /api/projects/[id]/script          → body: { action: "analyze" | "generate", ... }
```

action=analyze 时传入：sellingPoints, targetAudience, platform, providerId  
action=generate 时传入：shotSetId, selectedSellingPoints, templateId, duration, providerId

### 7.3 API 细节约定

`GET /api/projects/[id]/script` 返回：

```json
{
  "drafts": [],
  "analysis": null
}
```

其中 `analysis` 来自 `projects.sellingPointAnalysisJson`，解析失败时返回 `null` 并允许前端重新分析。

`GET /api/projects/[id]/script/models` 返回：

```json
{
  "providers": [
    {
      "id": "gemini",
      "name": "Gemini",
      "model": "gemini-3.5-flash",
      "configured": true,
      "apiStyle": "openai-compatible"
    }
  ]
}
```

`POST action=generate` 服务端加载分镜时必须限定 `shotSetId`：

```sql
SELECT s.id as shotId, s.indexNum, s.sourceImageId, s.latestGeneratedImageId,
       src.filename as sourceFilename
FROM shots s
JOIN shot_sets ss ON ss.id = s.shotSetId
JOIN image_assets src ON src.id = s.sourceImageId
WHERE ss.projectId = ? AND ss.id = ?
ORDER BY s.indexNum
```

如果 `shotSetId` 不属于当前项目或分镜为空，返回 400。

---

## 八、组件拆分

### 8.1 现有

```
components/ScriptPanel.tsx    ← 全部逻辑在一个文件（295 行）
```

### 8.2 变更后

```
components/ScriptPanel.tsx              ← 主容器，管理四步状态
components/ScriptSellingPointInput.tsx  ← 步骤①：卖点输入 + 人群平台 + 模型选择
components/ScriptAnalysisResult.tsx     ← 步骤②：分析结果展示 + 卖点勾选
components/ScriptTemplatePicker.tsx     ← 步骤②：模版选择器（7 卡片）
components/ScriptStrategyConfig.tsx     ← 步骤②：时长 + 生成模型选择 + 生成按钮
components/ScriptShotCard.tsx           ← 步骤④：单个分镜卡片（图 + 文）
components/ScriptResultView.tsx         ← 步骤③④：生成结果 + 图文对照 + 全文复制
```

---

## 九、Prompt 工程要点

### 9.1 分析 prompt

- 明确输出 JSON schema（避免格式混乱）
- 要求模型解释"为什么这个卖点打动这个人群"
- 要求推荐模版并给出理由
- 给出平台级别的策略建议

### 9.2 生成 prompt

System 指令包含：

- 当前选中模版的叙事结构（从模版定义注入）
- 平台对应的语气和节奏要求
- 时长对应的分镜时长分配逻辑
- 卖点与分镜的映射关系（内部使用 `shotId`，展示使用 `shotIndex`）
- 剪映友好格式要求（中文标点、按句断句、不出现 markdown）

### 9.3 时长与分镜匹配

| 时长 | 建议分镜数 | 每段口播字数 |
|---|---|---|
| 15s | 3-5 镜 | 15-25 字/段 |
| 20s | 4-6 镜 | 20-30 字/段 |
| 30s | 5-8 镜 | 25-35 字/段 |
| 60s | 8-15 镜 | 30-40 字/段 |

Prompt 中需要根据实际分镜数和时长自动计算每段口播的目标字数。

### 9.4 输出校验与归一化

模型返回 JSON 后，服务端需要先做校验和归一化，再写入 `script_drafts`：

- 去除 markdown fence、首尾空白。
- JSON.parse 后校验必填字段：`title`、`shots`、`fullScript`。
- 校验每个 `shots[].shotId` 必须存在于当前 `shotSetId` 的分镜集合中。
- 校验 `shots.length` 应与输入分镜数一致；不一致时可重试一次，仍失败则返回可读错误。
- 校验 `sellingPointMap[].shotId` 和 `sellingPointMap[].sellingPoint` 均有效。
- 归一化缺失字段：若 `fullScript` 为空，用各分镜 `voiceover` 按行拼接；若 `subtitle` 为空，默认等于 `voiceover`。
- 保存前补齐服务端可信字段：`shotSetId`、`provider`、`model`、`generatedAt`。

---

## 十、风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 卖点过多导致 token 超标 | API 调用失败 | 前端限制 15 条，prompt 中卖点文本截断保护 |
| 分析结果刷新丢失 | 用户体验差 | `sellingPointAnalysisJson` 持久化到 DB |
| 分镜无图可展示 | 对照视图空白 | 降级展示原始图/占位符，加标签说明 |
| 用户选模型但未配 Key | 生成失败报错 | 步骤①②④ 展示配置状态，未配置的模型灰色不可选 |
| 时长与分镜数不匹配 | 脚本质量差 | Prompt 中根据比例自动调整，必要时生成结束后提示 |
| Gemini 返回非 JSON | 解析失败 | 加强 JSON 提取容错（strip markdown fence、trim、retry） |
| 不同模型输出长度差异 | 脚本截断或过短 | 每个模型设置正确的 max_tokens |
| 多个分镜组的 `shotIndex` 重复 | 脚本和图片错配 | 生成前必须选择 `shotSetId`，输出和导出使用 `shotId` 关联 |
| 重构后 Gemini 代理不可用 | 现有用户配置失效 | 保留 `GEMINI_API_STYLE`，Gemini 同时支持 native / OpenAI-compatible |
| AI 返回合法 JSON 但字段无效 | 前端展示异常或导出错配 | 保存前做 schema 校验、shotId 校验、字段归一化 |
| 脚本模型配置入口割裂 | 用户不知道去哪里配置 Key | 第一阶段明确 `.env.local`，后续纳入 Settings 或统一 provider 表 |

---

## 十一、实施计划

| 阶段 | 内容 | 预估文件数 |
|---|---|---|
| **A. Provider 重构** | 拆出 openai-compatible.ts，建 index 注册表，支持 Qwen/Kimi/GPT | 4 文件 |
| **B. DB 变更** | 加 sellingPointAnalysisJson 字段；同步新库 schema、旧库 migration、PATCH 白名单 | 2 文件 |
| **C. API 改造** | 加 action=analyze/generate，/models 端点，持久化分析结果，按 shotSetId 加载分镜 | 1-2 文件 |
| **D. Prompt 工程** | 7 模版叙事指令，平台适配，分析/生成两个 prompt，时长控制，输出校验归一化 | 集中在 step D |
| **E. 前端组件** | ScriptPanel 拆分为 7 个组件，四步 UI，图文对照，模版选择器 | ~7 文件 |
| **F. 集成测试** | 端到端验证：输入卖点→分析→选择分镜组→生成→审阅→复制；覆盖多个 shot set 的错配防护 | 手动 |

---

## 十二、未决问题

1. **卖点分析的缓存策略**：相同卖点+人群+平台是否自动复用上次分析结果？建议先不做缓存，保持简单。
2. **模版是否允许用户自定义**：7 个模版是内置（hardcode）还是存 DB 可编辑？建议先内置，后续可扩展。
3. **是否需要流式输出**：生成脚本时是否需要 SSE 流式展示？建议先不做，30s 以内脚本生成通常 <10 秒。
4. **模型配置是否需要迁移到 Settings 页面**：当前图片/视频供应商在 Settings 配置，脚本模型是否也统一？建议 v2 第一阶段先用环境变量并在 UI 明确提示，后续统一。
5. **脚本生成入口选择哪个分镜组**：建议在步骤③前必须选择一个 `shotSetId`；如果项目只有一个分镜组，可自动选中。
