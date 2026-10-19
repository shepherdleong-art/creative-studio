# 供应商层 · 新增 OpenAI Responses 协议适配器（启用 gpt-5.5 / 5.6 系列）执行文档

> 日期：2026-07-26
> 类型：交接执行文档（可由另一个 AI/工程师独立执行）
> 触发：主理人要求「把 gemini 换成 gpt-5.5，比 gemini 聪明多了」。实测发现 **gpt-5.5 无法直接切换**——它走 OpenAI **Responses 协议**（`/v1/responses`），而本项目供应商层只实现了 chat/completions。
> 状态：**协议可行性已实机验证通过**（真实调用主理人配置的 PackyCode 代理，见 §2）。本文档给出适配器实现规格。
> 关联：`2026-07-26-mixcut-short-material-matching-fix.md` §3.1 —— 本适配器是那里「语义评分静默降级」的推荐解法之一。

---

## 0. 一句话摘要

新增第三种 `ApiStyle`（`openai-responses`），走 `/v1/responses` + **强制 SSE 流式**，即可启用 `gpt-5.5` / `gpt-5.6-luna|sol|terra`。

实测 gpt-5.5 在本项目的两个真实任务上表现**显著优于当前降级状态**：识图准确、语义矩阵**逐素材精准区分**（详见 §2.3 实测数据）。

> ⚠️ **本适配器不解决混剪视频轨全空的 P0**。那是句段切分粒度问题（我们代码里的正则，不走 LLM），见另一份文档 §2.1。两件事需并行修。

### 执行次序（重要）

本文档在整体计划里是**第 ⑤ 步、优先级最低**，建议先完成 `2026-07-26-mixcut-short-material-matching-fix.md` §0.1 的 ①–④。原因：

- 先做本文档**不会让混剪能出片**（P0 是切句问题，与模型无关）。
- 若目的只是「换个更聪明的模型、摆脱语义降级」，**`gpt-5.4` 零代码即可达成**（走现有 chat/completions，改配置 + 勾「支持图片理解」，见 §1.1）。本适配器是为了进一步用上 `gpt-5.5` / `5.6-*`。

若你此刻就是被指派来做这份文档的，可直接执行——它与另一份文档**无代码耦合**，可并行开发。

---

## 1. 为什么不能直接切换

`gpt` 供应商在 DB 里已存在、`model` 已被主理人设为 `gpt-5.5`、密钥已配、`enabled=1`。但：

```
POST {baseUrl}/v1/chat/completions   model=gpt-5.5
→ HTTP 400 {"code":"protocol_not_supported",
            "message":"模型 gpt-5.5 不支持 chat completions 协议"}
```

PackyCode 控制台对 gpt-5.5 的标注也一致：**API端点 `openai · /v1/responses` POST**。

### 1.1 实测：该代理上各 gpt 模型的协议支持矩阵

| 模型 | chat/completions | Responses | 识图 |
|---|---|---|---|
| `gpt-5.4` | ✅ 4.0s | 未测 | ✅ 正确识别 |
| `gpt-5.4-mini` | ❌ protocol_not_supported | 未测 | — |
| **`gpt-5.5`** | ❌ protocol_not_supported | ✅ **已验证** | ✅ **已验证** |
| `gpt-5.6-luna` | ❌ protocol_not_supported | 未测（同族，大概率同协议） | — |
| `gpt-5.6-sol` | ❌ protocol_not_supported | 未测 | — |
| `gpt-5.6-terra` | ❌ protocol_not_supported | 未测 | — |

> `/v1/models` 该密钥可见 7 个：`codex-auto-review` + 上述 6 个 gpt。
> **短期若只想立刻可用**：`gpt-5.4` 走现有 chat/completions 即可，改 DB 配置就行（但需同时打开 `supportsVision`，见 §5）。本适配器是为了用上 5.5/5.6 系列。

---

## 2. 已验证的协议细节（照此实现即可，无需再摸索）

### 2.1 请求体

