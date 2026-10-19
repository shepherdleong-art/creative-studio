# 脚本主导编排（Script-Driven Arrangement）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute one task at a time, run that task's verification commands, and stop for review before starting the next. Do not reinterpret the locked decisions in §"Locked Decisions".

**Goal:** 让脚本生成（第 3 步）**看着真实分镜图**写文案、挑图、排序，并让成片包装（第 5 步）**消费这份计划**而不是自己用 AI 重新发明一个顺序。

**Architecture:** 脚本生成改为多模态调用（把分镜图作为 image part 直接发给 LLM），输出 `version: 2` 的 `segments[]`（一句话 ↔ 一张图，数组顺序即成片顺序）+ `droppedShots[]`（备用池）。成片包装的 `prepare-draft` 读这份计划，逐句 TTS 拿真实时长，然后用一个**确定性**函数把 `segments` 映射成 `ArrangementPlan`（素材缺失时从备用池替补），交给几乎不动的 `solve-timeline.ts` 精算秒数。三个 LLM 步骤（重新切句 / 识图 / AI 编排）整个删除。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、better-sqlite3、Node 22 原生 TypeScript 测试（`node scripts/x.test.ts`，**没有** `npm test`）、FFmpeg/FFprobe、ASS 字幕。

**先读 spec：** `docs/superpowers/specs/2026-07-12-script-driven-arrangement-design.md`。本计划是它的执行分解，不重复论证，只给动作。

---

## Locked Decisions（不得在实现中自行改写）

1. **一句口播 = 一张画面 = 一段视频。** 段时长 = 该句 TTS 的真实时长。
2. **没有 `maxClipSeconds` 上限**（narration 路径）。**没有 beat 窗口切分。没有 `groupId`。没有慢放。**
3. **素材比句子短** → 下一张图提前顶上（`solve-timeline.ts` 现有的 `clip_short_borrowed_forward` + gap 机制，**不写新代码**）。
4. **画面用完口播还没完** → 末段定格（现有 `tpad=stop_mode=clone`，**保持原样**）。
5. **计划里的图缺席** → 从 `droppedShots` 备用池替补 + warning；备用池空了 → 该 beat 进 `gaps`（由邻近画面覆盖）+ warning。**绝不硬失败。**
6. **分镜图被重生成过**（`imageAssetId` 不匹配）→ **只发 warning，绝不阻断**。
7. **纯 BGM 模式行为不变**（手选 `selectedClipIds`，画面上限仍是 4 秒）。
8. **脚本供应商四家全留**（Gemini/Qwen/Kimi/GPT），不筛选、不删除。
9. **不重新设计成片包装界面**——只删掉因步骤消失而失效的字段。时间轴编辑器是 Round 2。

## 三处 spec 未定 / 冲突，本计划的裁决

执行者按本节执行，**不要**回去按 spec 字面理解：

| # | 冲突 | 裁决 |
|---|---|---|
| 1 | spec §7 要删 `maxClipSeconds` 配置，但 spec §3 又说 BGM「一行不改」，而 `solve-bgm-timeline.ts:57` 读 `input.maxClipSeconds` | **从 `PackageConfig` 删除 `maxClipSeconds`；`solve-bgm-timeline.ts` 改用模块常量 `const BGM_MAX_CLIP_SECONDS = 4`。** BGM 行为**逐位不变**——它本来就写着 `Math.min(input.maxClipSeconds, 4)`，默认值就是 4，恒等于常量 4。 |
| 2 | 快照格式变了（beat 丢 `groupId`、config 丢 `maxClipSeconds`），旧的 `final_video_jobs` 行怎么办 | **`solverVersion` 从 2 升到 3。** 沿用已有的 v1→v2 先例：渲染队列/重试/详情路由的 `solverVersion` 门禁全部 `2` → `3`，旧的 v2 任务变成只读历史记录（和现存的 v1 任务一样），**不迁移、不重渲染**。 |
| 3 | `stage` 有 SQLite CHECK 约束（`db.ts:362`）含 `narration-ready`/`describing`/`arranging` | **不改 CHECK 约束**（它是超集，允许新代码只写子集）。只收窄 TS 类型为 `'draft' \| 'preparing' \| 'review' \| 'failed'`。**已确认 `final_video_drafts` 表当前为空**，无存量行会因收窄而解析失败。 |

## File Structure

### 新建

| 文件 | 职责 |
|---|---|
| `lib/final-video/script-plan.ts` | 读 `script_drafts.outputJson` → `ScriptPlanSegment[]`。含 v2 解析 + 旧格式形状适配。纯函数（除一次 DB 读）。 |
| `lib/final-video/build-arrangement.ts` | `segments + beats + clipPool` → `ArrangementPlan + TimelineIssue[]`。确定性，无 LLM。含备用池替补 + 过期检测。 |
| `scripts/final-video-script-plan.test.ts` | 上者的测试 |
| `scripts/final-video-build-arrangement.test.ts` | 上者的测试 |

### 删除

| 文件 | 理由 |
|---|---|
| `lib/final-video/orchestrate.ts` | AI 编排——顺序已由脚本决定 |
| `lib/final-video/vision.ts` | 识图——脚本已看过图 |
| `lib/final-video/narration-script.ts` | LLM 重新切句——脚本已一句一图分好 |
| `app/api/final-video-drafts/[id]/describe/route.ts` | `vision.ts` 的入口 |
| `app/api/final-video-drafts/[id]/arrange/route.ts` | `orchestrate.ts` 的入口 |
| `scripts/final-video-orchestrate.test.ts` | 测已删除的模块 |
| `scripts/final-video-vision.test.ts` | 同上 |
| `scripts/final-video-narration-script.test.ts` | 同上 |
| `scripts/final-video-describe-api.test.ts` | 测已删除的路由 |
| `scripts/final-video-arrange-api.test.ts` | 同上 |

### 修改

`lib/script-providers/{types,openai-compatible,gemini,index}.ts`、`app/api/projects/[id]/script/route.ts`、`components/{ScriptPanel,ScriptResultView,ShotSetPanel,FinalVideoPanel}.tsx`、`app/api/projects/[id]/creative-package/route.ts`、`lib/final-video/{types,tts,subtitles,solve-timeline,solve-bgm-timeline,arrangement,prepare-draft,draft-api,draft-store,render-queue,submit-job}.ts`、`app/api/final-video-drafts/[id]/route.ts`、`app/api/final-video-jobs/[id]/{route,retry/route}.ts`

---

# Phase A — 脚本生成（第 3 步）

## Task A1: 脚本输出的新契约类型

**Files:**
- Modify: `lib/script-providers/types.ts:37-94`

- [ ] **Step 1: 改写 `ShotContext` / `ScriptInput` / `ScriptOutput`**

替换 `lib/script-providers/types.ts` 第 37–94 行（从 `export interface ShotContext` 到 `ProviderScriptResult` 结束）为：

```ts
/** 一张候选分镜图，连同它的真实像素（base64）一起发给多模态模型。 */
export interface ShotContext {
  shotId: string;
  shotIndex: number;
  sourceFilename: string;
  /** 模型实际看到的那张图（= 将来做成视频的那张）。 */
  imageAssetId: string;
  mimeType: string;
  imageBase64: string;
}

export interface ScriptInput {
  projectName: string;
  productName: string;
  productCode: string;
  productCategory: string;
  targetAudience: string;
  tone: string;
  platform: string;
  selectedSellingPoints: SelectedSellingPoint[];
  templateId: string;
  templateName: string;
  /** 取代旧的自由文本 duration。成片目标时长的唯一来源。 */
  targetDurationSec: number;
  shotSetId: string;
  shots: ShotContext[];
  sceneReference?: string;
  videoTemplates?: string[];
}

/** 一句口播 ↔ 一张画面。数组顺序 = 叙事顺序 = 成片画面顺序。 */
export interface ScriptSegment {
  shotId: string;
  /** 写作时看的那张图，用于下游过期检测。 */
  imageAssetId: string;
  narration: string;
  subtitle: string;
  /** 为什么选这张图 / 这张图里有什么。取代旧的 visualIntent（那是凭空编的）。 */
  rationale: string;
}

/** 没被选中的分镜 = 备用池，供成片阶段替补缺失素材。 */
export interface DroppedShot {
  shotId: string;
  reason: string;
}

export interface SellingPointMapEntry {
  shotId: string;
  sellingPoint: string;
}

export interface ScriptOutput {
  version: 2;
  title: string;
  platform: string;
  tone: string;
  targetDurationSec: number;
  template: string;
  shotSetId: string;
  sellingPointMap: SellingPointMapEntry[];
  segments: ScriptSegment[];
  droppedShots: DroppedShot[];
  /** 各 segment narration 的拼接（派生字段）。 */
  fullScript: string;
}

export interface ProviderScriptResult {
  script: ScriptOutput;
  provider: string;
  model: string;
}
```

`ScriptShot` 接口**整个删除**（旧的 `shots[]` 项类型）。

- [ ] **Step 2: 同步 barrel 导出**

`lib/script-providers/index.ts` 第 32–45 行的 `export type { ... }` 里，把 `ScriptShot` 换成 `ScriptSegment` 和 `DroppedShot`：

```ts
export type {
  ProviderConfig,
  ProviderMeta,
  AnalysisInput,
  AnalysisResult,
  ScriptInput,
  ScriptOutput,
  ProviderScriptResult,
  ScriptSegment,
  DroppedShot,
  SellingPointMapEntry,
  SelectedSellingPoint,
  ShotContext,
  SellingPointRanking,
} from './types';
```

- [ ] **Step 3: 确认这一步会大面积飘红（预期行为）**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 多处报错（`script/route.ts`、`ScriptResultView.tsx`、`gemini.ts` 等仍在用 `script.shots`）。**这是预期的**——Task A2–A6 会逐个修好。**本步不提交。**

## Task A2: OpenAI 兼容适配器支持图片

**Files:**
- Modify: `lib/script-providers/openai-compatible.ts:13-84`

- [ ] **Step 1: 给 `ChatOptions` 加 images，让 `chatCompletion` 发 image part**

把 `lib/script-providers/openai-compatible.ts` 第 13–19 行的 `ChatOptions` 改为：

```ts
export interface ChatImagePart {
  mimeType: string;
  imageBase64: string;
}

export interface ChatOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
  /** 非空时，user message 变成多模态 content 数组（文本在前、图片在后）。 */
  images?: ChatImagePart[];
}
```

然后把第 45–53 行的 `body` 构造改为：

```ts
  const userContent = options.images?.length
    ? [
        { type: 'text', text: options.userPrompt },
        ...options.images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.imageBase64}` },
        })),
      ]
    : options.userPrompt;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? runtime?.maxTokens ?? config.maxTokens,
  };
```

其余（`response_format`、fetch、错误处理、返回）**保持不变**。

`describeImageOpenAiCompatible`（第 93–150 行）**保持不动**——它马上会随 `vision.ts` 一起删（Task B6），现在删会破坏编译。

- [ ] **Step 2: 提交**

```bash
git add lib/script-providers/openai-compatible.ts
git commit -m "feat(script): send image parts through openai-compatible chat"
```

## Task A3: Gemini 适配器支持图片

**Files:**
- Modify: `lib/script-providers/gemini.ts:84-127,187-209`

- [ ] **Step 1: `geminiNativeCall` 接受 images**

把 `lib/script-providers/gemini.ts` 第 84–109 行（函数签名到 `body: JSON.stringify({...})` 的 `contents`）改为：

```ts
async function geminiNativeCall(
  prompt: string,
  runtime?: ScriptProviderRuntimeConfig,
  options?: { temperature?: number; maxTokens?: number; images?: Array<{ mimeType: string; imageBase64: string }> }
): Promise<string> {
  const baseUrl = (runtime?.baseUrl || geminiConfig.defaultBaseUrl).replace(/\/$/, '');
  const apiKey = runtime?.apiKey;
  const model = runtime?.model || geminiConfig.defaultModel;

  if (!apiKey) {
    throw new Error('Gemini API Key 未配置。请在供应商配置页填写。');
  }

  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of options?.images ?? []) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.imageBase64 } });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? runtime?.maxTokens ?? geminiConfig.maxTokens,
      },
    }),
  });