```jsonc
POST {baseUrl}/v1/responses
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "gpt-5.5",
  "stream": true,                    // ⚠️ 必须，见 §2.2
  "input": [                         // ⚠️ 是 input 不是 messages；必须是数组
    { "role": "system", "content": "系统提示词（纯字符串即可）" },
    { "role": "user", "content": [
        { "type": "input_text",  "text": "文本内容" },
        { "type": "input_image", "image_url": "data:image/jpeg;base64,...." }
    ]}
  ]
}
```

**与现有 `openai-compatible.ts:52-59` 的三处差异（改写时逐条对照）**：

| | chat/completions（现有） | Responses（新增） |
|---|---|---|
| 消息字段 | `messages` | **`input`** |
| 文本片段 | `{type:'text', text}` | **`{type:'input_text', text}`** |
| 图片片段 | `{type:'image_url', image_url:{url:'data:...'}}`（**对象**） | **`{type:'input_image', image_url:'data:...'}`（**字符串**）** |
| token 上限 | `max_tokens` | `max_output_tokens`（可选，实测不传也正常） |

### 2.2 ⚠️ 最大的坑：非流式返回空内容

**非流式调用会静默返回空**——这不是错误，极易被误判为"模型不可用"：

```
POST /v1/responses（不带 stream）
→ HTTP 200
   status: "completed"
   usage.output_tokens: 5        ← 模型确实产出了
   output: []                    ← 但数组是空的，拿不到任何文本
```

**必须 `stream: true` 并解析 SSE。** 实测事件序列（`content-type: text/event-stream`）：

```
response.created → response.in_progress → response.output_item.added
→ response.content_part.added → response.output_text.delta   ← 正文在这里
→ response.output_text.done → response.content_part.done
→ response.output_item.done → response.completed             ← usage 在这里
```

拼接方式：累加所有 `data:` 行中 `type === 'response.output_text.delta'` 的 `delta` 字段。
`response.completed` 事件的 `response.usage` 可取 token 用量（其 `response.output` 同样是空数组，**不要从这里取正文**）。

### 2.3 实测能力验证（真实调用，非推断）

**① 识图**（红色纯色测试图）：
```
✓ 2.3s  usage.output_tokens=6  正文="红色"
```

**② 语义矩阵**（复刻 `semantic-matrix.ts` 的真实 prompt，3 句 × 7 个**互不相同**的素材描述）：
```
✓ 7.3s  usage: input=4736 (cached 3840) / output=147 (reasoning 20)
正文: {"score_matrix":[[0.88,0.96,0.55,0.28,0.42,0.38,0.46],
                      [0.32,0.58,0.97,0.18,0.24,0.2,0.62],
                      [0.18,0.24,0.22,0.96,0.35,0.82,0.4]],
       "hook_scores":[0.82,0.9,0.68,0.74,0.48,0.78,0.52]}
形状合格(3行×7列 + 7项) ✓   每行 7 个值互不相同 ✓
```

**匹配质量（逐句核对，全部命中）**：

| 口播句 | 最高分素材 | 分 |
|---|---|---|
| 陷进这26斤满铺**鹅毛**的怀抱 | 素材1「人整个陷进厚实的**鹅毛**沙发靠垫里」 | 0.96 |
| 112度**人体工学靠背**，承托**腰背** | 素材2「**靠**在高背**靠枕**上，**腰背**贴合曲线」 | 0.97 |
| 婴幼级**半青皮**，细腻**质感** | 素材3「手掌抚过**真皮**表面，**皮革纹理**清晰」 | 0.96 |

第三句次高分给「小孩贴脸蹭皮革」0.82，同样合理。
→ 与当前 gemini 降级后的**全 0.6 常量矩阵**（零区分度）形成鲜明对比，是本次换模型的核心收益。

### 2.4 代理会注入 Codex system prompt（成本提示，不影响功能）

该代理对 gpt-5.5 注入了一段 Codex CLI 的 `instructions`（响应体 `instructions` 字段可见），导致每次调用固定带 **~3840 个 cached input tokens**。

- 功能无影响（实测输出正常、不受 Codex 人设干扰）。
- 计费：PackyCode `codex` 分组 输入 \$2.5/M、**缓存读取 \$0.25/M**、输出 \$15/M（截图价，0.7 折）。缓存部分很便宜，可接受。
- 但**不要**在 prompt 里再堆无关内容（见另一文档 §2.4：当前语义 prompt 塞了 assetFingerprint/startUs 等噪声，应一并清理）。

---

## 3. 实现规格

### 3.1 类型与路由接入点

```ts
// lib/script-providers/types.ts:114
export type ApiStyle = 'native-gemini' | 'openai-compatible' | 'openai-responses';  // ← 新增第三种
```

路由分发点（现有两处，照此扩展）：
- `lib/script-providers/index.ts:91-95`：`completeJson()` 现在是 `if (providerId === 'gemini') …else openai-compatible`。
  **应改为按 `runtime.apiStyle` 分发**，而不是按 provider id 硬判——否则 gpt 走不到新分支。
- `lib/script-providers/gemini.ts:79`：已有 `getApiStyle()` 的先例，可参考其写法。

### 3.2 新增文件

`lib/script-providers/openai-responses.ts`，导出与 `openai-compatible.ts` **同签名**的函数，便于上层无差别调用：

```ts
export async function chatCompletion(
  config: ProviderConfig,
  options: ChatOptions,          // { systemPrompt, userPrompt, temperature, maxTokens, images, responseFormat }
  runtime?: ScriptProviderRuntimeConfig,
): Promise<string>
```

要点：
1. URL：`{baseUrl}/v1/responses`（复用 `openai-compatible.ts:30-35` 的 baseUrl 规整思路，注意它是针对 `/chat/completions` 写的，需要单独写一个）。
2. body 按 §2.1 组装；`stream: true` **写死**。
3. SSE 解析按 §2.2。**注意跨 chunk 的半行问题**：必须做缓冲，按 `\n` 切分后保留最后一段不完整行到下次，不能假设每个 chunk 正好是完整行。
4. `responseFormat === 'json_object'`：Responses 协议的等价物是 `text: { format: { type: 'json_object' } }`。**未实测**——建议先不传（实测 §2.3 里靠 prompt 约束已能稳定返回纯 JSON），或实测确认后再启用。
5. 错误处理：非 2xx 抛错并带上响应体前 500 字（对齐 `openai-compatible.ts` 现有风格）；SSE 中出现 `response.failed` / `error` 事件也要抛。
6. **空正文必须抛错**，不要静默返回空串——否则会退化成本次排查中 gemini 那种"静默降级"，极难定位。

### 3.3 设置页

`app/settings/page.tsx:464-467` 的 script 分类 `<select>` 增加一项：

```tsx
<option value="openai-responses">OpenAI Responses (gpt-5.5 / 5.6)</option>
```

> 注意该 select 绑定的是 `form.type`，而 DB 里 `apiStyle` 与 `type` 是两列（`config.ts:147` 有 `type: runtime.apiStyle` 的映射）。执行时**先理清 type/apiStyle 二者关系**再动，别改坏现有 Gemini 的 `native-gemini` 路径。

### 3.4 不要动的部分

- `lib/script-providers/openai-compatible.ts`、`gemini.ts` 现有逻辑：Gemini/Qwen/Kimi 三家仍走原路径，必须零回归。
- `completeJson` / `analyzeSellingPoints` 等上层 API 签名不变——本适配器只是多一个分发分支。

---

## 4. 切换到 gpt-5.5 的完整清单（适配器完成后）