```

（`if (!res.ok)` 及之后**不变**。）

- [ ] **Step 2: `geminiCall` 透传 images**

把第 187–209 行的 `geminiCall` 改为：

```ts
async function geminiCall(
  systemPrompt: string,
  userPrompt: string,
  responseFormat: 'json_object' | 'text' = 'json_object',
  runtime?: ScriptProviderRuntimeConfig,
  options?: { temperature?: number; maxTokens?: number; images?: Array<{ mimeType: string; imageBase64: string }> }
): Promise<string> {
  const apiStyle = getApiStyle(runtime);

  if (apiStyle === 'openai-compatible') {
    return chatCompletion(geminiConfig, {
      systemPrompt,
      userPrompt,
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? runtime?.maxTokens ?? geminiConfig.maxTokens,
      responseFormat,
      images: options?.images,
    }, runtime);
  }

  // Native path: combine system + user into a single prompt (Gemini native doesn't have system role)
  const combined = `${systemPrompt}\n\n${userPrompt}`;
  return geminiNativeCall(combined, runtime, options);
}
```

- [ ] **Step 3: `geminiGenerateScript` 传图并去掉旧的 fullScript 兜底**

把第 221–234 行的 `geminiGenerateScript` 改为：

```ts
export async function geminiGenerateScript(input: ScriptInput, runtime?: ScriptProviderRuntimeConfig): Promise<ProviderScriptResult> {
  const systemPrompt = 'You are a professional e-commerce short-video scriptwriter. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildScriptPrompt(input);

  const rawText = await geminiCall(systemPrompt, userPrompt, 'json_object', runtime, {
    images: input.shots.map((shot) => ({ mimeType: shot.mimeType, imageBase64: shot.imageBase64 })),
  });
  const script = parseJsonResponse<ScriptOutput>(rawText, 'Gemini');

  return { script, provider: 'gemini', model: runtime?.model || getGeminiModel() };
}
```

（`fullScript` 的兜底移到路由的归一化里统一做，见 Task A5。）

- [ ] **Step 4: 提交**

```bash
git add lib/script-providers/gemini.ts
git commit -m "feat(script): send inline image parts through gemini"
```

## Task A4: 新的脚本提示词

**Files:**
- Modify: `lib/script-providers/openai-compatible.ts:236-306`
- Modify: `lib/script-providers/index.ts:117-150`

- [ ] **Step 1: 重写 `buildScriptPrompt`**

把 `openai-compatible.ts` 第 236–306 行的 `buildScriptPrompt` 整个替换为：

```ts
export function buildScriptPrompt(input: ScriptInput): string {
  const sellingPointsText = input.selectedSellingPoints
    .map((sp, i) => `${i + 1}. ${sp.title}（优先级：${sp.priority}，理由：${sp.reason}）`)
    .join('\n');

  // 图片按此顺序作为 image part 附在本 prompt 之后，与这里的编号一一对应。
  const shotsText = input.shots
    .map((s, i) => `图 ${i + 1}（shotId=${s.shotId}）`)
    .join('\n');

  return `你是一个专业电商短视频脚本策划。本条消息附带了 ${input.shots.length} 张候选分镜图，请**看图**写一条约 ${input.targetDurationSec} 秒的短视频口播脚本。

## 产品信息
- 项目名称：${input.projectName}
- 产品名称：${input.productName || '未填写'}
- 产品编号：${input.productCode || '未填写'}
- 品类：${input.productCategory || '未填写'}
- 目标人群：${input.targetAudience || '未填写'}
- 语气：${input.tone || '种草'}
- 平台：${input.platform || '通用'}
- 目标时长：${input.targetDurationSec} 秒

## 脚本模版：${input.templateName}
${getTemplateInstruction(input.templateId)}

## 选中的重点卖点
${sellingPointsText}

## 候选分镜图（顺序与附带的图片一一对应）
${shotsText}

## 场景参考
${input.sceneReference || '未指定'}

## 运镜模板
${input.videoTemplates?.join('、') || '未指定'}

## 你的任务
1. **看清楚每张图里到底有什么**（主体、材质、工艺细节、使用场景、画面强调了什么）。
2. **挑选**你真正需要的图，**决定它们的先后顺序**，组成一条有叙事的片子。
3. 为**每一张选中的图**写**一句**口播，这句话必须描述**这张图里真实存在的东西**。

## 硬性规则
- **一句口播 = 一张图。** segments 数组的顺序就是成片的画面顺序。
- **文案优先，不要为了用满图而硬凑。** 目标时长决定你写多少句：约 ${input.targetDurationSec} 秒，每句约 5 秒（约 25 个中文字），所以大约需要 ${Math.max(1, Math.round(input.targetDurationSec / 5))} 句、也就是 ${Math.max(1, Math.round(input.targetDurationSec / 5))} 张图。
- **没被你选中的图不会浪费**——它们会成为备用素材，用于替补生成失败的画面。所以**该舍就舍**。
- **绝对不要写图里没有的东西。** 你看不到的卖点，就不要写进口播。
- 每张选中的图必须给 rationale；每张丢弃的图必须给 reason。
- 每个 shotId 只能出现一次（要么在 segments，要么在 droppedShots）。

## 输出要求
请返回严格 JSON 格式（不要 markdown 代码块），结构如下：

{
  "version": 2,
  "title": "脚本标题",
  "platform": "${input.platform || '通用'}",
  "tone": "${input.tone || '种草'}",
  "targetDurationSec": ${input.targetDurationSec},
  "template": "${input.templateName}",
  "shotSetId": "${input.shotSetId}",
  "sellingPointMap": [
    { "shotId": "对应分镜的shotId", "sellingPoint": "本段对应的卖点标题" }
  ],
  "segments": [
    {
      "shotId": "这一段展示哪张图的shotId",
      "narration": "一句口播，约25字，描述这张图里真实存在的东西",
      "subtitle": "字幕文案，通常与 narration 相同",
      "rationale": "这张图里有什么，以及我为什么在这个位置用它"
    }
  ],
  "droppedShots": [
    { "shotId": "没选用的shotId", "reason": "为什么不用它" }
  ],
  "fullScript": "各句 narration 的拼接，纯文本，中文标点，不要换行符或 markdown"
}

## 注意事项
- 卖点要自然融入口播，不要像读说明书。使用模版 "${input.templateName}" 的叙事结构。
- 只返回 JSON，不要有其他内容。`;
}
```

**注意：** `ScriptSegment` 里有 `imageAssetId`，但**不要求模型输出它**——模型只给 `shotId`，服务端按 `shotId` 回填 `imageAssetId`（见 Task A5）。这样模型少一件事做错。

- [ ] **Step 2: `generateScript` 传图并去掉旧兜底**

把 `lib/script-providers/index.ts` 第 117–150 行的 `generateScript` 改为：

```ts
export async function generateScript(
  input: ScriptInput,
  providerId: string
): Promise<ProviderScriptResult> {
  checkConfigured(providerId);
  const runtime = resolveStoredScriptProvider(providerId);

  const systemPrompt =
    'You are a professional e-commerce short-video scriptwriter. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildScriptPrompt(input);

  if (providerId === 'gemini') {
    return geminiGenerateScript(input, runtime);
  }

  const config = resolveConfig(providerId);

  const rawText = await chatCompletion(config, {
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: runtime.maxTokens,
    responseFormat: 'json_object',
    images: input.shots.map((shot) => ({ mimeType: shot.mimeType, imageBase64: shot.imageBase64 })),
  }, runtime);

  const script = parseJsonResponse<ScriptOutput>(rawText, config.name);

  return { script, provider: providerId, model: runtime.model };
}
```

- [ ] **Step 3: 提交**

```bash
git add lib/script-providers/
git commit -m "feat(script): rewrite prompt to see images, select and order shots"
```

## Task A5: 脚本路由 —— 读图、目标时长、新校验

**Files:**
- Modify: `app/api/projects/[id]/script/route.ts`
- Test: `scripts/script-workflow.test.ts`（已存在，需按新契约更新）

- [ ] **Step 1: 写失败的测试**

在 `scripts/script-workflow.test.ts` **末尾追加**（保留文件已有内容）：

```ts
// ── v2 归一化：不再强制 1:1，选子集 + 未选进 droppedShots ──
{
  const { normalizeScriptOutput } = await import('../app/api/projects/[id]/script/normalize.ts');

  const shotRows = [
    { shotId: 's1', indexNum: 1, imageAssetId: 'img1' },
    { shotId: 's2', indexNum: 2, imageAssetId: 'img2' },
    { shotId: 's3', indexNum: 3, imageAssetId: 'img3' },
  ];

  // 模型只选了 2 张（s3 在前、s1 在后），s2 没提到
  const raw = {
    title: 'T',
    segments: [
      { shotId: 's3', narration: '句A', subtitle: '字A', rationale: '理由A' },
      { shotId: 's1', narration: '句B', subtitle: '字B', rationale: '理由B' },
    ],
    droppedShots: [],
  };

  const script = normalizeScriptOutput(raw, shotRows, 'set-1', 20);

  assert.equal(script.version, 2);
  // 顺序保持模型给的叙事顺序，不被强制成 indexNum 序
  assert.deepEqual(script.segments.map((s) => s.shotId), ['s3', 's1']);
  // imageAssetId 由服务端按 shotId 回填
  assert.deepEqual(script.segments.map((s) => s.imageAssetId), ['img3', 'img1']);
  // 未提及的 s2 自动补进 droppedShots
  assert.deepEqual(script.droppedShots.map((d) => d.shotId), ['s2']);
  // fullScript 由 narration 派生
  assert.equal(script.fullScript, '句A句B');
  assert.equal(script.targetDurationSec, 20);
}

// ── v2 归一化：非法 shotId 丢弃、重复 shotId 去重 ──
{
  const { normalizeScriptOutput } = await import('../app/api/projects/[id]/script/normalize.ts');
  const shotRows = [{ shotId: 's1', indexNum: 1, imageAssetId: 'img1' }];

  const script = normalizeScriptOutput({
    segments: [
      { shotId: 'BOGUS', narration: '不该活下来', subtitle: '', rationale: '' },
      { shotId: 's1', narration: '句A', subtitle: '', rationale: '' },
      { shotId: 's1', narration: '重复的', subtitle: '', rationale: '' },
    ],
    droppedShots: [],
  }, shotRows, 'set-1', 15);

  assert.deepEqual(script.segments.map((s) => s.shotId), ['s1']);
  assert.equal(script.segments[0].subtitle, '句A'); // subtitle 缺省回落到 narration
}

// ── v2 归一化：segments 全空要抛错（不能静默产出空片子）──
{
  const { normalizeScriptOutput } = await import('../app/api/projects/[id]/script/normalize.ts');
  assert.throws(
    () => normalizeScriptOutput({ segments: [], droppedShots: [] }, [{ shotId: 's1', indexNum: 1, imageAssetId: 'img1' }], 'set-1', 15),
    /没有产出任何画面/,
  );
}

console.log('script-workflow v2 normalization: OK');
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/script-workflow.test.ts`
Expected: FAIL —— `Cannot find module '.../script/normalize.ts'`

- [ ] **Step 3: 新建归一化模块**

Create `app/api/projects/[id]/script/normalize.ts`：

```ts
import type { ScriptOutput, ScriptSegment, DroppedShot, SellingPointMapEntry } from '@/lib/script-providers';

export interface NormalizeShotRow {
  shotId: string;
  indexNum: number;
  /** 模型实际看到的那张图（latestGeneratedImageId ?? sourceImageId）。 */
  imageAssetId: string;
}

type Raw = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 把模型输出收敛成可信的 v2 契约。
 *
 * 与旧版的关键差异：**不再强制 segments 数量等于分镜数**。模型选子集是设计要求，
 * 不是错误。这里只保证：shotId 合法、不重复、有 narration；未被 segments 提及的
 * 分镜一律补进 droppedShots（备用池），使 segments ∪ droppedShots 覆盖全部候选。
 */
export function normalizeScriptOutput(
  raw: unknown,
  shotRows: NormalizeShotRow[],
  fallbackShotSetId: string,
  targetDurationSec: number,
): ScriptOutput {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const imageByShotId = new Map(shotRows.map((row) => [row.shotId, row.imageAssetId]));

  const rawSegments = Array.isArray(source.segments) ? source.segments : [];
  const segments: ScriptSegment[] = [];
  const usedShotIds = new Set<string>();

  for (const item of rawSegments) {
    const entry = (item && typeof item === 'object' ? item : {}) as Raw;
    const shotId = str(entry.shotId);
    const narration = str(entry.narration);
    // 幻觉出来的 shotId、重复引用、空口播 —— 一律丢弃，绝不猜测模型的本意。
    if (!imageByShotId.has(shotId) || usedShotIds.has(shotId) || !narration) continue;
    usedShotIds.add(shotId);
    segments.push({
      shotId,
      imageAssetId: imageByShotId.get(shotId) as string,
      narration,
      subtitle: str(entry.subtitle) || narration,
      rationale: str(entry.rationale),
    });
  }

  if (segments.length === 0) {
    throw new Error('脚本没有产出任何画面段落（segments 为空）');
  }

  const rawDropped = Array.isArray(source.droppedShots) ? source.droppedShots : [];
  const droppedReasons = new Map<string, string>();
  for (const item of rawDropped) {
    const entry = (item && typeof item === 'object' ? item : {}) as Raw;
    const shotId = str(entry.shotId);
    if (!imageByShotId.has(shotId) || usedShotIds.has(shotId)) continue;
    droppedReasons.set(shotId, str(entry.reason) || '未说明原因');
  }
  // 模型漏提的分镜也必须落进备用池，否则成片阶段无从替补。
  const droppedShots: DroppedShot[] = shotRows
    .filter((row) => !usedShotIds.has(row.shotId))
    .map((row) => ({
      shotId: row.shotId,
      reason: droppedReasons.get(row.shotId) || '脚本未使用',
    }));

  const rawMap = Array.isArray(source.sellingPointMap) ? source.sellingPointMap : [];
  const sellingPointMap: SellingPointMapEntry[] = rawMap
    .map((item) => (item && typeof item === 'object' ? item : {}) as Raw)
    .filter((entry) => usedShotIds.has(str(entry.shotId)))
    .map((entry) => ({ shotId: str(entry.shotId), sellingPoint: str(entry.sellingPoint) }));

  const fullScript = str(source.fullScript) || segments.map((s) => s.narration).join('');

  return {
    version: 2,
    title: str(source.title) || '未命名脚本',
    platform: str(source.platform) || '通用',
    tone: str(source.tone) || '种草',
    targetDurationSec,
    template: str(source.template),
    shotSetId: str(source.shotSetId) || fallbackShotSetId,
    sellingPointMap,
    segments,
    droppedShots,
    fullScript,
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node scripts/script-workflow.test.ts`
Expected: PASS，末行 `script-workflow v2 normalization: OK`

- [ ] **Step 5: 路由改为读图 + 用新归一化**

在 `app/api/projects/[id]/script/route.ts` 顶部的 import 区加上：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { normalizeScriptOutput, type NormalizeShotRow } from './normalize';
```

并把 `import type { ... }` 里的 `ScriptOutput, SellingPointMapEntry, ScriptShot` 删掉（只保留 `AnalysisInput, ScriptInput, SelectedSellingPoint, ShotContext`）。

把 `handleGenerate` 里第 149–175 行（`const shotRows = ...` 到 `}));`）替换为：

```ts
  // 取模型该看的那张图：优先第 2 步生成的新分镜图，回退导入的原图。
  // 这与 app/api/shot-sets/[id]/video-jobs/route.ts:48 的取图逻辑一致 ——
  // 脚本看到的必须就是将来被做成视频的那一张。
  const shotRows = db.prepare(`
    SELECT s.id as shotId, s.indexNum,
           COALESCE(s.latestGeneratedImageId, s.sourceImageId) as imageAssetId,
           ia.path as imagePath, ia.filename as sourceFilename
    FROM shots s
    JOIN shot_sets ss ON ss.id = s.shotSetId
    JOIN image_assets ia ON ia.id = COALESCE(s.latestGeneratedImageId, s.sourceImageId)
    WHERE ss.projectId = ? AND ss.id = ?
    ORDER BY s.indexNum
  `).all(projectId, shotSetId) as Array<{
    shotId: string;
    indexNum: number;
    imageAssetId: string;
    imagePath: string;
    sourceFilename: string;
  }>;

  if (shotRows.length === 0) {
    return NextResponse.json({ error: '所选分镜组中没有分镜' }, { status: 400 });
  }

  const mimeByExt: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  };

  const shots: ShotContext[] = [];
  for (const row of shotRows) {
    if (!fs.existsSync(row.imagePath)) continue; // 图文件丢了的分镜进不了候选
    shots.push({
      shotId: row.shotId,
      shotIndex: row.indexNum,
      sourceFilename: row.sourceFilename,
      imageAssetId: row.imageAssetId,
      mimeType: mimeByExt[path.extname(row.imagePath).toLowerCase()] || 'image/png',
      imageBase64: fs.readFileSync(row.imagePath).toString('base64'),
    });
  }

  if (shots.length === 0) {
    return NextResponse.json({ error: '所选分镜组中没有可读取的分镜图片' }, { status: 400 });
  }
```

把第 209 行的 `const duration = ...` 替换为：

```ts
  const targetDurationSec = Number(body.targetDurationSec) > 0 ? Number(body.targetDurationSec) : 20;
```

把 `const input: ScriptInput = { ... }` 里的 `duration,` 改成 `targetDurationSec,`。

把第 234–235 行的归一化调用替换为：

```ts
  // Validate and normalize output
  const normalizeRows: NormalizeShotRow[] = shots.map((s) => ({
    shotId: s.shotId,
    indexNum: s.shotIndex,
    imageAssetId: s.imageAssetId,
  }));
  const script = normalizeScriptOutput(result.script, normalizeRows, shotSetId, targetDurationSec);
```

把 `inputSnapshot` 的 `JSON.stringify({...})` 里的 `duration,` 改成 `targetDurationSec,`。

最后**删除**第 272–350 行（`// ── Output validation & normalization ──` 到文件末尾的 `normalizeShotTitle`）——整块被 `normalize.ts` 取代。

- [ ] **Step 6: 提交**

```bash
git add app/api/projects/\[id\]/script/
git commit -m "feat(script): feed real shot images to the model, drop 1:1 shot forcing"
```

## Task A6: 脚本界面 + ZIP 导出跟上新契约

**Files:**
- Modify: `components/ScriptPanel.tsx:116`
- Modify: `components/ScriptResultView.tsx`
- Modify: `app/api/projects/[id]/creative-package/route.ts:168`
- Modify: `components/ShotSetPanel.tsx:530,548`

- [ ] **Step 1: `ScriptPanel` + `ScriptStrategyConfig` 的时长改成数字秒**

时长现在是一条**贯穿两个组件的 prop 链**（`ScriptPanel` 持有 state → 传给 `ScriptStrategyConfig` 的芯片选择器），两端都要改。

`components/ScriptPanel.tsx`：
- 第 116 行 `const [duration, setDuration] = useState('30s');` → `const [targetDurationSec, setTargetDurationSec] = useState(20);`
- 第 141 行的 snapshot 类型 `duration?: string;` → `targetDurationSec?: number;`
- 第 155 行 `if (snapshot.duration) setDuration(snapshot.duration);` → `if (snapshot.targetDurationSec) setTargetDurationSec(snapshot.targetDurationSec);`
- 第 379 行的 POST body 里 `duration,` → `targetDurationSec,`
- 第 410 行的依赖数组里 `duration` → `targetDurationSec`
- 第 567 行传给子组件的 prop：`duration={duration}` / `onDurationChange={setDuration}` → `targetDurationSec={targetDurationSec}` / `onTargetDurationSecChange={setTargetDurationSec}`

`components/ScriptStrategyConfig.tsx`：
- 第 21 行的 props 类型 `duration: string;` → `targetDurationSec: number;`，并把 `onDurationChange: (value: string) => void` 改为 `onTargetDurationSecChange: (value: number) => void`
- 第 49 行的解构同步改名
- 文件顶部的 `const DURATIONS = [...]`（现在是 `'15s'`/`'30s'` 这类字符串）改为数字秒：

```ts
const DURATIONS = [15, 20, 30, 45, 60];
```

- 第 155–170 行的芯片选择器改为：

```tsx
        <div>
          <label className="label">⏱ 目标时长（秒）</label>
          <div className="flex gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d}
                onClick={() => onTargetDurationSecChange(d)}
                className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                  targetDurationSec === d
                    ? 'bg-accent text-white'
                    : 'bg-surface-subtle text-ink-secondary hover:bg-surface'
                }`}
              >
                {d}s
              </button>
            ))}
          </div>
        </div>
```

（保留芯片式 UI，只把值从字符串换成数字秒——这是"目标时长"从第 5 步搬到第 3 步之后的**唯一入口**。）

- [ ] **Step 2: `ScriptResultView` 按 segments 渲染，并显示缩略图**

`components/ScriptResultView.tsx`：把所有 `script.shots` 改为 `script.segments`。逐项字段映射：`s.voiceover` → `s.narration`；`s.visualIntent` → `s.rationale`；**删除** `s.shotIndex`、`s.duration`、`s.title` 的所有引用。

第 45–51 行的 markdown 拼接改为：

```ts
      script.fullScript,
      '',
      '## 分段',
      ...script.segments.map((s, i) => (
        `### 第 ${i + 1} 段\n口播: ${s.narration}\n字幕: ${s.subtitle}\n画面理由: ${s.rationale}\n`
      )),