1. 设置页把 `gpt` 供应商的 **API 风格改为 `openai-responses`**、model 保持 `gpt-5.5`。
2. **勾选「支持图片理解」**（`app/settings/page.tsx:497`）。当前 DB 里 `gpt.supportsVision = 0`，不勾的话：
   - `lib/final-edit/runtime.ts:47` 会抛「没有已启用并支持图片理解的视觉分析供应商」；
   - `components/mixcut/MixcutPanel.tsx:165` 也选不中它。
   （§2.3 已实测 gpt-5.5 确实能识图，勾选属实。）
3. **注意分析缓存全部失效**：`final_edit_asset_analysis` 缓存键含 `providerId + model + analyzerVersion`，换供应商后 7 条视频会**全部重新分析**（成本 + 时间）。这是预期行为，不是 bug。
4. 建议保留 gemini 配置不删，便于对照/回退。

---

## 5. 测试要求

- **新增单测** `scripts/openai-responses-adapter.test.ts`（Node 22 原生 TS）：
  - 用 **mock 的 SSE 字节流**（不打真实 API）断言：多 chunk 拆分（含把一行 JSON 切成两半）能正确拼出完整正文。
  - 断言图片片段序列化为 `{type:'input_image', image_url:'data:...'}`（字符串形态，**不是**对象）。
  - 断言 `stream` 恒为 true。
  - 断言空正文/`response.failed` 会抛错而非返回空串。
  - 断言 `apiStyle` 为其它两种时**不会**走到本适配器（零回归）。
- **既有测试全绿**：全量 `scripts/*.test.ts`；两个 Playwright（`final-edit-mixcut.playwright.test.mjs` / `-real`）。
- `npm run lint` 0 error、`npm run build` exit 0。
- **人工实机验证**：切到 gpt-5.5 后跑一次真实混剪准备任务，确认 ①7 条视频分析成功 ②`semanticFallback === false` ③语义矩阵各行数值互不相同。

## 6. 验收标准

- `gpt-5.5` 可作为视觉分析 + 语义评分供应商正常完成一次真实混剪准备任务。
- Gemini / Qwen / Kimi 三家行为**零变化**（模块 3 脚本生成、模块 4 等所有既有调用方不受影响）。
- 适配器失败时**有明确报错**（不静默返回空）。
- 单测覆盖 SSE 跨 chunk 拼接这一核心风险点。

## 7. 非目标

- 不实现 Responses 协议的 tools / function calling / `previous_response_id` 多轮（本项目只用单轮 JSON 输出）。
- 不改匹配算法、不改混剪 UI（见另一文档）。
- 不删除/迁移 Gemini 配置。

## 8. 证据附录

**实测记录**（2026-07-26，真实调用 `https://www.packyapi.com`，密钥取自本地 DB）
- chat/completions 对 gpt-5.5 → `HTTP 400 protocol_not_supported`
- `/v1/responses` 非流式 → `HTTP 200 status=completed output_tokens=5` 但 `output: []`
- `/v1/responses` + `stream:true` → SSE 正常，`response.output_text.delta` 拼出 `"北京"`
- 识图 → `"红色"`；语义矩阵 → 3×7 合格且逐素材区分（§2.3 全文）
- `/v1/models` 可见模型清单见 §1.1

**代码接入点**
- `lib/script-providers/types.ts:114`（`ApiStyle` 定义）
- `lib/script-providers/index.ts:73-96`（`completeJson` 分发）
- `lib/script-providers/openai-compatible.ts:30-75`（现有请求组装，作为对照）
- `lib/script-providers/gemini.ts:79,143-145`（`getApiStyle` 分发先例）
- `lib/script-providers/config.ts:110,124,144-147`（apiStyle / type 映射）
- `app/settings/page.tsx:464-467`（API 风格下拉）、`:497`（支持图片理解开关）
- `lib/final-edit/runtime.ts:47`（视觉供应商校验）、`components/mixcut/MixcutPanel.tsx:165`（前端选取）

**相关文档**
- 混剪匹配修复（P0 空视频轨 + 语义失效）：`2026-07-26-mixcut-short-material-matching-fix.md`
- V2 UI 规格（已落地）：`../specs/2026-07-25-mixcut-v2-ui-spec.md`