```

第 111 行起的列表渲染，每段加上**缩略图**（这是脚本能看图之后最直接的红利）：

```tsx
{script.segments.map((segment, i) => (
  <div key={segment.shotId} className="flex gap-3 rounded border border-line p-3">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src={`/api/images/${segment.imageAssetId}`}
      alt={`第 ${i + 1} 段画面`}
      className="h-20 w-20 shrink-0 rounded object-cover"
    />
    <div className="min-w-0 flex-1">
      <p className="text-xs text-ink-tertiary">第 {i + 1} 段</p>
      <p className="mt-0.5 text-sm text-ink-primary">{segment.narration}</p>
      {segment.rationale && (
        <p className="mt-1 text-xs leading-relaxed text-ink-tertiary">画面理由：{segment.rationale}</p>
      )}
    </div>
  </div>
))}
```

（图片端点是 `app/api/images/[id]/route.ts`，故 URL 为 `/api/images/{imageAssetId}`，**没有** `/file` 后缀。）

然后在 segments 列表**下方**新增备用池区块：

```tsx
{script.droppedShots.length > 0 && (
  <div className="mt-4 rounded border border-line bg-surface-secondary p-3">
    <p className="text-xs font-medium text-ink-secondary">未使用的分镜（备用素材，用于替补生成失败的画面）</p>
    <ul className="mt-1 space-y-0.5">
      {script.droppedShots.map((dropped) => (
        <li key={dropped.shotId} className="text-xs text-ink-tertiary">· {dropped.reason}</li>
      ))}
    </ul>
  </div>
)}
```

- [ ] **Step 3: ZIP 导出读 segments（含旧格式兜底）**

`app/api/projects/[id]/creative-package/route.ts` 现在靠 `shotIndex` 做关联（`shotsArr.find((ss) => ss.shotIndex === s.shotIndex)`），但 **v2 的 segments 没有 `shotIndex`，只有 `shotId`**。所以要先让 manifest 带上 `shotId`：

第 65–74 行的 `manifestShots` 类型加一个字段：

```ts
    const manifestShots: Array<{
      shotId: string;
      shotIndex: number;
      sourceImage: string;
      videos: Array<{
        filename: string;
        provider: string;
        template: string;
        prompt: string;
      }>;
      script?: { voiceover: string; subtitle: string };
    }> = [];
```

第 111–114 行的 push 补上该字段：

```ts
      manifestShots.push({
        shotId: shot.id,
        shotIndex: shot.indexNum,
        sourceImage: shotEntry || '',
        videos: manifestVideos,
      });
```

然后把第 168–179 行的整块 annotate 逻辑替换为：

```ts
        // Annotate shots with script.
        // v2：segments[] 按 shotId 关联（segments 没有 shotIndex，且顺序是叙事顺序不是分镜序）。
        // 旧草稿：shots[] 仍按 shotIndex 关联，保持原行为。
        const rawScript = scriptObj as Record<string, unknown>;
        const segmentsArr = rawScript.segments as Array<Record<string, unknown>> | undefined;
        const legacyShotsArr = rawScript.shots as Array<Record<string, unknown>> | undefined;

        for (const s of manifestShots) {
          const match = segmentsArr
            ? segmentsArr.find((ss) => ss.shotId === s.shotId)
            : legacyShotsArr?.find((ss) => ss.shotIndex === s.shotIndex);
          if (!match) continue;
          s.script = {
            voiceover: String(match.narration ?? match.voiceover ?? ''),
            subtitle: String(match.subtitle || ''),
          };
        }
```

（`shot.id` 是该循环里 shots 行的主键——若变量名不是 `shot`，按实际改。）

- [ ] **Step 4: 修正分镜面板的误导文案**

`components/ShotSetPanel.tsx` 第 530 行和第 548 行：

```tsx
// 530 行附近
选择分镜图（1-9 张，顺序无所谓）
// 548 行附近
已选 {selectedImageIds.length}/9 张，顺序由脚本决定，这里随便点
```

（旧文案说"点击顺序即为分镜顺序"——**现在这是假的**，顺序由脚本看图后决定。）

- [ ] **Step 5: 校验并提交**

Run: `npx tsc --noEmit 2>&1 | grep -E "script|Script" | head`
Expected: 无输出（脚本侧类型已自洽；`lib/final-video/**` 仍会报错，Phase B 处理）

```bash
git add components/ app/api/projects/\[id\]/creative-package/route.ts
git commit -m "feat(script): render segments with thumbnails, move target duration to script step"
```

---

# Phase B — 成片引擎（第 5 步）

> **⚠️ Phase B 中途，代码树不编译，这是正常的。**
>
> 这是一次连贯的重构：B1 改掉 beat 模型、B2 拆掉 4 秒上限的那一刻，`narration-script.ts` / `orchestrate.ts` / `prepare-draft.ts` 和 `describe`/`arrange` 两个路由就同时失效了（它们引用 `groupId`、`buildFallbackArrangement`、`maxClipSeconds`）。只有到 **B6 删完文件**才重新自洽。
>
> **这不影响你干活**，因为 Node 22 的原生 TypeScript 只做**类型擦除、不做类型检查**——`node scripts/x.test.ts` 照常能跑，每个 Task 的测试门禁都有效。已确认 B1–B5 的测试门禁**都不会 import 到那些将死的模块**。
>
> **只在 Task B6 结束时**要求 `npx tsc --noEmit` **零错误**。在那之前 tsc 报错是预期的，**不要试图去"修好"那些马上要删掉的文件**。

## Task B1: beat 模型 —— 一句 = 一 beat

**Files:**
- Modify: `lib/final-video/types.ts:29-30,53,55`
- Modify: `lib/final-video/tts.ts:137-258,279-326`
- Modify: `lib/final-video/subtitles.ts:76-145`
- Test: `scripts/final-video-tts-beats.test.ts`、`scripts/final-video-subtitles.test.ts`

- [ ] **Step 1: 写失败的测试（字幕：一句一条 Dialogue）**

把 `scripts/final-video-subtitles.test.ts` 里所有构造 beat 的地方去掉 `groupId`，并追加：

```ts
// 一句 = 一条 Dialogue（不再按 groupId 合并）
{
  const style = { enabled: true, fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 18 };
  const beats = [
    { beatId: 'b0', index: 0, text: '第一句', subtitleText: '第一句', shotId: 's1', imageAssetId: 'i1', audioPath: '/tmp/a0.m4a', durationSec: 3, startSec: 0 },
    { beatId: 'b1', index: 1, text: '第二句', subtitleText: '第二句字幕', shotId: 's2', imageAssetId: 'i2', audioPath: '/tmp/a1.m4a', durationSec: 4, startSec: 3 },
  ];
  const ass = buildNarrationAss(beats, 2, style, 1080, 1920);
  const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 2);
  // 渲染的是 subtitleText，不是 text
  assert.ok(dialogues[1].includes('第二句字幕'));
  // 起止时间含片头偏移
  assert.ok(dialogues[0].includes('0:00:02.00'));
}
console.log('subtitles one-per-beat: OK');
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/final-video-subtitles.test.ts`
Expected: FAIL（类型/断言不符）

- [ ] **Step 3: 改 beat 类型**

`lib/final-video/types.ts` 第 29–30 行替换为：

```ts
/** 一句口播。一句 = 一个 beat = 一张画面（不再切窗口，故无 groupId）。 */
export interface NarrationDraftBeat {
  beatId: string;
  index: number;
  text: string;
  /** ASS 字幕渲染用；缺省等于 text。 */
  subtitleText: string;
  /** 这一句该展示哪个分镜的画面（来自脚本的计划）。 */
  shotId: string;
  /** 脚本写作时看的那张图；用于过期检测。旧格式脚本为 null。 */
  imageAssetId: string | null;
}
export interface NarrationBeat extends NarrationDraftBeat { audioPath: string; durationSec: number; startSec: number }
```

第 53 行的 stage 类型收窄：

```ts
export type FinalVideoDraftStage = 'draft' | 'preparing' | 'review' | 'failed';
```

第 221–230 行的 `parseNarrationBeatsJson` 替换为：

```ts
export function parseNarrationBeatsJson(json: string): NarrationBeat[] {
  const value = parseJson(json, 'narrationBeatsJson');
  if (!Array.isArray(value)) throw new Error('narrationBeatsJson must be an array');
  return value.map((raw, index) => { const beat = object(raw, `narrationBeatsJson[${index}]`); const p = `narrationBeatsJson[${index}]`; return {
    beatId: string(beat.beatId, `${p}.beatId`),
    index: number(beat.index, `${p}.index`),
    text: string(beat.text, `${p}.text`),
    subtitleText: string(beat.subtitleText, `${p}.subtitleText`),
    shotId: string(beat.shotId, `${p}.shotId`),
    imageAssetId: nullableString(beat.imageAssetId, `${p}.imageAssetId`),
    audioPath: string(beat.audioPath, `${p}.audioPath`),
    durationSec: number(beat.durationSec, `${p}.durationSec`),
    startSec: number(beat.startSec, `${p}.startSec`),
  }; });
}
```

- [ ] **Step 4: TTS 去掉窗口切分**

`lib/final-video/tts.ts`：**删除** `partitionTextByDuration`（第 141–171 行）和 `safeGroupFileName`（第 137–139 行），换成：

```ts
function safeBeatFileName(beatId: string): string {
  return `beat-${createHash('sha256').update(beatId).digest('hex').slice(0, 24)}.m4a`;
}
```

把 `synthesizeNarrationBeats`（第 173–258 行）整个替换为：

```ts
/** 一句合成一次，真实音频时长即该句的段时长。不再切窗口。 */
export async function synthesizeNarrationBeats(input: {
  draftId: string;
  beats: NarrationDraftBeat[];
  providerId: string;
  voice: string;
  speed: number;
}): Promise<NarrationBeat[]> {
  requirePositiveFinite('speed', input.speed);
  if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error('beats 不能为空');
  if (!input.providerId.trim()) throw new Error('providerId 不能为空');
  if (!input.voice.trim()) throw new Error('voice 不能为空');

  const directory = narrationDirectory(input.draftId);
  const seenBeatIds = new Set<string>();
  const seenIndexes = new Set<number>();
  for (const [position, beat] of input.beats.entries()) {
    if (!beat?.beatId?.trim()) throw new Error(`beats[${position}].beatId 不能为空`);
    if (!beat.text?.trim()) throw new Error(`beats[${position}].text 不能为空`);
    if (!beat.shotId?.trim()) throw new Error(`beats[${position}].shotId 不能为空`);
    if (!Number.isInteger(beat.index) || beat.index < 0) throw new Error(`beats[${position}].index 无效`);
    if (seenBeatIds.has(beat.beatId)) throw new Error(`重复 beatId：${beat.beatId}`);
    if (seenIndexes.has(beat.index)) throw new Error(`重复 index：${beat.index}`);
    seenBeatIds.add(beat.beatId);
    seenIndexes.add(beat.index);
  }

  fs.mkdirSync(directory, { recursive: true });
  const rt = await resolveNarrationRuntime(input.providerId);
  const output: NarrationBeat[] = [];
  let startSec = 0;

  for (const draftBeat of [...input.beats].sort((a, b) => a.index - b.index)) {
    const audioPath = path.join(directory, safeBeatFileName(draftBeat.beatId));
    const rawPath = `${audioPath}.raw`;
    const { buffer, speedApplied } = await synthesizeOne(draftBeat.text.trim(), input.voice, input.speed, rt);
    fs.writeFileSync(rawPath, buffer);
    try {
      const atempo = !speedApplied && Math.abs(input.speed - 1) > 0.01
        ? ['-filter:a', atempoFilter(input.speed)]
        : [];
      await runFfmpeg(['-i', rawPath, ...atempo, '-c:a', 'aac', '-b:a', '128k', '-y', audioPath], { timeoutMs: 60_000 });
    } finally {
      fs.rmSync(rawPath, { force: true });
    }

    const durationSec = await probeDurationSec(audioPath);
    requirePositiveFinite('probed duration', durationSec);

    output.push({
      beatId: draftBeat.beatId,
      index: output.length,
      text: draftBeat.text,
      subtitleText: draftBeat.subtitleText || draftBeat.text,
      shotId: draftBeat.shotId,
      imageAssetId: draftBeat.imageAssetId,
      audioPath,
      durationSec,
      startSec,
    });
    startSec += durationSec;
  }
  return output;
}
```

把 `buildBeatNarrationTrack`（第 279–326 行）里的分组逻辑去掉——现在一 beat 一文件，直接顺序 concat：

```ts
async function buildBeatNarrationTrack(opts: BeatNarrationTrackInput): Promise<string> {
  if (!Array.isArray(opts.beats) || opts.beats.length === 0) throw new Error('beats 不能为空');
  const ordered = [...opts.beats].sort((a, b) => a.index - b.index);
  const seenBeatIds = new Set<string>();
  const seenIndexes = new Set<number>();
  let expectedStartSec = 0;
  for (const [position, beat] of ordered.entries()) {
    if (!beat.beatId?.trim() || seenBeatIds.has(beat.beatId)) throw new Error(`beats[${position}].beatId 无效或重复`);
    if (!Number.isInteger(beat.index) || seenIndexes.has(beat.index)) throw new Error(`beats[${position}].index 无效或重复`);
    seenBeatIds.add(beat.beatId);
    seenIndexes.add(beat.index);
    requirePositiveFinite(`beats[${position}].durationSec`, beat.durationSec);
    if (!Number.isFinite(beat.startSec) || beat.startSec < 0) throw new Error(`beats[${position}].startSec 无效`);
    if (Math.abs(beat.startSec - expectedStartSec) > 0.01) throw new Error('beats startSec 不连续');
    expectedStartSec += beat.durationSec;
  }

  const out = path.join(opts.workDir, 'narration.m4a');
  const args: string[] = ['-hide_banner'];
  const parts: string[] = [];
  const labels: string[] = [];
  if (opts.introDurationSec > 0) {
    parts.push(`aevalsrc=0:d=${opts.introDurationSec}:s=44100[aintro]`);
    labels.push('[aintro]');
  }
  ordered.forEach((beat, index) => {
    if (!beat.audioPath || !fs.existsSync(beat.audioPath)) throw new Error(`口播音频不存在：${beat.audioPath}`);
    args.push('-i', beat.audioPath);
    parts.push(`[${index}:a]anull[ag${index}]`);
    labels.push(`[ag${index}]`);
  });
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-y', out);
  await runFfmpeg(args, { timeoutMs: 120_000 });
  return out;
}
```

同时删除 `tts.ts` 顶部不再使用的 `TIMING_EPSILON_SEC` 常量。

- [ ] **Step 5: 字幕一句一条**

`lib/final-video/subtitles.ts` 把 `buildNarrationAss`（第 76–145 行）替换为：

```ts
/** Build one subtitle dialogue per narration sentence (one beat = one sentence). */
export function buildNarrationAss(
  beats: NarrationBeat[],
  introDurationSec: number,
  style: SubtitleStyle,
  width: number,
  height: number,
): string {
  if (!Number.isFinite(introDurationSec) || introDurationSec < 0) {
    throw new Error('introDurationSec must be finite and non-negative');
  }

  const sorted = [...beats].sort((a, b) => a.index - b.index);
  const beatIds = new Set<string>();
  for (let position = 0; position < sorted.length; position += 1) {
    const beat = sorted[position];
    if (!Number.isInteger(beat.index) || beat.index !== position) {
      throw new Error(`beat indexes must be contiguous from zero; expected ${position}, got ${beat.index}`);
    }
    if (beatIds.has(beat.beatId)) throw new Error(`duplicate beatId: ${beat.beatId}`);
    beatIds.add(beat.beatId);
    if (!Number.isFinite(beat.startSec) || beat.startSec < 0) {
      throw new Error(`beat startSec must be finite and non-negative: ${beat.beatId}`);
    }
    if (!Number.isFinite(beat.durationSec) || beat.durationSec <= 0) {
      throw new Error(`beat durationSec must be finite and positive: ${beat.beatId}`);
    }
  }

  const lines = [buildAssHeader(style, width, height)];
  if (style.enabled) {
    for (const beat of sorted) {
      const text = (beat.subtitleText || beat.text).trim();
      if (!text) continue;
      const start = assTime(introDurationSec + beat.startSec);
      const end = assTime(introDurationSec + beat.startSec + beat.durationSec);
      lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${escapeAssText(text)}`);
    }
  }
  return lines.join('\n') + '\n';
}
```

删除文件顶部不再使用的 `BEAT_TIME_TOLERANCE_SEC` 常量。

- [ ] **Step 6: 更新 TTS 测试并跑通**

`scripts/final-video-tts-beats.test.ts`：删掉所有关于「长句被切成多个窗口」「groupId 一致」「partitionTextByDuration」的断言，改为断言「N 句 → N 个 beat，每个 beat 的 durationSec = 该句 probe 出来的真实时长，startSec 连续累加」。所有构造 `NarrationDraftBeat` 的地方补上 `subtitleText`、`shotId`、`imageAssetId` 字段，去掉 `groupId`。`synthesizeNarrationBeats` 的调用去掉 `maxClipSeconds` 参数。

Run: `node scripts/final-video-subtitles.test.ts && node scripts/final-video-tts-beats.test.ts`
Expected: 两个都 PASS

- [ ] **Step 7: 提交**

```bash
git add lib/final-video/types.ts lib/final-video/tts.ts lib/final-video/subtitles.ts scripts/final-video-subtitles.test.ts scripts/final-video-tts-beats.test.ts
git commit -m "refactor(final-video): one sentence = one beat, drop groupId windowing"
```

## Task B2: 拆掉 4 秒上限

**Files:**
- Modify: `lib/final-video/types.ts:15,78,116,177`
- Modify: `lib/final-video/solve-timeline.ts:28-64,70-79,119,155,171,184-186`
- Modify: `lib/final-video/arrangement.ts`
- Modify: `lib/final-video/solve-bgm-timeline.ts:27,32,57`
- Modify: `lib/final-video/draft-api.ts:75,83`
- Modify: `lib/final-video/render-queue.ts:132,142`
- Modify: `app/api/final-video-drafts/[id]/route.ts:43`
- Test: `scripts/final-video-solve.test.ts`

- [ ] **Step 1: 写失败的测试（一句 6 秒，素材 10 秒 → 整段放 6 秒，不再被砍到 4 秒）**

在 `scripts/final-video-solve.test.ts` 的 `beat()` / `clip()` / `solve()` 帮手里去掉 `groupId` 和 `maxClipSeconds`，并追加：

```ts
// 没有 4 秒上限：一句 6 秒、素材 10 秒 → 整段就放 6 秒
result = solve({
  beats: [beat('b0', 0, 6)], clips: [clip('c0', 0, 10)],
  plan: plan([['c0', ['b0']]]), targetDurationSec: 6,
});
assert.equal(result.segments.length, 1);
assert.equal(result.segments[0].mediaDurationSec, 6);
assert.equal(result.segments[0].padStopSec, 0);
assert.ok(!codes(result).includes('last_clip_exceeds_max_after_fallback'));
console.log('solve without maxClipSeconds: OK');
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/final-video-solve.test.ts`
Expected: FAIL（当前 `mediaDurationSec` 会被 `maxClipSeconds=4` 砍到 4）

- [ ] **Step 3: 从 PackageConfig 删除 maxClipSeconds**

`lib/final-video/types.ts`：
- 第 15 行：`PackageCommonConfig` 里删掉 `maxClipSeconds: number;`
- 第 78 行：`defaultPackageConfig()` 里删掉 `maxClipSeconds: 4,`
- 第 116 行：可选数字校验列表里删掉 `'maxClipSeconds'`
- 第 177 行：`mergePackageConfigAt` 的 `common` 里删掉 `maxClipSeconds: ...` 那一行
- 第 39–42 行：`TimelineIssueCode` 删掉 `'last_clip_exceeds_max_after_fallback'`，新增两个替补/过期码：

```ts
export type TimelineIssueCode =
  | 'target_duration_out_of_tolerance' | 'arrangement_invalid'
  | 'visual_gap' | 'clip_missing' | 'clip_short_borrowed_forward' | 'last_clip_frozen'
  | 'planned_clip_substituted' | 'script_image_stale';
```

（`arrangement_fallback_used` 也删掉——AI 兜底不存在了。）

- 第 254 行的 `ISSUE_CODES` 数组同步为：

```ts
const ISSUE_CODES: TimelineIssueCode[] = ['target_duration_out_of_tolerance','arrangement_invalid','visual_gap','clip_missing','clip_short_borrowed_forward','last_clip_frozen','planned_clip_substituted','script_image_stale'];
```

（`solverVersion` 的 2→3 升级**不在本 Task**，统一放在 Task B6 Step 4 —— 那里才是快照格式定型的地方。）

- [ ] **Step 4: solve-timeline 去掉上限**

`lib/final-video/solve-timeline.ts`：
- 第 30 行、第 77 行：`validateInput` 与 `solveTimeline` 的入参类型里删掉 `maxClipSeconds: number;`
- 第 34 行：删掉 `if (!finitePositive(input.maxClipSeconds)) fail(...)`
- 第 59 行：`validateArrangement(input.plan, beats, clips, input.maxClipSeconds)` → `validateArrangement(input.plan, beats, clips)`
- 第 119 行：`let mediaDurationSec = Math.min(wanted, clip.clipDurationSec, input.maxClipSeconds);` → `let mediaDurationSec = Math.min(wanted, clip.clipDurationSec);`
- 第 155 行：`Math.min(clip.clipDurationSec, input.maxClipSeconds, contentDurationSec)` → `Math.min(clip.clipDurationSec, contentDurationSec)`
- 第 171 行：`const unusedUnderMax = Math.max(0, input.maxClipSeconds - segment.mediaDurationSec);` → **删除该行**，并把第 172 行改为 `const mediaExtension = Math.min(remaining, unusedPhysical);`
- 第 184–186 行：整块 `if (segment.segmentDurationSec - input.maxClipSeconds > SECONDS_EPSILON) { ... }` **删除**

- [ ] **Step 5: arrangement 校验去掉上限**

`lib/final-video/arrangement.ts`：
- `validateArrangement` 与 `assertValidArrangement` 的签名删掉第 4 个参数 `maxClipSeconds: number`
- 删掉 `if (!Number.isFinite(maxClipSeconds) ...)`（第 26 行）
- 删掉第 62 行 `if (exceedsDurationLimit(duration, maxClipSeconds)) return fail('编排片段时长超过单画面时长上限', ...)`；随之删掉现在没人用的 `duration` 累加（第 48、55 行）、`DURATION_EPSILON_SECONDS` 和 `exceedsDurationLimit`
- **`buildFallbackArrangement`（第 93–134 行）整个删除** —— AI 兜底不存在了，旧脚本走的是 Task B3 的形状适配，不是这里

- [ ] **Step 6: BGM 用自己的常量（行为不变）**

`lib/final-video/solve-bgm-timeline.ts`：
- 入参类型（第 27 行）删掉 `maxClipSeconds: number;`
- 第 32 行删掉 `if (!finitePositive(input.maxClipSeconds)) fail(...)`
- 第 57 行 `const maxClipSeconds = Math.min(input.maxClipSeconds, 4);` → 删除，并在文件顶部 `SECONDS_EPSILON` 旁加：

```ts
/** 纯 BGM 蒙太奇的单画面上限。narration 路径已无上限（口播定长度），BGM 没有口播，仍需要一个节奏闸门。
 *  原实现是 Math.min(config.maxClipSeconds, 4) 且 config 默认就是 4 —— 恒等于 4，故行为逐位不变。 */
const BGM_MAX_CLIP_SECONDS = 4;
```

第 63 行与第 91 行的 `maxClipSeconds` 改为 `BGM_MAX_CLIP_SECONDS`。

- [ ] **Step 7: 清理调用点**

- `lib/final-video/render-queue.ts` 第 132、142 行：删掉 `maxClipSeconds: pkg.maxClipSeconds,`
- `lib/final-video/draft-api.ts` 第 75、83 行：从 `narrationChanged` 的比较对象里删掉 `maxClipSeconds` 两行
- `app/api/final-video-drafts/[id]/route.ts` 第 43 行：删掉传给 `assertValidArrangement` 的 `workflow.packageConfig.maxClipSeconds` 参数

- [ ] **Step 8: 跑测试**

Run: `node scripts/final-video-solve.test.ts && node scripts/final-video-bgm-solve.test.ts && node scripts/final-video-types.test.ts && node scripts/final-video-arrangement.test.ts`
Expected: 全 PASS。（`final-video-arrangement.test.ts` 里所有 `validateArrangement(...)` 调用要去掉第 4 个参数，断言"超过单画面上限"的用例**删除**；`final-video-types.test.ts` 里断言 `maxClipSeconds` 和 `solverVersion: 2` 的用例改为新契约；`final-video-bgm-solve.test.ts` 的入参去掉 `maxClipSeconds`。）

- [ ] **Step 9: 提交**

```bash
git add lib/final-video/ app/api/final-video-drafts/ scripts/
git commit -m "refactor(final-video): remove the 4s clip cap from the narration path"
```

## Task B3: 读脚本的计划（含旧格式适配）

**Files:**
- Create: `lib/final-video/script-plan.ts`
- Test: `scripts/final-video-script-plan.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `scripts/final-video-script-plan.test.ts`：

```ts
import assert from 'node:assert/strict';
import { parseScriptPlan } from '../lib/final-video/script-plan.ts';

// v2：直接读 segments，保持叙事顺序
{
  const plan = parseScriptPlan(JSON.stringify({
    version: 2,
    segments: [
      { shotId: 's3', imageAssetId: 'i3', narration: '句A', subtitle: '字A', rationale: 'r3' },
      { shotId: 's1', imageAssetId: 'i1', narration: '句B', subtitle: '字B', rationale: 'r1' },
    ],
    droppedShots: [{ shotId: 's2', reason: '重复构图' }],
  }));
  assert.equal(plan.legacy, false);
  assert.deepEqual(plan.segments.map((s) => s.shotId), ['s3', 's1']);
  assert.deepEqual(plan.segments.map((s) => s.imageAssetId), ['i3', 'i1']);
  assert.equal(plan.segments[0].subtitle, '字A');
  assert.deepEqual(plan.droppedShotIds, ['s2']);
}

// 旧格式：shots[] 按原顺序读成 segments，imageAssetId 为 null（不做过期检测）
{
  const plan = parseScriptPlan(JSON.stringify({
    shots: [
      { shotId: 's1', voiceover: '老句A', subtitle: '老字A' },
      { shotId: 's2', voiceover: '老句B' },
      { shotId: 's3', voiceover: '' },   // 空口播的旧分镜要被跳过
    ],
    fullScript: '老句A老句B',
  }));
  assert.equal(plan.legacy, true);
  assert.deepEqual(plan.segments.map((s) => s.shotId), ['s1', 's2']);
  assert.deepEqual(plan.segments.map((s) => s.imageAssetId), [null, null]);
  assert.equal(plan.segments[0].subtitle, '老字A');
  assert.equal(plan.segments[1].subtitle, '老句B');  // subtitle 缺省回落到 voiceover
  assert.deepEqual(plan.droppedShotIds, []);
}

// 两种格式都没有可用句子 → 抛可辨识错误
{
  assert.throws(() => parseScriptPlan(JSON.stringify({ version: 2, segments: [] })), /脚本内容为空/);
  assert.throws(() => parseScriptPlan(JSON.stringify({ shots: [] })), /脚本内容为空/);
}

console.log('final-video script-plan: OK');
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/final-video-script-plan.test.ts`
Expected: FAIL —— `Cannot find module '../lib/final-video/script-plan.ts'`

- [ ] **Step 3: 实现**

Create `lib/final-video/script-plan.ts`：

```ts
// lib/final-video/script-plan.ts
/**
 * 把 script_drafts.outputJson 读成成片引擎要消费的「计划」。
 *
 * v2（脚本看图后产出）：segments[] 就是计划本身——数组顺序即成片画面顺序。
 * 旧格式（脚本瞎写时代）：shots[] 按 indexNum 顺序 1:1 读成 segments，imageAssetId 置 null
 *   表示"不知道当时看的是哪张图"，故不做过期检测。行为与改造前一致。
 */

export interface ScriptPlanSegment {
  shotId: string;
  /** 脚本写作时看的那张图。旧格式为 null。 */
  imageAssetId: string | null;
  narration: string;
  subtitle: string;
  rationale: string;
}

export interface ScriptPlan {
  segments: ScriptPlanSegment[];
  /** 未被使用的分镜 = 备用池，供 build-arrangement 替补缺失素材。 */
  droppedShotIds: string[];
  /** true 表示这是改造前的旧脚本，界面应提示"建议重新生成以获得看图文案"。 */
  legacy: boolean;
}

type Raw = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function invalidInputError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

export function parseScriptPlan(outputJson: string): ScriptPlan {
  // outputJson 本身是坏 JSON 时让 JSON.parse 抛出（路由回落 500）——绝不当作"空脚本"吞掉。
  const parsed = JSON.parse(outputJson) as Raw;

  if (parsed.version === 2 && Array.isArray(parsed.segments)) {
    const segments: ScriptPlanSegment[] = [];
    for (const item of parsed.segments) {
      const entry = (item && typeof item === 'object' ? item : {}) as Raw;
      const shotId = str(entry.shotId);
      const narration = str(entry.narration);
      if (!shotId || !narration) continue;
      segments.push({
        shotId,
        imageAssetId: str(entry.imageAssetId) || null,
        narration,
        subtitle: str(entry.subtitle) || narration,
        rationale: str(entry.rationale),
      });
    }
    if (segments.length === 0) throw invalidInputError('脚本内容为空，无法生成口播');

    const dropped = Array.isArray(parsed.droppedShots) ? parsed.droppedShots : [];
    const droppedShotIds = dropped
      .map((item) => str(((item && typeof item === 'object' ? item : {}) as Raw).shotId))
      .filter(Boolean);

    return { segments, droppedShotIds, legacy: false };
  }

  // ── 旧格式形状适配 ──
  const shots = Array.isArray(parsed.shots) ? parsed.shots : [];
  const segments: ScriptPlanSegment[] = [];
  for (const item of shots) {
    const entry = (item && typeof item === 'object' ? item : {}) as Raw;
    const shotId = str(entry.shotId);
    const narration = str(entry.voiceover);
    if (!shotId || !narration) continue;
    segments.push({
      shotId,
      imageAssetId: null,
      narration,
      subtitle: str(entry.subtitle) || narration,
      rationale: str(entry.visualIntent),
    });
  }
  if (segments.length === 0) throw invalidInputError('脚本内容为空，无法生成口播');

  return { segments, droppedShotIds: [], legacy: true };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node scripts/final-video-script-plan.test.ts`
Expected: PASS，`final-video script-plan: OK`

- [ ] **Step 5: 提交**

```bash
git add lib/final-video/script-plan.ts scripts/final-video-script-plan.test.ts
git commit -m "feat(final-video): read the script's picture plan, with legacy adapter"
```

## Task B4: 确定性编排（计划 → ArrangementPlan）

**Files:**
- Create: `lib/final-video/build-arrangement.ts`
- Test: `scripts/final-video-build-arrangement.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `scripts/final-video-build-arrangement.test.ts`：

```ts
import assert from 'node:assert/strict';
import { buildPlanArrangement } from '../lib/final-video/build-arrangement.ts';
import type { ClipPoolItem, NarrationBeat } from '../lib/final-video/types.ts';

const beat = (beatId: string, index: number, shotId: string, imageAssetId: string | null = null): NarrationBeat => ({
  beatId, index, text: beatId, subtitleText: beatId, shotId, imageAssetId,
  audioPath: `/tmp/${beatId}.m4a`, durationSec: 3, startSec: index * 3,
});
const clip = (clipId: string, shotId: string, shotIndex: number, sourceImageId = `i-${shotId}`): ClipPoolItem => ({
  clipId, shotId, shotIndex, videoPath: `/tmp/${clipId}.mp4`, clipDurationSec: 5,
  sourceImageId, sourceImagePath: `/tmp/${clipId}.png`,
});
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

// 素材齐全：每句拿到自己那张图，顺序 = 脚本顺序
{
  const beats = [beat('b0', 0, 's3'), beat('b1', 1, 's1')];
  const clips = [clip('c1', 's1', 1), clip('c2', 's2', 2), clip('c3', 's3', 3)];
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: ['s2'] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c3', 'c1']);
  assert.deepEqual(plan.assignments.map((a) => a.beatIds), [['b0'], ['b1']]);
  assert.deepEqual(plan.gaps, []);
  assert.deepEqual(issues, []);
}

// 计划里的素材缺席 → 从备用池替补 + warning
{
  const beats = [beat('b0', 0, 's1'), beat('b1', 1, 's9')];   // s9 没视频
  const clips = [clip('c1', 's1', 1), clip('c2', 's2', 2)];   // s2 是备用
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: ['s2'] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1', 'c2']);
  assert.deepEqual(plan.gaps, []);
  assert.ok(codes(issues).includes('planned_clip_substituted'));
}

// 素材缺席且备用池已空 → 该句进 gaps（由邻近画面覆盖），绝不失败
{
  const beats = [beat('b0', 0, 's1'), beat('b1', 1, 's9')];
  const clips = [clip('c1', 's1', 1)];
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1']);
  assert.deepEqual(plan.gaps.map((g) => g.beatId), ['b1']);
  assert.ok(codes(issues).includes('planned_clip_substituted'));
}

// 分镜图在写完脚本后被重生成过 → 软提醒，不阻断
{
  const beats = [beat('b0', 0, 's1', 'OLD-IMG')];
  const clips = [clip('c1', 's1', 1, 'NEW-IMG')];
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1']);   // 照常出片
  assert.ok(codes(issues).includes('script_image_stale'));
}

// 旧脚本 imageAssetId 为 null → 不做过期检测，不告警
{
  const beats = [beat('b0', 0, 's1', null)];
  const clips = [clip('c1', 's1', 1, 'ANY')];
  const { issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.ok(!codes(issues).includes('script_image_stale'));
}

// 一张备用图只能替补一次（不能重复使用同一 clip）
{
  const beats = [beat('b0', 0, 's8'), beat('b1', 1, 's9')];
  const clips = [clip('c1', 's1', 1)];
  const { plan } = buildPlanArrangement({ beats, clips, droppedShotIds: ['s1'] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1']);
  assert.deepEqual(plan.gaps.map((g) => g.beatId), ['b1']);
}

console.log('final-video build-arrangement: OK');
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/final-video-build-arrangement.test.ts`
Expected: FAIL —— `Cannot find module '../lib/final-video/build-arrangement.ts'`

- [ ] **Step 3: 实现**

Create `lib/final-video/build-arrangement.ts`：

```ts
// lib/final-video/build-arrangement.ts
/**
 * 把脚本的计划（beat.shotId）变成 solver 吃的 ArrangementPlan。**确定性，不调 LLM。**
 *
 * 铁律：顺序是计划不是合同。
 * - 计划里的素材缺席（视频没生成/失败）→ 从备用池（脚本没选中的分镜）替补 + warning。
 * - 备用池也空了 → 该 beat 进 gaps；solve-timeline 会让邻近画面提前顶上并报 visual_gap。
 * - 分镜图在脚本写完后被重生成过 → 只发 warning，绝不阻断出片。
 */
import type { ArrangementPlan, ClipPoolItem, NarrationBeat, TimelineIssue } from './types.ts';

const warning = (
  code: TimelineIssue['code'],
  message: string,
  beatIds: string[],
  clipId: string | null,
): TimelineIssue => ({ code, severity: 'warning', message, beatIds, clipId });

export function buildPlanArrangement(input: {
  beats: NarrationBeat[];
  clips: ClipPoolItem[];
  droppedShotIds: string[];
}): { plan: ArrangementPlan; issues: TimelineIssue[] } {
  const beats = [...input.beats].sort((a, b) => a.index - b.index);
  const clipByShotId = new Map(input.clips.map((clip) => [clip.shotId, clip]));

  // 备用池 = 脚本明确丢弃的分镜里、确实有可用视频的那些。按 shotIndex 稳定排序，
  // 让替补结果可复现（同一草稿反复 prepare 得到同一条片子）。
  const droppedSet = new Set(input.droppedShotIds);
  const spares = input.clips
    .filter((clip) => droppedSet.has(clip.shotId))
    .sort((a, b) => a.shotIndex - b.shotIndex || a.clipId.localeCompare(b.clipId));

  const usedClipIds = new Set<string>();
  const assignments: ArrangementPlan['assignments'] = [];
  const gaps: ArrangementPlan['gaps'] = [];
  const issues: TimelineIssue[] = [];

  const takeSpare = (): ClipPoolItem | undefined =>
    spares.find((clip) => !usedClipIds.has(clip.clipId));

  for (const beat of beats) {
    const planned = clipByShotId.get(beat.shotId);

    if (planned && !usedClipIds.has(planned.clipId)) {
      // 脚本看的那张图，和这条视频实际用的那张源图不是同一张 —— 说明分镜图在写完脚本后被重生成过。
      // 多数情况只是画质微调、主体一致，脚本仍然有效，所以只提醒，不阻断。
      if (beat.imageAssetId && beat.imageAssetId !== planned.sourceImageId) {
        issues.push(warning(
          'script_image_stale',
          '分镜图在脚本生成后被重新生成过，文案可能与画面不匹配',
          [beat.beatId],
          planned.clipId,
        ));
      }
      usedClipIds.add(planned.clipId);
      assignments.push({ assignmentId: `plan-${assignments.length}`, clipId: planned.clipId, beatIds: [beat.beatId] });
      continue;
    }

    const spare = takeSpare();
    if (spare) {
      usedClipIds.add(spare.clipId);
      assignments.push({ assignmentId: `plan-${assignments.length}`, clipId: spare.clipId, beatIds: [beat.beatId] });
      issues.push(warning(
        'planned_clip_substituted',
        '计划中的画面缺失，已用备用画面替补',
        [beat.beatId],
        spare.clipId,
      ));
      continue;
    }

    // 无图可用：交给 solver 的 gap 机制 —— 邻近画面会提前顶上，成片不会开天窗。
    gaps.push({ beatId: beat.beatId, reason: '计划中的画面缺失，且备用池已空' });
    issues.push(warning(
      'planned_clip_substituted',
      '计划中的画面缺失，且没有备用画面可替补',
      [beat.beatId],
      null,
    ));
  }

  return { plan: { assignments, gaps }, issues };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node scripts/final-video-build-arrangement.test.ts`
Expected: PASS，`final-video build-arrangement: OK`

**注意：** 上面测试里的 `clip()` 帮手构造 `ClipPoolItem` 时**没写** `visualDescription` / `descriptionProviderId` / `descriptionModel` —— 因为那三个字段随 `vision.ts` 在 **Task B6** 一起删。在 B6 落地之前，这个测试文件会有**类型报错但能正常跑通**（Node 只擦类型不检查类型，见 Phase B 开头的横幅）。**不要**为了消掉这个红波浪线而提前动 `types.ts`——按顺序走到 B6 自然就干净了。

- [ ] **Step 5: 提交**

```bash
git add lib/final-video/build-arrangement.ts scripts/final-video-build-arrangement.test.ts
git commit -m "feat(final-video): build the arrangement deterministically from the script plan"
```

## Task B5: prepare-draft 消费计划

**Files:**
- Modify: `lib/final-video/prepare-draft.ts`
- Test: `scripts/final-video-prepare.test.ts`

- [ ] **Step 1: 重写 prepare-draft**

把 `lib/final-video/prepare-draft.ts` 第 9–20 行的 import 换成：

```ts
import { getDb } from '../db.ts';
import { buildClipPool } from './clip-pool.ts';
import { parseScriptPlan } from './script-plan.ts';
import { buildPlanArrangement } from './build-arrangement.ts';
import { synthesizeNarrationBeats } from './tts.ts';
import { getFinalVideoDraft, updateFinalVideoDraft } from './draft-store.ts';
import {
  parseFinalVideoWorkflowConfigJson,
  parseNarrationBeatsJson,
  type FinalVideoDraftRow,
  type NarrationBeat,
  type NarrationDraftBeat,
  type TimelineIssue,
} from './types.ts';
import type { ScriptPlan } from './script-plan.ts';
```

把 `resolveSourceText`（第 34–61 行）替换为：

```ts
/**
 * 读所选脚本草稿的计划。v2 直接读 segments；旧草稿走形状适配（见 script-plan.ts）。
 * outputJson 本身是坏 JSON 时让 JSON.parse 抛错（路由回落 500），绝不当作空脚本吞掉。
 */
function resolveScriptPlan(scriptDraftId: string): ScriptPlan {
  const row = getDb()
    .prepare(`SELECT outputJson FROM script_drafts WHERE id = ?`)
    .get(scriptDraftId) as ScriptDraftOutputRow | undefined;
  if (!row) throw invalidInputError('脚本内容为空，无法生成口播');
  return parseScriptPlan(row.outputJson);
}
```

把 `prepareFinalVideoDraft` 的函数体（第 63–166 行）替换为：

```ts
export async function prepareFinalVideoDraft(input: {
  draftId: string;
  expectedRevision: number;
}): Promise<FinalVideoDraftRow> {
  const initialRow = getFinalVideoDraft(input.draftId);
  if (!initialRow) throw notFoundError();

  const workflowConfig = parseFinalVideoWorkflowConfigJson(initialRow.workflowConfigJson);
  const packageConfig = workflowConfig.packageConfig;

  // Input validation happens before any DB write: a bad request must never bump
  // stage/revision, so the draft is left exactly as the client last saw it.
  let scriptPlan: ScriptPlan | null = null;
  if (packageConfig.mode === 'narration') {
    if (initialRow.scriptDraftId === null) throw invalidInputError('口播模式必须先选择脚本草稿');
    scriptPlan = resolveScriptPlan(initialRow.scriptDraftId);
  }

  const row = updateFinalVideoDraft(input.draftId, input.expectedRevision, { stage: 'preparing' });
  const currentRevision = row.revision;

  try {
    let narrationBeats: NarrationBeat[] = [];
    const issues: TimelineIssue[] = [];

    if (packageConfig.mode === 'narration' && scriptPlan) {
      const existingBeats = parseNarrationBeatsJson(row.narrationBeatsJson);
      if (existingBeats.length > 0) {
        // Same-state retry: reuse already-synthesized audio instead of paying for TTS again.
        narrationBeats = existingBeats;
      } else {
        // 一句 = 一个 beat。不再调 LLM 重新切句 —— 脚本已经一句一图分好了。
        const draftBeats: NarrationDraftBeat[] = scriptPlan.segments.map((segment, index) => ({
          beatId: `beat-${index}`,
          index,
          text: segment.narration,
          subtitleText: segment.subtitle,
          shotId: segment.shotId,
          imageAssetId: segment.imageAssetId,
        }));
        const narrationConfig = packageConfig.narration;
        narrationBeats = await synthesizeNarrationBeats({
          draftId: input.draftId,
          beats: draftBeats,
          providerId: narrationConfig.providerId,
          voice: narrationConfig.voice,
          speed: narrationConfig.speed,
        });
      }

      const actualTotalSec = packageConfig.cover.introDurationSec
        + narrationBeats.reduce((sum, beat) => sum + beat.durationSec, 0);
      const relativeDelta = Math.abs(actualTotalSec - packageConfig.targetDurationSec) / packageConfig.targetDurationSec;
      if (relativeDelta > packageConfig.durationTolerancePct) {
        // Warning only: never truncate audio, never fail the operation over this.
        issues.push({
          code: 'target_duration_out_of_tolerance',
          severity: 'warning',
          message: '成片实际时长超出目标容差',
          beatIds: [],
          clipId: null,
        });
      }
    }

    // Clip pool is a cheap, deterministic, zero-cost DB+ffprobe read — always rebuild it.
    const { clips, issues: clipIssues } = await buildClipPool(row.shotSetId);
    issues.push(...clipIssues);

    // 编排是确定性的：脚本已经决定了顺序，这里只做「计划 vs 现实」的对账。
    let arrangementJson = row.arrangementJson;
    if (packageConfig.mode === 'narration' && scriptPlan) {
      const { plan, issues: planIssues } = buildPlanArrangement({
        beats: narrationBeats,
        clips,
        droppedShotIds: scriptPlan.droppedShotIds,
      });
      arrangementJson = JSON.stringify(plan);
      issues.push(...planIssues);
    }

    return updateFinalVideoDraft(input.draftId, currentRevision, {
      // 编排已在此处完成，不再有 narration-ready / describing / arranging 三个中间态。
      stage: 'review',
      narrationBeatsJson: JSON.stringify(narrationBeats),
      clipPoolJson: JSON.stringify(clips),
      arrangementJson,
      issuesJson: JSON.stringify(issues),
      errorMessage: null,
    });
  } catch (error) {
    try {
      return updateFinalVideoDraft(input.draftId, currentRevision, {
        stage: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // This recovery write itself raced and lost — a concurrent writer already moved the
      // draft's revision past currentRevision. That writer's state is now the source of
      // truth: don't clobber it, and don't crash just because we lost the race.
      const current = getFinalVideoDraft(input.draftId);
      if (current) return current;
      throw error;
    }
  }
}
```

- [ ] **Step 2: 更新 prepare 测试**

`scripts/final-video-prepare.test.ts`：把断言 `stage === 'narration-ready'` 改为 `stage === 'review'`；去掉所有 mock `generateNarrationDraftBeats` 的部分；新增断言「prepare 之后 `arrangementJson` 已经有 assignments」。

Run: `node scripts/final-video-prepare.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add lib/final-video/prepare-draft.ts scripts/final-video-prepare.test.ts
git commit -m "feat(final-video): prepare consumes the script plan and arranges deterministically"
```

## Task B6: 删掉三个 LLM 步骤

**Files:**
- Delete: `lib/final-video/{orchestrate,vision,narration-script}.ts`
- Delete: `app/api/final-video-drafts/[id]/{describe,arrange}/route.ts`
- Delete: `scripts/final-video-{orchestrate,vision,narration-script,describe-api,arrange-api}.test.ts`
- Modify: `lib/final-video/{types,clip-pool,draft-api,draft-store,render-queue,submit-job}.ts`
- Modify: `lib/script-providers/{openai-compatible,gemini}.ts`
- Modify: `app/api/final-video-jobs/[id]/{route,retry/route}.ts`

- [ ] **Step 1: 删文件**

```bash
git rm lib/final-video/orchestrate.ts lib/final-video/vision.ts lib/final-video/narration-script.ts
git rm -r app/api/final-video-drafts/\[id\]/describe app/api/final-video-drafts/\[id\]/arrange
git rm scripts/final-video-orchestrate.test.ts scripts/final-video-vision.test.ts scripts/final-video-narration-script.test.ts scripts/final-video-describe-api.test.ts scripts/final-video-arrange-api.test.ts
```

- [ ] **Step 2: `ClipPoolItem` 去掉视觉描述三件套**（这一步做完，Task B4 那个测试的红波浪线就消失了）

`lib/final-video/types.ts` 第 31–35 行：

```ts
export interface ClipPoolItem {
  clipId: string; shotId: string; shotIndex: number; videoPath: string; clipDurationSec: number;
  sourceImageId: string; sourceImagePath: string;
}
```

`parseClipPoolJson` 里删掉 `visualDescription` / `descriptionProviderId` / `descriptionModel` 三行。
`lib/final-video/clip-pool.ts` 第 111–113 行同样删掉这三个字段的赋值。

- [ ] **Step 3: `FinalVideoWorkflowConfig` 去掉三个已死的供应商字段**

`lib/final-video/types.ts` 第 22–28 行：

```ts
export interface FinalVideoWorkflowConfig {
  packageConfig: PackageConfig;
  selectedClipIds: string[];
}
```

`parseFinalVideoWorkflowConfigJson`（第 212–220 行）删掉三行 `narrationScriptProviderId` / `visionProviderId` / `orchestrationProviderId` 的解析：

```ts
export function parseFinalVideoWorkflowConfigJson(json: string): FinalVideoWorkflowConfig {
  const value = object(parseJson(json, 'workflowConfigJson'), 'workflowConfigJson');
  const packageConfig = mergePackageConfigAt(object(value.packageConfig, 'workflowConfigJson.packageConfig'), 'workflowConfigJson.packageConfig');
  const selectedClipIds = stringArray(value.selectedClipIds, 'workflowConfigJson.selectedClipIds');
  if (packageConfig.mode === 'narration' && selectedClipIds.length) throw new Error('workflowConfigJson.selectedClipIds must be empty in narration mode');
  return { packageConfig, selectedClipIds };
}
```

`lib/final-video/draft-api.ts`：`narrationChanged` 的比较对象删掉 `narrationScriptProviderId`；**整个删除** `visionChanged` 分支（第 89、100–107 行）和 `orchestrationChanged`（第 90 行），第 108 行改为 `if (selectedClipsChanged) { ... }`。

`lib/final-video/draft-store.ts`：新建草稿时若写了这三个字段的默认值，一并删掉。

- [ ] **Step 4: solverVersion 2 → 3**

- `lib/final-video/draft-store.ts:154`：`solverVersion: 2` → `solverVersion: 3`
- `lib/final-video/render-queue.ts:41,46,94`：三处 `solverVersion = 2` → `solverVersion = 3`
- `app/api/final-video-jobs/[id]/route.ts:19`：`if (row.solverVersion === 2)` → `=== 3`
- `app/api/final-video-jobs/[id]/retry/route.ts:20`：`if (row.solverVersion !== 2)` → `!== 3`
- `lib/db.ts:343`：`solverVersion INTEGER NOT NULL DEFAULT 2` → `DEFAULT 3`
- **不加 migration**：旧的 v2 任务保持原值，变成只读历史记录（与现存 v1 任务同样处理）。

- [ ] **Step 5: 删掉现在没人用的 vision helper**

`lib/script-providers/openai-compatible.ts`：删除 `describeImageOpenAiCompatible`（第 86–150 行）。
`lib/script-providers/gemini.ts`：删除 `describeImageGeminiNative`（第 129–183 行）。
（唯一调用者 `lib/final-video/vision.ts` 已删。）

- [ ] **Step 6: 全量类型检查**

Run: `npx tsc --noEmit`
Expected: **零错误**。若有残留引用（如 `render-queue.ts` 仍 import `visualDescription`），按报错逐个清掉。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor(final-video): delete orchestrate/vision/narration-script and bump solver to v3"
```

## Task B7: 成片包装界面做减法

**Files:**
- Modify: `components/FinalVideoPanel.tsx`

- [ ] **Step 1: 删掉 5 个失效字段**

`components/FinalVideoPanel.tsx`：

- 删除 state：`targetDurationSec`（第 50 行）、`narrationScriptProviderId`（53）、`visionProviderId`（54）、`orchestrationProviderId`（55）及其 setter 与第 77–81 行的同步赋值。
- 删除表单控件：第 275 行「目标时长（秒）」、第 278 行「口播文本供应商」、第 281 行「图片理解供应商」、第 282 行「编排供应商」四个 `<label>`。
- 第 170、176 行的 packageConfig 构造：删掉 `maxClipSeconds: 4,`；`targetDurationSec` 改为**从所选脚本草稿读**：

```ts
// 目标时长现在是脚本层的决策（脚本按它决定写多少字）。成片阶段只跟随，不再提供一个
// 改了也没用的输入框 —— 口播时长决定成片时长，这里填什么都改变不了结果。
const targetDurationSec = selectedScriptTargetDurationSec ?? 20;
```

并在组件里从已加载的脚本草稿解析出该值：

```ts
const selectedScriptTargetDurationSec = useMemo(() => {
  const draft = scriptDrafts.find((item) => item.id === selectedScriptId);
  if (!draft) return null;
  try {
    const output = JSON.parse(draft.outputJson || '{}') as { targetDurationSec?: number };
    return typeof output.targetDurationSec === 'number' ? output.targetDurationSec : null;
  } catch {
    return null;
  }
}, [scriptDrafts, selectedScriptId]);
```

（确认 `scriptDrafts` 的类型里带 `outputJson`；`ScriptPanel.tsx:18` 的 `ScriptDraft` 是有的，需要时补上该字段的加载。）

- 第 187–188 行的校验：删掉 `!narrationScriptProviderId || !visionProviderId || !orchestrationProviderId` 三个条件和「目标时长必须大于 0 秒」那条。
- 第 199–201 行的 `runDraftAction`：签名收窄为 `(action: 'prepare')`，删掉 `providerId` 的三元推导。
- 第 291–292 行「识别画面」和「AI 编排」两个按钮：**整个删除**（这两个步骤已不存在）。
- 第 290 行的 prepare 按钮文案去掉 `narrationScriptProviderId` 的插值。
- 所有 `draft.stage === 'narration-ready'` 的分支删除；`stage === 'review'` 的分支保留不动。
- 若有 `hasDescribedVisuals` 之类的派生状态，一并删除。

- [ ] **Step 2: 新增两个提醒（旧脚本 / 图已变更）**

在 `stage === 'review'` 区块顶部加：

```tsx
{draft.issues.some((issue) => issue.code === 'script_image_stale') && (
  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700">
    分镜图在脚本生成后被重新生成过，文案可能与画面不匹配。可以继续出片，也可以回到脚本步骤重新生成。
  </p>
)}
{draft.issues.some((issue) => issue.code === 'planned_clip_substituted') && (
  <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-600">
    脚本计划中的部分画面缺失（视频未生成或生成失败），已用备用画面替补。
  </p>
)}
```

- [ ] **Step 3: 校验并提交**

Run: `npx tsc --noEmit && npm run lint`
Expected: 零错误

```bash
git add components/FinalVideoPanel.tsx
git commit -m "refactor(final-video): drop the five dead fields from the packaging form"
```

## Task B8: 完成门禁

- [ ] **Step 1: UI 契约测试对齐**

`scripts/final-video-ui-contract.test.mjs` 断言了面板上存在的字段/按钮。按 Task B7 的删减更新它（去掉四个供应商/时长字段、去掉「识别画面」「AI 编排」按钮的断言）。

- [ ] **Step 2: 全套测试**

```bash
npm run lint
for f in scripts/final-video-*.test.ts scripts/script-workflow.test.ts; do echo "── $f"; node "$f" || break; done
node scripts/final-video-ui-contract.test.mjs
node scripts/db-migrations.test.ts
npm run build
```
Expected: 全部通过，`npm run build` 成功。

- [ ] **Step 3: 端到端人工验证（不可跳过）**

```bash
npm run dev
```
用现有项目「实木软包沙发」（`projectId = 0d01b8e5-f7e0-460a-937f-fa3722dba7a8`）跑一遍：

1. **脚本生成**：选分镜组「客厅01」，目标时长填 20，生成脚本。
   - ✅ 每段旁边显示**缩略图**
   - ✅ **文案描述的是图里真实存在的东西**（这是本次改造的唯一目的，逐句对着缩略图看）
   - ✅ 底部列出「未使用的分镜」及原因
2. **成片包装**：新建草稿 → 选该脚本 → 「准备口播」。
   - ✅ 表单只剩 6 个字段（分镜组/成片模式/口播脚本/口播供应商/音色/封面标题/封面模板），**没有目标时长、没有三个供应商下拉**
   - ✅ 一步直达 review（**没有**「识别画面」「AI 编排」按钮）
3. **正式渲染**，打开成片：
   - ✅ **画面顺序与脚本一致**
   - ✅ **无黑屏、无异常定格**
   - ✅ 字幕一句一条，与口播同步

- [ ] **Step 4: 更新 CLAUDE.md 的架构描述**

`CLAUDE.md` 的 `lib/final-video/` 一行提到「时间线/ASS 字幕/FFmpeg 渲染图/渲染队列」。补一句说明编排现在来自脚本层：

```
  - `final-video/` — 成片包装引擎（时间线/ASS 字幕/FFmpeg 渲染图/渲染队列）。**画面的选择与顺序由脚本生成步骤决定**（`script_drafts.outputJson.segments`），本层只做确定性对账与秒数精算，不调用 LLM。ffmpeg 二进制经 `lib/ffmpeg.ts` 解析（env → ffmpeg-static → PATH）
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "test(final-video): align contract tests and docs with script-driven arrangement"
```

---

## 执行者须知

- **没有 `npm test`。** 单个测试跑 `node scripts/<name>.test.ts`（Node 22 原生 TS）。
- **Phase A 结束时 `lib/final-video/**` 仍会飘红**，这是正常的——Phase B 才修。只在 Task B6 Step 6 要求 `npx tsc --noEmit` 零错误。
- **本计划不碰**：分镜生成的顺序机制（只改文案）、视频生成、纯 BGM 模式的行为、脚本供应商列表、成片包装的审核列表长相（Round 2 才换时间轴）。
- **遇到与本计划冲突的现实**（比如某个文件的行号对不上、某个字段实际不存在），**以代码为准**，按本计划的**意图**调整，并在提交信息里注明偏差。
